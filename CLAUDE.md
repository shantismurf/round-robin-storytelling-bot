# Round Robin StoryBot — Claude Context
## Developer Notes & Persona
- The user is self-taught with professional DB and coding experience; she prefers plain language and context over jargon. Treat her as a competent peer, but speak directly when an approach is over-engineered or wrong, and teach to fill gaps in her knowledge. Default to concise, warm, conversational prose sized to the question — not padded, not clipped into status updates. Reserve bullet lists for genuinely list-shaped content (options, findings, data); keep progress narration and everyday replies in prose.
* **Process Transparency:** Always immediately restate what you understand the user's request to be, then narrate before and after every distinct investigation step — do not chain more than 2-3 tool calls without an update explaining what was found and what's next. Check in if a process runs for more than 30 seconds with no output. Narrate in plain response text, never rely on thinking blocks being visible — see `docs/feedback_narrate_progress.md`.
- **No Assumptions:** Regularly ask the user for context rather than chasing assumptions. Don't assume the user didn't restart the process or change a system variable if things aren't adding up - ASK.
- **Docs before speculation:** Before investigating an issue, check system_roadmap.md and the relevant docs first. If you find no paper trail in the docs or code, state that clearly rather than hallucinating a theory.
- **Reuse before you write:** Check for existing logic before implementing. Extract reusable code to shared helpers and modules. Search for existing config values that can be repurposed before creating new keys. Keep files under 500 lines.
- **No hard-coded text:** All user-facing text must be displayed for and approved by the user unless they provided the exact text already.

## System Information
- **Host:** Managed via restricted pterodactyl interface on bot-hosting.net. No manual console access, no local/staging execution — any change, including debug logging, must be pushed to main and the bot restarted before it can be tested. Runs Node.js v24.18.0 (as of 2026-07-24); the host keeps this current with new Node releases, so don't assume this stays pinned.
- **Startup:** Pulls main branch -> runs index.js -> fires deploy.js:
  - database_setup: schema checks and migrations.
  - sync_config: aggregates `db/config_files/*.sql` and syncs to DB.
  - deploy_commands: registers slash commands (instant in test_mode).
- **MariaDB:** Uses explicit transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) for all story state changes.
  - The migration runner splits on ; before stripping comments, so any ; inside a comment text corrupts the next statement. NO SEMI-COLONS IN SQL CODE COMMENTS!
- discord.js 14.26.4: modals DO support selects/radio groups. Before writing or reviewing ANY discord.js component/modal code, read `docs/discordjs_reference.md` and verify against `node_modules/discord.js/src/`, never training data.

## High-level Architecture 
- **index.js (The Gateway):** Primary bot entry point. Routes all interactions (isCommand, isButton, isModalSubmit) by customId. Executes `deploy.js` on bot start for database migrations, config table sync, slash command registration, and faq post sync.
- **prefix.commands (UI Handlers):** story.js, mystory.js, and storyadmin.js handle Discord-specific logic (Builders, Modals, Buttons), delegating to `story/_*.js` for state changes.
- **story/_*.js (The Engine):** Core business logic and DB operations — turn advancement, state machine, metadata, moderation. UI handlers call functions here to execute state changes.
- **storybot.js:** Story entry points (creation (`CreateStory`) and join (`StoryJoin`)), plus shared re-exports (`getActiveThreadId`, `PickNextWriter`, `NextTurn`).
- **job-runner.js (Automation):** Manages background tasks like turn timeouts and reminders.

## Critical Program Standards
- **Zero Hardcoding:** Never hard-code user-facing text. Labels, buttons, and prompts must be dynamic.
- **High-resolution Logging:** Exhaustive traceability is required to debug the restricted server environment.
- **Reuse & Modularize:** Export logic to shared helpers to avoid redundancy. Break up files if they significantly exceed 500 lines.
- **Versioning:** Maintain the version number in `package.json` per the Versioning Policy below.
- **Maintain Documentation:** Always sync roadmaps with code changes.

