import { ChannelType, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
import { UserError } from './tickets.js';

export const MOD_PERMISSIONS = {
  warn: P.ModerateMembers, warnings: P.ModerateMembers, timeout: P.ModerateMembers,
  untimeout: P.ModerateMembers, kick: P.KickMembers, ban: P.BanMembers, unban: P.BanMembers,
  clear: P.ManageMessages, say: P.ManageMessages, lock: P.ManageChannels,
  unlock: P.ManageChannels, slowmode: P.ManageChannels,
};
const command = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description)
  .setDefaultMemberPermissions(MOD_PERMISSIONS[name]).setDMPermission(false);
const target = c => c.addUserOption(o => o.setName('member').setDescription('Member to act on').setRequired(true));
const reason = c => c.addStringOption(o => o.setName('reason').setDescription('Reason for the action').setMaxLength(400).setRequired(true));

export function moderationCommands() {
  return [
    reason(target(command('warn', 'Warn a member and save it in their warning history.'))),
    target(command('warnings', 'View the latest saved warnings for a member.')),
    reason(target(command('timeout', 'Temporarily prevent a member from communicating.'))
      .addIntegerOption(o => o.setName('minutes').setDescription('1 to 40320 minutes (28 days)').setMinValue(1).setMaxValue(40320).setRequired(true))),
    reason(target(command('untimeout', 'Remove a member’s timeout.'))),
    reason(target(command('kick', 'Remove a member from this server.'))),
    reason(target(command('ban', 'Ban a member from this server.'))),
    reason(command('unban', 'Unban a user by Discord ID.').addStringOption(o => o.setName('user-id').setDescription('Discord user ID').setRequired(true))),
    command('clear', 'Delete up to 100 matching recent messages, skipping pinned and old messages.')
      .addIntegerOption(o => o.setName('amount').setDescription('Maximum messages to delete').setMinValue(1).setMaxValue(100).setRequired(true))
      .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user'))
      .addStringOption(o => o.setName('contains').setDescription('Only messages containing this text; requires content intent').setMaxLength(100))
      .addStringOption(o => o.setName('reason').setDescription('Why these messages are being cleared').setMaxLength(400)),
    command('say', 'Send a message as the bot. Mentions do not ping anyone.')
      .addStringOption(o => o.setName('message').setDescription('Text for the bot to send').setMaxLength(2000).setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Destination; defaults to this channel').addChannelTypes(ChannelType.GuildText)),
    reason(command('lock', 'Lock this channel for @everyone, preserving its original setting.')),
    reason(command('unlock', 'Restore the channel setting saved by /lock.')),
    reason(command('slowmode', 'Set this channel’s slowmode delay.').addIntegerOption(o => o.setName('seconds')
      .setDescription('0 disables slowmode; maximum 21600').setMinValue(0).setMaxValue(21600).setRequired(true))),
  ];
}

export function checkHierarchy(actor, targetMember, guild, botId) {
  if ([actor.id, botId, guild.ownerId].includes(targetMember.id)) throw new UserError('You cannot moderate yourself, the bot, or the server owner.');
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    throw new UserError('You can only moderate members below your highest role.');
  }
  if (!targetMember.manageable) throw new UserError('The bot’s role must be above the target member’s highest role.');
}

export function selectClearMessages(messages, { amount, userId, contains, now = Date.now() }) {
  const cutoff = now - 14 * 24 * 60 * 60 * 1000 + 60_000;
  return [...messages.values()].filter(message => !message.pinned && message.createdTimestamp > cutoff
    && (!userId || message.author?.id === userId)
    && (!contains || message.content?.toLowerCase().includes(contains.toLowerCase()))).slice(0, amount);
}

export class ModerationService {
  constructor(config, store, logger) { Object.assign(this, { config, store, logger }); this.busy = new Set(); }

