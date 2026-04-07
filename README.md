# Round Robin StoryBot

A Discord bot for running collaborative relay-style stories where writers take turns contributing entries. When one writer finalizes their turn, the next participant is automatically selected and notified.

## Quick Start

1. In the Discord Developer Portal, create an application and bot. Enable the **Message Content** privileged intent (Bot → Privileged Gateway Intents).
2. Invite the bot to your server using an OAuth2 URL with scopes **`bot`** and **`applications.commands`** and the permissions listed below.
3. Copy `config.example.json` to `config.json` and fill in your bot token, client ID, guild ID, and database credentials. Set `testMode: true` for a single-server test deployment.
4. Run `npm install`
5. Run `node deploy.js` — sets up the database schema, syncs default config, and registers slash commands.
6. Run `node index.js` (or `npm start`)
7. In Discord, run `/storyadmin setup` in any server channel as a user with the Manage Server permission.

## Required Bot Permissions

These permissions must be granted to the bot's role when inviting it. `/storyadmin setup` will attempt to grant channel-level overrides for the feed and media channels, but the bot's role must already have **Manage Roles** for that to work.

| Permission | Why it's needed |
|---|---|
| View Channels | Read any channel the bot posts to or manages threads in |
| Send Messages | Post to the feed channel and fallback @mentions |
| Send Messages in Threads | Post inside turn threads |
| Embed Links | All status embeds, story cards, and announcements |
| Attach Files | Forward media to the media channel; story exports |
| Read Message History | Fetch messages to update status embeds and find announcements to delete |
| Manage Messages | Delete announcement stub messages when threads are removed |
| Pin Messages | Pin the status embed in story threads (separate from Manage Messages as of Jan 2026) |
| Create Public Threads | Create public turn threads and story threads |
| Create Private Threads | Create private turn threads for writers who prefer privacy |
| Manage Threads | Delete and archive threads on story close or delete |
| Manage Roles | Allows `/storyadmin setup` to set channel-level permission overrides for the bot and admin role |

The bot uses slash commands, buttons, modals, and select menus — no message content reading is required beyond what the Message Content privileged intent covers for attachment forwarding.

## Project Layout

- `index.js` — bot entry point, Discord client wiring, event and interaction routing
- `storybot.js` — core story engine: turn lifecycle, writer selection, status embeds, activity logging
- `job-runner.js` — scheduled job processor for turn timeouts and reminders
- `announcements.js` — story feed announcement helpers
- `utilities.js` — shared helpers (config lookup, DB class, input sanitization)
- `commands/story.js` — all `/story` slash commands and modal handling
- `commands/storyadmin.js` — `/storyadmin` commands for server admins
- `commands/mystory.js` — `/mystory` commands for writers
- `db/migrations/` — SQL migration files (run in order)
- `deploy-commands.js` — registers slash commands with the Discord API
- `sync-config.js` — pushes default config values from `db/sample_config.sql` to the database

## Configuration

All user-facing text and server settings are stored in the database config table and can be customized per server or translated to other languages. See `db/sample_config.sql` for default values. The getConfigValue function will default to values with guild_id = 1 if no guild-specific value exists.

Server-specific variables are:
- cfgStoryFeedChannelId - ID of the channel where all story and turn threads and story activity will take place. This must be present.
- cfgMediaChannelId - Images posted in story turn threads are reposted to this channel to be preserved for story export. If not set, images are silently skipped during finalization and only text content is saved. Alternate help text is used that does not mention images.
- cfgAdminRoleName - All story administration is allowed for server admins, and to some extent also story creators, so the system can still be managed if the role isn't found, but it allows for non-server admins to manage settings and users in all stories.
