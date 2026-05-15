# Round Robin StoryBot — System Roadmap & Export Manifest

This document maps the bot's logic. Use this to identify where a process lives and which exported functions are available for reuse.

**File naming convention in `story/`:**
- No prefix = subcommand handler (maps to a user-facing command or interaction flow)
- `_` prefix = internal module (called by other files, not a direct command entry point)

### 📂 1. Core Logic (The Engine)
**File:** `storybot.js`  
**Purpose:** Story creation/join orchestration and shared base exports. No Discord UI code here.
- `CreateStory()`: Validates and inserts a new story into the DB.
- `StoryJoin()`: Handles writer entry, capacity checks, and deduping.
- `getActiveThreadId()`: Resolves the correct active thread for a story (NR vs restricted).
- `StoryBot`: EventEmitter class for publish events.

### 📂 2. Core Modules (Internal)
**File:** `story/_turn.js`  
**Purpose:** Turn lifecycle — selection, creation, notifications, and thread management.
- `NextTurn()`: Creates a new turn, schedules jobs, posts thread and notifications.
- `PickNextWriter()`: Selects next writer (Random, Round Robin, Fixed order).
- `postStoryThreadActivity()`: Posts activity log messages to the story thread.
- `deleteThreadAndAnnouncement()`: Deletes a thread and its parent channel announcement.
- `skipActiveTurn()`: Ends a turn as a skip, cancels jobs, deletes thread.
- `turnEndTimeFunction()`: Calculates turn end timestamp.

**File:** `story/_storyStatus.js`  
**Purpose:** Story status embed — builds, posts, and keeps it updated.
- `updateStoryStatusMessage()`: Builds and posts (or edits) the pinned status embed.
- `buildThreadTitle()`: Builds the story thread title string from config templates.

**File:** `story/_delay.js`  
**Purpose:** Delayed story activation logic.
- `checkStoryDelay()`: Checks writer-count and hour-delay conditions; activates story if met.

**File:** `story/_migration.js`  
**Purpose:** Thread migration when story rating crosses the M/E barrier.
- `migrateStoryThread()`: Moves the active thread between feed channels and updates DB.

**File:** `story/_metadata.js`  
**Purpose:** Rating, warning, and feed channel helpers.
- `isRestricted()`, `crossesBarrier()`, `formatWarnings()`, `buildMetadataFields()`
- `resolveFeedChannelId()`, `resolveMediaChannelId()`
- `ratingBadge`, `ratingLabels`, `warningOptions`, `dynamicOptions`

**File:** `story/_addMetadata.js`  
**Purpose:** AO3-style metadata panel UI (ratings, warnings, dynamic, etc.).
- `buildMetadataPanel()`, `handleMetadataButton()`, `handleMetadataModal()`, `handleMetadataSelectMenu()`
- `getMetaCfg()`, `registerMetaSession()`

**File:** `story/_manageEntries.js`  
**Purpose:** Admin entry management sub-panel (view, edit, delete entries).
- `handleManageEntriesButton()`, `handleManageEntriesModal()`, `handleManageEntriesSelectMenu()`, `handleManageEntriesActionButton()`

**File:** `story/_manageTurnActions.js`  
**Purpose:** Admin turn action sub-panel (skip, extend, reassign, pause).
- `buildTurnActionsPanel()`, `handleTurnActionButton()`, `handleTurnActionConfirm()`, `handleTurnActionCancel()`, `handleTurnActionSelectMenu()`, `handleTurnActionModal()`

**File:** `story/_manageUser.js`  
**Purpose:** Admin user management sub-panel (writer status, pen name, order).
- `handleManageUser()`, `handleManageUserButton()`, `handleManageUserModalSubmit()`

**File:** `story/_entryRenderer.js`  
**Purpose:** Builds paginated entry embeds for read/preview display.
- `buildEntryPages()`, `buildEntryEmbed()`, `postThreadEntry()`

**File:** `story/_state.js`  
**Purpose:** Shared in-memory session Maps (pending previews, reads, edits).
- `pendingPreviewData`, `pendingViewData`, `pendingReadData`, `lastReadPage`, `pendingEditData`

### 📂 3. Main Entry & Routing
**File:** `index.js`  
**Purpose:** Gateway for all Discord events.
- `interactionCreate`: Global listener. Routes `isCommand`, `isButton`, and `isModalSubmit`.
- `client.on('ready')`: Triggers the deployment and job-runner sequences.

### 📂 4. Feature: Story Commands
**File:** `commands/story.js`  
**Purpose:** Entry point for `/story`. Routes all subcommands and interactions.

**File:** `story/add.js` — `/story add` flow  
**File:** `story/join.js` — join story flow  
**File:** `story/write.js` — turn writing flow  
**File:** `story/read.js` — read story entries  
**File:** `story/edit.js` — edit entries  
**File:** `story/manage.js` — manage story panel  
**File:** `story/close.js` — close story  
**File:** `story/list.js` — list stories  
**File:** `story/tags.js` — tag submission and management  
**File:** `story/timeleft.js` — turn time remaining  
**File:** `story/ping.js` — ping current writer  
**File:** `story/help.js` — help pages  
**File:** `story/export.js` — story export  

### 📂 5. Feature: Admin Overrides
**File:** `commands/storyadmin.js`  
**Purpose:** Server-level configuration and override actions.

### 📂 6. Feature: Writer Dashboard
**File:** `commands/mystory.js`  
**Purpose:** Personal participation and catchup logic.

### 📂 7. Shared Utilities
**File:** `utilities.js`  
**Purpose:** Helpers used by every other file.
- `getConfigValue()`: Retrieves text from the database via config roadmap.
- `log()`: Unified dynamic logger (Strings, Tables, Deep Objects).
- `sanitizeModalInput()`: Cleans user input and enforces length limits.
- `replaceTemplateVariables()`: Swaps `[story_id]` placeholders with live data.
- `formattedDate()`: Consistent timestamping for logs.

### 📂 8. Background Jobs
**File:** `job-runner.js`  
**Purpose:** Processes timeouts and reminders while the bot is running.
- `startJobRunner()`: Initial loop for processing the `job` table.
- `processJob()`: Routes jobs to turn/delay modules.

### 📂 9. Automation
**File:** `story/roundup.js`  
**Purpose:** Weekly roundup stats and scheduling.
