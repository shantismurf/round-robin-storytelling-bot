# Plan: Add/Manage Panel Rework + Ground Rules + Warnings Checkbox Conversion

Status: Pending
Created: 2026-07-26 (drafted in an earlier Claude Code chat session; committed to the repo on this date)
Last Updated: 2026-07-26 (added Part 1b, folded in from a separate TODO.md item)

Design finalized in chat, implementation not started.

---

## Context

`/story manage`'s embed is at 21/25 fields and 5/5 action rows (fully maxed). `/story add`
is close behind (18 fields, 4/5 rows). Root cause: v3.0 modularized *editing* into separate
modals but never modularized the *display* — the embed still renders every field at once
regardless of what's relevant. This blocks adding Ground Rules (or anything else) to those
panels until the display is reworked.


---

## Part 1 — Panel Display Rework (Settings / Metadata split)

Two groups only, per decision: **Settings** and **Metadata**.

### Proposed field grouping

**Settings** (mechanical/structural):
- Title & Summary
- Mode, Writer Order
- Turn Length, Timeout Reminder, Delay Start, Max Writers
- Show Authors, Turn Privacy, Scene Break Divider
- *(story add only)* Join Settings — pen name, join privacy, notifications

**Metadata** (AO3-style descriptive):
- Rating, Dynamic, Warnings
- Main Pairing, Other Relationships, Characters, Tags
- Ground Rules (new — see Part 2)

**Open decision to confirm before building:** Rating currently lives in the "always shown"
14-field block in `buildStoryEmbed()` (`story/_metadataModals.js` line ~109), not the
metadata-only block. Moving it into Metadata is a recategorization, not just a display change
— confirm this is wanted. Similarly, Join Settings only applies to `/story add` (not manage);
current assumption is it folds into the Settings group for the add flow specifically, since
`isManage` already branches this in `buildStoryEmbed()`.

### UI mechanism

Two-group is a binary choice — use a **button pair, not a select menu**: `[Settings]` /
`[Metadata]`, with the currently-active view visually distinct (e.g. `ButtonStyle.Success` for
active, `ButtonStyle.Secondary` for inactive) so "you are here" is unambiguous at a glance.
This is clearer than a dropdown for a 2-option choice and costs only 1 action row.

The embed re-renders to show only the active group's fields when toggled. This is what frees
the room needed for Ground Rules and any future fields — collapsing ~21 always-visible fields
down to ~7-10 per view.

### Files touched
- `story/_metadataModals.js` — `buildStoryEmbed()` needs a `activeGroup` param to filter which
  fields get added
- `story/add.js`, `story/manage.js` — new button handlers for the group toggle, state needs an
  `activeGroup` field (defaults to `'settings'`)

---

## Part 1b — Move Manage Users onto the manage panel

Folded in from a standalone TODO.md item. Currently `/storyadmin user` (`commands/storyadmin.js`,
routes to `story/_manageUser.js`) is a separate slash command taking `story_id` and `user` as
required options. The idea: add a "Manage Users" button to `/story manage`
(`story/manage.js`'s `buildManageMessage()`) that opens a two-step modal (pick the writer, then
manage them) instead of requiring a standalone command with both params typed up front.

**Doesn't actually require the Part 1 rework to fit.** The panel is at 5/5 *action rows* (the
hard cap — no 6th row possible), but individual rows aren't at their own 5-button cap: row 2
(Manage Entries, Manage Turns) has 2/5, row 4 (Join toggle, Pause/Resume, Close/Reopen) has 3/5,
row 5 (Save Settings) has 1/5. A "Manage Users" button could slot into any of those today.
Bundling it with Part 1 anyway since the panel's layout is already being touched, and because
the Settings/Metadata split may change which row makes sense for it (e.g. row 2 next to Manage
Entries/Manage Turns reads as the more natural home once the layout stabilizes).

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

## Part 3 — Warnings: convert to Checkbox Group

Same component conversion as Ground Rules, smaller and self-contained — good first PR to prove
the pattern before Ground Rules builds on top of it.

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

1. Warnings → Checkbox Group conversion (small, proves the pattern, no schema changes)
2. Panel display rework (Settings/Metadata split) — unblocks everything else
3. Move Manage Users onto the manage panel (Part 1b) — independent of the rest, but natural to
   do alongside Part 1 since both touch `buildManageMessage()`'s button rows
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
