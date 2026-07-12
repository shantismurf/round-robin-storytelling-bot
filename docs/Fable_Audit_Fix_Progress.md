# Fable Audit Fix Progress — Steps 1-3 (single session, 2026-07-10)

Branch: `fable-audit/steps-1-3`. Per user direction, doing steps 1-3 in one sitting
(deviating from the "one step per session" default in TODO.md), with a separate
commit per step so they can be reviewed/reverted independently. PR + merge + SemVer
bump to 3.1.0 happens after all three are done and tested.

Note: origin/main already merged a join.js fix (PR #15) before this session started.
It closes the join-duplicate race inside StoryJoin's transaction, but does **not**
add a capacity re-check inside the transaction — 1.14's capacity race is still open.
Not in scope for steps 1-3 (it's a Tier-2 state-machine item not on the fix-order
list); flagged here for a future session.

## STATUS AS OF SESSION END: all 3 steps done, committed, NOT yet verified at runtime

3 commits on `fable-audit/steps-1-3` (a3853cc, 87b1f75, cbcad61). package.json bumped
to 3.1.0. Attempted DB-level verification against the real remote MariaDB
(bot-hosting.net) — connected successfully, confirmed live schema/data, but the user
correctly declined to let me run any write-based check against production data with
no rollback path, and no isolated test guild/token or local DB (Docker daemon down)
was available. **Nothing in this diff has been runtime-verified** — confidence rests
entirely on `node --check` (clean on every touched file) and careful manual tracing
against `db/init.sql` + migrations during implementation. See TODO.md's Fable Audit
entry for the specific manual-test checklist to run before trusting this in production.

Read this whole file before touching anything in steps 1-3's area again — it records
several judgment calls (see "Deliberately NOT touched" under each step) about what's
in scope vs. deferred, and the reasoning for each so a future session doesn't
re-litigate them from scratch.

## Step 1 — One-line/one-word fixes with outsized impact

Target findings: 1.1, 1.2, 1.5, 1.6, 1.9, 1.3, 1.4, 1.30, 1.31, 1.32, 1.33, 1.34, 1.35, 1.47

- [x] 1.1 quick_mode -> mode (`story/_writeQuickMode.js:35`)
- [x] 1.2 getSelectMenuValues -> getStringSelectValues (`story/add.js` x5), removed dead fallback chain in `manage.js`
- [x] 1.5 add sw.discord_user_id to SELECT (`job-runner.js` handleTurnTimeout)
- [x] 1.6 add missing deleteThreadAndAnnouncement import (`story/_writeSkip.js`)
- [x] 1.9 status 4 guard fix (`job-runner.js` handleCheckStoryDelay pre-check, was `!== 2`)
- [x] 1.3 add summary column to INSERT (`storybot.js` CreateStory)
- [x] 1.4 map state.notifications -> notificationPrefs 'dm'/'mention' (`story/add.js`)
- [x] 1.30 reordered exact `story_edit_restore_cancel` check before the `startsWith('story_edit_restore_')` branches (`story/edit.js`)
- [x] 1.31 list nav parse via parts.at(-1) + slice(2,-1).join('_') for filter (`story/list.js`)
- [x] 1.32 String(entryId) compare against pendingRepostEntryId (`story/edit.js`)
- [x] 1.33 keyed warningLabels map by option key not label (`story/_metadata.js`)
- [x] 1.34 added lblSetupModalFieldRole + txtSetupModalPlaceholderRole to setup config batch (`commands/_storyadminSetup.js`)
- [x] 1.35 unconditional upserts (write '' when cleared) for media/restricted-feed/restricted-media/adminRole (`commands/_storyadminSetup.js`)
- [x] 1.47 removed erroneous ` + ' ##'` append on footer text (config string already contains '##' heading markup) (`commands/_storyadminSetup.js`)

Deliberately NOT touched (out of step-1 scope per audit's fix-order list, noted for a future session):
- 1.7 (skip delete/keep choice ignored) — same file as 1.6 but needs a `deleteNow` flag threaded through `endTurnThread`, a behavioral change not a one-liner.
- 1.24 (can't unset rating/dynamic in add/manage metadata modal) — Tier-3, not in step 1's list.
- 1.54-style inline `.replace()` on config strings spotted in job-runner.js:193 and _writeSkip.js:172 — pre-existing, separate TODO.md compliance sweep already tracks this.
- 1.14 join capacity race — already partially addressed by origin/main PR #15 (dupe-join race closed inside StoryJoin's transaction) but capacity re-check is still only pre-transaction in join.js. Not on the step 1-3 fix-order list; flagging for later.

All 10 touched files pass `node --check`. No remaining references to `getSelectMenuValues` or `quick_mode` anywhere in the codebase.

## Step 2 — State-machine guards

Target findings: 1.11, 1.8, 1.13, plus pass-2: 1.40 call sites, 1.43, 1.44, 1.45

- [x] 1.11 added shared `endTurnGuarded(connection, turnId)` helper in `story/_turn.js` — atomic
      `UPDATE turn SET turn_status=0 ... WHERE turn_id=? AND turn_status=1` + affectedRows check,
      cancels the turn's pending jobs (status 3) on success. Applied to: `_writeFinalize.js`
      (doFinalizeEntry), `job-runner.js` (handleTurnTimeout), `_writeQuickMode.js` (confirmEntry,
      replacing the old non-atomic SELECT-then-check), `_turn.js` (skipActiveTurn, now returns
      bool), `_manageTurnActions.js` (skip + reassign, both check the return and abort politely
      with txtWriteTurnEnded on a stale turn).
      Unique-key half: added `db/migrations/021_story_entry_confirmed_unique.sql` — generated
      column + unique index constraining only `entry_status='confirmed'` rows (turns legitimately
      carry pending/discarded/deleted rows too). **User confirmed via production query
      (`SELECT turn_id, COUNT(*) ... WHERE entry_status='confirmed' GROUP BY turn_id HAVING
      COUNT(*)>1`) that no existing duplicates exist**, so the migration is a straight ALTER TABLE,
      no de-dupe step. This makes the existing (previously inert) `ER_DUP_ENTRY` handler in
      `_writeFinalize.js` finally meaningful.
- [x] 1.8 `_writeQuickMode.js` handleWriteModalSubmit — now resolves the current active turn
      FIRST, then scopes the pending/discarded entry lookup to `turn_id = <current turn>` only
      (was: any pending/discarded row for user+story regardless of turn, which reused stale
      rows from dead turns and permanently blocked resubmission per 1.8's failure scenario).
- [x] 1.13 job-runner.js: `processJob` now sets `job_status=4` (new "completed" status) on
      success; guild-gone path now sets status 3 (was: left at 1 forever in both cases).
      `startJobRunner` is now async and re-queues (status 1 -> 0) any job stuck in-progress at
      boot — a job only sits at 1 while its handler runs synchronously, so anything at 1 on
      startup was orphaned by a crash/restart. Added a once-per-day purge of status
      2/3/4 rows older than 30 days (`JOB_PURGE_EVERY_N_TICKS`). Updated `system_roadmap.md`'s
      job registry table with the new status code and the requeue/purge behavior.
- [x] 1.40 extended the 1.11 guard to the five remaining call sites: `_manageUser.js` (pause,
      remove) and `commands/_myStoryManage.js` (panel pass/pause/leave). All now check
      `endTurnGuarded`'s return before touching the thread or calling PickNextWriter/NextTurn,
      and abort with a clear message instead of silently no-op'ing on a stale turn.
      `handlePanelPassConfirm`'s missing null-guard on `nextWriterId` (called out specifically
      in 1.40) is also fixed — now `if (nextWriterId) await NextTurn(...)` like its siblings.
- [x] 1.43 roundup finally-reschedule: reworked `handleWeeklyRoundup` so the job_log dedup
      INSERT happens AFTER a successful send (was: before, so a retry of a failed window
      would see its own dedup row and skip posting forever — silently losing that week).
      Dedup check is now a plain SELECT before attempting to post. Reschedule
      (`scheduleNextRoundup`) happens on every non-throwing path (duplicate/disabled/
      no-channel/success) directly in roundup.js; on a genuine send failure the function
      re-throws WITHOUT rescheduling so job-runner's existing 3-attempt/5-min-backoff retry
      gets first crack — job-runner's permanent-failure branch now reschedules on the
      roundup's behalf only once retries are exhausted, so the job's own retry slot is never
      cancelled out from under it by a premature reschedule.
      IMPORTANT CONTEXT (user flagged mid-session): earlier version of this bot had a real
      incident, dozens of weeklyRoundup jobs piling up once per restart (git commit e4ab6df,
      "Fix weekly roundup posting 38 times"). Root cause then was a `scheduleAllRoundupJobs()`
      startup scan with a weak dedup check — that function no longer exists in the codebase.
      Verified this 1.43 change and the 1.13 startup-requeue don't recreate that startup-
      insertion path (requeue only flips status 1->0, never inserts a new row); worst case
      residual risk is one possible duplicate post if a job crashes after send but before the
      job_log write — bounded/rare, not the old unbounded pile-up.
- [x] 1.44 tag approval — wrapped `handleTagReviewButton`'s approve/reject in a real
      transaction: submission status transition is now `WHERE submission_status='pending'` +
      affectedRows check (same pattern as endTurnGuarded) so two concurrent reviews of the same
      submission can't both proceed; the story.tags read-modify-write now uses
      `SELECT tags FROM story WHERE story_id=? FOR UPDATE` inside the transaction to serialize
      concurrent approvals for the same story, and checks `existingTags.includes(tagText)`
      before appending to prevent the same tag being added twice.
- [x] 1.45 catchup session keying — nav button customIds (`catchup_prev_/next_`) now encode
      storyId; handleCatchUpNavigation builds the exact session key
      (`catchup_<userId>_<storyId>`) instead of grabbing the first `.find()` match for that
      user, so two catch-up sessions open at once no longer cross-contaminate.

All 12 touched files (`story/_turn.js`, `story/_writeFinalize.js`, `story/_writeQuickMode.js`,
`job-runner.js`, `story/_manageTurnActions.js`, `story/_manageUser.js`,
`commands/_myStoryManage.js`, `story/roundup.js`, `story/tags.js`, `commands/_myStoryList.js`,
`index.js`, plus `db/migrations/021_story_entry_confirmed_unique.sql`) pass `node --check`.

Deliberately NOT touched (out of step-2 scope, noted for later):
- `close.js:124`'s unguarded turn-end UPDATE — not named in 1.11 or 1.40's site lists; closing
  a story is a lower-risk terminal action.
- 1.41 (admin/panel paths destroy drafts instead of preserving 24h like skip/timeout) — same
  files as 1.40 but a different, not-explicitly-assigned behavioral change (route through
  endTurnThread instead of immediate delete). Flagged for a future session alongside 1.7.
- 1.17 (job cancel status inconsistency: pause/resume use status 2 instead of 3, and some
  INSERTs omit turn_id) — related to 1.13 but not explicitly named in the step-2 list.

**Note on 1.43 (roundup finally-reschedule):** user flagged mid-session that an earlier
version of this bot had a real incident — dozens of weeklyRoundup jobs piling up, one
per restart (git commit e4ab6df, "Fix weekly roundup posting 38 times"). Root cause then
was a `scheduleAllRoundupJobs()` startup scan with a weak existence check. That function
no longer exists in the codebase — current design uses job_log as the single dedup
source instead of a startup scan. Verified my 1.43 change (moved job_log write to after
successful send, kept scheduleNextRoundup's cancel-before-insert untouched, added
job-runner-side reschedule only on exhausted retries) does not reintroduce a startup
insertion path. Traced the interaction with my own 1.13 fix (startup requeue of stuck
status-1 jobs) too — requeue only flips status 1->0, never inserts, so no multiplication
risk; worst case is one possible duplicate post if a job crashed after send but before
the job_log write, which is a bounded/rare edge case, not the unbounded pile-up from before.

## Step 3 — Rating-barrier sweep

Target findings: 1.36, 1.37, 1.38, 1.39/5.12 (policy decision already made). This step grew
substantially beyond its original scope — see "Scope expansion" below. Everything listed here
is done.

### Originally-assigned findings

- [x] 1.36 repost routes through getActiveThreadId (`story/edit.js` handleRepostEntry) — added
      `rating, restricted_thread_id` to the SELECT.
- [x] 1.37 export "Post to Story Thread" routes through getActiveThreadId (`story/export.js`
      handleExportPostPublic).
- [x] 1.38 tag proposals/votes route through getActiveThreadId — fixed 6 call sites total:
      `story/_tagSubmit.js` (submit-post, delete-thread-post, delete-success-link) and
      `story/tags.js` (handleViewProposedTags, handleEditTagsButton, handleTagReviewNav,
      handleTagReviewButton x2 including the remaining-tags panel rebuild, legacy
      handleViewTagsButton).
- [x] 1.39/5.12 policy applied in `story/manage.js` handleManageSave: added
      `isRestrictedChannelConfigured(connection, guildId)` helper to `story/_metadata.js`
      (reused, not duplicated, per the sentinel-check pattern already in resolveFeedChannelId).
      Migration is skipped ONLY when moving INTO restricted with no restricted channel
      configured — moving back OUT of restricted still migrates normally (that direction
      can't create a redundant thread; confirmed this distinction with the user after an
      initial draft of the guard would have wrongly blocked legitimate de-rating migrations
      when a restricted channel IS configured).

### Scope expansion — same bug class found well beyond the audit's 4 named findings

While fixing 1.36-1.38, checked the actual entry-posting flow (not just repost/export/tags)
and found the identical bug is far more widespread than the audit reported. Confirmed each
one with the user before fixing (this thread-routing bug ended up touching ~15 call sites
total). All confirmed via user discussion and fixed:

- **Primary write flow** (`story/_writeFinalize.js` doFinalizeEntry, `story/_writeQuickMode.js`
  confirmEntry) — the entry an M/E-rated story's writer submits was posting to the
  unrestricted thread instead of the restricted one. This is the main path every entry goes
  through, not an edge case — arguably higher-impact than any of the audit's named findings,
  and the audit didn't catch it.
- `story/_managePauseResume.js` handleReopenStory (audit's own **1.19**, previously
  unassigned) — reopening only retitled the unrestricted thread.
- `story/close.js` handleCloseConfirm — per user guidance, a story with threads in BOTH
  restricted and unrestricted space should get story-level lifecycle actions (retitle) on
  BOTH threads, not just "the active one" — only the close message + export buttons post
  once, to the active thread. Rewrote the retitle loop accordingly.
- `story/join.js` handleJoinConfirm — new writer was only added as a Discord thread *member*
  of the unrestricted thread, so on a restricted story they couldn't see/post in the private
  thread they'd actually be writing in.
- `story/ping.js` handlePing (`/story ping`) — posted to the wrong thread.
- `story/timeleft.js` handleRequestMoreTime — same (handleTimeleft itself is unaffected; it
  selects story_thread_id but never uses it, replies ephemerally instead).
- **Feed-channel routing** (separate from thread routing, caught when the user asked "does any
  feed announcement have this bug"): `announcements.js` postStoryFeedClosedAnnouncement was
  the only one of 4 announcement functions hardcoding `cfgStoryFeedChannelId` instead of
  calling `resolveFeedChannelId(connection, guildId, rating)` like its siblings (join/create/
  activate announcements were already correct) — added a `rating` param (default 'NR') and
  fixed the call site in close.js to pass `story.rating`.
- `job-runner.js` sendMentionReminder (turn reminder mention-fallback, used when DM fails or
  the writer prefers mention notifications — Discord doesn't deliver pings inside threads,
  which is why this posts to a channel instead) — same hardcoded-main-feed bug, fixed for both
  the normal/quick and slow-mode reminder paths (4 call sites); also fixed the turn-thread-link
  fallback in both reminder functions to use getActiveThreadId instead of bare story_thread_id.
- `story/_managePauseResume.js` applyResumeActions — resume notification's mention-fallback
  (both branches: primary mention path and DM-failed fallback) had the same hardcoded main-feed
  bug; also fixed its thread-link fallback.

### Explicitly NOT touched (checked, confirmed out of scope or not a live bug)

- `commands/storyadmin.js` handleDeleteConfirm (`/storyadmin delete`) — same class of bug
  (only deletes/references story_thread_id), but this is audit finding **1.42**, explicitly
  assigned to step 4's `closeStoryInternals` extraction (needs job cancellation + status
  message handling bundled in too, not a simple thread-id swap). Left alone.
- `utilities.js` sendUserMessage — has the same hardcoded-feed-channel bug internally, but
  it's dead code with zero callers anywhere in the codebase (confirmed via grep) and already
  separately broken (references an undefined `connection` var — audit finding **1.29**,
  assigned to step 5 cleanup). Not fixed; would have zero runtime effect since nothing calls it.
- `utilities.js` createThread — same story, audit finding 1.29, dead + already broken, step 5.
- `_managePauseResume.js` applyPauseActions/applyResumeActions's OWN inline
  `isRestricted(state.rating) && restricted_thread_id` ternaries (used for the story-thread
  title update, separate from the mention-fallback bug fixed above) — already correct, just
  written inline instead of calling getActiveThreadId. Left as stylistic duplication, not a bug;
  not worth the risk of touching working code that uses `state.rating` as its data source
  (slightly different from the fresh-query pattern used everywhere else) this late in the
  session.
- `story/read.js`, `story/timeleft.js` handleTimeleft — select story_thread_id but never
  actually use it to post anywhere (ephemeral replies only); not a routing bug, just an unused
  column in the query.
- `commands/_myStoryManage.js`, `story/_manageUser.js` thread fetches — all use
  `activeTurn.thread_id`/`activeTurnThreadId` (the writer's own private turn thread), not the
  story-level feed thread. Correct as-is, different concern entirely.

All files touched in this expanded step 3 pass `node --check`:
`story/edit.js`, `story/export.js`, `story/_tagSubmit.js`, `story/tags.js`, `story/manage.js`,
`story/_metadata.js`, `story/_writeFinalize.js`, `story/_writeQuickMode.js`,
`story/_managePauseResume.js`, `story/close.js`, `story/join.js`, `story/ping.js`,
`story/timeleft.js`, `announcements.js`, `job-runner.js`.

## Step 4 — NextTurn result-checking + departWriter/closeStoryInternals consolidation (2026-07-12)

Branch: `claude/fable-audit-next-steps-fbfult`. Target findings: 1.10(a)/(c), 1.7, 1.17, 1.41, 1.42,
plus the `_writerDeparted.js` 6th-duplicate-site item flagged earlier this session. Scoped
deliberately: the full 1.10(b)/1.12 advanceTurn/notifyTurn DB-Discord split was left for the
Phase 2 web-interface session (see TODO.md) — this pass fixes the "silently stalled and
invisible" failure mode without touching NextTurn's internals or transaction boundaries.
3 commits (`ea037af`, `cb30366`, `ea1cc96`), **not yet runtime-verified** — same constraint as
steps 1-3, no isolated test guild/DB available this session; confidence rests on `node --check`
(clean on every touched file) and manual tracing against the existing endTurnGuarded/endTurnThread
patterns already proven in steps 1-3.

**4a — job-cancel status + skip delete/keep** (1.17, 1.7):
- 1.17: `_managePauseResume.js` (pause, resume) and `_manageTurnActions.js` (extend) cancelled
  superseded jobs with `job_status=2` via `JSON_EXTRACT` payload matching instead of the
  `turn_id` column + status 3. Standardized both on `WHERE turn_id = ? AND job_status = 0` /
  status 3, and added `turn_id` to the replacement job INSERTs so NextTurn's own
  cancel-by-turn_id can find them later.
- 1.7: added a `{ forceDelete }` option to `endTurnThread` (`_turn.js`); `_writeSkip.js`'s
  `handleSkipConfirm` now passes `forceDelete: variant === 'delete'`, so Delete actually
  deletes immediately instead of silently behaving like Keep.

**4b — departWriter/closeStoryInternals** (1.41, 1.42, the `_writerDeparted.js` consolidation):
- Added `closeStoryInternals(connection, ctx, storyId)` in `_turn.js`: end any still-active
  turn, cancel every pending job tied to the story's turns, set `story_status=3`, retitle
  every existing thread (unrestricted and/or restricted), refresh the status message. Always
  silent — `close.js` calls it then layers its own public close-message/export-buttons/feed-
  announcement on top (unchanged from before, just no longer duplicating the shared part).
- Added `departWriter(connection, ctx, storyId, writerId, discordUserId)` in `_turn.js`: end
  the writer's active turn if any (24h-preserve via `endTurnThread`, not immediate delete),
  flip `sw_status=0`, then close-or-advance via `closeStoryInternals` or
  `PickNextWriter`+`NextTurn`. Replaces duplicated logic in three places: `_manageUser.js`
  (admin remove), `commands/_myStoryManage.js` (panel leave), and `_writerDeparted.js` (guild
  leave/ban sweep) — the six near-identical call sites flagged earlier this session collapse
  into one implementation.
- The three "yield without leaving" sites — admin pause (`_manageUser.js`), panel pass and
  panel pause (`commands/_myStoryManage.js`) — get the smaller half of 1.41: swapped their
  immediate `thread.delete()`/`deleteThreadAndAnnouncement` calls for `endTurnThread` so a
  paused/passed writer's draft gets the same 24h grace as skip/timeout, without needing the
  full departWriter treatment (they don't leave the story).
- `/storyadmin delete` (`commands/storyadmin.js`) now cancels the story's pending jobs before
  the cascade-delete (previously they fired later against a dangling `turn_id`) and deletes
  both `story_thread_id` and `restricted_thread_id` (previously only the unrestricted thread
  was deleted, leaking the restricted one on any story that had migrated).

**4c — NextTurn result-checking** (1.10a/c): NextTurn catches its own errors internally and
returns `{success:false}` rather than throwing, but nothing checked the result — a Discord
hiccup during thread creation, or an unguarded null `PickNextWriter`, left a story with an
ended turn and no successor, invisible until an admin happened to look. Swept all 16 call
sites (`job-runner.js` x2, `storybot.js` x2, `commands/_myStoryManage.js` x2,
`story/_managePauseResume.js` x2, `story/_manageTurnActions.js` x3, `story/_manageUser.js`,
`story/_writeFinalize.js`, `story/_writeQuickMode.js`, `story/_writeSkip.js`, plus
`departWriter` itself from 4b):
- `CreateStory` (`storybot.js`) now throws on failure/no-writer to trigger its existing
  transaction rollback — safe there specifically because nothing has been shown to the user
  yet, unlike a mid-flow finalize.
- Every other site now hub-logs (`show:true, hub:true`) a clear "story has no active turn"
  alert on failure or a missing next writer, without changing the surrounding commit/reply
  behavior. Turns an invisible stall into something `#logs` actually surfaces, per 1.10(c),
  without the larger DB/Discord split.
- Found and fixed one additional site while doing this sweep: `_writeSkip.js`'s
  `handleSkipConfirm` had its own unguarded `UPDATE turn SET turn_status = 0` — it was missed
  by step 2's `endTurnGuarded` rollout entirely (not in that step's site list). Now uses
  `endTurnGuarded` like every other turn-ending path.

Deliberately NOT touched (out of step-4 scope, noted for later):
- 1.10(b)/1.12 — the actual advanceTurn/notifyTurn split (DB-only turn creation separated from
  Discord thread-create/notify) and the Discord-calls-inside-transactions problem it would
  fix. Earmarked for the Phase 2 web-interface session per TODO.md — this pass only adds
  result-checking around NextTurn as currently structured.
- 1.14 (join capacity race) — flagged repeatedly as out-of-scope for steps 1-4, still open,
  still a standalone fix whenever (unrelated code path, `join.js`'s transaction).

All 13 touched files pass `node --check`: `story/_turn.js`, `story/_managePauseResume.js`,
`story/_manageTurnActions.js`, `story/_writeSkip.js`, `story/_manageUser.js`,
`commands/_myStoryManage.js`, `story/_writerDeparted.js`, `story/close.js`,
`commands/storyadmin.js`, `job-runner.js`, `storybot.js`, `story/_writeFinalize.js`,
`story/_writeQuickMode.js`.

---

## Log

**2026-07-12** — PR #17 (outside steps 1-3, separate session) added `story/_writerDeparted.js`
for the leave/ban auto-remove feature, explicitly mirroring `handlePanelLeaveConfirm`'s
protocol. It correctly picked up the step-2 `endTurnGuarded` fix, but also copied that
handler's two known-open bugs as a new (6th) call site of the same end-turn/delete-thread/
close-or-advance routine:
- **1.41**: `deleteThreadAndAnnouncement` called immediately on turn-end, no 24h draft
  preservation.
- **1.42**: last-writer departure does `UPDATE story SET story_status=3` only — no job
  cancellation, no status-message update, no thread cleanup. Third site with this exact
  half-close bug (alongside `_manageUser.js:359`, `_myStoryManage.js:408`).

Decision: don't patch 1.41/1.42 in each of the now-6 duplicate sites (`_manageUser.js`
pause/remove, `_myStoryManage.js` pass/pause/leave, `_writerDeparted.js`). Fold into step 4:
extract the interaction-agnostic core (end turn → 24h-preserve-or-delete thread → flip
`sw_status` → close-or-advance) into `departWriter(connection, ctx, storyId, writerId)` in
`_turn.js`, alongside the planned `closeStoryInternals`. `handlePanelLeaveConfirm` and the
admin pause/remove handlers keep their interaction-specific reply logic but call
`departWriter` for the shared part; `_writerDeparted.js` calls it directly. This turns a
6-site bug into a 1-site fix and gives step 4's Phase-2 seam one more reusable function for
free.

**Sequencing decision:** 1.7 (skip's delete/keep choice ignored) and 1.17 (job-cancel status
inconsistency — pause/resume use status 2 instead of 3, some INSERTs omit `turn_id`) both
touch the same turn-end/thread-disposal/job-cancellation surface that step 4 is already
opening up for `departWriter`/`closeStoryInternals`. Fold both into step 4 rather than
reopening those files in a separate session. 1.14 (join capacity race) lives in unrelated
code (`join.js`'s transaction, re-checking `max_writers` inside the existing transaction) and
doesn't depend on anything step 4 touches — fine as a standalone fix any time, no need to
wait.

## Step 5 — Docs/constants/tests/dead-code + opportunistic Step 6 folds (2026-07-12)

Branch: `fable-audit/step-5`. Target: audit's Suggested Fix Order item 5 (4.1/4.2 docs sync,
constants module closing LOGIC_ERRORS #11, Layer-1 test harness per 4.5, dead-code deletion
per 4.10/1.29) plus opportunistic Step 6 folds per the 2026-07-12 TODO.md sequencing decision.
A fresh Explore survey at the start of this session confirmed which Tier-3/Bucket-2 findings
were still live before starting (some had been incidentally closed by steps 1-4), and found
one stale TODO.md item (StoryJoin's `dmMessage` is computed from `NextTurn`'s return value,
not hardcoded — that cleanup item was dropped from scope). **Not yet runtime-verified** — no
isolated test guild/DB available this session either, same constraint as every prior step;
confidence rests on `node --check` (clean on all 35 touched files + `constants.js` + 6 new
test files) and the full Layer-1 suite (56/56 passing).

### 1. Constants module + full sweep (closes LOGIC_ERRORS #11)

Created `constants.js` at the project root: `STORY_STATUS`, `TURN_STATUS`, `JOB_STATUS`,
`WRITER_STATUS`, `ENTRY_STATUS`, `STORY_MODE` — values verified against `db/init.sql` +
migration 015 (story.mode rename) + migration 003 (entry_status ENUM), not assumed from the
audit doc. Confirmed via `commands/_myStoryList.js`'s own `story_status IN (0, 2, 4)` guard
that a bare `0` status is a defensive catch-all, not a real 5th story status — no code path
ever sets it, no migration documents it — so no constant was added for it.

Swept **all 33 files / 291 occurrences** the user approved doing in one pass (a pure rename,
each substitution semantically identical to the original — same value, same comparison
operator, no logic changes). Two agent passes handled most of the mechanical work
(18 files), but both needed correction after review:
- The first agent stalled mid-file after 8 files; all 8 were reviewed line-by-line and found
  correct before resuming.
- The second agent completed 10 of 25 assigned files before exhausting its context budget,
  self-reporting exactly which 15 it didn't reach. Of the 10 it did finish, a **live SQL
  parameter-count bug** was found and fixed by hand in `story/list.js` (converted a literal
  `sw_status = 1` to a `?` placeholder but never added the corresponding param — would have
  thrown or silently misbound at runtime), plus 3 missed literals in `commands/_myStoryList.js`,
  `story/export.js`, and `story/edit.js`. A read-only audit agent then re-verified all 10
  files' SQL placeholder-vs-param counts by hand and found zero further issues.
- The remaining 15 files, plus a final full-codebase grep sweep (which caught several more
  spots the agents missed — `job-runner.js`, `_storyStatus.js`, `add.js`, `manage.js`,
  `_metadataModals.js`, `_turn.js`, `utilities.js` each had at least one leftover literal),
  were done by hand with a `node --check` after every file and a widening series of grep
  patterns to catch what narrower ones missed (bare `.mode ===`, `state.storyMode`,
  `entry_status = '...'` string literals, `IN (...)` clauses). **Lesson for future sweeps of
  this kind:** narrow regex patterns reliably under-count; budget for at least 2-3 progressively
  broader re-sweeps of the whole codebase after the "first pass" looks done, and never trust an
  agent's self-reported completion on a mechanical, high-file-count task without spot-checking
  diffs — both agents produced correct work where they finished, but neither caught everything
  in scope.

**Also fixed while sweeping** (files opened for the sweep, folded in per the Step 6
opportunistic-fold decision):
- **1.18**: `_managePauseResume.js`'s `applyPauseActions` replaced a `[turnEndTime]` token
  that doesn't exist in `txtTurnThreadTitle` with the hardcoded literal `'PAUSED'` — a
  double bug (broken token + hardcoded text). User chose the fix: added an optional
  `{? ([status])?}` token to `txtTurnThreadTitle` in `config_turn.sql`, populated with the
  existing `txtPaused` config value via `replaceTemplateVariables` (not inline `.replace()`).
  Active threads render unchanged (`Turn 3 - Story ID: 12 - Alice`); paused ones now show
  `Turn 3 - Story ID: 12 - Alice (Paused)`.
- **1.54 (partial)**: inline `.replace('[writer_name]', ...)` → `replaceTemplateVariables`
  in `story/_manageUser.js` and `story/_writeSkip.js` (a second site of the same bug found
  while touching that file for the sweep). `story/read.js`'s `log(msg, ['', guildId])`
  array-as-options-object misuse fixed to `{ show: false, guildName }`.
- **`closeStoryInternals`'s inline `.replace()`** (`story/_turn.js`, flagged by the step-4
  code review) — converted to `replaceTemplateVariables`.
- **1.15**: `story/_writeSkip.js`'s `handleThreadDeleteNow` had no authorization check at
  all — any user who could see the button could delete another writer's preserved draft
  thread. Added a lookup from `thread_id` back to the owning turn/writer/story, gating the
  delete to the draft owner, the story creator, or an admin.

### 2. Dead code deletion (4.10 + 1.29)

Confirmed genuinely dead (zero callers) and removed:
- `utilities.js`: `createThread` (already broken — undefined `connection` var, the old
  `permissionOverwrites.create()` mistake) and `sendUserMessage`.
- `storybot.js` / `index.js`: the `StoryBot extends EventEmitter` class, `emitPublish`, and
  the `bot.on('publish')` listener — the "engine emits, gateway renders" design had zero
  real callers; `bot.start()`'s only effect (a startup log line) was preserved inline.
- `commands/storyadmin.js`: `handleModalTest` + `handleModalTestSubmit` (marked `[TEMP]` in
  their own comment, no `modaltest` subcommand registered) and the now-unused
  `TextDisplayBuilder`/`LabelBuilder`/`ChannelSelectMenuBuilder`/`ModalBuilder`/
  `TextInputBuilder`/`TextInputStyle` imports they were the only users of.
- `story/_manageUser.js`: unused `stagedNotificationPrefs`/`stagedWriterTurnPrivacy` state
  fields and the `btnAdminMUToggleNotif`/`btnAdminMUTogglePrivacy` config keys (fetched,
  never referenced — the panel actually uses `btnManageUserSwitchMention`/
  `btnManageUserMakePublic`/etc., a different key set).

**Explicitly NOT deleted** (re-verified live, contradicting the original audit note as
"legacy/unreachable"): `story/tags.js`'s `handleViewTagsNav` — it **is** called, routed via
the `story_view_tags_` customId prefix check in `commands/story.js`. Only the thin wrapper
`handleViewTagsButton` (which called `handleViewProposedTags` and was never itself invoked)
was actually dead; deleted that one function only.

### 3. Docs sync (4.1, 4.2)

- **`system_roadmap.md`**: added the 16 missing `story/_*.js` modules to the File Inventory
  table with accurate one-line purpose descriptions (read each file's exports rather than
  guessing from filenames), plus the new `constants.js`.
- **`CLAUDE.md`**: rewrote the "High-level Architecture" section — proposed to the user per
  the no-silent-edits-to-user-facing-text convention, user provided final wording (added
  detail on `index.js`'s `deploy.js` responsibilities, reworded the storybot.js bullet).
  Corrects "storybot.js (The Engine)" to reflect that the engine now lives in `story/_*.js`.

### 4. Retired LOGIC_ERRORS_REPORT.md

Added a header note marking it superseded by `docs/Fable_Audit_2026-07.md`, per the audit's
own disposition table — kept the file for history rather than deleting it.

### 5. Layer-1 test harness (4.5)

`test/_fakeConnection.js` — a scripted-queue fake `connection.execute()` matching
mysql2/promise's `[rows]` return shape. `package.json`'s `test` script changed from the
placeholder to `node --test "test/**/*.test.js"` (a bare `node --test test/` directory
argument fails on this Windows/Node 22 setup — treated as a `require()` path, not a glob
root — so the explicit glob is load-bearing, not stylistic).

6 test files, 56 tests, covering the audit's full suggested list:
- `test/_turn.test.js` — `PickNextWriter`, all 3 order types + admin override + the cycle-reset
  fallback (exercises 1.26's documented ambiguity directly).
- `test/_delay.test.js` — `checkStoryDelay`, writer-count and hour-delay boundaries, plus a
  regression guard pinning 1.9's fix (delayed-status check, not active-status check).
- `test/_entryRenderer.test.js` — `buildEntryPages` (pagination, scene-break markup, image
  extraction, author-name hiding).
- `test/_metadata.test.js` — `isRestricted`, `crossesBarrier`, `formatWarnings`.
- `test/join.test.js` — `validateJoinEligibility`, all rejection paths + success.
- `test/utilities.test.js` — `splitAtParagraphs`, `parseDuration`, `formatDuration`,
  `replaceTemplateVariables`, `chunkEntryContent`.

### 6. Standalone Step-6 items (1.23, 2.4) — deferred, not done this session

User approved including these in scope, but they were not reached this session — the
constants sweep and its cleanup took longer than planned once the two sweep agents' gaps
had to be manually closed. Both remain open:
- **1.23** — `messages.fetch({ limit: 100/50 })` caps in `_writeFinalize.js`/`_turn.js`
  silently drop content past the cap for very long turns. Needs pagination via discord.js's
  `before`/`after` cursor, with care taken since draft-detection and entry-composition call
  sites may have different correctness requirements.
- **2.4** — `job-runner.js` rebuilds a synthetic guild/role context per job even when
  multiple queued jobs target the same guild in one tick. Needs per-tick context caching
  keyed by guild.

Both are self-contained enough to pick up in a future session without re-deriving context —
flagged in TODO.md.

### 7. User-flagged bug (not from the audit): join panel posted publicly instead of ephemeral

User recalled a bug from their own notes: the writer-join embed (pen name / privacy /
notification selects + confirm/cancel) posted publicly and visibly to everyone in the
channel when triggered via the "Join" **button** (story feed / thread panel), then got
deleted on cancel — only the `/story join` **slash command** path was ephemeral.
Confirmed live in `story/join.js:160`: `handleJoin`'s button-triggered branch called
`interaction.reply(embedData)` with no `MessageFlags.Ephemeral`, while the slash-command
branch did. This predates the Fable Audit entirely — never caught by any pass, and distinct
from audit finding **1.58** (`story_join_thread_cancel_` not acknowledging the interaction
before delete — same button, different bug, same lines).

Fix: both branches now reply ephemeral (collapsed to one `interaction.reply({ ...embedData,
flags: MessageFlags.Ephemeral })` call). Since both join paths are now ephemeral, the
`isThreadMode`/`threadMode` distinction in `buildJoinEmbed` and `handleJoin` (which existed
solely to pick between two cancel-button customIds — `story_join_cancel_` for the
ephemeral/deferUpdate+editReply cancel, `story_join_thread_cancel_` for a raw
`message.delete()`) no longer served any purpose. Removed it: `buildJoinEmbed` no longer
takes a `threadMode` param or reads `state.threadMode`; the join state object no longer sets
it; the cancel button always uses `story_join_cancel_`; `commands/story.js`'s
`story_join_thread_cancel_` branch (and its `message.delete()`) is gone. This also fully
closes **1.58** — the buggy code path it was filed against no longer exists, rather than
just being less visible now that the message is ephemeral.

All 37 touched `.js` files plus `constants.js` and the 6 new test files pass `node --check`.
Full test suite: 56/56 passing.

### 8. Independent code review before merge (2026-07-12)

Ran a fresh-agent, high-effort code review (8 finder angles: line-by-line diff scan,
removed-behavior audit, cross-file tracer, reuse, simplification, efficiency, altitude,
CLAUDE.md conventions) against the full working-tree diff before pushing to main, per user
request. 23 raw candidates surfaced across the angles, deduped and verified down to 7. Two
were real issues, both fixed immediately:

- **`commands/_myStoryList.js`'s paused-view query regressed.** The constants sweep had
  converted a harmless literal `story_status IN (0, 2, 4)` — where `0` was always dead, no
  code path or migration ever writes it to `story.story_status` — into binding
  `STORY_STATUS.ACTIVE` for that slot instead of preserving `0`. This would have leaked
  every story the user is actively writing into their `/mystory list paused` results.
  Confirmed via `git log -p` the literal predates this session (present since the query was
  first written); the *substitution* was the regression, introduced by the mechanical sweep
  treating a defensive dead-value literal as if it were meant to match a real status. Fixed
  in two steps: first restored the literal `0` with an explanatory comment, then — after the
  user asked directly whether a nameless `0` would confuse a future agent into remapping it
  again — removed it entirely instead, since it matches zero possible rows under the current
  schema and a bare unexplained `0` is a standing trap for exactly this class of mistake.
  `whereExtra` for the paused view is now `story_status IN (?, ?)` bound to
  `[STORY_STATUS.PAUSED, STORY_STATUS.DELAYED]` only — verified placeholder count still
  matches the params array (5 filter placeholders: 2 for `IN`, 1 for `!=`, 2 for the
  `ORDER BY CASE`) after the removal.
- **`story/read.js`'s documented fix was never actually applied.** This doc's own item 1
  section (written earlier in this same session) claimed the `log(msg, ['', guildId])`
  array-misuse at three call sites was fixed to `{ show: false, guildName }` as part of the
  1.54 fold-in. It wasn't — the edit was never made, only written up as done. The review
  agent caught this by diffing the actual changes against the documented claim. Fixed for
  real this time (all three call sites in `handleRead`'s restricted-story branch).

**Lesson for future sessions:** a documented fix and an applied fix are not the same thing —
verify doc claims against `git diff`, including a session's own notes about itself, before
trusting them as a record of what actually happened.

**Outstanding findings from the review, left as-is (pre-existing debt or minor, none are
regressions introduced by step 5):**
- `_managePauseResume.js`'s story-level thread retitle (`applyPauseActions`/
  `applyResumeActions`/`handleReopenStory`) still uses inline `.replace()` chains on
  `txtStoryThreadTitle` rather than `replaceTemplateVariables` — confirmed via `git diff`
  these exact lines are untouched by step 5 (pre-existing, distinct from the turn-level
  `txtTurnThreadTitle` fix step 5 made for 1.18). Already covered by TODO.md's standing
  inline-`.replace()` compliance sweep item.
- `_writeSkip.js`'s new `handleThreadDeleteNow` authorization check (this session's 1.15 fix)
  is correct but hand-rolls owner/creator/admin logic inline — a fourth near-duplicate of
  this pattern in the codebase, worth extracting to a shared helper eventually.
- `story/list.js`'s `getStoriesPaginated` params assembly (fixed prefix + dynamic filter
  params + fixed suffix across 3 separate queries) is fragile to eyeball, though re-verified
  correct — the same file/pattern that produced step 5's own earlier param-count bug.
- `story/ping.js`'s SQL-ternary/params-ternary pairing and `_managePauseResume.js`'s
  un-batched `getConfigValue` calls (audit 2.3) are minor, pre-existing, non-blocking.

Full detail on all 7 findings and their disposition logged in TODO.md. Re-ran `node --check`
on the 2 fixed files and the full test suite after applying both fixes: 56/56 passing.
