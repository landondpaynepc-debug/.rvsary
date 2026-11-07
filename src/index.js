import http from 'node:http';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events,
  GatewayIntentBits, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder,
} from 'discord.js';
import { readConfig } from './config.js';
import { panelPayload, welcomePayload } from './panels.js';
import { Store } from './store.js';
import { TicketService, UserError, canClose } from './tickets.js';
import { VerificationService } from './verification.js';

const config = readConfig();
const store = new Store(config.dataDir);
const tickets = new TicketService(config, store);
const verification = new VerificationService(config);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
let publishing = false;
let ready = false;

const server = http.createServer((request, response) => {
  response.writeHead(ready && client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ bot: '.revisonary', ready: ready && client.isReady() }));
}).listen(config.port, '0.0.0.0');
server.on('error', error => { console.error('Health endpoint failed:', error.message); process.exit(1); });

const setup = new SlashCommandBuilder().setName('setup')
  .setDescription('Post or update the .revisonary verification and dashboard panels.')
  .setDefaultMemberPermissions(P.Administrator)
  .addStringOption(option => option.setName('panel').setDescription('Which panel to publish')
    .addChoices({ name: 'Both panels', value: 'all' }, { name: 'Verification', value: 'verification' },
      { name: 'Dashboard', value: 'dashboard' }));

async function publishPanel(guild, kind) {
  const channelId = kind === 'verification' ? config.verificationChannelId : config.dashboardChannelId;
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
  return `${kind === 'verification' ? 'Verification' : 'Dashboard'}: ${message.url}`;
}

client.once(Events.ClientReady, async () => {
  try {
    const verificationChannel = await client.channels.fetch(config.verificationChannelId);
    if (!verificationChannel?.guildId) throw new Error('The bot cannot access the configured verification channel. Invite it to the server and allow View Channel.');
    if (config.guildId && config.guildId !== verificationChannel.guildId) throw new Error('GUILD_ID does not match the verification channel server.');
    config.guildId = verificationChannel.guildId;
    const guild = await client.guilds.fetch(config.guildId);
    // Create/upsert this command without replacing any other application commands.
    await guild.commands.create(setup.toJSON());
    ready = true;
    console.log(`Connected as ${client.user.tag}. Run /setup in your server to publish the panels.`);
    if (!config.supportRoleId) console.log('Set SUPPORT_ROLE_ID to enable support ticket creation.');
  } catch (error) {
    console.error('Startup failed:', error.message);
    client.destroy();
    server.close();
    process.exitCode = 1;
  }
});

client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id !== config.guildId) return;
  try {
    await verification.assignOnJoin(member.guild, member.id);
  } catch (error) { console.error('New-member role assignment failed:', member.id, error.message); }
  // Still welcome the member if role assignment fails.
  try {
    const channel = await member.guild.channels.fetch(config.welcomeChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('WELCOME_CHANNEL_ID must be a text channel.');
    await channel.send(welcomePayload(member, config));
  } catch (error) { console.error('Welcome message failed:', error.message); }
});

client.on(Events.InteractionCreate, async interaction => {
  const ours = (interaction.isChatInputCommand() && interaction.commandName === 'setup')
    || ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('rv:'));
  if (!ours) return;
  try {
    if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
      throw new UserError('This bot is configured for a different server.');
    }
    if (interaction.isChatInputCommand()) {
      if (!interaction.memberPermissions?.has(P.Administrator)) throw new UserError('Only administrators can publish these panels.');
      if (publishing) throw new UserError('Panels are already being updated. Please wait.');
      publishing = true;
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const option = interaction.options.getString('panel') || 'all';
        const kinds = option === 'all' ? ['verification', 'dashboard'] : [option];
        const messages = [];
        for (const kind of kinds) {
          messages.push(await publishPanel(interaction.guild, kind));
          await interaction.editReply(messages.join('\n'));
        }
        if (!config.supportRoleId && kinds.includes('dashboard')) messages.push('Set SUPPORT_ROLE_ID and restart to enable support tickets.');
        await interaction.editReply(messages.join('\n'));
      } finally { publishing = false; }
      return;
    }
    if (interaction.customId === 'rv:verify') {
      if (interaction.channelId !== config.verificationChannelId) throw new UserError('Please use the Verify button in the verification channel.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await verification.verify(interaction.guild, interaction.user.id);
      await interaction.editReply({ content: 'You’re verified! Your verified role has been added and your new-member role removed.', allowedMentions: { parse: [] } });
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'rv:support') {
      if (interaction.channelId !== config.dashboardChannelId) throw new UserError('Please use the support menu in the dashboard channel.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await tickets.open(interaction, interaction.values[0]);
      await interaction.editReply({ content: `${result.existing ? 'You already have an open ticket' : 'Your private ticket is ready'}: <#${result.channel.id}>`, allowedMentions: { parse: [] } });
      return;
    }
    if (interaction.customId === 'rv:close') {
      const ticket = store.data.tickets[interaction.channelId];
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!ticket || ticket.guildId !== interaction.guildId || !canClose(member, ticket)) throw new UserError('Only the ticket owner or assigned staff can close this ticket.');
      if (ticket.closed) throw new UserError('This ticket is already closed.');
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
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
      await interaction.editReply({ content: 'Ticket closed. Your conversation has been kept for reference.', components: [] });
    }
  } catch (error) {
    console.error('Interaction failed:', error.name, error.code ?? '', error.message);
    const content = error instanceof UserError ? error.message
      : 'Something went wrong. Please ask an administrator to check the bot logs and channel permissions.';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [] });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyError) { console.error('Could not deliver error reply:', replyError.message); }
  }
});

client.on(Events.Error, error => console.error('Discord connection error:', error.message));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { ready = false; client.destroy(); server.close(); });
}
client.login(config.token).catch(error => {
  console.error('Login failed:', error.message);
  client.destroy(); server.close(); process.exitCode = 1;
});
