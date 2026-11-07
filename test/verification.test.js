import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { readConfig } from '../src/config.js';
import { VerificationService } from '../src/verification.js';

const config = readConfig({ DISCORD_TOKEN: 'test', GUILD_ID: '111111111111111111' });
function fixture(initial = []) {
  const roles = new Map(initial.map(id => [id, {}]));
  const calls = [];
  const member = { roles: { cache: roles,
    add: async id => { calls.push(['add', id]); roles.set(id, {}); },
    remove: async id => { calls.push(['remove', id]); roles.delete(id); },
  } };
  const guild = { id: config.guildId,
    roles: { fetch: async id => ({ id, managed: false, editable: true }) },
    members: {
      fetchMe: async () => ({ permissions: new PermissionsBitField(P.ManageRoles) }),
      fetch: async options => { assert.equal(options.force, true); return member; },
    },
  };
  return { service: new VerificationService(config), guild, member, roles, calls };
}

test('join grants exactly the requested new-member role', async () => {
  const f = fixture();
  await f.service.assignOnJoin(f.guild, 'user');
  assert.deepEqual(f.calls, [['add', '1492018455359127643']]);
});
test('Verify grants the verified role before removing the waiting role and preserves other roles', async () => {
  const f = fixture([config.unverifiedRoleId, 'unrelated']);
  await f.service.verify(f.guild, 'user');
  assert.deepEqual(f.calls, [['add', '1491987224835784754'], ['remove', '1492018455359127643']]);
  assert.deepEqual([...f.roles.keys()].sort(), ['1491987224835784754', 'unrelated']);
});
test('a failed verified-role grant leaves the waiting role intact', async () => {
  const f = fixture([config.unverifiedRoleId]);
  f.member.roles.add = async () => { throw new Error('Discord unavailable'); };
  await assert.rejects(f.service.verify(f.guild, 'user'), /unavailable/);
  assert.ok(f.roles.has(config.unverifiedRoleId));
  assert.equal(f.calls.length, 0);
});
test('failed removal reports a partial result and a second click completes it', async () => {
  const f = fixture([config.unverifiedRoleId]);
  const remove = f.member.roles.remove;
  f.member.roles.remove = async () => { throw new Error('Temporary failure'); };
  await assert.rejects(f.service.verify(f.guild, 'user'), /new-member role could not be removed/);
  assert.ok(f.roles.has(config.verifiedRoleId));
  assert.ok(f.roles.has(config.unverifiedRoleId));
  f.member.roles.remove = remove;
  await f.service.verify(f.guild, 'user');
  assert.ok(!f.roles.has(config.unverifiedRoleId));
});
test('missing Manage Roles or a role hierarchy problem prevents all writes', async () => {
  for (const problem of ['permission', 'hierarchy']) {
    const f = fixture([config.unverifiedRoleId]);
    if (problem === 'permission') f.guild.members.fetchMe = async () => ({ permissions: new PermissionsBitField() });
    else f.guild.roles.fetch = async id => ({ id, editable: false });
    await assert.rejects(f.service.verify(f.guild, 'user'), /administrator/);
    assert.equal(f.calls.length, 0);
  }
});
test('simultaneous join and verify finish with only the verified role', async () => {
  for (const order of ['join-first', 'verify-first']) {
    const f = fixture();
    const join = () => f.service.assignOnJoin(f.guild, 'user');
    const verify = () => f.service.verify(f.guild, 'user');
    await Promise.all(order === 'join-first' ? [join(), verify()] : [verify(), join()]);
    assert.deepEqual([...f.roles.keys()], [config.verifiedRoleId]);
    assert.equal(f.service.pending.size, 0);
  }
});
test('repeated Verify clicks are harmless and retain unrelated roles', async () => {
  const f = fixture([config.verifiedRoleId, 'unrelated']);
  await Promise.all([f.service.verify(f.guild, 'user'), f.service.verify(f.guild, 'user')]);
  assert.deepEqual([...f.roles.keys()].sort(), [config.verifiedRoleId, 'unrelated']);
});
