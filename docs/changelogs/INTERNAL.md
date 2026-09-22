# Internal Changelog

The comprehensive backend record, newest first. See [README.md](README.md) for how this
differs from the Hub posts in `public/` and when each gets written.

**Removed entries must say why.** A rename is a Removed plus an Added, not a Changed, because
the thing you will search for later is the old name.

**Provenance is marked per section and matters:**

- **v3.2.1 and later** — reconstructed 2026-09-22 from git history and the plan files. Commit
  messages are descriptive and version bumps are explicit commits, so the boundaries are firm,
  but anything not visible in a commit message or a plan is absent.
- **v2.0 through v3.1.2** — reconstructed 2026-09-22 from the Hub posts in `public/`, which
  were edited for readability and length. **Not comprehensive.** Treat as the announced
  highlights, not the full record.
- **Before v2.0** — no record exists. Git history begins 2026-07-16; nothing earlier survives
  outside the Hub posts.

---

## 3.5.5 — 2026-09-22

Provenance: git-derived.

### Added
- `getSetupRequiredMessage()` in `utilities.js` — one helper owning the "this server isn't set
  up yet" decision: configured check, Manage Server split, guild-1 read, `[hubInviteUrl]`
  substitution. Returns the string or null.
- The setup-required message now also appears on `/story help`, `/mystory help`,
  `/storyadmin help` and the `/storyadmin setup` panel. Those four are exempt from the command
  gate, so an admin who went straight to setup or help previously never saw the welcome at all.
- `test/commandContexts.test.js` — asserts the serialized command payload stays guild-only.

### Changed
- Slash commands are guild-only (`setContexts(InteractionContextType.Guild)` on `/story`,
  `/mystory`, `/storyadmin`). They were being offered in DMs with the bot, where every one of
  them dead-ended on the guild guard.
- `txtSetupRequiredAdmin` rewritten as a welcome with one requirement and a prerequisites list,
  `txtSetupRequiredUser` now states what the bot is rather than reading as an error the member
  caused, and `txtStoryAddIntro` says only a title is required.

### Removed
- The unconfigured-guild check in `commands/story.js`. **Why:** unreachable — the gate in
  `index.js` catches every `/story` subcommand except `help`, and this check exempted `help`
  too — and it read `txtNotConfigured`, which migration 010 deletes as unused.
- The "Story Writer role" bullet from `txtSetupRequiredAdmin`. **Why:** it advertised a
  `/storyadmin setup` field that does not exist. The field is shelved with the community
  invitation work in `docs/plans/PLAN-first-run-experience.md`.

### Fixed
- The setup-required reply never called `replaceTemplateVariables`, so the new `[hubInviteUrl]`
  token would have rendered literally.


## Unreleased

Changes on `main` since the v3.5.4 bump, not yet carrying a version number.

### Changed
- Setup panel rebuilt from embed fields into a single embed description, so the field list and
  the unsaved-changes warning render as one body (`commands/_storyadminSetup.js`). Committed
  2026-09-20 across four commits messaged only `Update _storyadminSetup.js`.

**Proposed version: 3.5.5** (PATCH — cosmetic, one panel). Awaiting sign-off per `CLAUDE.md`'s
versioning policy; `package.json` still reads 3.5.4.

### Docs only, no version impact
- New-admin onboarding review (`audits/Onboarding_Review_2026-09.md`), marketing and listing
  plan, roadmap sequencing plan, and this changelog directory. 2026-09-22.
- Corrected `reference/ux_roadmap.md`, which documented three `/storyadmin` subcommands that no
  longer exist and had caused a false backlog item. 2026-09-22.

---

## 3.5.4 — 2026-09-19

### Fixed
- Turn advancement and the weekly roundup force-refetch the guild rather than trusting a cached
  copy, so a bot removal masked by a stale cache no longer silently breaks them.
- Onboarding jobs force-refetch guild and owner for the same reason.

## 3.5.3 — 2026-09-02

