# Round Robin StoryBot — Fable Audit, July 2026

**Date completed:** 2026-07-10
**Scope:** All code changed since the Silo 5 audit commit (`8548241`, 2026-05-05), plus transaction-boundary tracing across the whole turn engine. Findings already closed by the Silo 1–5 audit are not re-reported. Items already in TODO.md are only mentioned where their risk is higher than their backlog position suggests.
**Coverage note:** Deep-read (pass 1, 2026-07-10): `storybot.js`, `story/_turn.js`, `_writeFinalize.js`, `_writeQuickMode.js`, `_writeSkip.js`, `_delay.js`, `_storyStatus.js`, `_managePauseResume.js`, `_manageTurnActions.js`, `_metadataModals.js`, `add.js`, `manage.js`, `join.js`, `close.js`, `job-runner.js`, `index.js`, plus schema (`db/init.sql`, all 20 migrations). Deep-read (pass 2 addendum, same day — see §Pass 2 below): `edit.js`, `read.js`, `list.js`, `tags.js`, `_tagSubmit.js`, `export.js`, `_metadata.js`, `_migration.js`, `roundup.js`, `faq.js`, `_manageUser.js`, `_manageEntries.js`, `commands/story.js`, `commands/_myStoryList.js`, `commands/_myStoryManage.js`, `commands/_storyadminSetup.js`, `commands/mystory.js`, `commands/storyadmin.js`, `utilities.js` (full). All application source is now covered at full depth.

---

## Bucket 1 — Hidden Bugs

### Tier 1: Broken features (confirmed against code + schema + installed discord.js)

**1.1 `/story write` rejects every story, including quick mode — quick-mode writing is unusable via the slash command.**
`story/_writeQuickMode.js:35` checks `storyInfo.story.quick_mode`, but the story table has no `quick_mode` column — it's `mode` (`db/init.sql:19`). `validateStoryAccess` returns the raw row, so `quick_mode` is always `undefined` and the handler always replies with `txtNormalModeWrite`. Routing confirmed live: `commands/story.js:7` → `story/write.js:1` → `_writeQuickMode.js`.
*Fix:* `storyInfo.story.mode !== 1` (and consider a shared named constant for modes).

**1.2 `/story add` "Story Metadata" and "My Settings" modals crash on every submit.**
`story/add.js:232–234` and `261–265` call `interaction.fields.getSelectMenuValues(...)`. The installed discord.js (14.26.x, verified in `node_modules/discord.js/src/structures/ModalSubmitFields.js`) only has `getStringSelectValues`. Every submit throws `TypeError`, caught and shown as `txtActionFailed`. Net effect: **rating, dynamic, warnings, join privacy, and notification prefs can never be set during story creation** — stories silently default to NR / public / dm. `manage.js:553–558` uses the correct name (with a defensive fallback), which is why the same modal works in manage but not add.
*Fix:* replace with `getStringSelectValues` in add.js; then delete the fallback chain in manage.js so both files use one accessor.

**1.3 Story summary is silently discarded at creation.**
`add.js` collects a 4000-char summary and passes it in `storyInput` (`add.js:492`), but `CreateStory`'s INSERT column list (`storybot.js:79–82`) does not include `summary`, even though `story.summary` exists (`init.sql:33`). The creator sees their summary in the panel embed, clicks Create, and it's gone; it only persists if re-entered via `/story manage`.
*Fix:* add `summary` to the INSERT.

**1.4 Creator's notification preference is silently ignored.**
`add.js:479` passes `notifications: 0|1`, but `StoryJoin` reads `storyInput.notificationPrefs || 'dm'` (`storybot.js:219`). A creator who picks "Mention" still gets DM notifications. (The join flow is unaffected — `join.js:237` passes `notificationPrefs` correctly.)
*Fix:* map `state.notifications` → `notificationPrefs: state.notifications ? 'dm' : 'mention'` in `handleCreateStorySubmit`.

**1.5 Turn timeout deletes writer drafts that were supposed to be preserved 24h.**
`job-runner.js:151–156` selects `t.turn_id, t.thread_id, sw.discord_display_name` — **not** `discord_user_id` — but line 186 passes `activeTurn.discord_user_id` (undefined) to `endTurnThread`. The draft check compares `m.author.id === String(undefined)`, never matches, so `hasContent` is always false and the thread is deleted immediately. Timeout is precisely the case where half-written drafts exist. (`close.js:114` selects the column correctly — this is an isolated omission.)
*Fix:* add `sw.discord_user_id` to the SELECT.

**1.6 The "Delete Now" button on preserved draft threads throws every time.**
`story/_writeSkip.js:197` calls `deleteThreadAndAnnouncement`, which is not in the file's imports (line 3 imports only `PickNextWriter, NextTurn, postStoryThreadActivity, endTurnThread`). Every click → ReferenceError → logged, no user feedback, thread not deleted (the 24h job still gets cancelled at line 190–194, so the thread then *never* auto-deletes either).
*Fix:* add the import. Also see 1.15 (button has no auth check).

**1.7 Skip flow's "Delete my draft" / "Keep for 24h" choice is ignored.**
`handleSkipTurn` presents `story_skip_confirm_delete_` and `story_skip_confirm_keep_` buttons (`_writeSkip.js:94–107`), but `handleSkipConfirm` parses the variant (`:136–137`) and never branches on it — both paths run identical code ending in `endTurnThread`, which always preserves for 24h when content exists. "Delete" quietly behaves as "Keep".
*Fix:* pass an explicit `deleteNow` flag through to thread disposal.

**1.8 A stale quick-mode entry permanently blocks a writer from submitting in that story.**
`handleWriteModalSubmit`'s pending-entry lookup (`_writeQuickMode.js:80–86`) matches any `pending`/`discarded` entry for that user+story **without filtering to the current turn**, and recycles that row — keeping its old `turn_id`. On a later turn, the writer's new text is attached to the dead turn; `confirmEntry`'s turn-status guard (`:207`) then rejects it with "turn ended", every time, forever (nothing cleans old pending/discarded rows — see 1.16).
*Fix:* scope the lookup with `AND t.turn_status = 1` (or by the current turn_id), and INSERT fresh when no current-turn row exists.

**1.9 Hour-based story delay never auto-activates (known-deferred item, confirmed live, underweighted).**
`job-runner.js:105` returns unless `story_status === 2`, but delayed stories are created with status **4** (`storybot.js:70`) and `_delay.js:57` activates only from status 4. The `checkStoryDelay` job is therefore a guaranteed no-op — a story delayed "N hours" activates only if a writer happens to join after the window. This is deferred item #2 in `Audit_Final_Report.md` marked "verify before testing" — it is not latent, it is live, and it silently disables an advertised feature.
*Fix:* change the guard to `!== 4` (or `=== 4`), and add a named constant for story statuses.

