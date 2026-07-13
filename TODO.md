# To-Do List

- **Fable Audit — Steps 1-5: DONE, merged to main** (2026-07-10 – 2026-07-12, PRs #16-19). Covers the audit's full "Suggested Fix Order" 1-5: one-line fixes, state-machine guards, rating-barrier sweep (grew to ~15 call sites beyond the 4 named findings — see Fix Progress "Scope expansion"), NextTurn result-checking + `departWriter`/`closeStoryInternals` consolidation, and docs/constants module/Layer-1 tests/dead-code cleanup. Full step-by-step detail (including two real bugs caught by a pre-merge independent code review: a dead-`0`-literal regression in `_myStoryList.js`'s paused-view query, and a documented-but-never-applied `log()` fix in `read.js`) lives in [docs/Fable_Audit_Fix_Progress.md](docs/Fable_Audit_Fix_Progress.md); findings are numbered in [docs/Fable_Audit_2026-07.md](docs/Fable_Audit_2026-07.md). Also folded in along the way: the restricted-guild policy decision (1.39/5.12 — no restricted channel configured means all stories, including M/E, stay in the main feed with ratings informational-only) and a user-flagged bug (not from the audit) where the writer-join panel posted publicly instead of ephemerally via the "Join" button.
  - **NOT YET RUNTIME-VERIFIED** — no isolated test guild/DB has been available for any step; confidence rests on `node --check` (clean on every touched file) and the Layer-1 suite (56/56 passing). Before trusting this in production: watch migration 021 apply cleanly on the next deploy, and manually exercise quick-mode write+finalize on a restricted (M/E) story, a finalize/timeout race, and closing a story with both a restricted and unrestricted thread.
  - **Still open:**
    - 1.23 — message-fetch caps (`_writeFinalize.js`, `_turn.js`, limit 100/50) silently drop content past the cap on very long turns; needs `before`/`after` cursor pagination.
    - 2.4 — `job-runner.js` rebuilds a synthetic guild/role context per job even when several queued jobs target the same guild in one tick; needs per-tick context caching.
    - 1.14 — join capacity race: `handleJoinConfirm` (`join.js`) re-validates `max_writers` outside the transaction; needs the check moved inside (`SELECT ... FOR UPDATE` or a conditional INSERT).
    - `_writeSkip.js`'s `handleThreadDeleteNow` auth check (owner/creator/admin) is hand-rolled — a 4th near-duplicate of this pattern in the codebase; extract to a shared helper next time one of the ~3 other copies is touched.
    - `story/list.js`'s `getStoriesPaginated` param assembly (fixed prefix + dynamic filter params + fixed suffix across 3 separate queries) is fragile to eyeball — worth restructuring into one incrementally-built params array if the `/story list` overhaul below is picked up.
    - `_managePauseResume.js`'s story-level thread retitle (`applyPauseActions`/`applyResumeActions`/`handleReopenStory`) still uses inline `.replace()` instead of `replaceTemplateVariables` — covered by the standing inline-`.replace()` compliance sweep below, no separate item needed.
    - Windows-only, not fixed, doesn't affect the Linux-hosted bot: `loadConfig()` in `utilities.js` can't resolve `config.json` via `import.meta.url` when run directly with `node` on Windows — blocks local dev/testing only.

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

## other adjacent issues 
- updateStoryStatusMessage never actually throws (it catches internally), so the .catch(err => log(...)) wrappers are technically dead code — but that's a pre-existing pattern from departWriter, not something this PR introduces.
- commands/_myStoryManage.js's resume log line uses "mystory manage resume" instead of the actual function name, deviating from CLAUDE.md's functionName failed for [context] convention — but it matches a sibling line already in that same function, so it's pre-existing house-style drift, not new

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