# Silo-Sprint Plan: Silo 5 — The Engine (storybot.js)

## Context
Audit of `storybot.js` and `config_turn.sql`. This is the core business logic layer —
CreateStory, StoryJoin, checkStoryDelay, PickNextWriter, NextTurn, updateStoryStatusMessage,
and related helpers. Focus: hardcoded strings, logging gaps, silent catches, and documentation.

---

## Bug Findings

### BUG 1 — storybot.js:166 — `updateStoryStatusMessage` fire-and-forget after CreateStory, no log
Line 166: `updateStoryStatusMessage(connection, interaction.guild, storyId).catch(() => {})` — if
the status embed fails to post for a delayed story, there is no log and the user sees nothing wrong.

**Fix:** Add `.catch(err => log(..., { show: true }))`.

### BUG 2 — storybot.js:170–173 — creator tip fire-and-forget, no log on failure
Lines 170–173: `.catch(() => {})` on the creator tip chain. Silent failure means the tip never
appears and no one knows.

**Fix:** Add `.catch(err => log(..., { show: true }))`.

### BUG 3 — storybot.js:591–601 — `updateStoryStatusMessage` + `postStoryThreadActivity` chained fire-and-forget, no log
Lines 591–601: Both the status update and activity log after `NextTurn` use `.catch(() => {})`.
If either fails, the story thread silently goes stale. No error surfaces.

**Fix:** Add `.catch(err => log(..., { show: true }))` on both.

### BUG 4 — storybot.js:831 — `statusMap` has hardcoded user-visible strings
Line 831: `{ 1: '▶️ Active', 2: '⏸️ Paused', 3: '🔒 Closed' }` — these appear directly in
the status embed field sent to Discord. Already loaded from config in the same function
(`txtActive`, `txtPaused`, `txtClosed`) but the statusMap isn't using them.

**Fix:** Replace hardcoded strings in statusMap with the already-loaded cfg values:
```javascript
const statusMap = {
  1: `▶️ ${txtActive}`,
  2: `⏸️ ${txtPaused}`,
  3: `🔒 ${txtClosed}`
};
```
Wait — this IS already the code at line 831. Confirm during implementation that it uses the
cfg variables and not bare strings. If confirmed correct, remove this bug.

### BUG 5 — storybot.js:842 — legend parts array has hardcoded user-visible labels
Line 842: `['⭐ Creator', '✍️ Current turn', '📌 Next up']` — these appear at the bottom of
the writer list in the status embed. Fully user-visible.

**Fix:** Add config keys `txtStatusLegendCreator`, `txtStatusLegendCurrentTurn`,
`txtStatusLegendNextUp`, `txtStatusLegendPaused` and build the array from cfg.

### BUG 6 — storybot.js:866–870 — `turnValue` and fallback strings are hardcoded
Lines 866–870:
- `'No active turn'` fallback when no activeTurn (story is active but no turn started)
- `'—'` fallback when story is not active

**Fix:** Add config keys `txtStatusNoActiveTurn` and `txtStatusDash` (or reuse a common `txtDash`).
Alternatively, `txtNoActiveTurn` already exists — check if it fits here or needs a separate key.

### BUG 7 — storybot.js:875–891 — `nextWriterValue` strings are hardcoded
Lines 875–891 build next-writer display like:
- `'📌 *(manually set)*'`
- `'*(next in order)*'`
- `'*Round Robin selection*'`
- `'*Random selection*'`
- `'—'`

**Fix:** Add config keys `txtStatusNextManual`, `txtStatusNextFixed`,
`txtStatusNextRoundRobin`, `txtStatusNextRandom`, `txtStatusNextDash`.

### BUG 8 — storybot.js:894–895 — turn reminder display string is hardcoded
Line 895: `` ` · reminder at ${story.timeout_reminder_percent}%` `` — visible in the embed
Turn Length field.

**Fix:** Add config key `txtStatusReminderSuffix` (template: `[percent]`).

### BUG 9 — storybot.js:898–900 — stats value strings are hardcoded
Lines 898–900: `'entry'`/`'entries'`, `'image'`/`'images'`, `'No entries yet'` — all visible
in the Entries embed field.

**Fix:** Add config keys `txtStatusEntryStats` (template: `[entry_count]`, `[entry_label]`,
`[word_count]`, `[image_part]`), `txtStatusEntryLabel`, `txtStatusEntriesLabel`,
`txtStatusImageLabel`, `txtStatusImagesLabel`, `txtStatusNoEntries`.
Or: simpler approach — `txtStatusEntryStats` (template), `txtStatusNoEntries`, and build
the parts inline using singular/plural logic driven by count. Check with user.

### BUG 10 — storybot.js:908–914 — metadata field labels are hardcoded
Lines 908–914: `'Rating'`, `'Fandom'`, `'Main Pairing'`, `'Warnings'`, `'Characters'`,
`'Additional Tags'` — all visible field names in the status embed.

