# Plan: Add/Manage Panel Rework + Ground Rules + Warnings Checkbox Conversion

Status: Pending
Created: 2026-07-26 (drafted in an earlier Claude Code chat session; committed to the repo on this date)
Last Updated: 2026-08-21 (Parts 1 and 1b shipped)

Design finalized in chat, implementation not started.

---

## Sequencing — goes before the help-system redesign's content pass

Cross-referenced 2026-08-21 against [PLAN-help-system-redesign.md](PLAN-help-system-redesign.md).
**This plan should ship first.** Its Phase 3 (content restructuring) would otherwise document panels
that are about to change out from under it:

- **Ground Rules is entirely new** — no existing help content covers it. Needs real entries in both
  `/story help` and `/storyadmin help` once built, not bolted on after.
- **The Settings/Metadata split (Part 1) changes the actual panel structure** that help pages 3 and 4
  currently describe as one flat set of fields. Those two pages already roughly correspond to
  Settings vs. Metadata by coincidence — worth making that alignment deliberate in the help redesign's
  content pass, once this split has actually shipped and the real field grouping is settled.
- **Manage Users relocating onto the manage panel (Part 1b)** makes `txtHelp8ManageUser`'s current
  description of `/storyadmin user [story_id] [writer]` stale the moment it lands.
- **Ground Rules' setup-modal authoring field** (Part 2) is workflow-shaped — good candidate for the
  same numbered-steps/compact-glossary distinction established in the help redesign. Specifically:
  keep the compressed format instructions (max 10 rules, label ≤40 chars, etc.) inline in the modal —
  load-bearing for completing the task — and let a "?" contextual button (once that mechanism exists)
  point to the fuller worked example in help, rather than cramming both into the modal's `Label`
  description text.

---

## Context

`/story manage`'s embed is at 21/25 fields and 5/5 action rows (fully maxed). `/story add`
is close behind (18 fields, 4/5 rows). Root cause: v3.0 modularized *editing* into separate
modals but never modularized the *display* — the embed still renders every field at once
regardless of what's relevant. This blocks adding Ground Rules (or anything else) to those
panels until the display is reworked.


---

## Part 1 — Panel Display Rework (Components V2, Settings / Metadata split) ✅ Implemented 2026-08-21

**Shipped as designed** (`buildStoryPanel()` in `story/_metadataModals.js`, wired into
`story/add.js` and `story/manage.js`), verified with `node --check`, a runtime smoke test
building all `isManage`×`activeGroup` combinations and both full message payloads (all clean,
`.toJSON()` running Discord's own component validators without throwing), and `npm test` (95/95
still passing). Component count came in at ~25 nested for the manage panel — comfortably under
the 40 budget even before the conservative-vs-actual nesting question is ever resolved.

**Found and handled along the way:**
- **Closed the TODO top-priority item** ("no unsaved-changes warning on the manage panel") as
  part of this same rework — `/story manage`'s save button is also called "Save Settings," so
  Setup's exact approved warning text got reused verbatim (new key `txtManageSaveWarning`),
  placed directly above the Save Settings button.
- **Two more dead code paths found and removed** in `story/manage.js`, same shape as Part 3's
  `handleManageSelectMenu` finding: `story_manage_rating_select`'s branch (no builder anywhere
  produces that customId — same file, same function, missed in the first pass) and
  `story_manage_cancel` (no builder anywhere either).
- **One real open risk, deliberately not resolved by guessing:** the `story_manage_close_open`
  transition edits from this now-Components-V2 panel to a plain `content`/`components` reply,
  because it feeds into `story/close.js`'s `handleCloseConfirm`/`handleCloseCancel` — shared with
  the standalone `/story close` command, out of this plan's scope, and not using Components V2.
  Whether Discord allows removing the `IsComponentsV2` flag on an edit is genuinely undocumented
  and untestable without staging. Left this one transition exactly as it worked before. **Needs a
  live spot-check after deploy** — if it breaks, the fix is converting `close.js`'s shared
  handlers too, a separate change since it touches a command outside this plan.
- `story/manage.js` grew to 593 lines, `story/add.js` to 501 — both now over the 500-line
  standard; logged in `docs/TODO.md`'s existing file-size-split item rather than opportunistically
  splitting mid-rework.

