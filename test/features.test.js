import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { readConfig } from '../src/config.js';
import { ApplicationService, acceptedRoles, applicationCommand, applicationResetCommand, QUESTIONS, reviewPayload } from '../src/applications.js';
import { checkHierarchy, moderationCommands, ModerationService, selectClearMessages } from '../src/moderation.js';
import { Logger } from '../src/logging.js';
import { panelPayload, ticketPayload } from '../src/panels.js';

const config = readConfig({ DISCORD_TOKEN: 'test-only', GUILD_ID: '111111111111111111' });
function fixture(track = 'support') {
  const sent = [], logs = [], grants = [], removals = [];
  const user = { id: '222222222222222222', send: async payload => { sent.push(payload); return { id: 'dm' }; } };
  const reviewer = { id: '333333333333333333', permissions: new PermissionsBitField(), roles: { cache: new Map([[config.applicationReviewerRoleId, {}]]) } };
  const member = { id: user.id, roles: { cache: new Map(),
    add: async id => { grants.push(id); member.roles.cache.set(id, {}); },
    remove: async id => { removals.push(id); member.roles.cache.delete(id); },
  } };
  const review = { id: '444444444444444444', edit: async payload => { review.payload = payload; return review; } };
  const channel = { id: config.applicationReviewChannelId, guildId: config.guildId, isTextBased: () => true,
    send: async payload => { review.payload = payload; return review; }, messages: { fetch: async () => review } };
  const guild = { id: config.guildId, members: { fetch: async input => (typeof input === 'string' ? input : input.user) === user.id ? member : reviewer,
    fetchMe: async () => ({ permissions: new PermissionsBitField([P.ManageRoles]) }) },
  roles: { fetch: async id => ({ id, managed: false, editable: true }) }, channels: { fetch: async () => channel } };
  const client = { user: { id: '555555555555555555' }, users: { fetch: async () => user }, guilds: { fetch: async () => guild }, channels: { fetch: async () => channel } };
  const store = { data: { applications: {} }, save() {} };
  const logger = { log: async (...args) => { logs.push(args); } };
  const service = new ApplicationService(client, config, store, logger);
  const app = { id: 'a'.repeat(24), userId: user.id, guildId: guild.id, track, status: 'pending',
    answers: QUESTIONS[track].map(() => 'Sample answer'), specialties: ['gfx', 'vfx', 'discord'],
    createdAt: new Date().toISOString(), reviewMessageId: review.id };
  store.data.applications[app.id] = app;
  const interaction = { guild, guildId: guild.id, channelId: config.applicationReviewChannelId, user: reviewer };
  return { service, store, app, interaction, guild, member, reviewer, user, sent, logs, grants, removals, review, channel, client, logger };
}

test('new slash commands and careers/support payloads serialize successfully', () => {
  const commands = [...moderationCommands(), applicationCommand(), applicationResetCommand()].map(c => c.toJSON());
  assert.deepEqual(commands.map(c => c.name), ['warn', 'warnings', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'clear', 'say', 'lock', 'unlock', 'slowmode', 'apply', 'reset-applications']);
  for (const c of commands) {
    let optional = false;
    for (const option of c.options || []) { if (!option.required) optional = true; else assert.equal(optional, false, `${c.name}: required options first`); }
  }
  const careers = panelPayload('careers', config).components[0].toJSON();
  assert.deepEqual(careers.components.at(-1).components[0].options.map(o => o.value), ['support', 'management', 'design']);
  const ticket = ticketPayload({ type: 'general', ownerId: 'user', closed: false });
  assert.equal(ticket.files[0].name, 'support.png');
  assert.equal(ticket.components[0].toJSON().components[0].items[0].media.url, 'attachment://support.png');
});

