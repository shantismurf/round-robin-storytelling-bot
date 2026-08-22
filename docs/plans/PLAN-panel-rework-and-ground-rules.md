# Plan: Add/Manage Panel Rework + Ground Rules + Warnings Checkbox Conversion

Status: Pending
Created: 2026-07-26 (drafted in an earlier Claude Code chat session; committed to the repo on this date)
Last Updated: 2026-08-22 (Part 1c shipped — ported over from a separate, never-merged branch
where it had been designed/approved 2026-08-10 but never coded; see Part 1c's own note)

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
- **Resolved 2026-08-22 — was flagged as an open risk, now confirmed and fixed.** The
  `story_manage_close_open` transition originally edited from this Components-V2 panel to a
  plain `content`/`components` reply, reusing `story/close.js`'s `handleCloseConfirm`/
  `handleCloseCancel` (shared with the standalone `/story close` command). Confirmed against
  Discord's own docs that `IsComponentsV2` can never be removed once a message carries it ("Once
  a message has been sent with this flag, it can't be removed from that message") — so that plain
  reply was actually broken, not just unverified, and simply switching it to Components V2 would
  have only moved the same problem one click later, since `handleCloseCancel` and part of
  `handleCloseConfirm` also reply in plain format. Fixed by giving the manage panel its own
  `story_manage_close_confirm`/`story_manage_close_cancel` customIds, handled in the new
  `story/_manageClose.js` — reuses `close.js`'s actual close logic (`closeStoryInternals`,
  `getStoryStats`, export-row build, thread-post, feed announcement) but replies in Components V2
  throughout. `close.js`'s existing handlers are untouched and still serve the standalone command
  exactly as before. This is intentionally a temporary fork, not a permanent duplication — tracked
  in `docs/TODO.md` as a follow-up to eventually convert `close.js` to V2 as well and delete
  `_manageClose.js`, restoring the single shared flow.
- `story/manage.js` is at 690 lines, `story/add.js` at 501 — both over the 500-line standard;
  logged in `docs/TODO.md`'s existing file-size-split item rather than opportunistically splitting
  mid-rework. The close-confirm fix above deliberately went to its own new file
  (`story/_manageClose.js`, 125 lines) instead of growing `manage.js` further, given it was
  already over budget.

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
  (`# Story Info and Settings` / `# Story Metadata and Tags` via `buildStoryPanel`'s new `titleMetadata`
  param) — previously the header was a single static string shown unchanged regardless of which
  tab was active, which read as broken once the Metadata tab existed. Tab button labels also
  changed from "Settings"/"Metadata" to "**Display Settings**"/"**Display Metadata**" so the verb
  makes clear they toggle the view, not act on it.