Original design notes below, kept for reference.

**Revised 2026-08-21 — rebuilt as Components V2, not a bigger classic embed.** Original design
extended `EmbedBuilder` with an `activeGroup` param; superseded because the real blocker here is
the 25-field embed cap itself (`/story manage` is at 21/25 today), not just which fields show when.
Components V2's `TextDisplay` has no analogous field-count ceiling, and modals are unaffected
either way — see the "Can Components V2 replace modals?" note below. Decided against doing the
small version now and a bigger rebuild later: this panel gets rebuilt once, correctly.

### What stays the same, what changes

**Modals are untouched.** `TextInputBuilder`, `RadioGroupBuilder`, and `CheckboxGroupBuilder` are
all exclusively modal-bound — confirmed against `@discordjs/builders` types: `ModalBuilder`'s own
component type is `(ActionRowBuilder<ModalActionRowComponentBuilder> | LabelBuilder |
TextDisplayBuilder)[]`, and `LabelBuilder` (which wraps radio/checkbox/select) never appears as a
valid child of `ContainerComponentBuilder` or anywhere outside `ModalBuilder`. So every existing
modal — Title & Summary, Story Info (mode/order/show-authors/turn-privacy/scene-break), Settings
(turn length/reminder/delay/max writers), Metadata (dynamic/rating/warnings), Tags, My Settings
(join) — stays exactly as built. **What changes is `buildStoryEmbed()`/`buildStoryAddMessage()`/
`buildManageMessage()`** — the read-only summary panel and its button rows, rebuilt as a
`ContainerBuilder` instead of an `EmbedBuilder`.

### Field grouping (corrected from the original list)

**Settings** (mechanical/structural — reuses the existing section-break groupings already in
`buildStoryEmbed()`, just converted from fake `sectionLine`-padded embed fields to real
`TextDisplay`+`Separator` sub-clusters):
- *(top, unlabeled)* Title, Summary
- *("Info" cluster)* Mode, Writer Order, Show Authors, Turn Privacy, Scene Break Divider, **Rating**
- *("Settings" cluster)* Turn Length, Timeout Reminder, Delay Start, Max Writers
- *("Join" cluster, add only)* Pen Name, Join Privacy, Notifications — folded in per decision below

**Metadata** (AO3-style descriptive):
- *("Meta" cluster)* Dynamic, Warnings, **Rating** (shown again — see below), Main Pairing, Other
  Relationships, Characters, Tags
- Ground Rules (new — see Part 2)

**Resolved: Rating displays on both tabs.** Rating drives real mechanics (`_migration.js`'s thread
routing between restricted/unrestricted feed channels on a rating change) — that's why it belongs
in Settings, not with the purely descriptive Metadata fields. But it's edited via the Metadata
modal, together with Dynamic and Warnings — no reason to split that modal apart over a display
change. So: Settings tab shows Rating's value because it matters there mechanically; Metadata tab
shows it too because that's where the edit button lives. One read-only value line duplicated is a
trivial cost — nothing like the hand-authored-prose duplication problem found in the help-content
audit.