test('application roles exactly match the requested team and chosen specialties', () => {
  assert.deepEqual(acceptedRoles({ track: 'support' }, config), ['1491987441702142074', '1491994140819324988']);
  assert.deepEqual(acceptedRoles({ track: 'management' }, config), ['1491987441702142074', '1492001472416845987']);
  assert.deepEqual(acceptedRoles({ track: 'design', specialties: ['gfx', 'discord'] }, config), ['1507979010053771354', '1507984459839045762', '1492013217692778616']);
  assert.throws(() => acceptedRoles({ track: 'design', specialties: ['invalid'] }, config), /not fully configured/);
});

test('acceptance grants roles, retains existing roles and DMs the reason', async () => {
  const f = fixture(); f.member.roles.cache.set('unrelated', {});
  const result = await f.service.decide(f.interaction, f.app, 'accept', 'Strong support experience.');
  assert.match(result, /accepted/);
  assert.deepEqual(f.grants, acceptedRoles(f.app, config));
  assert.ok(f.member.roles.cache.has('unrelated'));
  assert.equal(f.app.status, 'accepted'); assert.equal(f.app.notificationStatus, 'sent');
  assert.match(JSON.stringify(f.sent), /Strong support experience/);
  assert.deepEqual(f.review.payload.components, []);
  await assert.rejects(f.service.decide(f.interaction, f.app, 'deny', 'Changed mind'), /already been reviewed/);
});

test('denial sends its reason and never grants roles', async () => {
  const f = fixture('management');
  await f.service.decide(f.interaction, f.app, 'deny', 'More leadership experience needed.');
  assert.equal(f.app.status, 'denied'); assert.deepEqual(f.grants, []);
  assert.match(JSON.stringify(f.sent), /More leadership experience needed/);
});

test('review rejects unauthorized staff, wrong channels and blank reasons', async () => {
  const f = fixture();
  f.reviewer.roles.cache.clear();
  await assert.rejects(f.service.decide(f.interaction, f.app, 'accept', 'Good'), /you need reviewer role/);
  f.reviewer.permissions.add(P.Administrator);
  await assert.rejects(f.service.decide({ ...f.interaction, channelId: 'wrong' }, f.app, 'accept', 'Good'), /original application/);
  await assert.rejects(f.service.decide(f.interaction, f.app, 'accept', ' '), /decision reason/);
  assert.deepEqual(f.grants, []);
});

test('competing reviewers cannot accept and deny the same application', async () => {
  const f = fixture();
  const first = f.service.decide(f.interaction, f.app, 'accept', 'Good');
  await assert.rejects(f.service.decide(f.interaction, f.app, 'deny', 'No'), /still processing/);
  await first; assert.equal(f.app.status, 'accepted'); assert.equal(f.sent.length, 1);
});

test('failed role grant rolls back added roles and keeps the application pending', async () => {
  const f = fixture();
  f.member.roles.add = async id => {
    if (id === config.supportApplicationRoleId) throw new Error('Role unavailable');
    f.grants.push(id); f.member.roles.cache.set(id, {});
  };
  await assert.rejects(f.service.decide(f.interaction, f.app, 'accept', 'Good'), /Role unavailable/);
  assert.deepEqual(f.removals, [config.supportRoleId]); assert.equal(f.app.status, 'pending');
  assert.equal(f.sent.length, 0); assert.equal(f.app.provisionalRoleIds, undefined);
});

test('role hierarchy failures reject acceptance before any grants or decision DMs', async () => {
  const f = fixture(); f.guild.roles.fetch = async id => ({ id, editable: false });
  await assert.rejects(f.service.decide(f.interaction, f.app, 'accept', 'Good'), /Move the bot/);
  assert.deepEqual(f.grants, []); assert.equal(f.app.status, 'pending'); assert.equal(f.sent.length, 0);
});

test('interrupted approval removes provisional roles before reopening review', async () => {
  const f = fixture(); f.app.status = 'deciding'; f.app.provisionalRoleIds = [config.supportRoleId];
  f.member.roles.cache.set(config.supportRoleId, {});
  await f.service.recover();
  assert.equal(f.app.status, 'pending'); assert.deepEqual(f.removals, [config.supportRoleId]);
  assert.equal(f.app.provisionalRoleIds, undefined);
});

