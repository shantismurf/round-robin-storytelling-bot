# Plan: Manage Entries Consolidation into the Edit Engine

Status: Implemented
Created: 2026-08-05
Last Updated: 2026-08-05

Design decisions resolved with the user 2026-08-05 (full audit + design conversation); implemented same day. See Implementation Notes at the bottom for a few refinements made during the build that weren't in the original design.

---

## Context

`/story manage → Manage Entries` has three concrete bugs and a design mismatch, all confirmed by direct code reading (`story/_manageEntries.js`, `story/edit.js`, `story/_entryRenderer.js`, `commands/story.js`, `story/manage.js`):

1. **Truncation** — the entry preview embed (`_manageEntries.js:307-309`) hard-cuts content at 800 characters with a static "…continues" notice. It never uses the project's shared paging system (`story/_entryRenderer.js`), unlike Story Read and Story Edit, which both page through arbitrarily long entries in full.
2. **Restore confusion** — the "Restore" button in Manage Entries is a pure soft-delete/undelete toggle (`entry_status DELETED ↔ CONFIRMED`); it has no relationship to edit history. Meanwhile Story Edit has a *separate*, real "revert to a previous version" flow (`story_entry_edit` history browsing + restore), but it can never be used to undelete anything, because `openEditSession` (`edit.js:26-128`) hard-filters `entry_status = CONFIRMED` in both of its query paths — a deleted entry can never be loaded into an edit session. `handleRestoreExecute` (`edit.js:432-502`) even contains an already-written branch for flipping a DELETED entry back to CONFIRMED (lines 449-453) — but it's dead code today, unreachable, and buggy in its own right (it requires an `edit_id` to exist even though the DELETED branch doesn't use that row's content — an entry deleted before ever being edited has no `story_entry_edit` rows and could never be restored through it).
3. **Back button never responds** — `story_manage_entries_back`'s real handler (`_manageEntries.js:165-175`) does correctly `interaction.update(...)`, but nothing ever routes to it. `commands/story.js`'s button dispatcher special-cases `story_manage_entries_delete`/`_restore` by exact match, then sends everything else starting with `story_manage_` — including `_back` — to `handleManageButton` in `story/manage.js`, whose if/else chain (lines 230-407) has no case for it. The interaction falls through unacknowledged: no reply, no log, "didn't respond in time."
4. **Design mismatch** — Manage Entries filters by writer first, then entry, unlike Read/Edit which just list/page through entries directly. There's no good reason for the extra step, and it duplicates a "list entries" concept that already exists in two other forms.
5. **Compliance gaps** — one hardcoded label template (`_manageEntries.js:101`, not pulled from config), and logging density roughly half of its sibling `_manageTurnActions.js` (mostly missing success-path logs, only failure paths are logged).

**Decision:** rather than building a new, third parallel "admin entry viewer," Manage Entries becomes a thin entry-picker that hands off directly into the *existing* Story Edit session engine (`openEditSession` / `handleEditButton` / `renderHistoryPage` / restore-version flow in `story/edit.js`), which already has full paging, edit-history browsing, and version-restore logic. Two small, targeted additions to that engine (allow loading a DELETED entry in an admin context; add dedicated Delete/Restore/Back-to-list buttons) close the gap, instead of duplicating any of it. This matches the project's "reuse before you write" standard and eliminates the Back-button bug by construction (the new flow has one fewer `story_manage_entries_*` button customId, not more).

Restore-from-delete and revert-to-a-previous-version stay conceptually separate: undelete has nothing to do with content history and must not depend on a `story_entry_edit` row existing.

**Permission check correction:** `/story manage` (and therefore Manage Entries) is gated on `checkIsCreator(connection, storyId, userId) || checkIsAdmin(connection, interaction, guildId)` (`story/manage.js:123-124`) — being the story's creator (oldest active writer) is a completely separate check from Discord server admin permissions (`checkIsAdmin`, `utilities.js:441-448`, only checks server Administrator/admin-role). A non-admin story creator can legitimately reach Manage Entries. So the admin-mode gate inside `openEditSession` must check `isAdmin || isCreator`, not `isAdmin` alone, or a story creator would get walled out of the very feature they were let into.

