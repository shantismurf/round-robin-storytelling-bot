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
- **Before v2.0** — no entry has been written yet, but the source material does exist. Git
  history reaches back to 2025-10-28 ("Initial commit"), roughly 600 commits. **Corrected
  2026-09-25:** this section previously said history began 2026-07-16. It does not — cloud
  sessions clone this repo shallow, which truncates `git log` at about 144 commits without
  warning, and that artifact was mistaken for the repo's real history. Run
  `git fetch --unshallow` before any archaeology here, and check
  `git rev-parse --is-shallow-repository` before concluding anything is absent.

---

## Unreleased

Work that did not bump the version, because it changed nothing about what users experience.
The next version's entry absorbs this section. See the Versioning Policy in `CLAUDE.md`.

### Added
- **A Hub-only welcome at the top of the Overview post in the FAQ forum.** `txtHelpOverviewFaqIntro`,
  LeeAnn's text, 2026-10-02. The contents menu of `/story help` opens with `txtHelpTocIntro`, which
  points at the Hub by invite link, but the forum sync posts the twelve pages and never the contents
  menu, so a reader arriving in the Hub's FAQ forum met no welcome at all. This one names the Hub's
  own `#storybot-support` channel, which is why it cannot simply be added to the Overview page: a
  channel mention resolves only in the guild that owns the channel, so in any other server it would
  render as a dead `#unknown`.
  The mechanism is a `faqIntroKey` on the page definition, prepended by
  `buildPage(conn, guildId, pageDef, { forFaq: true })`, which only `syncFaqPosts` passes. Overview
  is the only page that has one. Note for whoever touches this next: `test/faqPages.test.js` covers
  the rendering both ways, but nothing fails if that one call in `syncFaqPosts` loses its flag.
- `cfgHubSupportChannelId` (`1498673028203286684`), joining the other `cfgHub*ChannelId` values in
  `config_system.sql`, and substituted into help text as `[hubSupportChannelId]`.

This lands after 3.7.0 merged but before the bot has been restarted, so readers will first meet it
as part of 3.7.0 rather than as a change to it. No bump: it adds a paragraph to the Hub's own forum
posts and changes nothing a writer does.


## 3.7.0 — 2026-10-01

Provenance: written alongside the work.

MINOR. The help system went from seven pages to twelve, reordered into the sequence a reader
actually follows, with a written overview at the front. Copy on every page is corrected, "Pass"
and "Skip" now mean one thing each throughout the bot, and admin access is widened to Manage
Server holders. Not MAJOR: nothing changes about what the bot does or how it is operated, and
the modal-panel paradigm 3.0.0 introduced is untouched. Proposed and signed off by LeeAnn
2026-10-01. Absorbs the setup-panel tweaks that were sitting in Unreleased.

### Changed
- LeeAnn 2026-09-29, setup panel minor tweaks: one more line break added after
  `txtSetupChannelsPermissionNote` at the top of the Server Admin tab; "Storybot Hub
  Announcements" and "Teen or Lower Only" toggle buttons changed from gray (`Secondary`) to blue
  (`Primary`); `txtSetupEmbedDescAdminRole` reworded ("only Discord server admins" → "only users
  with Manage Server permissions", matching what `hasTier1Access()` actually checks — Administrator
  also passes it, since discord.js's `PermissionsBitField.has()` defaults `checkAdmin=true`);
  `txtSetupEmbedDescRestrictedMedia`'s second sentence trimmed ("If the channel is not set" →
  "If not set").

### Added
- **`[hubInviteUrl]` now resolves in help page bodies, not just the contents page.** It was
  substituted only into `txtHelpTocIntro`, so a page that wanted to point a reader at the Hub had
  nowhere to put the link — which is what `txtHelpWritingThreadFeatures` needed for its
  one-divider-per-story suggestion. The substitution lives in `buildPage`, the single path all
  four readers of a help page go through (`/story help`, `/mystory help`, `/storyadmin help` and
  the Hub FAQ forum sync), and runs over body keys only: a title is a label, and
  `replaceTemplateVariables` also strips `{?...?}` blocks, which has no business running over text
  never written with a token in it. `renderEntries` stays a pure cfg-in/markdown-out function, so
  the substitution happens on the fetched copy rather than at render time. `buildPage` is exported
  now purely so a test can render a page end to end against a scripted connection.
