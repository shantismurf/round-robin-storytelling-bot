# Silo-Sprint Plan: Silo 1 — Gateway & Utilities

## Context
This is the opening silo of a full system audit and refactor. The goal is to resolve technical debt in the four gateway/infrastructure files before moving to feature-specific silos. Findings here establish baseline logging and routing standards that all later silos will reference.

---

## Audit Findings

### Overall Project Health
- **664 config keys** across 7 SQL files, all tracked in `db/config_roadmap.md`
- **No system_roadmap.md or ux_roadmap.md** exists yet — these are deliverables of Silo 1
- `story/` subcommands are broken into per-feature files; `commands/` holds 3 main handlers
- `TODO.md` contains a critical bug (metadata save), hardcoded text items, and deferred features

---

### File-by-File Findings

#### `index.js` (249 lines) — GOOD
- All logging uses the structured `log()` utility. No raw `console.log`.
- No hardcoded user-facing strings.
- **Routing:** Four prefixes correctly handled:
  - Modals: `story_*`, `storyadmin_*`, `mystory_*`
  - Buttons: `storyadmin_*`, `catchup_*`/`mystory_*`, all others → `story`
  - Select menus: `story_*` only (storyadmin and mystory have none)
- **Gap 1:** Button dedup hit (duplicate click suppressed) is silently deferred — no log that dedup fired.
- **Gap 2:** No entry log for each handler dispatch (modal, button, select) — only the raw customId is logged, not which handler receives it.
- **No unrouted customId prefixes identified.** All 35+ story prefixes, 4 storyadmin prefixes, and 7 mystory prefixes map correctly through the three-branch router.

#### `utilities.js` (546 lines) — MODERATE GAPS
- All logging uses the structured `log()` utility. No raw `console.log`.
- No hardcoded user-facing strings.
- **Gap: Missing entry/exit logs in critical utility functions:**
  - `createThread()` — No entry log, no success log after thread creation (only errors logged)
  - `validateStoryAccess()` — No entry or outcome log (only error path)
  - `validateActiveWriter()` — No entry or outcome log (only error path)
  - `checkIsAdmin()` — No logging at all
  - `getTurnNumber()` — No logging
  - `getEntryEditInfo()` — No logging
  - `replaceTemplateVariables()` — No logging
  - `chunkEntryContent()` — No logging
- Pure utility functions (`sanitize`, `sanitizeModalInput`, `splitAtParagraphs`) — logging not needed; they have no meaningful state to trace.
- `validateStoryAccess` catch block doesn't return on error — callers receive `undefined` instead of a structured error object. This is a latent bug.

#### `deploy.js` (77 lines) — LOGGING INCONSISTENCY
- Uses raw `console.log` / `console.error` exclusively — does not import or use `log()`.
- Hardcoded strings: `'Missing clientId in config.json.'`, `'Missing guildId...'`, `'Round Robin StoryBot — Deploy'`, `'TEST MODE'`, `'PRODUCTION'`, `'Deploy complete.'`
- **Assessment:** deploy.js is a CLI tool run manually before the bot starts; it intentionally uses raw console output. Hardcoded strings here are acceptable since they are developer/operator-facing, not user-facing in Discord. No config keys needed.
- **Action:** Leave deploy.js as-is. Document this exception in system_roadmap.md.

#### `job-runner.js` (244 lines) — MINOR GAPS
- All logging uses the structured `log()` utility. No raw `console.log`.
- No hardcoded user-facing strings.
- **Gap: Missing entry logs for job handlers:**
  - `processJob()` — No log when a job is claimed/started
  - `handleCheckStoryDelay()` — No entry log
  - `handleTurnTimeout()` — No entry log; thread deletion attempt has no pre-action log
  - `handleTurnReminder()` — No entry log; DM fallback failure is silent
- `buildSyntheticContext()` — No logging (acceptable; pure data assembly)

---

## Implementation Plan

### Step 1 — Fix latent bug in `validateStoryAccess` (utilities.js:484)
The catch block falls through without returning, so callers receive `undefined` on DB errors. Add `return { success: false, error: 'internal' }` in the catch.

### Step 2 — Add entry/outcome logs to utilities.js
Add `{ show: false }` entry logs to:
- `createThread()` — log entry + success (thread.id)
- `validateStoryAccess()` — log entry + success/failure outcome
- `validateActiveWriter()` — log entry + success/failure outcome
- `checkIsAdmin()` — log entry + result
- `getTurnNumber()` — log entry + result
- `getEntryEditInfo()` — log entry + result

### Step 3 — Add entry logs to job-runner.js handlers
Add `{ show: false }` entry logs to:
- `processJob()` — log job_id and job_type when claimed
- `handleCheckStoryDelay()` — log storyId on entry
- `handleTurnTimeout()` — log turnId on entry; log thread deletion attempt
- `handleTurnReminder()` — log turnId on entry; log DM fallback failure

### Step 4 — Add dedup log to index.js
On the deduplicated button path (line 184), add a `{ show: false }` log identifying the suppressed customId.

### Step 5 — Create `docs/system_roadmap.md`
Skeleton covering:
- File inventory with purpose, line count, and owner
- customId routing table (prefix → handler → file)
- Job type registry (job_type string → handler function)
- Deploy exception note (raw console.log is intentional)
- Link to config_roadmap.md as the string authority

### Step 6 — Create `docs/ux_roadmap.md`
Skeleton covering:
- Interaction flow map: slash command → modal/button/select → handler
- Known flow gaps / TODO items (metadata save bug, unimplemented "request more time")
- Per-silo status tracker (Silo 1 through 5)

---

## Files to Modify
- [utilities.js](../../../OneDrive/Documents/GitHub/round-robin-storybot/utilities.js) — Bug fix + entry/outcome logs
- [job-runner.js](../../../OneDrive/Documents/GitHub/round-robin-storybot/job-runner.js) — Entry logs for handlers
- [index.js](../../../OneDrive/Documents/GitHub/round-robin-storybot/index.js) — Dedup log

## Files to Create
- `system_roadmap.md` (project root) — System architecture reference
- `ux_roadmap.md` (project root) — UX interaction flow reference

## Files Left Unchanged
- `deploy.js` — Raw console.log is intentional (CLI tool, dev-only). No config keys needed.
- `sanitize()`, `sanitizeModalInput()`, `splitAtParagraphs()` — No logging; pure string transformers with no state to trace.

---

## Verification
1. Run the bot locally and trigger a button double-click — confirm dedup log appears.
2. Trigger a story write flow — confirm `validateStoryAccess` and `validateActiveWriter` entry/outcome logs appear.
3. Trigger a job manually via DB insert — confirm `processJob` and handler entry logs appear.
4. Confirm no new hardcoded strings were introduced (grep for string literals in modified files).
