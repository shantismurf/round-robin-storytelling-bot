# Silo-Sprint Plan: Silo 3 — Admin & Overrides

## Context
Audit of all storyadmin command files. Focus on bugs, hardcoded strings, and logging gaps.

---

## Bug Findings (fix before anything else)

### BUG 1 — storyadmin.js:617 — `getInteger` on a string option (CRITICAL)
`handleDelete` calls `interaction.options.getInteger('story_id')` but `story_id` is defined as a `.addStringOption` — `getInteger` always returns `null`, so `resolveStoryId` never resolves and the command always replies "story not found." The delete subcommand is entirely broken.

**Fix:** Change `getInteger('story_id')` → `parseInt(interaction.options.getString('story_id') ?? '', 10)` (matches the pattern used in `handleManageUser` at line 67).

### BUG 2 RESOLVED — manageTurnActions.js:127 — reassign missing `story_writer_id` on activeTurn
`handleTurnActionButton` (reassign branch) fetches `activeTurn` with columns `turn_id`, `thread_id`, `current_writer_name` only. At line 226, the reassign confirm writes `activeTurn.story_writer_id` to queue the skipped writer — but that column was never fetched, so it is `undefined` and the UPDATE writes `NULL`, silently discarding the queue.

**Fix:** Add `t.story_writer_id` to the SELECT at line 127.

### BUG 3 — manageUser.js:40 — hardcoded user-visible embed description
`.setDescription('-# Changes are staged — click **Save Settings** to apply notifications/privacy. Status actions (Pause/Restore/Remove) apply immediately.')` is a full user-facing sentence hardcoded in the embed.

**Fix:** Add config key `txtManageUserPanelDesc` to `config_storyadmin.sql` and load it in the bulk cfg fetch.

### BUG 4 — manageTurnActions.js:346 — hardcoded validation error (user-facing)
`'❌ Hours must be a positive number.'` sent directly to Discord.

**Fix:** Add config key `txtTurnExtendInvalidHours`.

### BUG 5 — manageTurnActions.js:403 — hardcoded validation error (user-facing)
`'❌ Turn number must be a positive integer.'` sent directly to Discord.

**Fix:** Add config key `txtTurnDeleteEntryInvalidNumber`.

### BUG 6 — manageTurnActions.js:461 — hardcoded validation error (user-facing)
`'❌ Entry ID must be a positive integer.'` sent directly to Discord.

**Fix:** Add config key `txtTurnRestoreEntryInvalidId`.

---

## Hardcoded Strings Inventory

### Tier A — User-visible (must fix)

| File | Line | String | Resolution |
|------|------|--------|------------|
| storyadmin.js | 109 | `'Not set'` in `fieldVal`/`strVal` helpers | Use existing `cfg.txtNotSet` — load in setup cfg fetch |
| storyadmin.js | 122 | `'Disabled'` in roundup channel fallback | Use existing `cfg.txtOff` — load in setup cfg fetch |
| storyadmin.js | 511 | `'*(Age-restrict this channel if...)*'` | `txtSetupAgeRestrictNote` |
| storyadmin.js | 568 | `'ℹ️ No media channel set...'` | `txtSetupNoMediaNote` |
| storyadmin.js | 569 | `'ℹ️ No admin role set...'` | `txtSetupNoRoleNote` |
| storyadmin.js | 571 | `'ℹ️ Weekly roundup disabled.'` | `txtSetupRoundupDisabledNote` |
| manageUser.js | 25 | `'DM'` / `'Mention in channel'` notif labels | `txtNotifDM` / `txtNotifMention` |
| manageUser.js | 26 | `'Private'` / `'Public'` privacy labels | Use existing `cfg.txtPrivate` / `cfg.txtPublic` |
| manageUser.js | 42 | `'Switch to: Mention'` / `'Switch to: DM'` | `btnManageUserSwitchMention` / `btnManageUserSwitchDM` |
| manageUser.js | 43 | `'Make Public'` / `'Make Private'` | `btnManageUserMakePublic` / `btnManageUserMakePrivate` |
| manageUser.js | 224 | `'⏸️ Pause Writer?'` embed title | `txtAdminMUPauseConfirmTitle` |
| manageUser.js | 237 | `'▶️ Restore to Rotation?'` embed title | `txtAdminMUUnpauseConfirmTitle` |
| manageUser.js | 249 | `'⚠️ Remove Writer?'` embed title | `txtAdminMURemoveConfirmTitle` |
| manageUser.js | 362 | `'\n⚠️ Story auto-closed — no writers remain.'` | `txtAdminRemoveAutoClose` — keep concatenation, make text config-driven |
| manageTurnActions.js | 108 | `'Select the next writer...'` select placeholder | `txtTurnNextSelectPlaceholder` |
| manageTurnActions.js | 431 | `'Delete Turn [n] — [name]?'` embed title | `txtTurnDeleteEntryConfirmTitle` (template: `[turn_number]`, `[writer_name]`) |
| manageTurnActions.js | 433 | Restore-hint footnote in addFields value | `txtTurnDeleteEntryConfirmNote` |
| manageTurnActions.js | 439 | `'Delete Entry'` button label | `btnTurnDeleteEntryConfirm` |
| manageTurnActions.js | 440 | `'Cancel'` button label | Use existing `cfg.btnCancel` |
| manageEntries.js | 75 | `'More writers ([n]+)...'` pagination label | `txtManageEntriesMoreWriters` (template: `[offset]`) |
| manageEntries.js | 84 | `'Select a writer...'` placeholder | `txtManageEntriesWriterPlaceholder` |
| manageEntries.js | 107 | `'More entries ([n]+)...'` pagination label | `txtManageEntriesMoreEntries` (template: `[offset]`) |
| manageEntries.js | 113 | `'Select an entry...'` placeholder | `txtManageEntriesEntryPlaceholder` |
| manageEntries.js | 303 | `'[DELETED]'` status flag in entry label | `txtManageEntriesDeletedFlag` |
| manageEntries.js | 304 | `'*...entry continues*'` truncation marker | `txtManageEntriesContinued` |

