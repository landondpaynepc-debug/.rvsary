import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField, MessageFlags } from 'discord.js';
import { readConfig } from '../src/config.js';
import { panelPayload, ticketPayload, welcomePayload } from '../src/panels.js';
import { Store } from '../src/store.js';
import { TicketService, canClose, privateOverwrites } from '../src/tickets.js';

const env = { DISCORD_TOKEN: 'test-only', GUILD_ID: '111111111111111111', SUPPORT_ROLE_ID: '222222222222222222' };
const config = readConfig(env);
const member = (id, roles = [], permissions = []) => ({ id, roles: { cache: new Map(roles.map(id => [id, {}])) }, permissions: new PermissionsBitField(permissions) });

test('defaults retain all four supplied destination IDs', () => {
  assert.equal(config.verificationChannelId, '1503856051232182294');
  assert.equal(config.dashboardChannelId, '1492006832779165756');
  assert.equal(config.ticketDestinationId, '1568501776125009984');
  assert.equal(config.welcomeChannelId, '1492026750329163776');
  const defaults = readConfig({ DISCORD_TOKEN: 'test-only' });
  assert.equal(defaults.supportRoleId, '1491987441702142074');
  assert.equal(defaults.guildId, '');
});
test('configuration rejects invalid URLs, IDs and identical verification roles', () => {
  assert.throws(() => readConfig({ ...env, VERIFICATION_BANNER_URL: 'javascript:alert(1)' }), /HTTPS/);
  assert.throws(() => readConfig({ ...env, GUILD_ID: 'wrong' }), /Discord ID/);
  assert.throws(() => readConfig({ ...env, VERIFIED_ROLE_ID: config.unverifiedRoleId }), /different/);
});
test('verification works without an external URL and describes a role swap', () => {
  const payload = panelPayload('verification', config);
  const json = payload.components[0].toJSON();
  assert.notEqual(json.components.at(-1).accessory.disabled, true);
  assert.equal(json.components.at(-1).accessory.label, 'Verify');
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.ok(fs.existsSync(payload.files[0].attachment));
  assert.doesNotMatch(JSON.stringify(json), /Dock Systems|Roblox/);
});
test('dashboard serializes all three support options with a bundled banner', () => {
  const payload = panelPayload('dashboard', config);
  const json = payload.components[0].toJSON();
  assert.deepEqual(json.components.at(-1).components[0].options.map(x => x.label), ['General Support', 'Management Support', 'Purchase Claim']);
  assert.ok(fs.existsSync(payload.files[0].attachment));
});
test('welcome allows only the joining member ping and links the dashboard', () => {
  const payload = welcomePayload({ id: '333333333333333333', guild: { id: config.guildId, memberCount: 198 } }, config);
  const json = payload.components[0].toJSON();
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ['333333333333333333'] });
  assert.equal(json.components[1].components[0].label, 'Members: 198');
  assert.equal(json.components[1].components[0].disabled, true);
  assert.equal(json.components[1].components[1].url, `https://discord.com/channels/${config.guildId}/${config.dashboardChannelId}`);
});
test('category permissions deny everyone and allow only owner, bot and staff', () => {
  const overwrites = privateOverwrites('guild', 'bot', 'owner', 'staff');
  assert.deepEqual(overwrites.map(x => x.id), ['guild', 'bot', 'owner', 'staff']);
  assert.ok(overwrites[0].deny.includes(P.ViewChannel));
  for (const overwrite of overwrites.slice(1)) assert.ok(overwrite.allow.includes(P.ViewChannel));
});
test('ticket closure is limited to owner, assigned staff and administrators', () => {
  const ticket = { ownerId: 'owner', staffRoleId: 'staff' };
  assert.ok(canClose(member('owner'), ticket));
  assert.ok(canClose(member('agent', ['staff']), ticket));
  assert.ok(canClose(member('admin', [], [P.Administrator]), ticket));
  assert.equal(canClose(member('stranger'), ticket), false);
  assert.equal(canClose(member('otherstaff', ['unassigned']), ticket), false);
});
test('state survives a restart and malformed state is not silently discarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revisonary-test-'));
  try {
    const store = new Store(dir);
    store.data.tickets.a = { ownerId: 'owner', closed: false };
    store.save();
    assert.equal(new Store(dir).data.tickets.a.ownerId, 'owner');
    fs.writeFileSync(path.join(dir, 'state.json'), '{bad');
    assert.throws(() => new Store(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fixture(type = ChannelType.GuildCategory) {
  const store = { data: { tickets: {} }, save() {} };
  const calls = [];
  const message = { id: '666666666666666666', author: { id: '555555555555555555' }, components: [],
    edit: async payload => { calls.push(['messageEdit', payload]); message.components = payload.components; return message; },
  };
  const channel = { id: '444444444444444444', isThread: () => type === ChannelType.GuildText,
    client: { user: message.author }, archived: false,
    messages: { fetch: async query => typeof query === 'string' ? message : [message] },
    send: async payload => { calls.push(['send', payload]); message.components = payload.components; return message; },
    delete: async () => { calls.push(['delete']); },
    members: { add: async id => { calls.push(['add', id]); } },
    edit: async options => { calls.push(['edit', options]); Object.assign(channel, options); },
    setArchived: async value => { calls.push(['archive', value]); channel.archived = value; },
    permissionOverwrites: { edit: async (id, options) => { calls.push(['overwrite', id, options]); } },
  };
  const create = async options => { calls.push(['create', options]); return channel; };
  const destination = { id: config.ticketDestinationId, type,
    permissionsFor: () => new PermissionsBitField(P.Administrator), threads: { create },
  };
  const owner = member('333333333333333333');
  const guild = { id: config.guildId,
    channels: { fetch: async id => id === destination.id ? destination : id === channel.id ? channel : null, create },
    roles: { fetch: async id => ({ id, managed: false }) },
    members: { fetchMe: async () => ({ id: '555555555555555555' }), fetch: async () => owner },
  };
  const interaction = { guild, guildId: guild.id, user: owner, channel, channelId: channel.id };
  return { service: new TicketService(config, store), store, calls, channel, destination, interaction, message };
}
test('a category ticket is private and a second request reuses it', async () => {
  const f = fixture();
  assert.equal((await f.service.open(f.interaction, 'general')).existing, false);
  assert.equal((await f.service.open(f.interaction, 'purchase')).existing, true);
  assert.equal(f.calls.filter(x => x[0] === 'create').length, 1);
  assert.equal(f.calls[0][1].parent, config.ticketDestinationId);
  assert.equal(f.calls[0][1].permissionOverwrites[0].deny[0], P.ViewChannel);
});
test('text destinations create private threads and add the owner', async () => {
  const f = fixture(ChannelType.GuildText);
  await f.service.open(f.interaction, 'general');
  assert.equal(f.calls[0][1].type, ChannelType.PrivateThread);
  assert.equal(f.calls[0][1].invitable, false);
  assert.deepEqual(f.calls[1], ['add', f.interaction.user.id]);
});
test('thread tickets fail closed when staff cannot see private threads', async () => {
  const f = fixture(ChannelType.GuildText);
  f.destination.permissionsFor = target => new PermissionsBitField(target.id === config.supportRoleId ? [P.ViewChannel] : [P.Administrator]);
  await assert.rejects(f.service.open(f.interaction, 'general'), /staff role needs/);
  assert.equal(f.calls.length, 0);
});
test('simultaneous requests cannot create duplicate tickets', async () => {
  const f = fixture();
  const first = f.service.open(f.interaction, 'general');
  await assert.rejects(f.service.open(f.interaction, 'general'), /already being created/);
  await first;
  assert.equal(f.calls.filter(x => x[0] === 'create').length, 1);
});
test('a failed welcome message cleans up the incomplete ticket', async () => {
  const f = fixture();
  f.channel.send = async () => { throw new Error('send failed'); };
  await assert.rejects(f.service.open(f.interaction, 'general'), /send failed/);
  assert.ok(f.calls.some(x => x[0] === 'delete'));
  assert.equal(Object.keys(f.store.data.tickets).length, 0);
});
test('closing a category ticket preserves its channel and locks sending', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  await f.service.close(f.interaction);
  assert.equal(f.store.data.tickets[f.channel.id].closed, true);
  assert.equal(f.calls.filter(x => x[0] === 'overwrite').length, 2);
  assert.equal(f.calls.some(x => x[0] === 'delete'), false);
});
test('closing a private thread locks and archives it', async () => {
  const f = fixture(ChannelType.GuildText);
  await f.service.open(f.interaction, 'general');
  await f.service.close(f.interaction);
  const edit = f.calls.find(x => x[0] === 'edit')[1];
  assert.equal(edit.locked, true);
  assert.equal(edit.archived, true);
  assert.equal(f.channel.archived, true);
});

function asStaff(f, id = '777777777777777777') {
  const staff = member(id, [config.supportRoleId]);
  f.interaction.user = staff;
  f.interaction.guild.members.fetch = async () => staff;
  return staff;
}

test('staff claim is saved and displayed without taking away owner close access', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  const owner = f.interaction.user;
  const staff = asStaff(f);
  const ticket = await f.service.claim(f.interaction);
  assert.equal(ticket.claimedById, staff.id);
  assert.ok(ticket.claimedAt);
  assert.ok(canClose(owner, ticket));
  const payload = f.message.components[0].toJSON();
  assert.ok(JSON.stringify(payload).includes(`<@${staff.id}>`));
  assert.equal(payload.components.at(-1).components[0].disabled, true);
  const restarted = new TicketService(config, f.store);
  await assert.rejects(restarted.claim(f.interaction), /already claimed/);
});

test('simultaneous staff claims never overwrite the first claim', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  const staff = asStaff(f);
  const first = f.service.claim(f.interaction);
  await assert.rejects(f.service.claim({ ...f.interaction, user: member('other', [config.supportRoleId]) }), /being updated/);
  await first;
  assert.equal(f.store.data.tickets[f.channel.id].claimedById, staff.id);
});

