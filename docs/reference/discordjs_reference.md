# discord.js Reference — Verified Against the Installed Version

**Installed: discord.js 14.27.0** (check `node_modules/discord.js/package.json` if in doubt —
this number has moved before without this doc being updated alongside it; a session that finds
a mismatch should re-verify anything version-sensitive below rather than trust it blind).
`@discordjs/builders` ships as a dependency of `discord.js` itself, not a separate
`node_modules/@discordjs/builders` version to track independently — check
`node_modules/@discordjs/builders/package.json` if you need its own number.

**The rule:** Do NOT trust training data about the discord.js API. This project's installed
version supports features that most LLM training data predates or misnames. Before writing,
reviewing, or declaring a bug in any discord.js component/modal code, check this doc; if it
doesn't cover the question, read the installed source under `node_modules/discord.js/src/`
(`structures/` for runtime classes, and `node_modules/@discordjs/builders/dist/` for builders).
Treat discordjs.guide and discord.js.org as version-suspect — they document the latest release,
which may not match what is installed here.

---

## Components V2 — the flag, and what it forbids

Set via `flags: MessageFlags.IsComponentsV2` on the message payload. Confirmed directly against
the installed source, `node_modules/discord.js/src/structures/interfaces/TextBasedChannel.js`:

> When using components v2, the flag `MessageFlags.IsComponentsV2` needs to be set and
> `content`, `embeds`, `stickers`, and `poll` cannot be used.

Two consequences, both load-bearing for how this codebase is built:

1. **It is per-message and one-way.** Confirmed against Discord's own developer documentation
   (not visible in the discord.js source itself, which only encodes the send-time validation
   above): once a message has been sent with this flag, it can never be removed from that
   message by a later edit. A message that started as a classic embed can never become V2 in
   place, and a message that started as V2 can never go back to plain content/embeds. **Every
   caller that later edits a V2 message must keep sending a V2-shaped payload for the rest of
   that message's life** — this is the single most common way this codebase has broken V2 panels
   (see the `/story close` example below).
2. **A fresh message is unconstrained by what any other message on the same command does.** The
   flag lives on the message, not the channel, the interaction, or the command. A panel message
   can be V2 while a terminal/interstitial reply to the *same* interaction flow is a classic
   embed, as long as that reply is a genuinely new message (a `followUp`, or a `reply` that
   hasn't touched the panel's own message ID) — see `story/manage.js`'s rating-change confirm
   prompt (`interaction.reply({ embeds: [...] })` off the metadata-modal-submit interaction,
   never touching the V2 panel message itself) for a live example.

### What's forbidden, and the fallback pattern

`content`, `embeds`, `stickers`, `poll` are unusable on a V2 message — there is no way to attach
a plain string alongside V2 components. Anywhere the old code sent `content` (an error message,
a "here's what changed" summary, onboarding text prepended to a panel) either:

