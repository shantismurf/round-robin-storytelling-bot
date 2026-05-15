# Plan: AO3 Name → Pen Name Rename

## Context

The `story_writer` table has a column named `AO3_name` that stores a writer's display alias.
The field was named after AO3 (Archive of Our Own) but the bot is not AO3-specific.
The rename targets: DB column, JS variables, modal field IDs, and config keys.

All occurrences were audited on 2026-05-07. No discovery work needed.

---

## Phase 1 — Database Migration

Create a new migration file (next number after 011):

```sql
-- Rename AO3_name column to pen_name on story_writer table
ALTER TABLE story_writer CHANGE COLUMN AO3_name pen_name VARCHAR(255) DEFAULT NULL;

-- Rename config keys
UPDATE config SET config_key = 'lblJoinPenName'         WHERE config_key = 'lblJoinAO3Name';
UPDATE config SET config_key = 'btnSetPenName'          WHERE config_key = 'btnSetAO3Name';
UPDATE config SET config_key = 'lblYourPenName'         WHERE config_key = 'lblYourAO3Name';
UPDATE config SET config_key = 'txtPenNamePlaceholder'  WHERE config_key = 'txtAO3NamePlaceholder';
UPDATE config SET config_key = 'txtAdminPenNameSuccess' WHERE config_key = 'txtAdminAO3NameSuccess';
UPDATE config SET config_key = 'btnAdminMUPenName'      WHERE config_key = 'btnAdminMUAO3Name';
```

Also update `db/init.sql` line 46: `AO3_name` → `pen_name`.

---

## Phase 2 — Config SQL Files

Files: `db/config_files/config_story.sql`, `config_mystory.sql`, `config_storyadmin.sql`

| Old key | New key |
|---|---|
| `lblJoinAO3Name` | `lblJoinPenName` |
| `btnSetAO3Name` | `btnSetPenName` |
| `lblYourAO3Name` | `lblYourPenName` |
| `txtAO3NamePlaceholder` | `txtPenNamePlaceholder` |
| `txtAdminAO3NameSuccess` | `txtAdminPenNameSuccess` |
| `btnAdminMUAO3Name` | `btnAdminMUPenName` |

Also update any config value text that says "AO3 Name" to say "Pen Name".

---

## Phase 3 — JavaScript Renames

### Variable/property renames (all files)
- `ao3Name` → `penName`
- `.AO3_name` → `.pen_name` (DB column access)
- `ao3_name` (modal field ID) → `pen_name`

### Files and approximate line counts

| File | Occurrences | What changes |
|---|---|---|
| `storybot.js` | 5 | Lines 205, 233, 235, 788, 867, 873 — SQL column, variable, display logic |
| `story/add.js` | 8 | Lines 13, 16, 34, 37, 55, 149, 219, 285, 459, 463, 464, 467, 557 |
| `story/join.js` | 10 | Lines 12, 15, 72, 76, 85, 151, 177, 185, 186, 192, 205, 233 |
| `story/export.js` | 2 | Lines 129, 162 |
| `story/manageUser.js` | 6 | Lines 36, 50, 89, 121, 151, 274, 279, 403, 406, 408 |
| `commands/mystory.js` | 7 | Lines 409, 419, 468, 487, 503, 548, 553, 562, 563, 837, 839 |

Config key references in JS (getConfigValue calls) — update alongside the key renames above:
- `lblJoinAO3Name` → `lblJoinPenName`
- `btnSetAO3Name` → `btnSetPenName`
- `lblYourAO3Name` → `lblYourPenName`
- `txtAO3NamePlaceholder` → `txtPenNamePlaceholder`
- `txtAdminAO3NameSuccess` → `txtAdminPenNameSuccess`
- `btnAdminMUAO3Name` → `btnAdminMUPenName`

Also check: `btnJoinSetAO3`, `txtJoinAO3NotSet`, `txtJoinAO3Placeholder`, `lblJoinSetAO3ModalTitle`,
`lblMyStoryManageAO3`, `lblManageUserAO3` — these also need pen name equivalents.

---

## Phase 4 — Documentation

- `db/config_roadmap.md`: Update all AO3 key references (lines ~30, 36)
- `docs/draftsystem_roadmap.md`: Update any AO3 references
- `TODO.md`: Mark rename audit items done

---

## Notes

- The migration must run before the JS changes go live (column rename = breaking change).
- The config key renames are non-breaking if done atomically with the JS changes (old keys become missing = error per CLAUDE.md rules, so deploy together).
- No user-facing text changes are pre-approved — all config value text must be reviewed before committing.
- Cross-reference: `story/add.js` uses a separate config key `btnJoinSetAO3` (not in config_files list above) — verify it exists and rename.
