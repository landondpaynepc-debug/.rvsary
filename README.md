# .revisonary Discord bot

Verification, a support dashboard, private tickets, and automatic welcome messages, styled after your screenshots. The spelling **.revisonary** follows your request.

## Your channels

| Feature | Destination |
| --- | --- |
| Verification panel | `1503856051232182294` |
| Dashboard with support menu | `1492006832779165756` |
| Support ticket category | `1568501776125009984` |
| New-member welcome | `1492026750329163776` |

The menu includes **General Support**, **Management Support**, and **Purchase Claim**. Each member can have one open ticket at a time. Closing a ticket keeps its history. A welcome message mentions the joining member, shows the member count at the time of joining, and links to the dashboard channel.

Staff role **`1491987441702142074`** is configured for all three support options. The server is detected from verification channel `1503856051232182294` when `GUILD_ID` is empty. If you set `GUILD_ID`, it must match that channel's server.

## First-time setup

1. Install Node.js 24.22.1 or a newer Node.js 24 release.
2. Create/select your application in the [Discord Developer Portal](https://discord.com/developers/applications). Set the bot's display name to **.revisonary** and upload your logo there. The code does not change the account's name or avatar.
3. On the application's **Bot** page, enable **Server Members Intent**. This is required for welcome messages. Message Content Intent is not required.
4. Invite the application with the **bot** and **applications.commands** scopes. Give it View Channels, Send Messages, Read Message History, Attach Files, Embed Links, Manage Channels, and Manage Roles. For text-channel tickets, also give it Create Private Threads, Send Messages in Threads, and Manage Threads. Channel-level overrides must allow the same relevant permissions. Administrator is not required for the bot.
5. Copy `.env.example` to `.env`. Fill in `DISCORD_TOKEN`. The staff role is already configured; leave `GUILD_ID` empty to detect the server automatically. Enter the token only in this local file or Render's secret environment field; do not paste it in chat or upload `.env` to GitHub.
6. In Server Settings → Roles, place the bot's highest role **above both** `1492018455359127643` and `1491987224835784754`. Give the bot **Manage Roles** at the server level. Both role IDs are already configured; no verification URL is needed.
7. From this folder run:

```sh
npm ci
npm start
```

8. In your Discord server, run **`/setup`** as a server administrator. It posts both panels. Run `/setup panel:Verification` or `/setup panel:Dashboard` to update one. Rerunning updates the saved messages instead of adding copies, provided the saved data is retained. Welcome messages start automatically when new members join; `/setup` does not post a sample welcome.

The bot must keep running for buttons, support tickets and welcomes to work.

## Verification behavior

New members receive role **`1492018455359127643`** when they join. When a member clicks **Verify** in the verification channel, the bot adds **`1491987224835784754`** and then removes **`1492018455359127643`**. All unrelated roles are preserved. Repeated clicks are safe. If removal fails after the verified role is granted, the bot explains the partial result and the member can click again to retry.

This is button-based server access, not Roblox account verification. It replaces the previous external verification link. `VERIFICATION_URL` is no longer used. The panel text now describes this role swap.

After updating from the previous version, restart/redeploy and run `/setup panel:Verification` to replace the old disabled button and text. `UNVERIFIED_ROLE_ID` and `VERIFIED_ROLE_ID` can override the default roles. Enable **Server Members Intent** for automatic role assignment and welcomes. Configure your channel permissions so the verified role can access the intended channels; assigning a role does not change channel permissions. Role assignment applies to new joins while the bot is online, not existing members retroactively. Existing members may still click Verify.

## Ticket permissions

The bot detects the destination type automatically:

- **Category:** creates a private text channel under the category, with explicit access for the customer, bot, and selected staff role. Existing category role grants are not copied. Server administrators can still see tickets. This is the recommended mode if Management Support needs a separate team.
- **Standard text channel:** creates a private thread there and adds the customer. The customer must have View Channel, Read Message History, and Send Messages in Threads on the parent. The staff role needs those permissions plus **Manage Threads** on the parent to discover and access private tickets. Staff use the channel's Threads list to find tickets. Anyone with Manage Threads on that parent can view its private tickets, including Management Support. Use a category for staff-team separation. Forum and announcement channels are not supported.

Set `MANAGEMENT_ROLE_ID` to use a different staff role for Management Support; otherwise it uses `SUPPORT_ROLE_ID`. The role must be a real staff role, not `@everyone` or a managed integration role.

The owner, assigned staff team, or an administrator can close a ticket after confirmation. Category tickets become read-only for the owner and assigned staff role; administrators can still write. Private threads are locked and archived; moderators with Manage Threads retain control. Closed records stay in `data/state.json`. Keep only **one running instance** of this bot and preserve that file across restarts.

## Separate Render service

This project lives at the root of `landondpaynepc-debug/.rvsary`. Its `render.yaml` defines a **new, separate background worker** with a 1 GB persistent disk. It does not replace or reconfigure the existing Vynex service. Leave Root Directory empty, use `npm ci` to build, and `npm start` to run. Your token belongs only in Render's `DISCORD_TOKEN` environment variable.

## Manual Render setup

If configuring a new Render service manually:

1. Put the contents of this folder in the Git repository connected to your service, or set the service's Root Directory to the folder containing `package.json`.
2. Set **Build Command** to `npm ci` and **Start Command** to `npm start`.
3. In Render Environment, set `NODE_VERSION=24.22.1` and `DISCORD_TOKEN`. The staff role, four channel IDs and both verification role IDs are already defaults. Leave `GUILD_ID` empty to auto-detect the server. Optionally set `MANAGEMENT_ROLE_ID`. `VERIFICATION_URL` is no longer used.
4. Attach a persistent disk mounted at `/var/data` and set `DATA_DIR=/var/data`. This preserves duplicate-ticket protection and panel IDs across deploys. Persistent disks and always-running service types can incur hosting charges; check your selected plan before deploying.
5. Use one instance. The bot provides an HTTP health response on `0.0.0.0:$PORT` (default `10000`) for private/web service compatibility. It returns ready only after Discord login and slash-command setup succeed.
6. Deploy, wait for the log saying **Connected**, then run `/setup` in Discord.

`render.yaml` is an optional Blueprint for a **new background worker with a persistent disk**. Do not use it to create a second copy if you are using the existing service. Review the selected Render plan before provisioning. [Render workers](https://render.com/docs/background-workers) run continuously without inbound traffic; [Blueprint settings](https://render.com/docs/blueprint-spec) describe the deployment file.

## Appearance

The included blue banners are fresh vector recreations inspired by your screenshots, not the original artwork. PNGs are ready to use; SVG sources are included. To use your own original banners, replace `assets/verification.png` and `assets/dashboard.png`, or set the optional direct HTTPS banner URLs. Run `/setup` again after changing them. Discord's own theme, font and app badge determine the rest of the appearance.

Panels use [Discord's Components V2 layout](https://discordjs.guide/legacy/popular-topics/display-components). Private-thread visibility follows [Discord's thread permissions](https://docs.discord.com/developers/topics/threads).

## Checks and troubleshooting

Run `npm test` for local tests covering panel payloads, configuration, ticket privacy, duplicate requests, persistence, cleanup, close permissions, and welcome links. These use simulated Discord responses, not a live server.

- **Disallowed intents / login closes:** enable Server Members Intent on the Bot page; large verified apps may need approval for that privileged intent.
- **No `/setup`:** confirm `GUILD_ID`, the invitation scopes, and that the startup log says Connected. You need Administrator to use the command.
- **Missing permissions:** review overrides on each destination, not just the server-wide bot role.
- **Old verification button disabled:** deploy this updated version, restart, and rerun `/setup panel:Verification`.
- **Role assignment fails:** give the bot Manage Roles at the server level and move its highest role above both configured roles. Enable Server Members Intent for join events. Check the bot logs for the specific failure.
- **Support not configured:** set `SUPPORT_ROLE_ID` to your staff role and restart.
- **No welcomes:** enable Server Members Intent and allow the bot to view/send in `1492026750329163776`. Existing members are not welcomed retroactively.
- **Duplicate panels after redeploy:** restore the persistent `state.json` or remove the old panels manually, then run `/setup`. Do not delete state while tickets are active.

Before inviting members to use it, test one join, each support option, a duplicate request, and ticket closure in your server. Live Discord and Render testing requires your configured bot and server access.
