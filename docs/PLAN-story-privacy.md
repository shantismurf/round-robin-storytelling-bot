# Story Privacy (Writer-Only Stories)

## Context

The user wants an option, set at story creation, to restrict a story so only the
creator and active writers can read/access it — everyone else in the server should
not be able to see the story thread or its content. Story *metadata* (list entries,
status embed stats) staying publicly visible is explicitly fine; it's the actual
narrative content that needs to be locked down.

This was originally raised as an urgent mid-session need, but the urgency resolved
itself (the problem story that prompted it was deleted instead). This plan is saved
for implementation in a future session, not immediately.

## Key technical constraint discovered during research

Discord threads cannot change `PublicThread` ↔ `PrivateThread` after creation — this
is a Discord platform limitation (confirmed against installed discord.js 14.26.4
source: `ThreadChannel` has no `setType`, and `.edit()` doesn't accept `type`). The
existing turn-thread precedent (`story/_turn.js:245-256`) already proves the correct
pattern: **decide public vs. private at `channel.threads.create()` time**, then use
`thread.members.add()` to grant access (works for `PrivateThread`; harmless no-op
value-add on `PublicThread`).

**Per user decision: Story Privacy is create-only.** No migration-on-toggle logic,
no `/story manage` support for changing it after creation. This avoids needing the
`migrateStoryThread()`-style cross-link/archive dance (used today only for M/E rating
changes, `story/_migration.js`) for privacy changes.

**Per user decision:** `scene_break_divider` moves out of the shared
`buildStoryInfoModal()` (`story/_metadataModals.js:264-320`) and back into the
Title/Summary modal, for **both** `/story add` and `/story manage` (keeps the two
flows' modal shapes identical). This frees the 5th slot in Story Info for the new
Story Privacy radio group. Story Privacy itself only renders/applies in the `add`
flow — `manage`'s Story Info modal ends up with 4/5 slots used (mode, order,
showauthors, turnprivacy), no replacement 5th field.

## Why this is smaller than it first looked

Both `join.js:303-310` (on join) already calls
`thread?.members.add(interaction.user.id)` **unconditionally on every join today**,
regardless of thread type. This is currently a no-op nicety on public threads but is
exactly the access-grant mechanism a `PrivateThread` needs — no new code required
there, it already works once the thread itself is created as `PrivateThread`.

Nearly everything that currently "posts story content" (status embed, thread
activity log, "post export publicly" button) posts **into the active story thread
itself** (`getActiveThreadId()`), not to some separate public channel — so once that
thread is a `PrivateThread`, all of those are already locked down for free. The two
places that need an explicit access check are `/story read` (ephemeral command,
anyone can currently run it regardless of thread membership) and its export/download
button (same code path, same gate).

## Implementation

### 1. Schema — `db/migrations/022_story_privacy.sql`
```sql
ALTER TABLE story
  ADD COLUMN IF NOT EXISTS story_privacy TINYINT(1) DEFAULT 0 AFTER story_turn_privacy;
```
0 = public (default, current behavior), 1 = writers-only. Also add the column to
`db/init.sql`'s `CREATE TABLE story` block (same position) so fresh installs match.

### 2. Config keys — `db/config_files/config_story.sql` + `db/config_roadmap.md`
Following the exact `lblTurnPrivacy` / `txtTurnPrivacyPublicDesc` /
`txtTurnPrivacyPrivateDesc` pattern already used for turn privacy:
```sql
('lblStoryPrivacy', '🛑 Story Privacy 🛑', 'en', 1),
('txtStoryPrivacyPublicDesc', 'Story is visible to anyone in the server.', 'en', 1),
('txtStoryPrivacyPrivateDesc', 'Story is only visible to story writers.', 'en', 1),
```
Plus one new user-facing error string for the `/story read` gate, approved wording:
```sql
('txtStoryPrivacyNotAWriter', 'This story is only visible to its writers.', 'en', 1),
```

### 3. Modal changes — `story/_metadataModals.js`
- `buildStoryInfoModal(cfg, state, namespace)`: remove the `scene_break_divider`
  text input from `addComponents(...)`. Add a 5th radio group,
  `storyPrivacyGroup`, alongside the other three (`modeGroup`/`orderGroup`/
  `showAuthorsGroup`/`turnPrivacyGroup`), customId `${ns}_storyinfo_privacy`,
  wired to `state.storyPrivacy`. **Only add this radio group when `ns === 'story_add'`**
  — manage's modal keeps 4 radio groups, no replacement.
- Title/Summary modal builders (inline in `story/add.js` ~line 304-313 and
  `story/manage.js` ~line 286-313): add the `scene_break_divider` TextInputBuilder
  back in (3rd component, after title/summary) for both.
- `buildStoryEmbed()` (`story/_metadataModals.js:47-151`): add a new field next to
  `lblMaxWriters` (line 121, currently `inline: false` — this is the "two empty
  fields" gap the user is seeing, since a lone non-inline field still leaves the
  row's other two grid slots blank). Change `lblMaxWriters` to `inline: true` and
  add the new `lblStoryPrivacy` field as `inline: true` right after it. Only render
  the privacy field's value from real state — no placeholder/fake default text.

### 4. Modal submit handlers — `story/add.js` (~line 243-252) and `story/manage.js`
Add `story.getRadioGroup('${ns}_storyinfo_privacy')` alongside the existing
mode/order/showauthors/turnprivacy reads in the `_storyinfo_modal` submit branch.
Store as `state.storyPrivacy` (0 or 1). Move `scene_break_divider` reading into the
`_titlesummary_modal` submit branch instead. `story/manage.js`'s submit handler
should NOT read a privacy value (field doesn't exist in its modal) — leave whatever
was set at creation untouched.

### 5. Thread creation — `storybot.js:CreateStory()` (line 105)
```js
const storyThread = await channel.threads.create({
  name: threadTitle,
  type: storyInput.storyPrivacy ? ChannelType.PrivateThread : ChannelType.PublicThread,
  reason: `Story thread for story ID ${guildStoryId}`
});
```
Add `story_privacy` to the `INSERT INTO story` column list/values (line 48-75),
sourced from `storyInput.storyPrivacy ?? 0`.

**Confirmed gap:** `channel.threads.create()` (line 105) runs under the bot's own
client, not the human creator, so only the bot becomes a thread member automatically.
`CreateStory`'s creator-join (line 118, `StoryJoin(txn, interaction, storyInput,
storyId)`) is a raw DB insert with no thread-membership side effect — unlike
`handleJoinConfirm` in `join.js`, which explicitly calls `thread.members.add()`
after `StoryJoin` for every subsequent joiner. Without a fix, a story's own creator
would be locked out of their own private thread. Fix: right after
`storyThread` is created in `CreateStory`, if `storyInput.storyPrivacy`, call
`await storyThread.members.add(interaction.user.id)` for the creator explicitly
(mirrors `join.js:306`).

### 6. Join flow — `story/join.js`
No code change needed. The existing unconditional `thread.members.add()` at
line 303-310 already grants access on join for whatever thread type exists.

### 7. Leave/removal — `story/_turn.js:departWriter()` (line 477-528)
This is the single shared function behind admin-remove, self-leave, and the
guild-leave sweep — the correct, centralized place to revoke access. Confirmed:
`departWriter`'s existing queries only fetch the departing writer's *turn* thread
(`turn.thread_id`, line 479) — not the story's main thread or its `story_privacy`
flag — so this needs one new `SELECT story_privacy, story_thread_id,
restricted_thread_id, rating FROM story WHERE story_id = ?` (or fold into an
existing query if one already touches the `story` row in this function). After the
`sw_status = LEFT` update (line 497), if `story_privacy` is true, resolve the active
thread via `getActiveThreadId()` (already imported elsewhere as the standard helper)
and call `thread.members.remove(discordUserId)`. Wrap in try/catch + log, matching
the existing defensive pattern around thread operations elsewhere in this function
(not fatal to the rest of the departure flow if it fails).

### 8. Read access gate — `story/read.js:handleRead()` (~line 164-230)
Add a writer-membership check, following the exact `isRestricted` gate pattern
already in this function (line ~184-207): after fetching `story` and before running
the entries query, if `story.story_privacy` is true, check whether
`interaction.user.id` has an active `story_writer` row for this `storyId`.
`read.js` already does its own inline active-writer query later in this same
function (line ~280-282, `SELECT story_writer_id FROM story_writer WHERE story_id
= ? AND discord_user_id = ? AND sw_status = ?`) — but that runs after the entries
are already fetched, too late to gate on. Move an equivalent check earlier
(alongside `checkIsAdmin`/`checkIsCreator`, both already imported in this file from
`utilities.js`), or lift the query into a small shared helper if that reads
cleaner — implementer's call. Admins should still bypass (matches the
`isRestricted` gate's spirit, and admins already bypass elsewhere via
`checkIsAdmin`). If ineligible, return the new `txtStoryPrivacyNotAWriter` error
message ephemeral, same shape as the existing `txtRestrictedStoryNotHere`
early-return.

This single gate also covers the HTML download button and the "post publicly"
export flow launched from `/story read`, since both are only reachable after
`handleRead` has already rendered the embed — no separate gate needed in
`export.js`'s `generateStoryExport`/`handleExportPostPublic` themselves.
`/story close`'s export is a separate, manual, optional post-close button
(`story/close.js:212`, already gated behind `checkIsAdmin`/`checkIsCreator` for who
can run `/story close` at all) — not an automatic background export, and posting
its result goes to the active (private, for a private story) thread same as
`handleExportPostPublic`, so it's already covered by the thread being private.

### 9. Explicitly out of scope (per user's own framing + this session's decisions)
- `/story list`, `/mystory list`, story status embed, roundup — metadata-only,
  staying visible everywhere, no change.
- Toggling privacy on an existing story via `/story manage` — not supported; the
  radio group does not appear in manage's Story Info modal at all.
- Any old-thread migration/cross-link logic — not needed since privacy can't change
  post-creation.

### 10. Documentation updates (per user, mid-session)

- **`checkIsCreator` semantics are intended, not a quirk — document them.**
  `utilities.js:523-529` identifies "creator" as the earliest-`joined_at` row in
  `story_writer` with `sw_status = ACTIVE` — meaning if the original creator leaves,
  creator status silently transfers to the next-earliest remaining active writer.
  This is confirmed-intended behavior. It's currently undocumented in
  `system_roadmap.md`'s function table (`checkIsAdmin` is listed at line 157;
  `checkIsCreator` is missing entirely). Add a row:
  `| checkIsCreator(conn, storyId, userId) | Earliest-joined ACTIVE writer — creator status transfers to the next writer if the original creator leaves (intended) |`
  This also simplifies the privacy access check in step 8: since the creator is
  always among active writers, "creator or writer" access for a private story is
  just "any active writer" — no separate creator check needed there.

- **"Set at creation, cannot be changed later" notice — shown in both add and
  manage embeds** (per user decision). Follow the existing inline-notice pattern
  already used for the multi-page edit warning (`lblEditPageSplitNotice` /
  `txtEditPageSplitInstructions`, rendered via `embed.addFields({ name, value })`
  in `story/edit.js:141-146`) — add a similar field to `buildStoryEmbed()` in
  `_metadataModals.js`, near the new Story Privacy field, in both the add and
  manage embeds. New config keys, wording TBD with user:
  `lblStoryPrivacyLockedNotice` / `txtStoryPrivacyLockedNotice`.

- **Manage's Story Info modal cannot show the privacy radio group at all — confirmed
  via source, not just avoided by choice.** Checked `docs/discordjs_reference.md`
  and the installed `@discordjs/builders` source directly:
  `RadioGroupBuilder` has no `setDisabled()` method (unlike `TextInputBuilder` and
  select builders, which do) — Discord's radio-group component has no disabled
  state at all. A "same picker, just disabled" field is not achievable. Per user
  decision: manage's modal instead gets a **read-only text notice** in place of the
  radio group — e.g. a `TextInputBuilder` with `.setValue(currentPrivacyLabel)` and
  effectively non-interactive framing (no `setDisabled` needed for text inputs to
  read as "just showing you the value" — could still technically be edited by the
  user, but the modal-submit handler must not read/apply this field for `story_manage`,
  matching the "only add's submit handler applies a privacy value" rule already in
  step 4). Wording/exact presentation TBD with user at implementation time.

## Verification
- `npm test` (existing Layer-1 suite) — no DB/Discord-dependent tests exist for this
  area today, so this mainly guards against syntax/regressions elsewhere; a new
  Layer-1 test for `checkIsActiveWriter`-style logic could be added following the
  existing `test/_fakeConnection.js` scripted-queue pattern if a pure-logic helper
  is extracted.
- `node --check` on every touched file.
- Manual runtime verification (per CLAUDE.md — no local execution, must push to
  main and restart the bot): create one public and one private story; confirm the
  private story's thread requires explicit membership to view in Discord itself;
  confirm a non-writer gets the new denial message from `/story read`; confirm join
  adds the joiner to the thread; confirm a removed/left writer loses thread access on
  a private story but retains it (as today, no change) on a public one.
