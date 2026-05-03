# Rating-Barrier Thread Migration Feature

## Context

When a story's rating crosses the NR/G/T ↔ M/E threshold, the story thread must move to the appropriate feed channel. The manage flow already has `crossesBarrier` logic, but it is broken in two ways and the migration itself lacks cross-link messages and the ability to reopen an existing thread. Additionally the metadata panel gives no warning when a barrier-crossing rating is selected.

The DB `story` table already has both `story_thread_id` and `restricted_thread_id` (VARCHAR 20), confirmed in migration `006_story_ao3_metadata.sql`. The design uses these as permanent pointers:
- `story_thread_id` — the unrestricted (main) feed channel thread; never changes after story creation
- `restricted_thread_id` — the M/E restricted feed channel thread; set on first NR→M migration

The "active" thread is computed as: `restricted_thread_id` if `isRestricted(rating) && restricted_thread_id`, otherwise `story_thread_id`. A helper `getActiveThreadId(story)` encodes this.

## Files Changed

- `storybot.js`
- `story/manage.js`
- `story/addMetadata.js`

---

## `storybot.js` Changes

### 1. Export `getActiveThreadId` helper
```js
export function getActiveThreadId(story) {
  return (isRestricted(story.rating) && story.restricted_thread_id)
    ? story.restricted_thread_id
    : story.story_thread_id;
}
```

### 2. Update `postStoryThreadActivity`
Change SELECT to also fetch `restricted_thread_id` and `rating`, then use `getActiveThreadId`.

### 3. Update `updateStoryStatusMessage`
- Add `restricted_thread_id` to SELECT
- Use `getActiveThreadId(story)` instead of `story.story_thread_id` for thread fetch and title sync

### 4. Update `NextTurn`
- Add `s.restricted_thread_id` to writer info SELECT
- In `handleQuickModeNotification`, use `getActiveThreadId(writer)` as `linkToThreadId`

### 5. Rewrite `migrateStoryThread`

**Two-thread-per-story design:**
- `story_thread_id` = permanent unrestricted thread (never overwritten after creation)
- `restricted_thread_id` = permanent restricted thread (set on first NR→M migration)

**NR→M:** archive `story_thread_id`; create/reopen `restricted_thread_id`; post cross-links; update `restricted_thread_id` in DB.

**M→NR (standard):** archive `restricted_thread_id`; reopen `story_thread_id`; post cross-links; no column change needed.

**M→NR (M-created story, no prior NR thread):** archive `story_thread_id`; create new NR thread; update `story_thread_id` = new thread, `restricted_thread_id` = old M thread.

### 6. Add `buildThreadTitle(connection, story)` helper
Builds the thread name string from config templates.

---

## `story/manage.js` Changes

### 1. Fix `barrierWarning` in `buildManageMessage`
Old code only reacted to `state.pendingRating`. New:
```js
const effectiveRating = state.pendingRating ?? state.rating;
const originalRating = state.originalRating ?? state.rating;
const barrierWarning = effectiveRating !== originalRating && crossesBarrier(originalRating, effectiveRating)
  ? `\n\n${cfg.txtRatingChangeThreadWarning}` : '';
```

### 2. Add `'txtMetaApplied'` to the `cfg` fetch in `handleManage`

### 3. Change `onSave` success message
```js
await interaction.update({ content: cfg.txtMetaApplied ?? cfg.txtMetaSaveSuccess, embeds: [], components: [] });
```

### 4. Fix migration trigger in `handleManageSave`
```js
if (finalRating !== state.originalRating && crossesBarrier(state.originalRating, finalRating)) {
  const migResult = await migrateStoryThread(connection, interaction.guild, state.storyId, finalRating);
```

### 5. Update `applyPauseActions` and `applyResumeActions`
Fetch `restricted_thread_id` alongside `story_thread_id`; use active thread based on `state.rating`.

---

## `story/addMetadata.js` Changes

### 1. Import `crossesBarrier` from `./metadata.js`

### 2. Add `'txtMetaApplied'` and `'txtRatingChangeThreadWarning'` to `getMetaCfg`

### 3. Add barrier warning field in `buildMetadataPanel`
```js
if (state.originalRating && state.rating !== state.originalRating
    && crossesBarrier(state.originalRating, state.rating)) {
  embed.addFields({
    name: '⚠️ Rating Change',
    value: cfg.txtRatingChangeThreadWarning ?? 'This rating change will move the story to a different feed channel.',
    inline: false,
  });
}
```

---

## New Config Keys (code has hardcoded fallbacks)

| Key | Purpose | Example value |
|-----|---------|---------------|
| `txtMetaApplied` | Metadata panel success msg (manage flow) | `"Metadata staged. Click Save Settings on the manage panel to write to the database."` |
| `txtStoryThreadMigratedOut` | Posted in old thread before archiving | `"This story has moved to a new channel: [new_thread_link]"` |
| `txtStoryThreadMigratedIn` | Posted in new/reopened thread | `"This story continues from a previous thread: [old_thread_link]"` |

---

## Verification

1. **Metadata panel barrier warning**: Open manage → Metadata → change rating across barrier → warning field appears in embed.
2. **Success message**: After saving metadata panel in manage flow, message tells user to click Save Settings.
3. **Thread migration on Save Settings**: Old thread gets "moved to" message + archived/locked. New thread gets "continues from" message. Status embed reposts.
4. **Round-trip migration**: NR→M then M→NR reopens original threads rather than creating new ones.
5. **M-created story going NR**: New NR thread created; old M thread stored for future re-use.
6. **Pause/Resume on restricted story**: Story thread title update targets active (restricted) thread.
7. **Add flow**: No barrier warning shown (no `originalRating`). Save works as before.