### Keys already in config that can be reused (no new SQL):
- `txtNotSet`, `txtOff` (storyadmin.js setup fallbacks)
- `txtPrivate`, `txtPublic` (manageUser.js privacy labels)
- `btnCancel` (manageTurnActions.js delete confirm)

### Tier B — Deferred
- `storyadmin.js` setup save response `✅`/`⚠️`/`ℹ️` prefixes on each saved-settings line — emoji indicators in an admin-only ephemeral reply. Track in ux_roadmap.md.
- `manageUser.js` `?? 'fallback'` safety guards on cfg keys (lines 24, 35–38, 47–51, 57–58) — **remove entirely** per "Missing Config = Error" standard. All those keys are confirmed present in config_storyadmin.sql and loaded in the bulk fetch.

---

## Logging Gaps

### storyadmin.js
- `execute()` — no entry log. Add `{ show: false }` with subcommand + user.
- `handleHelp()` — no entry log.
- `handleDelete()` — no entry log.
- `handleDeleteConfirm()` — no entry log.
- `handleSetup()` lines 204/206 — `show: true` for routine panel-open milestones → change to `show: false`.

### manageUser.js
- Remove path (line 365): `postStoryThreadActivity` called fire-and-forget with `.catch(() => {})` — no failure log. Add `.catch(err => log(..., { show: true }))`.

### manageTurnActions.js
- `handleTurnActionConfirm()` — no entry log.
- `handleTurnActionModal()` — no entry log.

### manageEntries.js
- `handleManageEntriesButton()` — no entry log.
- `handleManageEntriesModal()` — no entry log.

---

## Config SQL Updates

New keys to add to `config_storyadmin.sql`:

```
txtManageUserPanelDesc
txtTurnExtendInvalidHours
txtTurnDeleteEntryInvalidNumber
txtTurnRestoreEntryInvalidId
txtSetupAgeRestrictNote
txtSetupNoMediaNote
txtSetupNoRoleNote
txtSetupRoundupDisabledNote
txtNotifDM
txtNotifMention
btnManageUserSwitchMention
btnManageUserSwitchDM
btnManageUserMakePublic
btnManageUserMakePrivate
txtAdminMUPauseConfirmTitle
txtAdminMUUnpauseConfirmTitle
txtAdminMURemoveConfirmTitle
txtAdminRemoveAutoClose
txtTurnNextSelectPlaceholder
txtTurnDeleteEntryConfirmTitle
txtTurnDeleteEntryConfirmNote
btnTurnDeleteEntryConfirm
txtManageEntriesMoreWriters
txtManageEntriesWriterPlaceholder
txtManageEntriesMoreEntries
txtManageEntriesEntryPlaceholder
txtManageEntriesDeletedFlag
txtManageEntriesContinued
```

`config_roadmap.md` manifest for `config_storyadmin.sql` must be updated with all new keys.

---

## User Decisions
- **`?? 'fallback'` guards in manageUser.js:** Remove entirely — all cfg keys are confirmed present.
- **`txtAdminRemoveAutoClose`:** Keep string concatenation; make the text itself config-driven. The note only appears when `isLastWriter` is true.

---

## Implementation Order

1. **Bugs first** — BUG 1 (`getInteger` → `getString`), BUG 2 (add `story_writer_id` to reassign fetch)
2. **Logging** — entry logs for `execute`, `handleHelp`, `handleDelete`, `handleDeleteConfirm`; fix `show:true` on setup panel logs; fix silent catch on `postStoryThreadActivity`; entry logs for `handleTurnActionConfirm`, `handleTurnActionModal`, `handleManageEntriesButton`, `handleManageEntriesModal`
3. **Tier A strings** — manageUser.js confirm titles + panel desc + notif/privacy labels + toggle buttons + remove fallbacks; manageTurnActions.js validation errors + deleteentry confirm strings; manageEntries.js pagination/placeholder strings; storyadmin.js setup notes + `txtNotSet`/`txtOff` reuse
4. **Config SQL** — add all new keys, load them in each function's bulk cfg fetch
5. **Roadmap** — update `config_roadmap.md` manifest; update `ux_roadmap.md` Silo 3 status

---

## Files to Modify
- [commands/storyadmin.js](commands/storyadmin.js)
- [story/manageUser.js](story/manageUser.js)
- [story/manageTurnActions.js](story/manageTurnActions.js)
- [story/manageEntries.js](story/manageEntries.js)
- [db/config_files/config_storyadmin.sql](db/config_files/config_storyadmin.sql)
- [db/config_roadmap.md](db/config_roadmap.md)
- [ux_roadmap.md](ux_roadmap.md)

## Files NOT Modified
- `story/tags.js` — audited in Silo 2; no new issues
- `story/roundup.js` — config-clean; scheduling logic only
- `story/addMetadata.js` — metadata/tags flow; no storyadmin-specific issues