**Fix:** Reuse the existing `lbl*` config keys from `config_metadata.sql`:
- `lblMetaRating`, `lblMetaFandom`, `lblMetaMainRelationship`, `lblMetaWarnings`,
  `lblMetaCharacters`, `lblMetaTags` (for Additional Tags, check exact key name).

### BUG 11 — storybot.js:920–932 — status embed field labels are hardcoded
Lines 920–932: `'Tags'`, `'Status'`, `'Mode'`, `'Writer Order'`, `'Turn Length'`, `'Writers'`,
`'Show Authors'`, `'Current Turn'`, `'Next Writer'`, `'Entries'`, `'Writer List'`, `'Closed'`
— all hardcoded field names in the status embed sent to Discord.

**Fix:** Add config keys for each. These are status embed labels — prefix `lblStatus*`.
New keys: `lblStatusTags`, `lblStatusStatus`, `lblStatusMode`, `lblStatusWriterOrder`,
`lblStatusTurnLength`, `lblStatusWriters`, `lblStatusShowAuthors`, `lblStatusCurrentTurn`,
`lblStatusNextWriter`, `lblStatusEntries`, `lblStatusWriterList`, `lblStatusClosed`.

### BUG 12 — storybot.js:924–925 — writers count and join status are hardcoded
Line 925: `'Open'`/`'Closed'` in the Writers field value — user-visible join status.

**Fix:** Reuse existing `txtOpen`/`txtClosed` from config_system.sql.

### BUG 13 — storybot.js:926 — show_authors value is hardcoded
Line 926: `story.show_authors ? 'Yes' : 'No'` — visible in embed field.

**Fix:** Reuse existing `txtYes`/`txtNo` from config_system.sql.

### BUG 14 — storybot.js:1010–1011 — creator tip in `updateStoryStatusMessage` has silent catch
Lines 1010–1011: `.catch(() => {})` when posting the creator tip on first status message.
No log if it fails.

**Fix:** Add `.catch(err => log(..., { show: true }))`.

---

## Hardcoded Strings Summary

| File | Lines | String | Resolution |
|------|-------|--------|------------|
| storybot.js | 842 | Legend: `'⭐ Creator'`, `'✍️ Current turn'`, `'📌 Next up'`, `'⏸️ Paused'` | New keys `txtStatusLegend*` |
| storybot.js | 866 | `'No active turn'` / `'—'` in turnValue | New `txtStatusNoActiveTurn`; reuse `txtNoActiveTurn` check |
| storybot.js | 875–891 | Next writer display strings (5 variants) | New keys `txtStatusNext*` |
| storybot.js | 895 | `' · reminder at N%'` suffix | New `txtStatusReminderSuffix` (template: `[percent]`) |
| storybot.js | 898–900 | Entry stats: `'entry'`/`'entries'`/`'image'`/`'images'`/`'No entries yet'` | New keys `txtStatusEntryStats`, `txtStatusNoEntries`, `txtStatusEntry`, `txtStatusEntries`, `txtStatusImage`, `txtStatusImages` |
| storybot.js | 908–914 | Metadata field labels: Rating, Fandom, etc. | Reuse `lblMetaRating`, `lblMetaFandom`, `lblMetaMainRelationship`, `lblMetaWarnings`, `lblMetaCharacters`, `lblMetaTags` |
| storybot.js | 920–932 | Status embed field labels (12 fields) | New `lblStatus*` keys |
| storybot.js | 925 | `'Open'`/`'Closed'` in Writers field | Reuse `txtOpen`/`txtClosed` |
| storybot.js | 926 | `'Yes'`/`'No'` for show_authors | Reuse `txtYes`/`txtNo` |
| storybot.js | 869–870 | `'No active turn'` / `'—'` (non-active branch) | Same as line 866 fix |

### Keys already in config that can be reused (no new SQL):
- `txtYes`, `txtNo`, `txtOpen`, `txtClosed` (config_system.sql)
- `txtNoActiveTurn` (config_system.sql — verify it fits here contextually)
- `lblMetaRating`, `lblMetaFandom`, `lblMetaMainRelationship`, `lblMetaWarnings`,
  `lblMetaCharacters`, `lblMetaTags` (config_metadata.sql)

---

## Logging Gaps

| Function | Gap |
|----------|-----|
| `CreateStory()` | Entry log missing. Add `{ show: false }` with guildId + title. |
| `CreateStory()` | Lines 166, 170–173: silent `.catch(() => {})` — add error log (BUG 1, 2) |
| `StoryJoin()` | Entry log missing. Add `{ show: false }` with storyId + userId. |
| `checkStoryDelay()` | Entry log missing. Add `{ show: false }` with storyId. |
| `PickNextWriter()` | Entry log missing. Add `{ show: false }` with storyId. |
| `NextTurn()` | Entry log missing. Add `{ show: false }` with storyWriterId. |
| `NextTurn()` | Lines 591–601: silent `.catch(() => {})` — add error log (BUG 3) |
| `handleQuickModeNotification()` | Entry log missing. |
| `handleWriterNotification()` | Entry log missing. Log which notification method was used (DM vs mention) and whether DM fallback occurred. |
| `postWelcomeMessage()` | Entry log missing. |
| `updateStoryStatusMessage()` | Entry log missing. Add `{ show: false }` with storyId. |
| `updateStoryStatusMessage()` | Line 1010: silent `.catch(() => {})` — add error log (BUG 14) |
| `deleteThreadAndAnnouncement()` | Entry log missing. |
| `skipActiveTurn()` | Entry log missing. |
| `migrateStoryThread()` | Entry log exists at line 1199 (success), but no entry log at start. Add one. |
| `buildThreadTitle()` | Low priority — internal helper only; no entry log needed. |

