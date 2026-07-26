# Project: Round Robin StoryBot System Audit & Refactor

**Core Objective:** Resolve technical debts (unwired handlers, hardcoded text, logging gaps), generate synchronized project documentation, and improve overall agenic efficiency with a localized, context-aware "Silo-Sprint" methodology.

## Developer Notes & Standards from CLAUDE.md:
- **Developer Context:** Self-taught with professional DB experience. Prefers plain language over jargon.
- **Communication:** Regularly ask the user for context. If the root cause is unclear after 1 minute, stop and ask. Do not chase assumptions.
- **Approval Rule:** All user-facing text must be displayed for and approved by the user.
- **Zero Hardcoding:** ALL user-facing strings must reside in `db/config_files/` and use `getConfigValue()`. Keys must be tracked in `db/config_roadmap.md`. No hardcoded fallback text.
- **High-Resolution Logging:** Implement Traceability (function entries/branches), Milestones, and Outcome coverage using the unified `log()` utility per `CLAUDE.md`.
- **File Weight:** Target file size is under 500 lines. Modularize sub-commands and move redundant logic to shared handlers where practical.

## The Silo-Sprint Execution Plan:
To maintain token efficiency, we will tackle the project in these logical silos with just-in-time audits of discreet chunks. Provide a high-level assessment of this proposed order and issues to address:

1. **Silo 1: The Gateway & Utilities** (`index.js`, `utilities.js`, `deploy.js`, `job-runner.js`)
   * *Focus:* Validating and refining routing logic and background jobs; implementing logging and documentation.
2. **Silo 2: Story Management** (`commands/story.js`, `config_story.sql`, `config_metadata.sql`)
   * *Focus:* Documenting system structure and logic; identifying hardcoded strings and logging gaps.
3. **Silo 3: Admin & Overrides** (`commands/storyadmin.js`, `config_storyadmin.sql`)
   * *Focus:* Reviewing manage sub-panels to clearly define and correct handling of "staged edits" vs "immediate action" hand-offs. Fix unwired modals. Correct text and logging.
4. **Silo 4: User Experience** (`commands/mystory.js`, `config_mystory.sql`)
   * *Focus:* Dashboard accuracy and documentation, hard coded strings, logging, and validating/updating help files.
5. **Silo 5: The Engine** (`storybot.js`, `config_turn.sql`)
   * *Focus:* Performance efficiency and documentation.

## Immediate Task: Silo 1 Audit
Provide a high-level review of the project organization, then conduct a deep-dive audit of **Silo 1**. 
1. Identify any missing log coverage or hardcoded strings.
2. Verify all `customId` prefixes are correctly routed.
3. Propose the initial skeleton for `system_roadmap.md` and `ux_roadmap.md` based on your findings.

**Report your audit findings before writing code.**
