# Round Robin StoryBot — System Roadmap

Reference document for architecture, routing, and job infrastructure.
For config string keys, see `db/config_roadmap.md`.

---

## File Inventory

| File | Purpose | Lines |
|------|---------|-------|
| `index.js` | Entry point, Discord client, interaction router | ~250 |
| `utilities.js` | Shared helpers: DB, logging, config, validators | ~570 |
| `storybot.js` | Core story engine: CreateStory, NextTurn, PickNextWriter | — |
| `job-runner.js` | Background job polling and execution | ~250 |
| `deploy.js` | CLI deploy: migrations, config sync, command registration | ~80 |
| `sync-config.js` | Syncs SQL config files into the database | — |
| `database-setup.js` | Schema creation and migrations | — |
| `announcements.js` | Story feed announcement embeds | — |
| `commands/story.js` | `/story` command handler (delegates to `story/` subcommands) | — |
| `commands/storyadmin.js` | `/storyadmin` command handler | — |
| `commands/mystory.js` | `/mystory` command handler | — |
| `story/` | Per-subcommand modules: add, close, edit, help, join, list, manage, ping, read, timeleft, write, roundup | — |

---

## customId Routing

All Discord interactions are dispatched in `index.js` → `InteractionCreate` handler.

### Slash Commands
Routed by `interaction.commandName` to the matching command in `client.commands`.

### Modal Submissions (`isModalSubmit`)
| Prefix | Handler |
|--------|---------|
| `story_*` | `story.handleModalSubmit()` |
| `storyadmin_*` | `storyadmin.handleModalSubmit()` |
| `mystory_*` | `mystory.handleModalSubmit()` |

### Button Clicks (`isButton`)
| Prefix | Handler |
|--------|---------|
| `storyadmin_*` | `storyadmin.handleButtonInteraction()` |
| `catchup_*` or `mystory_*` | `mystory.handleButtonInteraction()` |
| all others | `story.handleButtonInteraction()` |

Duplicate button clicks (same user + customId already in-flight) are suppressed via `processingButtons` Set and logged at `show: false`.

### String Select Menus (`isStringSelectMenu`)
| Prefix | Handler |
|--------|---------|
| `story_*` | `story.handleSelectMenuInteraction()` |

No storyadmin or mystory select menus exist as of Silo 1 audit.

---

## Job Type Registry

Jobs are stored in the `job` table and polled every 60 seconds by `job-runner.js`.

| `job_type` | Handler | Description |
|------------|---------|-------------|
| `checkStoryDelay` | `handleCheckStoryDelay()` | Fires when the join-window expires; activates story if writer count met |
| `turnTimeout` | `handleTurnTimeout()` | Fires when a turn deadline passes; ends turn, advances to next writer |
| `turnReminder` | `handleTurnReminder()` | Fires partway through a turn to remind the active writer |
| `weeklyRoundup` | `handleWeeklyRoundup()` (story/roundup.js) | Weekly summary post |

Job retry: max 3 attempts, 5-minute delay between retries. Status codes: `0`=pending, `1`=in-progress, `2`=permanently failed, `3`=cancelled.

---

## Key Shared Utilities (`utilities.js`)

| Function | Purpose |
|----------|---------|
| `getConfigValue(conn, key, guildId)` | Config string lookup with guild override; logs on miss |
| `log(content, { show, guildName })` | Unified logger; `show: false` = test-mode only |
| `validateStoryAccess(conn, storyId, guildId)` | Checks story exists, belongs to guild, is active |
| `validateActiveWriter(conn, userId, storyId)` | Checks user holds the current turn |
| `checkIsAdmin(conn, interaction, guildId)` | Administrator permission or configured admin role |
| `createThread(interaction, guildId, keyValueMap)` | Creates public or private Discord thread with permissions |
| `resolveStoryId(conn, guildId, guildStoryId)` | Resolves guild-local story number to internal PK |
| `getTurnNumber(conn, storyId)` | Next confirmed turn number for display |
| `getEntryEditInfo(conn, entryId, authorId, createdAt)` | Edit metadata with 1-hour grace suppression |
| `chunkEntryContent(content, maxChunkSize)` | Splits long entries at paragraph boundaries |
| `replaceTemplateVariables(template, keyValueMap)` | `[key]` substitution in config string templates |
| `sendUserMessage(conn, interaction, writerId, cfgKey)` | DM writer; falls back to channel mention |
| `sanitize(input, maxLength)` | Escapes HTML entities and Discord markdown for embed fields |
| `sanitizeModalInput(input, maxLength, multiline)` | Normalizes whitespace from modal text inputs |
| `splitAtParagraphs(text, maxLen)` | Splits embed text at paragraph boundaries |

---

## Logging Convention

- `log(msg, { show: true })` — Always visible; use for state changes, errors, missing config keys.
- `log(msg, { show: false })` — Visible only in test mode (`testMode: true` in config.json); use for entry points, API calls, validation outcomes.
- Format for errors: `functionName failed for [context]: ${error?.stack ?? error}`
- `deploy.js` uses raw `console.log` intentionally — it is a CLI tool run before the bot starts and is developer-only. This is the only exception to the `log()` standard.

---

## Silo Audit Status

| Silo | Files | Status |
|------|-------|--------|
| 1 — Gateway & Utilities | index.js, utilities.js, deploy.js, job-runner.js | ✅ Complete |
| 2 — Story Management | commands/story.js, story/, config_story.sql, config_metadata.sql | ⬜ Pending |
| 3 — Admin & Overrides | commands/storyadmin.js, config_storyadmin.sql | ⬜ Pending |
| 4 — User Experience | commands/mystory.js, config_mystory.sql | ⬜ Pending |
| 5 — The Engine | storybot.js, config_turn.sql | ⬜ Pending |
