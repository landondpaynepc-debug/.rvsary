# .revisonary Discord bot

Verification, a support dashboard, private tickets, and automatic welcome messages, styled after your screenshots. The spelling **.revisonary** follows your request.

## Your channels

| Feature | Destination |
| --- | --- |
| Verification panel | `1503856051232182294` |
| Dashboard with support menu | `1492006832779165756` |
| Support ticket category | `1568501776125009984` |
| New-member welcome | `1492026750329163776` |
| Careers panel | `1492245276201582763` |
| Application review and activity logs | `1492019040082985110` |
| Moderation logs | `1492018824441102517` |
| Other event logs | `1492018836898054226` |

The menu includes **General Support**, **Management Support**, and **Purchase Claim**. Each member can have one open ticket at a time. Staff can claim tickets, which displays the assigned staff member. Closing a ticket keeps its history and shows a **Delete Ticket** option for staff. Deleting requires a separate confirmation and permanently removes the channel and conversation. A welcome message mentions the joining member, shows the member count at the time of joining, and links to the dashboard channel.

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

8. In your Discord server, run **`/setup`** as a server administrator. It posts all three panels. Use the Verification, Dashboard or Careers choice to update one. The careers panel also publishes or refreshes on startup. Rerunning updates saved messages instead of adding copies when saved data is retained. Welcome messages start automatically when new members join; `/setup` does not post a sample welcome.

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

The owner, assigned staff team, or an administrator can close a ticket after confirmation. Only the assigned staff role or an administrator can claim or delete a ticket. Claiming records one staff member and survives restarts; other assigned staff can still close or delete the ticket. Open tickets cannot be deleted using the bot. Permissions are checked again when deletion is confirmed.

Category tickets become read-only for the owner and assigned staff role; administrators can still write. Closed tickets show **Delete Ticket**, followed by **Delete Permanently** or **Keep Ticket**. Deletion removes the entire conversation; no transcript is exported. Private threads are locked and archived; moderators with Manage Threads retain control and may need to unarchive a thread to use its buttons. Ticket metadata stays in `data/state.json`, including claim, close and deletion details. Existing tracked tickets receive the new controls on startup. Keep only **one running instance** of this bot and preserve that file across restarts.

## Moderation commands

| Command | Use | Required moderator permission |
| --- | --- | --- |
| `/warn member reason` | Save a warning and try to DM the member | Moderate Members |
| `/warnings member` | Show the latest 10 saved warnings | Moderate Members |
| `/timeout member minutes reason` | Timeout from 1 minute to 28 days | Moderate Members |
| `/untimeout member reason` | Remove a timeout | Moderate Members |
| `/kick member reason` | Kick a member | Kick Members |
| `/ban member reason` | Ban a member, keeping message history | Ban Members |
| `/unban user-id reason` | Unban by Discord ID | Ban Members |
| `/clear amount [user] [contains] [reason]` | Clear matching messages from the most recent 100 | Manage Messages |
| `/say message [channel]` | Make the bot send text; mentions never ping | Manage Messages |
| `/lock reason` | Deny @everyone Send Messages in this channel | Manage Channels |
| `/unlock reason` | Restore the exact setting saved by `/lock` | Manage Channels |
| `/slowmode seconds reason` | Set slowmode; 0 disables it | Manage Channels |

Permissions are checked at runtime as well as when commands are displayed. Moderators cannot target themselves, the bot, the server owner, or members with equal/higher roles. The bot needs the corresponding permissions and an appropriately high role. `/clear` skips pinned messages and messages near or over Discord's 14-day bulk-delete limit. `/clear contains` needs Message Content access. `/say` checks both the moderator's and bot's access to the destination. Explicit channel role grants can bypass the @everyone lock; `/unlock` does not invent new permissions.

## Careers and applications

The careers panel offers **Support Staff**, **Management+**, and **Design Team**. `/apply team` also starts or resumes an application. The bot asks questions in DMs, one at a time, saves progress, then offers **Submit Application**. Applicants can type `resume` to repeat the current question or `cancel` to stop. Only one draft or pending application is allowed per applicant. Answers are limited to 800 characters; portfolio links may be included.

The owner-requested application reset `2026-11-08-request-1` runs once on startup. It clears existing application drafts, pending submissions and decisions, removes their bot-authored review messages, and keeps existing member roles and the careers panel. A persistent marker prevents subsequent restarts from clearing new applications. Failed review-message cleanup retries automatically; old application buttons cannot act after their stored application is cleared. Messages already sent in members' DMs and previously delivered activity logs are not erased.

Members with role `1494522719851643020` and administrators may use `/reset-applications`. It asks for confirmation, rechecks the role before resetting, clears saved applications and their review messages, and records who requested the reset. New applications survive subsequent restarts. The original reviewer role keeps accept/deny access. The bot ensures the new reviewer role can view the application channel, read its history and use commands there.

Design Team's first question is a selection menu allowing any combination of GFX, VFX, and Discord Services. Each team then has questions about experience, relevant scenarios or portfolio, and availability. The questions are editable in `src/applications.js`.