### Tier 2: State-machine integrity (the restricted-host stuck-state risks)

**1.10 `NextTurn` failures are swallowed and no caller checks the result → silently stalled stories.**
`NextTurn` catches all errors internally and returns `{success:false}` (`_turn.js:291–297`). **No call site checks it:** `CreateStory` (`storybot.js:157`), `doFinalizeEntry` (`_writeFinalize.js:284` — inside its transaction, which then **commits** with the old turn ended and no successor), `confirmEntry` (`_writeQuickMode.js:221`, same pattern), `handleSkipConfirm` (`_writeSkip.js:169`), `handleTurnTimeout` (`job-runner.js:189` — job then "succeeds", so no retry), delay activation (`job-runner.js:117`), resume/reopen (`_managePauseResume.js:107, 229`), reassign (`_manageTurnActions.js:214, 225`). If Discord hiccups inside NextTurn (thread create, channel fetch), the result is a story with **no active turn and no scheduled jobs** — invisible to users, recoverable only by admin action, expensive on a host with no console.
Related: `PickNextWriter` can return `null`; `doFinalizeEntry` and `confirmEntry` pass it to `NextTurn` unguarded (job-runner and skip do guard with `if (nextWriterId)` — but a null there *also* silently strands the story with no turn).
*Fix (layered):* (a) make NextTurn throw and let callers' transactions roll back, or check `result.success` at every call site; (b) split NextTurn into a DB-only `advanceTurn` (safe inside transactions) and a Discord-side `notifyTurn` (failure → logged + hub-alert but state stays consistent); (c) on any failure path, post to the hub log channel so a stalled story is noticed. (b) also fixes 1.12.

**1.11 Finalize vs. timeout race can double-advance a story; the guard that exists in quick mode is missing everywhere else.**
`doFinalizeEntry` (`_writeFinalize.js:280`), `handleTurnTimeout` (`job-runner.js:174`), and `skipActiveTurn` (`_turn.js:386`) all run `UPDATE turn SET turn_status = 0 ... WHERE turn_id = ?` with no `AND turn_status = 1` and no `affectedRows` check. A writer clicking Finalize within the same minute the timeout job fires → both paths read status 1, both end the turn, both run PickNextWriter + NextTurn → two active turns, two notified writers. The `ER_DUP_ENTRY` handler in `doFinalizeEntry:290` cannot save this: **`story_entry` has no unique key on `turn_id`** (`init.sql:67–74`; no migration adds one), so that guard is inert and duplicate entries are possible too.
Note `confirmEntry` (`_writeQuickMode.js:203–215`) already implements the correct pattern — re-check `turn_status` inside the transaction and bail politely.
*Fix:* `UPDATE ... WHERE turn_id = ? AND turn_status = 1` + check `affectedRows === 1` at all three sites; add a UNIQUE key on `story_entry.turn_id` (after de-duping existing rows).

**1.12 Discord API calls inside DB transactions.**
`CreateStory` creates the story thread and runs the full StoryJoin+NextTurn chain (thread creates, welcome posts, DMs) inside its transaction (`storybot.js:64–161`); `doFinalizeEntry`/`confirmEntry` do the same via NextTurn. Two consequences: transactions hold a pool connection (limit 5) for the duration of multi-second Discord I/O, and a rollback after a thread was created orphans the Discord artifacts (conversely, `doFinalizeEntry` forwards images to the media channel *before* opening its transaction, so rollback orphans media posts). The 1.10(b) advanceTurn/notifyTurn split resolves this structurally.

**1.13 Jobs are never marked complete — a restart mid-job silently loses it, and the job table grows forever.**
`processJob` claims a job (`job_status = 1`, `job-runner.js:33–37`) but on success never updates the status. Completed jobs sit in status 1 indefinitely: (a) a crash/restart between claim and completion leaves the job in status 1 — the poller only picks up status 0, so it is never retried; a lost `turnTimeout` = story stalled at its deadline (same failure mode as 1.10, triggered by any restart, which the host performs on every deploy); (b) completed rows are indistinguishable from crashed ones and nothing ever prunes the table (`helper/cleanup.js` cleans config keys only).
*Fix:* add a completed status (e.g. 4) set after the handler returns; on startup, re-queue status-1 jobs older than a threshold; add a periodic purge of completed/cancelled rows older than N days.
Related same-file inconsistency: the guild-gone path (`job-runner.js:66–69`) also returns with the job stuck in status 1.

**1.14 Join capacity race — LOGIC_ERRORS #16, still present as described.**
`handleJoinConfirm` re-validates eligibility *outside* the transaction (`join.js:227`), then joins inside it. Two users confirming simultaneously can exceed `max_writers`. The `(story_id, discord_user_id)` unique key protects against same-user duplicates only.
*Fix:* re-run the capacity check inside the transaction (a `SELECT ... FOR UPDATE` on the story row, or a conditional INSERT).

### Tier 3: Smaller confirmed defects

