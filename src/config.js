import path from 'node:path';

export function readConfig(env = process.env) {
  const id = (key, fallback = '', required = false) => {
    const value = (env[key] || fallback).trim();
    if ((required || value) && !/^\d{17,20}$/.test(value)) {
      throw new Error(`${key} must be a Discord ID. Copy it with Discord Developer Mode enabled.`);
    }
    return value;
  };
  const url = key => {
    const value = (env[key] || '').trim();
    if (!value) return '';
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`${key} must be a valid HTTPS URL.`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error(`${key} must be an HTTPS URL without credentials.`);
    }
    return value;
  };
  if (!env.DISCORD_TOKEN?.trim()) throw new Error('Set DISCORD_TOKEN in .env or Render Environment.');
  const port = Number(env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  const unverifiedRoleId = id('UNVERIFIED_ROLE_ID', '1492018455359127643');
  const verifiedRoleId = id('VERIFIED_ROLE_ID', '1491987224835784754');
  if (unverifiedRoleId === verifiedRoleId) throw new Error('The verified and unverified roles must be different.');
  return {
    token: env.DISCORD_TOKEN.trim(),
    guildId: id('GUILD_ID'),
    verificationChannelId: id('VERIFICATION_CHANNEL_ID', '1503856051232182294'),
    dashboardChannelId: id('DASHBOARD_CHANNEL_ID', '1492006832779165756'),
    ticketDestinationId: id('TICKET_DESTINATION_ID', '1568501776125009984'),
    welcomeChannelId: id('WELCOME_CHANNEL_ID', '1492026750329163776'),
    supportRoleId: id('SUPPORT_ROLE_ID', '1491987441702142074'),
    managementRoleId: id('MANAGEMENT_ROLE_ID'),
    unverifiedRoleId,
    verifiedRoleId,
    verificationBannerUrl: url('VERIFICATION_BANNER_URL'),
    dashboardBannerUrl: url('DASHBOARD_BANNER_URL'),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    port,
  };
}