test('failed decision DM keeps its pending notification and later retries successfully', async () => {
  const f = fixture(); f.user.send = async () => { throw new Error('DMs closed'); };
  await f.service.decide(f.interaction, f.app, 'deny', 'Please gain more experience.');
  assert.equal(f.app.status, 'denied'); assert.equal(f.app.notificationStatus, 'pending');
  f.user.send = async p => { f.sent.push(p); }; f.app.nextNotificationAt = 0;
  await f.service.recover(); await f.service.recover();
  assert.equal(f.app.notificationStatus, 'sent'); assert.equal(f.sent.length, 1);
});

test('DM applications save each answer, require submission, and resume after restart', async () => {
  const f = fixture(); f.store.data.applications = {};
  await f.service.begin(f.user, 'support');
  const app = f.service.active(f.user.id);
  assert.equal(app.status, 'draft');
  for (let index = 0; index < 5; index++) await f.service.onMessage({ guildId: null, author: f.user, id: String(index), content: `Answer ${index}`, reply: async () => {} });
  assert.equal(app.status, 'ready'); assert.equal(app.answers.length, 5);
  const restarted = new ApplicationService(f.client, config, f.store, f.logger);
  assert.equal(restarted.active(f.user.id).status, 'ready');
  await restarted.submit(f.user, app); assert.equal(app.status, 'pending');
  await assert.rejects(restarted.begin(f.user, 'management'), /waiting for review/);
});

test('design first question uses a multiselect and records multiple specialties', async () => {
  const f = fixture('design'); f.app.status = 'draft'; f.app.answers = [];
  await f.service.prompt(f.user, f.app);
  const menu = f.sent.at(-1).components[0].toJSON().components[0];
  assert.equal(menu.max_values, 3); assert.equal(menu.min_values, 1);
  const interaction = { isChatInputCommand: () => false, customId: `rv:app:specialties:${f.app.id}`, guildId: null,
    user: f.user, values: ['gfx', 'vfx'], deferReply: async () => {}, editReply: async () => {} };
  await f.service.handle(interaction);
  assert.deepEqual(f.app.specialties, ['gfx', 'vfx']); assert.equal(f.app.answers[0], 'GFX, VFX');
  await assert.rejects(f.service.handle(interaction), /already been saved/);
});

test('blocked DMs preserve a resumable application instead of creating duplicates', async () => {
  const f = fixture(); f.store.data.applications = {}; f.user.send = async () => { throw new Error('DMs closed'); };
  await assert.rejects(f.service.begin(f.user, 'support'), /Enable DMs/);
  await assert.rejects(f.service.begin(f.user, 'support'), /Enable DMs/);
  assert.equal(Object.keys(f.store.data.applications).length, 1);
});

test('review embed stays within Discord limits at maximum answer and reason length', () => {
  const f = fixture('management'); f.app.answers = QUESTIONS.management.map(() => 'x'.repeat(800));
  Object.assign(f.app, { status: 'accepted', reason: 'y'.repeat(600), notificationStatus: 'pending' });
  const e = reviewPayload(f.app).embeds[0].toJSON();
  const length = e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((n, field) => n + field.name.length + field.value.length, 0);
  assert.ok(length <= 6000); assert.ok(e.fields.every(field => field.value.length <= 1024));
});

test('/clear selects only matching recent unpinned messages, capped by amount', () => {
  const now = Date.now();
  const messages = new Map([
    ['1', { id: '1', author: { id: 'a' }, content: 'Spam one', createdTimestamp: now }],
    ['2', { id: '2', author: { id: 'a' }, content: 'Spam pinned', createdTimestamp: now, pinned: true }],
    ['3', { id: '3', author: { id: 'b' }, content: 'Spam other', createdTimestamp: now }],
    ['4', { id: '4', author: { id: 'a' }, content: 'Spam old', createdTimestamp: now - 15 * 86400_000 }],
    ['5', { id: '5', author: { id: 'a' }, content: 'Spam two', createdTimestamp: now }],
  ]);
  assert.deepEqual(selectClearMessages(messages, { amount: 1, userId: 'a', contains: 'spam', now }).map(m => m.id), ['1']);
  assert.deepEqual(selectClearMessages(messages, { amount: 100, userId: 'a', contains: 'spam', now }).map(m => m.id), ['1', '5']);
});

