# Story Entry Mentions: Always Display Text, Never Functional

Status: Pending
Created: 2026-08-17
Last Updated: 2026-08-17

---

## Context

Discord announced an upcoming "Channel Obfuscation for Users and Bots" change (HTTP effective
2026-11-16, Gateway already testable via opt-in): channels a bot lacks `VIEW_CHANNEL` on get
redacted — `name` becomes the literal string `"___hidden___"` — instead of being fully visible
as they are today. Investigating whether this affected the bot's story/channel setup surfaced
that it doesn't (admin channel setup goes through Discord's native channel-select component via
the interaction payload, a path the change explicitly doesn't touch), but it did surface a real,
separate design gap in `story/export.js`: when a story entry mentions a Discord channel/user/role
the bot can't resolve, the code falls back to printing the raw numeric ID — and once obfuscation
is active, a hidden channel would resolve its `.name` to the literal placeholder string
`"___hidden___"`, which could leak into an exported story verbatim.

Working through the fix surfaced a bigger, underlying design question worth deciding
deliberately rather than patching around: what should `@user`/`#channel`/`@role` mentions in a
story entry ever be — live Discord references, or plain narrative text? This document is the
result of that decision.

## Decision: mentions are always plain display text — never a raw ID, never a functional link

Story entries never contain functional Discord mentions or clickable channel links, anywhere
they're shown — not just in the AO3-facing HTML export, but inside Discord itself (the
permanent story thread's entry posts/embeds, "view last entry," the edit modal). A mention
typed into a story is in-fiction text, not a real address-book lookup, and must never behave
like one:

- It should never accidentally notify a real Discord user just because their handle happened to
  get used as narrative text.
- It should never leak a real Discord account or a private server's channel structure to a
  reader on an external platform (this bot's stories are written for export to AO3 — an
  external, non-Discord audience).

So mentions always resolve to plain display text: the real name when it can be resolved, or a
generic placeholder (e.g. `@[user]`, `#[channel]`) when it can't — covering every failure mode
identically (channel hidden/obfuscated, ordinary cache miss, channel/user deleted, user left the
server). Never the raw numeric ID, never a `discord.com/...` link, under any circumstance.

Resolution happens **once, at submission time** — as part of the same step that builds a
writer's finalize/confirm preview — not stored separately and not re-resolved live later. The
resolved text simply *is* what gets stored as the entry's content from that point forward; there
is no raw token preserved anywhere for a later process to re-interpret. This requires no
database schema change: earlier drafts of this plan explored a separate `resolved_content`
column (to keep raw markdown around for live Discord rendering elsewhere), but that was based on
an assumption — that live Discord pings needed to keep working — that turned out to be wrong.
Once mentions are never supposed to be functional anywhere, there's nothing to preserve two
copies of.

## Explicitly out of scope

**A hypothetical future "interactive" story format that deliberately routes readers to
different Discord channels via real, functional links** — e.g. a branching/"choose your path"
story implemented as live channel links. Described by the user as "wild but possible," and
intentionally not supported now: this bot exists to produce stories for export to AO3, not for
permanent interactive display inside Discord. If this is ever wanted, it is a real design
reversal — it touches the finalize/edit/restore write paths and export, not a small tweak — and
should revisit the tradeoffs recorded here (pen-name anonymity for writers, avoiding accidental
pings, avoiding dead links for non-Discord readers) rather than silently re-adding functional
links.

## Implementation

### 1. Shared resolution helper

Extract the mention-resolution block currently inside `discordMarkdownToHtml`
(`story/export.js:39-65`) into a narrow, reusable helper — e.g. `resolveMentionsToPlainText(text,
guild)` in `story/_entryMarkup.js`, alongside the existing `applyEntryMarkup`/`isSceneBreakLine`
per-target transform pattern. It substitutes only `<@id>`/`<#id>`/`<@&id>` tokens; emoji,
timestamps, and CDN image links pass through untouched (handled elsewhere in the export
pipeline and unaffected by this change).

**Add a short comment at this helper explaining the "always flatten, never link" rule and
pointing back to this document** — so a future reader of the code directly (not digging through
plan history) sees that this is a deliberate decision, not an oversight, before they'd be
tempted to "fix" it by restoring functional mentions.

### 2. Placeholder text