**Second extension:** regular authors currently have no way to browse/pick from their own editable entries — `/story edit` requires typing an exact turn number, and the only other path is the contextual Edit button while using `/story read`. Since this plan is already building a flat, paginated entry-picker for admins, extending the same mechanism to authors (filtered to their own entries) is a natural, small addition, not a separate effort — see §2a and §3 below.

## Design

### 1. `story/edit.js` — extend the session engine for admin use

- `openEditSession(connection, interaction, guildId, storyId, turnNumber, entryId, options = {})` — add `options.allowDeleted` and `options.manageMode`. When `manageMode` is true (only ever passed by the new Manage Entries flow, entryId path only — turn-number path is untouched since deleted entries aren't numbered), relax the Path B query's status filter (currently `AND se.entry_status = ?` at line 47) to accept CONFIRMED or DELETED. Assert `isAdmin || isCreator` when `manageMode` is requested (import `checkIsCreator` from `utilities.js`, call with `storyId`/`userId` — matches the actual gate already used on the Manage Entries entry point, see the permission-check correction above; NOT `isAdmin` alone). Store `manageMode` and enough state to rebuild the picker (`listOffset`) on `pendingEditData`.
- `buildEditMessage(...)` — when `manageMode`, append to the button row:
  - **Delete** (`story_edit_manage_delete`) — shown/enabled only when `entry_status === CONFIRMED`. Flips to DELETED (same logic as today's `_manageEntries.js:361-377`).
  - **Restore** (`story_edit_manage_restore`) — shown/enabled only when `entry_status === DELETED`. Flips to CONFIRMED (same logic as today's `_manageEntries.js:378-393`). Independent of edit history — no `story_entry_edit` row required.
  These do not appear for ordinary `/story edit` sessions — `manageMode` is false there, so the view is unchanged for normal use.
- **Back to entries list** (`story_edit_backlist`) — a separate, non-admin-gated button: shown whenever the session was reached via *either* picker (admin Manage Entries or the new author picker, see §2a/§3), calling back into whichever `renderEntryListPage` variant matches the session's role. Kept generic (one customId, not two) since the only difference is which filtered list to rebuild, tracked in session state (§5).
- `handleEditButton` — add `else if` branches for the three new customIds above. All flow through the existing `startsWith('story_edit_')` catch-all already in `commands/story.js:279-280` for buttons — **no routing changes needed for these**, which is what makes this fix structural rather than a patch.
- `handleRestoreExecute` (lines 432-502) — simplify: remove the DELETED branch entirely (lines 449-453). It's superseded by the dedicated Restore button above, and was buggy (required an unused `edit_id`). This function goes back to doing one job: revert content to a specific historical version.
- Optional/recommended cleanup: `edit.js` is already 764 lines, over the project's ~500-line guideline, and this adds to it. Consider extracting the history-browsing block (`renderHistoryPage`, `handleRestoreConfirm`, `handleRestoreExecute`, roughly lines 334-502) into a new `story/_editHistory.js`, imported back into `edit.js`. This isn't required for correctness — flag as a separate follow-up if the diff should stay smaller (this also overlaps with the existing `docs/TODO.md` file-size-split item for `edit.js` — coordinate with that entry rather than duplicating the split).

### 2. New `story/_manageEntriesList.js` — the flat entry-list engine (shared by admin and author pickers)

- `fetchStoryEntries(connection, storyId, offset, limit, { authorUserId = null, includeDeleted = false } = {})` — one query, ordered by turn start time, computing `turn_number` via the same correlated-subquery pattern already duplicated across `read.js`/`edit.js`/`_manageEntries.js` (not worth fully unifying in this change — flag as a separate future cleanup). Paginated via LIMIT/OFFSET like today's Manage Entries (not "load everything into memory" like Read — admin/long-running stories could be large, and bounded queries are safer here).
  - Admin (Manage Entries) call: no `authorUserId` filter, `includeDeleted: true`.
  - Author (new `/story edit` picker, §2a) call: `authorUserId` set to the caller, `includeDeleted: false` (matches today's existing edit-eligibility rule — only CONFIRMED entries are editable).
- `renderEntryListPage(cfg, entries, hasMore, offset, { showAuthorName })` — builds the picker select-menu message. Row labels come from config-driven templates (see §6) instead of the current hardcoded string — `showAuthorName: true` for the admin list (cross-writer, needs the writer name per row), `false` for the author list (redundant, always the same writer).
- Kept in its own module (not inside `_manageEntries.js` or `edit.js`) specifically so `edit.js`'s new `story_edit_backlist` button can call `renderEntryListPage` directly (for either role) without creating a circular import between `edit.js` and `_manageEntries.js`.

### 2a. `/story edit` — optional `turn`, author entry picker

- `commands/story.js:147-150` — change the `turn` option to `.setRequired(false)`, update its description to note it can be left blank to pick from a list (exact wording pending approval).
- `handleEdit` (`edit.js:11-21`) — when `turnNumber` is `null` (option omitted), instead of calling `openEditSession` directly, call a new `renderEntryListPage`-backed reply listing the caller's own editable (CONFIRMED) entries via `fetchStoryEntries(connection, storyId, 0, PAGE_SIZE, { authorUserId: interaction.user.id })`. When a turn number is given, behavior is unchanged.
- New select-menu customId `story_edit_mypick_select` for this picker (pagination sentinel + real selection, same shape as the admin list's select). On a real pick, calls `openEditSession(connection, interaction, guildId, storyId, null, entryId)` — no `manageMode`/`allowDeleted`, so this is exactly today's existing Path B behavior (already used by Story Read's contextual Edit button), just reached via a new door. `isAdmin || isAuthor` inside `openEditSession` (already in place, lines 80-85) continues to gate actual access to that specific entry.
- Routing: `commands/story.js`'s select-menu dispatcher currently has no blanket `story_edit_` prefix case (only an exact match for `story_edit_jump`, line 336-337) — add `story_edit_mypick_select` as one more exact match there, routed into a new small handler in `edit.js` (or broaden the existing `story_edit_jump` case into a `startsWith('story_edit_') && endsWith('_select')` check that routes both into `handleEditButton`, which already knows how to branch on exact customId internally — recommended, since it's one less special case to maintain and future select-menus in this file won't repeat the Back-button bug's root cause of an incomplete enumeration).

### 3. `story/_manageEntries.js` — gutted down to a thin picker

Keeps: `handleManageEntriesButton` (open → `renderEntryListPage` page 1, admin variant), `handleManageEntriesSelectMenu` (pagination sentinel, or a real pick → calls `openEditSession(connection, interaction, guildId, storyId, null, entryId, { allowDeleted: true, manageMode: true })`).

Removed entirely: `fetchContributingWriters`, `buildWriterSelectMessage`, `fetchWriterEntries`, `buildEntrySelectMessage`, `handleManageEntriesModal` (filter modal gone), `handleManageEntriesActionButton` (delete/restore logic now lives in `edit.js`, see §1). File shrinks from 401 lines to roughly 90-120.

### 4. Routing changes

- `commands/story.js` modal dispatcher: remove the `story_manage_entries_filter_modal` case (no longer exists).
- `commands/story.js` button dispatcher: remove the exact-match special case for `story_manage_entries_delete`/`_restore` (gone — replaced by `story_edit_manage_delete`/`_restore`/`story_edit_backlist`, which need no new routing since they fall under the existing `startsWith('story_edit_')` branch).
- `commands/story.js` select-menu dispatcher: replace the `story_manage_entries_writer_select`/`_entry_select` exact matches with one for `story_manage_entries_list_select`; broaden the existing `story_edit_jump` exact match (line 336-337) into a `startsWith('story_edit_') && endsWith('_select')` check so it also catches the new `story_edit_mypick_select` (§2a) without a second special case.
- `commands/story.js` command option: `turn` becomes optional on the `edit` subcommand (§2a).
- `story/manage.js`: no change needed — `story_manage_entries_open`'s existing case (line 369-370, providing `storyId`/`title` from `pendingManageData`) stays exactly as-is; it's the one part of the old routing that was already correct.
- Net effect: after this change there is exactly one `story_manage_entries_*` button customId (`_open`), which already has a correct, working route. The Back-button bug class is eliminated by having fewer moving parts, not by patching the missed case.

### 5. Session state

Reuses `story/_state.js`'s existing Map pattern — no new pattern invented. `pendingEditData` (already exists) carries new fields: `manageMode` (bool, admin-only capabilities), and a `pickerContext` object (`{ role: 'admin' | 'author', listOffset }`) set whenever the session was reached via either picker rather than a direct turn number — this is what makes the generic `story_edit_backlist` button (§1) work for both roles from one customId. `_manageEntries.js` keeps its own small `pendingEntryData` map only for the admin list-browsing step (storyId, listOffset per user) — the writer filter is gone, so this shrinks considerably. The new author picker doesn't need its own session map — it reads straight from `fetchStoryEntries` on each interaction and only sets `pendingEditData` once an entry is actually opened via `openEditSession`, exactly like today's flow.

Note: `story/_state.js` already declares an unused `pendingViewData` (view-last-entry session) and `_entryRenderer.js` already reserves an unused `context: 'view'` / `story_view_*` prefix — both appear to be leftover scaffolding from an earlier, abandoned attempt at a separate admin viewer (confirmed via `docs/archive/draftsystem_roadmap.md:69`, the only other place `pendingViewData` is mentioned). This plan does not build on top of them, per the decision to reuse the Edit engine instead — flag them as candidates for removal in a future cleanup pass, not part of this change.

### 6. Config keys (`db/config_files/config_storyadmin.sql`) — draft, pending wording approval

**Retire** (writer-filter step and old bespoke preview no longer exist): `txtManageEntriesSelectWriter`, `txtManageEntriesFilterModal`, `lblManageEntriesFilterField`, `txtManageEntriesFilterPlaceholder`, `txtManageEntriesNoWriters`, `txtManageEntriesNoMatch`, `txtManageEntriesMoreWriters`, `txtManageEntriesWriterPlaceholder`, `txtManageEntriesPreviewTitle`, `txtManageEntriesPreviewFooter`, `txtManageEntriesContinued`.

**Reuse unchanged**: `btnManageEntries`, `txtManageEntriesEntryPlaceholder`, `txtManageEntriesDeletedFlag`, `btnManageEntriesDelete`, `btnManageEntriesRestore`, `btnManageEntriesBack` (now labels on the Edit view instead of the old preview), `txtManageEntryDeleteSuccess`, `txtManageEntryRestoreSuccess`, `txtManageEntryAlreadyDeleted`, `txtManageEntryAlreadyConfirmed`.

**Reuse, reworded** (no longer per-writer — needs sign-off on final copy): `txtManageEntriesSelectEntry` ("Select an entry to preview:" → something like "Select an entry to manage:"), `txtManageEntriesNoEntries` ("No entries found for this writer." → "No entries found for this story."), `txtManageEntriesMoreEntries` (offset wording still applies, no change needed).

**New keys needed** (exact wording to be approved before implementation, not decided in this plan):
- A config-driven replacement for the hardcoded label at `_manageEntries.js:101` — e.g. `lblManageEntriesEntryOption` = `Turn [turn_number] — [writer_name] — [word_count] words — [preview]` (writer name now needs to appear per-row since the list spans all writers).
- An author-facing equivalent without the writer name, e.g. `lblEditMyEntryOption` = `Turn [turn_number] — [word_count] words — [preview]`, used by the new `/story edit` picker (§2a).
- Prompt/empty-state text for the author picker, e.g. `txtEditMyEntriesSelect` ("Select an entry to edit:") and `txtEditMyEntriesNone` ("You have no editable entries in this story yet.") — distinct from the admin-facing `txtManageEntriesSelectEntry`/`txtManageEntriesNoEntries` since the audience/framing differs.
- A label for the new generic `story_edit_backlist` button, e.g. reuse `btnManageEntriesBack` ("Back") for both roles, or a more specific `btnEditBackToList` if wording distinct from `btnEditBackToEntry` (the existing "← Back to Entry" button used when closing the history view) is preferred.

### 7. Logging

Bring `_manageEntries.js`/`edit.js`'s new code up to the density already established in `_manageTurnActions.js`: a `show:false` entry log for every branch (open, list-select, list-page, delete, restore, backlist) covering the *success* path, not just the failure path (today's file only logs failures for most branches) — plus `show:true` on the actual state-changing actions (delete/restore), matching the existing pattern already used in `handleManageEntriesActionButton` today.

### 8. Tests

Only existing coverage in this area is `test/_entryRenderer.test.js` — nothing today covers `_manageEntries.js`, `edit.js`, or `_manageTurnActions.js`. New/updated tests (using `test/_fakeConnection.js`, no live DB/Discord):
- `test/_manageEntriesList.test.js` — `fetchStoryEntries` pagination, ordering, CONFIRMED+DELETED inclusion, and the `authorUserId`/`includeDeleted` filter combinations (admin vs. author call shapes).
- Updated coverage for `openEditSession`'s `allowDeleted`/`manageMode` branching (deleted entry loads only when both flags set and `isAdmin || isCreator`; ordinary `isAuthor`-only sessions still can't see deleted entries).
- Coverage for the new `handleEditButton` branches (delete/restore/backlist) — status-flip logic and the guard conditions (Delete only when CONFIRMED, Restore only when DELETED, backlist rebuilds the correct list for each `pickerContext.role`).
- Coverage for `/story edit` with `turn` omitted — resolves to the author picker filtered to the caller's own entries, not someone else's.

### 9. Docs

Update `docs/reference/ux_roadmap.md` (Manage Entries flow description, and the new `/story edit` no-turn picker flow), `docs/reference/system_roadmap.md` (file inventory: `_manageEntries.js` description, new `_manageEntriesList.js` entry, updated `edit.js` description), `docs/reference/config_roadmap.md` (key manifest changes from §6). Per the Help Sync Rule, check whether any `txtHelp*` config keys describe `/story edit`'s current required-turn behavior and update them to mention the optional picker. Also update `docs/INDEX.md`'s plans table when this plan's status changes.

### Versioning

This is a MINOR-level change under the project's versioning policy (meaningfully affects reliability/UX, touches several files) — propose the bump with reasoning for sign-off once implemented; do not apply it unilaterally.

## Build order

1. New `story/_manageEntriesList.js`: `fetchStoryEntries` + `renderEntryListPage` (both roles).
2. `story/edit.js`: extend `openEditSession` (`allowDeleted`/`manageMode`, corrected `isAdmin || isCreator` check), `buildEditMessage` (Delete/Restore/generic Backlist), `handleEditButton` (new branches), simplify `handleRestoreExecute`; wire the `turn`-omitted picker path into `handleEdit`.
3. Gut `story/_manageEntries.js` down to the thin admin picker.
4. Update routing in `commands/story.js` (remove/replace dispatch entries as in §4, make `turn` optional).
5. Config changes in `db/config_files/config_storyadmin.sql` (after wording approval — §6).
6. Logging pass across all touched handlers.
7. Tests.
8. Docs sync (`ux_roadmap.md`, `system_roadmap.md`, `config_roadmap.md`, `INDEX.md`).

## Verification

- `npm install && npm test` — new/updated unit tests pass, no regressions in `test/_entryRenderer.test.js`.
- Push to main, restart the bot (per `docs/reference/HOSTING.md` — no local/staging execution is possible), then manually walk the golden path in Discord:
  - **Admin side**: `/story manage` → Manage Entries → list appears (no writer step) → pick a long entry → confirm full text pages correctly (no truncation) → Delete → confirm status flips and buttons update → Restore → confirm undelete works even on an entry with no edit history → Back to list → confirm it actually returns (no timeout) → browse edit history on an entry that has some → confirm version-restore still works unchanged. Repeat as a non-admin story creator to confirm the corrected `isAdmin || isCreator` check doesn't wall them out.
  - **Author side**: `/story edit story_id:<id>` with no `turn` given → picker of your own entries appears → pick one → same paging/edit/history experience as before → Back to list returns to your picker (not the admin one) → confirm no Delete/Restore buttons appear. `/story edit story_id:<id> turn:<n>` still works unchanged.

## Implementation Notes (added after building)

A few things changed shape between design and build, all discovered by writing it and its tests:

- **No browse-session map after all.** §5 proposed a small `pendingEntryData` map in `_manageEntries.js` to carry `storyId`/`listOffset` across the open→paginate→pick flow. Building it made clear that's unnecessary: `storyId` is threaded directly through the select menu's customId (`story_manage_entries_list_select_<storyId>` / `story_edit_mypick_select_<storyId>`), the same stateless pattern already used everywhere else in this codebase for IDs riding along on customIds. Both pickers are now fully stateless until an entry is actually opened via `openEditSession`.
- **Found and fixed a real 25-option overflow bug** while writing `_manageEntriesList.test.js`: pagination as originally coded (in this plan, and identically in the *old* `_manageEntries.js` it replaces) sliced to `ENTRY_PAGE_SIZE` (25) real entries and then unconditionally pushed a "more" sentinel on top, giving up to 26 options — over Discord's 25-option select-menu cap, which throws. Fixed by reserving one slot (`ENTRY_PAGE_SIZE - 1` real entries whenever a sentinel is being added). Worth a mental note that the pre-existing writer/entry pickers this replaces likely had the same latent crash on any story with more than 25 matching rows.
- **`handleRestoreExecute` (revert-to-a-version) now always leaves the entry CONFIRMED**, not just when it wasn't DELETED. The original plan just said "drop the DELETED branch" but didn't work through that a version-restore on a still-deleted entry would otherwise silently do nothing visible — reverting content while leaving it soft-deleted is a confusing dead end. So the single remaining code path both archives+overwrites content and sets `entry_status = CONFIRMED` unconditionally (harmless no-op if already confirmed).
- **`handleRestoreConfirm`'s confirmation text** no longer branches on DELETED status either, for the same reason — it always shows the "this replaces your current content" warning now. `txtEditRestoreConfirmSingle` (the DELETED-specific wording) is retired as a result.
- **Manage-mode permission check** ended up needing `checkIsCreator` imported into `edit.js` (it wasn't there before) — confirmed via direct code reading that `checkIsAdmin` and story-creator status are unrelated checks, and Manage Entries' actual gate (`story/manage.js:123-124`) is `isAdmin || isCreator`, not `isAdmin` alone.
- **Test coverage lands on `_manageEntriesList.js` only** — the new module is pure/DB-only and fits the project's existing Layer-1 testing pattern (`test/_fakeConnection.js`, no live Discord). The new branches inside `edit.js` (delete/restore/backlist button handlers, `openEditSession`'s manageMode gate) all take a live `interaction` object and aren't unit-testable without diverging from how the rest of this codebase tests things — no existing test file in this repo mocks a Discord interaction. These are covered by the manual verification steps above instead, consistent with `edit.js`'s existing (untested) history/restore-version code.
- **Help text synced.** `config_help.sql`'s `txtHelp6Edit`/`txtHelp7StoryCommands` and `docs/help/faq-page-4-writer-commands.md` now describe `/story edit [id] (turn)` — turn optional, opens that entry directly if given, or shows a picker of the caller's entries if omitted. (`txtHelp3WhatEdit` in `faq-all-pages-sql.md` was left alone — it never implied turn was required.) Wording approved by the user before applying.
- **Pre-existing, out-of-scope items noticed but not touched**: `txtEditRestoreWarningMulti`/`txtEditRestoreWarningSingle` are fetched into `editCfg` in both `edit.js` and `read.js` but appear to have been dead (never read off the object) before this change too — left alone since fixing it wasn't part of what was asked. `story/_manageTurnActions.js`'s duplicate delete/restore-by-ID modal flow (a manually-typed-ID equivalent of what Manage Entries' browse UI now covers with a friendlier picker) was intentionally left as-is — out of scope for this plan, which was about Manage Entries specifically.