test('moderation hierarchy rejects equal/higher roles, self, bot and owner', () => {
  const actor = { id: 'actor', roles: { highest: { comparePositionTo: () => 0 } } };
  const target = { id: 'target', manageable: true, roles: { highest: {} } };
  assert.throws(() => checkHierarchy(actor, target, { ownerId: 'owner' }, 'bot'), /below your highest role/);
  actor.roles.highest.comparePositionTo = () => 1;
  for (const id of ['actor', 'owner', 'bot']) assert.throws(() => checkHierarchy(actor, { ...target, id }, { ownerId: 'owner' }, 'bot'), /cannot moderate/);
  assert.doesNotThrow(() => checkHierarchy(actor, target, { ownerId: 'owner' }, 'bot'));
});

test('/say requires native permissions and never enables mention pings', async () => {
  const f = fixture(); const actor = { permissions: new PermissionsBitField([P.ManageMessages]) };
  f.guild.members.fetch = async () => actor;
  f.channel.id = 'channel'; f.channel.permissionsFor = () => new PermissionsBitField([P.ViewChannel, P.SendMessages]);
  let payload;
  f.channel.send = async p => { payload = p; return { id: 'msg', url: 'https://discord.com/channels/g/c/m' }; };
  const service = new ModerationService(config, { data: {} }, f.logger);
  const interaction = { ...f.interaction, channel: f.channel, commandName: 'say', options: { getString: key => key === 'message' ? '@everyone Hello' : null, getChannel: () => null } };
  await service.run(interaction); assert.deepEqual(payload.allowedMentions, { parse: [] });
  actor.permissions = new PermissionsBitField();
  await assert.rejects(service.run(interaction), /required for this command/);
});

