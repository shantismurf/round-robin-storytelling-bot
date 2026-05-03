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

### 1. Extract `createStoryThread` from `CreateStory` lines 107–124

Extract the feed-channel-resolve + thread-title-build + thread-create block into an exported shared helper. `CreateStory` calls it; `migrateStoryThread` calls it for the new-thread case.

```js
export async function createStoryThread(connection, guild, { guildId, guildStoryId, title, rating, storyStatus, reason }) {
  log(`createStoryThread: entry guildStoryId=${guildStoryId} rating=${rating} storyStatus=${storyStatus}`, { show: false, guildName: guild?.name });
  const storyFeedChannelId = await resolveFeedChannelId(connection, guildId, rating ?? 'NR');
  log(`createStoryThread: resolved feedChannelId=${storyFeedChannelId}`, { show: false, guildName: guild?.name });
  const channel = await guild.channels.fetch(storyFeedChannelId);
  if (!channel) throw new Error(`Story feed channel ${storyFeedChannelId} not found`);

  const [titleTemplate, txtActive, txtPaused, txtClosed, txtDelayed] = await Promise.all([
    getConfigValue(connection, 'txtStoryThreadTitle', guildId),
    getConfigValue(connection, 'txtActive', guildId),
    getConfigValue(connection, 'txtPaused', guildId),
    getConfigValue(connection, 'txtClosed', guildId),
    getConfigValue(connection, 'txtDelayed', guildId),
  ]);
  const statusLabel = { 1: txtActive, 2: txtPaused, 3: txtClosed, 4: txtDelayed }[storyStatus] ?? txtActive;
  const threadTitle = titleTemplate
    .replace('[story_id]', guildStoryId)
    .replace('[inputStoryTitle]', title)
    .replace('[story_status]', statusLabel);

  log(`createStoryThread: creating thread name="${threadTitle}"`, { show: false, guildName: guild?.name });
  const thread = await channel.threads.create({ name: threadTitle, type: ChannelType.PublicThread, reason });
  log(`createStoryThread: created threadId=${thread.id}`, { show: false, guildName: guild?.name });
  return thread;
}
```

### 2. Export `getActiveThreadId` helper

```js
export function getActiveThreadId(story) {
  return (isRestricted(story.rating) && story.restricted_thread_id)
    ? story.restricted_thread_id
    : story.story_thread_id;
}
```

### 3. Update `postStoryThreadActivity`

Change SELECT to fetch `restricted_thread_id` and `rating`; use `getActiveThreadId`:
```js
const [rows] = await connection.execute(
  `SELECT story_thread_id, restricted_thread_id, rating FROM story WHERE story_id = ?`, [storyId]
);
if (!rows[0]) return;
const activeThreadId = getActiveThreadId(rows[0]);
if (!activeThreadId) return;
const thread = await guild.channels.fetch(activeThreadId).catch(() => null);
```

### 4. Update `updateStoryStatusMessage`

- Add `restricted_thread_id` to the existing big SELECT (already has `rating`)
- Change early-exit guard: `if (storyRows.length === 0 || !getActiveThreadId(storyRows[0])) return;`
- Change thread fetch: `await guild.channels.fetch(getActiveThreadId(story)).catch(() => null)`
- Update title-sync block to use `getActiveThreadId(story)` for the `setName` call

### 5. Update `NextTurn`

- Add `s.restricted_thread_id` to the writer info SELECT
- In `handleQuickModeNotification`: change `writer.story_thread_id` → `getActiveThreadId(writer)` for the `linkToThreadId` argument passed to `handleWriterNotification`

### 6. Rewrite `migrateStoryThread`

**Two-thread-per-story design:**
- `story_thread_id` = permanent unrestricted thread (never overwritten after creation, except for M-created stories on first NR migration — see below)
- `restricted_thread_id` = permanent restricted thread (set on first NR→M migration)

**NR→M:** old = `story_thread_id`; create/reopen `restricted_thread_id`; update `restricted_thread_id` in DB only.

**M→NR (standard — `restricted_thread_id` exists):** old = `restricted_thread_id`; reopen `story_thread_id`; no column changes.

**M→NR (M-created story, `restricted_thread_id` is null):** old = `story_thread_id`; create new NR thread via `createStoryThread`; update `story_thread_id` = new, `restricted_thread_id` = old M thread.