- **Help pages are addressed by a stable `id`, not by their position.** Every entry in
  `PAGE_DEFS` gained an `id` (`find-join`, `writer-commands`, `admin-server-setup` …) and a new
  `pageById()` resolves it, throwing on an unknown id rather than returning `undefined`. Three
  things indexed the array positionally: `/mystory help` and `/storyadmin help` jumped to
  `PAGE_DEFS[6]` and `[7]`, the contents menu used the array index as each option's value, and
  `cfgFaqPostIds` stored Hub forum thread ids as a bare pipe-delimited list read back by index.
  That last one is why this had to come first: splitting or reordering any page shifted every
  later slot, so the next FAQ sync would have overwritten the wrong forum thread, silently and
  with no error — the same failure shape as the duplicate-post bug fixed on 2026-09-25.
- `cfgFaqPostIds` now stores `pageId:threadId` pairs. `parseFaqPostIds()` still accepts the old
  positional form and migrates it through a frozen `LEGACY_FAQ_PAGE_ORDER`, so an already-deployed
  forum keeps its threads instead of being abandoned and duplicated. The sync also deletes the
  thread of a page that no longer exists, which the positional format could not express.
- Help page 2 gained a **Section Break** section documenting `[[break]]` (`lblHelp2SectionBreak` /
  `txtHelp2SectionBreak`), which had no writer-facing coverage.
- `txtHelpPageGone`, shown when a reader opens a page from a contents menu built by an older
  deploy. **Wording not yet approved by LeeAnn.**
- `txtHelp9Title`, `txtHelp10Title` for the two pages split out of the admin page.
- **An Overview page**, first in the contents menu, from copy LeeAnn drafted during the review:
  what the bot does, what a turn looks like, and how a finished story is read or exported. It is
  three paragraphs of prose with **no section headings**, deliberately — her instruction was that
  it is a conversational introduction rather than the topical reference every other page is
  (`txtHelpOverviewHowItWorks`, `txtHelpOverviewWriting`, `txtHelpOverviewReading`).
- **Find & Join a Story is its own page** (`find-join`, `txtHelpFindJoinTitle`). It used to be the
  body of the page titled "Round Robin StoryBot Overview", which is how a page called Overview
  came to contain nothing but joining instructions.
- **Writing Your Entry is its own page** (`writing-your-entry`, `txtHelpWritingTitle`) — Normal,
  Quick and Slow modes, inline translations and section breaks. It was a *subsection* of Your
  Stories & Turns, which meant the thing a writer with an open turn is hunting for never appeared
  in the contents menu at all. It was also 1,777 of that page's 2,129 characters.
- `txtHelpTocIntro`, a short welcome on the contents menu itself, which previously showed a bare
  title and a dropdown. LeeAnn's wording, and it links the Hub server through the existing
  `[hubInviteUrl]` token.
- `renderEntries` now accepts an entry with `txt` and no `lbl`, rendering it as a lead paragraph
  above the page's first heading. Find & Join needs one: its opening text had carried a heading
  identical to the page title. `collectKeys` was pushing `entry.lbl` unconditionally, so such an
  entry would have put `undefined` into the key list handed to `getConfigValue`.

### Changed
- **The admin help page was split three ways**, following the setup panel's own permission
  tiers rather than cutting where the characters ran out: `admin-server-setup` (Server Admin
  Options), `admin-story-setup` (Story Admin Options) and `admin-commands` (Other Admin
  Commands). The single page had reached 4095 of Discord's 4096-character embed cap — one
  character of headroom. LeeAnn's rewritten copy would have come to ~4029, still fitting but
  with no room to edit. The three pages now render 1675 / 1620 / 861. Section keys keep their
  original `Help8` names: the prefix identifies the key, and renaming would orphan any guild's
  overriding row for no gain.