**1.15** `handleThreadDeleteNow` (`_writeSkip.js:185`) has no authorization check — the button is posted in the (public) turn thread, so once 1.6 is fixed, any server member could delete another writer's preserved draft. Gate on the draft owner / creator / admin.
**1.16** Quick-mode entry expiry is advertised but not enforced — LOGIC_ERRORS #15 still true. `cfgEntryTimeoutMinutes` drives only the message text and a 5-minute in-memory DM reminder (`_writeQuickMode.js:113–134`, lost on restart). No job ever expires pending entries. Combined with 1.8 this actively corrupts the write flow.
**1.17** Job-cancel semantics are split: `NextTurn`/`skipActiveTurn`/finalize/timeout cancel with `job_status = 3`, but pause/resume (`_managePauseResume.js:19, 115`) and extend (`_manageTurnActions.js:363`) use `job_status = 2` — which means "permanently failed" per the registry. Same files also INSERT replacement `turnTimeout`/`turnReminder` jobs **without the `turn_id` column** (`_managePauseResume.js:131, 138, 146`; `_manageTurnActions.js:368`), so `NextTurn`'s cancel-by-`turn_id` misses them; the stale jobs only no-op because handlers re-check turn status. Standardize: always populate `turn_id`, always cancel with 3.
**1.18** Pausing never actually retitles the turn thread: `applyPauseActions` replaces a `[turnEndTime]` token (`_managePauseResume.js:37`) that doesn't exist in `txtTurnThreadTitle` (`Turn [storyTurnNumber] - Story ID: [story_id] - [user display name]`), so the "PAUSED" marker never appears — and `'PAUSED'` is hardcoded besides.
**1.19** `handleReopenStory` renames only `story_thread_id` (`_managePauseResume.js:209–223`) — reopening an M/E-rated story retitles the wrong (unrestricted) thread. Pause/resume in the same file do rating-aware selection; reuse `getActiveThreadId`.
**1.20** `handleCloseConfirm` ends the active turn but never cancels its pending jobs (`close.js:120–127`) — stale timeout/reminder jobs later fire and no-op only thanks to downstream guards. Add the standard `UPDATE job SET job_status = 3 WHERE turn_id = ?`.
**1.21** Rating-barrier migration failure is invisible to the admin: `handleManageSave` logs it but still replies `txtAdminConfigSaved` (`manage.js:447–457`) — an M-rated story can be left sitting in the unrestricted channel with a success message. Surface the failure in the reply.
**1.22** `handleManageSave` is not transactional (`manage.js:415–443`): main UPDATE, status UPDATE, pause/resume actions, and migration run sequentially on the pool; a mid-sequence failure leaves half-applied settings with the generic error message.
**1.23** Finalize composes the entry from `messages.fetch({ limit: 100 })` (`_writeFinalize.js:210`, also `:80` and `_turn.js:350` at limit 50) — a writer whose turn spans more than 100 messages (or 50 for the draft check) silently loses the oldest ones. Unlikely but silent; paginate or document the cap in the welcome message.
**1.24** `/story add` metadata can't be un-set: `if (dynamic) state.dynamic = ...` (`add.js:236–237`, same in manage) means deselecting rating/dynamic in the modal leaves the old value staged; only warnings assign unconditionally. Cosmetic inconsistency, fix alongside 1.2.
**1.25** `_metadataModals.js:116`: the delay field renders `-+*${cfg.txtDelayHint}*` — the `-+*` is a mangled markdown prefix (likely meant `-#` subtext) and shows literally in both add and manage embeds.
**1.26** Round-robin order (type 2) cycle anchoring — verify intent: `PickNextWriter` defines a "cycle" as *turns since the current writer's previous turn* (`_turn.js:54–75`). Once a story is past its first full rotation, the eligible-pool path almost always comes up empty and every pick goes through the "cycle reset" fallback, which only excludes the most recent ~25% of writers. For groups of 5+, the everyone-once-per-cycle guarantee quietly degrades to "not among the last ceil(n/4) to go". The comments suggest the reset behavior is intentional, but the anchor choice means the *primary* path is effectively dead after cycle 1 — worth a deliberate decision (a `cycle_started_at` marker on the story, or per-cycle flags on story_writer, would make it exact).
**1.27** `checkStoryDelay` treats writer-count and hour delays as OR (`_delay.js:26–57`): a story delayed "until 5 writers AND 48h" activates when either is met. If both-set-means-whichever-first is intended, fine — but CreateStory's UI implies both are constraints. Verify intent.
**1.28** In-memory session maps (`pendingStoryData`, `pendingManageData`, `pendingPreviewData`, `pendingJoinData`, `pendingTurnActionData`, `pendingReminderTimeouts`) are keyed by user ID only, never expire, and hold full interaction objects + cfg blobs. Consequences: sessions die on restart (admin-assisted finalize then falls back to the *admin's* ID — `_writeFinalize.js:336` — and errors confusingly); a user with two panels open (two stories) gets the second silently overwriting the first, and Save on the first panel writes the second story's staged values from their perspective; slow memory growth. Key by `userId:storyId`, add a TTL sweep, and store only what's needed.
**1.29** Dead code that will mislead future work: `utilities.createThread` (`utilities.js:467`) is called from nowhere, still contains the LOGIC_ERRORS #8 `thread.permissionOverwrites.create()` mistake, and references an undefined `connection` variable — it would crash if ever called. Delete it (live thread creation in `NextTurn` correctly uses `thread.members.add()`). Likewise the `StoryBot` class publish/EventEmitter machinery (`storybot.js:21–44`, `index.js:72–87`) has zero callers of `emitPublish` — see Bucket 3. The `story_manage_rating_select`/`warnings_select` branches in `manage.js:597–604` reference select menus no longer emitted.

### LOGIC_ERRORS_REPORT.md disposition (per briefing section 3 cross-check)

| # | Status after verification |
|---|---|
| 4 (transactions) | Superseded by 1.10–1.12 above — the real issues are specific, not general. |
| 8 (thread permissionOverwrites) | **Resolved in live code** — buggy code survives only in dead `utilities.createThread` (1.29). |
| 11 (status literals) | Still true; statuses simplified to 0/1 but remain magic numbers across ~10 files. Named constants module recommended (see Bucket 4). |
| 12 (empty writers) | Fixed — guard at `_turn.js:122`. |
| 13 (story_thread_id in quick mode) | Effectively fixed — now a fallback only (`_turn.js:438`). |
| 14 (rigid status check) | Still as designed; `validateStoryAccess` remains active-only. Low priority. |
| 15 (pending entry cleanup) | Still true and now compounding a real bug (1.8, 1.16). |
| 16 (join race) | Still present (1.14). |
| 17 (guild_id in error paths) | Not found in current code — moot. |
| 18/19/20 (patterns) | Still true in aggregate; addressed piecemeal above. |
| Recommendation | The report references items #1–3/5–7/9–10 that no longer exist in its own body. Retire the file (mark superseded by this audit) so agents stop re-checking it. |

---

## Bucket 2 — Runtime Efficiency

**2.1 `updateStoryStatusMessage` loads the full text of every confirmed entry on every call** (`_storyStatus.js:61–78`) to recount words/images — and it's called on every turn change, every join, every manage-save, and once per active story at startup (`index.js:152`). Cost grows linearly with story length: a 100-entry story ≈ 400KB pulled and regexed per turn. *Fix:* store `word_count`/`image_count` on `story_entry` at insert (one migration + set in the two entry-insert sites), or maintain running totals on `story`.

**2.2 The turn-number subquery is duplicated at least five times** (`_writeFinalize.js:299–306`, `_writeQuickMode.js:185–189`, `_writeSkip.js:28–32`, `close.js:16–19`, `_manageTurnActions.js:409–412`) — a correlated `COUNT(DISTINCT ...)` that scans the story's turn history per call, and drifts from `utilities.getTurnNumber`. Consolidate into one helper; longer-term, store `turn_number` on the turn row at creation and stop deriving it.

**2.3 Config fetching is mixed between the batched array form and per-key round-trips.** `getMetaCfg` batches ~90 keys in one call, but many hot paths issue 3–6 individual `getConfigValue` awaits (`_writeFinalize.js:111–115, 222–225`, `createPreviewEmbed` `_writeQuickMode.js:273–280`, `close.js:68–72, 139–142, 161–164`, reminder handlers in job-runner). Each is a DB round-trip. Standardize on the array form in any function that reads >1 key.

**2.4 Job runner throughput and blast radius:** jobs run strictly sequentially, max 20 per 60s tick (`job-runner.js:20–24`); one slow Discord call (e.g., a fetch against a rate-limited guild) delays every queued job. Each job also rebuilds its context — `guilds.fetch` + full `roles.fetch` per job (`:90–94`) — even when five jobs target the same guild in one tick. Fine today; will degrade linearly with server count. Cheap wins: cache synthetic contexts per tick, raise the LIMIT, and bound per-job time.

**2.5 Hub broadcast is serial N+1** (`index.js:180–194`): per guild, two config queries + channel fetch + send. At 50 guilds that's ~200 sequential awaits inside a message handler. Batch the config reads and parallelize sends with a small concurrency cap.

**2.6 Startup refresh multiplies 2.1:** `refreshAllStatusMessages` serially runs the full status update for every active/paused story (`index.js:17–43`). With 2.1 fixed this is probably fine; consider staggering if guild count grows.

**2.7 Unbounded tables:** `job` never pruned (see 1.13); `story_entry` keeps `discarded` rows forever (harmless except for 1.8); session maps never expire (1.28).

---

## Bucket 3 — Rendering/Engine Separation

Headline: **the separation is real and a full rework is NOT needed** — but the documented mechanism is dead, and the actual boundary runs through different files than CLAUDE.md says.

**The documented architecture is vestigial.** `StoryBot extends EventEmitter` with `emitPublish` (`storybot.js:21–44`) and the `bot.on('publish')` renderer in `index.js:74–87` — the stated "engine emits, gateway renders" design — has **zero callers**. Every real code path calls Discord directly. Either delete it or (better, given Phase 2) revive the *idea* as the notifier interface described below.

### Classification (verified against code, refining the briefing's section 2)

**Pure logic / data+DB only — reusable by a web frontend as-is:**
- `story/_turn.js`: `PickNextWriter` (connection + storyId only — the single most valuable test/reuse seam in the codebase), `turnEndTimeFunction`
- `story/_delay.js`: `checkStoryDelay` (returns flags + message strings)
- `story/_metadata.js`: everything (rating codes, `isRestricted`, `crossesBarrier`, `formatWarnings`, `resolveFeedChannelId`, `resolveMediaChannelId`)
- `story/_storyStatus.js`: `buildThreadTitle`
- `story/_entryRenderer.js`: `buildEntryPages` (pure text pagination)
- `storybot.js`: `getActiveThreadId`
- `utilities.js`: `getConfigValue`, `replaceTemplateVariables`, `parseDuration`, `formatDuration`, `splitAtParagraphs`, `chunkEntryContent`, `sanitize`, `sanitizeModalInput`, `resolveStoryId`, `getTurnNumber`, `validateStoryAccess`, `validateActiveWriter`, `checkIsCreator`
- `join.js`: `validateJoinEligibility`

**Coupled engine functions — the exact set needing a thin seam (and only these):**
| Function | Coupling | Decoupling shape |
|---|---|---|
| `CreateStory` (`storybot.js:61`) | `interaction.guild` for id + `channels.fetch` + `threads.create`; returns pre-rendered ✅ message string | Take `{guildId, actorUserId, actorDisplayName}` + a `channelPort`; return structured result, let caller render |
| `StoryJoin` (`storybot.js:195`) | Reads `interaction.user/member` only | Same identity-object change — smallest lift, do first |
| `NextTurn` (`_turn.js:145`) | Thread create, welcome post w/ buttons, DM/mention notify | Split: `advanceTurn(conn, storyId, writerId)` (DB: end-prev-jobs, insert turn, schedule jobs) + `notifyTurn(ctx, turnInfo)` (Discord). Also fixes 1.10/1.12 |
| `updateStoryStatusMessage` (`_storyStatus.js:30`) | ~200 lines: data assembly then EmbedBuilder + buttons + message edit/pin | Extract `getStoryStatusData(conn, storyId)` returning the full struct (writers, turn, stats, next-writer, metadata); keep Discord render + a future HTML render as consumers |
| `postStoryThreadActivity`, `endTurnThread`, `skipActiveTurn`, `deleteThreadAndAnnouncement` (`_turn.js`) | Take `guild`/thread objects | `skipActiveTurn`'s DB half is already separable; thread ops stay Discord-side |
| `announcements.js` (4 functions) | Take `interaction`, fetch channel, send | Template+token assembly is already data; wrap sends behind the same channelPort |
| `handleQuickModeNotification`, `handleWriterNotification`, `postWelcomeMessage` (`_turn.js`, private) | DM/channel sends, buttons | Become part of `notifyTurn` |
| `sendUserMessage`, `checkIsAdmin` (`utilities.js`) | interaction/member | checkIsAdmin needs a role-check port for web-originated admin actions |

Everything else that touches Discord (`add.js`, `manage.js`, `join.js` panels, `_metadataModals.js`, `_manageTurnActions.js`, `_writeFinalize.js`, `_myStoryList/_myStoryManage/_storyadminSetup`, `faq.js`, `list.js`, `read.js`, `edit.js`) is UI-handler layer and *supposed* to be coupled — a web frontend replaces it, not reuses it.

**Scope estimate for Phase 2 readiness:** 2 small signature changes (CreateStory, StoryJoin), 1 function split (NextTurn), 1 extraction (getStoryStatusData), 1 port interface (send/DM/thread ops). No schema changes required for the separation itself.

---

## Bucket 4 — Agent-Workflow Efficiency

**4.1 `system_roadmap.md` is badly stale and actively misleading** — the highest-leverage doc fix. Its file inventory predates the underscore-module refactor (`storybot.js` listed as containing `NextTurn`/`PickNextWriter`; no `story/_*.js`, `faq.js`, `helper/`, `commands/_*.js`; line counts wrong), and its Silo Audit Status table still says Silos 2–5 "Pending" despite `Audit_Final_Report.md` closing all five in May. An agent trusting it will look for the engine in the wrong file. The job registry section, by contrast, is current and good.

**4.2 `CLAUDE.md` architecture section no longer matches the code.** "storybot.js (The Engine): Core business logic and DB operations. UI handlers must call functions here" — the engine now lives in `story/_*.js`; storybot.js is 280 lines of CreateStory/StoryJoin plus re-exports; the publish-event design it describes is dead code (Bucket 3). Rewrite that section around the real module map.

**4.3 The 500-line rule is violated by 9 files:** `edit.js` (729), `utilities.js` (683), `manage.js` (630), `commands/story.js` (577), `_storyadminSetup.js` (570), `_turn.js` (555), `_myStoryList.js` (527), `add.js` (520), `_manageTurnActions.js` (502). The May refactor fixed storybot.js/write.js/mystory.js; growth since has re-broken it elsewhere. `utilities.js` is the one worth splitting soonest (it's imported everywhere, and deleting dead `createThread` removes ~70 lines for free).

**4.4 The "no `??` config fallbacks" standard is regressing in post-audit code.** Silos 2–4 explicitly removed them; new files reintroduce them (`_metadataModals.js` throughout — `cfg[k] ?? k`, `?? ''`; `add.js` placeholders `?? 'e.g. 24h...'`; `join.js` hardcoded embed strings `'🎭 Join'`, `'Public'/'Private'` option labels, `'💬 DM'`; `_managePauseResume.js` `'PAUSED'`). Worth one sweep plus adding the rule to the planned `style_roadmap.md` so it stops recurring.

**4.5 Tests: none, and the riskiest code is exactly the untested state machine.** `package.json` has a placeholder test script. Given the restricted host (no local Discord, live-testing is expensive), the minimal viable seam is:
- **Layer 1 (zero infra, start here):** `node:test` + a fake connection (`{ execute: async (sql, params) => [fixtureRows] }`, or a scripted queue of results). Immediately testable, no code changes needed: `PickNextWriter` (all three order types + override + cycle reset — would have caught 1.26 ambiguity), `checkStoryDelay` (would have caught 1.9's status mismatch at the boundary), `buildEntryPages`, `splitAtParagraphs`, `parseDuration`/`formatDuration`, `replaceTemplateVariables`, `crossesBarrier`/`formatWarnings`, `validateJoinEligibility`.
- **Layer 2 (after the 1.10 advanceTurn split):** transaction-sequence tests for advanceTurn/finalize/skip against the same fake connection, asserting the SQL sequence and that failure paths roll back — this is what makes agent edits to the turn engine safe.
- **Layer 3 (optional):** dockerized MariaDB running `init.sql` + migrations for schema-drift tests (would have caught 1.1 and 1.3, both schema-vs-code mismatches).
Also add `node --check`-style lint or eslint in CI-ish form: findings 1.6 (missing import) and 1.2 (nonexistent method) are both catchable statically — `eslint` with `no-undef` alone pays for itself.

**4.6 Duplication that specifically burns agent context:** the turn-number subquery ×5 (2.2); the thread-title `.replace` chain ×5 (`_turn.js:238`, `_managePauseResume.js:33, 60, 96, 157`, `close.js:165`, `_storyStatus.js:19`) — and TODO.md already flags inline `.replace()` on config strings as a compliance sweep; the DM-with-mention-fallback block ×4 (`_turn.js:464–484`, `job-runner.js:250–262, 314–325`, `_managePauseResume.js:178–191`). Each should be one helper. Magic numbers for story/turn/job/writer statuses across ~10 files → one `constants.js` (also closes LOGIC_ERRORS #11 properly).

**4.7 TODO.md items that are riskier than their backlog position suggests:**
- **Modal routing cleanup pass** (Audit deferred #1): 1.2 and 1.6 are precisely the bug class that pass would catch. Elevate to next-sprint.
- **checkStoryDelay status check** (Audit deferred #2): not a "verify" — a live feature-killer (1.9).
- **Export "Show Names" decoupling**: as listed; correctly scoped.
- **style_roadmap.md creation**: cheap, and 4.4 shows the drift it prevents is already happening.
- **Deprecated ActionRow migration**: lower urgency than listed concerns imply — the new Label/RadioGroup builders in `_metadataModals.js` are already the modern API; the remaining legacy usage is stable.

---

## Bucket 5 — Feature / Workflow UX

Grounded in friction visible in the code; building toward the existing roadmap (Series, Reactions/Kudos, Hub Sharing), not orthogonal to it.

**5.1 Make silent failures loud (biggest UX debt, mostly = Bucket 1 fixes).** Summary loss (1.3), notification-pref loss (1.4), metadata modal crash (1.2), migration-failure-reports-success (1.21) all share a shape: the user believes something happened that didn't. Beyond the fixes, adopt a rule for new work: any staged-panel Save should echo back what was actually written (the manage panel already has the embed for it — re-render it once post-save instead of replacing with a bare success line).

**5.2 A "story stalled" safety net.** Given 1.10/1.13, and even after fixes: add a cheap watchdog job (e.g. hourly) that flags active stories with no active turn and no pending turn-creating job, posting to the hub log channel (`cfgHubLogChannelId` infrastructure already exists and is the right transport). On a host with no console this converts invisible stalls into a ping.

**5.3 Honor and finish the draft-preservation story.** The 24h-preserve design is good; right now timeout deletes drafts (1.5), Delete Now is broken (1.6), and the skip choice is ignored (1.7). Once fixed, also DM the writer when their turn times out with a link to the preserved thread ("your draft is kept until <t:...>") — currently the only timeout signal is a feed activity line, and the writer with a dead draft is exactly who's not watching the feed.

**5.4 Quick-mode write recovery.** After 1.8's fix, the flow still has a rough edge: a writer whose preview expired (restart, 1.28) has a pending row and no buttons. `txtRecoveryInstructions` exists — verify it points at a real recovery path (re-running `/story write` should resume the pending entry into a fresh preview, which the pending-row reuse *almost* implements already; scope it to the current turn and it becomes the recovery mechanism instead of a bug).

**5.5 Multi-panel sessions (1.28) have a UX face:** an admin managing two stories, or creating while managing, gets crossed wires with no warning. Cheapest fix consistent with current architecture: when opening a second panel, edit the first panel's message to "superseded by your newer panel" before overwriting the session.

**5.6 Can't clear metadata once set** (1.24): add an explicit "— none —" option to dynamic selects rather than treating empty selection as "no change", and say which semantics apply in the placeholder.

**5.7 Toward Reactions/Kudos and Hub Sharing:** the status-message pattern (persistent, edited-in-place, id stored on story) is the right chassis for the reaction-repost feature — but note 2.1 first, since Reactions will multiply status-update frequency. For Hub Sharing's consent points, the join flow already has the confirm-panel pattern to hang a consent notice on (`buildJoinEmbed` + `handleJoinConfirm` revalidation is the natural insertion point).

**5.8 Turn extension ("Request More Time") remains half-built** (button exists, deferred pending scheduler work) — noting per instructions, not re-suggesting: the admin-side extend in `_manageTurnActions.js` now contains all the mechanics the writer-side button needs (DATE_ADD update + job cancel/reinsert). The deferred item is smaller than it was when written; the message-id storage TODO.md describes is only needed for the disable-after-use nicety.

---

## Pass 2 Addendum (2026-07-10) — full-depth review of previously skimmed files

Same methodology and verification standard as pass 1 (confirmed against code + schema + installed discord.js 14.26.4). Numbering continues each bucket. Note on pass-1 finding 1.2: re-verified this pass against `node_modules/discord.js/src/structures/ModalSubmitFields.js` — modals fully support selects/radio groups; the bug is solely the nonexistent method name `getSelectMenuValues` (correct: `getStringSelectValues`). See the new `docs/discordjs_reference.md`.

### Bucket 1 — Hidden Bugs (continued)

#### Tier 1: Broken features (confirmed)

**1.30 Edit history "Cancel" on the restore confirmation can never cancel — the user is trapped in the confirm dialog.**
`handleEditButton` checks `startsWith('story_edit_restore_')` (`edit.js:267`) before the exact `story_edit_restore_cancel` (`edit.js:271`), so Cancel matches the restore branch, `parseInt('cancel')` = NaN, and `handleRestoreConfirm` re-renders the confirmation with `story_edit_restore_confirm_NaN`; confirming that finds no edit row (`txtEditHistoryNotFound`). The unreachable cancel branch never runs.
*Fix:* test the exact cancel ID before the `startsWith` branches.

**1.31 `/story list` pagination breaks under every rating filter.**
Nav customId is `story_list_${filter}_${page}` parsed positionally by `split('_')` (`list.js:24`); `story_list_rating_G_2` yields filter=`rating`, page=`'G'`→NaN. With a rating filter and >5 stories, Prev/Next errors out (NaN OFFSET) and the unknown filter drops the rating constraint besides.
*Fix:* take page via `.at(-1)` and rejoin the middle segments as the filter.

**1.32 Repost after an edit from the read view destroys the read UI instead of refreshing it.**
`pendingRepostEntryId` is stored as a string (DB `bigNumberStrings`, set at `edit.js:540`) but compared with `===` against `parseInt(customId)` (`edit.js:695`) — never equal, so the fallback branch (`edit.js:701-702`) replaces the entire read embed with a bare success line. The reader loses their place and all controls.
*Fix:* compare as strings (keep the customId segment unparsed, as `read.js:404` already does).

**1.33 Content warnings display as raw config keys (`optWarnViolence`) in every metadata embed.**
`buildMetadataFields` builds the label map as `[cfg[k], cfg[k]]` — keyed by display label — while `formatWarnings` looks up by option key (`_metadata.js:73` vs `:51`), so every lookup misses and falls back to the raw key. `export.js:206` builds the same map correctly (`[k, cfg[k]]`).
*Fix:* one character class of fix — key the map by `k`.

**1.34 Setup's admin-role modal always shows the generic fallback label "Value".**
`handleSetupButton` reads `cfg.lblSetupModalFieldRole` / `cfg.txtSetupModalPlaceholderRole` (`_storyadminSetup.js:237`) but neither key is in `handleSetup`'s config batch (`:60-79`) — both are `undefined`, and `buildSetupFieldModal`'s guard downgrades to `'Value'`/empty. The keys exist in `config_storyadmin.sql`; they're just not fetched.
*Fix:* add both keys to the batch.

**1.35 Setup save silently keeps values the admin cleared.**
All upserts except the feed channel are conditional (`_storyadminSetup.js:408-411`), so clearing media/restricted/role in the modal (minValues 0) updates the panel to "Not set" but leaves the old value in config — the guild keeps using a channel the admin believes is removed. Roundup is the only setting with an explicit off-path.
*Fix:* upsert unconditionally (write `''`) or DELETE the row when the staged value is empty; the sentinel checks elsewhere already treat `''` as unset.

#### Rating-barrier bypasses (Tier 1, shared root cause: `getActiveThreadId` exists — `storybot.js:52` — but these paths use `story_thread_id` directly)

**1.36 Repost posts M/E-story content into the unrestricted thread.** `handleRepostEntry` selects only `s.story_thread_id` (`edit.js:636`) and sends there (`:690`). For a restricted story whose active thread is `restricted_thread_id`, an edited adult entry is reposted into the unrestricted thread.
**1.37 "Post to Story Thread" export does the same** — `handleExportPostPublic` (`export.js:325, 340-341`) posts the complete story HTML to `story_thread_id` unconditionally.
**1.38 Tag proposals, vote reactions, and approve/reject status edits all target `story_thread_id`** (`_tagSubmit.js:137`, `tags.js:399`) — for restricted stories, tag activity lands in the thread the writers aren't using (votes silently read 0).
*Fix for all three:* select `rating, restricted_thread_id` too and route through `getActiveThreadId`.

**1.39 Rating migration with no restricted channel configured creates the "restricted" thread in the main feed.**
`handleManageSave` calls `migrateStoryThread` with no gate (`manage.js:445-447`); `resolveFeedChannelId` silently falls back to the main feed (`_metadata.js:104-109`), so migration builds a second thread in the same channel, archives the original, and records the new one as `restricted_thread_id`.
**Policy decided (user, 2026-07-10):** when no restricted channel is configured, all stories go in the main feed — ratings are informational-only. *Fix accordingly:* skip `migrateStoryThread` entirely when `isRestricted(newRating)` and no restricted channel is configured (rating change still saves; story stays in its current thread); `handleRead`'s unconfigured no-op (`read.js:187-189`) is correct as-is.

#### Tier 2: State-machine integrity (extends 1.10/1.11/1.13/1.20 call-site lists)

**1.40 Five more unguarded turn-end + swallowed-NextTurn sites, all in writer-management flows.**
Admin pause/remove (`_manageUser.js:311, 347`) and panel pass/pause/leave (`_myStoryManage.js:282, 333, 394`) run `UPDATE turn SET turn_status = 0` with no `AND turn_status = 1`/affectedRows check (1.11 class), swallow `PickNextWriter`/`NextTurn` failures (1.10 class), and **never cancel the ended turn's timeout/reminder jobs** (1.20 class). `handlePanelPassConfirm` additionally passes a possibly-null `nextWriterId` straight into `NextTurn` (`_myStoryManage.js:283-284`) — the null guard its sibling flows have is missing. Add all five sites to the 1.10/1.11/1.20 fix sweeps.

**1.41 Admin/panel actions destroy writer drafts that skip/timeout would preserve.**
Admin pause/remove call `deleteThreadAndAnnouncement` immediately (`_manageUser.js:315, 351`); panel pass/pause call `thread.delete()` outright (`_myStoryManage.js:288, 337`). No 24h preserve, no warning that a draft exists. Route these through `endTurnThread` like the skip flow (complements pass-1 findings 1.5-1.7 / 5.3).

**1.42 "Last writer gone" auto-close is half a close, and `/storyadmin delete` leaks artifacts.**
Auto-close on remove/leave sets `story_status = 3` only (`_manageUser.js:359`, `_myStoryManage.js:408`) — no job cancellation, no status-message update, none of close.js's thread handling. `/storyadmin delete` (`storyadmin.js:240-260`) deletes the story row and `story_thread_id` thread but leaves the `restricted_thread_id` thread orphaned forever and never cancels the story's pending jobs (they later fire against cascaded-away turn rows).
*Fix:* extract a shared `closeStoryInternals(conn, storyId)` (cancel jobs + status message + threads) used by close.js, both auto-close sites, and delete.

**1.43 Weekly roundup chain dies on a single failed post.**
`handleWeeklyRoundup` re-throws on send failure (`roundup.js:258-261`) before reaching `scheduleNextRoundup` (`:267`); with 1.13 (claimed jobs never retried after restart) the chain is dead until an admin re-saves setup. The `job_log` dedup INSERT also happens *before* posting (`:221-225`), so any retry of the failed window bails as a duplicate — that week is silently lost. The disabled-path early return (`:233-236`) also skips rescheduling, though setup's save/cancel flow (`_storyadminSetup.js:419-423`) covers the normal disable route.
*Fix:* reschedule in a `finally`; move the job_log write after the successful send.

**1.44 Tag approval has a lost-update race and no dedup.**
Approve does read-then-write on `story.tags` on the pool with no transaction (`tags.js:423-426`) — two concurrent approvals can drop one tag, and the same tag text can be appended twice.

**1.45 Catch-up navigation can serve the wrong story's pages.**
`handleCatchUpNavigation` finds the session by `startsWith('catchup_${userId}_')` (`_myStoryList.js:496`) — with two catch-up sessions open, buttons on story B render story A's pages. Sessions are also never cleaned (1.28 class). Encode the storyId in the nav customId and key the lookup exactly.

#### Tier 3: Smaller confirmed defects

**1.46** `commands/story.js:164` references `txtNotConfigured`, which migration 010 **deleted** as unused — the guard itself is dead (index.js pre-blocks unconfigured guilds at `index.js:229-239`) but would show a raw key name if ever reached. Delete the block.
**1.47** Setup panel footer renders a literal debug marker: `txtSetupModalSaveWarning + ' ##'` (`_storyadminSetup.js:28`) — and the save warning appears twice (description and footer).
**1.48** Read-path single-chunk edit refresh is suspect (**verify live**): after `showModal` on the button interaction (`read.js:388`), the flow later calls `originalInteraction.editReply` (`edit.js:542`) — a component interaction acknowledged only with a modal may have no `@original` message to edit. If it fails live, the clean fix is using the modal submit itself (`isFromMessage()` → `deferUpdate()` + `editReply`), which also removes the stored-interaction dependency (1.28).
**1.49** Undelete-with-old-version divergence: restoring a history version of a *deleted* entry flips status only (`edit.js:409-413`) but the UI state adopts the selected version's content (`:439`) — screen and DB disagree until re-opened.
**1.50** Edit modal customIds embed `_p${chunkPage}` (`edit.js:219`) that the submit handler ignores in favor of `state.chunkPage` — a Discord-cached stale modal writes old text onto whatever page the session points at now.
**1.51** Manage-entries turn numbers count confirmed+deleted entries (`_manageEntries.js:56, 288`) while `/story read` and `/story edit` count confirmed only — the admin panel displays numbers the other commands don't recognize. Also: the writer-filter pagination sentinel `__page__${offset}__${fragment}` mis-parses fragments containing `__` (`:224-227`).
**1.52** `/mystory list` stats can show more "my turns" than total: `my_turn_count` counts all *ended* turns including skips/timeouts (`_myStoryList.js:85, 98`) while `total_turn_count` counts only turns with confirmed entries (`:87-90`). Count both the same way.
**1.53** Creator identity is defined two ways: `checkIsCreator` = oldest **active** writer by `joined_at` (`utilities.js:611-617`); autocompletes = `MIN(story_writer_id)` regardless of status (`commands/story.js:414, 427`, `storyadmin.js:313`); `list.js:257` = earliest `joined_at` any status. If the founder leaves, creatorship silently migrates in some views and not others. Pick one definition, one helper.
**1.54** `log()` misuse in read.js restricted-check block: `log(msg, ['', guildId])` passes an array as the options object (`read.js:184, 186, 197`) — `show` is undefined so these never print in production and guildName is lost. Same block uses inline `.replace('[rating]', …)` (`read.js:202`) and `_manageUser.js:374` uses inline `.replace('[writer_name]', …)` — both violate the replaceTemplateVariables rule.
**1.55** Old-thread lockdown order is inverted in migration: `setArchived(true)` then `setLocked(true)` (`_migration.js:115-116`) — the lock call on an archived thread can fail (silently caught), leaving the old thread archive-only, and any member post un-archives it. Lock first, then archive.
**1.56** `handleTagSubmitModalSubmit` replies with the *placeholder text* as the error message when the tag is empty (`_tagSubmit.js:112`); `_tagSubmit.js:291` has a hardcoded fallback success string.
**1.57** faqsync partial-failure reporting is wrong when config is missing: `syncFaqPosts` early returns `{errors: N}` without `total` (`faq.js:251, 257, 263`), so `handleFaqSync`'s `errors === total` check (`storyadmin.js:161`) compares against undefined and reports "partial". faq.js catch blocks also leave the user's deferred ephemeral spinning with no message (`faq.js:193-195`).
**1.58** `story_join_thread_cancel_` deletes the host message without acknowledging the interaction (`commands/story.js:263-265`) — likely flashes "This interaction failed."

### Bucket 2 — Runtime Efficiency (continued)

**2.8** `storyLastActivitySQL()` is a correlated MAX-subquery evaluated per story row in ORDER BY across every list and autocomplete query (`utilities.js:676-684`; ~14 call sites). Fine at current scale; the eventual fix is a `last_activity_at` column maintained on turn end.
**2.9** The correlated turn-number subquery from 2.2 also appears per-row in `edit.js` (×3), `read.js:211`, `export.js:145`, `_myStoryList.js:417` (catchup), and `_manageEntries.js:53` — reinforces 2.2's "store turn_number on the turn row" recommendation.
**2.10** Sequential `getConfigValue` round-trips inside the 3-second showModal window: `_tagSubmit.js:46-50, 71-75` (3 each). Batch with the array form.
**2.11** Per-item Discord fetches in loops: tag views fetch one message per pending tag for reaction counts (`tags.js:58`, `:287`); export fetches members one-by-one for mention resolution (`export.js:30`). Bounded but linear; fine to leave until Reactions/Kudos multiplies read frequency.

### Bucket 4 — Agent-Workflow Efficiency (continued)

**4.8 The `getConfigValue` missing-key fallback (returns the key name) forces hand-rolled sentinel checks** — `value !== 'cfgRestrictedFeedChannelId'` idioms at `read.js:187`, `_metadata.js:106, 121`, `roundup.js:124, 130, 242, 245`, `index.js:185`, plus the `startsWith('txt')` guards in `_storyadminSetup.js:118-120`. Centralize as `isConfigSet(value, key)` (or return null and handle explicitly) before the idiom spreads further.
**4.9 Hardcoded user-facing text found this pass** (worst offenders): the entire weekly-roundup embed (`roundup.js:131-165` — section names, activity lines, en-US dates); setup save summary lines and permission warnings (`_storyadminSetup.js:503-543`); edit flow (restore warnings at `edit.js:328-330` **shadowing the fetched `txtEditRestoreWarning*` keys**, modal titles/labels/placeholders, 'Edit Next Entry →'); read flow (`read.js:74, 81, 93, 157, 379-386`); list ('Choose a filter...', `list.js:43`); tags ('— suggested by', 'Tag X of Y', '◀️ Prev'; `tags.js:211, 304, 312`); manage-entries option labels (`_manageEntries.js:100`); 'This command can only be used in a server.' ×3 (`commands/story.js:155`, `mystory.js:46`, `storyadmin.js:54`); `formatDuration`'s English units (`utilities.js:669-673`).
**4.10 Dead code to delete** (beyond 1.29): the whole legacy paginated tag view — `handleViewTagsButton` + `handleViewTagsNav` (`tags.js:240-336`) — its nav buttons are self-generated only and nothing emits `story_view_tags_`; `handleModalTest` (`storyadmin.js:80-146`, no `modaltest` subcommand exists); the `handleManageEntriesButton` import in `commands/story.js:13`; `stagedNotificationPrefs`/`stagedWriterTurnPrivacy` fields and the fetched-but-unused `btnAdminMUToggleNotif/TogglePrivacy` keys (`_manageUser.js`).
**4.11 New duplication:** `logAdminAction` is defined twice verbatim (`storyadmin.js:8-18`, `_manageUser.js:8-18`); the emoji-strip regex twice (`faq.js:154, 288`); the pen-name modal built twice (`_manageUser.js:268-281`, `_myStoryManage.js:156-169`); the 25-key list-cfg batch twice (`_myStoryList.js:27-37, 249-259`).

### Bucket 5 — Feature / Workflow UX (continued)

**5.9 Pen-name save semantics differ by panel:** the admin manage-user modal writes to DB immediately on submit (`_manageUser.js:406`), while the writer's own panel stages it until Save (`_myStoryManage.js:453`). Standardize on staged (the setup-panel reference pattern) and echo what was written — feeds the planned settings-UX audit.
**5.10 Draft preservation should be honored by *all* turn-ending paths** — 1.41 gives the admin/panel list; once fixed, the 5.3 DM-the-writer improvement covers these paths too.
**5.11 Setup should support clearing a value end-to-end** (1.35) and say so in the save summary — the summary already itemizes; add "removed" lines for cleared settings.
**5.12 Unconfigured-restricted-guild policy — RESOLVED** (see 1.39): user decided 2026-07-10 that without a restricted channel, all stories live in the main feed and ratings are informational-only. Apply that rule uniformly across read, migration, tags, and export instead of each improvising.

### Pass 2 fix-order addendum

Fold into the pass-1 fix order: 1.30-1.35 join step 1 (small, high-impact); 1.36-1.39 form a new "rating-barrier sweep" step (one shared fix via `getActiveThreadId` + one policy decision); 1.40-1.45 join step 2's state-machine guards (same sweeps, more call sites); the shared `closeStoryInternals` extraction (1.42) belongs with step 3's restructure; Bucket 4 items fold into step 4.

---

## Suggested Fix Order

1. **One-line/one-word fixes with outsized impact:** 1.1 (`quick_mode`→`mode`), 1.2 (`getStringSelectValues`), 1.5 (add column to SELECT), 1.6 (import), 1.9 (status 4), 1.3 (add summary to INSERT), 1.4 (notificationPrefs mapping). *Pass 2 additions:* 1.30 (reorder cancel check), 1.31 (list nav parse), 1.32 (string compare), 1.33 (map key), 1.34 (add 2 keys to batch), 1.35 (unconditional upserts), 1.47 (footer `##`).
2. **State-machine guards:** 1.11 (guarded turn-end UPDATEs + unique key), 1.8 (scope pending lookup), 1.13 (job completion status + startup requeue). *Pass 2:* extend the same sweeps to the five 1.40 call sites; 1.43 (roundup finally-reschedule); 1.44 (tag txn); 1.45 (catchup keying).
3. **Rating-barrier sweep:** 1.36-1.38 (route through `getActiveThreadId`) + the 1.39/5.12 policy decision.
4. **NextTurn restructure** (1.10/1.12 — advanceTurn/notifyTurn split), unlocking Bucket 3's seam and Layer-2 tests; extract `closeStoryInternals` (1.42) alongside.
5. **Docs + tests:** 4.1/4.2 roadmap/CLAUDE.md sync, Layer-1 test harness (4.5), constants module, retire LOGIC_ERRORS_REPORT.md; delete pass-2 dead code (4.10).
6. Tier-3 cleanups and Bucket 2 items opportunistically alongside touched files.