```js
export async function migrateStoryThread(connection, guild, storyId, newRating) {
  log(`migrateStoryThread: entry storyId=${storyId} newRating=${newRating}`, { show: false, guildName: guild?.name });
  try {
    const [rows] = await connection.execute(
      `SELECT guild_story_id, title, story_status, story_thread_id, restricted_thread_id, guild_id
       FROM story WHERE story_id = ?`,
      [storyId]
    );
    if (rows.length === 0) return { success: false, error: 'Story not found' };
    const story = rows[0];
    const movingToRestricted = isRestricted(newRating);
    log(`migrateStoryThread: story fetched story_thread_id=${story.story_thread_id} restricted_thread_id=${story.restricted_thread_id} movingToRestricted=${movingToRestricted}`, { show: false, guildName: guild?.name });

    let oldThreadId, newThread;
    const dbUpdates = {};

    if (movingToRestricted) {
      // Unrestricted → Restricted
      oldThreadId = story.story_thread_id;
      log(`migrateStoryThread: NR→M oldThreadId=${oldThreadId} checking for existing restricted_thread_id=${story.restricted_thread_id}`, { show: false, guildName: guild?.name });
      if (story.restricted_thread_id) {
        const existing = await guild.channels.fetch(story.restricted_thread_id).catch(() => null);
        log(`migrateStoryThread: existing restricted thread fetched=${!!existing} archived=${existing?.archived} locked=${existing?.locked}`, { show: false, guildName: guild?.name });
        if (existing) {
          if (existing.archived) await existing.setArchived(false);
          if (existing.locked)   await existing.setLocked(false);
          newThread = existing;
          log(`migrateStoryThread: reopened restricted thread ${newThread.id}`, { show: false, guildName: guild?.name });
        }
      }
      if (!newThread) {
        log(`migrateStoryThread: no existing restricted thread, creating new one`, { show: false, guildName: guild?.name });
        newThread = await createStoryThread(connection, guild, {
          guildId: story.guild_id, guildStoryId: story.guild_story_id, title: story.title,
          rating: newRating, storyStatus: story.story_status,
          reason: `Story thread migrated to restricted channel (rating: ${newRating})`,
        });
      }
      dbUpdates.restricted_thread_id = newThread.id;

    } else {
      // Restricted → Unrestricted
      if (story.restricted_thread_id) {
        // Standard: dedicated restricted thread exists; story_thread_id is the archived NR thread
        oldThreadId = story.restricted_thread_id;
        log(`migrateStoryThread: M→NR standard oldThreadId=${oldThreadId} reopening story_thread_id=${story.story_thread_id}`, { show: false, guildName: guild?.name });
        const existing = await guild.channels.fetch(story.story_thread_id).catch(() => null);
        log(`migrateStoryThread: NR thread fetched=${!!existing} archived=${existing?.archived} locked=${existing?.locked}`, { show: false, guildName: guild?.name });
        if (existing) {
          if (existing.archived) await existing.setArchived(false);
          if (existing.locked)   await existing.setLocked(false);
          newThread = existing;
          log(`migrateStoryThread: reopened NR thread ${newThread.id}`, { show: false, guildName: guild?.name });
        }
        if (!newThread) {
          log(`migrateStoryThread: NR thread gone, creating new one`, { show: false, guildName: guild?.name });
          newThread = await createStoryThread(connection, guild, {
            guildId: story.guild_id, guildStoryId: story.guild_story_id, title: story.title,
            rating: newRating, storyStatus: story.story_status,
            reason: `Story thread migrated to main channel`,
          });
          dbUpdates.story_thread_id = newThread.id;
        }
      } else {
        // M-created story: story_thread_id IS the M thread, no prior NR thread
        oldThreadId = story.story_thread_id;
        log(`migrateStoryThread: M→NR M-created story oldThreadId=${oldThreadId} creating new NR thread`, { show: false, guildName: guild?.name });
        newThread = await createStoryThread(connection, guild, {
          guildId: story.guild_id, guildStoryId: story.guild_story_id, title: story.title,
          rating: newRating, storyStatus: story.story_status,
          reason: `Story thread migrated to main channel`,
        });
        dbUpdates.story_thread_id = newThread.id;
        dbUpdates.restricted_thread_id = oldThreadId;
      }
    }

    log(`migrateStoryThread: resolved oldThreadId=${oldThreadId} newThread.id=${newThread.id}`, { show: false, guildName: guild?.name });

    const oldThreadLink = oldThreadId
      ? `https://discord.com/channels/${story.guild_id}/${oldThreadId}` : null;
    const newThreadLink = `https://discord.com/channels/${story.guild_id}/${newThread.id}`;

    // Post migration notice in old thread, then archive/lock it
    const oldThread = oldThreadId ? await guild.channels.fetch(oldThreadId).catch(() => null) : null;
    log(`migrateStoryThread: oldThread fetched=${!!oldThread}`, { show: false, guildName: guild?.name });
    if (oldThread) {
      const txtOut = await getConfigValue(connection, 'txtStoryThreadMigratedOut', story.guild_id);
      log(`migrateStoryThread: posting migration-out message to oldThread ${oldThreadId}`, { show: false, guildName: guild?.name });
      await oldThread.send(txtOut.replace('[new_thread_link]', newThreadLink)).catch(() => {});
      log(`migrateStoryThread: archiving and locking oldThread ${oldThreadId}`, { show: false, guildName: guild?.name });
      await oldThread.setArchived(true).catch(() => {});
      await oldThread.setLocked(true).catch(() => {});
      log(`migrateStoryThread: oldThread archived and locked`, { show: false, guildName: guild?.name });
    }

    // Post continuation message in new/reopened thread
    const txtIn = await getConfigValue(connection, 'txtStoryThreadMigratedIn', story.guild_id);
    log(`migrateStoryThread: posting migration-in message to newThread ${newThread.id}`, { show: false, guildName: guild?.name });
    await newThread.send(txtIn.replace('[old_thread_link]', oldThreadLink ?? '')).catch(() => {});

    // DB update — always clear status_message_id so a fresh embed is posted
    dbUpdates.status_message_id = null;
    const setClauses = Object.keys(dbUpdates).map(k => `${k} = ?`).join(', ');
    log(`migrateStoryThread: DB update setClauses="${setClauses}" values=${JSON.stringify(Object.values(dbUpdates))}`, { show: false, guildName: guild?.name });
    await connection.execute(
      `UPDATE story SET ${setClauses} WHERE story_id = ?`,
      [...Object.values(dbUpdates), storyId]
    );

    log(`migrateStoryThread: complete storyId=${storyId} newRating=${newRating} newThread=${newThread.id}`, { show: true, guildName: guild?.name });
    return { success: true, newThreadId: newThread.id };
  } catch (err) {
    log(`migrateStoryThread failed: storyId=${storyId} newRating=${newRating}: ${err?.stack ?? err}`, { show: true, guildName: guild?.name });
    return { success: false, error: String(err) };
  }
}
```

---

## `story/manage.js` Changes

### 1. Fix `barrierWarning` in `buildManageMessage`

Old code only reacted to `state.pendingRating`. Replace:
```js
const barrierWarning = state.pendingRating && crossesBarrier(state.originalRating ?? state.rating, state.pendingRating)
  ? `\n\n${cfg.txtRatingChangeThreadWarning}` : '';
