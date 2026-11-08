import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder,
  PermissionFlagsBits as P, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { UserError } from './tickets.js';

export const TRACKS = { support: 'Support Staff', management: 'Management+', design: 'Design Team' };
export const SPECIALTIES = { gfx: 'GFX', vfx: 'VFX', discord: 'Discord Services' };
export const QUESTIONS = {
  support: [
    'Why do you want to join .revisonary as Support Staff?',
    'What customer support or Discord moderation experience do you have?',
    'A client is upset about a delayed order. How would you handle their ticket?',
    'When would you escalate a ticket to management, and what information would you include?',
    'What is your timezone and typical weekly availability? Add anything else you want reviewers to know.',
  ],
  management: [
    'Why are you applying for Management+, and what leadership experience do you have?',
    'How would you handle a report against a staff member fairly?',
    'Two team members disagree over an order. How would you resolve the situation?',
    'How would you organize the team, track work, and improve service quality?',
    'What is your timezone and weekly availability? What would be your first priority as a manager?',
  ],
  design: [
    'Which services do you provide? Select one or more below.',
    'Share public portfolio or sample-work links for the services you selected.',
    'Describe your experience and the tools you use for those services.',
    'How do you handle a client brief, revisions, and quality checks?',
    'What is your timezone, weekly availability, and usual turnaround time?',
  ],
};
export const applicationCommand = () => new SlashCommandBuilder().setName('apply').setDescription('Start or resume an application in your DMs.')
  .setDMPermission(false).addStringOption(o => o.setName('team').setDescription('Team to apply for').setRequired(true)
    .addChoices(...Object.entries(TRACKS).map(([value, name]) => ({ name, value }))));
export const applicationResetCommand = () => new SlashCommandBuilder().setName('reset-applications')
  .setDescription('Reset all applications after confirmation. Restricted to authorized staff.').setDMPermission(false);

export function acceptedRoles(app, config) {
  if (app.track === 'support') return [...new Set([config.supportRoleId, config.supportApplicationRoleId])];
  if (app.track === 'management') return [...new Set([config.supportRoleId, config.managementApplicationRoleId])];
  const ids = { gfx: config.gfxRoleId, vfx: config.vfxRoleId, discord: config.discordServicesRoleId };
  if (!config.designRoleId || !app.specialties?.length || app.specialties.some(value => !ids[value])) {
    throw new UserError('Design Team roles are not fully configured for these specialties.');
  }
  return [...new Set([config.designRoleId, ...app.specialties.map(value => ids[value])])];
}
export const canReview = (member, config) => member.permissions.has(P.Administrator)
  || [config.applicationReviewerRoleId, config.applicationAdditionalReviewerRoleId].some(id => id && member.roles.cache.has(id));
export const canResetApplications = (member, config) => member.permissions.has(P.Administrator)
  || Boolean(config.applicationAdditionalReviewerRoleId && member.roles.cache.has(config.applicationAdditionalReviewerRoleId));

export function reviewPayload(app) {
  const pending = app.status === 'pending' || app.status === 'submitting';
  const embed = new EmbedBuilder().setColor(app.status === 'accepted' ? 0x4bb987 : app.status === 'denied' ? 0xe15b64 : 0x528cff)
    .setTitle(`${TRACKS[app.track]} application`).setDescription(`Applicant: <@${app.userId}> (${app.userId})\nStatus: **${app.status}**`)
    .addFields(QUESTIONS[app.track].map((q, index) => ({ name: `${index + 1}. ${q}`.slice(0, 256), value: (app.answers[index] || 'Not answered').slice(0, 800) })))
    .setFooter({ text: `Application ${app.id}` }).setTimestamp(new Date(app.createdAt));
  if (app.reason) embed.addFields({ name: 'Review decision', value: `${app.status} by <@${app.reviewerId}>\n${app.reason}`.slice(0, 800) });
  if (app.notificationStatus) embed.addFields({ name: 'Decision DM', value: app.notificationStatus === 'sent' ? 'Delivered' : 'Delivery pending; retrying automatically.' });
  return { embeds: [embed], allowedMentions: { parse: [] }, components: pending ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rv:app:accept:${app.id}`).setLabel('Accept with reason').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rv:app:deny:${app.id}`).setLabel('Deny with reason').setStyle(ButtonStyle.Danger),
  )] : [] };
}

