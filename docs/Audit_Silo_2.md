# Silo-Sprint Plan: Silo 2 — Story Management

## Context
Audit of all `/story` command files and their config SQL. Focus on bugs, hardcoded strings,
and logging gaps. The manage flow gets extra scrutiny per user request.

---

## Bug Findings (fix before anything else)

### BUG 1 — write.js:134 — `discordTimestamp` is undefined (CRITICAL)
The DM reminder sent 5 minutes after a user opens the write modal uses `discordTimestamp`
as a variable, but that name does not exist in scope. The correctly named variable is
`expiryTimestamp` (defined at line 123). This causes the DM to fail with a `ReferenceError`,
which is caught silently by the try-catch at line 135 — so the user never gets the reminder
and there is no error in the console.

**Fix:** Replace `discordTimestamp` → `expiryTimestamp` at write.js:134.

### BUG 2 — write.js:281 — `formattedDate()` not imported
`formattedDate()` is called inside a `throw new Error(...)` message (line 281) but is not
imported from utilities.js. On a DB miss for the entry, this throw itself will throw a
`ReferenceError`, masking the real error with a confusing one.

**Fix:** Remove `formattedDate()` from the throw message — plain string is fine there.
The surrounding `log()` call in the catch already timestamps output.

### BUG 3 — manage.js:45 — hardcoded `'Disabled'` in user-visible embed field
The `lblTimeoutReminder` embed field shows `'Disabled'` when `timeoutReminder === 0`.
This is a raw string literal in an embed sent to Discord users.

**Fix:** Replace with the existing config key `cfg.txtDisabled` (already in scope via the
`cfg` object loaded at the top of `buildManageMessage`). Confirm `txtDisabled` exists in
config — if not, add it to `config_story.sql` and `config_roadmap.md`.

### BUG 4 — manage.js:756 — routine modal entry logged at `show: true`
`handleManageModalSubmit` logs its entry with `{ show: true }`, meaning every modal submit
from the manage panel spams the production console. This is a logging tier violation per
CLAUDE.md — entry points use `show: false`.

**Fix:** Change `{ show: true }` → `{ show: false }` at manage.js:756.

### BUG 5 — manage.js:897 — `updateStoryStatusMessage()` fire-and-forget on tag approve, no log
After approving a tag, `updateStoryStatusMessage()` is called with `.catch(() => {})` and
no log. If it fails silently the status embed goes stale with no trace.

**Fix:** Add a `.catch(err => log(...))` so failures surface in the console.

---

## Hardcoded Strings Inventory

These are user-facing strings that must move to config. They are divided into two tiers:

### Tier A — Visible to end users in Discord (must fix)

| File | Line | String | Proposed Key |
|------|------|--------|--------------|
| manage.js | 45 | `'Disabled'` | `cfg.txtDisabled` (see Bug 3) |
| write.js | 45 | `'✍️ '` prefix on modal title | Embed in `txtWriteModalTitle` or prepend in config |
| join.js | 182 | `'Set AO3 Username'` (modal title) | `lblJoinSetAO3ModalTitle` |
| timeleft.js | 39 | `'*(hidden)*'` (authors hidden display) | `txtAuthorsHidden` |
| list.js | 52–56 | `'[G] General'`, `'[T] Teen'`, `'[M] Mature'`, `'[E] Explicit'`, `'[NR] Not Rated'` (filter options) | Already exist as `optRating*` keys in config_metadata.sql — wire them up |
| list.js | 295–296 | Same rating labels duplicated in `getStoriesPaginated` object literal | Same fix |
| close.js | 158 | `'✅'` alone as success response | `txtStoryCloseSuccess` |
| edit.js | 129 | `'📄 Entry split across pages'` (field name) | `lblEditPageSplitNotice` |
| edit.js | 129 | Multi-line edit instruction (field value) | `txtEditPageSplitInstructions` |
| edit.js | 141/146 | `'← Prev'` / `'Next →'` (nav buttons) | `btnEditPrev` / `btnEditNext` |
| edit.js | 155 | `'Edit'` (button label) | `btnEditOpen` |
| edit.js | 164 | `'History'` (button label) | `btnEditHistory` |
| edit.js | 211 | `'Entry content'` (modal field label) | `lblEditEntryContent` |
| edit.js | 215 | Character count placeholder | `txtEditChunkPlaceholder` |
| edit.js | 314–316 | Multi-page / single-page restore warnings | `txtEditRestoreWarningMulti` / `txtEditRestoreWarningSingle` |
| edit.js | 322/325 | `'← Newer'` / `'← Prev Page'` | `btnEditHistNewer` / `btnEditHistPrevPage` |
| edit.js | 330 | `'Restore This Version'` (button) | `btnEditRestore` |
| edit.js | 334/337 | `'Next Page →'` / `'Older →'` | `btnEditHistNextPage` / `btnEditHistOlder` |
| edit.js | 339 | `'← Back to Entry'` (button) | `btnEditBackToEntry` |
| edit.js | 355–356 | Restore confirmation messages | `txtEditRestoreConfirmSingle` / `txtEditRestoreConfirmMulti` |
| edit.js | 359 | `'Confirm Restore'` (embed title) | `txtEditRestoreConfirmTitle` |
| edit.js | 366/370 | `'Confirm Restore'` / `'Cancel'` (buttons) | `btnEditRestoreConfirm` / `btnEditRestoreCancel` |

