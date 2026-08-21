# Plan: Help System Redesign — Components V2 + Unified Wiki/In-Discord Architecture

Status: Draft — awaiting review
Created: 2026-08-21
Last Updated: 2026-08-21

---

## Context

Triggered by a real incident: an admin (alegria.defaro, The AFK Cafe™) got stuck partway through
`/storyadmin setup`, never completed it, and every command — including `/story help` — was blocked
by the setup-required gate. That specific gap is already fixed (help subcommands now bypass the
gate — see `index.js` / `commands/story.js`). This plan is the follow-up: the help system itself,
once reachable, is inconsistent and in places doesn't actually solve the problem a stuck user has.

The help system today (`faq.js`, `db/config_files/config_help.sql`) is 8 pages (`PAGE_DEFS`), ~100
config keys, rendered as classic embeds with a 2-level header tree (`##`/`###` inside one
`description` string), reached three ways:
- `/story help` — full table of contents via a select menu, then one page per selection
- `/storyadmin help` / `/mystory help` — jump straight to one relevant page (page 8 / page 7)
- Hub server FAQ forum — `syncFaqPosts()` reposts all 8 pages as forum threads on every deploy
  where `config_help.sql` changed, meant as a "one-stop wiki" separate from in-command help

It's been edited piecemeal since (confirmed by measuring actual content, not just guessing):

| Finding | Detail |
|---|---|
| Inconsistent structure | Pages 1, 2, 8 use nested sub-sections (`children` in `PAGE_DEFS`); pages 4 and 5 cram 8–11 distinct concepts into one wall of bullets under a single header instead |
| Duplicated content | Pen Name, Notifications, and Turn Privacy are each explained from scratch on 2–3 different pages with slightly different wording, no cross-links — drift risk every time one copy gets updated and the others don't |
| Fragile lookup | `handleWriterHelp`/`handleAdminHelp` reach into `PAGE_DEFS[6]`/`PAGE_DEFS[7]` by raw array index, trusting a comment to stay accurate. Reordering `PAGE_DEFS` silently breaks this with no error. The same fragility runs through the config keys themselves — `txtHelp1*`...`txtHelp8*` bake page *position* into ~100 key names, so splitting/reordering pages (exactly what this plan does to pages 4 and 5) either forces a mass rename or leaves the numbering meaningless. **Decision: move to content-based naming for both** — see Naming Convention below. |
| Doesn't fix the actual problem | `txtHelp8Setup` just says "run `/storyadmin setup`" — never explains it opens a multi-step panel needing Configure Feed Channels → pick a channel → Save. Someone stuck exactly like alegria, now able to reach this page, still wouldn't learn what to do. |
| No page-to-page flow | `/story help`'s select menu has no "back to menu" or next/prev between pages — dead end after one selection |

None of this is a size problem — measured every page's actual rendered length; longest is 2,266
chars against Discord's 4,096-char embed description cap. It's structural and editorial.

---

## Verified Platform Capabilities

Checked against installed source, not training data, per this repo's own rule
(`docs/reference/discordjs_reference.md`). Installed: `discord.js@14.27.0`,
`@discordjs/builders@1.14.1`. Confirmed present: `ContainerBuilder`, `SectionBuilder`,
`TextDisplayBuilder`, `SeparatorBuilder`, `ThumbnailBuilder`, `MediaGalleryBuilder`,
`FileBuilder` (Components V2).

Hard limits confirmed against Discord's current developer docs:

| Limit | Value |
|---|---|
| Total components per message | 40 |
| Text Display content | 4,000 chars |
| Section children | up to 3 components + 1 accessory (button or thumbnail) |
| Action row | 5 buttons, or 1 select menu |
| String select options | 25 |
| **`IS_COMPONENTS_V2` flag** | **All-or-nothing per message** — disables `content`, `embeds`, and `poll` entirely; everything must be conveyed through top-level components. Cannot mix classic embeds with Components V2 in one message. |

**Unverified / real risk:** whether a forum thread's starter message (`ForumChannel.threads.create`)
accepts a Components V2 payload the same way `channel.send()` does. Not documented anywhere I could
find, and this repo has no staging environment — every change ships by pushing to `main` and
restarting the live bot. This must be spot-checked early (Phase 0 below), before committing to
converting the FAQ sync, because if it doesn't work the forum sync needs a different plan than the
in-Discord interactive help.

---

## Design Principles

1. **Progressive disclosure, not walls of text.** People arrive at help mid-task, usually already
   confused. One focused idea per screen, not 8–11 concepts under one header. This is the fix for
   pages 4 and 5 specifically.