export class ApplicationService {
  constructor(client, config, store, logger) {
    Object.assign(this, { client, config, store, logger });
    this.busy = new Set();
    this.resetConfirmations = new Map();
    store.data.applications ??= {};
    // Preserve existing review links when the destination changes.
    let migrated = false;
    for (const app of Object.values(store.data.applications)) if (!app.reviewChannelId) {
      app.reviewChannelId = app.reviewMessageId || app.status === 'submitting'
        ? config.legacyApplicationReviewChannelId : config.applicationReviewChannelId;
      migrated = true;
    }
    if (migrated) store.save();
    // Interrupted role changes are rolled back by recover() before review is reopened.
  }
  reviewChannelId(app) { return app.reviewChannelId || this.config.applicationReviewChannelId; }
  async ensureReviewerAccess(guild) {
    const role = await guild.roles.fetch(this.config.applicationAdditionalReviewerRoleId);
    const channel = await guild.channels.fetch(this.config.applicationReviewChannelId);
    if (!role || !channel?.permissionOverwrites) throw new UserError('The additional reviewer role or application channel is unavailable.');
    if (!channel.permissionsFor(role)?.has([P.ViewChannel, P.ReadMessageHistory, P.UseApplicationCommands])) {
      await channel.permissionOverwrites.edit(role.id, { ViewChannel: true, ReadMessageHistory: true, UseApplicationCommands: true },
        { reason: 'Owner authorized this role to review and reset applications' });
    }
  }
  async resetAllOnce(resetId, actor = 'Owner-requested startup reset') {
    if (this.resetting || this.busy.size || this.recovering || this.resetCleaning) {
      throw new UserError('An application action is still processing. Please try the reset again in a moment.');
    }
    this.resetting = true;
    try { return await this.performReset(resetId, actor); }
    finally { this.resetting = false; }
  }
  async performReset(resetId, actor) {
    const completed = this.store.data.completedApplicationResets ??= {};
    const previous = this.store.data.applicationReset;
    if (previous) completed[previous.id] = true;
    if (!completed[resetId]) {
      const apps = Object.values(this.store.data.applications).filter(app => app.guildId === this.config.guildId);
      const ids = new Set(apps.map(app => app.id));
      const pendingReviews = [...(previous?.pendingReviews || []), ...apps.filter(app => app.reviewMessageId).map(app => ({
        applicationId: app.id, channelId: this.reviewChannelId(app), messageId: app.reviewMessageId,
      }))];
      this.store.data.applicationReset = {
        id: resetId, actor, at: new Date().toISOString(), cleared: apps.length, deletedReviews: 0,
        pendingReviews: [...new Map(pendingReviews.map(item => [`${item.channelId}:${item.messageId}`, item])).values()],
      };
      for (const id of ids) delete this.store.data.applications[id];
      // Drop undelivered old application activity along with drafts and decisions.
      this.store.data.pendingLogs = (this.store.data.pendingLogs || []).filter(item => item.kind !== 'application');
      completed[resetId] = true;
      this.store.save();
    }
    await this.cleanResetReviews();
    const reset = this.store.data.applicationReset;
    if (!reset.announced) {
      await this.logger.log('application', 'Applications reset', {
        'Applications cleared': reset.cleared, 'Review messages deleted': reset.deletedReviews,
        'Cleanup pending': reset.pendingReviews.length, 'Requested by': reset.actor || actor,
        Details: 'Everyone can apply again. Existing member roles were kept.',
      });
      reset.announced = true; this.store.save();
    }
    return { cleared: reset.cleared, deletedReviews: reset.deletedReviews, cleanupPending: reset.pendingReviews.length };
  }
  async cleanResetReviews() {
    const reset = this.store.data.applicationReset;
    if (!reset?.pendingReviews?.length || this.resetCleaning) return;
    this.resetCleaning = true;
    try {
      for (const item of [...reset.pendingReviews]) {
        try {
          const channel = await this.client.channels.fetch(item.channelId);
          if (channel) {
            const message = await channel.messages.fetch(item.messageId);
            if (message.author.id !== this.client.user.id
              || !message.embeds.some(embed => embed.footer?.text === `Application ${item.applicationId}`)) {
              throw new Error('Saved review message does not match this bot and application.');
            }
            await message.delete(); reset.deletedReviews++;
          }
        } catch (error) {
          if (![10003, 10008].includes(error.code)) {
            console.error('Application reset review cleanup deferred:', item.channelId, item.messageId, error.message);
            continue;
          }
        }
        reset.pendingReviews = reset.pendingReviews.filter(pending => pending !== item);
        this.store.save();
      }
    } finally { this.resetCleaning = false; }
  }
  async locked(key, fn) {
    if (this.resetting) throw new UserError('Applications are being reset. Please try again in a moment.');
    if (this.busy.has(key)) throw new UserError('Your previous application action is still processing. Please try again in a moment.');
    this.busy.add(key);
    try { return await fn(); } finally { this.busy.delete(key); }
  }
  active(userId) {
    return Object.values(this.store.data.applications).find(app => app.userId === userId && app.guildId === this.config.guildId
      && ['draft', 'ready', 'submitting', 'pending', 'deciding'].includes(app.status));
  }
  async begin(user, track) {
    if (!Object.hasOwn(TRACKS, track)) throw new UserError('Choose a team from the careers panel.');
    return this.locked(`user:${user.id}`, async () => {
      let app = this.active(user.id);
      if (app && ['pending', 'submitting', 'deciding'].includes(app.status)) throw new UserError('You already have an application waiting for review.');
      if (!app) {
        app = { id: randomBytes(12).toString('hex'), guildId: this.config.guildId, userId: user.id, track,
          status: 'draft', answers: [], specialties: [], createdAt: new Date().toISOString() };
        this.store.data.applications[app.id] = app;
        this.store.save();
        await this.logger.log('application', 'Application started', { Applicant: user.id, Team: TRACKS[track], Application: app.id });
      }
      try {
        await user.send({ content: `**.revisonary — ${TRACKS[app.track]} application**\nReply to each question here, up to 800 characters per answer. Your answers are saved and sent to the review team when you submit. Do not include passwords or private personal information. Type **cancel** to stop or **resume** to repeat the current question.`, allowedMentions: { parse: [] } });
        await this.prompt(user, app);
      } catch { throw new UserError('I could not send your questions. Enable DMs from this server, then use /apply again to resume.'); }
      return `Check your DMs for your ${TRACKS[app.track]} application.`;
    });
  }
  async prompt(user, app) {
    if (app.status === 'ready') {
      return user.send({ content: 'All answers are saved. Submit your application for staff review, or cancel it.', allowedMentions: { parse: [] },
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rv:app:submit:${app.id}`).setLabel('Submit Application').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`rv:app:cancel:${app.id}`).setLabel('Cancel Application').setStyle(ButtonStyle.Secondary),
        )] });
    }
    const index = app.answers.length;
    const components = app.track === 'design' && index === 0 ? [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`rv:app:specialties:${app.id}`).setPlaceholder('Select all your services')
        .setMinValues(1).setMaxValues(3).addOptions(Object.entries(SPECIALTIES).map(([value, label]) => ({ value, label }))),
    )] : [];
    await user.send({ content: `**Question ${index + 1}/${QUESTIONS[app.track].length}**\n${QUESTIONS[app.track][index]}`, components, allowedMentions: { parse: [] } });
  }
  async onMessage(message) {
    if (message.guildId || message.author.bot) return;
    const app = this.active(message.author.id);
    if (!app || !['draft', 'ready'].includes(app.status)) return;
    try {
      await this.locked(`user:${message.author.id}`, async () => {
        const answer = message.content?.trim();
        if (answer?.toLowerCase() === 'cancel') {
          app.status = 'cancelled'; this.store.save();
          await this.logger.log('application', 'Application cancelled', { Applicant: app.userId, Application: app.id });
          await message.reply('Your application was cancelled. You can start a new one from the careers panel.'); return;
        }
        if (answer?.toLowerCase() === 'resume' || app.status === 'ready') { await this.prompt(message.author, app); return; }
        if (app.track === 'design' && app.answers.length === 0) { await message.reply('Choose your services using the selection menu first.'); return; }
        if (!answer || answer.length > 800) { await message.reply('Please reply with 1–800 characters. For portfolio samples, paste public links.'); return; }
        if (app.lastAnswerMessageId === message.id) return;
        app.answers.push(answer); app.lastAnswerMessageId = message.id;
        if (app.answers.length === QUESTIONS[app.track].length) app.status = 'ready';
        this.store.save();
        await this.prompt(message.author, app);
      });
    } catch (error) {
      console.error('Application DM failed:', error.message);
      await message.reply(error instanceof UserError ? error.message : 'Your saved application is safe. Type resume to continue.').catch(() => {});
    }
  }
  async reviewer(interaction, app) {
    if (!app || interaction.guildId !== app.guildId || interaction.channelId !== this.reviewChannelId(app)) throw new UserError('Use the original application review message.');
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (!canReview(member, this.config)) {
      throw new UserError(`To accept or deny applications, you need reviewer role <@&${this.config.applicationReviewerRoleId}> or <@&${this.config.applicationAdditionalReviewerRoleId}>, or Administrator.`);
    }
    return member;
  }
  async submit(user, app) {
    if (app.status !== 'ready') throw new UserError('This application is not ready to submit, or it was already submitted.');
    const guild = await this.client.guilds.fetch(app.guildId);
    await guild.members.fetch({ user: app.userId, force: true });
    const channel = await guild.channels.fetch(this.config.applicationReviewChannelId);
    if (!channel?.isTextBased()) throw new UserError('The review channel is unavailable. Your answers are still saved.');
    app.reviewChannelId = channel.id;
    app.status = 'submitting'; this.store.save();
    try {
      const sent = await channel.send({ ...reviewPayload(app), nonce: app.id, enforceNonce: true });
      app.reviewMessageId = sent.id; app.status = 'pending'; app.submittedAt = new Date().toISOString(); this.store.save();
      await sent.edit(reviewPayload(app));
    } catch (error) {
      if (!app.reviewMessageId) app.status = 'ready';
      this.store.save(); throw error;
    }
    await this.logger.log('application', 'Application submitted', { Applicant: user.id, Team: TRACKS[app.track], Application: app.id });
  }
  async decide(interaction, app, decision, reason) {
    return this.locked(`review:${app?.id}`, async () => {
      await this.reviewer(interaction, app);
      if (app.status !== 'pending') throw new UserError('This application has already been reviewed or is still being submitted.');
      if (!['accept', 'deny'].includes(decision) || !reason.trim() || reason.length > 600) throw new UserError('Enter a decision reason between 1 and 600 characters.');
      app.status = 'deciding'; this.store.save();
      const added = [];
      let member;
      try {
        if (decision === 'accept') {
          const guild = interaction.guild;
          member = await guild.members.fetch({ user: app.userId, force: true });
          const bot = await guild.members.fetchMe();
          if (!bot.permissions.has(P.ManageRoles)) throw new UserError('The bot needs Manage Roles before this application can be accepted.');
          const ids = acceptedRoles(app, this.config);
          const roles = await Promise.all(ids.map(id => guild.roles.fetch(id)));
          if (roles.some(role => !role || role.id === guild.id || role.managed || !role.editable)) throw new UserError('Move the bot above all application reward roles, and check the configured role IDs.');
          app.provisionalRoleIds = roles.filter(role => !member.roles.cache.has(role.id)).map(role => role.id);
          this.store.save();
          for (const role of roles) if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role.id, `Application ${app.id} accepted by ${interaction.user.id}`); added.push(role.id);
          }
          app.grantedRoleIds = ids;
        }
      } catch (error) {
        let rollbackFailed = false;
        for (const id of added.reverse()) {
          try { await member.roles.remove(id, 'Application approval failed; undo partial grant'); }
          catch (rollbackError) { rollbackFailed = true; await this.logger.log('application', 'Application role rollback failed', { Applicant: app.userId, Role: id, Error: rollbackError.message }); }
        }
        app.status = rollbackFailed ? 'deciding' : 'pending';
        if (!rollbackFailed) delete app.provisionalRoleIds;
        this.store.save(); throw error;
      }
      delete app.provisionalRoleIds;
      app.status = decision === 'accept' ? 'accepted' : 'denied';
      app.reason = reason.trim(); app.reviewerId = interaction.user.id; app.decidedAt = new Date().toISOString();
      app.notificationStatus = 'pending'; app.reviewNeedsUpdate = true; this.store.save();
      await this.logger.log('application', 'Application reviewed', { Applicant: app.userId, Team: TRACKS[app.track], Decision: app.status, Reviewer: app.reviewerId, Reason: app.reason });
      await this.notify(app);
      await this.updateReview(app);
      return `Application ${app.status}.${app.notificationStatus === 'sent' ? ' Decision DM delivered.' : ' Their DMs are closed or unavailable; delivery will be retried.'}`;
    });
  }
  async notify(app) {
    if (app.notificationStatus !== 'pending') return;
    if (app.nextNotificationAt && Date.now() < app.nextNotificationAt) return;
    const key = `notify:${app.id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const user = await this.client.users.fetch(app.userId);
      await user.send({ embeds: [new EmbedBuilder().setColor(app.status === 'accepted' ? 0x4bb987 : 0xe15b64)
        .setTitle(`Your ${TRACKS[app.track]} application was ${app.status}`)
        .setDescription(`**.revisonary**\n\n**Reason:** ${app.reason}${app.status === 'accepted' ? '\n\nYour team roles have been added. Welcome to the team!' : '\n\nThank you for applying.'}`)
        .setFooter({ text: `Application ${app.id}` })], allowedMentions: { parse: [] } });
      app.notificationStatus = 'sent'; app.reviewNeedsUpdate = true;
    } catch (error) {
      app.notificationAttempts = (app.notificationAttempts || 0) + 1;
      app.nextNotificationAt = Date.now() + 60 * 60 * 1000;
      console.error('Application decision DM deferred:', app.id, error.code ?? error.name);
    }
    try { this.store.save(); } finally { this.busy.delete(key); }
  }
  async updateReview(app) {
    if (!app.reviewNeedsUpdate || !app.reviewMessageId) return;
    try {
      const channel = await this.client.channels.fetch(this.reviewChannelId(app));
      const message = await channel.messages.fetch(app.reviewMessageId);
      await message.edit(reviewPayload(app)); app.reviewNeedsUpdate = false; this.store.save();
    } catch (error) { console.error('Application review display update deferred:', app.id, error.message); }
  }
  async recover() {
    if (this.recovering || this.resetting) return;
    this.recovering = true;
    try {
    await this.cleanResetReviews();
    for (const app of Object.values(this.store.data.applications)) {
      if (this.busy.has(`review:${app.id}`) || this.busy.has(`user:${app.userId}`)) continue;
      if (app.status === 'deciding') {
        try {
          const guild = await this.client.guilds.fetch(app.guildId);
          let member;
          try { member = await guild.members.fetch({ user: app.userId, force: true }); }
          catch (error) { if (error.code !== 10007) throw error; }
          for (const id of app.provisionalRoleIds || []) if (member?.roles.cache.has(id)) {
            await member.roles.remove(id, 'Recovering interrupted application approval');
          }
          delete app.provisionalRoleIds; app.status = 'pending'; app.reviewNeedsUpdate = true; this.store.save();
          await this.logger.log('application', 'Interrupted application review recovered', { Application: app.id, Applicant: app.userId });
        } catch (error) { console.error('Application role recovery deferred:', app.id, error.message); }
      }
      if (app.status === 'submitting') {
        try {
          const channel = await this.client.channels.fetch(this.reviewChannelId(app));
          const messages = await channel.messages.fetch({ limit: 100 });
          const found = messages.find(m => m.author.id === this.client.user.id && m.embeds.some(e => e.footer?.text === `Application ${app.id}`));
          if (found) { app.reviewMessageId = found.id; app.status = 'pending'; app.reviewNeedsUpdate = true; }
          else app.status = 'ready';
          this.store.save();
        } catch (error) { console.error('Application submission recovery deferred:', error.message); }
      }
      if (app.notificationStatus === 'pending') await this.notify(app);
      await this.updateReview(app);
    }
    } finally { this.recovering = false; }
  }
  async handle(interaction) {
    if ((interaction.isChatInputCommand() && interaction.commandName === 'reset-applications')
      || interaction.customId?.startsWith('rv:app-reset:')) return this.handleReset(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === 'apply' || interaction.customId === 'rv:apply') {
      if (interaction.guildId !== this.config.guildId) throw new UserError('Apply from the .revisonary server.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const team = interaction.isChatInputCommand() ? interaction.options.getString('team', true) : interaction.values[0];
      await interaction.editReply(await this.begin(interaction.user, team)); return true;
    }
    if (!interaction.customId?.startsWith('rv:app:')) return false;
    const [, , action, id, decision] = interaction.customId.split(':');
    const app = this.store.data.applications[id];
    if (!app) throw new UserError('This application could not be found.');
    if (['accept', 'deny'].includes(action)) {
      if (interaction.guildId !== app.guildId || interaction.channelId !== this.reviewChannelId(app)
        || interaction.message.id !== app.reviewMessageId || app.status !== 'pending') throw new UserError('Use the pending application’s original review message.');
      // Open the reason form immediately: cached interaction roles can be stale.
      // decide() fetches current membership before any decision or role changes.
      await interaction.showModal(new ModalBuilder().setCustomId(`rv:app:decision:${id}:${action}`)
        .setTitle(`${action === 'accept' ? 'Accept' : 'Deny'} application`).addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Reason sent to the applicant').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(600),
        ))); return true;
    }
    if (action === 'decision' && interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await this.decide(interaction, app, decision, interaction.fields.getTextInputValue('reason'))); return true;
    }
    if (interaction.guildId || interaction.user.id !== app.userId) throw new UserError('These application controls belong to another applicant.');
    await interaction.deferReply();
    await this.locked(`user:${app.userId}`, async () => {
      if (action === 'specialties') {
        if (app.status !== 'draft' || app.track !== 'design' || app.answers.length) throw new UserError('Your specialties have already been saved.');
        const values = [...new Set(interaction.values)];
        if (!values.length || values.some(value => !Object.hasOwn(SPECIALTIES, value))) throw new UserError('Select valid design specialties.');
        app.specialties = values; app.answers.push(values.map(value => SPECIALTIES[value]).join(', ')); this.store.save();
        await interaction.editReply('Specialties saved.'); await this.prompt(interaction.user, app);
      } else if (action === 'submit') {
        await this.submit(interaction.user, app); await interaction.editReply('Application submitted! You will receive the decision and reason here by DM.');
      } else if (action === 'cancel') {
        if (!['draft', 'ready'].includes(app.status)) throw new UserError('This application was already submitted or closed.');
        app.status = 'cancelled'; this.store.save(); await interaction.editReply('Application cancelled.');
        await this.logger.log('application', 'Application cancelled', { Applicant: app.userId, Application: app.id });
      } else throw new UserError('Unknown application action.');
    });
    return true;
  }
  async handleReset(interaction) {
    if (interaction.guildId !== this.config.guildId) throw new UserError('Use this command in the .revisonary server.');
    const command = interaction.isChatInputCommand();
    if (command) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (!canResetApplications(member, this.config)) throw new UserError('Only the authorized reset role or an administrator can reset applications.');
    if (command) {
      for (const [id, pending] of this.resetConfirmations) if (pending.expires < Date.now()) this.resetConfirmations.delete(id);
      const nonce = randomBytes(8).toString('hex');
      this.resetConfirmations.set(interaction.user.id, { nonce, expires: Date.now() + 5 * 60_000 });
      await interaction.editReply({
        content: 'Reset all saved application drafts, pending submissions and decisions, and delete their review messages? Everyone will be able to apply again. Existing member roles will be kept. This cannot be undone.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rv:app-reset:confirm:${interaction.user.id}:${nonce}`).setLabel('Reset All Applications').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`rv:app-reset:cancel:${interaction.user.id}:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
      });
      return true;
    }
    const [, , action, userId, nonce] = interaction.customId.split(':');
    const pending = this.resetConfirmations.get(userId);
    if (userId !== interaction.user.id || !pending || pending.nonce !== nonce || pending.expires < Date.now()) {
      throw new UserError('This reset confirmation expired or belongs to someone else. Run /reset-applications again.');
    }
    if (action === 'cancel') {
      this.resetConfirmations.delete(userId);
      await interaction.editReply({ content: 'Reset cancelled. Applications were kept.', components: [] }); return true;
    }
    if (action !== 'confirm') throw new UserError('Unknown reset action.');
    const result = await this.resetAllOnce(`manual:${interaction.id}`, userId);
    this.resetConfirmations.delete(userId);
    await interaction.editReply({ content: `Reset complete: ${result.cleared} application(s) cleared. Everyone can apply again.${result.cleanupPending ? ` ${result.cleanupPending} review message(s) are waiting for cleanup.` : ''}`, components: [] });
    return true;
  }
}