### Tier B — UI chrome (icons, status indicators)

These are emoji/icon prefixes in status displays. The manage.js ones (lines 29–33) already
have a config fallback pattern (`cfg.txtManageStoryStatusPaused ?? '⏸️ ...'`), meaning if
the config key exists it is used. **Action:** Verify those four config keys exist in
config_storyadmin.sql and add them if missing. Leave the fallback emoji pattern in place as
a safe default — they are not hardcoded in the same sense since the config override works.

The list.js status icons (lines 313–317: `'🟢'`, `'⏸️'`, `'🏁'`, `'⏳'`) and the
read.js emoji prefixes on embed titles are lower priority and will be tracked in
`ux_roadmap.md` rather than fixed in this silo.

---

## Logging Gaps

### write.js — many missing entry logs
Add `{ show: false }` entry logs to:
- `handleWrite()` (line 10)
- `handleWriteModalSubmit()` (line 71, approx)
- `handleEntryConfirmation()` (line 223)
- `confirmEntry()` (line 248)
- `discardEntry()` (line 338)
- `handleViewLastEntry()` (line 366)
- `handleSkipTurn()` (line 841)
- `handleSkipConfirm()` (line 900)

Also: validation rejection paths in `handleWrite()` (lines 29–39) should log at
`{ show: false }` (user-facing rejections, not errors, but traceable).

Also: several existing logs in `doFinalizeEntry` and `handleFinalizeConfirm` use
`{ show: true }` for routine flow steps — change those to `{ show: false }`.

### manage.js — gaps
- `handleManageButton()` entry (line 279) — add `{ show: false }` entry log
- `handleManageSelectMenu()` entry (line 831) — add `{ show: false }` entry log  
- `handleTagReviewButton()` entry (line 859) — add `{ show: false }` entry log
- `handleReviewTags()` entry (line 459) — add `{ show: false }` entry log
- Tag approve/reject outcome (lines 887–907) — log action + tagText + storyId

### Other files
- `help.js` — add try-catch + entry log to `handleHelp()` and `handleHelpNavigation()`
- `ping.js` — add entry log and auth-rejection log to `handlePing()`
- `timeleft.js` — add entry logs to both handlers; log auth rejection; log `catch` at line 123
- `close.js` — add entry log; log auth rejection at lines 29–39
- `join.js` — log `postStoryFeedJoinAnnouncement()` failure instead of `.catch(() => {})`

---

## Config Roadmap Updates

- Add 2 keys missing from `config_metadata.sql` roadmap (they exist in SQL, just not documented)
- Add all new Tier A edit.js keys to `config_story.sql` and update `config_roadmap.md`
- Add `txtAuthorsHidden`, `lblJoinSetAO3ModalTitle`, `txtStoryCloseSuccess` to `config_story.sql`
- Confirm `txtDisabled` exists or add it

---

## Implementation Order

Because this silo has a lot of ground to cover, we will work in this order to ship functional
fixes before cosmetic ones:

1. **Bugs first** (write.js:134, write.js:281, manage.js:45, manage.js:756, manage.js:897)
2. **Logging** — write.js and manage.js entry/outcome logs; fix show:true overuse in write.js
3. **Tier A hardcoded strings** — edit.js (bulk), then join/timeleft/close/list
4. **Config SQL + roadmap updates** — add all new keys, update roadmap doc count
5. **Update ux_roadmap.md** — mark Silo 2 complete, note deferred Tier B items

---

## Files to Modify
- [story/write.js](story/write.js) — Bug fixes + logging
- [story/manage.js](story/manage.js) — Bug fixes + logging
- [story/edit.js](story/edit.js) — Bulk hardcoded string migration (largest change)
- [story/join.js](story/join.js) — Modal title + announcement log fix
- [story/timeleft.js](story/timeleft.js) — Hardcoded string + logging
- [story/close.js](story/close.js) — Success message + logging
- [story/list.js](story/list.js) — Rating label wiring
- [story/help.js](story/help.js) — Add try-catch + logging
- [story/ping.js](story/ping.js) — Logging
- [db/config_files/config_story.sql](db/config_files/config_story.sql) — New keys
- [db/config_roadmap.md](db/config_roadmap.md) — Updated manifest

## Files NOT Modified
- `story/read.js` — Tier B emoji items deferred; auth-failure logs are low risk
- `story/roundup.js` — Clean; word count comment is informational only
- `story/add.js` — Logging gaps are low priority; no bugs found
- `commands/story.js` — Router only; log coverage acceptable

---

## Verification
1. Run `/story write` on a quick-mode story — confirm DM reminder fires with correct timestamp text.
2. Run `/story manage` → set reminder to 0 → verify embed shows config-driven "Disabled" text.
3. Run `/story manage` → submit a title modal → confirm no `show:true` spam in console.
4. Run `/story edit` → confirm all buttons show config-driven labels.
5. Run `/story close` → confirm success reply uses config text not bare `✅`.
6. Run tag approve on a pending tag submission → confirm status message update failure surfaces as log.
7. grep `config_story.sql` for all new keys to confirm they are present.

---

## User Decisions
- **edit.js strings:** Fix all 20+ now in Silo 2. Add config keys to config_story.sql.
- **write.js modal title emoji:** Remove the `✍️ ` prefix entirely — no config key needed.
- **list.js rating labels:** Wire up existing `optRating*` keys. Make list builder async.