2. **Two render surfaces need two modes, from one source of truth.**
   - **Interactive** (`/story help`, `/storyadmin help`, `/mystory help`) — ephemeral, in the
     admin's own guild, can safely include *actionable* accessories (e.g., a button that actually
     opens the setup panel) because `interaction.guild.id` is correct for the user looking at it.
   - **Static/wiki** (hub FAQ forum) — public, shared across every server's admins, **must stay
     informational-only**. A "Open Setup Panel" button posted to the hub's shared FAQ thread would
     fire in the *hub* guild's context, not the reader's own server — wrong and potentially
     confusing/broken. Forum posts get the same Container/Section/TextDisplay visual structure, but
     no guild-scoped action buttons.
   - Same content, same visual language, two different button policies. This needs to be a property
     of the shared page-definition data, not a decision made ad hoc per page.
3. **Reuse the nav idiom this codebase already has**, don't invent a new one. `story/_entryRenderer.js`
   already implements session-backed prev/next paging (`« ← Prev / Next → »`, disabled at bounds).
   `/story help` should feel like that, not like re-running a command to see a different page.
4. **Command entry points stay need-driven.** `/storyadmin help` and `/mystory help` jumping straight
   to their relevant page (no ToC detour) is correct and doesn't need to change.

---

## Proposed Architecture

### Page-definition model (replaces/extends `PAGE_DEFS`)

Each entry gains an explicit key (not array position) and a per-entry action-accessory field that's
only ever consulted in interactive mode:

```js
{
  key: 'admin-commands',           // stable lookup — no more PAGE_DEFS[7] guessing
  titleKey: 'txtHelpAdminCmdsTitle',
  entries: [
    {
      lbl: 'lblHelpAdminCmdsSetup', txt: 'txtHelpAdminCmdsSetup',
      action: { labelKey: 'btnHelpAdminCmdsOpenSetup', customId: 'storyadmin_setup_open' }, // interactive-only
      children: [ /* ... */ ],
    },
  ],
}
```

`handleWriterHelp`/`handleAdminHelp` look up by `key`, not index.

### Naming Convention

Config keys move from position-based (`txtHelp1*`...`txtHelp8*`) to content-based, following this
repo's existing `[type][Location][Purpose][Name]` rule (`docs/reference/config_roadmap.md`) — `Location`
becomes a semantic topic segment instead of a page number, so it survives pages being split, merged,
or reordered without ever needing a mass rename again.

Representative mapping for the current 8 pages (final segmentation for the split pages 4/5 gets
finalized during Phase 3's content draft, not here — the *rule* is what's being locked in now):

| Old prefix | New `Location` segment | Page |
|---|---|---|
| `txtHelp1*` / `lblHelp1*` | `HelpOverview` | Overview |
| `txtHelp2*` / `lblHelp2*` | `HelpMyStories` | Your Stories & Turns |
| `txtHelp3*` / `lblHelp3*` | `HelpCreateStory` | Create a New Story — General Options |
| `txtHelp4*` / `lblHelp4*` | `HelpCreateStory` + new sub-topic segments once split (Phase 3) | Join Options & Metadata |
| `txtHelp5*` / `lblHelp5*` | `HelpManageStory` + new sub-topic segments once split (Phase 3) | Managing a Story |
| `txtHelp6*` / `lblHelp6*` | `HelpReadEdit` | Reading & Editing |
| `txtHelp7*` / `lblHelp7*` | `HelpWriterCmds` | Writer Command Reference |
| `txtHelp8*` / `lblHelp8*` | `HelpAdminCmds` | Admin Command Reference |

e.g. `txtHelp8SetupChannels` → `txtHelpAdminCmdsSetupChannels`; `lblHelp1PenName` → `lblHelpOverviewPenName`.

**Migration mechanics — this is not a simple find-and-replace in the SQL files.** `sync-config.js` is
additive-only: it inserts keys missing from the DB and updates changed values, but explicitly never
deletes a DB key that's no longer present in the config files (confirmed by reading it — it just logs
"note: N key(s) in DB not found... will not be touched"). Renaming ~100 keys by editing
`config_help.sql` alone would leave every old numbered key as a permanent orphan row in the live
`config` table — silent drift, the exact thing this plan exists to stop. The rename needs an explicit
one-time migration (`db/migrations/NNN_rename_help_keys.sql`, this repo's existing mechanism for
one-shot DB changes, tracked so it runs once) that deletes the old key names after the new ones are
confirmed synced. This lands as part of Phase 3.

### Two renderers, one data source

- `renderInteractive(pageDef, cfg, { session })` → Components V2 payload with nav buttons
  (prev/next/back-to-menu, mirroring `_entryRenderer.js`'s button pattern) and `action` accessories
  wired to real customIds.
- `renderStatic(pageDef, cfg)` → Components V2 payload, no nav chrome (the forum's thread list *is*
  the nav), no `action` accessories — informational only, safe to post anywhere.

Both are pure functions of `(pageDef, cfg)` plus rendering mode — testable without a live Discord
connection, following this repo's existing `test/*.test.js` convention (pure/DB-only logic via
`test/_fakeConnection.js`).

### Session state for `/story help` navigation