## Versioning Policy
- **Approval required before bumping:** Explicit sign-off is required to bump any version level. Propose the number and the reasoning and submit for approval — don't just apply it.
- **MAJOR** — a significant change to the core identity of the application, or a major addition that substantially impacts user experience (e.g. the UX v3 modal-panel rework, shipped as 3.0.0).
- **MINOR** — a significant amount of work that meaningfully affects experience, reliability/risk, or touches enough code that experience could be impacted even without a visible change (e.g. code changes across several files that may only manifest as a single line change to the user).
- **PATCH** — small, contained fixes and additions: one new field, one bug fix, a cosmetic tweak, a background job for an edge case.
- **No bump** — wording adjustments (e.g. typo fixes), purely internal back-end/db changes below the "significant" bar, docs-only updates.

## Config & Localization Rules
- **NO HARDCODED USER TEXT:** Every user-facing string must use `getConfigValue()`. Logs and the unicode space character may be hard-coded.
- **Missing Config = Error:** Do not use `?? "Fallback"` defaults. Log a high-priority error.
- **Roadmap-Driven:** Check `config_roadmap.md` before creating keys. Update the roadmap as needed.
- **Naming Convention:** `[type][Location][Purpose][Name]` (e.g., `btnStoryAddPanelCreate`).
  - `lbl`: Labels | `txt`: Content/Titles | `btn`: Buttons | `cfg`: System values.
- **Token Substitution:** Always use `replaceTemplateVariables(template, keyValueMap)` — never inline `.replace()` on config strings. Wrap optional text in `{?text with [token]?}` markers (no spaces inside markers); the block is stripped if any `[token]` inside it is missing from the map.
- **Discord Timestamps:** Always use Discord rendered timestamps for user-facing text, when they will render properly, using the `discordTimestamp (input, form)` utility.

## Logging Rules
Implement two-tier high-resolution coverage using `log(content, { show, guildName })`.
- **show: true** (Standard Production Logs, Operational Visibility)
  - User Actions, State Changes, Validation Failures, System Errors, Configuration Alerts.
- **show: false** (Test-Mode Debugging, Traceability)
  - Entry points, Major Logic Branches, Mid-process Milestones, API/DB Payloads.
- **Format:** `functionName failed for [context]: ${error?.stack ?? error}`.
- **Log Function:** Universal Logger logic:
  - **Strings:** Appended to a standard prefix (timestamp and guildName).
  - **Arrays:** Auto-renders `console.table` with empty-column filtering.
  - **Objects:** Auto-renders `console.dir` with infinite depth and colors.
  - **Bundles:** Pass `[label, data]` for a timestamped header followed by rendered data.
- **Data in context:** Log entities active in the operation. If a readable name is already in scope, use `name (id)` format — otherwise ID alone is fine. Always include the triggering user and any story being acted on. Turns and threads need ID only. Guild is redundant if already passed as the log option.
- **Hub Log Channel** some logs are duplicated to the hub server's `#logs` channel for instant admin notification (`cfgHubLogChannelId`): Any `show: true` message that either contains a clear problem pattern (e.g. 'error', 'failed'. 'not found', etc), OR is explicitly flagged with `hub: true` (e.g. new guild registration)

## Testing
- **Layer-1 unit tests** live in `test/*.test.js`. Run `npm install` first, then execute via `npm test` (`node --test`).
  Cover pure/DB-only logic using `test/_fakeConnection.js` (a scripted-queue fake
  `connection.execute()`) — no live DB or Discord connection required.

## System Documentation
Review and maintain roadmaps with every implementation.
- **system_roadmap.md:** Maps exported functions, state maps, and event routing logic.
- **db/config_roadmap.md:** Manifest of all database-stored config strings and values.
- **ux_roadmap.md:** Application workflows and interface structure.
- **Help Sync Rule:** UX Roadmap changes must be reflected in the corresponding user help config keys (e.g., `txtHelp1FindJoin`).