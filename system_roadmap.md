# Round Robin StoryBot — System Roadmap

Reference document for architecture, routing, and job infrastructure.
For config string keys, see `db/config_roadmap.md`.

---

## File Inventory

| File | Purpose | Lines |
|------|---------|-------|
| `index.js` | Entry point, Discord client, interaction router | ~250 |
| `utilities.js` | Shared helpers: DB, logging, config, validators, parseDuration, formatDuration | ~680 |
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
| `story/_metadataModals.js` | Shared embed/modal builders for /story add and /story manage: getMetaCfg, buildStoryEmbed, buildMetadataModal, buildTagsModal | ~255 |
| `story/_writerDeparted.js` | `handleWriterDeparted()` — sweeps a user out of every story they're writing in a guild on `GuildMemberRemove`/`GuildBanAdd`; mirrors the voluntary-leave protocol | ~75 |

---

## customId Routing

All Discord interactions are dispatched in `index.js` → `InteractionCreate` handler.

### Slash Commands
Routed by `interaction.commandName` to the matching command in `client.commands`.

### Slash Subcommands (`/story`)
| Subcommand | Handler | Notes |
|------------|---------|-------|
| `add` | `handleAddStory` | |
| `list` | `handleListStories` | |
| `write` | `handleWrite` | Quick mode only |
| `join` | `handleJoin` | |
| `read` | `handleRead` | |
| `close` | `handleClose` | Creator/admin |
| `manage` | `handleManage` | Creator/admin |
| `timeleft` | `handleTimeleft` | |
| `help` | `handleHelp` | |
| `ping` | `handlePing` | Creator/admin |
| `edit` | `handleEdit` | |
| `tag` | `handleTagCommand` | Active writers only; opens tag submit modal |

### Modal Submissions (`isModalSubmit`)
| Prefix | Handler |
|--------|---------|
| `story_*` | `story.handleModalSubmit()` |
| `storyadmin_*` | `storyadmin.handleModalSubmit()` |
| `mystory_*` | `mystory.handleModalSubmit()` |

### Button Clicks (`isButton`) — tag-related
| Prefix | Handler | Auth |
|--------|---------|------|
| `story_submit_tag_<storyId>` | `handleTagSubmit` | Active writers only |
| `story_tag_submit_modal_<storyId>` | `handleTagSubmitModalSubmit` | Active writers only (modal) |
| `story_tag_delete_<submissionId>` | `handleTagDeleteButton` | Submitter / creator / admin |
| `story_tag_delete_confirm_<submissionId>` | `handleTagDeleteConfirm` | Re-checked on confirm |
| `story_tag_delete_cancel_<submissionId>` | `handleTagDeleteCancel` | Any |
| `story_tag_view_proposed_<storyId>` | `handleViewProposedTags` | All server members |
| `story_view_tags_<storyId>` | `handleViewProposedTags` | All server members (legacy alias) |
| `story_tag_manage_<storyId>` | `handleTagManageButton` | Creator/admin (auth-gated on click) |
| `story_manage_review_tags_read_<storyId>` | `handleEditTagsButton` | Creator/admin |
| `story_tag_approve_<submissionId>_<storyId>` | `handleTagReviewButton` | Creator/admin |
| `story_tag_reject_<submissionId>_<storyId>` | `handleTagReviewButton` | Creator/admin |
| `story_tag_view_prev_<storyId>_<pageIndex>` | `handleViewTagsNav` | Writers/creator/admin |
| `story_tag_view_next_<storyId>_<pageIndex>` | `handleViewTagsNav` | Writers/creator/admin |

**Manage Tags panel entry points** (`handleEditTagsButton`):
1. Read view → `story_manage_review_tags_read_<storyId>` button
2. Thread post → `story_tag_manage_<storyId>` → `handleTagManageButton` → delegates to `handleEditTagsButton`

### Button Clicks (`isButton`) — all others
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
| `turnTimeout` | `handleTurnTimeout()` | Fires when a turn deadline passes; ends turn, advances to next writer. Not created for slow mode turns — guarded by `isSlowMode` check in `story/_turn.js`. |
| `turnReminder` | `handleTurnReminder()` | Fires once partway through a turn (at `reminder_timing`% of turn length) to remind the active writer. Normal/quick mode only. |
| `turnSlowReminder` | `handleSlowTurnReminder()` | Fires every `reminder_timing` hours to remind the writer of an open slow mode turn. Self-rescheduling: inserts a new job on fire. Cancelled on turn end or story pause. |
| `weeklyRoundup` | `handleWeeklyRoundup()` (story/roundup.js) | Weekly summary post. Dedup via `job_log` table — `INSERT IGNORE` on `(job_type, guild_id, window_key)` ensures only the first execution per window posts. |

Job retry: max 3 attempts, 5-minute delay between retries. Status codes: `0`=pending, `1`=in-progress, `2`=permanently failed, `3`=cancelled, `4`=completed.

On startup, any job still at status `1` is re-queued to `0` — a job only stays claimed while its handler is synchronously running, so if the process restarted mid-job (e.g. a deploy), the row is orphaned rather than genuinely stuck. Completed/cancelled/failed jobs (`2`/`3`/`4`) older than 30 days are purged once per day.

Note: status `2` is dual-purpose — set both by the retry exhaustion path in `job-runner.js` (genuine permanent failure, `attempts` = 3) and by pause/extend actions that cancel a job before rescheduling it (`attempts` = 0). Check `attempts` to tell the two apart when auditing. Status `3` is used when a turn ends outright (skip, timeout, close, remove) via `endTurnGuarded()` — no replacement job follows.

### job_log table

Permanent record of completed scheduled job windows. Used for idempotency — a job checks `job_log` before acting, not the transient `job` table state.

| Column | Type | Purpose |
|--------|------|---------|
| `job_type` | VARCHAR(50) | Matches `job.job_type` |
| `guild_id` | BIGINT NOT NULL | Guild the job ran for |
| `window_key` | VARCHAR(100) | Unique identifier for the logical window (e.g. scheduled ISO timestamp) |
| `scheduled_at` | DATETIME | When the job was supposed to run |
| `posted_at` | DATETIME | When it actually ran (DEFAULT NOW) |

Unique constraint on `(job_type, guild_id, window_key)` — duplicate insert fails silently via `INSERT IGNORE`.

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
| `closeOrphanedGuildStories(conn, guildId)` | Bulk-closes a guild's stories on lost bot access (Discord `10004`): ends any active turns, closes stories, cancels pending jobs |

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
