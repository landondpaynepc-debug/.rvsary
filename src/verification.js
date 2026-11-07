import { PermissionFlagsBits as P } from 'discord.js';
import { UserError } from './tickets.js';

export class VerificationService {
  constructor(config) { this.config = config; this.pending = new Map(); }

  // Serialize join events and button presses for the same member.
  async forMember(guild, userId, action) {
    const key = `${guild.id}:${userId}`;
    const previous = this.pending.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.pending.set(key, task);
    try { return await task; }
    finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }

  async checkRoles(guild) {
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(P.ManageRoles)) {
      throw new UserError('The bot needs Manage Roles. Please ask an administrator to enable it.');
    }
    for (const id of [this.config.unverifiedRoleId, this.config.verifiedRoleId]) {
      const role = await guild.roles.fetch(id);
      if (!role || role.id === guild.id || role.managed || !role.editable) {
        throw new UserError('Please ask an administrator to place the bot role above both verification roles and check that both role IDs exist.');
      }
    }
  }

  assignOnJoin(guild, userId) {
    return this.forMember(guild, userId, async () => {
      await this.checkRoles(guild);
      const member = await guild.members.fetch({ user: userId, force: true });
      // A delayed join handler must not put an already-verified member back in the waiting role.
      if (member.roles.cache.has(this.config.verifiedRoleId)) return;
      await member.roles.add(this.config.unverifiedRoleId, 'New member: awaiting verification');
    });
  }

  verify(guild, userId) {
    return this.forMember(guild, userId, async () => {
      await this.checkRoles(guild);
      const member = await guild.members.fetch({ user: userId, force: true });
      // Add first: a failed grant must never remove the member's existing access.
      // Use single-role operations to preserve every unrelated role.
      await member.roles.add(this.config.verifiedRoleId, 'Member pressed Verify');
      try {
        await member.roles.remove(this.config.unverifiedRoleId, 'Verification completed');
      } catch (error) {
        console.error('Verified role granted but waiting role removal failed:', userId, error.message);
        throw new UserError('Your verified role was added, but the new-member role could not be removed. Press Verify again to retry; if it persists, ask staff to check the bot role permissions.');
      }
    });
  }
}