- Help copy across all ten pages updated from LeeAnn's review of the full rendered text, carried
  out over the week of 2026-09-25. Her wording throughout. Notable corrections of fact rather
  than style: Turn Thread Privacy is no longer labelled "(Normal Mode only)" — `story/_turn.js`
  creates turn threads for Normal *and* Slow mode; `/story help`'s command list was missing
  `add` and `tag` and is now alphabetised; `/story manage` is available to the story admin role,
  not just the creator and server admins; the Ground Rules limits are stated as the real ones
  (40-character label, 100-character description, 10 rules) read from `story/_groundRules.js`.
- **The two permission levels are now one definition each.** `checkIsAdmin` tested
  `Administrator` while the setup panel's tier-1 gate (`hasTier1Access`) tested `ManageGuild`, so
  a member with Manage Server but not Administrator could configure the server's channels and yet
  could not run `/storyadmin user`, `delete` or `sweep`. Both now resolve through a new
  `hasManageServer()` in `utilities.js`, and `hasTier1Access` delegates to it so the two cannot
  drift apart again. **This widens access on live servers:** anyone holding Manage Server without
  Administrator, and not in the Story Admin role, gains those three commands. Nobody loses
  anything — discord.js's `PermissionsBitField.has()` defaults `checkAdmin=true`, so an
  Administrator satisfies a Manage Server check. Raised and approved by LeeAnn 2026-10-01.
- `txtHelp8Footer` and `txtSetupNoRoleNote` updated to match: both said Administrator, which
  stopped being true with the change above. **Wording not yet approved by LeeAnn.**
- Both entry pickers now say which one the reader is looking at
  (`txtEditMyEntriesSelect`, `txtManageEntriesSelectEntry`). `/story edit` shows only your own
  entries and `/story manage` → Manage Entries shows an admin all of them; the pickers looked
  identical, which read as a bug.
- **The help pages are reordered**, which is what the stable ids above were a prerequisite for.
  The order is now overview, creating a story, story options and metadata, find and join, writing
  your entry, reading and editing, your stories, managing a story, the command reference, then the
  three admin pages. Reading and editing moved up to sit directly after writing your entry
  (LeeAnn, 2026-10-02), since reading back what the group has written is the other half of taking
  a turn, where your stories and managing a story are both about administering your participation. LeeAnn's reasoning, from the review: the old order opened with finding and
  joining, which assumes a reader who has walked into an already-active server, when the only
  person guaranteed to be reading on day one is whoever installed the bot. The order is asserted
  in full in `test/faqPages.test.js` — it is a decision, not an implementation detail.
- **"Pass" and "Skip" now mean one thing each.** LeeAnn's rule, 2026-10-01: *Pass* is what a
  writer does to their own turn, *Skip* is what an admin does to someone else's. Nineteen config
  strings changed across `config_turn.sql`, `config_mystory.sql`, `config_system.sql` and
  `config_storyadmin.sql`. The writer's own flow became Pass throughout (`btnSkipTurn`,
  `btnSkipConfirm`, `btnSkipDelete`, `btnSkipKeep`, `txtSkipConfirm*`, `txtSkipSuccess`,
  `txtStoryThreadTurnSkip`, the four turn-thread welcome bodies and more — keys keep their
  `Skip` names, since the name identifies the key). `txtMyPassConfirm` said "Pass your turn?…
  This will skip" in one sentence and now says pass twice. The admin-facing strings
  (`btnTurnSkip`, `txtTurnSkipConfirm`, `txtAdminSkipSuccess`, `txtManageTurnsDesc`) were already
  correct and are untouched. Two were judgement calls LeeAnn ruled on: a turn timeout and an
  admin confirming an action on another writer are both things done *to* a writer rather than
  *by* them, so both say Skip — which made `txtAdminMUActiveTurnWarning` change from "auto-pass"
  to "auto-skip", the one string that moved toward Skip rather than away from it.
