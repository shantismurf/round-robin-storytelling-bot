# Plan: Help Content → Hub FAQ Forum Sync

## Context
The bot has three `/story help` pages and planned `/mystory help` / `/storyadmin help` pages.
The Hub Discord server already has a FAQ forum channel. The goal is:

1. Help content lives in config DB (single source of truth, already the case for `/story help`)
2. On demand, the bot posts or updates each help page as a Forum post in the Hub FAQ channel
3. Any time help config keys are updated, the FAQ posts update in place (no new posts, no manual editing)

Config already in place (`config_system.sql`, `guild_id = 1`):
- `cfgHubServerId` — Hub Discord server ID (populated)
- `cfgHubFaqChannelId` — Hub FAQ forum channel ID (populated)
- `cfgFaqThreadOverview` — stores message/thread ID once created (currently empty)
- `cfgFaqThreadWriterCmds` — same
- `cfgFaqThreadStoryCreation` — same
- `cfgFaqThreadManaging` — same
- `cfgFaqThreadAdminCmds` — same

---

## Help Content Audit (what exists, what needs updating)

### Existing pages (config-driven, displayed via `/story help`)
| Key group | Page | Status |
|-----------|------|--------|
| txtHelp1* / lblHelp1* | Page 1 — Overview & Writer Basics | ✅ Current |
| txtHelp2* / lblHelp2* | Page 2 — Story Creation Options | ✅ Current |
| txtHelp3* / lblHelp3* | Page 3 — Managing a Story | ✅ Current |

### Pages needed but not yet written
| Planned page | Target FAQ thread | Config key group |
|-------------|------------------|-----------------|
| Writer Commands quick-ref | `cfgFaqThreadWriterCmds` | `txtFaqWriterCmds*` (new) |
| Admin Commands quick-ref | `cfgFaqThreadAdminCmds` | `txtFaqAdminCmds*` (new) |

### Thread mapping
The five `cfgFaqThread*` keys each store the Forum **post** (thread) ID once created.
The bot updates the **first message** in that thread when syncing.

| Config key | Content |
|------------|---------|
| `cfgFaqThreadOverview` | Help page 1 (Overview) |
| `cfgFaqThreadStoryCreation` | Help page 2 (Story Creation) |
| `cfgFaqThreadManaging` | Help page 3 (Managing) |
| `cfgFaqThreadWriterCmds` | Writer Commands (new page — see below) |
| `cfgFaqThreadAdminCmds` | Admin Commands (new page — see below) |

---

## Help Content Updates Required Before Sync

### /mystory help — stale content
Current `txtMyHelpDashboard` references `/mystory active` and `/mystory history` — commands that don't exist.
Current `txtMyHelpPause` references `/mystory pause [id]` and `/mystory resume [id]` — also removed.
These must be corrected to reflect actual commands (`/mystory list`, `/mystory manage`) before syncing to public FAQ.

Correct values:
```
txtMyHelpDashboard:
  - `/mystory list` — See all your stories — active, paused, delayed, and closed
  - `/mystory catchup [id]` — Read entries written since your last turn

txtMyHelpPause:
  - Use `/mystory manage [id]` to pause, resume, or leave a story.
    If it's your turn when you pause, it will be passed automatically.
```

### /storyadmin help — stale content
Current `txtAdminHelpRemove` may reference old syntax. Audit all `txtAdminHelp*` keys against
the actual `/storyadmin` subcommands before syncing.

---

## New FAQ Page Content (to write)

### Writer Commands (cfgFaqThreadWriterCmds)
A compact reference card for writers. Proposed structure:

```
📋 Writer Command Reference

/story list [page]         — Browse all stories on the server
/story join [id]           — Join a story
/story write [id]          — Submit your entry (Quick Mode)
/story read [id]           — Read the story in Discord
/story edit [id]           — Edit one of your finalized entries
/story timeleft [id]       — See how much time is left in the current turn
/story ping [id]           — Ping all writers in a story
/mystory list              — See all your stories
/mystory manage [id]       — Update your settings or take action on a story
/mystory catchup [id]      — Read entries since your last turn
/story help                — Detailed help on the above
```

**New config keys needed:**
`txtFaqWriterCmdsTitle`, `txtFaqWriterCmdsContent`

### Admin Commands (cfgFaqThreadAdminCmds)
A compact reference card for server admins and story creators.

```
⚙️ Admin Command Reference

/storyadmin setup          — Configure the bot for this server
/storyadmin manage [id]    — Manage a story: users, turns, entries
/storyadmin skip [id]      — Skip the current turn
/storyadmin close [id]     — Close a story
/storyadmin pause [id]     — Pause a story
/storyadmin delete [id]    — Delete a story
/story manage [id]         — Story creator settings (turn length, writer order, tags...)
/storyadmin help           — Detailed help on the above
```

**New config keys needed:**
`txtFaqAdminCmdsTitle`, `txtFaqAdminCmdsContent`

---

## Forum Post Order

Posts must be created in reverse order so oldest sorts to top. Order to post:
1. Admin Commands (`cfgFaqThreadAdminCmds`) — posted first, sorts to bottom
2. Writer Commands (`cfgFaqThreadWriterCmds`)
3. Managing a Story (`cfgFaqThreadManaging`)
4. Create New Story (`cfgFaqThreadStoryCreation`)
5. Overview (`cfgFaqThreadOverview`) — posted last, sorts to top ✅ always

## Draft Files (pending review)