test('ticket owners and unrelated roles cannot claim or delete tickets', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  await assert.rejects(f.service.claim(f.interaction), /Only assigned staff/);
  await f.service.close(f.interaction);
  await assert.rejects(f.service.delete(f.interaction), /Only assigned staff/);
  f.interaction.guild.members.fetch = async () => member('outsider', ['wrong-role']);
  await assert.rejects(f.service.delete(f.interaction), /Only assigned staff/);
  assert.equal(f.calls.some(x => x[0] === 'delete'), false);
});

test('closing changes public controls to Delete Ticket and prevents future claims', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  asStaff(f);
  await assert.rejects(f.service.delete(f.interaction), /Close this ticket/);
  await f.service.close(f.interaction);
  const json = f.message.components[0].toJSON();
  assert.deepEqual(json.components.at(-1).components.map(button => button.custom_id), ['rv:delete']);
  await assert.rejects(f.service.claim(f.interaction), /Closed tickets/);
  await assert.rejects(f.service.close(f.interaction), /already closed/);
});

test('staff deletion removes only the current closed channel and records who deleted it', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  await f.service.close(f.interaction);
  const staff = asStaff(f);
  const ticket = await f.service.delete(f.interaction);
  assert.equal(f.calls.filter(x => x[0] === 'delete').length, 1);
  assert.equal(ticket.deletedById, staff.id);
  assert.ok(ticket.deletedAt);
  await assert.rejects(f.service.delete(f.interaction), /not a tracked/);
});

