# Copyedit Round Trip (Export → Edit → Import)

Status: Draft — design under discussion, not approved
Created: 2026-09-22
Last Updated: 2026-09-22

## Problem

Finished stories are published to AO3 by a single editor (LeeAnn), who runs an
extensive copyedit pass first: whole-work tense normalization, continuity, and
flow. Today that pass happens on the downloaded HTML export, and the result
**never comes back** — there is no import path anywhere in the codebase. The DB
and the Discord thread keep the as-written text permanently, so every published
work is a hand-maintained fork.

The per-entry editor (`story/edit.js`) is correctly shaped for spot fixes and
badly shaped for this. Current backlog: 50k+ words awaiting edit.

## Findings

### Pages are not a real boundary

`chunkEntryContent()` (`utilities.js:384`) splits an entry into 3800-character
pages purely to fit Discord's 4000-character modal cap. `story_entry.content`
is a single `TEXT` column; pages are computed at display time and never stored.

Confirmed with the editor: text routinely moves **across pages within an entry**
during a copyedit, but **not across turn boundaries**. So the page boundaries
that make editing painful are a UI artifact of a Discord limit, and the editor
is currently doing chunking arithmetic by hand to satisfy a constraint the data
model does not have. Entry boundaries, by contrast, are real and stable — which
is what makes a per-entry round trip safe, with no authorship ambiguity.

### Growing an entry is undiscoverable

Within an edit session the chunk list is deliberately frozen — see the comment
at `story/edit.js:529` ("do NOT re-chunk from scratch, as that shifts boundaries
and causes orphaned content"). To add a page you must save and reopen. The only
in-app hint is `setPlaceholder()` at `story/edit.js:414`.

A placeholder renders only when the field is empty, and `setValue()` on the
preceding line always pre-fills it — so that hint almost certainly never
displays. **Not verified against a live client**; the builder just forwards
`placeholder` to the API and cannot settle a client rendering question, and this
host has no local/staging execution. Treat as strong suspicion pending a live check.

The observed workaround is padding an entry with junk text to force an extra
page — not something a non-developer would ever discover.

### No attachment handling exists

`addAttachmentOption` / `getAttachment` appear nowhere in the codebase. File
upload is new ground for this bot (supported fine by discord.js).

### Turn order has no sort column

`turn` (`db/init.sql:55`) orders solely by `started_at`. Reordering committed
turns — done manually once already, after a plot-trajectory change — requires a
new sort column plus updating every `ORDER BY t.started_at` and the correlated
`t2.started_at <= t.started_at` turn-numbering subqueries in `export.js`,
`read.js`, and `edit.js`. This is the expensive item and is deliberately deferred.

### Chapters do not exist

Only referenced as a one-line idea in `PLAN-series-system.md` (Status: Idea).
The editor's Google Docs workflow uses one tab per chapter; the bot has no
equivalent, so long works are either split into separate stories up front or
left as one 40k-word story to be divided by hand later.

### Incidental

- `story.ao3_URL` (`db/init.sql:15`) is still created but referenced by zero
  JavaScript — dead column, available if a published-URL field is wanted back.
- `CLAUDE.md` pins discord.js 14.26.4; installed resolves to 14.27.0.

## Proposed direction

### Format: plain text with visible per-entry delimiters

The editing surface is Google Docs, largely on a phone. That rules out raw HTML
(escape characters and tags) and markdown-in-a-text-editor (no good phone
editor). Plain text opens cleanly in Docs on mobile.

Delimiters must be visible and human-meaningful so they survive editing, and
distinctive enough not to collide with prose. Carrying `story_entry_id` lets the
importer detect a moved or missing block instead of silently misassigning text:

```
━━━ TURN 12 · Maria · #4417 ━━━
```

Trade-off: inline markdown (`*italic*`, `||spoiler||`, `[[break]]`) appears
literally. For tense/continuity work that is arguably an advantage — what you
see is what is stored — and it is unambiguously round-trippable. A `.docx`
export would render real formatting in Docs but makes the return trip lossy and
adds a dependency. Recommended only if the literal markup proves intolerable.

### Import flow

1. `/story import` with a file attachment (admin/creator gated).
2. Parse, match blocks by entry ID, compute a per-entry diff.
3. Preview: entries changed / unchanged / missing markers. Nothing commits yet.
4. On confirm, one transaction — per changed entry, `INSERT` the old content
   into `story_entry_edit` (preserving existing history semantics) then `UPDATE`
   `story_entry.content`.
5. Optionally re-post affected thread messages via the existing
   `postThreadEntry` / repost mechanism.

Because edits stay within entry boundaries, every block maps 1:1 and the
authorship ambiguity that would make this risky does not arise.

### Chapters via the import file

Chapter boundaries are an editorial decision made *during* the copyedit pass,
which is exactly when the editor is in the file. A `═══ CHAPTER: Title ═══`
marker in the imported text is therefore a natural place to define them, and
lets per-chapter export follow without a separate authoring UI.

## Build order

1. **Small** — make growing an entry discoverable. `LabelBuilder.setDescription()`
   (present in the installed builders) renders persistently, unlike a
   placeholder; optionally an explicit "Add a page" button.
2. **Medium** — plain-text export + `/story import` with diff preview. No
   reordering, no chapters. Addresses most of the backlog pain on its own.
3. **Medium/large** — chapter markers in the import format + per-chapter export.
   Coordinate with `PLAN-series-system.md`.
4. **Large, deferred** — turn reordering (sort column + every ORDER BY).

## Open decisions

- Plain text vs `.docx`.
- Whether import replaces the current multi-page editor for whole-entry
  replacement, or sits alongside it.
- Whether chapters belong here or in the series plan.

## Related

- `docs/plans/PLAN-series-system.md` — chapters/series, Status: Idea
- `docs/TODO.md:110` — export help page with Work Skin instructions