### Changed
- Add Panel: help text, emoji consistency, and the tab-toggle label (#62).

## 3.5.2 — 2026-09-02

### Fixed
- Double-bolded and double-colon field labels (#61).

### Infrastructure
- Database migrated to a self-hosted encrypted Hetzner instance. Documented, not a code change.

## 3.5.1 — 2026-08-26

### Added
- Mentions in story entries resolve to plain display text at write time — never a functional
  link or a raw ID, anywhere they are shown. Covers Discord's channel-obfuscation change, which
  becomes HTTP-effective 2026-11-16. Plan:
  [`plans/completed/PLAN-mention-display-text.md`](../plans/completed/PLAN-mention-display-text.md).

## 3.5.0 — 2026-08-26

The Add/Manage panel rework: Parts 1, 1b, 1c and 3 of
[`plans/PLAN-panel-rework-and-ground-rules.md`](../plans/PLAN-panel-rework-and-ground-rules.md).
Part 2 (Ground Rules) remains unbuilt.

### Added
- Story add and manage panels rebuilt as Components V2, with a Settings/Metadata tab split.
- Unsaved-changes indicator on `/story manage` (Part 1c), shown only when a staged field differs
  from what was loaded.
- Manage Users moved onto the manage panel (Part 1b).
- Warnings converted to a real Checkbox Group (Part 3), dropping the `__dismiss__` hack.

### Changed
- Pause/Resume and Close/Open Joins act immediately on `/story manage`, matching Close/Reopen,
  rather than staging behind Save.
- Pen Name staged alongside Notifications and Turn Privacy on the Manage User panel.
- Section headings restructured; Story Actions renamed to Story Management; Metadata page
  retitled Story Metadata and Tags.
- Setup panel: dirty-state warning, plainer permissions copy, added gap logging.

### Fixed
- `trimTrailingEmoji` was eating the last letter of any label not ending in an emoji
  (`Story Mode` → `Story Mod`).
- Close Story on the manage panel: a plain reply onto a Components V2 message, confirmed broken.
- Manage Users button threw a ReferenceError — `cfg` was never declared.
- Manage Users gate corrected to creator-or-admin, not admin-only.
- False unsaved-changes warning after reopening a story.
- Delay Start display on the manage panel.

## 3.4.0 — 2026-08-13

### Changed
- The bot retries database connectivity at boot instead of crash-looping (#45).

## 3.3.2 — 2026-08-13

### Added
- Manage Entries rebuilt on the Story Edit engine, with an author entry picker. Plan:
  [`plans/completed/PLAN-manage-entries-consolidation.md`](../plans/completed/PLAN-manage-entries-consolidation.md).

### Changed
- `job-runner` throttles repeated poll-failure logging to the hub channel (#44).
- Turn number is now optional on `/story edit`; help text synced.

### Fixed
- Broken template literal in the roundup; roundup embed wired to config (#41).
- Further changes to `export.js`, `roundup.js` and `config_story.sql` committed without
  descriptive messages — see the commits themselves.

## 3.3.1 — 2026-08-06

### Added
- Entry word count in the `/story read` footer (#40).

### Changed
- The entry-processing message is sent before finalize work rather than after.
- Docs reorganised by lifecycle stage; inline plans extracted to `plans/` with status headers.

## 3.3.0 — 2026-07-24

### Added
- Privacy policy posted and maintained automatically on the Hub; image-export resizing
  disclosed in it.
- Broadcast gated into `deploy.js`, so a send is armed by editing `broadcast.js` and restarting.

### Changed
- Story export images embedded as base64 rather than linked to expiring Discord CDN URLs.
- `package-lock.json` untracked, to fix recurring deploy hangups on the host.

## 3.2.2 — 2026-07-23

### Added
- Page-jump select on the edit embed.

### Changed
- Versioning policy reframed around user impact rather than strict SemVer (`CLAUDE.md`).
- Preserved draft threads renamed to "Pending Deletion" to avoid title collisions.

### Fixed
- `deleteThreadAndAnnouncement` ReferenceError in `job-runner.js` (#34).
- Summary line breaks in export.
- New turn threads use `replaceTemplateVariables` instead of an inline `.replace()`.
- Read embed refreshed via the modal-submit interaction rather than `showModal`'s caller.

## 3.2.1 — 2026-07-22

### Changed
- Version corrected to 3.2.1 and the SemVer policy codified in `CLAUDE.md`.

---

# Before v3.2.1 — reconstructed from the Hub posts

Summarised from `public/`. **Not comprehensive** — these posts were edited for readability and
to fit one Discord message. Follow each link for the full announcement as sent.

## v2.6.0 → v3.1.2 — June–July 2026
[Full post](public/2026-07-15-v2.6.0-v3.1.2.md) · posted 2026-07-15

v3.0.0 was the interface overhaul — the MAJOR bump `CLAUDE.md` cites as its worked example.

### Added
- Scene break divider (`[[break]]`), and inline translation tooltips (`[[text|translation]]`)
  in the HTML export.
- Two export options: no breaks, or breaks with turns and names.
- Turn threads link back to the main story thread.
- Writers who leave or are banned are auto-removed from that server's stories.
- Paused and departed writers grouped under an "Inactive" heading on the status post.

### Changed
- **Interface overhaul (v3.0):** add/manage panels streamlined to consistent field names and a
  single Save/Create button, replacing a multi-step flow.
- Feed channel and role setup use Discord's native select menus instead of typed text.
- `/story list` and related views sort by last activity.
- Export HTML styling refined, with a CSS block for AO3 Work Skins.

### Fixed
A stability pass after v3.0 plus eight named bug fixes — crashes on slow-mode status refresh,
archived threads, multi-page edits and closing from a turn thread; mature-rated content leaking
into public threads; draft preservation deleting drafts it should have kept; a Quick mode bug
that could permanently block a writer; a tagging race. See the post for the full list.

## v2.5 → v2.6.1 — late May 2026
[Full post](public/2026-05-29-v2.5-v2.6.1.md) · posted 2026-05-29

### Removed
- **`/storyadmin manage` — renamed to `/storyadmin user`**, because it now only changes
  user-related information. **All story administration moved to `/story manage`.**

  This is the consolidation that left `reference/ux_roadmap.md` documenting
  `/storyadmin skip`, `close` and `pause` for months after they were gone, and produced a false
  backlog item in the 2026-08-21 entry-point audit. It predates git history, so nothing in the
  repository recorded it until now. **This entry is the reason this file exists.**
- AO3 references removed from all user-facing text except the export instructions.

### Changed
- Round-robin fairness: the number of recent writers excluded from selection now scales with
  group size (none at 1–2 writers, rising to 4 at 10+).
- Turn notifications announce the story mode and carry relative timestamps.
- `/story help` restructured as a select-menu table of contents, expanded to 7 pages.
- Setup save warning moved into the header and footer.
- `/mystory list` overhauled with turn status indicators.

### Added
- Draft preservation: 24 hours to retrieve text from a turn that ended unfinalized, with a
  confirm on skip.
- Help content syncs to the Hub FAQ forum and re-syncs whenever help text changes.

### Fixed
- CreateStory column mismatch that blocked new story creation entirely.
- Roundup posting more than once.

## v2.1 → v2.5 — May 2026
[Full post](public/2026-05-10-v2.1-v2.5.md) · posted 2026-05-10

### Added
- Collaborative tagging with reaction voting on the story thread, and an approve/reject queue
  on `/story manage`.
- Slow Mode — threaded turns with no timeout, only a configurable repeating reminder.
- Story reopening from `/story manage`.
- Draft preservation (first version).

### Changed
- All story settings consolidated onto the single `/story manage` panel; user management split
  out to `/storyadmin user`.
- Help system refactored into a select-menu table of contents, mirrored to the Hub forum.

## v2.0 — April 2026
[Full post](public/2026-04-30-v2.0.md) · posted 2026-04-30

### Added
- Full story metadata: Rating, Warnings, Dynamic, Main Pairing, Other Pairings, Characters, Tags.
- Collaborative tagging (first version).
- Restricted feed channel for mature and explicit ratings.
- Weekly roundup with stats, contributor list and writer badges.
- Autocomplete on story commands taking a story ID, turn number or username.
- Reassign — returns the turn to the previous writer and requeues the skipped one.
- `/story timeleft` with a Request More Time button.
- Repost After Editing.

### Changed
- Management control panels introduced: `/mystory manage` and `/storyadmin manage`.
- Story images render as an embed grid in `/story read`.
- Entries over 4,000 characters post as multiple messages, paging correctly throughout.

---

## Before v2.0

No record exists. Git history begins 2026-07-16 and the earliest Hub post is 2026-04-30.