Submitted answers go to `1492019040082985110`. Members with reviewer role `1492001472416845987` or `1494522719851643020`, or administrators, may use **Accept with reason** or **Deny with reason**. Both open a required reason form. Authorized reviewers may review their own applications as well as applications from other members. The reason form opens immediately, then the bot fetches current server membership and checks reviewer permissions when the decision is submitted; cached button roles cannot incorrectly block an authorized reviewer. Acceptance assigns roles before recording a final acceptance. Failed grants undo roles added by that attempt. Interrupted approvals are recovered on restart. Applications already posted in `1492019111142887434` retain their original review messages and working buttons; each application saves its review channel. Claim/close/delete ticket controls are separate from application reviews.

| Accepted team | Roles assigned |
| --- | --- |
| Support Staff | `1491987441702142074` + `1491994140819324988` |
| Management+ | `1491987441702142074` + `1492001472416845987` |
| Design Team | `1507979010053771354` + selected specialty roles |
| GFX specialty | `1507984459839045762` |
| VFX specialty | `1492013251700064307` |
| Discord Services specialty | `1492013217692778616` |

Keep the bot's highest role above all these roles and grant Manage Roles. Decision DMs contain accepted/denied and the reviewer's reason. Closed DMs cannot be forced open: the review message shows pending delivery and the bot retries hourly. Review messages disable decision buttons after completion. Application activity logs accompany the submitted applications in `1492019040082985110`. Restrict the review channel and persistent data to the appropriate team.

## Logging

Moderation commands, warnings, bans/unbans and relevant server audit entries go to `1492018824441102517`. Application starts, submissions, cancellations, decisions, recovery and action errors go to `1492019040082985110`, alongside the submitted applications with Accept/Deny buttons. Tickets, verification, member joins/leaves, role/nickname changes, channel/role/thread changes, message edits/deletes, voice moves/server mute changes, startup and other bot action errors go to `1492018836898054226`. The bot also logs other audit entries Discord sends, with actor, target, reason and a bounded change summary. Give the bot **View Audit Log** to receive these entries and View Channel, Send Messages and Embed Links in all log channels.

`ENABLE_MESSAGE_CONTENT=auto` (the default) checks the app's current access before connecting. Enable **Message Content Intent** in the Developer Portal and restart to include message text and use `/clear contains`. `false` opts out; `true` explicitly requests it and requires prior enablement. Application answers in DMs work without this privileged intent. Content excerpts in logs are capped at 400 characters. Bot logs are operational records, not complete transcripts: Discord cannot supply events while the bot is offline, uncached deleted content cannot be recovered, and inaccessible channels cannot be monitored. Log-channel message edits/deletes are excluded to avoid recursive logging.

Failed log deliveries are saved to the persistent disk and retried every minute, with a 2,000-entry queue limit. Monitor Render logs for delivery failures or queue overflow. The bot does not copy every ordinary message, private DM outside an application, or reaction into logs.

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

The verification panel uses your supplied original artwork, saved as `assets/verification.webp` so it does not depend on an expiring Discord attachment link. Tickets use your original `assets/support.png`. Careers use the matching generated `assets/careers.png`; its generation prompt is saved in `assets/careers-prompt.txt`. The dashboard uses the included blue recreation, `assets/dashboard.png`. Existing saved verification and ticket messages refresh on startup when needed. Discord's own theme, font and app badge determine the rest of the appearance.

Panels use [Discord's Components V2 layout](https://discordjs.guide/legacy/popular-topics/display-components). Private-thread visibility follows [Discord's thread permissions](https://docs.discord.com/developers/topics/threads).

## Checks and troubleshooting

Run `npm test` for local tests covering panels, verification, ticket privacy, duplicate requests, claim/close/delete permissions, application questions and decisions, role assignment rollback, concurrent reviews, DM retry, moderation filters/hierarchy and durable logs. These use simulated Discord responses, not a live server.

- **Disallowed intents / login closes:** enable Server Members Intent on the Bot page; large verified apps may need approval for that privileged intent.
- **No `/setup`:** confirm `GUILD_ID`, the invitation scopes, and that the startup log says Connected. You need Administrator to use the command.
- **Missing permissions:** review overrides on each destination, not just the server-wide bot role.
- **Old verification button disabled:** deploy this updated version, restart, and rerun `/setup panel:Verification`.
- **Role assignment fails:** give the bot Manage Roles at the server level and move its highest role above both configured roles. Enable Server Members Intent for join events. Check the bot logs for the specific failure.
- **Support not configured:** set `SUPPORT_ROLE_ID` to your staff role and restart.
- **No welcomes:** enable Server Members Intent and allow the bot to view/send in `1492026750329163776`. Existing members are not welcomed retroactively.
- **Duplicate panels after redeploy:** restore the persistent `state.json` or remove the old panels manually, then run `/setup`. Do not delete state while tickets are active.

Before inviting members to use it, test one join, each support option, a duplicate request, and ticket closure in your server. Live Discord and Render testing requires your configured bot and server access.
