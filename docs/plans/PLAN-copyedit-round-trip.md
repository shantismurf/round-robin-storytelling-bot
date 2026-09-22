# Copyedit Round Trip (Export → Edit → Import)

Status: Draft — direction agreed, details open
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

### Format: plain text with markdown (decided)

The editing surface is Google Docs, largely on a phone. That rules out raw HTML
(escape characters and tags) and markdown-in-a-text-editor (no good phone
editor). Plain text opens cleanly in Docs on mobile and is the most faithful
representation of what is actually stored in `story_entry.content`.

Inline markdown (`*italic*`, `||spoiler||`, `[[break]]`) appears literally. For
tense/continuity work that is an advantage — what you see is what is stored —
and it round-trips losslessly. `.docx` was considered and rejected: it renders
real formatting in Docs but makes the return trip lossy and adds a dependency.

Where a delimiter is needed (whole-story file only, see phase 2), it should
follow the existing `[[...]]` bot-tag convention rather than inventing a new
one. Verified safe: `applyEntryMarkup` only transforms `[[break]]` and
`[[text|translation]]`, so an unrecognised `[[...]]` passes through untouched.

### Import flow

Phase 1 is a **single-entry** round trip on the existing edit interface: download
this entry as text, fix it wholesale with no page boundaries, upload it back.
This is the smallest change that removes the page problem entirely, its diff
fits Discord's limits comfortably, its permission model is already solved by the
edit panel's existing author/admin/creator gate, and it needs no delimiters at
all — the file is just that one entry. It also builds every piece the
whole-story version needs, so it is a stepping stone rather than throwaway work.

Phase 2 generalises the same machinery to a whole-story file.

1. Attachment upload (admin/creator gated; single-entry reuses the edit gate).
2. Parse, match blocks by entry ID, compute a per-entry diff.
3. Preview: entries changed / unchanged / missing markers. Nothing commits yet.
   Embed descriptions cap at 4096 characters (verified in the installed
   builders), so a full inline diff is not viable for anything large — the diff
   should be posted as an **attached file**, reusing the mechanism `export.js`
   already uses to attach HTML, with only a compact summary in the message.
4. On confirm, one transaction — per changed entry, `INSERT` the old content
   into `story_entry_edit` (preserving existing history semantics) then `UPDATE`
   `story_entry.content`.
5. Optionally re-post affected thread messages via the existing
   `postThreadEntry` / repost mechanism.

Because edits stay within entry boundaries, every block maps 1:1 and the
authorship ambiguity that would make this risky does not arise.

### Chapters: a real UI, not file markers (revised)

An earlier draft proposed defining chapters with markers inside the imported
file. **Rejected** — a text file gives no validation, no preview and no undo
affordance for a change to story-level structure, and an import should not be
able to silently rewrite story-level DB values as a side effect of a copyedit.

Preferred shape instead: an explicit chapter interface, along the lines of a
print-range dialog — "add a chapter", then a comma-delimited list or range of
turns (`1-4, 7`), plus optional title and summary, since AO3 chapters carry
both. Compact enough for a Discord modal and no file parsing involved.

Needs a `chapter` table (story_id, position, title, summary) and a turn
association. Design consideration: ranges are positional, so if turn reordering
(below) ever lands, chapter ranges need to move with it or be stored as
explicit turn references rather than numeric ranges.

## Build order

1. **Small** — an explicit "Add a page" button on the edit panel, plus
   `LabelBuilder.setDescription()` (present in the installed builders) to make
   the save-and-reopen behaviour visible, since it renders persistently where a
   placeholder does not.
2. **Small/medium** — single-entry export + import on the edit interface. The
   real fix for cross-page editing. Main open question is how to present it:
   framing it as one round trip ("edit as file") likely reads more clearly than
   two separate download/upload buttons.
3. **Medium** — whole-story export + import with an attached diff. Generalises
   phase 2's machinery; needs the `[[...]]` delimiter.
4. **Medium/large** — chapter interface + per-chapter export. Coordinate with
   `PLAN-series-system.md`.
5. **Large, deferred** — turn reordering (sort column + every ORDER BY).

## Open decisions

- How to present the single-entry round trip so it is obvious to a non-developer.
- Whether chapters belong in this plan or in `PLAN-series-system.md`.
- Whether the whole-story import (phase 3) is needed at all once phase 2 exists.

## Settled

- Plain text with markdown, not `.docx`.
- Chapters get a real interface; import files do not change story-level values.
- Turn reordering is not done by moving blocks in a file.

## Related

- `docs/plans/PLAN-series-system.md` — chapters/series, Status: Idea
- `docs/TODO.md:110` — export help page with Work Skin instructions
