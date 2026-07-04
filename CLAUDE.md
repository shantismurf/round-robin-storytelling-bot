# Round Robin StoryBot — Claude Context
## Developer Notes & Persona
- User is self-taught with professional DB and coding experience; prefers plain language and context over jargon. Speak with camaraderie and honesty, and teaching to fill in the user's gaps in knowledge. Treat the user as a competent peer, but if an approach is over-engineered or wrong, say so directly and don't invent a fake consensus.
* **Process Transparency:** Always immediately restate what you understand the user's request to be, then proceed keeping the user regularly informed of your thought processes. Check in if a process runs for more than 30 seconds with no output.
- **No Assumptions:** Regularly ask the user for context rather than chasing assumptions. Don't assume the user didn't restart the process or change a system variable if things aren't adding up - ASK.
- **Docs before speculation:** Before investigating an issue, check system_roadmap.md and the relevant docs first. If you find no paper trail in the docs or code, state that clearly rather than hallucinating a theory.
- **Reuse before you write:** Check for existing logic before implementing. Extract reusable code to shared helpers and modules. Search for existing config values that can be repurposed before creating new keys. Keep files under 500 lines.
- **No hard-coded text:** All user-facing text must be displayed for and approved by the user unless they provided the exact text already.

## System Information
- **Host:** Managed via restricted pterodactyl interface on bot-hosting.net. No manual console access.
- **Startup:** Pulls main branch -> runs index.js -> fires deploy.js:
  - database_setup: schema checks and migrations.
  - sync_config: aggregates `db/config_files/*.sql` and syncs to DB.
  - deploy_commands: registers slash commands (instant in test_mode).
- **MariaDB:** Uses explicit transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) for all story state changes.
  - The migration runner splits on ; before stripping comments, so any ; inside a comment text corrupts the next statement. NO SEMI-COLONS IN SQL CODE COMMENTS!
- Current discord.js version is 14.26.4, which supports select menus and radio buttons in modals. Use web resources if you don't have reference data.

## High-level Architecture 
- **index.js (The Gateway):** Primary entry point. Routes all interactions (isCommand, isButton, isModalSubmit) by customId 
- **prefix.commands (UI Handlers):** story.js, mystory.js, and storyadmin.js handle Discord-specific logic (Builders, Modals, Buttons).
- **storybot.js (The Engine):** Core business logic and DB operations. UI handlers must call functions here to execute state changes.
- **job-runner.js (Automation):** Manages background tasks like turn timeouts and reminders.

## Critical Program Standards
- **Zero Hardcoding:** Never hard-code user-facing text. Labels, buttons, and prompts must be dynamic.
- **High-resolution Logging:** Exhaustive traceability is required to debug the restricted server environment.
- **Reuse & Modularize:** Export logic to shared helpers to avoid redundancy. Break up files if they significantly exceed 500 lines.
- **SemVer:** Maintain the version number in `package.json` per SemVer standards
- **Maintain Documentation:** Always sync roadmaps with code changes.

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

## System Documentation
Review and maintain roadmaps with every implementation.
- **system_roadmap.md:** Maps exported functions, state maps, and event routing logic.
- **db/config_roadmap.md:** Manifest of all database-stored config strings and values.
- **ux_roadmap.md:** Application workflows and interface structure.
- **Help Sync Rule:** UX Roadmap changes must be reflected in the corresponding user help config keys (e.g., `txtHelp1FindJoin`).