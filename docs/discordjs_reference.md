# discord.js Reference — Verified Against the Installed Version

**Installed: discord.js 14.26.4** (check `node_modules/discord.js/package.json` if in doubt).

**The rule:** Do NOT trust training data about the discord.js API. This project's installed
version supports features that most LLM training data predates or misnames. Before writing,
reviewing, or declaring a bug in any discord.js component/modal code, check this doc; if it
doesn't cover the question, read the installed source under `node_modules/discord.js/src/`
(`structures/` for runtime classes, and `node_modules/@discordjs/builders/dist/` for builders).
Treat discordjs.guide and discord.js.org as version-suspect — they document the latest release,
which may not match what is installed here.

## Modals — what they support

Modals fully support **select menus, radio groups, checkboxes, file uploads, and text inputs**.
Any belief that "modals only take text inputs" is stale training data.

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
   Text inputs may still go through `addComponents` (bare or in an ActionRow).
2. **Optional selects need BOTH `setRequired(false)` AND `setMinValues(0)`.**
   `setRequired(false)` alone still shows Discord's required indicator on select menus;
   `setMinValues(0)` is what actually allows submitting with nothing selected.
   Radio groups only need `setRequired(false)`.
3. **An empty optional select/radio returns empty/null on submit** — handlers must treat
   "no selection" as "no change", not as clearing the value (see the staged-state pattern
   in `story/add.js` / `story/manage.js`).

## Known cleanup debt (do not "fix" in passing without checking TODO.md)

- Legacy `ActionRowBuilder` usage for text inputs is stable and low-priority to migrate.
- Label/required-flag display polish is tracked externally by the maintainer.
