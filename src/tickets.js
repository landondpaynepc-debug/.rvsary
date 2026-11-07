import { ChannelType, PermissionFlagsBits as P, ThreadAutoArchiveDuration } from 'discord.js';
import { SUPPORT_TYPES, ticketPayload } from './panels.js';

export class UserError extends Error {}
export const roleFor = (type, config) => type === 'management'
  ? config.managementRoleId || config.supportRoleId : config.supportRoleId;
export const canClose = (member, ticket) => member.id === ticket.ownerId
  || member.permissions.has(P.Administrator) || member.roles.cache.has(ticket.staffRoleId);

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
      await channel.send(ticketPayload(ticket));
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

  async close(interaction) {
    const ticket = this.store.data.tickets[interaction.channelId];
    if (!ticket || ticket.guildId !== interaction.guildId) throw new UserError('This is not a tracked .revisonary ticket.');
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!canClose(member, ticket)) throw new UserError('Only the ticket owner or the assigned staff team can close this ticket.');
    if (ticket.closed) throw new UserError('This ticket is already closed.');
    const lock = `close:${ticket.channelId}`;
    if (this.busy.has(lock)) throw new UserError('This ticket is already being closed.');
    this.busy.add(lock);
    try {
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
      this.store.save();
    } finally { this.busy.delete(lock); }
  }
}
