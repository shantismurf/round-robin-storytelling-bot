# Round-Robin Storytelling Bot

A Discord bot for running collaborative relay-style stories where writers take turns contributing entries. When one writer finalizes their turn, the next participant is automatically selected and notified.

## Quick Start

1. Copy `config.example.json` to `config.json` and fill in your bot token, client ID, and database credentials.
2. Run `npm install`
3. Run `node database-setup.js` to initialize the database schema.
4. Run `node deploy-commands.js` to register slash commands with Discord.
5. Run `npm start`

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
- cfgMediaChannelId - Images posted in story turn threads are reposted to this channel to be preserved for story export. If not set, images are silently skipped during finalization and only text content is saved.
- cfgAdminRoleName - All story administration is allowed by server admins, and to some extent also story creators, so if the role isn't found, the system can still be managed, but it allows for non-server admins to manage settings and users in all stories.
