# Plan: Sequencing & Priorities — what to build, in what order, and why

Status: Draft — awaiting review
Created: 2026-09-22
Last Updated: 2026-09-22

A read across all plan files and the TODO backlog, done 2026-09-22, to answer one question:
given everything that is designed but not built, what should happen next and in what order.

This is a plan *about* the other plans. It does not replace them — each one keeps its own
design work. It says which to open next and which to leave closed for now.

---

## Corrections found during the pass

Three pieces of drift, all cheap to fix, listed first because they make the inventory below
trustworthy.

1. **`PLAN-mention-display-text.md` is finished but filed as pending.** The plan header reads
   `Status: Implemented 2026-08-26`, and the implementation is verifiably in the codebase —
   `resolveMentions` appears in `story/_entryMarkup.js`, `_writeFinalize.js`,
   `_writeQuickMode.js`, `edit.js`, `export.js`, plus `test/_entryMarkup.test.js`. But
   `docs/INDEX.md` lists it as **Pending**, and the file is still in `plans/` rather than
   `plans/completed/`. Fix: move the file, update the index row.
2. **`PLAN-help-system-redesign.md` is missing from `docs/INDEX.md` entirely.** It exists
   (`Status: Draft — awaiting review`, 2026-08-21, 387 lines), `TODO.md` links to it, and
   `PLAN-panel-rework-and-ground-rules.md` names it as a downstream dependency. A live
   dependency pointing at a plan the master map does not list is exactly how work gets lost.
3. **The two documents added 2026-09-22** (`PLAN-marketing-and-listing.md` and
   `audits/Onboarding_Review_2026-09.md`) are not yet in the index either.

---

## Inventory — real status, not claimed status

| Plan | Real status | Size | Blocked by / notes |
|---|---|---|---|
| `PLAN-panel-rework-and-ground-rules.md` | Parts 1/1b/1c/3 shipped; Part 2 (Ground Rules) designed, not started | 713 lines | Nothing. Blocks the help redesign. |
| `PLAN-help-system-redesign.md` | Draft — awaiting review | 387 lines | Its own Phase 3 waits on panel-rework Part 2. |
| `PLAN-hub-sharing.md` | Partially Implemented — needs review | 332 lines | Needs an audit pass, not a build. Per-guild opt-in, per-story opt-out and writer consent were not found in the code. |
| `PLAN-story-privacy.md` | Pending, design resolved 2026-07-21 | 232 lines | Nothing technical. |
| `PLAN-marketing-and-listing.md` | Draft — not approved | 174 lines | Its Part 4 (measurement) is a prerequisite for judging its Parts 1–3. |
| `PLAN-mention-display-text.md` | **Implemented 2026-08-26** | 170 lines | Done. See correction 1. Relevant date: Discord's channel-obfuscation change is HTTP-effective 2026-11-16; this plan is what covers it, and it is already in. |
| `PLAN-story-list-overhaul.md` | Pending, layout decided | 89 lines | Nothing. |
| `hub-brainstorming.md` | Companion notes | 76 lines | Reconcile with `PLAN-hub-sharing.md` during that plan's audit. |
| `PLAN-dm-support.md` | Pending | 42 lines | Requires the User Install scope in the Discord dev portal. |
| `PLAN-reactions-kudos.md` | Idea — brainstorm only | 16 lines | Not a design yet. |
| `PLAN-series-system.md` | Idea — brainstorm only | 12 lines | Not a design yet. |

Roughly 2,200 lines of design work, of which one plan is complete and one is half-complete.
That is not an unfocused project. It is a well-documented project with no stated order.

---

## The organizing principle

From `audits/Onboarding_Review_2026-09.md` and the top.gg result, there are two funnels:

- **A — Acquisition:** someone hears about the bot → it is in their server. Currently near
  zero. A top.gg staff pick, the best placement that channel offers, produced no genuine
  installs.
- **B — Activation:** installed → a story running with more than one writer. Admins reach
  setup and often create a story, then leave, because the story is created into a room nobody
  else can see.

**Every plan in the inventory above makes the product deeper. None of them makes either funnel
wider.** That is the actual finding of this pass, and it is the reason for the order below.

The test to apply to any candidate work: *does this help someone discover the bot, or help a
server get to its second writer?* If neither, it is depth, and depth is currently being built
for an audience that has not arrived.

---

## The sequence

### Stage 1 — Make it measurable (do this first, it gates everything else)

The `guild_event` table from the onboarding review, finding 7: one small table and roughly
seven insert calls at points that already exist in code — `guild_joined`, `setup_opened`,
`setup_saved`, `story_created`, `writer_joined`, `turn_finalized`, `guild_left`.

Nothing else in this document can be judged without it. It is also the smallest item here.
No plan file exists for it; it is small enough that this section is the plan.

### Stage 2 — The first-run fixes

The Funnel B items from the onboarding review, in its own suggested order. All are small, none
has a plan file, and together they are the difference between a solo notepad and a group
activity:

1. Join button on the feed-channel creation announcement (`announcements.js:128`), not only on
   the in-thread status embed.
2. An invite step after story creation — a copyable thread link, and an optional ping the admin
   chooses to send.
3. A welcome message on `GuildCreate`, which currently posts nothing at all.
4. Do not silently start a solo story's turn clock; use the existing Delay Start "wait for N
   writers" machinery.
5. Copy fixes: soften the setup-required wall, say that only a title is required, give the
   setup confirmation a next step.

