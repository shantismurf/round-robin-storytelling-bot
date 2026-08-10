# Docs Index

Master map of every doc in this repo. Categories are organized by lifecycle stage, so you
can tell what's current, what's outstanding, and what's historical without opening files.

`CLAUDE.md` stays at the repo root (Claude Code only auto-loads it from there) — everything
else lives under `docs/`.

---

## TODO.md — running backlog

[`TODO.md`](TODO.md) — short-bullet backlog and index. Anything plan-sized is linked out to
`plans/` rather than written inline here.

---

## plans/ — proposed or in-progress features

Every file has a `Status` / `Created` / `Last Updated` (/ `Implemented`) header.

| File | Status | Summary |
|---|---|---|
| [PLAN-manage-entries-consolidation.md](plans/PLAN-manage-entries-consolidation.md) | Implemented (help-text sync pending) | Manage Entries rebuilt to reuse the Edit engine (fixes truncation, Back-button, delete/restore); adds an author entry picker to `/story edit` |
| [PLAN-story-list-overhaul.md](plans/PLAN-story-list-overhaul.md) | Pending | `/story list` layout/filter overhaul |
| [PLAN-story-privacy.md](plans/PLAN-story-privacy.md) | Pending | Writer-only (private) stories, create-only toggle |
| [PLAN-hub-sharing.md](plans/PLAN-hub-sharing.md) | Partially Implemented — needs review | Hub server story mirroring, consent, broadcast system |
| [hub-brainstorming.md](plans/hub-brainstorming.md) | — (companion notes) | Open questions/decisions feeding into PLAN-hub-sharing.md |
| [PLAN-panel-rework-and-ground-rules.md](plans/PLAN-panel-rework-and-ground-rules.md) | Pending | Add/Manage panel Settings/Metadata split, Move Manage Users onto the panel, Ground Rules feature, Warnings checkbox conversion |
| [PLAN-dm-support.md](plans/PLAN-dm-support.md) | Pending | Full DM-based story participation |
| [PLAN-series-system.md](plans/PLAN-series-system.md) | Idea | Group stories into a series with chapters |
| [PLAN-reactions-kudos.md](plans/PLAN-reactions-kudos.md) | Idea | Reaction-based kudos reposted to the story feed |

### plans/completed/ — implemented, kept for historical record

| File | Implemented | Summary |
|---|---|---|
| [PLAN-ao3-to-pen-name-rename.md](plans/completed/PLAN-ao3-to-pen-name-rename.md) | 2026-07-01 | `AO3_name` column/field renamed to `pen_name` throughout |
| [PLAN-rating-barrier-migration.md](plans/completed/PLAN-rating-barrier-migration.md) | 2026-07-10 | Story thread migration when rating crosses the NR/M barrier |
| [PLAN-help-faq-hub-sync.md](plans/completed/PLAN-help-faq-hub-sync.md) | 2026-07-01 | Help content synced to Hub FAQ forum posts |

---

## audits/ — point-in-time audit reports (historical)

| File | Summary |
|---|---|
| [Audit_Plan.md](audits/Audit_Plan.md) | Methodology for the Silo-Sprint audit (kicks off Silos 1–5) |
| [Audit_Silo_1.md](audits/Audit_Silo_1.md) | Gateway/Config findings |
| [Audit_Silo_2.md](audits/Audit_Silo_2.md) | Story Management findings |
| [Audit_Silo_3.md](audits/Audit_Silo_3.md) | Admin findings |
| [Audit_Silo_4.md](audits/Audit_Silo_4.md) | UX findings |
| [Audit_Silo_5.md](audits/Audit_Silo_5.md) | Engine findings |
| [Audit_Final_Report.md](audits/Audit_Final_Report.md) | Completion summary of Silos 1–5 |
| [Fable_Audit_2026-07.md](audits/Fable_Audit_2026-07.md) | Audit of code changed since Silo 5; supersedes archive/LOGIC_ERRORS_REPORT.md |
| [Fable_Audit_Fix_Progress.md](audits/Fable_Audit_Fix_Progress.md) | Progress log fixing Fable Audit findings — status per TODO.md |

---

## reference/ — living docs, kept in sync with code

| File | Summary |
|---|---|
| [system_roadmap.md](reference/system_roadmap.md) | Exported functions, state maps, event routing |
| [config_roadmap.md](reference/config_roadmap.md) | Manifest of all database-stored config keys |
| [ux_roadmap.md](reference/ux_roadmap.md) | Application workflows and interface structure |
| [discordjs_reference.md](reference/discordjs_reference.md) | Verified discord.js API notes — check before trusting training data |
| [autocomplete-sort-filter-reference.md](reference/autocomplete-sort-filter-reference.md) | Filter/sort rules per `/story` autocomplete subcommand |
| [HOSTING.md](reference/HOSTING.md) | Production hosting (Pterodactyl) access/deploy reference |
| [PRIVACY_POLICY.md](reference/PRIVACY_POLICY.md) | User-facing Privacy Policy & ToS (canonical source is `privacy-policy.js`) |

---

## help/ — assembled FAQ content

`faq-page-*.md` files are posted as Hub FAQ forum threads via `faq.js`; `faq-all-pages-sql.md`
is the combined SQL-ready source.

- [faq-page-1-overview.md](help/faq-page-1-overview.md)
- [faq-page-2-story-creation.md](help/faq-page-2-story-creation.md)
- [faq-page-3-managing.md](help/faq-page-3-managing.md)
- [faq-page-4-writer-commands.md](help/faq-page-4-writer-commands.md)
- [faq-page-5-admin-commands.md](help/faq-page-5-admin-commands.md)
- [faq-all-pages-sql.md](help/faq-all-pages-sql.md)

---

## archive/ — superseded, kept for historical reference only

| File | Superseded by |
|---|---|
| [LOGIC_ERRORS_REPORT.md](archive/LOGIC_ERRORS_REPORT.md) | `audits/Fable_Audit_2026-07.md` (self-marked SUPERSEDED) |
| [draftsystem_roadmap.md](archive/draftsystem_roadmap.md) | `reference/system_roadmap.md` |
| [help page 1.txt](archive/help%20page%201.txt), [help page 2.txt](archive/help%20page%202.txt), [help page 3.txt](archive/help%20page%203.txt) | `help/faq-page-*.md` |
