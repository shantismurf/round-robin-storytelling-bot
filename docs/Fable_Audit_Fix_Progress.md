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

Target findings: 1.36, 1.37, 1.38, 1.39/5.12 (policy decision already made)

- [ ] 1.36 repost routes through getActiveThreadId (`story/edit.js`)
- [ ] 1.37 export "Post to Story Thread" routes through getActiveThreadId (`story/export.js`)
- [ ] 1.38 tag proposals/votes route through getActiveThreadId (`story/_tagSubmit.js`, `story/tags.js`)
- [ ] 1.39 skip migrateStoryThread entirely when no restricted channel configured (`story/manage.js`)

---

## Log