**Fold in from the backlog here:** Fable Audit item **1.14**, the join-capacity race in
`handleJoinConfirm` (`story/join.js`) that re-validates `max_writers` outside the transaction.
Stage 2 exists to push more people down the join path; fixing the join path's one known
correctness bug belongs in the same pass.

### Stage 3 — Acquisition

`PLAN-marketing-and-listing.md`, in its own stated order. Its Part 4 is Stage 1 above, so by
this point it is already done. That leaves: pick one writing community and try it, make the
screenshots, rewrite the tagline and opening line, write an admin-facing install doc.

Explicitly not recommended: further investment in top.gg placement.

### Stage 4 — The panel and help chain

This is the one place the existing docs already specify an order, and it should be respected:

1. `PLAN-panel-rework-and-ground-rules.md` **Part 2 (Ground Rules)** — designed, not started.
   Get the real component count while building it, then revisit the Settings/Metadata tab split
   question that Part 2's own note leaves open.
2. The **`/storyadmin setup` permission-tier split** (TODO, raised 2026-09-22). Ground Rules is
   the first setting that makes this matter, so it belongs in the same pass. Keep the
   escalation-capable fields at Manage Server; the bullet explains why.
3. `PLAN-help-system-redesign.md` **Phase 3**, which the panel-rework plan says must wait for
   the above.

Stage 4 also earns its place on Funnel B: the create panel's fifteen-decision problem is a
panel problem, and the help system is what a stuck admin reaches for.

### Stage 5 — Deferred by owner decision, 2026-09-22

Reviewed with LeeAnn. The reasoning is recorded because the *why* is the part that gets lost
and re-litigated — the same lesson the changelog directory exists for.

- **`PLAN-hub-sharing.md` — deferred.** The Hub server has nine members: three bots, two of
  them LeeAnn, one the top.gg admin, and three people who may or may not have the bot
  installed. There is no audience for story sharing yet. The audit of what is actually built
  (per-guild opt-in, per-story opt-out, writer consent — none found in the code despite the
  hub infrastructure being live) still needs doing, but only when this is picked back up.
  Reconcile `hub-brainstorming.md` into it at that point.
- **`PLAN-story-privacy.md` — shelved, probably not wanted.** The feature originated from
  LeeAnn needing a clean export of a story that was not ready to be public. She solved it by
  creating the story on the Hub server and deleting it afterwards. No one else has asked for
  it. Fully designed and ready if demand ever appears, but do not build it on spec.
- **`PLAN-dm-support.md` — deferred indefinitely.** Will not be implemented unless someone
  asks for it. Related observation: the turn-notification rewording seems to have reduced
  confusion, though it is unclear whether that is the copy or simply that the existing writers
  have learned the system. Installing into a new community will distinguish the two.

### Stage 6 — Worth revisiting

- **`PLAN-reactions-kudos.md` and `PLAN-series-system.md`** — both flagged by LeeAnn on
  2026-09-22 as having real value, against their "Idea" status. Series/chapters is under
  active discussion in the story-editing thread as of that date, so **that discussion owns the
  design** — do not write a competing one here. Both still need a resolved design before they
  are buildable.
- **`PLAN-story-list-overhaul.md`** — modest Funnel B relevance, since the quick-join menu
  lives on `/story list` and that is one of the three join routes. Unchanged by this review.

---

## Backlog triage

The TODO items that are not plan-sized sort into three groups.

**Fold into a stage above:**

- 1.14 join-capacity race → Stage 2.
- `/storyadmin setup` permission tiers → Stage 4.
- Per-server concurrent story limit → Stage 4 (it is a setup-panel field, so it rides with the
  tier split).
- Help text review, roundup formatting → Stage 4, with the help redesign.

**Do opportunistically, when already in the file:**

- Inline `.replace()` → `replaceTemplateVariables` compliance sweep.
- `trimTrailingEmoji()` inversion.
- Shared `wordCount` helper; the hand-rolled auth check in `_writeSkip.js`.
- `formatDuration` sweep.
- The file-size split pass — **counts are stale and self-marked as needing re-audit**; re-count
  before planning any split.

**Genuine debt, schedule deliberately:**

- **~~Missing confirmation on `/storyadmin skip`/`close`/`pause`~~ — withdrawn 2026-09-22.**
  Checked against the code: those subcommands no longer exist, skip and reassign already
  confirm on the `/story manage` panel, `/story close` confirms, and pause/resume are immediate
  by design and fully reversible. They were real once and were consolidated into `/story manage`
  before the visible git history begins. The item came from a stale `ux_roadmap.md` entry left
  behind by that consolidation. Both are now corrected. Kept here as a note because it is a
  useful caution twice over: `reference/` docs are load-bearing, and an audit that reads them
  instead of the code inherits their errors — and **`git log` only reaches back to 2026-07-16**,
  so absence of history is not evidence that something never existed.
- Layer-2 integration test suite — real value (it would have caught the `JSON_EXTRACT` class of
  bug that silently broke five call sites for months), real cost. Its own session.
- `style_roadmap.md` — cheap, and it settles recurring questions. Write it the next time a
  style question comes up rather than as a standalone task.

---

## What this pass deliberately does not do

It does not re-litigate any plan's design. Every plan here was thought through when it was
written; nothing in this document says any of them is wrong. It says which are answers to the
question the project currently has, and which are answers to questions it will have later.