**Revised 2026-08-22 (header hierarchy pass):** the field-cluster labels (`ℹ️ Story Info`, `⚙️
Story Settings`, `🗂️ Story Metadata`, `🖊️ My Join Settings`) became real `##` markdown headers
instead of manually bolded text (`**...**`), and `🛠️ Story Management` was promoted to `#` —
same visual weight as the page title, marking it as a distinct region rather than another field
cluster. A `## 🏷️ Story Tags` header was added above the Relationships/Characters/Tags cluster,
which previously had none. Page-level `#` titles (Story Info and Settings / Story Metadata and
Tags / Add's Create New Story) deliberately stay emoji-free — there's exactly one per screen and `#`'s
size already carries it; emoji are reserved for the repeated `##` pattern where they help you find
the right section. `lblStoryTitle` changed from `📝 Story Title 📝` to `📖 Story Title` (matching
the emoji `lblManageStoryTitle` already used for the same concept elsewhere) and `lblMetaSummary`
dropped its trailing `📝` — the two fields shared one emoji before this, now they don't. Review
Tags' caption moved from trailing the button to sitting between Edit Story Tags and Review Tags,
and its text simplified to "Approve or reject submitted tags." Component counts unaffected (37
Settings / 25 Metadata) — the new heading text replaced existing text in place, no new nodes.

**Revised 2026-08-22 (readability pass — Story Info / Story Settings restructure):** each field
in these two clusters changed from one dense line (`emoji **Label:** value — description`) to
two: `**Label:** value` on its own line, then the description as `-#` subtext directly under it
— same small/muted treatment the Story Management captions already used, so the description
reads as secondary to the label+value line above it. The blank line between fields (added
earlier this same day) was dropped again for just these two clusters once fields started taking
two lines each — the two-line shape plus the subtext's muted weight already separates them, and
the panel was getting long. Metadata's and Tags' clusters keep the blank-line spacing, since
their fields are still single-line with nothing else to keep them from running together.
Show Names and Turn Thread Privacy previously had no short value, only a description — reused
the existing generic `txtOn`/`txtOff`/`txtPrivate`/`txtPublic` keys rather than adding new ones.
Scene Break Divider, Rating, Turn Length, Reminder Timing, and Max Writers have no description
text at all, so they stayed single-line rather than inventing filler.

**Also found and fixed in the same pass:** Delay Start was rendering on the Manage panel
("0 hours / 0 writers (leave blank to start immediately)") despite being meaningless there —
`state.delayHours`/`delayWriters` are hardcoded `null` in `manage.js`'s state init and never
loaded from the DB, and Manage's "Edit Story Settings" modal has no delay fields at all (only
Turn Length, Timeout Reminder, Max Writers). It's an Add-only concept (governs when a story's
first turn starts, before the story exists yet as far as Manage is concerned) and is now gated
`!isManage`.

**Also: `txtManageSaveWarning`'s heading level.** Started at `##`. A live screenshot comparing
`🛠️ Story Management` (`#`) against `ℹ️ Story Info` (`##`) against plain `**bold**` field labels
settled the actual hierarchy Discord renders — three real tiers, not two: `#` is a distinctly
large headline, `##` is visibly bigger than bold body text (a genuine middle tier), and `###`
renders close to bold weight but with more line-height around it. Landed on `###` for the save
warning — smaller than the `##` cluster headers it doesn't need to compete with, but still reads
as its own line rather than blending into plain body text.

**Also: `txtChangeStoryStatusLabel` was still plain `**bold**`**, missed during the header-hierarchy
pass that promoted `🛠️ Story Management` — caught live (screenshot showed it not matching). Now
`## 🚦 Change Story Status`, same level as the Story Info/Story Settings cluster headers.
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

**Bug found live 2026-08-22:** the `story_manage_users_open` button handler never declared
`const cfg = state.cfg;` (every sibling branch in `handleManageButton` does), so clicking Manage
Users threw `ReferenceError: cfg is not defined` on the first bare `cfg.` reference. Fixed by
adding the same declaration the other branches already use.

**Also found while testing this flow live:** `story/_manageUser.js`'s Manage User panel (shared
by this button and the standalone `/storyadmin user`) had Pen Name saving immediately on modal
submit, while Notifications and Turn Privacy were staged behind a Save Settings button — a
three-way split the panel's own note text never actually described (it claimed only
notifications/privacy were staged, silent on pen name). Moved Pen Name into the staged group:
`handleManageUserModalSubmit` now only updates `pending.penName` in memory, and
`storyadmin_mu_save`'s `UPDATE` now includes `pen_name` alongside `notification_prefs`/
`turn_privacy`. The note itself moved from `.setDescription()` (top of the embed) to a trailing
zero-width-name field (bottom of the embed, same convention already used there for the
active-turn/last-writer warnings) and now correctly lists all three staged fields — key renamed
`txtManageUserPanelDesc` → `txtManageUserPanelSaveNote` to match its new role and position.

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

## Part 1c — Unsaved-changes indicator on `/story manage`

**Status: Shipped 2026-08-22.**