The fallback placeholder (used whenever a mention can't be resolved to a real name) is
genuinely user-facing — every writer sees it, not just export readers — so it must be a config
key, not a JS literal, per this project's no-hardcoded-text rule. New keys in
`config_metadata.sql` or `config_other.sql` (e.g. `txtExportPlaceholderUser`,
`txtExportPlaceholderChannel`, `txtExportPlaceholderRole`); exact wording pending user approval.

The existing no-guild placeholder branch in `story/export.js` (`'@[user]'`/`'#[channel]'`/
`'@[role]'`, lines 61-65) is a separate case: verified `generateStoryExport` has exactly 3 real
call sites (`export.js:380`, `read.js:420`, `close.js:212`), all passing `interaction.guild`
from a live guild interaction — this bot has no DM-context commands, so `guild` is never
actually null in production. The only place it's null is 4 image-handling unit tests in
`test/export.test.js`, none of which contain a mention token, so that branch never executes for
them either. Remove that branch entirely rather than route it through config — it's incidental
test plumbing, not a real production path, and deleting it is simpler than preserving dead code.

### 3. Write sites — resolve once, use the result for both preview and storage

- `story/_writeFinalize.js`'s `doFinalizeEntry()` — resolve the raw thread-message text where
  it's captured for the finalize preview (`story/_writeFinalize.js:242-266`), and insert that
  same resolved text as `content` (`story/_writeFinalize.js:292-295`).
- `story/_writeQuickMode.js`'s modal-submit/confirm step (`story/_writeQuickMode.js:70-142`) —
  same pattern.
- `story/edit.js`'s edit-modal-submit overwrite (`story/edit.js:691-693`) — an edit is a new
  submission of that entry's text, so it goes through the same resolution before overwriting
  `content`.
- `story/edit.js`'s restore path (`story/edit.js:602-605`) — apply the same resolution when
  restoring a historical version back into `content` (a no-op if that history entry was already
  resolved plain text).
- Each site needs a `guild` object in scope to resolve against — confirm availability during
  implementation (all are Discord interaction handlers, so `interaction.guild` should already
  be present).

Since resolution happens where the finalize/confirm preview is built, the writer already sees
the exact resolved text before confirming — no separate preview mechanism is needed. Wire the
resolved text into the existing finalize confirmation embed (`lblFinalizePreviewEntry`/
`txtFinalizeConfirm` in `config_turn.sql`, both normal and quick-mode confirm steps); it's just
what `content`'s preview shows now, not an addition.

### 4. `story/export.js` keeps a copy of the resolution logic — as backward compatibility

Existing rows in `story_entry.content` already contain raw `<@id>`/`<#id>` tokens and always
will (no backfill migration — see below), so export needs to keep resolving them. The
regex-based approach is naturally idempotent: run it against already-resolved plain text (new
entries) and it simply finds no token to match, passing the text through unchanged. One helper
serves both eras of data without needing to branch on which one it's looking at.

### 5. No backfill migration

Old entries keep their raw tokens in storage permanently; export's use of the shared helper
resolves them correctly on every export run regardless. Worth a quick check during
implementation for any display path that renders `content` verbatim without going through the
helper (e.g. a thread repost of a very old entry) — but not worth a migration to fix
retroactively.

### 6. Minor side effect

Word counts (`export.js`, `_writeQuickMode.js`, `roundup.js`, `_manageEntriesList.js`,
`close.js` — all do `content.split(/\s+/).length`-style counts) will shift slightly for entries
with mentions once resolution happens at write time: a raw token counts as one "word," a
resolved display name may be multiple words. Arguably more accurate (matches what's actually
displayed), but a real, if small, behavior change worth knowing about going in.

### 7. Documentation

Once implemented, add a one-line note to `docs/reference/system_roadmap.md`'s
`story/_entryMarkup.js` file-inventory row noting the new helper and that its flatten-only
behavior is deliberate (see this doc), not incidental.

## Verification

- Run existing tests: `npm install && npm test` — none of `test/export.test.js`'s 4 no-guild
  calls contain mention tokens, so extracting the resolution block doesn't change their
  behavior.
- Add new tests for the write-time resolution (finalize/quick-mode/edit/restore all storing
  resolved text) and for the placeholder rule (unresolvable mention → config placeholder, never
  an ID or link), using the existing `test/_fakeConnection.js` scripted-queue pattern.
- The obfuscation angle specifically doesn't need a live-Discord repro (opting into the Gateway
  `capabilities` flag) — the placeholder rule covers it structurally, since any unresolved
  mention behaves identically regardless of *why* it couldn't be resolved.

## Versioning

Touches finalize, quick-mode, edit, restore, and export, but with no schema change — likely
PATCH-to-MINOR per the Versioning Policy (moderate file count, no migration/rollback risk). Not
decided here; propose the number with reasoning for approval once implemented, per policy.
