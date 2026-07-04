import { EventEmitter } from 'events';
import { getConfigValue, log } from './utilities.js';
import { ChannelType } from 'discord.js';
import { postStoryFeedCreationAnnouncement, postStoryFeedActivationAnnouncement } from './announcements.js';
import { resolveFeedChannelId, isRestricted } from './story/_metadata.js';
import { checkStoryDelay } from './story/_delay.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity } from './story/_turn.js';
import { updateStoryStatusMessage, buildThreadTitle } from './story/_storyStatus.js';

export { checkStoryDelay } from './story/_delay.js';
export { PickNextWriter, NextTurn, postStoryThreadActivity, deleteThreadAndAnnouncement, skipActiveTurn } from './story/_turn.js';
export { updateStoryStatusMessage } from './story/_storyStatus.js';
export { migrateStoryThread } from './story/_migration.js';

/**
 * StoryBot.js contains story engine logic and emits 'publish' events when it
 * wants something posted to Discord. index.js owns the Discord client and
 * listens for those events to perform posting. Announcements are handled
 * in announcements.js which is called from storybot.js and commands/story.js.
 */
export class StoryBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config || {};
  }

  async start() {
    // initialize schedulers, etc. (no Discord login here)
    log('Round Robin StoryBot engine initialized', { show: true });
  }

  async stop() {
    // stop internal timers/workers
  }

  /**
   * Compose a simple publish payload and emit it. Payload is a plain object
   * so the caller (index.js) can convert to discord.js EmbedBuilder.
   */
  emitPublish(channelID, { title, author, description, footer, content, files } = {}) {
    const embedData = { title, author, description, footer };
    this.emit('publish', { channelId: channelID, content: content || null, embeds: [embedData], files: files || [] });
  }
}

/**
 * Returns the currently active story thread ID.
 * story_thread_id is the permanent unrestricted thread (set at creation, never overwritten).
 * restricted_thread_id is the permanent restricted thread (set on first NR->M migration).
 * For restricted-rated stories that have a dedicated restricted thread, that is the active one.
 */
export function getActiveThreadId(story) {
  return (isRestricted(story.rating) && story.restricted_thread_id)
    ? story.restricted_thread_id
    : story.story_thread_id;
}

/**
 * CreateStory function with explicit transaction handling
 */