Originally designed and approved 2026-08-10 on a separate, never-merged branch
(`claude/todo-panel-rework-review-t4leg9`) that had independently rebuilt overlapping Part 1/1b/3
work — that branch's plan doc had this section, this repo's didn't, and the gap wasn't noticed
until the user asked about it directly during this session. The design below carries over that
approved reasoning and text verbatim; only the mechanism/display sections were re-decided against
the current, already-shipped Components V2 panel rather than applied as originally written.

Nothing typed into the manage panel persists to the DB until **Save Settings** is clicked
(`story_manage_save` → `handleManageSave`, `story/manage.js`). Everything staged before that lives
only in the in-memory `pendingManageData` session state. Discord gives the bot no hook for a user
dismissing an ephemeral message, and the 15-minute interaction-token expiry is likewise silent —
so a user who edits several fields and then dismisses or lets the panel time out loses those edits
with no warning. The only real fix is a persistent on-panel warning while unsaved edits exist, not
an interception of the dismiss itself (not possible).

**Scope: `/story manage` only.** `/story add` was considered and explicitly excluded — creation
already carries the obvious expectation that nothing exists until the final Create button is
clicked, so a matching warning there would be redundant. (Decided 2026-08-10.)

**Mechanism — dirty-state detection (as built):** `story/manage.js` lists every state field a
manage-panel modal or toggle button stages before Save in a flat `STAGED_FIELDS` array (title,
summary, storyMode, orderType, showAuthors, storyTurnPrivacy, sceneBreakDivider, turnLength,
timeoutReminder, maxWriters, dynamic, rating, warnings, mainPairing, otherRelationships,
characters, tags, allowJoins, targetStatus). `handleManage()` snapshots those fields into
`state.originalFields` right after `state` is built (current === original for all of them at that
point by construction). `isManageDirty(state)` diffs current values against that snapshot on every
`buildManageMessage()` render — array fields (just `warnings`) are compared order-independently,
since a checkbox-group resubmit can return the same set in a different order without that being a
real edit. This is a flat list diffed generically rather than a matching `originalX` field per
entry (the `originalStatus`/`originalRating` pattern the 2026-08-10 design note started from) —
one list to keep in sync with the staging call sites, not two. Both `isManageDirty` and
`STAGED_FIELDS` are exported and covered by `test/manage_isManageDirty.test.js`.

**Display — replaces the static banner, doesn't sit alongside it.** The panel already had a
different, always-visible warning here (`txtManageSaveWarning`, `### === You Must Click Save
Settings to Apply Changes! ===`) shipped independently earlier this same session, without
knowledge of this approved design. Decided to replace it rather than keep both: `/storyadmin
setup` still carries its own always-on version of that same warning (`txtSetupModalSaveWarning`,
out of this scope), so the "this panel stages, remember to save" education isn't lost — repeating
it unconditionally on every single manage-panel render on top of that was just noise. The
dirty-only version now shows a Components V2 `TextDisplay` immediately above the Save Settings
button, only when `isManageDirty(state)` is true:

```
**⚠️ Unsaved Changes**
You have changes that haven't been saved yet. Click **Save Settings** below to keep them.
```

