import { AuditLogEvent, EmbedBuilder, Events } from 'discord.js';

export const clip = (value, size = 1000) => String(value ?? 'Unknown').slice(0, size) || '—';
const describe = value => value ? `${value.name || value.tag || value.username || ''} (${value.id})` : 'Unknown';

export class Logger {
  constructor(client, config, store) {
    Object.assign(this, { client, config, store });
    store.data.pendingLogs ??= [];
    this.flushing = false;
  }

  async log(kind, title, fields = {}) {
    const item = { kind, title: clip(title, 256), fields, at: new Date().toISOString() };
    this.store.data.pendingLogs.push(item);
    if (this.store.data.pendingLogs.length > 2000) {
      this.store.data.pendingLogs.shift();
      console.error('Log backlog exceeded 2000 entries; oldest queued log removed.');
    }
    this.store.save();
    // Events should not wait behind an unavailable Discord log channel.
    void this.flush();
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.store.data.pendingLogs.length) {
        const item = this.store.data.pendingLogs[0];
        const id = item.kind === 'mod' ? this.config.modLogChannelId : this.config.eventLogChannelId;
        const channel = await this.client.channels.fetch(id);
        if (!channel?.isTextBased() || channel.guildId !== this.config.guildId) throw new Error('Log channel is unavailable or in the wrong server.');
        const embed = new EmbedBuilder().setColor(item.kind === 'mod' ? 0xe6a23c : 0x528cff)
          .setTitle(item.title).setTimestamp(new Date(item.at))
          .addFields(Object.entries(item.fields).slice(0, 12).map(([name, value]) => ({ name: clip(name, 256), value: clip(value, 400) })));
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        this.store.data.pendingLogs.shift();
        this.store.save();
      }
    } catch (error) { console.error('Log delivery deferred:', error.message); }
    finally { this.flushing = false; }
  }

  start() {
    this.timer = setInterval(() => void this.flush(), 60_000);
    this.timer.unref();
    void this.flush();
  }
  stop() { clearInterval(this.timer); }
}

export function registerEventLogs(client, config, logger) {
  const on = (event, handler) => client.on(event, (...args) => {
    Promise.resolve().then(() => handler(...args)).catch(error => console.error(`Event logging failed (${event}):`, error.message));
  });
  const allowed = guild => guild?.id === config.guildId;
  const visibleMessage = message => message.guildId === config.guildId
    && ![config.modLogChannelId, config.eventLogChannelId].includes(message.channelId);
  const content = message => config.messageContentEnabled ? clip(message?.content || '(content not cached)', 400)
    : '(message content logging is disabled)';

  on(Events.GuildMemberAdd, m => allowed(m.guild) && logger.log('event', 'Member joined', { Member: describe(m.user), Count: m.guild.memberCount }));
  on(Events.GuildMemberRemove, m => allowed(m.guild) && logger.log('event', 'Member left', { Member: describe(m.user), Count: m.guild.memberCount }));
  on(Events.GuildMemberUpdate, (before, after) => {
    if (!allowed(after.guild)) return;
    const added = after.roles.cache.filter(role => !before.roles.cache.has(role.id)).map(describe);
    const removed = before.roles.cache.filter(role => !after.roles.cache.has(role.id)).map(describe);
    const fields = { Member: describe(after.user) };
    if (added.length) fields['Roles added'] = added.join('\n');
    if (removed.length) fields['Roles removed'] = removed.join('\n');
    if (before.nickname !== after.nickname) fields.Nickname = `${before.nickname || '(none)'} → ${after.nickname || '(none)'}`;
    if (before.communicationDisabledUntilTimestamp !== after.communicationDisabledUntilTimestamp) fields.Timeout = after.communicationDisabledUntil?.toISOString() || 'Removed';
    if (Object.keys(fields).length > 1) return logger.log('event', 'Member updated', fields);
  });
  on(Events.MessageDelete, message => visibleMessage(message) && logger.log('event', 'Message deleted', {
    Channel: message.channelId, Message: message.id, Author: describe(message.author), Content: content(message),
  }));
  on(Events.MessageBulkDelete, (messages, channel) => channel.guildId === config.guildId
    && ![config.modLogChannelId, config.eventLogChannelId].includes(channel.id)
    && logger.log('event', 'Messages bulk deleted', { Channel: channel.id, Count: messages.size, 'Message IDs': [...messages.keys()].join(', ') }));
  on(Events.MessageUpdate, (before, after) => {
    if (!visibleMessage(after) || before.editedTimestamp === after.editedTimestamp) return;
    return logger.log('event', 'Message edited', { Channel: after.channelId, Message: after.id, Author: describe(after.author), Before: content(before), After: content(after) });
  });
  for (const [event, title] of [[Events.ChannelCreate, 'Channel created'], [Events.ChannelDelete, 'Channel deleted'],
    [Events.GuildRoleCreate, 'Role created'], [Events.GuildRoleDelete, 'Role deleted'],
    [Events.ThreadCreate, 'Thread created'], [Events.ThreadDelete, 'Thread deleted']]) {
    on(event, item => allowed(item.guild) && logger.log('event', title, { Item: describe(item) }));
  }
  for (const [event, title] of [[Events.ChannelUpdate, 'Channel updated'], [Events.GuildRoleUpdate, 'Role updated'], [Events.ThreadUpdate, 'Thread updated']]) {
    on(event, (before, after) => allowed(after.guild) && logger.log('event', title, { Item: describe(after), Before: before.name, After: after.name }));
  }
  on(Events.VoiceStateUpdate, (before, after) => {
    if (!allowed(after.guild)) return;
    if (before.channelId !== after.channelId || before.serverMute !== after.serverMute || before.serverDeaf !== after.serverDeaf) {
      return logger.log('event', 'Voice state changed', { Member: after.id, From: before.channelId || 'Not connected', To: after.channelId || 'Disconnected', Muted: after.serverMute, Deafened: after.serverDeaf });
    }
  });
  for (const [event, title] of [[Events.GuildBanAdd, 'Member banned'], [Events.GuildBanRemove, 'Member unbanned']]) {
    on(event, ban => allowed(ban.guild) && logger.log('mod', title, { Member: describe(ban.user) }));
  }
  on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (!allowed(guild)) return;
    const moderation = [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberBanRemove,
      AuditLogEvent.MemberUpdate, AuditLogEvent.MessageDelete, AuditLogEvent.MessageBulkDelete].includes(entry.action);
    return logger.log(moderation ? 'mod' : 'event', 'Server audit action', {
      Action: AuditLogEvent[entry.action] || entry.action, Actor: entry.executorId || 'Unknown',
      Target: entry.targetId || 'Unknown', Reason: entry.reason || 'Not provided',
      Changes: JSON.stringify(entry.changes || []), 'Audit entry': entry.id,
    });
  });
}
