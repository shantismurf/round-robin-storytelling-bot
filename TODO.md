# To-Do List

- Fable Audit fixes — see [docs/Fable_Audit_2026-07.md](docs/Fable_Audit_2026-07.md) "Suggested Fix Order" and [docs/Fable_Audit_Fix_Progress.md](docs/Fable_Audit_Fix_Progress.md) for full detail on what steps 1-3 actually touched.
  - **Steps 1-3: DONE 2026-07-10**, all in one session on branch `fable-audit/steps-1-3` (3 commits — PR/merge pending). Step 3 (rating-barrier sweep) grew well beyond its 4 named findings — see the Fix Progress doc's "Scope expansion" section for the full list of ~15 additional call sites fixed (the primary entry-write flow itself had the same bug, plus reopen/close/join/ping/request-more-time/turn-reminders/resume-notifications, plus a separate feed-channel-routing bug in the closed-story announcement).
  - **NOT YET VERIFIED AT RUNTIME.** Syntax-checked and carefully traced against the schema, but never run against a live Discord connection or exercised against the real DB — the hosted bot instance was live during this session so a second connection wasn't safe, and there's no separate test guild/token. Before trusting this in production: watch migration 021 apply cleanly on the next deploy, and manually exercise at least: quick-mode write + finalize on a restricted (M/E) story (confirm the entry posts to the restricted thread), a finalize/timeout race if reproducible, and closing a story that has both a restricted and unrestricted thread.
  - **New pre-existing bug found, NOT fixed (out of scope):** `loadConfig()` in `utilities.js` can't resolve `config.json` when run directly via `node` on Windows (`import.meta.url`'s `/C:/...` pathname breaks `path.resolve`). Only matters for local Windows dev/testing, not the Linux-hosted production bot — but blocked local DB verification this session.
  - **Session plan for remaining steps:** Step 4 (NextTurn restructure + closeStoryInternals extraction) belongs with the Phase 2 web-interface plan: Fable, planned together. Step 5 (docs/tests/constants module) and step 6 (Tier-3 cleanup) still pending — see docs/Fable_Audit_2026-07.md's Suggested Fix Order.
  - **Deliberately left out of steps 1-3, flagged for a future session:** 1.7 (skip delete/keep choice ignored), 1.41 (admin/panel paths destroy drafts instead of preserving 24h), 1.17 (job cancel status inconsistency), 1.42/`storyadmin delete` thread-orphan leak (assigned to step 4's closeStoryInternals), 1.29 (dead code: `utilities.createThread`, `sendUserMessage` — both already broken/uncalled, low urgency).
  - **2026-07-12 addition, fold into step 4:** `story/_writerDeparted.js` (new, post-audit — added in PR #17 for the leave/ban auto-remove feature) copies `handlePanelLeaveConfirm`'s pattern, including its bugs — it's a 6th near-duplicate of the end-turn/delete-thread/close-or-advance routine (alongside `_manageUser.js` pause/remove ×2 and `_myStoryManage.js` pass/pause/leave ×3), so it inherits both 1.41 (deletes the thread immediately instead of 24h-preserving) and 1.42 (last-writer auto-close only sets `story_status=3`, no job cancellation/status-message/thread cleanup). Rather than patching 1.41/1.42 in 6 places, extract the interaction-agnostic core into a shared `departWriter(connection, ctx, storyId, writerId)` helper in `_turn.js` (next to `endTurnGuarded`) as part of step 4 — have `handlePanelLeaveConfirm`, the admin pause/remove paths, and `_writerDeparted.js` all call it, with `closeStoryInternals` handling the close-or-advance branch. One fix instead of six.
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
- Export: "Show Names" controls the entire turn-break header (turn number + name), so exporting with breaks but `show_authors = false` produces no header at all — not even a turn number. Decouple: turn numbers should always show when breaks are enabled; "Show Names" should only toggle whether the writer name is included.

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