New lightweight session map (mirroring the existing pattern in `story/_state.js`) tracking
`{ pageIndex, guildId }` per user, so prev/next/back-to-menu buttons work the same way turn-reading
navigation already does.

---

## Content Restructuring Targets

Not final wording — every user-facing string change needs sign-off before landing in
`config_help.sql`, per this repo's zero-hardcoding rule. This is the list of *what* needs
restructuring, not the copy itself:

1. **Split page 4** (`txtHelp4Metadata`) into a `children` tree — Rating, Warnings, Dynamic,
   Relationships, Characters, Tags, Summary, Scene Break Divider each get their own labeled entry,
   matching the pattern already used elsewhere.
2. **Split page 5** (`txtHelp5WhatEdit`) the same way — each of the 11 editable settings becomes its
   own entry instead of one bulleted wall.
3. **De-duplicate, don't re-explain:** Pen Name, Notifications, and Turn Privacy each need exactly
   one canonical explanation. Where a second page needs the concept, cross-reference (a "see also"
   line, or — since we now have Section accessories — a jump button in interactive mode) instead of
   restating it with different wording.
4. **Fix `txtHelp8Setup`** to actually describe the panel flow: run the command → a panel opens →
   Configure Feed Channels (pick a channel — required) → click Save Settings to apply. This is the
   one content fix directly tied to the incident that started this review.
5. **Re-evaluate page granularity.** Splitting 4 and 5 by topic may mean more, smaller top-level
   pages rather than deeper nesting within 8 pages — fits the "one-stop wiki" framing better (a wiki
   with focused articles, not 8 long ones) and the select menu has headroom (8 of 25 options used).
   This changes the FAQ forum's thread count too. Worth deciding once the content split is drafted,
   not before.

---

## Open Risks

- **Forum + Components V2 compatibility — mostly de-risked, not fully confirmed.** Traced
  `GuildForumThreadManager.create()` in the installed discord.js source: it runs the `message` payload
  through the same generic `MessagePayload.create().resolveBody()` pipeline as any other channel send,
  with no forum-specific filtering of `flags`/`components` — identical code path to `channel.send()`.
  No client-side blocker found. What source can't confirm is a server-side-only restriction on
  Discord's end. Phase 0 below is now a cheap final check rather than an open question, and stays in
  the plan for that reason.
- **40-component budget per message.** Comfortable for current page sizes, but splitting pages 4/5
  into more entries adds components (each entry ≈ 1 TextDisplay, more with `children`). Worth a
  quick per-page component count once the content split is drafted, not just a character count.
- **No staging.** Every step below ends in "push to `main`, restart, spot-check live" per this repo's
  hosting constraints — sequencing into small phases is what keeps that survivable.

---

## Phased Implementation

**Phase 0 — De-risk the forum unknown.** Build one experimental Components V2 render (suggest page
8, since it's the one tied to the incident) and push it through both the interactive `/storyadmin
help` path and one real `syncFaqPosts()` run, live. Confirms or kills the forum-compatibility
assumption before Phase 3+ commits to it.

**Phase 1 — Rendering engine.** New page-definition schema (stable `key`s, `action` field), the two
pure renderer functions, unit tests for both against fake config data.

**Phase 2 — Interactive navigation.** Session map + prev/next/back-to-menu buttons for `/story help`,
mirroring `_entryRenderer.js`. `/storyadmin help` / `/mystory help` unaffected (still single-page
jumps) except for getting the new visual treatment.

**Phase 3 — Content restructuring.** Split pages 4 & 5, de-duplicate the repeated concepts, fix
`txtHelp8Setup`, and rename all `txtHelp1*`...`txtHelp8*` keys to the content-based convention (see
Naming Convention above). Includes the one-time `db/migrations/NNN_rename_help_keys.sql` that deletes
the old key names — `sync-config.js` won't do this on its own. All wording drafted for review before
it goes into `config_help.sql`.

**Phase 4 — Action accessories.** Wire the "Open Setup Panel" button (and any other clear candidates
found during Phase 3) into the interactive-only render path.

**Phase 5 — FAQ forum migration.** Convert `syncFaqPosts()` to the static renderer, informational-only,
using Phase 0's confirmed approach. Re-evaluate thread count against the Phase 3 page split.

**Phase 6 — Docs sync.** Update `docs/reference/system_roadmap.md` (new render functions),
`docs/reference/config_roadmap.md` (full key rename from Phase 3, plus any newly split keys),
`docs/reference/ux_roadmap.md` (new nav flow). Move this plan to `docs/plans/completed/` once shipped.

---

## Open Decisions (need your input before/at each phase)

- Exact wording for every restructured/de-duplicated string (Phase 3) — will come to you as drafts,
  not silently written into SQL.
- Whether page-splitting (item 5 above) happens now or gets logged as a future pass once Phase 3's
  draft shows how much bigger the page count gets.
- Which sections beyond Setup get action-button accessories in Phase 4 — Setup is the clear case tied
  to real harm; others are open to suggestion once the content split is drafted.