- `txtHelp2WriteSlow` says turns end when "passed or finalized" rather than "skipped or
  finalized", matching the renamed button the writer is looking at.
- `txtHelp2WriteNormal` rewritten. It claimed "If your turn times out, all posts will be lost",
  which has never been true: `endTurnThread` (`story/_turn.js:347`) keeps a thread the writer
  posted in for 24 hours, renames it with a pending-deletion marker and offers a **Delete Now**
  button, and only deletes an untouched thread immediately. Draft thread preservation shipped
  2026-05-09 in `af7f7c5`; the sentence was written 2026-05-11 in `df44e84`, so it described the
  old behaviour from the day it was added and survived two years of edits. It was also wedged
  between the two halves of the sentence about how entries are compiled, and has moved to sit
  with the extension sentence, both being about running out of time.
- `txtHelp2Title` trimmed from "Your Stories & Turns" to "Your Stories", since taking a turn is
  now its own page.
- **Inline Translations and Section Break condensed into one Thread Features section**, written by
  LeeAnn 2026-10-02. Both described markup that behaves identically in every writing mode and
  neither was long enough to earn its own heading. The new section leads the Writing Your Entry
  page, ahead of Normal, Quick and Slow, because it is the part that is true whichever mode you
  are in. It also absorbs two things that were not documented anywhere: that a paragraph break
  needs a blank line, not a single newline (the export runs `marked` with `breaks: true`, so one
  newline is a `<br>` inside the same paragraph), and that markdown survives into the export,
  spoilers, quotes and `-#` subtext included (`story/export.js` pre-processes each before the
  markdown pass). The markdown sentence moved here out of Normal Mode, where it had always
  described behaviour common to all three modes.