```
With:
```js
const effectiveRating = state.pendingRating ?? state.rating;
const originalRating = state.originalRating ?? state.rating;
const barrierWarning = effectiveRating !== originalRating && crossesBarrier(originalRating, effectiveRating)
  ? `\n\n${cfg.txtRatingChangeThreadWarning}` : '';
```

### 2. Add `'txtMetaApplied'` to the `cfg` fetch array in `handleManage`

### 3. Change `onSave` success message in `story_manage_open_metadata` handler

```js
await interaction.update({ content: cfg.txtMetaApplied ?? cfg.txtMetaSaveSuccess, embeds: [], components: [] });
```

Add `show:false` logging in the `onSave` callback at: entry (user, storyId); metaFields received; `state.rating` and `state.originalRating` after assign; before `interaction.update`; before `editReply`; complete.

### 4. Fix migration trigger in `handleManageSave`

`finalRating` is already defined at the top of the function. Add logging and change the barrier check:
```js
log(`handleManageSave: finalRating=${finalRating} originalRating=${state.originalRating} crossesBarrier=${finalRating !== state.originalRating && crossesBarrier(state.originalRating, finalRating)}`, { show: false, guildName: state.guildName });
if (finalRating !== state.originalRating && crossesBarrier(state.originalRating, finalRating)) {
  log(`handleManageSave: triggering thread migration storyId=${state.storyId} finalRating=${finalRating}`, { show: false, guildName: state.guildName });
  const migResult = await migrateStoryThread(connection, interaction.guild, state.storyId, finalRating);
  log(`handleManageSave: migration result success=${migResult.success} newThreadId=${migResult.newThreadId} error=${migResult.error}`, { show: false, guildName: state.guildName });
  if (!migResult.success) {
    log(`Thread migration failed for story ${state.storyId}: ${migResult.error}`, { show: true, guildName: state.guildName });
  }
}
```

### 5. Update `applyPauseActions` and `applyResumeActions`

Both currently SELECT only `story_thread_id`. Add `restricted_thread_id` to the SELECT and resolve the active thread using `state.rating`:
```js
const [storyInfo] = await connection.execute(
  `SELECT story_thread_id, restricted_thread_id FROM story WHERE story_id = ?`, [state.storyId]
);
if (storyInfo[0]) {
  const activeThreadId = (isRestricted(state.rating) && storyInfo[0].restricted_thread_id)
    ? storyInfo[0].restricted_thread_id : storyInfo[0].story_thread_id;
  if (activeThreadId) {
    const storyThread = await interaction.guild.channels.fetch(activeThreadId).catch(() => null);
    // ... rest of existing logic unchanged
  }
}
```

---

## `story/addMetadata.js` Changes

### 1. Import `crossesBarrier`
```js
import { ratingLabels, dynamicOptions, warningOptions, crossesBarrier } from './metadata.js';
```

### 2. Add `'txtMetaApplied'`, `'lblRatingChangeThreadWarning'`, and `'txtRatingChangeThreadWarning'` to `getMetaCfg`

### 3. Add barrier warning field in `buildMetadataPanel`
```js
if (state.originalRating && state.rating !== state.originalRating
    && crossesBarrier(state.originalRating, state.rating)) {
  embed.addFields({
    name: cfg.lblRatingChangeThreadWarning,
    value: cfg.txtRatingChangeThreadWarning,
    inline: false,
  });
}
```

---

## New Config Keys (NO hardcoded fallbacks — all keys must be seeded in DB)

| Key | Purpose | Value |
|-----|---------|-------|
| `txtMetaApplied` | Metadata panel success msg (manage flow) | `Your changes have been **staged** only. You MUST click "Save Settings" on the Manage panel above to save them to the system.` |
| `txtStoryThreadMigratedOut` | Posted in old thread before archiving | `The rating for this story has changed and all story activity has moved to a new channel: [new_thread_link]` |
| `txtStoryThreadMigratedIn` | Posted in new/reopened thread | `The rating for this story has changed. Story activity continues from the previous thread: [old_thread_link] Use \`/story read\` to catch up with previous entries.` |
| `lblRatingChangeThreadWarning` | Embed field label for barrier warning | `⚠️ Rating Change` |
| `txtRatingChangeThreadWarning` | Embed field value for barrier warning | `This rating change will move the story to a different feed channel.` |

---

## Verification

1. **Metadata panel barrier warning**: Open manage → Metadata → change rating across barrier → `⚠️ Rating Change` warning field appears in the embed.
2. **Success message**: After saving metadata panel in manage flow, message tells user they must click Save Settings on the manage panel.
3. **Thread migration on Save Settings**: `show:false` logs confirm migration triggered. Old thread gets migration-out message + archived/locked. New thread gets migration-in message. Status embed reposts in new thread.
4. **Round-trip migration (NR→M→NR)**: Second migration reopens the original NR thread rather than creating a third thread.
5. **M-created story going NR**: New NR thread created; old M thread stored in `restricted_thread_id` for future re-use.
6. **Pause/Resume on restricted story**: Story thread title update targets the active (restricted) thread, not the archived NR thread.
7. **Add flow**: No barrier warning shown (no `originalRating`). Save works as before.