- becomes a component in the same container (a `TextDisplayBuilder`, e.g.
  `buildSetupPanel()`'s `prependMessage` option in `commands/_storyadminSetup.js`), or
- becomes a separate ephemeral **follow-up** message rather than an edit of the panel itself
  (`commands/_storyadminSetupSave.js`'s validation-failure and success paths: the panel
  re-renders unchanged/in its terminal state via `editReply`, and the text goes out via a
  second `interaction.followUp({ content: ..., flags: MessageFlags.Ephemeral })`).

`finalMessage()` (`story/_metadataModals.js`, imported wherever a plain-text terminal state is
needed post-V2) wraps a string as a one-block V2 `ContainerBuilder` — the standard way to send
"just some text" once a message has to stay V2:

```js
export function finalMessage(text, extraComponents = []) {
  return {
    components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text)), ...extraComponents],
    flags: MessageFlags.IsComponentsV2,
  };
}
```

### `/story close` — the worked example of getting it wrong

`/story manage`'s Close Story button originally tried to reuse `story/close.js`'s
`handleCloseConfirm`/`handleCloseCancel` — the standalone `/story close` command's handlers,
which reply in plain `content`/`components` (that command's message never carries the flag).
The manage panel is V2. Confirmed against Discord's docs that the flag can't be removed once
set, so editing the V2 panel message with `close.js`'s plain-content reply shape would have
thrown at runtime the first time a manage-panel user clicked Close. Fixed by forking a
manage-panel-specific confirm flow into `story/_manageClose.js` — it reuses `close.js`'s actual
close *logic* (`closeStoryInternals`, `getStoryStats`, the export-row build, thread-post, feed
announcement — none of that is reply-format-coupled) but replies in Components V2 throughout,
with its own `story_manage_close_confirm`/`story_manage_close_cancel` customIds rather than
`close.js`'s `story_close_confirm_<id>`/`story_close_cancel_<id>`. This is intentionally a
temporary fork (tracked in `docs/TODO.md`) until `close.js` itself is converted to V2 and the
manage panel can route back to the shared handlers directly.

**The general lesson:** before wiring a V2 panel's button to *any* existing handler — shared
logic or not — check what shape that handler's own reply takes. If it ever sends
`content`/`embeds`/`components: []` directly, it will break the moment it's called from a V2
message, not gracefully degrade.

### Same trap, `/storyadmin setup`

`commands/_storyadminSetup.js`'s `handleSetupSave` and `handleSetupCancel` had the identical
shape before this session's V2 conversion: `interaction.editReply({ content: saved.join('\n'),
embeds: [], components: [] })` on save, and the same shape on cancel. Converting
`buildSetupPanel()` to a `ContainerBuilder` meant both had to change — see the "What's
forbidden" section above for the fix each one landed on.

---

## Component budget

Discord's documented ceiling is 40 components per message. **Unconfirmed, and treated as the
conservative assumption throughout this codebase:** whether that count is top-level container
children only, or every nested node (a `Container`'s children, each `ActionRow`'s buttons,
etc.) counted individually. `story/manage.js`'s `buildManageMessage()` carries an inline comment
with the actual measured node count (37 on the busiest tab) under the conservative
per-node-counted interpretation, verified by running the real builder against mock data and
walking `.toJSON()`'s `components` tree recursively — the same technique this session used to
smoke-test every V2 payload touched (`buildSetupPanel`, `buildMetadataModal`,
`buildGroundRulesModal`, the two-tier panel's render options). `@discordjs/builders` does not
validate this client-side — confirmed by searching `node_modules/@discordjs/builders/dist/
index.js` for a component-count limit and finding none — so a payload that exceeds the true
server-side limit fails only at send time, not at build time. When in doubt, run the same
node-counting smoke test against the real builder rather than guess.

---

## Which builders go where

**Top-level in a V2 message** (children of the message's own `components` array, or nested
inside a `ContainerBuilder` — confirmed against `ContainerBuilder`'s own `add*Components`
methods in `node_modules/@discordjs/builders/dist/index.js`): `ContainerBuilder`,
`ActionRowBuilder`, `TextDisplayBuilder`, `SectionBuilder`, `SeparatorBuilder`,
`MediaGalleryBuilder`, `FileBuilder`. An `ActionRowBuilder` inside a V2 message holds the same
interactive components it always did (buttons, select menus) — V2 doesn't change what's
*inside* an action row, only what can sit alongside it.

**Modal-only** (never valid as a top-level V2 message component, confirmed the same way):
`LabelBuilder` (which wraps a select menu, radio group, or checkbox group), `RadioGroupBuilder`,
`CheckboxGroupBuilder`. `TextInputBuilder` is modal-only in practice — nothing outside a modal
can collect free-text input from a user. `TextDisplayBuilder` and a bare `ActionRowBuilder` of
buttons/selects are valid in **both** places (a modal's own instructions text, or a channel/
select field in setup's field-editing modals — see `buildChannelsModal()` in
`commands/_storyadminSetupFieldModals.js` for `TextDisplayBuilder` used as modal instructions
alongside `LabelBuilder`-wrapped selects).

**Modals are otherwise unaffected by any of this.** They have their own flag-free lifecycle —
`showModal()`/`ModalBuilder` never touches `IsComponentsV2`, and a modal opened from a V2
message's button is exactly as valid as one opened from a classic embed's. Modals fully support
select menus, radio groups, checkboxes, file uploads, and text inputs — any belief that "modals
only take text inputs" is stale training data.

### `ModalBuilder`'s own component methods

Verified in `node_modules/@discordjs/builders/dist/index.js`: `addComponents` is **deprecated**
in favor of `addLabelComponents`/`addTextDisplayComponents`, but still functional and still used
throughout this codebase for plain text inputs (`modal.addComponents(new
ActionRowBuilder().addComponents(textInput))` — see `buildSetupFieldModal()`,
`buildTagsModal()`). It auto-wraps a bare `TextInputBuilder` in an `ActionRowBuilder` for you.
Mixing `addTextDisplayComponents` (instructions text) with `addComponents`/`addLabelComponents`
(the actual fields) in one modal is normal and already used throughout (`buildChannelsModal()`,
`commands/_storyadminSetupGroundRules.js`'s `buildGroundRulesModal()`).

### A modal-submit interaction cannot show a modal

`ModalSubmitInteraction` does **not** support `showModal()` — corrected 2026-09-24 after an
earlier version of this doc claimed the opposite. Verified in
`node_modules/discord.js/src/structures/ModalSubmitInteraction.js`:

```js
InteractionResponses.applyToClass(ModalSubmitInteraction, 'showModal');
```

`applyToClass(structure, ignore = [])` treats its second argument as the *ignore* list, and tests
membership with `ignore.includes(prop)`. Passing the bare string `'showModal'` (not an array)
means that check runs as `'showModal'.includes(prop)` — a **substring test on the string
itself** — which is only `true` when `prop === 'showModal'`. So `showModal` is the one method
this call explicitly *excludes* from `ModalSubmitInteraction`, not the one it grants. Calling
`interaction.showModal(...)` on a modal-submit interaction throws `TypeError: interaction.showModal
is not a function` at runtime.

A `MessageComponentInteraction` (a button click) has no such exclusion —
`MessageComponentInteraction.applyToClass(MessageComponentInteraction)` is called with no ignore
list, so it gets the full `InteractionResponses` set including `showModal()`. That means a
modal-submit handler that needs to re-show a modal on validation failure (pre-filled with what
the user just submitted, plus an error) cannot do it directly — it has to reply with an
intermediate ephemeral message carrying a "try again" button, and let that button's own
`MessageComponentInteraction` call `showModal()`.

---

## Reading modal submissions — `interaction.fields` (ModalSubmitFields)

Verified accessor list from `node_modules/discord.js/src/structures/ModalSubmitFields.js`:

| Accessor | Returns |
|---|---|
| `getTextInputValue(customId)` | string |
| `getStringSelectValues(customId)` | string[] |
| `getRadioGroup(customId, required?)` | selected value or null |
| `getCheckboxGroup(customId)` / `getCheckbox(customId)` | values / boolean |
| `getSelectedUsers/Roles/Channels/Members/Mentionables(customId, ...)` | collections |
| `getUploadedFiles(customId, required?)` | attachments |
| `getField(customId, type?)` | raw component |

⚠️ **There is NO `getSelectMenuValues`.** The correct name is `getStringSelectValues`.
This exact mistake has shipped before (audit finding 1.2) — the method throws `TypeError`
and the modal silently fails.

⚠️ **Reading a field that wasn't in the submitted modal throws, not returns empty/null.** A
`CheckboxGroupBuilder`/`LabelBuilder` field that a builder function omits conditionally (e.g.
`buildMetadataModal()`'s Ground Rules group, omitted entirely when a guild has no vocabulary
configured) will make `getCheckboxGroup()` throw a "field not found" style error on submit if
the handler tries to read it unconditionally. Wrap the read in try/catch when the field's
presence is conditional — see `story/add.js`/`story/manage.js`'s metadata-modal-submit branches
for the pattern.

## Building modals — patterns this project learned the hard way

Working reference implementation: [story/_metadataModals.js](../story/_metadataModals.js).

1. **Selects and radio groups must be wrapped in `LabelBuilder`** and added via
   `modal.addLabelComponents(...)` — not `ActionRowBuilder`/`addComponents`:
   ```js
   new ModalBuilder().addLabelComponents(
     new LabelBuilder().setLabel(cfg.lblMetaRating).setStringSelectMenuComponent(ratingSelect),
     new LabelBuilder().setLabel(cfg.lblModeToggle).setRadioGroupComponent(modeGroup),
   );
   ```
   Text inputs may still go through `addComponents` (bare or in an ActionRow) — see the
   deprecation note above; this codebase keeps using it deliberately for text inputs.
2. **Optional selects need BOTH `setRequired(false)` AND `setMinValues(0)`.**
   `setRequired(false)` alone still shows Discord's required indicator on select menus;
   `setMinValues(0)` is what actually allows submitting with nothing selected.
   Radio groups only need `setRequired(false)`.
3. **An empty optional select/radio returns empty/null on submit** — handlers must treat
   "no selection" as "no change", not as clearing the value (see the staged-state pattern
   in `story/add.js` / `story/manage.js`).
4. **`CheckboxGroupOptionBuilder`'s description is optional but can't be an empty string.**
   Calling `.setDescription('')` on an option with no description text throws a validator error
   — omit the call entirely rather than pass an empty string
   (`story/_metadataModals.js`'s Ground Rules option-building: `if (rule.description)
   option.setDescription(rule.description);`).
5. **`CheckboxGroupOptionBuilder`'s label and description are both capped at 100 characters**
   — the actual platform limit, confirmed in `node_modules/@discordjs/builders/dist/index.js`'s
   `checkboxGroupOptionPredicate`: `description: s.string().lengthLessThanOrEqual(100).optional()`,
   same cap on `label`. A validator or UI built to a looser number (this codebase briefly had a
   plan document claiming 150 for descriptions) will accept text Discord then refuses to render.

## Known cleanup debt (do not "fix" in passing without checking ../TODO.md)

- Legacy `ActionRowBuilder` usage for text inputs is stable and low-priority to migrate.
- Label/required-flag display polish is tracked externally by the maintainer.
- `story/close.js`'s `handleCloseConfirm`/`handleCloseCancel` are still plain content/components
  (not V2) — intentional, since the standalone `/story close` command's own message never
  carries the flag. `story/_manageClose.js` is a deliberate temporary fork, not a bug; see
  "`/story close` — the worked example of getting it wrong" above.