- **Normal Mode expanded**, LeeAnn's text, 2026-10-02. It now says what happens to a timed-out
  turn in full — posts kept 24 hours so the writer can copy their work out and ask the creator
  to reassign the turn, which is a real one-click action ("↩️ Reassign to Previous" on the turn
  actions panel, `story/_manageTurnActions.js:118`, limited to the writer whose turn ended most
  recently) — and gives image handling its own paragraph, including how to get images onto a site
  like AO3, which the bot cannot do for you. The Delete Now button is deliberately left
  undocumented (LeeAnn: "the button is self explanatory and I think it's better to keep this at
  least somewhat concise").
- **`/mystory manage` rebuilt on Components V2**, matching the `/story add` and `/story manage`
  panels. It was the last panel still built as a classic `EmbedBuilder` and was simply missed when
  the others were converted — LeeAnn's words, 2026-10-01: "it got lost in the component upgrade
  the other panels got." The visible symptom was that its four `addFields` entries, all marked
  `inline: true`, rendered as eight stacked lines of label over value on her phone, with a fold
  screen opened — so not a width fallback, since `inline` is a hint a client may ignore outright.
  That is the general argument for the conversion: a `TextDisplayBuilder`'s layout is what you
  wrote, on every client. Each editable setting is now a `SectionBuilder` — its line of text on
  the left, the button that changes it on the right — which the old embed could not express at
  all: its three edit buttons sat in a row under all four fields with nothing tying one to the
  other. Status stays a plain line, because the button that would pair with it is Pause/Resume,
  and that acts immediately where the other three stage until Save.
  Converting the builder forced every later edit of that message to become V2 too, since the flag
  is per-message and one-way — the same chain that `handleSetupSave`/`handleSetupCancel` had to
  follow. Twenty-one `editReply` sites across seven handlers now go through `finalMessage()`,
  including the pass, pause and leave confirm prompts, which pass their button row as
  `finalMessage(text, [row])`. Three early returns in `handleMyStoryManage` stay plain content
  deliberately: they answer before the panel is built, so that message is still a bare deferred
  reply. The `catch` in the same function does not, because if the panel send itself threw the
  message may already carry the flag. Worst case is 22 components of Discord's 40, counted per
  nested node. New `test/myStoryManagePanel.test.js` covers the flag, the ceiling, the absence of
  `undefined`, the one-line-per-setting shape and the two state-dependent buttons, across every
  combination of writer status, active turn, pen name, privacy and notification preference.
  Button styling settled in the same pass (LeeAnn, 2026-10-02: "those button colours look good,
  blue is right for actions"). The three section accessories are `Primary`: each one does
  something — opens the pen-name modal, flips the notification mode, flips turn privacy — so blue
  is the colour of "change this setting". Save alone is `Success`. Pass My Turn and Leave Story
  are `Danger`, the two you cannot take back, while Pause/Resume stays `Secondary` because it is
  reversible in both directions and shares one button slot — colouring it would make Resume read
  as destructive. `test/myStoryManagePanel.test.js` asserts all four roles, so a later change to
  any of them fails the suite rather than landing unnoticed.
  The panel's **Cancel button is gone** (LeeAnn, 2026-10-02: "I've never understood the value of
  a cancel button when dismissing the post is right there and easier"). The panel is ephemeral,
  so Discord's own Dismiss message already did exactly what Cancel did, and the staged edits it
  discarded are overwritten by the next `/mystory manage` regardless. Cancel stays on the three
  confirm prompts, where it means "go back to the panel" rather than "close". **`/storyadmin setup` lost its
  panel-level Cancel in the same pass**, for the same reason and on the same instruction
  (LeeAnn, 2026-10-02: "yes pull the cancel from both"). Those two were the only panels that had
  one — `/story add` and `/story manage` never did. Removing it took `handleSetupCancel` and the
  `storyadmin_setup_cancel` route with it, and the `btnCancel` fetch it was the only caller of.
  Safe because `handleSetup` rebuilds that admin's `pendingSetupData` entry from the database on
  every open, so a panel dismissed with staged edits cannot leak a stale value into the next one.
  Cancel stays on the Ground Rules authoring flow, where it means "go back" rather than "close".
  **No version bump for this** (LeeAnn, 2026-10-01): it is an oversight being corrected rather
  than new work, and 3.7.0 has not been deployed, so it is part of what users first experience
  as 3.7.0.
- The section comments in `config_help.sql` no longer give page numbers. A key's `Help<N>` prefix
  is the page it was created for, not the page it renders on, and after this reorder most of them
  disagree — `Help1` content sits on pages 1 and 4, `Help2` on pages 5 and 6, `Help8` on 10, 11
  and 12. The comments name the key group instead, and keys added from here on are named for
  their page (`txtHelpOverview*`, `txtHelpFindJoinTitle`). Stale numbered comments are exactly how
  `ux_roadmap.md` came to document three commands that no longer existed.

### Removed
- `lblHelp1FindJoin` and `lblHelp2WritingYourTurn`. Both were section headings whose text became
  the title of the page split out around them, so keeping them would have rendered the page title
  twice — once as the embed title and again as its first heading. Their wording survives verbatim
  as `txtHelpFindJoinTitle` and `txtHelpWritingTitle`. Note that `sync-config.js` only inserts and
  updates, never deletes, so the rows stay in the `config` table of an already-deployed guild and
  are simply never read again.
- `txtPassSuccess`, a dead key. No `.js` file anywhere read it, and it duplicated
  `txtMyPassSuccess` word for word. Found during the Pass/Skip sweep.


## 3.6.0 — 2026-09-25

Provenance: written alongside the work.

MINOR. Ground Rules is a new user-facing feature, the `/storyadmin setup` panel was reworked
into two permission tiers and rebuilt on Components V2, and the story panel gained a third tab.
Not MAJOR: 3.0.0 was the introduction of the modal-panel paradigm, and this extends that
paradigm rather than replacing it. Proposed and signed off by LeeAnn 2026-09-25. Absorbs the
`guild_event` instrumentation below, which was itself no-bump work.

### Added
- `/storyadmin setup` split into two permission tiers, per `docs/TODO.md`'s design (LeeAnn,
  2026-09-22): escalation-capable fields (feed/media/restricted channels, admin role name) stay
  Manage-Server-only; roundup, changelog, and the two items below are reachable by any story
  admin. Same command, one panel — `handleSetup`'s flat refusal for non-Manage-Server users
  became "render the tier-2 panel" instead. Every tier-1 action re-checks live
  (`hasTier1Access()`), not just hides the button, since a customId can be replayed by anyone
  who saw the tier-1 panel.
- Ground Rules — per-story tone/conduct tags, server-defined vocabulary
  (`docs/plans/PLAN-panel-rework-and-ground-rules.md` Part 2). Authored as a paragraph-text field
  on the (now tier-2) setup panel, pre-filled with six approved defaults on an unconfigured
  guild; validated against the real 10-rule/40-label/100-description limits; a confirmation
  screen (Added/Removed-with-story-count/Renamed) gates any change that isn't a pure addition,
  and a detected rename migrates existing stories' selections rather than silently dropping them.
  Selected per story via a checkbox group on the shared Metadata modal (`/story add` and
  `/story manage`); displayed on the story status post, the join panel, and the Manage/Add
  panel's Metadata tab; a story-thread notice posts when a story's own selection changes (never
  on the server vocabulary edit). New `story.ground_rules` column
  (`db/migrations/024_story_ground_rules.sql`) and `cfgGroundRules` config key. Parsing/
  validation/diffing logic in new `story/_groundRules.js`, covered by
  `test/groundRules.test.js` (23 tests).
- Teen or Lower Only toggle (tier-2 setup panel, `cfgTeenOrLowerOnly`) — when on, the rating
  picker in `/story add`/`/story manage` offers only NR, G, and T. An M/E story's rating resets
  to NR the moment its metadata is next submitted after the toggle is turned on (M/E is no
  longer selectable to reaffirm it), routed through the restored rating-change confirmation
  below so that reset isn't silent. Supersedes the TODO.md item "Suppress rating display when no
  restricted channel is configured" — closed as superseded, see that file.
- Restored the rating-change confirmation flow. Built 2026-05-06 (`e281761`), deleted
  2026-07-01 (`eefc881`, "UX v3 — replace individual setting buttons with grouped modal panels")
  when that commit rebuilt the metadata UI and didn't carry the confirm/revert branches across.
  The approved copy (`txtRatingChangeConfirmTitle`/`Body`, `btnRatingChangeConfirm`/`Revert`) sat
  unused in `config_metadata.sql` the whole time. Restored in `story/manage.js`, adapted for
  Components V2 (the revert branch's old shape edited a message back to plain
  content/embeds/components, which is invalid once a message carries `IsComponentsV2`) and to
  fire for the Teen or Lower Only reset above, not just a manual barrier crossing. Manage-only,
  matching the original's `metaEntry.onSave` gate.

### Changed
- `commands/_storyadminSetup.js` converted from a classic embed panel to Components V2
  (`ContainerBuilder`), matching the pattern already used by `story/_metadataModals.js`'s
  `buildStoryPanel()`. `handleSetupSave` and `handleSetupCancel`'s terminal states now post a
  follow-up message rather than overwriting the panel with plain content, since V2's flag can
  never be removed once a message carries it.
- Turn thread welcome message (`story/_turn.js`'s `postWelcomeMessage()`) converted from plain
  `content` to an embed — plain content parses `@everyone`/role/user mentions live, and this was
  the one place admin-adjacent freeform text could reach a message a writer can't opt out of
  seeing. Prerequisite for Ground Rules' welcome-message wiring (not currently used there, but
  closes the risk before anything does flow through it).
- `commands/_storyadminSetup.js` split into four files (`_storyadminSetupSave.js`,
  `_storyadminSetupFieldModals.js`, `_storyadminSetupGroundRules.js`, plus the original) and
  `story/manage.js`'s save handler extracted to `story/_manageSave.js` — both were pushed over
  the 500-line CLAUDE.md standard by the work above. `story/manage.js` remains over budget
  (755 lines, was 690) — the fuller settings/turns/save split `docs/TODO.md`'s file-size entry
  already describes is still open.

### Added — internal only, absorbed from Unreleased
- `guild_event` table (`db/migrations/023_guild_event.sql`) and `logGuildEvent()` helper
  (`utilities.js`) — funnel instrumentation for the install-through-activation path, per
  `docs/plans/PLAN-sequencing-and-priorities.md` Stage 1 and finding 7 of
  `docs/audits/Onboarding_Review_2026-09.md`. There was previously no way to measure where
  servers drop off between adding the bot and reaching an active multi-writer story. Records
  `guild_joined`, `guild_left`, `setup_opened`, `setup_saved`, `story_created`, `writer_joined`
  (standalone join path only, not the creator's own auto-join), and `turn_finalized` — six
  non-fatal insert calls at points that already existed in code. Deliberately no `user_id`
  column: every funnel question is a per-guild count over time, and it keeps this table outside
  the privacy policy's enumerated data categories. See
  `docs/plans/completed/PLAN-guild-event-funnel.md`.

### Fixed
- `handleSetupGroundRulesModal`'s validation-failure branch called `interaction.showModal(...)`
  directly on a modal-submit interaction, which has no such method
  (`docs/reference/discordjs_reference.md` — "A modal-submit interaction cannot show a modal";
  an earlier version of that doc claimed the opposite, also corrected). Submitting the Ground
  Rules modal with invalid text (more than 10 rules, a label over 40 characters, or a
  description over 100) would throw `TypeError: interaction.showModal is not a function`.
  Fixed by replying ephemerally with the error and a new "Try Again" button
  (`btnGroundRulesTryAgain`); that button click is a `MessageComponentInteraction`, which does
  support `showModal()`, and re-opens the form pre-filled with the rejected submission. New
  `handleSetupGroundRulesRetry` handler in `commands/_storyadminSetupGroundRules.js`.
- "Invalid Webhook Token" on setup-panel toggle/tab buttons and field modals after ~15 minutes
  of an open `/storyadmin setup` session (LeeAnn, live testing). Root cause: every one of these
  handlers edited the panel via `state.originalInteraction.editReply(...)` — the *original*
  `/storyadmin setup` command's own webhook token, which expires 15 minutes after that command
  ran, no matter how fresh the triggering button/modal-submit's own token was. Replaced with
  `interaction.update(...)` (buttons) or `interaction.deferUpdate()` + `interaction.editReply(...)`
  (modal submits, which Discord lets acknowledge/edit the originating message directly since
  every modal here opens from a button click) — both use the current interaction's own token.
  10 call sites across `commands/_storyadminSetup.js`, `_storyadminSetupFieldModals.js`, and
  `_storyadminSetupGroundRules.js`.
- **Live production crash**: `/story manage` threw `DiscordAPIError[50035]` /
  `COMPONENT_CUSTOM_ID_DUPLICATED` on every open (shantismurf, live). Root cause:
  `buildPanelTabRow()`'s Story Info/Settings/Metadata tab row is rendered twice per panel (top
  and bottom, LeeAnn 2026-09-24), and both calls used identical customIds (`story_manage_tab_*`/
  `story_add_tab_*`) — Discord rejects a duplicate custom_id anywhere in a message's component
  tree, not just within one row. `buildPanelTabRow()` now takes a `position` ('top'/'bottom')
  folded into each customId; the two tab-click dispatch sites (`story/manage.js`,
  `story/add.js`) match with `customId.startsWith(...)` instead of an exact string so either
  position still routes. While in that code: also replaced its
  `state.originalInteraction.editReply(...)` with `interaction.update(...)`, the same stale-token
  bug just fixed on the setup panel (see above) — this dispatch had the identical pattern.
- Same `COMPONENT_CUSTOM_ID_DUPLICATED` bug, missed in the fix above: `commands/_storyadminSetup.js`
  has the identical "tab row repeated top and bottom" pattern for its own Server/Story tab toggle
  (`buildTabRow()`, called once at the top of the panel and again at the bottom with the same
  hardcoded `storyadmin_setup_tab_tier1`/`tier2` customIds) — would throw the same crash for any
  Manage Server holder opening the interactive setup panel. Same fix: `buildTabRow(position)` now
  folds `'top'`/`'bottom'` into each customId; `handleSetupButton`'s dispatch matches via
  `id.startsWith(...)`. Verified with a runtime smoke test against the real `buildSetupPanel`
  export (no duplicate customIds in either tab's rendered tree) and a repo-wide grep confirming no
  other "same row built twice on one message" pattern exists outside these three.

### Changed
- Setup panel channel-field copy, LeeAnn 2026-09-24: `txtSetupModalTitleMedia` ("Media/Image
  Channel" → "Story Media Channel"), `txtSetupModalTitleRestrictedFeed` ("Restricted Feed
  Channel" → "Restricted Story Feed Channel"), `txtSetupModalTitleRestrictedMedia` ("Restricted
  Media Channel" → "Restricted Story Media Channel") for consistency with the "Story Admin"
  naming convention. Per-field bot-permission wording on `txtSetupEmbedDescMedia`/
  `txtSetupEmbedDescRestrictedMedia` replaced with one shared `txtSetupChannelsPermissionNote`
  header above all four channel fields. `txtSetupEmbedDescRestrictedMedia` now also states its
  fallback (unset → Story Media Channel), matching what `resolveMediaChannelId()` already does.
- `txtSetupChannelsPermissionNote` dropped its `-# ` subtext markdown in favor of plain text
  (LeeAnn: the subtext styling plus the blank-line gap before the first field read as excess
  whitespace); also now joined to the first channel field with a single line break instead of
  the double-line gap used between field blocks, since it's a header for the group, not its own
  field.


## 3.5.6 — 2026-09-24

Provenance: git-derived.

### Added
- Join button on the story feed creation announcement. A new story was announced to the feed as
  a plain line of text with no way to act on it — the only Join button lived on the pinned
  status embed *inside* the story thread, so a member had to already be in the thread to find
  the control that gets them into the thread. Reuses the existing `btnJoinStory` label and the
  existing `story_join_<storyId>` customId, so no new config key and no new routing.
- `isStoryJoinable()` in `story/_metadata.js` — the "is this story open for new writers"
  predicate, extracted from `story/_storyStatus.js` and now shared with the creation
  announcement so the two cannot drift. A third caller is planned in the roundup's open-stories
  section (`docs/plans/PLAN-roundup-open-stories.md`).
- `test/_metadataJoinable.test.js` — seven tests on that predicate.

### Notes
- The feed button persists after the story's state changes. That is deliberate rather than
  overlooked: `validateJoinEligibility` (`story/join.js:22`) re-checks closed, joins-off,
  at-capacity and already-joined at click time, each with its own config string.


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
- Setup panel rebuilt from embed fields into a single embed description, so the field list and
  the unsaved-changes warning render as one body (`commands/_storyadminSetup.js`). Committed
  2026-09-20 across four commits messaged only `Update _storyadminSetup.js`. **Recorded here
  2026-09-25** — it had been left behind in a stale Unreleased section below this entry.

### Docs only, no version impact
- New-admin onboarding review (`audits/Onboarding_Review_2026-09.md`), marketing and listing
  plan, roadmap sequencing plan, and this changelog directory. 2026-09-22.
- Corrected `reference/ux_roadmap.md`, which documented three `/storyadmin` subcommands that no
  longer exist and had caused a false backlog item. 2026-09-22.

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