test('failed channel deletion keeps the closed record available for retry', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  await f.service.close(f.interaction);
  asStaff(f);
  f.channel.delete = async () => { throw new Error('Missing Permissions'); };
  await assert.rejects(f.service.delete(f.interaction), /Missing Permissions/);
  assert.equal(f.store.data.tickets[f.channel.id].deletedAt, undefined);
  f.channel.delete = async () => {};
  await f.service.delete(f.interaction);
  assert.ok(f.store.data.tickets[f.channel.id].deletedAt);
});

test('deletion rechecks staff role and guild even after earlier authorization', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  await f.service.close(f.interaction);
  const staff = asStaff(f);
  await f.service.authorize(f.interaction, true);
  staff.roles.cache.clear();
  await assert.rejects(f.service.delete(f.interaction), /Only assigned staff/);
  asStaff(f);
  await assert.rejects(f.service.delete({ ...f.interaction, guildId: 'wrong' }), /not a tracked/);
  assert.equal(f.calls.some(x => x[0] === 'delete'), false);
});

test('administrator without staff role can claim and delete a closed ticket', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  const admin = member('admin', [], [P.Administrator]);
  f.interaction.user = admin;
  f.interaction.guild.members.fetch = async () => admin;
  await f.service.claim(f.interaction);
  await f.service.close(f.interaction);
  await f.service.delete(f.interaction);
  assert.equal(f.store.data.tickets[f.channel.id].deletedById, admin.id);
});

test('existing ticket controls upgrade on startup without another message', async () => {
  const f = fixture();
  await f.service.open(f.interaction, 'general');
  const ticket = f.store.data.tickets[f.channel.id];
  delete ticket.controlMessageId;
  delete ticket.controlsVersion;
  ticket.closed = true;
  await f.service.restoreControls(f.interaction.guild);
  assert.equal(ticket.controlMessageId, f.message.id);
  assert.equal(ticket.controlsVersion, 3);
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
  assert.equal(f.message.components[0].toJSON().components.at(-1).components[0].custom_id, 'rv:delete');
});

test('closed ticket payload never includes a claim or close action', () => {
  const json = ticketPayload({ type: 'general', ownerId: 'owner', closed: true }).components[0].toJSON();
  assert.deepEqual(json.components.at(-1).components.map(x => x.custom_id), ['rv:delete']);
});
