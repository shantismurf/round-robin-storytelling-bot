# To-Do List

- Fable Audit fixes — see [docs/Fable_Audit_2026-07.md](docs/Fable_Audit_2026-07.md) "Suggested Fix Order" and [docs/Fable_Audit_Fix_Progress.md](docs/Fable_Audit_Fix_Progress.md) for full detail on what steps 1-3 actually touched.
  - **Steps 1-3: DONE 2026-07-10**, all in one session on branch `fable-audit/steps-1-3` (3 commits — PR/merge pending). Step 3 (rating-barrier sweep) grew well beyond its 4 named findings — see the Fix Progress doc's "Scope expansion" section for the full list of ~15 additional call sites fixed (the primary entry-write flow itself had the same bug, plus reopen/close/join/ping/request-more-time/turn-reminders/resume-notifications, plus a separate feed-channel-routing bug in the closed-story announcement).
  - **NOT YET VERIFIED AT RUNTIME.** Syntax-checked and carefully traced against the schema, but never run against a live Discord connection or exercised against the real DB — the hosted bot instance was live during this session so a second connection wasn't safe, and there's no separate test guild/token. Before trusting this in production: watch migration 021 apply cleanly on the next deploy, and manually exercise at least: quick-mode write + finalize on a restricted (M/E) story (confirm the entry posts to the restricted thread), a finalize/timeout race if reproducible, and closing a story that has both a restricted and unrestricted thread.
  - **New pre-existing bug found, NOT fixed (out of scope):** `loadConfig()` in `utilities.js` can't resolve `config.json` when run directly via `node` on Windows (`import.meta.url`'s `/C:/...` pathname breaks `path.resolve`). Only matters for local Windows dev/testing, not the Linux-hosted production bot — but blocked local DB verification this session.
  - **Step 4: DONE 2026-07-12**, branch `claude/fable-audit-next-steps-fbfult` (3 commits: `ea037af`, `cb30366`, `ea1cc96`). Closed 1.7, 1.17, 1.41, 1.42, and the `_writerDeparted.js` 6-site consolidation together (per the sequencing decision below), plus 1.10(a)/(c) — NextTurn's result is now checked at all 16 call sites, with a hub-log alert on failure instead of a silent stall. Full detail (including a bonus fix found mid-sweep: `_writeSkip.js`'s `handleSkipConfirm` had an unguarded turn-end UPDATE that step 2 missed entirely) in the Fix Progress doc's "Step 4" section. **Deliberately deferred, unchanged from the original plan:** the actual 1.10(b)/1.12 advanceTurn/notifyTurn DB/Discord split — still belongs with Phase 2 web-interface planning, not a quick pass. **NOT YET RUNTIME-VERIFIED** — same constraint as steps 1-3, no isolated test guild/DB available.
  - **Step 4 reviewed and merged to main 2026-07-12** via PR #18 (merge commit `7914e58`) — independent fresh-session code review at high effort came back clean, no correctness findings. Still not runtime-tested; the reviewer flagged one behavior change worth eyeballing on the next live redeploy: admin-remove, panel pass/pause, and last-writer departures now 24h-preserve the writer's draft thread (with a Delete Now button) instead of deleting it immediately — that's the intended 1.41 fix, but it's the most visible user-facing difference.
  - Step 5 (docs/tests/constants module) and step 6 (Tier-3 cleanup) still pending — see docs/Fable_Audit_2026-07.md's Suggested Fix Order.
  - **Still open, not folded into any step yet:** 1.14 (join capacity race — standalone fix, unrelated code path, fine any time), 1.29 (dead code: `utilities.createThread`, `sendUserMessage` — both already broken/uncalled, low urgency).
  - **Cleanup items flagged by the step-4 code review (non-blocking, didn't affect the merge):** `closeStoryInternals` (`story/_turn.js`) uses inline `.replace()` for thread-title tokens instead of `replaceTemplateVariables`, per the existing TODO.md compliance sweep this pattern already tracks elsewhere; `StoryJoin`'s (`storybot.js`) `dmMessage` strings are hardcoded rather than pulled via `getConfigValue`, violating the zero-hardcoding rule.
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