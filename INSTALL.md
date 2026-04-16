# Round Robin StoryBot — Installation Guide

## Requirements

- **Node.js** 16 or higher
- **MariaDB** 10.6+ or **MySQL** 8.0+
- A Discord account with access to the [Discord Developer Portal](https://discord.com/developers/applications)

---

## Step 1 — Create a Discord Application and Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Give it a name and save.
3. Go to the **Bot** tab:
   - Click **Add Bot** if prompted.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent**. This is required for the bot to read attachment data when forwarding media to the media channel.
   - Copy your **bot token** — you will need it for `config.json`.
4. Go to the **OAuth2** tab and copy your **Client ID**.

---

## Step 2 — Invite the Bot to Your Server

In the **OAuth2 → URL Generator** tab:

**Scopes** — check both:
- `bot`
- `applications.commands`

**Bot Permissions** — check all of the following:

| Permission | Why it's needed |
|---|---|
| View Channels | Read channels the bot posts to and manages threads in |
| Send Messages | Post to the feed channel and send fallback @mentions |
| Send Messages in Threads | Post inside turn threads |
| Embed Links | Story cards, status embeds, and announcements |
| Attach Files | Forward media to the media channel; story exports |
| Read Message History | Find and update status embeds; locate announcement messages to delete |
| Manage Messages | Delete Discord's auto-generated thread announcement stub when threads are removed |
| Pin Messages | Pin the status embed inside story threads *(separate from Manage Messages as of January 2026)* |
| Create Public Threads | Create public turn threads and story threads |
| Create Private Threads | Create private turn threads for writers who prefer privacy *(requires server boost level 2+)* |
| Manage Threads | Delete and archive threads on story close or delete |
| Send Messages in Threads | Post status updates, activity logs, and turn notifications inside story and turn threads |
| Manage Roles | Required for `/storyadmin setup` to write channel-level permission overrides for the bot and admin role |

Copy the generated URL, open it in a browser, and add the bot to your server. Confirm it appears in the server member list — if it doesn't, the invite did not include the `bot` scope.

---

## Step 3 — Set Up the Database

Create a database and a user with full privileges on it. The bot does not require root access — it only needs SELECT, INSERT, UPDATE, DELETE, and CREATE TABLE on its own database.

---

## Step 4 — Configure the Bot

Copy `config.example.json` to `config.json` and fill in your values:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "clientId": "YOUR_CLIENT_ID",
  "guildId": "YOUR_SERVER_ID",
  "testMode": true,
  "db": {
    "host": "localhost",
    "port": 3306,
    "user": "your_db_user",
    "password": "your_db_password",
    "database": "your_database_name"
  }
}
```

**`testMode`** controls how slash commands are registered:
- `true` — commands register to the single guild specified by `guildId`. Changes take effect instantly. Use this for development and single-server deployments.
- `false` — commands register globally across all servers the bot is in. Changes can take up to one hour to propagate. Use this for production multi-server deployments.

**`guildId`** is required when `testMode: true`. To find it: in Discord, enable Developer Mode (User Settings → Advanced), then right-click your server name and choose **Copy Server ID**.

---

## Step 5 — Install and Start

```bash
npm install
node index.js
```

On first run, the bot detects a fresh database and automatically:
1. Creates the database schema
2. Loads default configuration values
3. Registers slash commands with Discord

You do not need to run `node deploy.js` manually on a first install. Use `node deploy.js` (or `npm run deploy`) after updates to apply schema migrations, sync any new config keys, and re-register commands.

---

## Step 6 — Configure the Bot in Discord

In your Discord server, run `/storyadmin setup` in any channel as a user with the **Manage Server** permission.

This opens a form where you set:
- **Story feed channel** — the channel where story threads, turn notifications, and announcements will be posted. Required.
- **Media channel** — images posted in turn threads are forwarded here for preservation. Optional; if not set, images are silently skipped during entry finalization.
- **Admin role** — members with this role can use `/storyadmin` commands. Optional; if not set, only users with the Discord Administrator permission can manage stories.

After submitting, the bot will attempt to set channel-level permission overrides on the feed and media channels and will report any permissions it was unable to apply. If warnings appear, check that the bot's role has **Manage Roles** in Server Settings → Roles.

---

## Ongoing Maintenance

After pulling updates from the repository, run:

```bash
node deploy.js
```

This is safe to run at any time — all steps are idempotent (they only add what's missing, never overwrite existing data). Then restart the bot.

---

## Troubleshooting

**Commands show up in the bot's DMs but not in the server, or return "This command can only be used in a server."**
The bot was invited without the `bot` scope — only `applications.commands` was used. Re-invite using a URL that includes both scopes. Confirm the bot appears in the server member list after inviting.

**`/storyadmin setup` reports it could not set bot permissions.**
This can happen when the feed channel is private — Discord does not allow bots to grant themselves access to channels they can't already see. Fix it manually: go to the feed channel → Edit Channel → Permissions → Add Role → select the bot's role → enable all the permissions listed in the setup warning. Then run `/storyadmin setup` again to confirm.

**Private threads aren't being created.**
Private threads require server boost level 2. If your server isn't boosted, use public threads or have users set their privacy preference to public when joining a story.

**The bot can't send DMs to a user.**
Users who have DMs from server members disabled will not receive turn notifications by DM. The bot will fall back to an @mention in the feed channel automatically.
