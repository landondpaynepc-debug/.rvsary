import { ChannelType, PermissionFlagsBits as P, ThreadAutoArchiveDuration } from 'discord.js';
import { SUPPORT_TYPES, ticketPayload } from './panels.js';

export class UserError extends Error {}
export const roleFor = (type, config) => type === 'management'
  ? config.managementRoleId || config.supportRoleId : config.supportRoleId;
export const canManage = (member, ticket) => member.permissions.has(P.Administrator)
  || member.roles.cache.has(ticket.staffRoleId);
export const canClose = (member, ticket) => member.id === ticket.ownerId || canManage(member, ticket);

export function privateOverwrites(guildId, botId, ownerId, staffRoleId) {
  const readWrite = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
  return [
    { id: guildId, deny: [P.ViewChannel] },
    { id: botId, allow: [...readWrite, P.ManageChannels, P.ManageRoles] },
    { id: ownerId, allow: readWrite, deny: [P.CreatePublicThreads, P.CreatePrivateThreads] },
    { id: staffRoleId, allow: readWrite, deny: [P.CreatePublicThreads, P.CreatePrivateThreads] },
  ];
}

export class TicketService {
  constructor(config, store) { this.config = config; this.store = store; this.busy = new Set(); }

  async open(interaction, type) {
    if (!Object.hasOwn(SUPPORT_TYPES, type)) throw new UserError('Choose a support option from the dashboard.');
    const key = `${interaction.guildId}:${interaction.user.id}`;
    if (this.busy.has(key)) throw new UserError('Your ticket is already being created. Please wait.');
    this.busy.add(key);
    try { return await this.create(interaction, type); }
    finally { this.busy.delete(key); }
  }

