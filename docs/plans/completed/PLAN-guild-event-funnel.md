# Plan: `guild_event` funnel table (Stage 1 of PLAN-sequencing-and-priorities.md)

Status: Implemented 2026-09-24
Created: 2026-09-24
Last Updated: 2026-09-24

## Context

`PLAN-sequencing-and-priorities.md` Stage 1 and finding 7 of `Onboarding_Review_2026-09.md`
both identify the same gap: there is no analytics or funnel instrumentation in this codebase.
LeeAnn's observed sequence (install → setup → maybe a story → uninstall) is currently an
impression, not a number, and every other item on the roadmap — the Funnel B fixes in Stage 2,
the acquisition work in Stage 3 — is unjudgeable without a way to measure where servers actually
drop off. This is deliberately the smallest and first piece of work: one migration and a small
number of insert calls at points that already exist in code, wired through one shared
non-fatal helper.

Per the task instructions (which supersede the audit doc's original column list): **no
`user_id` column.** Every funnel question here is a per-guild count over time, and confirmed
against `privacy-policy.js:14-24` — the policy enumerates exact data categories collected
(Discord IDs for writer identification, entry text, story metadata, moderation records, server
config) and product analytics is not one of them. Adding a user-identifying column would pull
this table into that policy and require a re-sync of the pinned hub message. Leaving it out
means none of that is needed, and `story_writer` already answers "who" for any story-scoped
question.

## The migration

`db/migrations/023_guild_event.sql` (022 was the prior highest). Matches the `job_log`
migration (`db/migrations/016_job_log.sql`) as the closest precedent — a small event-style
table, no foreign key, no `IF NOT EXISTS`:

```sql
-- Migration 023: add guild_event table for funnel instrumentation
-- Tracks per-guild funnel events (install through activation) so drop-off points can be
-- measured instead of guessed. No user_id column by design: every question here is a
-- per-guild count over time, and story_writer already records per-writer identity for any
-- story-scoped question. See PLAN-sequencing-and-priorities.md Stage 1 and privacy-policy.js
-- (product analytics is not one of the enumerated data categories, and it should stay that way)
CREATE TABLE guild_event (
  guild_event_id INT AUTO_INCREMENT PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  detail JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_guild_event_type (guild_id, event_type, created_at)
)
```

An index on `(guild_id, event_type, created_at)` supports the actual query shape (funnel counts
and sequences per guild/event, ordered by time).

## The shared helper

`logGuildEvent(connection, guildId, eventType, detail = null)` in `utilities.js`, next to `log()`:

```js
export async function logGuildEvent(connection, guildId, eventType, detail = null) {
  try {
    await connection.execute(
      `INSERT INTO guild_event (guild_id, event_type, detail) VALUES (?, ?, ?)`,
      [guildId, eventType, detail ? JSON.stringify(detail) : null]
    );
    log(`logGuildEvent: ${eventType} for guild ${guildId}`, { show: true });
  } catch (err) {
    log(`logGuildEvent failed for guild ${guildId}, event ${eventType}: ${err?.stack ?? err}`, { show: true });
  }
}
```

- Non-fatal by construction: the `try/catch` swallows the DB error after logging it, so a
  failed analytics write never breaks the caller's action or propagates into a story
  transaction's `catch`/`rollback` block.
- Always called with the plain pool connection, never a transaction handle, and always after
  any enclosing transaction has already committed — mirroring the existing precedent at
  `storybot.js`, where `postStoryFeedCreationAnnouncement(connection, ...)` is deliberately
  called with the outer connection after `txn.commit()`, not with `txn`.
- `show: true` on both success and failure, per the two-tier logging rule (state change /
  system error, both operationally relevant).
- Not flagged `hub: true` — this is an internal signal, not something an admin needs to see
  instantly in the hub log channel.

## The six call sites

| Event | Where | Notes |
|---|---|---|
| `guild_joined` | `index.js` — `Events.GuildCreate` | Plain connection, no transaction |
| `guild_left` | `index.js` — `Events.GuildDelete` | Plain connection, no transaction |
| `setup_opened` | `commands/_storyadminSetup.js` — `handleSetup`, right after the permission check passes | `detail: { isOwner }` |
| `setup_saved` | `commands/_storyadminSetup.js` — `handleSetupSave`, after the `upsert()` calls that actually persist the config (not right after the earlier `isFirstSetup` check, since validation can still bail out between there and the real write) | `detail: { isFirstSetup, isOwner }`, reusing the already-computed `isFirstSetup` |
| `story_created` | `storybot.js` — `CreateStory`, after `txn.commit()`, same spot as the existing `postStoryFeedCreationAnnouncement` call | |
| `writer_joined` | `story/join.js` — `handleJoinConfirm`, right after its own short-lived `txn` commits (the existing "join committed" log line) | Deliberately **not** fired for the creator's own auto-join inside `CreateStory` — see decision below |
| `turn_finalized` | `story/_writeFinalize.js` — `doFinalizeEntry`, right after its transaction's `finally`/`txn.release()` block | Single insert point covers both call sites in that file, since both route through this one function |

**`writer_joined` scope — confirmed with LeeAnn.** `StoryJoin` is called two ways, and both are
actually transactional: from inside `CreateStory`'s transaction when the creator is added as
the first writer, and from `story/join.js`'s `handleJoinConfirm`, which opens its own
short-lived `txn` around just the `StoryJoin` call. The event only fires from the standalone
join path — not the creator's auto-join — because the funnel question it answers is "did a
second person join" (the actual Funnel B activation signal), not a raw writer-add count. The
creator's own membership is already implied by `story_created`.

**`is_owner` flag** (on `setup_opened`/`setup_saved`): `interaction.user.id === interaction.guild.ownerId`.
`ownerId` is a plain property on the cached `Guild` object (no extra API call), matching
discord.js's guidance to prefer it over `fetchOwner()` when the member object isn't needed.
Framed as descriptive metadata, not a drop-off signal — the sequence `setup_opened` with no
following `setup_saved` is the actual signal, regardless of who ran it.

## Tests

`test/_guildEvent.test.js` — three cases covering a successful insert with no detail, a
successful insert with a JSON detail payload, and confirming the helper does not throw when the
underlying insert fails. Suite went from 137 to 140 passing.

## What this deliberately does not do

- No config keys — no user-facing text in this feature.
- No version bump — back-end-only, below the "significant" bar in `CLAUDE.md`'s versioning
  policy.
- Does not touch `admin_action_log` (`db/init.sql:106`) — no `guild_id` column, scoped to admin
  actions on stories, wrong table to overload.
- Does not build any query/reporting layer on top of `guild_event` — this is the table and the
  writes only.