**Resolved: Join Settings folds into the Settings tab** for `/story add` (manage doesn't have it —
you don't rejoin your own story). Two tabs everywhere, not three; Join Settings are mechanical
("how you personally participate"), same category as everything else in Settings.

### Layout

```
┌─ Container ──────────────────────────────────────────┐
│ [Settings] [Metadata]              ← tab toggle row   │
│                                                        │
│ Title: ...                          ← TextDisplay,    │
│ Summary: ...                          top, unlabeled  │
│ [Edit Title & Summary]              ← ActionRow       │
│ ─────────────────────               ← Separator       │
│ 🚦 Mode  🎲 Order  📑 Show Authors                     │
│ 🔑 Turn Privacy  ⁘ Scene Break  🛡️ Rating              │
│ [Edit Story Info]                   ← ActionRow       │
│ ─────────────────────               ← Separator       │
│ ⌛ Turn Length  ⏰ Reminder                             │
│ 🫸 Delay Start  #️⃣ Max Writers                         │
│ [Edit Settings]                     ← ActionRow       │
│ ─────────────────────  (add only)                     │
│ ✒️ Pen Name  🔒 Join Privacy  💬 Notifications          │
│ [Edit My Settings]      (add only) ← ActionRow         │
│                                                        │
│ ═══════════════════ (persistent, both tabs) ══════════│
│ [Manage Entries] [Manage Turns] [Review Tags (N)]      │
│ [Open/Close Joins] [Pause/Resume] [Close/Reopen]       │
│ [Save Settings]                                        │
└────────────────────────────────────────────────────────┘
```

Metadata tab swaps the middle section for its own clusters (Dynamic/Warnings/Rating + `[Edit
Metadata]`, then Pairings/Characters/Tags + `[Edit Tags]`); the persistent bottom row set doesn't
change with the tab, since none of those are "edit a currently-shown field" actions — they're
story-lifecycle actions (Manage Entries, Manage Turns, Review Tags, Joins, Pause/Resume,
Close/Reopen, Save Settings). `/story add` has no persistent row (just `[Create Story]`) and no
Manage Entries/Turns/Joins/etc., since those only apply to an existing story.

**Revised 2026-08-22:** the "persistent, both tabs" framing above turned out wrong on inspection —
walking through mockups of both tab states surfaced two problems the original design hadn't
caught, so the row split by relevance instead of staying uniform:
- **Tab toggle now renders above the header line, and the header line itself switches with it**
  (`# Story Info and Settings` / `# Story Metadata` via `buildStoryPanel`'s new `titleMetadata`
  param) — previously the header was a single static string shown unchanged regardless of which
  tab was active, which read as broken once the Metadata tab existed. Tab button labels also
  changed from "Settings"/"Metadata" to "**Display Settings**"/"**Display Metadata**" so the verb
  makes clear they toggle the view, not act on it.

**Revised 2026-08-22 (header hierarchy pass):** the field-cluster labels (`ℹ️ Story Info`, `⚙️
Story Settings`, `🗂️ Story Metadata`, `🖊️ My Join Settings`) became real `##` markdown headers
instead of manually bolded text (`**...**`), and `🛠️ Story Management` was promoted to `#` —
same visual weight as the page title, marking it as a distinct region rather than another field
cluster. A `## 🏷️ Story Tags` header was added above the Relationships/Characters/Tags cluster,
which previously had none. Page-level `#` titles (Story Info and Settings / Story Metadata /
Add's Create New Story) deliberately stay emoji-free — there's exactly one per screen and `#`'s
size already carries it; emoji are reserved for the repeated `##` pattern where they help you find
the right section. `lblStoryTitle` changed from `📝 Story Title 📝` to `📖 Story Title` (matching
the emoji `lblManageStoryTitle` already used for the same concept elsewhere) and `lblMetaSummary`
dropped its trailing `📝` — the two fields shared one emoji before this, now they don't. Review
Tags' caption moved from trailing the button to sitting between Edit Story Tags and Review Tags,
and its text simplified to "Approve or reject submitted tags." Component counts unaffected (37
Settings / 25 Metadata) — the new heading text replaced existing text in place, no new nodes.
- **Manage Entries, Manage Turns, and Manage Users are Settings-tab only now** — none of them
  relate to Metadata content, so there's no reason to show them (or pay their component cost)
  while metadata-editing; switching back to Settings is one click. **Review Tags moved the other
  direction**, out of that group and onto the Metadata tab directly under `[Edit Tags]`, since
  approving/rejecting tag submissions is what populates that field. Change Story Status and Save
  Settings still render on both tabs — a staged edit on either tab still needs Save.
- Every field-cluster edit button gained an explicit verb for consistency:
  `Edit Title and Summary`, `Edit Story Info`, `Edit Story Settings`, `Edit Story Metadata`,
  `Edit Story Tags` (Manage Entries/Turns/Users/Review Tags already had one).

Diagram and "Component budget check" below are the original 2026-08-21 design as first shipped;
see the component-budget paragraph's own 2026-08-22 update for the corrected, code-verified counts
after this split.

**Added 2026-08-21:** the persistent action-row area gets a short `TextDisplay` label above it
(landed as "🛠️ Story Management" — "Story Actions" read as too generic, and this echoes the
existing "Manage Entries"/"Manage Turns" button vocabulary already in the same row) — this is the
direct fix for the entry-point audit's Manage Turns finding
(`PLAN-help-system-redesign.md`: Skip/Extend/Reassign have zero inline explanation anywhere,
only on a help page most admins never open). Same pattern as everything else here: label +
orientation text stays inline (a person looking at this panel needs to know what "Manage Turns"
even opens without a click), and the fuller explanation stays reachable as a `renderContextual`
popup from that same help plan, once that mechanism exists — this panel doesn't need to duplicate
it.

Each field cluster follows the compact-glossary pattern already established for the help-system
redesign: one `TextDisplay` with tight label:value lines, not one box per field — these are
independent facts (content shape: glossary), not a sequence, so per that plan's Design Principle 1,
boxing each one separately would add scroll cost with no comprehension gain. Each cluster's edit
button is its own `TextDisplay` + trailing `ActionRow` (not a `Section` accessory) — same
verified pattern as the help redesign's Setup button, for the same reason: `Section`'s accessory
is side-by-side-only and squeezes the text.

The existing `sectionLine`-padded fake-header embed fields (e.g. `{ name: sectionLine + ' ' +
cfg.txtStoryAddSectionBreakInfo + ' ' + sectionLine, value: '​' }`, using a zero-width space
because classic embed fields can't have an empty value) go away entirely — a `TextDisplay` heading
line doesn't need that workaround.

### Component budget check

Estimated for `/story manage`, Settings tab active (busiest realistic case, conservatively
assuming nested children count individually toward the 40-component cap — unconfirmed either way
per the help-redesign plan's Open Risks): tab-toggle row (~3) + 3 field clusters, each
`TextDisplay` + `ActionRow` + `Separator` (~5 each, ~15 total) + persistent action rows (Manage
Entries/Turns/Review Tags, Joins/Pause/Close, Save Settings — ~9) + Container wrapper (1) ≈ 28.
Comfortable headroom under 40 even in the conservative interpretation.

**Revised 2026-08-22 (code-verified, not estimated):** ran the actual `buildManageMessage()`
against a mock config/state and counted every nested node in the real `.toJSON()` output —
Settings tab, admin/creator, all fields populated (the actual worst case) comes to **37**, not the
~28 estimate above; the gap is mostly the Story Management label/captions and the Change Story
Status/Save Settings block, which the original estimate undercounted. That 37 was measured
*before* this same day's Settings/Metadata split (see the layout note above) removed Review Tags
from that row; post-split it's still 37 on Settings (Review Tags leaving is offset by nothing —
Manage Entries/Turns/Users stayed put), but **Metadata drops to 25** now that it no longer carries
the Story Management block at all. Both are under Discord's documented 40-per-message ceiling;
`story/manage.js` carries the up-to-date inline comment and fallback plan (drop the one purely
decorative `Separator` first) if a future field addition pushes Settings' 37 closer to the limit.

### `IsComponentsV2` is all-or-nothing per message

Every caller of `buildStoryEmbed()`/`buildStoryAddMessage()`/`buildManageMessage()` needs its reply
payload shape changed from `{ embeds: [...], components: [...] }` to `{ components: [...], flags:
MessageFlags.IsComponentsV2 }` — confirmed against Discord's docs that this flag disables `content`
and `embeds` entirely, no mixing. Every call site sending this panel needs auditing, not just the
builder function itself.

### Files touched
- `story/_metadataModals.js` — `buildStoryEmbed()` becomes `buildStoryPanel()`, rebuilt as a
  `ContainerBuilder` per the layout above, with an `activeGroup` param
- `story/add.js`, `story/manage.js` — button handlers for the tab toggle and each cluster's edit
  button (mostly relabeled/repositioned versions of the existing `story_*_open_*` handlers — the
  modals they open don't change); state needs an `activeGroup` field (defaults to `'settings'`);
  every `interaction.reply`/`editReply` call sending this panel updates to the Components V2
  payload shape

---

## Part 1b — Move Manage Users onto the manage panel ✅ Implemented 2026-08-21

**Shipped with one correction from the initial design:** the two-step flow landed as: click
"Manage Users" (Settings-tab persistent row, gated to **creator-or-admin** — matching `/story
manage`'s own access level, hidden entirely rather than shown-disabled for anyone else) → a modal
with a `StringSelectMenu` of the story's current active/paused writers (built from `story_writer`'s
already-stored `discord_display_name`, no extra Discord API fetch needed) → submitting it opens the
existing Manage User panel, unchanged.

**Refactor to enable reuse:** extracted `handleManageUser`'s body (from the story lookup onward)
into `openManageUserPanel(connection, interaction, storyId, targetUserId, guildId,
writerDisplayName?)` in `story/_manageUser.js` — called by both the original `/storyadmin user`
slash command (unchanged, kept as a power-user shortcut per the plan's own open choice) and the new
panel button. The actual writer-management logic (pause/unpause/remove/pen name/etc.) needed no
changes at all, as anticipated.

**Server-side admin re-check** on both the button click and the modal submit, not just the
client-side hide — a hidden button is not an authorization boundary on its own.

Folded in from a standalone TODO.md item. Currently `/storyadmin user` (`commands/storyadmin.js`,
routes to `story/_manageUser.js`) is a separate slash command taking `story_id` and `user` as
required options. The idea: add a "Manage Users" button to `/story manage`
(`story/manage.js`'s `buildManageMessage()`) that opens a two-step modal (pick the writer, then
manage them) instead of requiring a standalone command with both params typed up front.

**Doesn't actually require the Part 1 rework to fit** — this was true under the original classic-
embed design (row 2's 2/5, row 4's 3/5, row 5's 1/5 all had spare slots) and remains true under
Part 1's Components V2 rebuild: the persistent action-row area (Part 1's component budget check
already has headroom to ~40) has plenty of room for one more button. Bundling it with Part 1 anyway
since the panel's layout is already being touched — natural home is next to Manage Entries/Manage
Turns in the persistent row set, unaffected by which tab (Settings/Metadata) is active.

### Files touched
- `story/manage.js` — new button (likely row 2, next to Manage Entries/Manage Turns),
  new button handler that opens the first step of the two-step modal
- `story/_manageUser.js` — needs a modal-based entry point instead of (or in addition to) the
  current command-argument-based one; the existing management logic itself shouldn't need to change
- `commands/storyadmin.js` — decide whether `/storyadmin user` stays as a power-user shortcut or
  gets removed once the panel button covers the same flow

---

## Part 2 — Ground Rules

### Concept
Per-story, zero-to-many tags directing writer *tone/intent* — not overlapping with existing
free-text `tags`. Vocabulary (the option set) is server-defined; each story picks any subset.

### Example rules (loaded for every new and existing server, editable/deleteable)
```"Anything Goes
This story is open to any and all ideas. Go wild!

Maintain Tonal Harmony
Match the vibe of the story so far. Keep the balance of humor and seriousness consistent with the previous entries, ensuring a cohesive mood.

Preserve Lore Integrity
Stick to the core elements of the setting for things like character fate or basic world facts. Don't introduce drastically new mechanics (like new characters, magic, or new biology) to a story without checking in with the rest of the group.

Keep It Clean
This story's rating will stay in the Teen or lower range."```

### Component: Checkbox Group,
`CheckboxGroupBuilder` wrapped in `LabelBuilder`, same pattern as the existing fields in `buildMetadataModal()`. **Hard cap: 10 options** (Discord platform limit).

### Server-level authoring — `/storyadmin setup`

New paragraph text field (`TextInputStyle.Paragraph`), added to the existing setup modal flow
in `commands/_storyadminSetup.js`.

- **Pre-filled with the four default rules already correctly formatted** when a guild has none
  configured yet — this teaches the format by example rather than by instruction.
- Modal `Label` description text (shown above the field):
  > "Max 10 rules: label on the first line (max 40 characters), description below it
  > (max 150), blank line between rules."
- **Format:** blank-line-separated blocks. Line 1 of each block = label. Remaining line(s) =
  description.
- **Label required. Description optional — blank is fine.**
- **Parsing:** split on one-or-more consecutive blank lines (tolerant of doubled blank lines,
  don't require exactly one).
- **Validation — reject the whole submission on any error, no partial saves:**
  - More than 10 blocks
  - Any label missing or >40 chars
  - Any description >150 chars
  - Error message must name the specific offending rule (by its label or position), e.g.
    *"Rule 3 ('Keep It Clean and Don't Raise the Rating!!!') — label exceeds 40 characters."*
- **On validation failure:** re-show the paragraph field pre-filled with exactly what the admin
  submitted (don't discard their input), plus the specific error. Verify at implementation time
  whether `showModal()` can be called directly from a `ModalSubmitInteraction`, or whether an
  intermediate ephemeral reply + "Try Again" button (which reopens the pre-filled modal) is
  needed — check installed `discord.js` source per `docs/reference/discordjs_reference.md`'s own guidance
  rather than assuming from training data.
- **On success:** re-render the **setup panel embed** (not the modal) showing confirmation.
  Display green check and rule labels only, comma-separated, not full text — full descriptions can exceed
  a single embed field's 1024-char cap across 10 rules, and the setup panel only needs an
  at-a-glance confirmation, not a place to re-read full rule text. This field behaves like every
  other setup panel field: it reflects current saved state regardless of whether that particular
  save touched it. If Rules are empty, display red X and approved text: "No Ground Rules Configured."

### Setup panel field count
Currently **9 fields** (Feed, Media, Admin Role, Restricted Feed, Restricted Media, Roundup
Channel, Roundup Day, Roundup Hour, Changelog) — see `commands/_storyadminSetup.js`
`buildSetupPanel()`. Ground Rules becomes the 10th. Plenty of room.

### Storage

**Server vocabulary — one config value — this codebase already has the right
precedent in `cfgFaqPostIds` (`db/config_files/config_system.sql`), which stores a
variable-length list as a single delimited config row. Store the Ground Rules vocabulary as
**one new config key** holding the raw formatted block text (same blank-line format used for
admin input) — parse it identically on save and on every read. New key name: `cfgGroundRules`
(guild-scoped like other `cfg*` keys).

**Per-story selection — new column, stable slugs, not raw labels.** New `story.ground_rules`
TEXT column (same shape/pattern as the existing `tags` column — comma-delimited, no new table).
Store **stable slugs** derived from each rule's label (e.g. `maintain-tonal-harmony`), not the
raw label text.

**Important constraint this storage choice creates:** because the vocabulary is a flat re-parsed
text blob (no hidden per-rule ID), a label edit is otherwise indistinguishable from a
delete-and-recreate — a plain "generate slug from label" approach means fixing a single typo in
a rule's label would silently strip that rule from every story that had it selected. That is
not acceptable, so the save handler needs an explicit diff step:

1. Before overwriting `cfgGroundRules`, fetch and parse the **previous** value the same way as
   the new submission.
2. Match rules between old and new lists **by exact label text**, not by position — position-based
   matching would break under reordering, which needs to keep working freely.
3. Labels unchanged between old and new (wherever they've moved to) keep their existing slug
   automatically — no admin involvement.
4. What remains after that match is two small sets: labels that disappeared, labels that are new.
5. **If exactly one label disappeared and exactly one appeared in the same save** — the
   single-rename case (e.g. a typo fix) — do not resolve this silently. Surface a one-question
   confirmation before finalizing the save: *"'[old label]' → '[new label]' — same rule renamed
   (existing stories keep it), or a new rule replacing it (existing stories lose the old tag)?"*
   Two buttons. Only this specific ambiguous case requires the extra step.
6. If multiple labels vanish and multiple appear in the same save, the mapping between them is
   genuinely ambiguous — default to treating each as an independent delete/add (matches the
   plain "orphan on deletion" behavior below), but list the affected labels to the admin as a
   heads-up rather than resolving it fully silently.

If a story references a slug no longer present in the guild's current vocabulary after all of
the above (a rule was actually deleted, not renamed), skip it silently at render time rather
than erroring.

### Story-level selection — `/story add` AND `/story manage`

Add the Checkbox Group to the **existing shared `buildMetadataModal()`** function in
`story/_metadataModals.js` (already takes a `namespace` param handling both `'story_add'` and
`'story_manage'` identically) — this means adding it once covers both flows with no duplicated
logic. Options are built dynamically from the guild's `cfgGroundRules` config value at modal-open
time (not a hardcoded array like `warningOptions`/`dynamicOptions`).

### Display locations

- **Story status post** (`story/_storyStatus.js`) — add to the existing `metadataFields` array,
  same conditional-push pattern already used for `characters`/`tags`/`warnings` (only shown if
  the story has any selected). Plenty of room, nowhere near the 25-field cap here.
- **Join panel** (`story/join.js`) — add as a 4th field (currently only 3 used). Read-only
  display so writers see it before committing to join.
- **Turn thread welcome message** (`story/_turn.js`, `postWelcomeMessage()`) — **convert from
  plain `content` to an embed.** This is also needed for the separately-planned scene-break/
  translation instructions rework, and closes a real risk: plain `content` parses `@everyone`/
  role/user mentions live and will actually ping people; embeds never parse mentions regardless
  of what admin-authored text ends up in them. This is the only place in the bot currently
  sending user-adjacent freeform text as plain content — closing it before Ground Rules text
  flows through it matters.
- **Manage panel** — blocked until Part 1 (section split) lands. Add to the Metadata group once
  it exists.

### Change notifications

Reuse the existing `postStoryThreadActivity()` helper (`story/_turn.js`, already used for
turn-start announcements). On `/story manage` save, diff the story's old vs. new
`ground_rules` selection; if changed, post an announcement to the story thread. This is a
**story-level** side effect only — editing the server's master vocabulary in `/storyadmin setup`
does not trigger any story thread posts.

---

## Part 3 — Warnings: convert to Checkbox Group ✅ Implemented 2026-08-21

Same component conversion as Ground Rules, smaller and self-contained — good first PR to prove
the pattern before Ground Rules builds on top of it.

**Shipped as designed, plus two things found along the way:**
- `handleManageSelectMenu` (`story/manage.js`) turned out to be entirely dead code — both its
  branches (`story_manage_rating_select`, `story_manage_warnings_select`) had zero component
  builders anywhere producing those customIds, confirmed by exhaustive search. Removed the whole
  function, its export, its import in `commands/story.js`, and its dispatch branch (the only live
  `story_manage_*_select` customId, `story_manage_ta_next_select`, was already claimed by the more
  specific `story_manage_ta_*` branch checked first).
- `txtManageWarningSelectInstructions` (the `__dismiss__` placeholder's label) is now orphaned —
  removed from `config_metadata.sql` and `config_roadmap.md`. Left as a harmless orphan row in the
  live DB per the same additive-only `sync-config.js` behavior established in the help-redesign
  plan, not force-deleted.

Currently a `StringSelectMenuBuilder` with `setMaxValues(warningOptions.length)`
(`story/_metadataModals.js` line ~184), carrying a workaround: a fake `__dismiss__` placeholder
option (line 191) that exists only so the dropdown renders something, then gets filtered back
out on submit (`story/add.js` line 241, `story/manage.js` line 564). A real checkbox group needs
none of this — remove the `__dismiss__` hack entirely.

`warningOptions` (`story/_metadata.js`) has 7 entries — fits the 10-cap with room to spare, no
need to trim.

### Read-back changes
- `story/add.js` line 237, `story/manage.js` line 564:
  `interaction.fields.getStringSelectValues(...)` → `interaction.fields.getCheckboxGroup(...)`
- Remove the `.filter(v => v !== '__dismiss__')` line in both files (no longer needed)

---

## Suggested build order

1. ✅ Warnings → Checkbox Group conversion (small, proves the pattern, no schema changes) — done 2026-08-21
2. ✅ Panel display rework (Settings/Metadata split, Components V2) — done 2026-08-21, unblocks everything else
3. ✅ Move Manage Users onto the manage panel (Part 1b) — done 2026-08-21
4. Ground Rules: server-vocabulary setup modal + parser/validator
5. Ground Rules: story-level checkbox field in `buildMetadataModal()`
6. Ground Rules: `story.ground_rules` column + stable-slug generation + storage
7. Ground Rules: display wiring (status post, join panel, manage panel)
8. Turn thread welcome message → embed conversion (bundle with scene-break/translation
   instructions rework)
9. Ground Rules: change-notification post to story thread on save

---

## Explicitly out of scope for this plan
- Kudos (reaction → thread repost feature) — deprioritized, not part of this plan
- Numbered config keys (`cfgGroundRule1Label` etc.) — decided against, see Storage section
