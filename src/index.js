import http from 'node:http';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events,
  ApplicationFlags, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits as P, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import { readConfig } from './config.js';
import { panelPayload, welcomePayload } from './panels.js';
import { Store } from './store.js';
import { TicketService, UserError } from './tickets.js';
import { VerificationService } from './verification.js';
import { Logger, registerEventLogs } from './logging.js';
import { MOD_PERMISSIONS, ModerationService, moderationCommands } from './moderation.js';
import { ApplicationService, applicationCommand } from './applications.js';

const config = readConfig();
if (!config.messageContentEnabled && process.env.ENABLE_MESSAGE_CONTENT !== 'false') {
  try {
    const application = await new REST({ version: '10' }).setToken(config.token).get(Routes.currentApplication());
    config.messageContentEnabled = Boolean(application.flags & (ApplicationFlags.GatewayMessageContent | ApplicationFlags.GatewayMessageContentLimited));
  } catch (error) { console.error('Message-content capability check failed; using metadata logs:', error.code ?? error.name); }
}
const store = new Store(config.dataDir);
const tickets = new TicketService(config, store);
const verification = new VerificationService(config);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildVoiceStates, ...(config.messageContentEnabled ? [GatewayIntentBits.MessageContent] : [])],
partials: [Partials.Channel, Partials.Message, Partials.GuildMember] });
const logger = new Logger(client, config, store);
const moderation = new ModerationService(config, store, logger);
const applications = new ApplicationService(client, config, store, logger);
registerEventLogs(client, config, logger);
client.on(Events.MessageCreate, message => void applications.onMessage(message));
let applicationTimer;
let publishing = false;
let ready = false;

const server = http.createServer((request, response) => {
  response.writeHead(ready && client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ bot: '.revisonary', ready: ready && client.isReady() }));
}).listen(config.port, '0.0.0.0');
server.on('error', error => { console.error('Health endpoint failed:', error.message); process.exit(1); });

const setup = new SlashCommandBuilder().setName('setup')
  .setDescription('Post or update the .revisonary verification, dashboard and careers panels.')
  .setDefaultMemberPermissions(P.Administrator)
  .addStringOption(option => option.setName('panel').setDescription('Which panel to publish')
    .addChoices({ name: 'All panels', value: 'all' }, { name: 'Verification', value: 'verification' },
      { name: 'Dashboard', value: 'dashboard' }, { name: 'Careers', value: 'careers' }));

async function publishPanel(guild, kind) {
  const channelId = kind === 'verification' ? config.verificationChannelId : kind === 'careers' ? config.careersChannelId : config.dashboardChannelId;
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) throw new UserError(`The ${kind} channel must be a text channel in this server.`);
  const me = await guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks])) {
    throw new UserError(`The bot needs View Channel, Send Messages, Read Message History, Attach Files and Embed Links in the ${kind} channel.`);
  }
  const key = `${guild.id}:${kind}`;
  const saved = store.data.panels[key];
  let old;
  if (saved?.channelId === channel.id) {
    try { old = await channel.messages.fetch(saved.messageId); }
    catch (error) { if (error.code !== 10008) throw error; }
  }
  const payload = panelPayload(kind, config);
  const message = old
    ? await old.edit({ ...payload, attachments: [] })
    : await channel.send(payload);
  store.data.panels[key] = { channelId: channel.id, messageId: message.id };
  store.save();
  return `${kind[0].toUpperCase() + kind.slice(1)}: ${message.url}`;
}