export async function CreateStory(connection, interaction, storyInput) {
  log(`CreateStory: entry title="${storyInput.storyTitle}"`, { show: false, guildName: interaction?.guild?.name });
  const guild_id = interaction.guild.id;
  const txn = await connection.getConnection();
  await txn.beginTransaction();

  try {

    // Step 1: Insert story record
    const storyStatus = (storyInput.delayHours > 0 || storyInput.delayWriters > 0) ? 4 : 1; // 4 = waiting (delayed), 1 = active

    // Calculate next guild-local story number
    const [[{ nextGuildStoryId }]] = await txn.execute(
      `SELECT COALESCE(MAX(guild_story_id), 0) + 1 AS nextGuildStoryId FROM story WHERE guild_id = ?`,
      [guild_id]
    );

    const [storyResult] = await txn.execute(
      `INSERT INTO story (guild_id, guild_story_id, title, story_status, mode, turn_length_hours,
       reminder_timing, story_turn_privacy, show_authors, story_delay_hours, story_delay_users, story_order_type, max_writers,
       rating, warnings, main_pairing, other_relationships, characters, dynamic, tags, scene_break_divider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guild_id,
        nextGuildStoryId,
        storyInput.storyTitle,
        storyStatus,
        storyInput.mode ?? 0,
        storyInput.turnLength,
        storyInput.timeoutReminder,
        storyInput.hideTurnThreads,
        storyInput.showAuthors,
        storyInput.delayHours,
        storyInput.delayWriters,
        storyInput.orderType,
        storyInput.maxWriters ?? null,
        storyInput.rating ?? 'NR',
        storyInput.warnings ?? null,
        storyInput.mainPairing ?? null,
        storyInput.otherRelationships ?? null,
        storyInput.characters ?? null,
        storyInput.dynamic ?? null,
        storyInput.tags ?? null,
        storyInput.sceneBreakDivider ?? null
      ]
    );

    const storyId = storyResult.insertId;
    const guildStoryId = nextGuildStoryId;

    // Step 2: Create delay job if needed
    if (storyInput.delayHours) {
      const delayTime = new Date(Date.now() + (storyInput.delayHours * 60 * 60 * 1000));
      await txn.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, ?)`,
        ['checkStoryDelay', JSON.stringify({ storyId }), delayTime, 0]
      );
    }

    // Step 3: Get story feed channel (restricted if M/E rated) and create story thread
    const storyFeedChannelId = await resolveFeedChannelId(connection, guild_id, storyInput.rating ?? 'NR');
    const channel = await interaction.guild.channels.fetch(storyFeedChannelId);

    if (!channel) {
      throw new Error('Story feed channel not found');
    }

    const threadTitle = await buildThreadTitle(connection, {
      guild_id,
      guild_story_id: guildStoryId,
      title: storyInput.storyTitle,
      story_status: storyStatus
    });

    const storyThread = await channel.threads.create({
      name: threadTitle,
      type: ChannelType.PublicThread,
      reason: `Story thread for story ID ${guildStoryId}`
    });

    // Step 4: Update story with thread ID
    await txn.execute(
      `UPDATE story SET story_thread_id = ? WHERE story_id = ?`,
      [storyThread.id, storyId]
    );

    // Step 5: Add creator as first writer
    const writerResult = await StoryJoin(txn, interaction, storyInput, storyId);

    if (!writerResult.success) {
      throw new Error(writerResult.error);
    }

    // Step 6: Start first turn if story is active (no delay)
    if (storyStatus === 1) {
      const firstWriterId = await PickNextWriter(txn, storyId);
      await NextTurn(txn, interaction, firstWriterId);
    }

    // Commit transaction
    await txn.commit();

    // Post story creation announcement after commit so writer count is visible
    await postStoryFeedCreationAnnouncement(connection, storyId, interaction);

    // Post initial status message (NextTurn already posted one if story is active;
    // this covers delayed stories where no turn has started yet)
    if (storyStatus !== 1) {
      updateStoryStatusMessage(connection, interaction.guild, storyId)
        .catch(err => log(`CreateStory: updateStoryStatusMessage failed for story ${storyId}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name }));
    }

    return {
      success: true,
      message: `✅ **Story "${storyInput.storyTitle}" created successfully!**\n${writerResult.confirmationMessage}`
    };

  } catch (error) {
    await txn.rollback();
    log(`CreateStory failed: ${error}`, { show: true, guildName: interaction?.guild?.name });

    const txtThreadCreationFailed = await getConfigValue(connection, 'txtThreadCreationFailed', interaction.guild.id);
    return {
      success: false,
      error: txtThreadCreationFailed
    };
  } finally {
    txn.release();
  }
}

/**
 * StoryJoin function - adds a writer to a story
 */
export async function StoryJoin(connection, interaction, storyInput, storyId) {
  log(`StoryJoin: entry storyId=${storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  try {
    const guild_id = interaction.guild.id;
    const userId = interaction.user.id;
    const displayName = interaction.member.displayName || interaction.user.displayName || interaction.user.username;
    const penName = storyInput.penName || displayName;

    // Check if user already joined this story
    const [existingWriter] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ?`,
      [storyId, userId]
    );

    if (existingWriter.length > 0) {
      const txtAlreadyJoined = await getConfigValue(connection, 'txtAlreadyJoined', guild_id);
      return {
        success: false,
        error: txtAlreadyJoined
      };
    }

    // Insert story_writer record
    const turnPrivacy = storyInput.writerTurnPrivacy !== undefined ? storyInput.writerTurnPrivacy : storyInput.keepPrivate;
    const notificationPrefs = storyInput.notificationPrefs || 'dm';

    // Assign writer_order = current active writer count + 1 so fixed order works correctly
    const [countResult] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1`,
      [storyId]
    );
    const writerOrder = countResult[0].count + 1;

    const [writerResult] = await connection.execute(
      `INSERT INTO story_writer (story_id, discord_user_id, discord_display_name, pen_name, turn_privacy, notification_prefs, writer_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [storyId, userId, displayName, penName, turnPrivacy, notificationPrefs, writerOrder]
    );

    const storyWriterId = writerResult.insertId;

    // Check story delay status
    const delayResult = await checkStoryDelay(connection, storyId);

    let confirmationMessage = '';
    let shouldStartTurn = false;

    if (delayResult.madeActive) {
      // Story became active, start turn
      shouldStartTurn = true;
      const txtStoryActive = await getConfigValue(connection, 'txtStoryActive', guild_id);
      confirmationMessage += `\n${txtStoryActive}`;

      // Post story activation announcement to feed channel
      const [storyInfo] = await connection.execute(`SELECT title FROM story WHERE story_id = ?`, [storyId]);
      if (storyInfo.length > 0) {
        await postStoryFeedActivationAnnouncement(connection, storyId, interaction, storyInfo[0].title);
      }
    } else if (delayResult.writerDelayMessage) {
      confirmationMessage += `\n${delayResult.writerDelayMessage}`;
    } else if (delayResult.hourDelayMessage) {
      confirmationMessage += `\n${delayResult.hourDelayMessage}`;
    }

    if (shouldStartTurn) {
      const turnResult = await NextTurn(connection, interaction, storyWriterId, true);
      if (turnResult.dmMessage) {
        confirmationMessage += `\n${turnResult.dmMessage}`;
      }
    }

    return {
      success: true,
      confirmationMessage,
      storyWriterId
    };

  } catch (error) {
    log(`StoryJoin failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    const txtStoryJoinFail = await getConfigValue(connection, 'txtStoryJoinFail', interaction.guild.id);
    return {
      success: false,
      error: txtStoryJoinFail
    };
  }
}
