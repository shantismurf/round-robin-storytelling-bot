import { ChannelType, EmbedBuilder } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from '../utilities.js';
import { resolveFeedChannelId, isRestricted } from './_metadata.js';

/**
 * Migrate a story's thread when its rating crosses the M/E barrier.
 *
 * Two permanent thread IDs are stored in the DB:
 *   story_thread_id      — the unrestricted (main) feed channel thread; never changed after creation
 *   restricted_thread_id — the M/E restricted feed channel thread; set on first NR→M migration
 *
 * The "active" thread is whichever one matches the current rating (see getActiveThreadId).
 * Migration posts a cross-link message in the old thread, archives/locks it, posts a
 * continuation message in the new thread, and updates the DB accordingly.
 *
 * Returns { success, newThreadId, migratedInEmbed } or { success: false, error }.
 */
export async function migrateStoryThread(connection, guild, storyId, newRating, oldRating) {
  log(`migrateStoryThread: entry storyId=${storyId} oldRating=${oldRating} newRating=${newRating}`, { show: false, guildName: guild?.name });
  try {
    const [rows] = await connection.execute(
      `SELECT guild_story_id, title, story_status, story_thread_id, restricted_thread_id, guild_id, rating
       FROM story WHERE story_id = ?`,
      [storyId]
    );
    if (rows.length === 0) return { success: false, error: 'Story not found' };
    const story = rows[0];
    const movingToRestricted = isRestricted(newRating);
    const newFeedChannelId = await resolveFeedChannelId(connection, story.guild_id, newRating);
    const newFeedChannel = await guild.channels.fetch(newFeedChannelId).catch(() => null);
    if (!newFeedChannel) return { success: false, error: 'Target feed channel not found' };

    let oldThreadId, newThread;
    const dbUpdates = {};

    if (movingToRestricted) {
      // Unrestricted → Restricted
      // story_thread_id is the permanent NR thread; it stays as-is for future M→NR migration
      oldThreadId = story.story_thread_id;

      if (story.restricted_thread_id) {
        const existing = await guild.channels.fetch(story.restricted_thread_id).catch(() => null);
        if (existing) {
          if (existing.archived) await existing.setArchived(false).catch(() => {});
          if (existing.locked)   await existing.setLocked(false).catch(() => {});
          newThread = existing;
        }
      }
      if (!newThread) {
        const { buildThreadTitle } = await import('./_storyStatus.js');
        newThread = await newFeedChannel.threads.create({
          name: await buildThreadTitle(connection, story),
          type: ChannelType.PublicThread,
          reason: `Story thread migrated to restricted channel (rating: ${newRating})`,
        });
      }
      dbUpdates.restricted_thread_id = newThread.id;
      // story_thread_id intentionally NOT updated — stays as the permanent NR thread

    } else {
      // Restricted → Unrestricted
      if (story.restricted_thread_id) {
        // Standard path: a dedicated restricted thread exists; story_thread_id is the archived NR thread
        oldThreadId = story.restricted_thread_id;
        const existing = await guild.channels.fetch(story.story_thread_id).catch(() => null);
        if (existing) {
          if (existing.archived) await existing.setArchived(false).catch(() => {});
          if (existing.locked)   await existing.setLocked(false).catch(() => {});
          newThread = existing;
        }
        if (!newThread) {
          // Original NR thread was deleted; create a new one
          const { buildThreadTitle } = await import('./_storyStatus.js');
          newThread = await newFeedChannel.threads.create({
            name: await buildThreadTitle(connection, story),
            type: ChannelType.PublicThread,
            reason: `Story thread migrated to main channel`,
          });
          dbUpdates.story_thread_id = newThread.id;
        }
        // If we successfully reopened the existing NR thread, no column updates needed

      } else {
        // Story was originally created at M/E with no prior NR thread
        oldThreadId = story.story_thread_id;
        const { buildThreadTitle } = await import('./_storyStatus.js');
        newThread = await newFeedChannel.threads.create({
          name: await buildThreadTitle(connection, story),
          type: ChannelType.PublicThread,
          reason: `Story thread migrated to main channel`,
        });
        dbUpdates.story_thread_id = newThread.id;
        dbUpdates.restricted_thread_id = oldThreadId; // preserve old M thread for future NR→M
      }
    }

    const oldThreadLink = oldThreadId
      ? `https://discord.com/channels/${story.guild_id}/${oldThreadId}` : null;
    const newThreadLink = `https://discord.com/channels/${story.guild_id}/${newThread.id}`;

    const [txtOut, txtIn, lblRatingChanged] = await Promise.all([
      getConfigValue(connection, 'txtStoryThreadMigratedOut', story.guild_id),
      getConfigValue(connection, 'txtStoryThreadMigratedIn', story.guild_id),
      getConfigValue(connection, 'lblRatingChangeThreadWarning', story.guild_id),
    ]);
    const fieldName = replaceTemplateVariables(lblRatingChanged, { old_rating: oldRating, new_rating: newRating });

    // Post migration notice in old thread, then archive/lock it
    const oldThread = oldThreadId ? await guild.channels.fetch(oldThreadId).catch(() => null) : null;
    if (oldThread) {
      const outEmbed = new EmbedBuilder()
        .setColor(0xffa500)
        .addFields({ name: fieldName, value: replaceTemplateVariables(txtOut, { new_thread_link: newThreadLink }), inline: false });
      await oldThread.send({ embeds: [outEmbed] }).catch(() => {});
      await oldThread.setArchived(true).catch(() => {});
      await oldThread.setLocked(true).catch(() => {});
    }

    // Build continuation message embed — caller posts it after updateStoryStatusMessage for correct ordering
    const migratedInEmbed = new EmbedBuilder()
      .setColor(0xffa500)
      .addFields({ name: fieldName, value: replaceTemplateVariables(txtIn, { old_thread_link: oldThreadLink }), inline: false });

    // DB update — always clear status_message_id so a fresh embed is posted
    dbUpdates.status_message_id = null;
    const setClauses = Object.keys(dbUpdates).map(k => `${k} = ?`).join(', ');
    await connection.execute(
      `UPDATE story SET ${setClauses} WHERE story_id = ?`,
      [...Object.values(dbUpdates), storyId]
    );

    log(`Migrated story ${storyId} to ${newRating} (newThread: ${newThread.id})`, { show: true, guildName: guild?.name });
    return { success: true, newThreadId: newThread.id, migratedInEmbed };
  } catch (err) {
    log(`migrateStoryThread failed for story ${storyId}: ${err}`, { show: true, guildName: guild?.name });
    return { success: false, error: String(err) };
  }
}