  async create(interaction, type) {
    const { guild, user } = interaction;
    // Check persisted records, including archived private threads, before creating another ticket.
    for (const ticket of Object.values(this.store.data.tickets)) {
      if (ticket.guildId !== guild.id || ticket.ownerId !== user.id || ticket.closed) continue;
      let existing;
      try { existing = await guild.channels.fetch(ticket.channelId); }
      catch (error) { if (error.code !== 10003) throw error; }
      if (existing) {
        if (existing.isThread() && existing.archived && !existing.locked) await existing.setArchived(false);
        return { channel: existing, existing: true };
      }
      ticket.closed = true;
      this.store.save();
    }
    const staffRoleId = roleFor(type, this.config);
    if (!staffRoleId) throw new UserError('Support is not configured yet. Ask an administrator to set SUPPORT_ROLE_ID.');
    const role = await guild.roles.fetch(staffRoleId);
    if (!role || role.id === guild.id || role.managed) {
      throw new UserError('The configured staff role is invalid. Please contact an administrator.');
    }
    const destination = await guild.channels.fetch(this.config.ticketDestinationId);
    if (!destination || ![ChannelType.GuildCategory, ChannelType.GuildText].includes(destination.type)) {
      throw new UserError('The ticket destination must be a category or a standard text channel.');
    }
    const me = await guild.members.fetchMe();
    const member = await guild.members.fetch(user.id);
    const botPermissions = destination.permissionsFor(me);
    const name = `ticket-${type}-${user.id}`;
    let channel;
    let ticket;
    try {
      if (destination.type === ChannelType.GuildCategory) {
        if (!botPermissions?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])) {
          throw new UserError('The bot needs View Channel, Manage Channels and Manage Roles on the ticket category.');
        }
        channel = await guild.channels.create({
          name, type: ChannelType.GuildText, parent: destination.id,
          topic: `.revisonary | ${SUPPORT_TYPES[type].label} | Owner: ${user.id}`,
          permissionOverwrites: privateOverwrites(guild.id, me.id, user.id, role.id),
          reason: `Support ticket requested by ${user.id}`,
        });
      } else {
        const required = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.CreatePrivateThreads, P.SendMessagesInThreads, P.ManageThreads];
        if (!botPermissions?.has(required)) throw new UserError('The bot needs private-thread, message and Manage Threads permissions in the ticket channel.');
        if (!destination.permissionsFor(member)?.has([P.ViewChannel, P.SendMessagesInThreads, P.ReadMessageHistory])) {
          throw new UserError('You need View Channel, Read Message History and Send Messages in Threads in the ticket destination.');
        }
        if (!destination.permissionsFor(role)?.has([P.ViewChannel, P.ManageThreads, P.SendMessagesInThreads, P.ReadMessageHistory])) {
          throw new UserError('The staff role needs View Channel, Read Message History, Send Messages in Threads and Manage Threads on the ticket channel.');
        }
        channel = await destination.threads.create({
          name, type: ChannelType.PrivateThread, invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: `Support ticket requested by ${user.id}`,
        });
        await channel.members.add(user.id);
      }
      ticket = {
        guildId: guild.id, ownerId: user.id, channelId: channel.id,
        staffRoleId: role.id, type, closed: false, createdAt: new Date().toISOString(),
      };
      // Persist before sending controls so a restart cannot leave a working button untracked.
      this.store.data.tickets[channel.id] = ticket;
      this.store.save();
      const controls = await channel.send(ticketPayload(ticket));
      ticket.controlMessageId = controls.id;
      ticket.controlsVersion = 3;
      this.store.save();
      return { channel, existing: false };
    } catch (error) {
      if (channel) {
        // Only remove the empty ticket created by this attempt; never remove existing tickets.
        try {
          await channel.delete('Ticket setup failed; removing incomplete ticket');
          delete this.store.data.tickets[channel.id];
          this.store.save();
        } catch (cleanupError) {
          console.error('Incomplete ticket needs administrator attention:', channel.id, cleanupError.message);
        }
      }
      throw error;
    }
  }

  async authorize(interaction, staffOnly = false) {
    const ticket = this.store.data.tickets[interaction.channelId];
    if (!ticket || ticket.guildId !== interaction.guildId || ticket.deletedAt) throw new UserError('This is not a tracked .revisonary ticket.');
    // Recheck current membership for destructive actions, including stale confirmation buttons.
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (!(staffOnly ? canManage(member, ticket) : canClose(member, ticket))) {
      throw new UserError(staffOnly ? 'Only assigned staff or administrators can claim or delete tickets.'
        : 'Only the ticket owner or the assigned staff team can close this ticket.');
    }
    return { ticket, member };
  }

  async mutate(interaction, staffOnly, action) {
    const lock = `ticket:${interaction.channelId}`;
    if (this.busy.has(lock)) throw new UserError('This ticket is being updated. Please try again in a moment.');
    this.busy.add(lock);
    try {
      const { ticket, member } = await this.authorize(interaction, staffOnly);
      return await action(ticket, member);
    } finally { this.busy.delete(lock); }
  }

  async refreshControls(channel, ticket) {
    let message;
    if (ticket.controlMessageId) {
      try { message = await channel.messages.fetch(ticket.controlMessageId); }
      catch (error) { if (error.code !== 10008) throw error; }
    } else {
      // Find the controls in tickets created before message IDs were recorded.
      const messages = await channel.messages.fetch({ limit: 100 });
      message = messages.find(item => item.author.id === channel.client.user.id
        && item.components.some(component => /"custom_id":"rv:(close|claim|delete)"/.test(JSON.stringify(component.toJSON()))));
    }
    const wasArchived = channel.isThread() && channel.archived;
    if (wasArchived) await channel.setArchived(false);
    try {
      const payload = ticketPayload(ticket);
      message = message ? await message.edit({ ...payload, attachments: [] }) : await channel.send(payload);
      ticket.controlMessageId = message.id;
      ticket.controlsVersion = 3;
      this.store.save();
    } finally {
      if (wasArchived) await channel.setArchived(true);
    }
  }

  async tryRefreshControls(channel, ticket) {
    try { await this.refreshControls(channel, ticket); }
    catch (error) { console.error('Ticket controls refresh failed:', ticket.channelId, error.message); }
  }

  async restoreControls(guild) {
    for (const ticket of Object.values(this.store.data.tickets)) {
      if (ticket.guildId !== guild.id || ticket.deletedAt || ticket.controlsVersion === 3) continue;
      const lock = `ticket:${ticket.channelId}`;
      if (this.busy.has(lock)) continue;
      this.busy.add(lock);
      try {
        const channel = await guild.channels.fetch(ticket.channelId);
        if (channel) await this.refreshControls(channel, ticket);
        else { ticket.closed = true; ticket.deletedAt = new Date().toISOString(); ticket.deletedExternally = true; this.store.save(); }
      } catch (error) {
        if (error.code === 10003) {
          ticket.closed = true; ticket.deletedAt = new Date().toISOString(); ticket.deletedExternally = true; this.store.save();
        } else console.error('Ticket upgrade failed:', ticket.channelId, error.message);
      }
      finally { this.busy.delete(lock); }
    }
  }

  async claim(interaction) {
    return this.mutate(interaction, true, async (ticket, member) => {
      if (ticket.closed) throw new UserError('Closed tickets cannot be claimed.');
      if (ticket.claimedById) throw new UserError(`This ticket is already claimed by <@${ticket.claimedById}>.`);
      ticket.claimedById = member.id;
      ticket.claimedAt = new Date().toISOString();
      ticket.controlsVersion = 0;
      this.store.save();
      await this.tryRefreshControls(interaction.channel, ticket);
      return ticket;
    });
  }

  async close(interaction) {
    return this.mutate(interaction, false, async (ticket, member) => {
      if (ticket.closed) throw new UserError('This ticket is already closed.');
      const channel = interaction.channel;
      if (channel.isThread()) {
        await channel.edit({ locked: true, archived: true, reason: `Ticket closed by ${member.id}` });
      } else {
        // Preserve the conversation, but stop the customer and staff role from sending messages.
        for (const id of [ticket.ownerId, ticket.staffRoleId]) {
          await channel.permissionOverwrites.edit(id, {
            SendMessages: false, AddReactions: false, SendMessagesInThreads: false,
            CreatePublicThreads: false, CreatePrivateThreads: false,
          });
        }
      }
      ticket.closed = true;
      ticket.closedAt = new Date().toISOString();
      ticket.closedById = member.id;
      ticket.controlsVersion = 0;
      this.store.save();
      await this.tryRefreshControls(channel, ticket);
      return ticket;
    });
  }

  async delete(interaction) {
    return this.mutate(interaction, true, async (ticket, member) => {
      if (!ticket.closed) throw new UserError('Close this ticket before deleting it.');
      await interaction.channel.delete(`Closed ticket deleted by ${member.id}`);
      ticket.deletedAt = new Date().toISOString();
      ticket.deletedById = member.id;
      this.store.save();
      return ticket;
    });
  }
}