---

## Config SQL Updates

New keys to add to `config_turn.sql`:

```
txtStatusLegendCreator         — '⭐ Creator'
txtStatusLegendCurrentTurn     — '✍️ Current turn'
txtStatusLegendNextUp          — '📌 Next up'
txtStatusLegendPaused          — '⏸️ Paused'
txtStatusNoActiveTurn          — 'No active turn' (check if txtNoActiveTurn already fits)
txtStatusNextManual            — '📌 *(manually set)*'
txtStatusNextFixed             — '*(next in order)*'
txtStatusNextRoundRobin        — '*Round Robin selection*'
txtStatusNextRandom            — '*Random selection*'
txtStatusReminderSuffix        — ' · reminder at [percent]%'
txtStatusNoEntries             — 'No entries yet'
txtStatusEntryStats            — '[entry_count] entries · ~[word_count] words[image_part]'
lblStatusTags                  — 'Tags'
lblStatusStatus                — 'Status'
lblStatusMode                  — 'Mode'
lblStatusWriterOrder           — 'Writer Order'
lblStatusTurnLength            — 'Turn Length'
lblStatusWriters               — 'Writers'
lblStatusShowAuthors           — 'Show Authors'
lblStatusCurrentTurn           — 'Current Turn'
lblStatusNextWriter            — 'Next Writer'
lblStatusEntries               — 'Entries'
lblStatusWriterList            — 'Writer List'
lblStatusClosed                — 'Closed'
```

`config_roadmap.md` manifest updated. `ux_roadmap.md` Silo 5 marked complete.

---

## User Decisions (Resolved)

1. **Entry stats format**: Use a single template key. Plurals always present even on singular
   counts — accepted. `txtStatusEntryStats` = `'[entry_count] entries · ~[word_count] words[image_part]'`.
   Build `[image_part]` conditionally inline as ` · N images` (always plural).

2. **`txtStatusNoActiveTurn`**: Separate key from `txtNoActiveTurn`. Value: `You do not have an active turn.`

3. **Turn thread title order**: Reorder so turn number comes first to distinguish turn threads
   from story threads in the channel list. New format:
   `'Turn [storyTurnNumber] - Story ID: [story_id] - [user display name] - Ends [turnEndTime] (UTC)'`
   Update `txtTurnThreadTitle` config value accordingly.

4. **Thread title date off-by-one**: `toLocaleDateString` uses the server's local timezone (UTC
   on the host), but users in negative UTC offsets see the turn end date as one day earlier in
   Discord's timestamp display. Fix: use `{ timeZone: 'UTC' }` in `toLocaleDateString` and append
   `(UTC)` to the date in the thread title so users know the date is UTC-based.

---

## Implementation Order

1. **Bugs first** — BUG 1–3 (silent catches in CreateStory and NextTurn); BUG 14 (creator tip)
2. **Logging** — entry logs for all functions listed above
3. **Hardcoded strings** — `updateStoryStatusMessage` is where most hardcoded strings live;
   fix in this order: legend → turnValue → nextWriterValue → reminderSuffix → stats → field labels
4. **Config SQL** — add all ~27 new keys to `config_turn.sql`
5. **Roadmap** — update `config_roadmap.md` and `ux_roadmap.md`

---

## Files to Modify
- [storybot.js](storybot.js) — Bugs, logging, hardcoded string migration
- [db/config_files/config_turn.sql](db/config_files/config_turn.sql) — New status embed keys
- [db/config_roadmap.md](db/config_roadmap.md) — Updated manifest and count
- [ux_roadmap.md](ux_roadmap.md) — Silo 5 complete

## Files NOT Modified
- `announcements.js` — not in Silo 5 scope
- `story/metadata.js` — not in Silo 5 scope
- `job-runner.js` — audited in Silo 1; complete

---

## Notes

- `storybot.js` is currently ~1200 lines. CLAUDE.md targets <500 lines. After the hardcoded
  string and logging work, consider whether `updateStoryStatusMessage` (lines 766–1016, ~250 lines)
  should be split into a separate `storyStatus.js` helper. Raise with user before splitting.
- `buildThreadTitle()` at line 1071 duplicates logic from `updateStoryStatusMessage` lines 947–956.
  These could share a single helper. Note this but don't refactor without user sign-off.
- `checkStoryDelay()` at line 336 checks `story.story_status === 2` to activate, but the delay
  status is `4` per the comment at line 61. Verify whether this is a latent bug or intentional.
  Raise with user before touching.
