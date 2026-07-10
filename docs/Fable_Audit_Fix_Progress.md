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

- [ ] 1.11 guarded turn-end UPDATEs (WHERE turn_status=1 + affectedRows check) + unique key on story_entry.turn_id
- [ ] 1.8 scope pending-entry lookup to current turn
- [ ] 1.13 job completion status + startup requeue
- [ ] 1.40 extend guards to _manageUser.js, _myStoryManage.js call sites
- [ ] 1.43 roundup finally-reschedule + job_log ordering
- [ ] 1.44 tag approval transaction
- [ ] 1.45 catchup session keying by storyId

## Step 3 — Rating-barrier sweep

Target findings: 1.36, 1.37, 1.38, 1.39/5.12 (policy decision already made)

- [ ] 1.36 repost routes through getActiveThreadId (`story/edit.js`)
- [ ] 1.37 export "Post to Story Thread" routes through getActiveThreadId (`story/export.js`)
- [ ] 1.38 tag proposals/votes route through getActiveThreadId (`story/_tagSubmit.js`, `story/tags.js`)
- [ ] 1.39 skip migrateStoryThread entirely when no restricted channel configured (`story/manage.js`)

---

## Log