client.once(Events.ClientReady, async () => {
  try {
    const verificationChannel = await client.channels.fetch(config.verificationChannelId);
    if (!verificationChannel?.guildId) throw new Error('The bot cannot access the configured verification channel. Invite it to the server and allow View Channel.');
    if (config.guildId && config.guildId !== verificationChannel.guildId) throw new Error('GUILD_ID does not match the verification channel server.');
    config.guildId = verificationChannel.guildId;
    const guild = await client.guilds.fetch(config.guildId);
    // Upsert our commands without removing any unrelated application commands.
    for (const command of [setup, applicationCommand(), ...moderationCommands()]) await guild.commands.create(command.toJSON());
    ready = true;
    console.log(`Connected as ${client.user.tag}. Run /setup in your server to publish the panels.`);
    console.log(`Message content logging: ${config.messageContentEnabled ? 'enabled' : 'metadata only; enable Message Content Intent and restart for content'}.`);
    logger.start();
    await logger.log('event', 'Bot online', { Bot: client.user.tag, 'Message content logging': config.messageContentEnabled });
    if (store.data.panels[`${guild.id}:verification`]) {
      try {
        console.log(`Verification panel refreshed: ${await publishPanel(guild, 'verification')}`);
      } catch (error) { console.error('Verification panel refresh failed:', error.message); }
    }
    if (!config.supportRoleId) console.log('Set SUPPORT_ROLE_ID to enable support ticket creation.');
    try { console.log(`Careers panel ready: ${await publishPanel(guild, 'careers')}`); }
    catch (error) { console.error('Careers panel failed:', error.message); }
    await tickets.restoreControls(guild);
    await applications.recover();
    applicationTimer = setInterval(() => void applications.recover().catch(error => console.error('Application recovery failed:', error.message)), 5 * 60_000);
    applicationTimer.unref();
  } catch (error) {
    console.error('Startup failed:', error.message);
    logger.stop(); clearInterval(applicationTimer);
    client.destroy();
    server.close();
    process.exitCode = 1;
  }
});