The original 2026-08-10 design called for a dedicated embed field (name/value) — re-decided
against that shape since the panel is Components V2 now, not embeds; a two-line `TextDisplay`
with a bold title line is the direct translation of "field name, field value" into this panel's
existing conventions. The exact wording is unchanged from what was approved 2026-08-10. Config
keys: `lblManageUnsavedChangesTitle` (title, was `lblManageUnsavedChangesTitle` in the original
design too) and `txtManageUnsavedChangesBody` (body, with the button label as a real
`[save_label]` token via `replaceTemplateVariables()` rather than the literal string "Save
Settings" hard-coded into the body text, so it can't drift from `btnSaveSettings`).

### Files touched (as built)
- `story/manage.js` — `STAGED_FIELDS`, `isManageDirty()`, the `state.originalFields` snapshot in
  `handleManage()`, and the conditional `TextDisplay` replacing the static banner in
  `buildManageMessage()`
- `story/_metadataModals.js` — `getMetaCfg()`'s shared config fetch list swapped
  `txtManageSaveWarning` for the two new keys (shared with `/story add`, which doesn't use them)
- `db/config_files/config_story.sql` — removed `txtManageSaveWarning`, added
  `lblManageUnsavedChangesTitle`/`txtManageUnsavedChangesBody`
- `test/manage_isManageDirty.test.js` — new, 7 tests covering clean/dirty scalar and array cases,
  array-reorder-is-not-dirty, an untracked field (tab switch) not tripping it, and the
  not-yet-snapshotted guard

### Found, not fixed (separate, pre-existing bug)
While tracing `state.targetStatus`/`originalStatus` for the dirty check, found that
`story_manage_reopen` (`handleManageButton`) writes the reopen straight to the DB but never
updates `state.targetStatus`/`originalStatus` afterward — the re-rendered panel still shows the
"Reopen" button and a disabled Pause/Resume row until the panel is reopened fresh. Predates this
session and this feature; doesn't interact with the dirty check (reopen isn't a staged field, so
it correctly reports clean either way) — logged in `docs/TODO.md` rather than fixed here, since
it's out of Part 1c's scope.

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
- **On success** (immediately if the diff is pure-additions, otherwise after the admin clicks
  Confirm on the summary screen in the Storage section below): re-render the **setup panel
  embed** (not the modal) showing confirmation.
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
5. **If exactly one label disappeared and exactly one appeared in the same save**, it's a rename
   *candidate* (e.g. a typo fix) — flagged as such on the confirmation screen below, not applied
   silently.
6. If multiple labels vanish and multiple appear in the same save, the mapping between them is
   genuinely ambiguous — no rename guess is made; each shows as a separate Added/Removed entry
   on the same confirmation screen instead.

If a story references a slug no longer present in the guild's current vocabulary after all of
the above (a rule was actually deleted, not renamed), skip it silently at render time rather
than erroring.

**Revised 2026-08-22 — unified confirmation screen.** Originally this was two separate
mechanisms: a blocking two-button prompt only for the single-rename case, and a vaguely-specified
"heads-up" for everything else (unclear whether it blocked the save or just informed after).
Replaced with one screen, shown after validation and the diff above, before anything is written
to `cfgGroundRules`:

- **Added:** [labels] — no confirmation needed on its own (nothing existing can break from an
  addition), so if the diff contains *only* additions, skip this screen and save immediately.
- **Removed:** [labels], each with how many stories currently reference it — `SELECT
  COUNT(*) FROM story WHERE FIND_IN_SET(?, ground_rules)` per removed slug (or one query across
  all removed slugs). "Keep It Clean — currently used by 12 stories" is the actual warning; a
  bare label name isn't.
- **Renamed:** [old label] → [new label], for the single-swap case only from step 5 above.
  Multi-swap ambiguity (step 6) still lists as separate Added/Removed entries on this same
  screen, never guessed at as a rename.
- **Confirm / Cancel.** Cancel returns to the pre-filled paragraph modal with the admin's
  submitted text intact (same re-show behavior as a validation failure); nothing is written to
  `cfgGroundRules` until Confirm. This is the only point where the write happens — the diff step
  above is read-only until this gate passes.

This subsumes the old single-rename prompt (now just one row on the summary rather than its own
interruption) and resolves the old ambiguity about whether the multi-change case blocked the
save — it now unambiguously does, on the same screen as everything else.

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
- **Manage panel** — blocked until Part 1 (section split) lands. **Revised 2026-08-22:** now that
  Part 1 shipped and the Metadata tab split into two `##` sub-clusters, Ground Rules belongs in
  the **🗂️ Story Metadata cluster** (Rating/Dynamic/Warnings), not the 🏷️ Story Tags cluster —
  it's edited via the same `buildMetadataModal()` opened by `[Edit Story Metadata]`, so display
  location should follow the edit button it's paired with, same as every other field here.

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
