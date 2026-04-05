# To-Do List

---

## 1. storyadmin delete subcommand
*(note: `turn_id = 45` is the turn pending deletion once this is implemented)*

Accept an argument to delete one specific entry; show confirm message with content preview; add `deleted` status to entries so they are skipped in turn count, read, export, etc.; deleted entries should still appear in the edit interface; Restore should update entry status but not touch the edits table.

---

## 2. User Pause
Users should have the ability to pause themselves and remove themselves from turn selection. Admins should be able to pause and unpause users.

---

## 3. View Last Entry button
Add a button to a new turn thread welcome post that on click posts the previous entry as a permanent embed so the writer can read it as they are composing.

---

## 4. Repost after edit
Add an option to publicly repost the entry to the story thread when confirming an edit.

---

## 5. Jump to Page + Persist read page

**Jump to Page** — add a dropdown jump-to-page select list to the `/story read` interface. Also update the Previous button so it is colored the same as the Next button.

**Persist last-viewed read page** — store `currentPage` in a lightweight persistent map so that when a user reopens `/story read` for the same story, they resume where they left off rather than starting from page 1.

---

## 6. Refactor repeated logic into shared utilities
Audit the project for duplicated functionality that should be extracted into reusable helper functions. For example, pagination/chunking of long entries for display is repeated across read, edit, and export — that logic should live in one place so changes only need to be made once.

---

## 7. DM support + story autocomplete UX overhaul

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

**4. Replace `story_id` integer options with autocomplete** on:
- `mystory`: `leave`, `pass`, `catchup`
- `story`: `join`, `write`, `read`, `close`, `manage`
- Results formatted as `The Wandering Stars (#3)` (guild) or `[BBC] The Wandering Stars (#3)` (DM); max 100 chars, max 25 results
- Value submitted is `story_id` as string, parsed to int in handler; validation still required (user can submit without selecting)
- Filter per subcommand:
  - `mystory catchup/leave/pass` → stories user is currently active in
  - `mystory history` → all stories user has ever been in
  - `story join` → stories open to join that user isn't already in
  - `story write` → stories where it's currently the user's turn
  - `story read` → all stories on the server
  - `story close/manage` → stories user created or has admin role
- Add `autocomplete(connection, interaction)` export to `mystory.js` and `story.js`; route from `index.js` via `interaction.isAutocomplete()`

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
6. `index.js` — route `interaction.isAutocomplete()` to correct command's autocomplete handler
7. `sync-config.js` / DB — new config key defaults for `guildName` and `guildTag`
