# To-Do List

Top Priority - there is no message telling a user they have unsaved changes to the story manage panel. revisit the manage and ad panel redesign and add that to the plan. 

Sorted quick wins to biggest lifts within each group — small, no-plan-needed items first,
tapering up to the fully-scoped efforts at the end of each section.

---

# Pending

- **[TOP PRIORITY]** Manage Entries audit found truncated entries, a non-functional Restore button, and a Back button that fails silently with no log trail — see [plans/PLAN-manage-entries-consolidation.md](plans/PLAN-manage-entries-consolidation.md) for the full fix (rebuilds Manage Entries on top of the existing Edit engine) plus a bundled extension: an author-facing entry picker for `/story edit` when no turn number is given.
- Extract a shared `wordCount` helper — the same `content.split(/\s+/).filter(w => w.length > 0).length` logic is currently duplicated across `_writeQuickMode.js`, `_storyStatus.js`, `export.js`, `read.js`, `close.js`, and `edit.js`. Once it exists, add the word count to the finalize embed footer.
- formatDuration sweep: apply to `story/_storyStatus.js` line 210 (`${turn_length_hours}h`) and `announcements.js` line 105 (`${turn_length_hours}h Turns`) — these are different UX contexts and need separate review before changing displayed format
- Code review: inline `.replace()` calls on config strings (replaceTemplateVariables compliance)
- Code review: Slow mode additions and End Turn Thread Preservation additions (project standard compliance)
- **Modal label radio groups:** Check Radio groups `.setRequired(false)` to see if we can remove any of the annoying "X Clear Selection" bars that take up a ton of space on mobile. On desktop they are unassuming little buttons, but the mobile interface for this is terrible.
- Status post can go stale on turn-advance failure, not just on writer-status changes (found during independent review of the pause/resume status-refresh fix): `handlePanelPassConfirm` (pass-your-turn, `commands/_myStoryManage.js`) and the admin turn actions in `story/_manageTurnActions.js` (skip/reassign/next) call `NextTurn` and only log a warning if it fails — no fallback `updateStoryStatusMessage` call like the removal/pause/resume fixes now have. Same bug shape, different trigger (turn-advance failure rather than a writer-status change).
- Move Manage Users onto the story manage panel — folded into [plans/PLAN-panel-rework-and-ground-rules.md](plans/PLAN-panel-rework-and-ground-rules.md) (Part 1b) since it touches the same panel button rows as the Settings/Metadata split.
- **Fable Audit — remaining open items** (full completed-work writeup in [audits/Fable_Audit_Fix_Progress.md](audits/Fable_Audit_Fix_Progress.md); findings numbered in [audits/Fable_Audit_2026-07.md](audits/Fable_Audit_2026-07.md)):
  - 1.23 — message-fetch caps (`_writeFinalize.js`, `_turn.js`, limit 100/50) silently drop content past the cap on very long turns; needs `before`/`after` cursor pagination.
  - 2.4 — `job-runner.js` rebuilds a synthetic guild/role context per job even when several queued jobs target the same guild in one tick; needs per-tick context caching.
  - 1.14 — join capacity race: `handleJoinConfirm` (`join.js`) re-validates `max_writers` outside the transaction; needs the check moved inside (`SELECT ... FOR UPDATE` or a conditional INSERT).
  - `_writeSkip.js`'s `handleThreadDeleteNow` auth check (owner/creator/admin) is hand-rolled — a 4th near-duplicate of this pattern in the codebase; extract to a shared helper next time one of the ~3 other copies is touched.
  - `story/list.js`'s `getStoriesPaginated` param assembly (fixed prefix + dynamic filter params + fixed suffix across 3 separate queries) is fragile to eyeball — worth restructuring into one incrementally-built params array if the `/story list` overhaul below is picked up.
  - `_managePauseResume.js`'s story-level thread retitle (`applyPauseActions`/`applyResumeActions`/`handleReopenStory`) still uses inline `.replace()` instead of `replaceTemplateVariables` — covered by the standing inline-`.replace()` compliance sweep above, no separate item needed.

---

## Create style_roadmap.md

Establish a project style standard document and reference it from CLAUDE.md. Should define at minimum:
- **No emojis in buttons** — button labels are plain text only
- **Button colors** — use Discord ButtonStyle semantically: Success=green (active/positive), Secondary=gray (neutral/paused), Danger=red (closed/ended), Primary=blurple (call to action/joinable). Disabled state always renders gray regardless of style.
- **Mode icons** — 🟣 Quick · 🟢 Normal · 🔵 Slow (hardcoded UI chrome, not config strings)
- **Status icons** — 🟢 Active · ⏸️ Paused · ⏳ Delayed · 🏁 Closed (for titles/headers only, not inline text)
- **Emoji policy** — emojis permitted in embed titles, field names, and status headers; not in buttons or inline turn/stat text
- Any other visual conventions that emerge from feature work