  async run(interaction) {
    const name = interaction.commandName;
    if (!Object.hasOwn(MOD_PERMISSIONS, name)) return false;
    const { guild, channel, options, user } = interaction;
    const actor = await guild.members.fetch({ user: user.id, force: true });
    const bot = await guild.members.fetchMe();
    if (!actor.permissions.has(MOD_PERMISSIONS[name])) throw new UserError('You do not have the Discord permission required for this command.');
    const reasonText = options.getString('reason')?.trim() || 'No reason provided';
    const auditReason = `${user.id}: ${reasonText}`;
    const log = (details = {}) => this.logger.log('mod', `/${name}`, { Moderator: user.id, Channel: channel.id, Reason: reasonText, ...details });
    if (name === 'say') {
      const destination = options.getChannel('channel') || channel;
      if (destination.guildId !== guild.id || !destination.isTextBased()) throw new UserError('Choose a text channel in this server.');
      for (const member of [actor, bot]) {
        if (!destination.permissionsFor(member)?.has([P.ViewChannel, P.SendMessages])) throw new UserError('Both you and the bot need access to send messages in that channel.');
      }
      const content = options.getString('message', true);
      const sent = await destination.send({ content, allowedMentions: { parse: [] } });
      await log({ Destination: destination.id, Message: sent.id, Content: content });
      return `Message sent: ${sent.url}`;
    }
    if (name === 'clear') {
      const required = [P.ViewChannel, P.ReadMessageHistory, P.ManageMessages];
      if (!channel.bulkDelete || !channel.permissionsFor(actor)?.has(required) || !channel.permissionsFor(bot)?.has(required)) {
        throw new UserError('Both you and the bot need View Channel, Read Message History and Manage Messages here.');
      }
      const contains = options.getString('contains');
      if (contains && !this.config.messageContentEnabled) throw new UserError('Text filtering needs Message Content Intent enabled and ENABLE_MESSAGE_CONTENT=true. You can still filter by user.');
      const recent = await channel.messages.fetch({ limit: 100 });
      const selected = selectClearMessages(recent, { amount: options.getInteger('amount', true), userId: options.getUser('user')?.id, contains });
      if (!selected.length) return 'No matching recent messages were found. Pinned messages and messages near or over 14 days old are skipped.';
      const deleted = await channel.bulkDelete(selected.map(message => message.id), true);
      await log({ Deleted: deleted.size, 'Message IDs': [...deleted.keys()].join(', '), Filter: contains || options.getUser('user')?.id || 'None' });
      return `Cleared ${deleted.size} matching message(s) from the latest 100. Pinned and old messages were kept.`;
    }
    if (['lock', 'unlock', 'slowmode'].includes(name)) {
      if (channel.type !== ChannelType.GuildText) throw new UserError('Use this command in a standard text channel.');
      if (!channel.permissionsFor(actor)?.has(P.ManageChannels) || !channel.permissionsFor(bot)?.has(P.ManageChannels)) throw new UserError('You and the bot need Manage Channels here.');
      if (name === 'slowmode') {
        const seconds = options.getInteger('seconds', true);
        await channel.setRateLimitPerUser(seconds, auditReason);
        await log({ Seconds: seconds });
        return seconds ? `Slowmode set to ${seconds} seconds.` : 'Slowmode disabled.';
      }
      if (!channel.permissionsFor(bot)?.has(P.ManageRoles)) throw new UserError('The bot needs Manage Roles to change channel permissions.');
      if (this.busy.has(channel.id)) throw new UserError('This channel is being updated. Try again in a moment.');
      this.busy.add(channel.id);
      try {
        const previous = this.store.data.channelLocks[channel.id];
        if (name === 'lock') {
          if (previous) throw new UserError('This channel is already locked by the bot.');
          const overwrite = channel.permissionOverwrites.cache.get(guild.id);
          const value = overwrite?.allow.has(P.SendMessages) ? true : overwrite?.deny.has(P.SendMessages) ? false : null;
          this.store.data.channelLocks[channel.id] = { guildId: guild.id, sendMessages: value };
          this.store.save();
          try { await channel.permissionOverwrites.edit(guild.id, { SendMessages: false }, { reason: auditReason }); }
          catch (error) { delete this.store.data.channelLocks[channel.id]; this.store.save(); throw error; }
        } else {
          if (!previous || previous.guildId !== guild.id) throw new UserError('There is no saved /lock setting to restore for this channel.');
          await channel.permissionOverwrites.edit(guild.id, { SendMessages: previous.sendMessages }, { reason: auditReason });
          delete this.store.data.channelLocks[channel.id];
          this.store.save();
        }
      } finally { this.busy.delete(channel.id); }
      await log();
      return name === 'lock' ? 'Channel locked for @everyone. Roles with an explicit send permission may still write.' : 'The previous @everyone send permission has been restored.';
    }
    if (name === 'unban') {
      if (!bot.permissions.has(P.BanMembers)) throw new UserError('The bot needs Ban Members.');
      const id = options.getString('user-id', true);
      if (!/^\d{17,20}$/.test(id)) throw new UserError('Provide a valid Discord user ID.');
      await guild.members.unban(id, auditReason);
      await log({ Member: id });
      return `Unbanned <@${id}>.`;
    }
    const targetUser = options.getUser('member', true);
    const key = `${guild.id}:${targetUser.id}`;
    if (name === 'warnings') {
      const warnings = this.store.data.warnings[key] || [];
      await log({ Member: targetUser.id, Count: warnings.length });
      return warnings.length ? `Warnings for <@${targetUser.id}> (${warnings.length} total):\n${warnings.slice(-10).map(w => `• ${w.at.slice(0, 10)} — ${w.reason.slice(0, 140)} (by ${w.moderatorId})`).join('\n')}` : 'This member has no saved warnings.';
    }
    const targetMember = await guild.members.fetch({ user: targetUser.id, force: true });
    checkHierarchy(actor, targetMember, guild, bot.id);
    if (name === 'warn') {
      (this.store.data.warnings[key] ??= []).push({ reason: reasonText, moderatorId: user.id, at: new Date().toISOString() });
      this.store.save();
      let delivered = true;
      try { await targetUser.send({ content: `You received a warning in **${guild.name}**.\nReason: ${reasonText}`, allowedMentions: { parse: [] } }); }
      catch { delivered = false; }
      await log({ Member: targetUser.id, 'DM delivered': delivered });
      return `Warning saved for <@${targetUser.id}>.${delivered ? ' They were notified by DM.' : ' Their DM could not be delivered.'}`;
    }
    if (!bot.permissions.has(MOD_PERMISSIONS[name])) throw new UserError('The bot lacks the Discord permission for that action.');
    if (name === 'timeout' || name === 'untimeout') {
      if (!targetMember.moderatable) throw new UserError('This member cannot be timed out by the bot.');
      await targetMember.timeout(name === 'timeout' ? options.getInteger('minutes', true) * 60_000 : null, auditReason);
    } else if (name === 'kick') {
      if (!targetMember.kickable) throw new UserError('The bot cannot kick this member.');
      await targetMember.kick(auditReason);
    } else if (name === 'ban') {
      if (!targetMember.bannable) throw new UserError('The bot cannot ban this member.');
      await targetMember.ban({ reason: auditReason, deleteMessageSeconds: 0 });
    }
    await log({ Member: targetUser.id, ...(name === 'timeout' ? { Minutes: options.getInteger('minutes', true) } : {}) });
    return `/${name} completed for <@${targetUser.id}>.`;
  }
}