client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id !== config.guildId) return;
  try {
    await verification.assignOnJoin(member.guild, member.id);
    await logger.log('event', 'New-member role assigned', { Member: member.id, Role: config.unverifiedRoleId });
  } catch (error) {
    console.error('New-member role assignment failed:', member.id, error.message);
    await logger.log('event', 'New-member role assignment failed', { Member: member.id, Error: error.message }).catch(() => {});
  }
  // Still welcome the member if role assignment fails.
  try {
    const channel = await member.guild.channels.fetch(config.welcomeChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('WELCOME_CHANNEL_ID must be a text channel.');
    await channel.send(welcomePayload(member, config));
  } catch (error) {
    console.error('Welcome message failed:', error.message);
    await logger.log('event', 'Welcome message failed', { Member: member.id, Error: error.message }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async interaction => {
  const ours = (interaction.isChatInputCommand() && ['setup', 'apply', ...Object.keys(MOD_PERMISSIONS)].includes(interaction.commandName))
    || ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith('rv:'));
  if (!ours) return;
  try {
    if (await applications.handle(interaction)) return;
    if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
      throw new UserError('This bot is configured for a different server.');
    }
    if (interaction.isChatInputCommand() && Object.hasOwn(MOD_PERMISSIONS, interaction.commandName)) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await moderation.run(interaction);
      await interaction.editReply({ content: result, allowedMentions: { parse: [] } }); return;
    }
    if (interaction.isChatInputCommand()) {
      if (!interaction.memberPermissions?.has(P.Administrator)) throw new UserError('Only administrators can publish these panels.');
      if (publishing) throw new UserError('Panels are already being updated. Please wait.');
      publishing = true;
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const option = interaction.options.getString('panel') || 'all';
        const kinds = option === 'all' ? ['verification', 'dashboard', 'careers'] : [option];
        const messages = [];
        for (const kind of kinds) {
          messages.push(await publishPanel(interaction.guild, kind));
          await interaction.editReply(messages.join('\n'));
        }
        if (!config.supportRoleId && kinds.includes('dashboard')) messages.push('Set SUPPORT_ROLE_ID and restart to enable support tickets.');
        await interaction.editReply(messages.join('\n'));
        await logger.log('event', 'Panels published', { Administrator: interaction.user.id, Panels: kinds.join(', ') });
      } finally { publishing = false; }
      return;
    }
    if (interaction.customId === 'rv:verify') {
      if (interaction.channelId !== config.verificationChannelId) throw new UserError('Please use the Verify button in the verification channel.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await verification.verify(interaction.guild, interaction.user.id);
      await logger.log('event', 'Member verified', { Member: interaction.user.id, Added: config.verifiedRoleId, Removed: config.unverifiedRoleId });
      await interaction.editReply({ content: 'You’re verified! Your verified role has been added and your new-member role removed.', allowedMentions: { parse: [] } });
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'rv:support') {
      if (interaction.channelId !== config.dashboardChannelId) throw new UserError('Please use the support menu in the dashboard channel.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await tickets.open(interaction, interaction.values[0]);
      if (!result.existing) await logger.log('event', 'Ticket opened', { Member: interaction.user.id, Channel: result.channel.id, Type: interaction.values[0] });
      await interaction.editReply({ content: `${result.existing ? 'You already have an open ticket' : 'Your private ticket is ready'}: <#${result.channel.id}>`, allowedMentions: { parse: [] } });
      return;
    }
    if (interaction.customId === 'rv:claim') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await tickets.claim(interaction);
      await logger.log('event', 'Ticket claimed', { Staff: interaction.user.id, Channel: interaction.channelId });
      await interaction.editReply({ content: 'You claimed this ticket. The ticket now shows you as the assigned staff member.', allowedMentions: { parse: [] } });
      return;
    }
    if (interaction.customId === 'rv:close') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { ticket } = await tickets.authorize(interaction);
      if (ticket.closed) throw new UserError('This ticket is already closed.');
      await interaction.editReply({
        content: 'Close this ticket? The conversation will be kept for reference.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('rv:confirm-close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('rv:cancel-close').setLabel('Keep Open').setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }
    if (interaction.customId === 'rv:cancel-close') {
      await interaction.update({ content: 'Ticket left open.', components: [] });
      return;
    }
    if (interaction.customId === 'rv:confirm-close') {
      await interaction.deferUpdate();
      await tickets.close(interaction);
      await logger.log('event', 'Ticket closed', { Member: interaction.user.id, Channel: interaction.channelId });
      await interaction.editReply({ content: 'Ticket closed. Your conversation has been kept for reference. Staff can use Delete Ticket to remove it permanently.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('rv:delete').setLabel('Delete Ticket').setStyle(ButtonStyle.Danger),
        )] });
      return;
    }
    if (interaction.customId === 'rv:delete') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { ticket } = await tickets.authorize(interaction, true);
      if (!ticket.closed) throw new UserError('Close this ticket before deleting it.');
      await interaction.editReply({
        content: 'Permanently delete this closed ticket and its entire conversation? This cannot be undone.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('rv:confirm-delete').setLabel('Delete Permanently').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('rv:cancel-delete').setLabel('Keep Ticket').setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }
    if (interaction.customId === 'rv:cancel-delete') {
      await interaction.update({ content: 'Ticket kept. Nothing was deleted.', components: [] });
      return;
    }
    if (interaction.customId === 'rv:confirm-delete') {
      await interaction.deferUpdate();
      await tickets.delete(interaction);
      await logger.log('event', 'Ticket deleted', { Staff: interaction.user.id, Channel: interaction.channelId });
      // Discord may discard the ephemeral reply together with the deleted channel.
      try { await interaction.editReply({ content: 'Ticket permanently deleted.', components: [] }); }
      catch (error) { console.log('Ticket deleted; final reply unavailable:', error.code ?? error.name); }
      return;
    }
  } catch (error) {
    console.error('Interaction failed:', error.name, error.code ?? '', error.message);
    const logKind = interaction.commandName === 'apply' || interaction.customId?.startsWith('rv:app') ? 'application'
      : interaction.isChatInputCommand() && Object.hasOwn(MOD_PERMISSIONS, interaction.commandName) ? 'mod' : 'event';
    try { await logger.log(logKind, 'Bot action failed', {
      Member: interaction.user.id, Action: interaction.commandName || interaction.customId, Error: error.message,
    }); } catch (logError) { console.error('Could not save failure log:', logError.message); }
    const content = error instanceof UserError ? error.message
      : 'Something went wrong. Please ask an administrator to check the bot logs and channel permissions.';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
      else await interaction.reply({ content, ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}), allowedMentions: { parse: [] } });
    } catch (replyError) { console.error('Could not deliver error reply:', replyError.message); }
  }
});

client.on(Events.Error, error => console.error('Discord connection error:', error.message));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { ready = false; logger.stop(); clearInterval(applicationTimer); client.destroy(); server.close(); });
}
client.login(config.token).catch(error => {
  console.error('Login failed:', error.message);
  client.destroy(); server.close(); process.exitCode = 1;
});