---

## Help text review

Check for Missing or outdated info:

**Add to `/story help` page 2 (story creation options):**
- Restricted channel behavior for mature ratings (moving active thread in and out of restricted channel)

**Add `/story help` page 4 — Metadata & Tagging:**
- How metadata is used in exports
- How collaborative tagging works (writers submit, creator/admin reviews)
- What fields appear in the export

**Update `/storyadmin help`:**
- Add admin finalize capability (click Finalize Entry on behalf of stuck writer)

---

## Roundup formatting

- Roundup needs to show a system stat summary, then each active story in a block with selected metadata, then paused or delayed stories listed with title only
- user input needed for final formatting

---

- UX v3 Phases 3–5: `/storyadmin user` collapse, `/mystory manage` collapse + resume confirm, pending-indicator sweep.
- **[LOW PRIORITY] File-size split pass** — line count audit taken 2026-07-12 after the Fable Audit step 5 session (which touched nearly every file in the codebase). Not urgent; do as a dedicated session whenever it becomes worth it, not opportunistically mid-other-work like the Step 6 folds were. Six files over the 500-line CLAUDE.md standard, in priority order (`edit.js` and `utilities.js` are repeat offenders — both were already flagged in the original May Fable Audit and crept back over 500 despite partial shrinkage since):
  - **`story/edit.js` (642 lines)** — three fairly separable concerns: (1) edit-session open/modal-submit (`handleEdit`, `openEditSession`, `handleEditModalSubmit`), (2) history/restore (`renderHistoryPage`, `handleRestoreConfirm`, `handleRestoreExecute`), (3) repost (`handleRepostEntry`) + the shared `buildEditMessage`/`handleEditButton` UI. Likely split: keep open/modal-submit in `edit.js`, move history/restore to `story/_editHistory.js`, move repost to `story/_editRepost.js` (matches the existing `_*.js` submodule convention already used for write/manage/pause-resume).
  - **`story/_turn.js` (622 lines)** — the turn engine core; audit's Bucket 3 already identified this as "the single most valuable test/reuse seam in the codebase," so any split needs care not to fragment that. Natural seam: `PickNextWriter`/`NextTurn`/`turnEndTimeFunction` (pure selection + turn creation) vs. the thread-lifecycle helpers (`postStoryThreadActivity`, `deleteThreadAndAnnouncement`, `endTurnThread`, `endTurnGuarded`, `skipActiveTurn`, `closeStoryInternals`, `departWriter`) vs. the private notification helpers (`handleQuickModeNotification`, `handleWriterNotification`, `postWelcomeMessage`). Do this one last and most carefully of the six — re-read the Bucket 3 analysis in `audits/Fable_Audit_2026-07.md` first.
  - **`story/manage.js` (566 lines)** — panel build (`buildManageMessage`, `handleManage`) vs. button routing (`handleManageButton`) vs. save/modal-submit (`handleManageSave`, `handleManageModalSubmit`, `handleManageSelectMenu`). The save logic alone is substantial; could become `story/_manageSave.js`.
  - **`commands/story.js` (540 lines)** — mostly a router (`execute`, `handleModalSubmit`, `handleButtonInteraction`, `handleSelectMenuInteraction`, `handleAutocomplete`); `handleAutocomplete` (line 345 to end, ~195 lines) is the biggest single chunk and is fairly self-contained — candidate to extract to `commands/_storyAutocomplete.js`.
  - **`utilities.js` (534 lines)** — a genuine grab-bag by design (per CLAUDE.md, "imported everywhere"), so splitting has less obvious payoff than the others, but the validators (`validateStoryAccess`, `validateActiveWriter`, `checkIsAdmin`, `checkIsCreator`) and the text/duration helpers (`sanitize`, `sanitizeModalInput`, `chunkEntryContent`, `splitAtParagraphs`, `parseDuration`, `formatDuration`, `replaceTemplateVariables`) are two clean, already-cohesive groups that could become `validators.js` and `textHelpers.js` if this file keeps growing.
  - **`commands/_storyadminSetup.js` (509 lines)** — barely over; lowest priority of the six. `handleSetupSave` (line 333 to end, ~230 lines) is most of the overage on its own.
  - Also worth a light look when doing this pass (currently just under 500, likely to cross it next time they're touched): `story/_manageTurnActions.js` (474), `story/add.js` (471), `commands/_myStoryList.js` (465).
- **Layer-2 integration test suite against a real DB** — proposed 2026-07-16 after discovering `CAST(JSON_EXTRACT(payload, '$.guildId') AS CHAR) = ?` had been silently matching zero rows in 5 job-cancellation call sites since 2026-05-11 (`scheduleNextRoundup`, `cancelPendingRoundupJobs`, `scheduleOnboardingReminders`, `closeOrphanedGuildStories`, `_writeSkip.js`'s thread-delete cancel — root cause: MySQL's `JSON_EXTRACT` returns the value still JSON-quoted, so the CHAR-cast comparison against an unquoted param never matches; fixed by swapping to `JSON_UNQUOTE(JSON_EXTRACT(...))`). The existing Layer-1 suite (`test/_fakeConnection.js`, a scripted-queue mock) structurally cannot catch this class of bug — it returns pre-scripted canned results regardless of the actual SQL text, so a syntactically-valid-but-semantically-wrong `WHERE` clause is indistinguishable from a correct one that legitimately matches nothing. Needs: a real MySQL instance for test runs (Docker-based MySQL or similar — schema uses MySQL-specific features like `JSON_EXTRACT`/`ON DUPLICATE KEY` that a SQLite substitute likely won't replicate faithfully), a seed SQL file mirroring `db/init.sql` plus representative rows, and a spin-up/teardown harness per test run. This would be a new Layer-2/integration tier, not a replacement for the existing fast dependency-free Layer-1 unit tests — those still cover pure logic well. Scope it as its own session; not a small addition.
- `/story list` overhaul — see [plans/PLAN-story-list-overhaul.md](plans/PLAN-story-list-overhaul.md)
- Story Privacy (writer-only stories), create-only toggle — see [plans/PLAN-story-privacy.md](plans/PLAN-story-privacy.md) for full plan (thread-type constraints, modal layout, access-gate design, all resolved with user 2026-07-21). Not urgent — the story that prompted it was deleted instead of needing this fix.

---

# Deferred

## Address deprecated framework [deferred]
Update to a component-based approach using ActionRows. Instead of passing components directly, they must be wrapped in an ActionRowBuilder to ensure proper layout and compliance with current interaction API standards.

---

## turn reminder notifications — Request More Time button [deferred: requires scheduler]

The "Request More Time" button logic is implemented and working on `/story timeleft`. Adding it to reminder notifications requires the scheduler to store the message ID of each reminder sent, so the button can be edited/disabled after use.

When the scheduler is built:
- Store the message ID returned by `user.send()` / `channel.send()` with the job record
- On button click, retrieve and edit that message to disable the button
- Config keys and DB column (`more_time_requested` on `turn`) are already in place

---

## `app_permissions` on resolved interaction channels [deferred: blocked until discord.js exposes it]

Discord's API announcement (2026-07-16) said resolved channel objects in interactions now include an `app_permissions` field (bot's own perm bitfield in that channel), useful for permission pre-flight checks in `commands/_storyadminSetup.js`'s channel-select modals. Verified directly against source: not present as of `discord.js@14.27.0`/`discord-api-types@0.38.50` (latest stable) nor the latest `15.0.0-dev` nightly. Live-tested 2026-07-16 by logging `interaction.fields.resolved` on a real `storyadmin_setup_channels_modal` submission — confirmed the field is genuinely absent by the time our code sees it, because discord.js's `ModalSubmitInteraction` (`transformComponent`, `ModalSubmitInteraction.js:209`) runs every resolved channel through `client.channels._add()`, which rebuilds it into discord.js's own `GuildChannel` object model (cache-backed, with discord.js-native properties like `permissionOverwrites`/`rawPosition`) and discards whatever per-interaction fields Discord actually sent, including any `app_permissions`/`permissions`. So `interaction.fields.resolved` is not the raw wire payload — the true raw JSON would need to be read one level earlier, off the interaction's raw `data.data.resolved` before discord.js's transform runs (not yet checked; low priority since discord.js will likely just expose this properly once it ships support). Nothing to implement until discord.js adds it. Revisit by checking `node_modules/discord-api-types/payloads/v10/_interactions/base.d.ts` for `app_permissions` on `APIInteractionDataResolvedChannelBase`, and whether `ModalSubmitInteraction`/`ChannelSelectMenuInteraction` read it through. If picked up: `commands/_storyadminSetup.js` is the only file with both bot-permission checks and `ChannelSelectMenuBuilder` usage; today's only check is post-save in `handleSetupSave` via live `permissionsFor()`, after the code's own permission-overwrite mutation — any new early check from `app_permissions` would be a supplementary heads-up at channel-select time, not a replacement.

---

## DM support [deferred]

Full implementation plan extracted to [plans/PLAN-dm-support.md](plans/PLAN-dm-support.md).

---

# Future Features

- Add an export help page with Work Skin creation instructions — walk users through copying the `#workskin` CSS block from their exported HTML into an AO3 Work Skin so entry formatting (tooltips, scene breaks, subtext) matches on AO3.
- Series System — see [plans/PLAN-series-system.md](plans/PLAN-series-system.md)
- Reactions Kudos — see [plans/PLAN-reactions-kudos.md](plans/PLAN-reactions-kudos.md)
- Hub Sharing — full design in [plans/PLAN-hub-sharing.md](plans/PLAN-hub-sharing.md) and [plans/hub-brainstorming.md](plans/hub-brainstorming.md)