| File | Status |
|------|--------|
| [docs/faq-page-1-overview.md](docs/faq-page-1-overview.md) | ✅ Ready — 1 config change (txtHelp1Dashboard) |
| [docs/faq-page-2-story-creation.md](docs/faq-page-2-story-creation.md) | ⚠️ 2 config changes (txtHelp2HideThreads, txtHelp2CreatorOptions) |
| [docs/faq-page-3-managing.md](docs/faq-page-3-managing.md) | ⚠️ 2 config changes (txtHelp3WhatEdit, txtHelp3AdminControls) |
| [docs/faq-page-4-writer-commands.md](docs/faq-page-4-writer-commands.md) | ⚠️ New content + 3 config changes (txtMyHelpDashboard, txtMyHelpPause, txtMyHelpTurn) |
| [docs/faq-page-5-admin-commands.md](docs/faq-page-5-admin-commands.md) | ⚠️ New content, no config changes needed |

All pages confirmed under 2000 characters (Discord message limit).

---

## Implementation

### Phase 1: Fix stale help content
- Update `txtMyHelpDashboard` and `txtMyHelpPause` in `config_mystory.sql`
- Audit `txtAdminHelp*` keys in `config_storyadmin.sql` against actual subcommands
- No code changes — config-only

### Phase 2: New FAQ page config keys
Add to `config_system.sql`:
```sql
('txtFaqWriterCmdsTitle', '📋 Writer Command Reference', 'en', 1),
('txtFaqWriterCmdsContent', '...', 'en', 1),
('txtFaqAdminCmdsTitle', '⚙️ Admin Command Reference', 'en', 1),
('txtFaqAdminCmdsContent', '...', 'en', 1),
```
User must approve final text before adding to config.

### Phase 3: Sync mechanism (`deploy.js` or new `faq-sync.js`)

**Approach — Deploy-triggered, key-pattern-aware:**
- After `sync_config` runs, check the list of keys that were inserted or updated
- If any key matches the pattern for help content (e.g. `txtHelp*`, `txtMyHelp*`, `txtAdminHelp*`, `txtFaqWriter*`, `txtFaqAdmin*`), fire `sync_faq_posts()`
- If no help keys changed, skip FAQ sync entirely (no rate limit cost on normal deploys)
- `sync_faq_posts()` checks `cfgHubServerId` and `cfgHubFaqChannelId` — if either is empty, skips silently
- For each of the 5 thread config keys:
  - If thread ID stored: fetch the thread, edit its first message with current config content
  - If no thread ID: create a new forum post in the correct order, store the resulting thread ID back to DB
- `deploy.js` currently returns inserted key list from `sync_config` — pass that through to the trigger check

### Phase 4: Forum post format

Each FAQ post = one Forum thread. The thread **title** comes from the `txt*Title` config key.
The thread **first message** content is assembled from the config page keys, formatted as Discord markdown.

For Help pages 1–3, the content is already split into labeled sections (each `txtHelp*` key is one section).
The sync function assembles them into a single message:

```javascript
async function buildFaqPostContent(connection, pageKeys, guildId) {
  const cfg = await getConfigValue(connection, pageKeys, guildId);
  return pageKeys
    .map(k => cfg[k])
    .filter(Boolean)
    .join('\n\n');
}
```

Discord message length limit is 2000 chars. Each help page should be checked for length.
If over limit, split into multiple messages within the same thread (edit message 1, post message 2+).
For now, assume each page fits in one message and add a length check with a log warning.

### Phase 5: DB persistence of thread IDs

`cfgFaqThread*` keys already exist and are stored per `guild_id = 1` (system config).
After creating a new thread, update via:
```javascript
await connection.execute(
  `UPDATE config SET config_value = ? WHERE config_key = ? AND guild_id = 1`,
  [thread.id, cfgKey]
);
```

---

## Files to Create/Modify
- [db/config_files/config_system.sql](db/config_files/config_system.sql) — Add `txtFaqWriter*`, `txtFaqAdmin*` keys
- [db/config_files/config_mystory.sql](db/config_files/config_mystory.sql) — Fix stale `txtMyHelp*` values
- [db/config_files/config_storyadmin.sql](db/config_files/config_storyadmin.sql) — Audit `txtAdminHelp*` values
- New file: `faq-sync.js` — Forum sync logic (called from deploy.js or storyadmin command)
- [commands/storyadmin.js](commands/storyadmin.js) — Add `/storyadmin syncfaq` subcommand (if Option B)
- [db/config_roadmap.md](db/config_roadmap.md) — Add new keys to manifest

## Files NOT Modified
- `story/help.js` — Discord help command stays as-is; FAQ sync is a separate output path

---

## Resolved Decisions
1. **Sync trigger** — deploy-triggered when help-pattern config keys are in the update list. ✅
2. **Post order** — Admin → Writer → Managing → Create → Overview (Overview posts last, sorts to top). ✅
3. **Quick Reference pages** — Yes, Writer Commands and Admin Commands are separate posts in addition to the detailed help pages. ✅
4. **`cfgFaqThreadOverview` mapping** — Page 1 (Overview) only, not a merged summary. ✅
5. **Length check** — All five pages confirmed under 2000 chars. Draft files in docs/ for review. ✅

## Pending (awaiting user review of draft files)
- User review and sign-off on all five draft files in `docs/faq-page-*.md`
- On approval: update config SQL values for the 8 stale keys, add 4 new config keys
- Then implement `faq-sync.js` and wire into `deploy.js`
