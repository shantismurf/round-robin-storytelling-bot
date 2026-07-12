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
   - Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for the bot to read attachment data when forwarding media to the media channel) and **Server Members Intent** (required to detect writers leaving or being banned from the server so they can be removed from active stories).
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

**`testMode`** controls how slash commands are registered and what logs are printed the the console:
- `true` — commands register to the single guild specified by `guildId`. Changes take effect instantly. Returns high-resolution logging of all entry points and major logic paths with relevant data, in addition to production logs. Use this for development and single-server deployments.
- `false` — commands register globally across all servers the bot is in. Changes can take up to one hour to propagate. Minimal logging tracks user interactions and errors. Use this for production multi-server deployments.

**`guildId`** is required when `testMode: true`. To find it: in Discord, enable Developer Mode (User Settings → Advanced), then right-click your server name and choose **Copy Server ID**.

---

## Step 5 — Initialize 

```bash
npm install
node index.js
```

Every time index.js is run, the bot connects to the database and automatically:
1. Creates or updates the database schema (changes applied via migration SQL scripts in \db\migrations)
2. Loads or updates system configuration values (necessary IDs and all user-facing text) from \db\config_files
3. Attempts to create FAQ posts from config_help.sql, posted in a forum channel on the hub server (cfgHubServerId and cfgHubFaqChannelId).
4. Registers slash commands with Discord (instantly for test environment, globally for production)
5. Starts the job runner process for ongoing turn management and weekly posts
6. Refreshes status messages on all active stories

**Hub log channel:** The bot posts new guild registrations and permanent job failures to the hub server's `#logs` channel (`cfgHubLogChannelId` in `config_system.sql`). To change the target channel, update that config value and restart.

No manual entry to the database is required for ongoing maintenance. It can all be handled by index.js. 

Unused config values will be reported in the startup log, and those can be cleaned up by adding the log output to \helper\cleanup.js and running it in a terminal.

---

## Step 6 — Configure the Bot in Discord

In your Discord server, run `/storyadmin setup` in any channel as a user with the **Manage Server** permission.

This opens a form where you set:
- **Story feed channel** — the channel where story threads, turn notifications, and announcements will be posted. Required.
- **Media channel** — images posted in turn threads are forwarded here for preservation. It's recommended that this channel be private, but it's not necessary. Optional; if not set, images are silently skipped during entry.  finalization.
- **Admin role** — members with this role can use `/storyadmin` commands. Optional; if not set, only users with the Discord Administrator permission can manage stories.
- **Restricted Feed Channel** — Optional age-restricted channel for Mature or Explicit stories.
- **Restricted Media Channel** — Optional alternative media storage. If blank it will default to the main media channel. If that's blank images will not be processed.
- **Weekly Roundup Channel** — Channel to post a weekly summary of story activity on the current server. Day and Hour can also be configured.

After submitting, the bot will attempt to set channel-level permission overrides on the feed and media channels and will report any permissions it was unable to apply. If warnings appear, check that the bot itself has **Manage Roles** access in Server Settings → Roles.

---

Application support can be found on the Round Robin Storybot Hub server: https://discord.gg/hKH9G5XFpJ