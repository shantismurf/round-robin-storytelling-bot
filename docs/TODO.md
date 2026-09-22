# To-Do List

Sorted quick wins to biggest lifts within each group — small, no-plan-needed items first,
tapering up to the fully-scoped efforts at the end of each section.

---

# Pending

- **`/storyadmin skip` / `close` / `pause` have no confirmation step at all** — per `docs/reference/ux_roadmap.md`'s flow map, these are "immediate actions; no confirm panel." Found 2026-08-21 during the help-system redesign entry-point audit. An admin can fat-finger `/storyadmin close` on the wrong story with no undo prompt. Every comparable action elsewhere in the bot (writer-side leave/pass/pause, `/story close`, story-manage save) has at least a confirm dialog, even if some of those dialogs also need better wording (see `/story close`'s confirm in [plans/PLAN-help-system-redesign.md](plans/PLAN-help-system-redesign.md)'s Entry-Point Audit) — these three have none.
- Extract a shared `wordCount` helper — the same `content.split(/\s+/).filter(w => w.length > 0).length` logic is currently duplicated across `_writeQuickMode.js`, `_storyStatus.js`, `export.js`, `read.js`, `close.js`, and `edit.js`. Once it exists, add the word count to the finalize embed footer.
- formatDuration sweep: apply to `story/_storyStatus.js` line 210 (`${turn_length_hours}h`) and `announcements.js` line 105 (`${turn_length_hours}h Turns`) — these are different UX contexts and need separate review before changing displayed format
- Code review: inline `.replace()` calls on config strings (replaceTemplateVariables compliance)
- Code review: Slow mode additions and End Turn Thread Preservation additions (project standard compliance)
- **Modal label radio groups:** Check Radio groups `.setRequired(false)` to see if we can remove any of the annoying "X Clear Selection" bars that take up a ton of space on mobile. On desktop they are unassuming little buttons, but the mobile interface for this is terrible.
- **[OPTIONAL CLEANUP] Flip `trimTrailingEmoji()` around to an append-based helper** — raised 2026-08-22 right after fixing a live bug where it silently ate the last letter off any label that didn't end in emoji (`Story Mode` → `Story Mod`, etc.; fixed by making it check first). The trim itself is fixed and tested now, so this isn't urgent — the concern is that the pattern (store a fully-bracketed "emoji Text emoji" value, then guess-and-strip the trailing emoji at ~18 inline call sites, while a handful of modal-label call sites use the raw un-stripped value directly) is the kind of implicit, easy-to-misuse convention that's likely to trip up a future pass on this code (agent or human) the same way it did today, even with the guard in place. Proposed direction: store the **plain** (leading-emoji-only) form as the canonical value for these ~18 labels, and add a small `appendTrailingEmoji()` helper for the handful of modal-label call sites that want the bracketed look — append can't corrupt existing text the way a mis-guessed trim can; worst case is a missing decorative emoji, not a chopped letter. Checked all current bracketed values first: 16 of the 18 are simple duplicate-emoji pairs (`⚠️ Warnings ⚠️`, `🛡️ Rating 🛡️`, etc.) and would migrate cleanly to "append a copy of the leading emoji." Two are **not** duplicates and can't use that shortcut — `lblMetaCharacters` (`🧑‍♂️ Characters 🧑‍♀️`, man/woman) and `lblDelayStart` (`🫷 Delay Start 🫸`, a deliberate push-left/push-right pairing) — those two would keep their trailing emoji stored explicitly and keep needing something trim-shaped, so `trimTrailingEmoji()` wouldn't fully disappear, just shrink from ~18 call sites to 2. Touches `utilities.js` (new helper), `db/config_files/config_story.sql`/`config_metadata.sql` (16 value edits), and the ~9 modal-label call sites across `story/_metadataModals.js`/`story/add.js`/`story/manage.js`.
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
- **[NEEDS RE-AUDIT — counts below are stale] File-size split pass** — line count audit taken 2026-07-12 after the Fable Audit step 5 session (which touched nearly every file in the codebase); `edit.js`'s entry got a partial update 2026-08-26 (see below) but the rest of this list wasn't re-measured against current `main` at the same time — e.g. `commands/_storyadminSetup.js` is listed at 509 below but is 614 as of 2026-08-26. Flagged 2026-08-26 as overdue for a full dedicated re-count, not opportunistic mid-other-work fixes. Six files were over the 500-line CLAUDE.md standard as of the original count, in priority order (`edit.js` and `utilities.js` are repeat offenders — both were already flagged in the original May Fable Audit and crept back over 500 despite partial shrinkage since):
  - **`story/edit.js` — partially split 2026-08-26 (704 lines, was 917 by then — file had grown further since this note's original 642 count, from the mention-display-text write-site change).** History/restore (`renderHistoryPage`, `handleRestoreConfirm`, `handleRestoreExecute`, plus their `handleEditButton` branches) moved to `story/_editHistory.js` (244 lines) via a single `handleEditHistoryButton` dispatcher, matching the `_manageClose.js` pattern. `edit.js` is still over 500 — the repost split into `story/_editRepost.js` (suggested in this note's original version) was not done this pass; `handleRepostEntry` plus the session-open/modal-submit/UI-builder core remain together. Revisit if it grows further.
  - **`story/_turn.js` (622 lines)** — the turn engine core; audit's Bucket 3 already identified this as "the single most valuable test/reuse seam in the codebase," so any split needs care not to fragment that. Natural seam: `PickNextWriter`/`NextTurn`/`turnEndTimeFunction` (pure selection + turn creation) vs. the thread-lifecycle helpers (`postStoryThreadActivity`, `deleteThreadAndAnnouncement`, `endTurnThread`, `endTurnGuarded`, `skipActiveTurn`, `closeStoryInternals`, `departWriter`) vs. the private notification helpers (`handleQuickModeNotification`, `handleWriterNotification`, `postWelcomeMessage`). Do this one last and most carefully of the six — re-read the Bucket 3 analysis in `audits/Fable_Audit_2026-07.md` first.
  - **`story/manage.js` (690 lines as of 2026-08-22 — was 593 after the initial Components V2 panel rework, grew further through this session's tab-reorder/header-hierarchy pass and the close-confirm V2 fix below)** — panel build (`buildManageMessage`, `handleManage`) vs. button routing (`handleManageButton`) vs. save/modal-submit (`handleManageSave`, `handleManageModalSubmit`). The save logic alone is substantial; could become `story/_manageSave.js`. Note: the close-confirm flow specifically was already extracted to `story/_manageClose.js` (2026-08-22, see the Components V2 item below) rather than added here, which is exactly this kind of split — a model for the rest of this entry when it's picked up.
  - **`commands/story.js` (540 lines)** — mostly a router (`execute`, `handleModalSubmit`, `handleButtonInteraction`, `handleSelectMenuInteraction`, `handleAutocomplete`); `handleAutocomplete` (line 345 to end, ~195 lines) is the biggest single chunk and is fairly self-contained — candidate to extract to `commands/_storyAutocomplete.js`.
  - **`utilities.js` (534 lines)** — a genuine grab-bag by design (per CLAUDE.md, "imported everywhere"), so splitting has less obvious payoff than the others, but the validators (`validateStoryAccess`, `validateActiveWriter`, `checkIsAdmin`, `checkIsCreator`) and the text/duration helpers (`sanitize`, `sanitizeModalInput`, `chunkEntryContent`, `splitAtParagraphs`, `parseDuration`, `formatDuration`, `replaceTemplateVariables`) are two clean, already-cohesive groups that could become `validators.js` and `textHelpers.js` if this file keeps growing.
  - **`commands/_storyadminSetup.js` (509 lines)** — barely over; lowest priority of the six. `handleSetupSave` (line 333 to end, ~230 lines) is most of the overage on its own.
  - **`story/add.js` (501 lines)** — crossed the line during the Components V2 panel rework; same shape as manage.js's split candidates (panel build vs. button routing vs. modal-submit) once this pass is picked up.
  - **Also now over 500** (not part of the original six, found 2026-08-22 while refreshing these counts — grew independently of the panel-rework work, not yet looked at for what pushed them over): `story/_manageTurnActions.js` (529, was 474), `commands/_myStoryList.js` (532, was 465).
- **Layer-2 integration test suite against a real DB** — proposed 2026-07-16 after discovering `CAST(JSON_EXTRACT(payload, '$.guildId') AS CHAR) = ?` had been silently matching zero rows in 5 job-cancellation call sites since 2026-05-11 (`scheduleNextRoundup`, `cancelPendingRoundupJobs`, `scheduleOnboardingReminders`, `closeOrphanedGuildStories`, `_writeSkip.js`'s thread-delete cancel — root cause: MySQL's `JSON_EXTRACT` returns the value still JSON-quoted, so the CHAR-cast comparison against an unquoted param never matches; fixed by swapping to `JSON_UNQUOTE(JSON_EXTRACT(...))`). The existing Layer-1 suite (`test/_fakeConnection.js`, a scripted-queue mock) structurally cannot catch this class of bug — it returns pre-scripted canned results regardless of the actual SQL text, so a syntactically-valid-but-semantically-wrong `WHERE` clause is indistinguishable from a correct one that legitimately matches nothing. Needs: a real MySQL instance for test runs (Docker-based MySQL or similar — schema uses MySQL-specific features like `JSON_EXTRACT`/`ON DUPLICATE KEY` that a SQLite substitute likely won't replicate faithfully), a seed SQL file mirroring `db/init.sql` plus representative rows, and a spin-up/teardown harness per test run. This would be a new Layer-2/integration tier, not a replacement for the existing fast dependency-free Layer-1 unit tests — those still cover pure logic well. Scope it as its own session; not a small addition.
- **Consolidate `/story close` onto Components V2, then delete `story/_manageClose.js`** — 2026-08-22: confirmed against Discord's docs that `IsComponentsV2` can never be removed once a message carries it ("Once a message has been sent with this flag, it can't be removed from that message"), which meant `/story manage`'s "Close Story" button couldn't safely reuse `story/close.js`'s shared `handleCloseConfirm`/`handleCloseCancel` (they reply in plain content/components, for the standalone `/story close` command). Fixed by forking a manage-panel-specific confirm flow into `story/_manageClose.js`, reusing `close.js`'s actual close logic (`closeStoryInternals`, `getStoryStats`, export-row build, thread-post, feed announcement — none of it reply-format-coupled) but not its reply formatting. This is intentionally temporary: once `close.js`'s `handleClose`/`handleCloseConfirm`/`handleCloseCancel` are themselves converted to Components V2 (bigger change, also touches the standalone command's UX), the manage panel should route back to those shared handlers directly and `_manageClose.js` should be deleted. Not urgent — the fork works correctly as-is, this is about removing duplication, not fixing a bug.
- `/story list` overhaul — see [plans/PLAN-story-list-overhaul.md](plans/PLAN-story-list-overhaul.md)
- Story Privacy (writer-only stories), create-only toggle — see [plans/PLAN-story-privacy.md](plans/PLAN-story-privacy.md) for full plan (thread-type constraints, modal layout, access-gate design, all resolved with user 2026-07-21). Not urgent — the story that prompted it was deleted instead of needing this fix.

---

# Deferred

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

- stpry efiting expansion: explore the idea of reordering turns,  think about how to make it clear to users how to add content to entries that hit the page limit, editing multi page entries requires skill and understanding of how the system works. 
- Add an export help page with Work Skin creation instructions — walk users through copying the `#workskin` CSS block from their exported HTML into an AO3 Work Skin so entry formatting (tooltips, scene breaks, subtext) matches on AO3.
- Series System — see [plans/PLAN-series-system.md](plans/PLAN-series-system.md)
- Reactions Kudos — see [plans/PLAN-reactions-kudos.md](plans/PLAN-reactions-kudos.md)
- Hub Sharing — full design in [plans/PLAN-hub-sharing.md](plans/PLAN-hub-sharing.md) and [plans/hub-brainstorming.md](plans/hub-brainstorming.md)
- Bulk per-user story management — let admins pause/resume (or otherwise act on) all of a user's stories in a server at once, instead of one story at a time via `/storyadmin user`. Raised 2026-07-20 alongside the member-departure redesign; not something anyone's asked for, no known multi-server usage yet.
- Block/ban feature — no way currently to block a specific user from joining stories in a server. Same origin as above.
- Guided first-run onboarding — raised 2026-08-22, purely a "think about later" idea, unscoped. Two variants floated: (1) the first time a guild runs `/story add`, offer a choice between the normal panel and a guided version broken into smaller steps with more inline explanation of each feature/option; (2) on first `/storyadmin setup`, offer a guided tour / dummy walkthrough instead. Would need its own plan file if picked up — not a small addition on top of the panel-rework/Components V2 work.
- Per-server concurrent story limit — raised 2026-09-22 during the new-admin onboarding review. Busy admins may want a cap on how many stories can run at once in their server, so a writing server doesn't accumulate a dozen half-dead threads competing for the same handful of writers. Unscoped; open questions are where the cap lives (a `cfgMaxConcurrentStories` guild config, presumably set in `/storyadmin setup`), what counts toward it (Active + Paused + Delayed, not Closed), what a blocked `/story add` tells a non-admin writer versus an admin, and whether an admin can override their own cap. Explore later.
- **Split `/storyadmin setup` into two permission tiers** — review alongside Part 2 (Ground Rules) of [plans/PLAN-panel-rework-and-ground-rules.md](plans/PLAN-panel-rework-and-ground-rules.md). Raised 2026-09-22. Today the two admin gates are different levels by design: `/storyadmin setup` checks Manage Server (`commands/_storyadminSetup.js:81`), while `/storyadmin user`/`delete`/`sweep`/`faqsync` check Administrator or an exact-name match on `cfgAdminRoleName` (`utilities.js:505-512`). That makes the story admin role effectively a moderator — it cannot reach anything on the setup panel. For the fields currently on that panel this is correct and worth keeping: `cfgAdminRoleName` is itself edited there, so letting the admin role run setup would let anyone holding it repoint the admin role at a role they control, i.e. a privilege escalation. The tension is that the panel bundles two risk classes. Escalation-capable (must stay at Manage Server): feed channel, media channel, both restricted channels, admin role name. Operationally boring (no escalation path, reasonable for a story admin): roundup channel/day/hour, changelog toggle — and **Ground Rules**, which is server-level vocabulary applied per story and is slated to become the 10th field on this same panel, so it would inherit the Manage Server gate by default. Do the split when there are enough tier-2 settings to justify it; Ground Rules is the first one that makes it actually matter.
