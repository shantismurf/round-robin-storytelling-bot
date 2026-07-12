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
