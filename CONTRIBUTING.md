# Contributing

## Project Overview

This Discord bot manages collaborative round-robin story writing events with the following features:

- **Multi-story support**: Run multiple stories simultaneously on a server
- **User participation**: Users can join multiple stories, defining unique pen name and status for each
- **Turn management**: Writers are chosen in random, fixed, or Round Robin (random but no repeats until everyone has a turn) order, admin can manually define next writer chosen
- **Flexible timing**: Stories can have custom turn lengths and reminder settings
- **Story modes**: Support for both quick mode storytelling, using a simple modal input, and normal mode, with threads created for each new turn that support multiple posts and image upload. Media entries are forwarded to a media channel and the post id of the forwarded message is stored in the entry in the order posted.
- **Story states**: Stories can be active, paused, delayed, or closed. Delayed stories wait until a specified number of users or amount of time has passed.
- **Admin controls**: Admin role (or server admin) defines who can manage server, user, and story settings
- **Editing entries** - Users and admins can edit story entries and restore older versions.
- **Publishing integration**: Closed stories can be exported as HTML for posting to archives like AO3
- **Job scheduling**: Background job system for turn reminders and timeouts

## Development Guidelines

### Code Organization
- Keep Discord client logic in `index.js`
- Keep story engine logic in `storybot.js` with event emission to index.js
- Shared utilities go in `utilities.js`
- Command handlers in separate files under `story/` and `commands/` directories
- Database schema changes use numbered migration files
- Centralize logic and break out common handlers whenever possible.

### Naming Conventions
- Function names and parameters use camelCase + ID: guildID, storyID, userID, etc.
- Database fields and tables use snake_case: guild_id, story_id, user_id, etc.
- Local variables from Discord objects use camelCase + Id: guildId, userId, channelId

### Configuration Management
- Use `getConfigValue(key, guildID)` for all user-facing text and configuration variables. No hard-coded user-facing text (only "Yes", "No", "None", "On", "Off", and numeric literals may be hardcoded).
- `getConfigValue` supports multi-language with language code and guild-specific customization. Default `guild_id = 1`.
- Variables within template text that must be replaced with contextual values use bracket notation: `[story_id]` and use `replaceTemplateVariables()` for processing, passing a `valueKeyMap` with contextual data.

#### Config Key Naming Convention: `[type][Location][Purpose][Name]`

Keys follow a four-segment camelCase structure. Always search existing keys before adding new ones.

| Segment | Role | Examples |
|---|---|---|
| **type** | What kind of value | `txt`, `lbl`, `btn`, `cfg` |
| **Location** | Which feature/screen | `Setup`, `StoryAdd`, `ManageUser` |
| **Purpose** | Where in the UI it appears | `EmbedTitle`, `ModalTitle`, `ModalField`, `ModalPlaceholder`, `Panel` |
| **Name** | The specific field | `Feed`, `AdminRole`, `RoundupDay` |

**Type prefixes:**
- `txt` — message content: errors, prompts, announcements, embed field names, modal/embed titles, placeholder text
- `lbl` — short labels: modal field labels (≤45 chars), embed field headers
- `btn` — button labels (≤80 chars)
- `cfg` — system settings: channel IDs, role names, numeric thresholds

**Examples:**
- `txtSetupEmbedTitleFeed` — the embed field header for the feed channel field on the setup panel
- `lblSetupModalFieldFeed` — the label inside the feed channel modal input
- `txtSetupModalPlaceholderFeed` — placeholder text inside that same input (≤100 chars)
- `btnSetupFeed` — the button on the setup panel that opens the feed channel modal
- `cfgStoryFeedChannelId` — the stored channel ID value

**Discord character limits to enforce at naming time:**
- Modal titles (`txtXxxModalTitle*`): ≤45 chars
- Modal field labels (`lbl*ModalField*`): ≤45 chars  
- Modal placeholders (`txt*ModalPlaceholder*`): ≤100 chars
- Button labels (`btn*`): ≤80 chars
- Embed field names (`txt*EmbedTitle*`, `lbl*`): ≤256 chars

### Error Handling Standards
- Error messages should be sent to the console using the log() function. Parameters are: `message, { show = true/false, guildName = null } = {}` where show is true on detailed test environment logging.
- Include function name in error message: `FunctionName failed:` or `Error in FunctionName:`
- Include key parameters for debugging context where helpful (e.g., IDs, user input)
- Return structured objects with `success` boolean and `error`/`message` fields
- Use database transactions for multi-step operations with rollback on errors

### Database Interaction Guidelines
- Use prepared sql statements with parameter binding
- Use explicit transactions for operations affecting multiple tables
- Release connections in `finally` blocks to prevent connection leaks
- Follow the pattern: `await connection.beginTransaction()` → operations → `await connection.commit()` → `connection.release()`

### Discord API Best Practices  
- Use `interaction.deferReply()` for operations that may take longer than 3 seconds
- Handle modal submissions with two-stage validation (client-side + server-side)
- Include reason parameters where applicable for audit log clarity

### Testing & Deployment

The test bot and production bot both run on two instance with the same host. To pick up code changes:

1. Push commits to the repository
2. Restart the test bot on the host — `index.js` automatically runs `deploy.js` on startup, which pushes any schema, config table, and slash command definition changes to Discord
3. Test the changes in the Discord server connected to the test bot
4. When testing is complete, restart the production bot

No manual `node deploy.js` is needed — the deploy step is wired into bot startup.

### Help Command Documentation

Whenever a user-facing command is added, changed, or removed, evaluate whether the `/story help` or `/mystory help` text needs updating before closing the task. Help text is stored in the config table under keys prefixed with `txtHelp` and `txtMyHelp`.

