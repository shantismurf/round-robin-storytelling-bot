# To-Do List

- Fable Audit fixes — see [docs/Fable_Audit_2026-07.md](docs/Fable_Audit_2026-07.md) "Suggested Fix Order" and [docs/Fable_Audit_Fix_Progress.md](docs/Fable_Audit_Fix_Progress.md) for full detail on what steps 1-3 actually touched.
  - **Steps 1-3: DONE 2026-07-10**, all in one session on branch `fable-audit/steps-1-3` (3 commits — PR/merge pending). Step 3 (rating-barrier sweep) grew well beyond its 4 named findings — see the Fix Progress doc's "Scope expansion" section for the full list of ~15 additional call sites fixed (the primary entry-write flow itself had the same bug, plus reopen/close/join/ping/request-more-time/turn-reminders/resume-notifications, plus a separate feed-channel-routing bug in the closed-story announcement).
  - **NOT YET VERIFIED AT RUNTIME.** Syntax-checked and carefully traced against the schema, but never run against a live Discord connection or exercised against the real DB — the hosted bot instance was live during this session so a second connection wasn't safe, and there's no separate test guild/token. Before trusting this in production: watch migration 021 apply cleanly on the next deploy, and manually exercise at least: quick-mode write + finalize on a restricted (M/E) story (confirm the entry posts to the restricted thread), a finalize/timeout race if reproducible, and closing a story that has both a restricted and unrestricted thread.
  - **New pre-existing bug found, NOT fixed (out of scope):** `loadConfig()` in `utilities.js` can't resolve `config.json` when run directly via `node` on Windows (`import.meta.url`'s `/C:/...` pathname breaks `path.resolve`). Only matters for local Windows dev/testing, not the Linux-hosted production bot — but blocked local DB verification this session.
  - **Step 4: DONE 2026-07-12**, branch `claude/fable-audit-next-steps-fbfult` (3 commits: `ea037af`, `cb30366`, `ea1cc96`). Closed 1.7, 1.17, 1.41, 1.42, and the `_writerDeparted.js` 6-site consolidation together (per the sequencing decision below), plus 1.10(a)/(c) — NextTurn's result is now checked at all 16 call sites, with a hub-log alert on failure instead of a silent stall. Full detail (including a bonus fix found mid-sweep: `_writeSkip.js`'s `handleSkipConfirm` had an unguarded turn-end UPDATE that step 2 missed entirely) in the Fix Progress doc's "Step 4" section. **Deliberately deferred, unchanged from the original plan:** the actual 1.10(b)/1.12 advanceTurn/notifyTurn DB/Discord split — still belongs with Phase 2 web-interface planning, not a quick pass. **NOT YET RUNTIME-VERIFIED** — same constraint as steps 1-3, no isolated test guild/DB available.
  - **Step 4 reviewed and merged to main 2026-07-12** via PR #18 (merge commit `7914e58`) — independent fresh-session code review at high effort came back clean, no correctness findings. Still not runtime-tested; the reviewer flagged one behavior change worth eyeballing on the next live redeploy: admin-remove, panel pass/pause, and last-writer departures now 24h-preserve the writer's draft thread (with a Delete Now button) instead of deleting it immediately — that's the intended 1.41 fix, but it's the most visible user-facing difference.
  - **Step 5: DONE 2026-07-12**, branch `fable-audit/step-5`. Full detail in the Fix Progress doc's "Step 5" section. Closed: the constants module (`constants.js`, closes LOGIC_ERRORS #11) swept across all 33 files / 291 occurrences per user approval; docs sync (4.1 system_roadmap.md file inventory, 4.2 CLAUDE.md architecture section — user provided final wording); retired LOGIC_ERRORS_REPORT.md (superseded-by note, not deleted); the Layer-1 test harness (4.5) — 6 files, 56 tests, `npm test` now runs `node --test "test/**/*.test.js"`; dead-code deletion (4.10/1.29) — `utilities.createThread`/`sendUserMessage`, the dead `StoryBot`/`emitPublish`/`bot.on('publish')` EventEmitter scaffolding, `storyadmin.js`'s unregistered `handleModalTest`, `_manageUser.js`'s unused staged-field/config-key pair. Also closed as opportunistic Step 6 folds while those files were open anyway: **1.18** (added an optional `[status]` token to `txtTurnThreadTitle` so paused turn threads actually show a paused marker — was silently hardcoding `'PAUSED'` against a nonexistent token), **1.54** (inline `.replace()` → `replaceTemplateVariables` in `_manageUser.js` and `_writeSkip.js`; `read.js`'s `log()` array-misuse), the step-4-code-review's `closeStoryInternals` inline-`.replace()` cleanup item, and **1.15** (`_writeSkip.js`'s `handleThreadDeleteNow` had zero authorization check — now gated to draft owner/creator/admin). One stale TODO item dropped: `StoryJoin`'s `dmMessage` cleanup item from the step-4 review turned out to be a false positive (it's computed, not hardcoded) — re-verified and removed from scope.
  - **NOT YET RUNTIME-VERIFIED** — same constraint as every prior step, no isolated test guild/DB available this session. `node --check` clean on all 35 touched `.js` files + `constants.js` + 6 new test files; full Layer-1 suite 56/56 passing. Given the file count, prioritize a close look at `story/list.js`'s pagination/filter queries and `_managePauseResume.js`'s pause/resume thread-retitle behavior on the next live check — those had hand-caught bugs mid-sweep (a real SQL param-count mismatch in list.js, and the 1.18 rewrite) that are exactly the kind of thing that's easy to miss without a live DB.
  - **Step 6 reassessed 2026-07-12 after step 5:** 1.23 (message-fetch caps in `_writeFinalize.js`/`_turn.js`) and 2.4 (job-runner per-job context rebuild) were approved for step 5's scope but not reached — the constants sweep took longer than planned once gaps in two delegated sweep passes had to be manually found and closed (a live SQL param-count bug and ~10 missed literals across the codebase, found via progressively broader grep sweeps after the "first pass" looked done). Both remain open, self-contained, no dependency on anything else — fine to pick up standalone whenever.
  - **Still open, not folded into any step yet:** 1.14 (join capacity race — standalone fix, unrelated code path, fine any time).
  - **User-flagged bug fixed 2026-07-12 (not from the audit):** the writer-join panel (pen name/privacy/notification selects + confirm/cancel) posted publicly to the whole channel instead of ephemerally when triggered via the "Join" button (story feed/thread panel) — only the `/story join` slash command was ephemeral. `story/join.js`'s `handleJoin` now always replies ephemeral; the now-pointless `isThreadMode`/`threadMode` distinction (which only existed to pick between two cancel-button behaviors) was removed from `buildJoinEmbed`/`handleJoin`/the join state object, and `commands/story.js`'s `story_join_thread_cancel_` branch (a raw `message.delete()`) is gone in favor of always using the ephemeral `story_join_cancel_` path. This also fully closes audit finding **1.58** (same button, different bug — unacknowledged interaction before delete) since that code path no longer exists. Full detail in the Fix Progress doc's "Step 5" section, item 7.
  - **Independent code review (fresh agent, high effort) run 2026-07-12 before merging step 5 to main** — 8 finder angles, 23 raw candidates, verified down to 7. Caught and fixed 2 real issues the session missed:
    - `commands/_myStoryList.js`'s paused-view query: the constants sweep had changed a harmless literal `story_status IN (0, 2, 4)` (where `0` was always dead — no code path or migration ever writes it) into binding `STORY_STATUS.ACTIVE` for that slot, which would have leaked every active story into `/mystory list paused`. Fixed by removing the dead `0` entirely (not remapping it to a constant) — a bare unnamed `0` literal was judged more likely to mislead a future agent into "fixing" it back to a real status than to be self-evidently a no-op, so the cleaner move was deleting it outright now that its dead status is fully confirmed.
    - `story/read.js`: this session's own Step 5 documentation (Fix Progress doc + TODO.md) claimed the `log(msg, ['', guildId])` array-misuse (three call sites) was fixed as part of the 1.54 fold-in — it was not actually fixed, only documented as fixed. Caught by the review comparing the diff against the doc's claim. Now actually fixed to `{ show: false, guildName }`.
    - **Lesson:** verify doc claims against the actual diff before trusting a session's own "done" notes, including this session's — a documented fix and an applied fix are not the same thing.
  - **Outstanding non-blocking findings from that review, not fixed (pre-existing debt or minor, none are regressions from step 5):**
    - `story/_managePauseResume.js` (`applyPauseActions`/`applyResumeActions`/`handleReopenStory`, lines ~64/100/~225ish) retitle the **story-level** thread via inline `.replace()` chains on `txtStoryThreadTitle` instead of `replaceTemplateVariables` — confirmed via `git diff` these exact lines are untouched by step 5 (pre-existing, not a regression; distinct from the turn-level `txtTurnThreadTitle` 1.18 fix step 5 did make). Already covered by the standing "inline `.replace()` compliance sweep" TODO item below — no new item needed, just noting it surfaced again here.
    - `story/_writeSkip.js`'s new `handleThreadDeleteNow` authorization check (added this session for 1.15) hand-rolls owner/creator/admin logic inline rather than calling a shared helper — correct as written, but a fourth near-duplicate of this authorization pattern in the codebase. Worth extracting to a shared helper (e.g. in `utilities.js`) next time any of the ~3 other inline copies gets touched, not urgent enough for its own session.
    - `story/list.js`'s `getStoriesPaginated` params assembly (fixed prefix + dynamic filter params + fixed suffix across 3 separate query executions) is fragile to eyeball — no current bug (re-verified placeholder-vs-param counts match for all 4 filter branches), but it's the same file/pattern that produced a real param-count bug earlier in step 5. If this function is touched again, consider restructuring to build one params array incrementally alongside the WHERE clause (like `_myStoryList.js`'s `fetchStoriesForView` mostly does) rather than three separately-assembled arrays.
    - `story/ping.js`'s `sw_status IN (?, ?)` vs `= ?` ternary (both the SQL-string ternary and the params-array ternary must stay in lockstep) is minor readability debt, no bug.
    - `story/_managePauseResume.js` issues 2-3 sequential `getConfigValue` calls per pause/resume/reopen action that could batch into the array form per audit finding 2.3 — pre-existing pattern (Promise.all already makes them concurrent, just not a single round-trip), low priority.
- **Restricted-guild policy — DECIDED 2026-07-10, IMPLEMENTED** (audit 1.39/5.12): if no restricted channel is configured, all stories (including M/E) go in the main feed; ratings are informational-only. `story/manage.js` skips thread migration when moving into restricted with no restricted channel configured (moving back out still migrates normally); `getActiveThreadId` routing now applied consistently across all known story-thread-posting call sites.

- [x] Story Info Modal implementation (see plan: im-trying-to-run-resilient-candy.md)
  - [x] Config SQL: rename/add/delete keys (config_story, config_storyadmin, config_help, config_turn)
  - [x] `_metadataModals.js`: add `buildStoryInfoModal()`, update `getMetaCfg()`, fix Show Authors embed field
  - [x] `add.js`: new row layout, remove toggle handlers, add storyinfo modal handler, rename `state.hideThreads` → `state.storyTurnPrivacy`
  - [x] `manage.js`: new row layout, remove toggle handlers, add storyinfo modal handler, joins button logic flip
  - [x] Config roadmap sync
  - [x] Variable rename: `story.story_turn_privacy` → `storyTurnPrivacy`; `story_writer.turn_privacy` → `writerTurnPrivacy` across all JS files

- Roundup formatting
- Help text review
- Code review: Slow mode additions and End Turn Thread Preservation additions (project standard compliance)
- Code review: inline `.replace()` calls on config strings (replaceTemplateVariables compliance)
- Create `style_roadmap.md` and link from CLAUDE.md
- `/story list` overhaul — see [docs/PLAN-story-list-overhaul.md](docs/PLAN-story-list-overhaul.md)
- formatDuration sweep: apply to `story/_storyStatus.js` line 210 (`${turn_length_hours}h`) and `announcements.js` line 105 (`${turn_length_hours}h Turns`) — these are different UX contexts and need separate review before changing displayed format
- UX v3 Phases 3–5: `/storyadmin user` collapse, `/mystory manage` collapse + resume confirm, pending-indicator sweep (see plan file)
- Move Manage Users (currently the `/storyadmin manage-user` slash command, `story/_manageUser.js`) onto the story manage panel as a "Manage Users" button, loading a two-step modal instead of a standalone command.
- Status post can go stale on turn-advance failure, not just on writer-status changes (found during independent review of the pause/resume status-refresh fix): `handlePanelPassConfirm` (pass-your-turn, `commands/_myStoryManage.js`) and the admin turn actions in `story/_manageTurnActions.js` (skip/reassign/next) call `NextTurn` and only log a warning if it fails — no fallback `updateStoryStatusMessage` call like the removal/pause/resume fixes now have. Same bug shape, different trigger (turn-advance failure rather than a writer-status change).
- Export: "Show Names" controls the entire turn-break header (turn number + name), so exporting with breaks but `show_authors = false` produces no header at all — not even a turn number. Decouple: turn numbers should always show when breaks are enabled; "Show Names" should only toggle whether the writer name is included.
- **[LOW PRIORITY] File-size split pass** — line count audit taken 2026-07-12 after the Fable Audit step 5 session (which touched nearly every file in the codebase). Not urgent; do as a dedicated session whenever it becomes worth it, not opportunistically mid-other-work like the Step 6 folds were. Six files over the 500-line CLAUDE.md standard, in priority order (`edit.js` and `utilities.js` are repeat offenders — both were already flagged in the original May Fable Audit and crept back over 500 despite partial shrinkage since):
  - **`story/edit.js` (642 lines)** — three fairly separable concerns: (1) edit-session open/modal-submit (`handleEdit`, `openEditSession`, `handleEditModalSubmit`), (2) history/restore (`renderHistoryPage`, `handleRestoreConfirm`, `handleRestoreExecute`), (3) repost (`handleRepostEntry`) + the shared `buildEditMessage`/`handleEditButton` UI. Likely split: keep open/modal-submit in `edit.js`, move history/restore to `story/_editHistory.js`, move repost to `story/_editRepost.js` (matches the existing `_*.js` submodule convention already used for write/manage/pause-resume).
  - **`story/_turn.js` (622 lines)** — the turn engine core; audit's Bucket 3 already identified this as "the single most valuable test/reuse seam in the codebase," so any split needs care not to fragment that. Natural seam: `PickNextWriter`/`NextTurn`/`turnEndTimeFunction` (pure selection + turn creation) vs. the thread-lifecycle helpers (`postStoryThreadActivity`, `deleteThreadAndAnnouncement`, `endTurnThread`, `endTurnGuarded`, `skipActiveTurn`, `closeStoryInternals`, `departWriter`) vs. the private notification helpers (`handleQuickModeNotification`, `handleWriterNotification`, `postWelcomeMessage`). Do this one last and most carefully of the six — re-read the Bucket 3 analysis in `docs/Fable_Audit_2026-07.md` first.
  - **`story/manage.js` (566 lines)** — panel build (`buildManageMessage`, `handleManage`) vs. button routing (`handleManageButton`) vs. save/modal-submit (`handleManageSave`, `handleManageModalSubmit`, `handleManageSelectMenu`). The save logic alone is substantial; could become `story/_manageSave.js`.
  - **`commands/story.js` (540 lines)** — mostly a router (`execute`, `handleModalSubmit`, `handleButtonInteraction`, `handleSelectMenuInteraction`, `handleAutocomplete`); `handleAutocomplete` (line 345 to end, ~195 lines) is the biggest single chunk and is fairly self-contained — candidate to extract to `commands/_storyAutocomplete.js`.
  - **`utilities.js` (534 lines)** — a genuine grab-bag by design (per CLAUDE.md, "imported everywhere"), so splitting has less obvious payoff than the others, but the validators (`validateStoryAccess`, `validateActiveWriter`, `checkIsAdmin`, `checkIsCreator`) and the text/duration helpers (`sanitize`, `sanitizeModalInput`, `chunkEntryContent`, `splitAtParagraphs`, `parseDuration`, `formatDuration`, `replaceTemplateVariables`) are two clean, already-cohesive groups that could become `validators.js` and `textHelpers.js` if this file keeps growing.
  - **`commands/_storyadminSetup.js` (509 lines)** — barely over; lowest priority of the six. `handleSetupSave` (line 333 to end, ~230 lines) is most of the overage on its own.
  - Also worth a light look when doing this pass (currently just under 500, likely to cross it next time they're touched): `story/_manageTurnActions.js` (474), `story/add.js` (471), `commands/_myStoryList.js` (465).

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

## Roundup formatting

- Roundup needs to show a system stat summary, then each active story in a block with selected metadata, then paused or delayed stories listed with title only
- user input needed for final formatting

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


# Deferred Items

| — | *Deferred: Turn reminder notifications (Request More Time)* | 
| — | *Deferred: Address deprecated ActionRow framework* | 
| — | *Deferred: DM support* | 

## turn reminder notifications — Request More Time button [deferred: requires scheduler]

The "Request More Time" button logic is implemented and working on `/story timeleft`. Adding it to reminder notifications requires the scheduler to store the message ID of each reminder sent, so the button can be edited/disabled after use.

When the scheduler is built:
- Store the message ID returned by `user.send()` / `channel.send()` with the job record
- On button click, retrieve and edit that message to disable the button
- Config keys and DB column (`more_time_requested` on `turn`) are already in place

---

## Address deprecated framework [deferred]
Update to a component-based approach using ActionRows. Instead of passing components directly, they must be wrapped in an ActionRowBuilder to ensure proper layout and compliance with current interaction API standards.

---

## DM support [deferred]
**1. Discord app setup**
- Enable User Install scope in Discord Developer Portal
- In `deploy-commands.js`, add `setIntegrationTypes([0, 1])` and `setContexts([0, 1, 2])` to all applicable commands

**2. Guild resolution for DM context** — add `resolveGuildForDMUser(connection, client, userId)` to `utilities.js`
- 0 matching guilds → error; 1 → silently resolve; 2+ → show StringSelectMenu of server names
- Guild names sourced from `guildName` config key
- Must handle both regular and autocomplete interactions (no `interaction.guild` in DM context)

**3. Guild tag + name added to setup** — add **Server Tag** field to `storyadmin.js` `handleSetup` modal
- 1–4 chars, validated with `/^[\u0021-\u024F]{1,4}$/u` (printable ASCII/Latin, no spaces/emoji)
- Used to prefix story labels in DM context e.g. `[BBC] The Wandering Stars (#3)`
- `guildName` auto-populated silently from `interaction.guild.name` on every setup submission (no modal field)
- Add upserts for `guildTag` and `guildName` in `handleSetupModalSubmit`; follow existing pattern in `sync-config.js`

**5. DM guard clause removal** — replace early `if (!interaction.guild)` guards in `mystory.js` and `story.js` with guild resolution logic
- All `interaction.guild.id` → resolved `guildId` variable
- All `interaction.guild.name` in log calls → `interaction.guild?.name ?? 'DM'`

**6. Commands staying guild-only:** `storyadmin` (all subcommands), `story add`

**DM-related follow-ups (implement alongside or after DM support):**
- `story read` should be non-ephemeral in DM context
- Audit edit flow for `interaction.guild` references; apply guild-resolution pattern

**Suggested implementation order:**
1. `utilities.js` — `resolveGuildForDMUser` + shared autocomplete query helpers
2. `deploy-commands.js` — integration types, contexts, swap integer options to autocomplete string options
3. `storyadmin.js` — guild tag/name in setup modal and submit handler
4. `mystory.js` — remove guard, DM resolution, autocomplete handler, parse string story_id
5. `story.js` — same for applicable subcommands
7. `sync-config.js` / DB — new config key defaults for `guildName` and `guildTag`

---

# Future features:
- Series System
- Reactions Kudos 
- Hub Sharing 
- Add an export help page with Work Skin creation instructions — walk users through copying the `#workskin` CSS block from their exported HTML into an AO3 Work Skin so entry formatting (tooltips, scene breaks, subtext) matches on AO3.

---

## Series System

- series system, create a series, add stories to it, chapters in a larger story, consider how to display them

---

## Reactions Kudos

- I also want to make a reaction system where people can leave one of five or six reactions on any of the bot's posts, and after a minute (so people can add or take away as needed) it will repost them as a post in the story feed, so when a user posts an entry and someone reacts with "😍 ", after a minute it will make a post that says "[user] sent 😍 on [post title, linked]"
- I'm thinking 👍😍 🤣 😭 🫣 🔥
- any other reactions on those posts won't be reposted, in cases of potential abuse on user installs
- I'm not sure if its best just to have the posts load with the reactions so people can add to them, or have a small line of instructions
- preloading is likely to get more engagement, but might look odd?
- commenting on story activity seems like it's already a natural part of the process

---

## Hub Sharing

- Round Robin Storybot Hub server - It wouldn't make sense for a storybot server not to have stories in it though, and I cant expect anyone from the book club to be active there as well, so I want to ask users when they install the bot to opt in to having their stories mirrored on the Hub.  Then at the story level, story creators can choose if a story is shared or not, and when a user joins a story they have to consent to the fact that the story is set up to be shared, and at all of these points I'd have a reassurance that their data will never be shared or used for AI training in any way, though it would be available for others to read, much like posting a work on a public archive.  So, the reaction system would actually hit all the way back to the original story feed, when a user in the Hub left a reaction!

---