test('log delivery failure keeps a durable queue and a retry sends without pings', async () => {
  const store = { data: { pendingLogs: [] }, save() {} };
  let fail = true, sent;
  const client = { channels: { fetch: async () => ({ guildId: config.guildId, isTextBased: () => true, send: async p => { if (fail) throw new Error('Channel unavailable'); sent = p; } }) } };
  const logger = new Logger(client, config, store);
  await logger.log('mod', 'Action', { Reason: '@everyone' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.data.pendingLogs.length, 1);
  fail = false; await logger.flush();
  assert.equal(store.data.pendingLogs.length, 0); assert.deepEqual(sent.allowedMentions, { parse: [] });
});

test('/lock and /unlock restore an unset permission without granting new access', async () => {
  const f = fixture();
  const actor = { permissions: new PermissionsBitField([P.ManageChannels]) };
  f.guild.members.fetch = async () => actor;
  const changes = [];
  const channel = { id: 'channel', type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField([P.ManageChannels, P.ManageRoles]),
    permissionOverwrites: { cache: new Map(), edit: async (id, permissions) => { changes.push([id, permissions]); } },
  };
  const store = { data: { channelLocks: {} }, save() {} };
  const service = new ModerationService(config, store, f.logger);
  const interaction = { ...f.interaction, channel, commandName: 'lock', options: { getString: () => 'Testing' } };
  await service.run(interaction);
  await assert.rejects(service.run(interaction), /already locked/);
  interaction.commandName = 'unlock';
  await service.run(interaction);
  assert.deepEqual(changes, [[config.guildId, { SendMessages: false }], [config.guildId, { SendMessages: null }]]);
  await assert.rejects(service.run(interaction), /no saved/);
});

test('duplicate DM gateway delivery never advances the application twice', async () => {
  const f = fixture(); f.app.status = 'draft'; f.app.answers = [];
  const message = { guildId: null, author: f.user, id: 'same-id', content: 'My first answer', reply: async () => {} };
  await f.service.onMessage(message); await f.service.onMessage(message);
  assert.equal(f.app.answers.length, 1);
});

test('existing application reviews keep their old channel and reviewer buttons after migration', async () => {
  const f = fixture();
  const restarted = new ApplicationService(f.client, config, f.store, f.logger);
  assert.equal(f.app.reviewChannelId, '1492019111142887434');
  await assert.rejects(restarted.decide(f.interaction, f.app, 'deny', 'Reason'), /original application review/);
  await restarted.decide({ ...f.interaction, channelId: f.app.reviewChannelId }, f.app, 'deny', 'Reason');
  assert.equal(f.app.status, 'denied');
  assert.equal(f.logs.find(entry => entry[1] === 'Application reviewed')[0], 'application');
});

test('new submissions and application activity logs route to the requested channel', async () => {
  const f = fixture(); f.app.status = 'ready';
  await f.service.submit(f.user, f.app);
  assert.equal(f.app.reviewChannelId, '1492019040082985110');
  const destinations = [];
  const logger = new Logger({ channels: { fetch: async id => {
    destinations.push(id);
    return { guildId: config.guildId, isTextBased: () => true, send: async () => {} };
  } } }, config, { data: { pendingLogs: [] }, save() {} });
  await logger.log('application', 'Application submitted', { Applicant: f.user.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(destinations, ['1492019040082985110']);
});

test('application reset clears saved applications and review messages once, keeping roles and new applications', async () => {
  const f = fixture(); let deleted = 0;
  f.review.author = f.client.user;
  f.review.embeds = [{ footer: { text: `Application ${f.app.id}` } }];
  f.review.delete = async () => { deleted++; };
  f.store.data.applications.draft = { id: 'draft', guildId: config.guildId, userId: 'draft-user', status: 'draft', answers: ['old answer'] };
  const result = await f.service.resetAllOnce('test-reset');
  assert.deepEqual(result, { cleared: 2, deletedReviews: 1, cleanupPending: 0 });
  assert.deepEqual(f.store.data.applications, {});
  assert.deepEqual(f.grants, []); assert.deepEqual(f.removals, []);
  f.store.data.applications.new = { id: 'new', guildId: config.guildId, status: 'draft' };
  await f.service.resetAllOnce('test-reset');
  assert.ok(f.store.data.applications.new); assert.equal(deleted, 1);
});

test('application reset retries failed review cleanup without resetting later applications', async () => {
  const f = fixture();
  f.review.author = f.client.user;
  f.review.embeds = [{ footer: { text: `Application ${f.app.id}` } }];
  f.review.delete = async () => { throw new Error('Missing Permissions'); };
  const first = await f.service.resetAllOnce('test-reset');
  assert.equal(first.cleanupPending, 1); assert.deepEqual(f.store.data.applications, {});
  let deleted = false; f.review.delete = async () => { deleted = true; };
  f.store.data.applications.new = { id: 'new', guildId: config.guildId, status: 'draft' };
  await f.service.recover();
  assert.equal(deleted, true); assert.ok(f.store.data.applications.new);
  assert.equal(f.store.data.applicationReset.pendingReviews.length, 0);
});

test('the additional reviewer role can accept and deny without Administrator', async () => {
  for (const decision of ['accept', 'deny']) {
    const f = fixture(); f.reviewer.roles.cache.clear();
    f.reviewer.roles.cache.set('1494522719851643020', {});
    await f.service.decide(f.interaction, f.app, decision, 'Reviewed by authorized staff');
    assert.equal(f.app.status, decision === 'accept' ? 'accepted' : 'denied');
  }
});

function resetInteraction(f) {
  let payload;
  return { ...f.interaction, id: 'reset-command', commandName: 'reset-applications',
    isChatInputCommand: () => true, deferReply: async () => {}, deferUpdate: async () => {},
    editReply: async value => { payload = value; }, payload: () => payload };
}

test('reset permission requires the new role and confirmation rechecks current membership', async () => {
  const f = fixture(); const interaction = resetInteraction(f);
  await assert.rejects(f.service.handle(interaction), /authorized reset role/);
  f.reviewer.roles.cache.set(config.applicationAdditionalReviewerRoleId, {});
  await f.service.handle(interaction);
  assert.ok(f.store.data.applications[f.app.id]);
  const customId = interaction.payload().components[0].toJSON().components[0].custom_id;
  f.reviewer.roles.cache.delete(config.applicationAdditionalReviewerRoleId);
  await assert.rejects(f.service.handle({ ...interaction, isChatInputCommand: () => false, customId }), /authorized reset role/);
  assert.ok(f.store.data.applications[f.app.id]);
});

test('confirmed manual reset clears applications once and startup cannot repeat it', async () => {
  const f = fixture(); delete f.app.reviewMessageId;
  await f.service.resetAllOnce('startup-reset');
  f.store.data.applications[f.app.id] = f.app;
  f.reviewer.roles.cache.set(config.applicationAdditionalReviewerRoleId, {});
  const interaction = resetInteraction(f);
  await f.service.handle(interaction);
  const customId = interaction.payload().components[0].toJSON().components[0].custom_id;
  await f.service.handle({ ...interaction, id: 'confirmation', isChatInputCommand: () => false, customId });
  assert.deepEqual(f.store.data.applications, {});
  f.store.data.applications.new = { id: 'new', guildId: config.guildId, status: 'draft' };
  const restarted = new ApplicationService(f.client, config, f.store, f.logger);
  await restarted.resetAllOnce('startup-reset');
  assert.ok(f.store.data.applications.new);
});

test('reset refuses to race an in-flight application action', async () => {
  const f = fixture(); f.service.busy.add(`review:${f.app.id}`);
  await assert.rejects(f.service.resetAllOnce('new-reset'), /still processing/);
  assert.ok(f.store.data.applications[f.app.id]);
});

test('authorized reviewers can accept or deny their own applications', async () => {
  for (const decision of ['accept', 'deny']) {
    const f = fixture();
    f.member.permissions = new PermissionsBitField();
    f.member.roles.cache.set(config.applicationAdditionalReviewerRoleId, {});
    await f.service.decide({ ...f.interaction, user: f.user }, f.app, decision, 'Test review');
    assert.equal(f.app.status, decision === 'accept' ? 'accepted' : 'denied');
  }
});

test('review button opens with stale cached roles and the submitted decision checks fresh membership', async () => {
  const f = fixture();
  f.reviewer.roles.cache.clear(); f.reviewer.roles.cache.set(config.applicationAdditionalReviewerRoleId, {});
  let modal;
  const interaction = { ...f.interaction, isChatInputCommand: () => false, isModalSubmit: () => false,
    customId: `rv:app:accept:${f.app.id}`, message: { id: f.app.reviewMessageId },
    member: { roles: { cache: new Map() } }, memberPermissions: new PermissionsBitField(),
    showModal: async value => { modal = value.toJSON(); } };
  await f.service.handle(interaction);
  assert.equal(modal.custom_id, `rv:app:decision:${f.app.id}:accept`);
  assert.deepEqual(f.grants, []);
  await f.service.handle({ ...interaction, customId: modal.custom_id, isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'Approved with current reviewer role' }, deferReply: async () => {}, editReply: async () => {} });
  assert.equal(f.app.status, 'accepted');
});

test('a removed reviewer role cannot be bypassed by a stale modal or self-review', async () => {
  const f = fixture(); f.reviewer.roles.cache.clear();
  await assert.rejects(f.service.handle({ ...f.interaction, isChatInputCommand: () => false, isModalSubmit: () => true,
    customId: `rv:app:decision:${f.app.id}:accept`, fields: { getTextInputValue: () => 'Attempt' },
    deferReply: async () => {}, editReply: async () => {} }), /you need reviewer role/);
  f.member.permissions = new PermissionsBitField();
  await assert.rejects(f.service.decide({ ...f.interaction, user: f.user }, f.app, 'accept', 'Attempt'), /you need reviewer role/);
  assert.deepEqual(f.grants, []); assert.equal(f.app.status, 'pending');
});
