import { EventEmitter } from 'events';
import { getConfigValue, getTurnNumber, log } from './utilities.js';
import { ChannelType, MessageType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { postStoryFeedCreationAnnouncement, postStoryFeedActivationAnnouncement  } from './announcements.js';
import { resolveFeedChannelId, isRestricted, ratingBadge } from './story/metadata.js';

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
      `INSERT INTO story (guild_id, guild_story_id, title, story_status, quick_mode, turn_length_hours,
       timeout_reminder_percent, story_turn_privacy, show_authors, story_delay_hours, story_delay_users, story_order_type, max_writers,
       rating, warnings, fandom, main_pairing, other_relationships, characters, dynamic, additional_tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guild_id,
        nextGuildStoryId,
        storyInput.storyTitle,
        storyStatus,
        storyInput.quickMode,
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
        storyInput.fandom ?? null,
        storyInput.mainPairing ?? null,
        storyInput.otherRelationships ?? null,
        storyInput.characters ?? null,
        storyInput.dynamic ?? null,
        storyInput.additionalTags ?? null
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

    // Get thread title template and replace variables
    const threadTitleTemplate = await getConfigValue(connection,'txtStoryThreadTitle', guild_id);
    const statusText = storyStatus === 1
      ? await getConfigValue(connection, 'txtActive', guild_id)
      : storyStatus === 4
        ? await getConfigValue(connection, 'txtDelayed', guild_id)
        : await getConfigValue(connection, 'txtPaused', guild_id);

    const threadTitle = threadTitleTemplate
      .replace('[story_id]', guildStoryId)
      .replace('[inputStoryTitle]', storyInput.storyTitle)
      .replace('[story_status]', statusText);

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
      updateStoryStatusMessage(connection, interaction.guild, storyId).catch(() => {});
    }

    // Post creator tip to story thread (fire-and-forget — lands after status embed and turn log)
    getConfigValue(connection, 'txtStoryThreadCreatorTip', guild_id).then(template => {
      const msg = template.replace('[story_id]', guildStoryId);
      return postStoryThreadActivity(connection, interaction.guild, storyId, msg);
    }).catch(() => {});

    return {
      success: true,
      message: `✅ **Story "${storyInput.storyTitle}" created successfully!**\n${writerResult.confirmationMessage}`
    };

  } catch (error) {
    await txn.rollback();
    log(`CreateStory failed: ${error}`, { show: true, guildName: interaction?.guild?.name });

    const txtThreadCreationFailed = await getConfigValue(connection,'txtThreadCreationFailed', interaction.guild.id);
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
  try {
    const guild_id = interaction.guild.id;
    const userId = interaction.user.id;
    const displayName = interaction.member.displayName || interaction.user.displayName || interaction.user.username;
    const ao3Name = storyInput.ao3Name || displayName;
    
    // Check if user already joined this story
    const [existingWriter] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ?`,
      [storyId, userId]
    );
    
    if (existingWriter.length > 0) {
      const txtAlreadyJoined = await getConfigValue(connection,'txtAlreadyJoined', guild_id);
      return {
        success: false,
        error: txtAlreadyJoined
      };
    }
    
    // Insert story_writer record
    const turnPrivacy = storyInput.turnPrivacy !== undefined ? storyInput.turnPrivacy : storyInput.keepPrivate;
    const notificationPrefs = storyInput.notificationPrefs || 'dm';

    // Assign writer_order = current active writer count + 1 so fixed order works correctly
    const [countResult] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1`,
      [storyId]
    );
    const writerOrder = countResult[0].count + 1;

    const [writerResult] = await connection.execute(
      `INSERT INTO story_writer (story_id, discord_user_id, discord_display_name, AO3_name, turn_privacy, notification_prefs, writer_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [storyId, userId, displayName, ao3Name, turnPrivacy, notificationPrefs, writerOrder]
    );
    
    const storyWriterId = writerResult.insertId;
    
    // Check story delay status
    const delayResult = await checkStoryDelay(connection, storyId);
    
    let confirmationMessage = '';
    let shouldStartTurn = false;
    
    if (delayResult.madeActive) {
      // Story became active, start turn
      shouldStartTurn = true;
      const txtStoryActive = await getConfigValue(connection,'txtStoryActive', guild_id);
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
      const turnResult = await NextTurn(connection, interaction, storyWriterId, true); // true = first turn announcement
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
    const txtStoryJoinFail = await getConfigValue(connection,'txtStoryJoinFail', interaction.guild.id);
    return {
      success: false,
      error: txtStoryJoinFail
    };
  }
}

/**
 * checkStoryDelay function - checks if story should be activated
 */
export async function checkStoryDelay(connection, storyId) {
  try {
    // Get story details
    const [storyRows] = await connection.execute(
      `SELECT story_status, story_delay_hours, story_delay_users, created_at, turn_length_hours, guild_id 
       FROM story WHERE story_id = ?`,
      [storyId]
    );
    
    if (storyRows.length === 0) {
      return { madeActive: false };
    }
    
    const story = storyRows[0];
    let shouldActivate = false;
    let writerDelayMessage = '';
    let hourDelayMessage = '';
    
    // Check writer count delay
    if (story.story_delay_users && story.story_status !== 1) {
      const [writerCount] = await connection.execute(
        `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1`,
        [storyId]
      );
      
      const currentWriters = writerCount[0].count;
      
      if (currentWriters >= story.story_delay_users) {
        shouldActivate = true;
      } else {
        const needed = story.story_delay_users - currentWriters;
        const txtMoreWritersDelay = await getConfigValue(connection,'txtMoreWritersDelay', story.guild_id);
        writerDelayMessage = txtMoreWritersDelay.replace('X', needed);
      }
    }
    
    // Check hour delay
    if (story.story_delay_hours && story.story_status !== 1) {
      const delayEndTime = new Date(story.created_at.getTime() + (story.story_delay_hours * 60 * 60 * 1000));
      
      if (Date.now() >= delayEndTime.getTime()) {
        shouldActivate = true;
      } else {
        const hoursLeft = Math.ceil((delayEndTime.getTime() - Date.now()) / (1000 * 60 * 60));
        const txtHoursDelay = await getConfigValue(connection,'txtHoursDelay', story.guild_id);
        hourDelayMessage = txtHoursDelay.replace('X', hoursLeft);
      }
    }
    
    // Activate story if conditions met
    if (shouldActivate && story.story_status === 2) {
      await connection.execute(
        `UPDATE story SET story_status = 1 WHERE story_id = ?`,
        [storyId]
      );
      
      // Pick next writer and start turn
      const nextWriterId = await PickNextWriter(connection, storyId);
      if (nextWriterId) {
        // This will be handled by the calling function
      }
      
      return { madeActive: true };
    }
    
    return {
      madeActive: false,
      writerDelayMessage,
      hourDelayMessage
    };
    
  } catch (error) {
    log(`checkStoryDelay failed for story ${storyId}: ${error}`, { show: true });
    return { madeActive: false };
  }
}

/**
 * PickNextWriter function - selects next writer based on story order type
 */
export async function PickNextWriter(connection, storyId) {
  // Check for admin-designated next writer override
  const [overrideRows] = await connection.execute(
    `SELECT next_writer_id FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (overrideRows[0]?.next_writer_id) {
    const overrideId = overrideRows[0].next_writer_id;
    await connection.execute(`UPDATE story SET next_writer_id = NULL WHERE story_id = ?`, [storyId]);
    return overrideId;
  }

  // Get the most recent turn to determine who just went
  // (turn is already ended by the time PickNextWriter is called, so don't filter by status)
  // Order by turn_id (auto-increment) rather than started_at for reliable sequencing
  const [lastTurn] = await connection.execute(
    `SELECT t.turn_id, sw.story_writer_id FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ?
     ORDER BY t.turn_id DESC LIMIT 1`,
    [storyId]
  );
  const currentWriterId = lastTurn.length > 0 ? lastTurn[0].story_writer_id : null;
  const currentTurnId = lastTurn.length > 0 ? lastTurn[0].turn_id : null;
  
  // Get story order type
  const [storyData] = await connection.execute(
    `SELECT story_order_type FROM story WHERE story_id = ?`,
    [storyId]
  );
  const story_order_type = storyData[0]?.story_order_type;
  
  if (story_order_type === 2) {
    // Round-robin: cycle-based selection.
    const [allWriters] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND sw_status = 1`,
      [storyId]
    );
    if (allWriters.length === 0) return null;
    if (!currentWriterId) return allWriters[0].story_writer_id;

    // Find the current writer's previous turn (the one before the turn that just ended)
    const [prevTurnRows] = await connection.execute(
      `SELECT turn_id FROM turn
       WHERE story_writer_id = ? AND turn_id < ?
       ORDER BY turn_id DESC LIMIT 1`,
      [currentWriterId, currentTurnId]
    );
    const prevTurnId = prevTurnRows[0]?.turn_id ?? 0;

    // Find writers who have already gone this cycle (turns between prevTurnId and currentTurnId)
    const [alreadyGoneRows] = await connection.execute(
      `SELECT DISTINCT t.story_writer_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_id > ? AND t.turn_id < ?`,
      [storyId, prevTurnId, currentTurnId]
    );
    const alreadyGone = new Set(alreadyGoneRows.map(r => r.story_writer_id));

    // Pool: active writers not yet gone this cycle, excluding the current writer
    let pool = allWriters.filter(w => !alreadyGone.has(w.story_writer_id) && w.story_writer_id !== currentWriterId);

    // Full cycle complete — reset, everyone except current writer is eligible
    if (pool.length === 0) {
      pool = allWriters.filter(w => w.story_writer_id !== currentWriterId);
    }

    // Solo story — allow current writer to repeat
    if (pool.length === 0) {
      pool = allWriters;
    }

    return pool[Math.floor(Math.random() * pool.length)].story_writer_id;
  }

  const orderClause = story_order_type === 3 ? 'ORDER BY writer_order' : '';
  const [writers] = await connection.execute(
    `SELECT story_writer_id FROM story_writer
     WHERE story_id = ? AND sw_status = 1 ${orderClause}`,
    [storyId]
  );
  if (writers.length === 0) return null;
  if (!currentWriterId) {
    return writers[0].story_writer_id;
  }

  // Random (type 1) — exclude previous writer unless they're the only one
  if (story_order_type === 1) {
    const eligible = writers.filter(w => w.story_writer_id !== currentWriterId);
    const pool = eligible.length > 0 ? eligible : writers;
    return pool[Math.floor(Math.random() * pool.length)].story_writer_id;
  }

  // Fixed order (type 3) — strict sequential rotation by writer_order
  const currentIndex = writers.findIndex(w => w.story_writer_id === currentWriterId);
  const nextIndex = (currentIndex + 1) % writers.length;
  return writers[nextIndex].story_writer_id;
}

/**
 * NextTurn function - creates a new turn for a story
 */
export async function NextTurn(connection, interaction, storyWriterId) {
  const guild_id = interaction.guild.id;
  try {
    
    // Get story and writer info
    const [writerInfo] = await connection.execute(
      `SELECT sw.story_id, sw.discord_user_id, sw.discord_display_name, sw.turn_privacy, sw.notification_prefs,
              s.quick_mode, s.turn_length_hours, s.story_thread_id, s.restricted_thread_id, s.story_turn_privacy, s.title,
              s.timeout_reminder_percent, s.guild_id, s.guild_story_id, s.show_authors, s.rating
       FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_writer_id = ?`,
      [storyWriterId]
    );
    
    if (writerInfo.length === 0) {
      throw new Error('Writer not found');
    }
    
    const writer = writerInfo[0];

    // Cancel any pending jobs for the story's current active turn before starting the next one
    const [activeTurnRows] = await connection.execute(
      `SELECT turn_id FROM turn WHERE story_writer_id IN (
         SELECT story_writer_id FROM story_writer WHERE story_id = ?
       ) AND turn_status = 1 LIMIT 1`,
      [writer.story_id]
    );
    if (activeTurnRows.length > 0) {
      await connection.execute(
        `UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`,
        [activeTurnRows[0].turn_id]
      );
    }

    // Insert turn record
    const turnEndsAt = new Date(Date.now() + (writer.turn_length_hours * 60 * 60 * 1000));
    const [turnResult] = await connection.execute(
      `INSERT INTO turn (story_writer_id, started_at, turn_ends_at, turn_status) VALUES (?, NOW(), ?, 1)`,
      [storyWriterId, turnEndsAt]
    );
    
    const turnId = turnResult.insertId;

    // Schedule turnTimeout job
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
      ['turnTimeout', JSON.stringify({ turnId, storyId: writer.story_id, guildId: writer.guild_id }), turnEndsAt, turnId]
    );

    // Schedule turnReminder job if configured
    if (writer.timeout_reminder_percent > 0) {
      const reminderMs = writer.turn_length_hours * (writer.timeout_reminder_percent / 100) * 60 * 60 * 1000;
      const reminderTime = new Date(Date.now() + reminderMs);
      await connection.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
        ['turnReminder', JSON.stringify({ turnId, storyId: writer.story_id, guildId: writer.guild_id, writerUserId: writer.discord_user_id }), reminderTime, turnId]
      );
    }

    let threadId = null;
    let dmMessage = '';

    // Compute turn number and end time here — used by both modes for activity log and thread title
    const turnNumber = await getTurnNumber(connection, writer.story_id);
    const turnEndTime = turnEndTimeFunction(writer.turn_length_hours);

    // Handle quick mode vs normal mode
    if (writer.quick_mode) {
      // Quick mode - send notifications and post feed announcement
      await handleQuickModeNotification(connection, interaction, writer, guild_id);
      dmMessage = 'Quick mode notification sent';
    } else {
      // Normal mode - create private thread on the correct feed channel (restricted if M/E)
      const storyFeedChannelId = await resolveFeedChannelId(connection, guild_id, writer.rating ?? 'NR');
      const channel = await interaction.guild.channels.fetch(storyFeedChannelId);

      const formattedEndTime = turnEndTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      // Create thread title (plain date — Discord doesn't render timestamps in thread names)
      const threadTitleTemplate = await getConfigValue(connection,'txtTurnThreadTitle', guild_id);
      const threadTitle = threadTitleTemplate
        .replace('[story_id]', writer.guild_story_id)
        .replace('[storyTurnNumber]', turnNumber)
        .replace('[user display name]', writer.discord_display_name)
        .replace('[turnEndTime]', formattedEndTime);
      
      // Determine privacy: story-level privacy overrides writer preference
      const isPrivateThread = writer.story_turn_privacy || writer.turn_privacy;
      
      // Create thread based on privacy setting
      const thread = await channel.threads.create({
        name: threadTitle,
        type: isPrivateThread ? ChannelType.PrivateThread : ChannelType.PublicThread,
        reason: `Turn thread for story ${writer.story_id}`
      });
      
      threadId = thread.id;
      
      // Set thread membership
      if (isPrivateThread) {
        // Private thread — add writer only.
        // Admin role members have Manage Threads on the feed channel and can see all threads.
        await thread.members.add(writer.discord_user_id);
      }
      // Public threads are visible to all — no membership changes needed
      
      // Update turn with thread ID
      await connection.execute(
        `UPDATE turn SET thread_id = ? WHERE turn_id = ?`,
        [threadId, turnId]
      );
      
      // Post welcome message with buttons
      await postWelcomeMessage(connection, thread, writer, guild_id, turnEndTime);
      
      // Send notification to writer
      await handleWriterNotification(connection, interaction, writer, threadId, guild_id);
      dmMessage = 'Normal mode thread created and notification sent';
    }
    
    // Update status embed first, then post activity log — order matters in the story thread
    const unixTs = Math.floor(turnEndTime.getTime() / 1000);
    updateStoryStatusMessage(connection, interaction.guild, writer.story_id)
      .then(() => getConfigValue(connection, 'txtStoryThreadTurnStart', guild_id))
      .then(template => {
        const msg = template
          .replace('[turn_number]', turnNumber)
          .replace('[writer_name]', writer.discord_display_name)
          .replace('[turn_end_full]', `<t:${unixTs}:F>`)
          .replace('[turn_end_relative]', `<t:${unixTs}:R>`);
        return postStoryThreadActivity(connection, interaction.guild, writer.story_id, msg);
      })
      .catch(() => {});

    return {
      success: true,
      turnId,
      threadId,
      dmMessage
    };

  } catch (error) {
    log(`NextTurn failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    return {
      success: false,
      error: 'Failed to create turn'
    };
  }
}

/**
 * Handle quick mode notification and feed announcement
 */
async function handleQuickModeNotification(connection, interaction, writer, guild_id) {
  const turnEndTime = turnEndTimeFunction(writer.turn_length_hours);
  const discordTimestamp = `<t:${Math.floor(turnEndTime.getTime() / 1000)}:F>`;
  
  // Send notification to writer using the active story thread as the link
  await handleWriterNotification(connection, interaction, writer, getActiveThreadId(writer), guild_id);
  
  // Post feed announcement to the appropriate channel (restricted if M/E rated)
  const txtQuickModeTurnStart = await getConfigValue(connection,'txtQuickModeTurnStart', guild_id);
  const feedMessage = txtQuickModeTurnStart
    .replace('[story_id]', writer.guild_story_id)
    .replace('[story_title]', writer.title)
    .replace('[current_writer]', writer.discord_display_name)
    .replace('[turn_end_date]', discordTimestamp);

  const storyFeedChannelId = await resolveFeedChannelId(connection, guild_id, writer.rating ?? 'NR');
  const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
  await channel.send(feedMessage);
}

/**
 * Handle writer notification based on their preference
 */
async function handleWriterNotification(connection, interaction, writer, linkToThreadId, guild_id) {
  const linkToUse = linkToThreadId || writer.story_thread_id;
  const threadUrl = `https://discord.com/channels/${guild_id}/${linkToUse}`;
  const modeKey = writer.quick_mode ? 'Quick' : 'Normal';

  function applyTokens(text) {
    return text
      .replace(/\[turn_thread_link\]/g, threadUrl)
      .replace(/\[story_title\]/g, writer.title);
  }

  if (writer.notification_prefs === 'mention') {
    const txtKey = `txtMentionTurnStart${modeKey}`;
    const txt = applyTokens(await getConfigValue(connection, txtKey, guild_id));
    const feedChannelId = await resolveFeedChannelId(connection, guild_id, writer.rating ?? 'NR');
    const channel = await interaction.guild.channels.fetch(feedChannelId);
    await channel.send(`<@${writer.discord_user_id}> ${txt}`);
  } else {
    const dmKey = `txtDMTurnStart${modeKey}`;
    const txt = applyTokens(await getConfigValue(connection, dmKey, guild_id));
    try {
      const user = await interaction.client.users.fetch(writer.discord_user_id);
      await user.send(txt);
    } catch (dmError) {
      // DM failed — fall back to mention in feed channel
      const mentionKey = `txtMentionTurnStart${modeKey}`;
      const mentionTxt = applyTokens(await getConfigValue(connection, mentionKey, guild_id));
      const feedChannelId = await resolveFeedChannelId(connection, guild_id, writer.rating ?? 'NR');
      const channel = await interaction.guild.channels.fetch(feedChannelId);
      await channel.send(`<@${writer.discord_user_id}> ${mentionTxt}`);
    }
  }
}

/**
 * Post welcome message with buttons to normal mode thread
 */
async function postWelcomeMessage(connection, thread, writer, guild_id, turnEndTime) {
  const mediaChannelId = await getConfigValue(connection, 'cfgMediaChannelId', guild_id);
  const mediaConfigured = mediaChannelId && mediaChannelId !== 'cfgMediaChannelId';
  const welcomeKey = mediaConfigured ? 'txtNormalModeWelcome' : 'txtNormalModeWelcomeNoMedia';

  const cfgKeys = [welcomeKey, 'btnFinalizeEntry', 'btnSkipTurn', 'btnViewLastEntry'];
  const cfg = await getConfigValue(connection, cfgKeys, guild_id);

  const unixTs = Math.floor(turnEndTime.getTime() / 1000);
  const welcomeContent = cfg[welcomeKey]
    .replace('[story_title]', writer.title)
    .replace('[turn_end_full]', `<t:${unixTs}:F>`)
    .replace('[turn_end_relative]', `<t:${unixTs}:R>`)
    .replace('[story_id]', writer.guild_story_id);

  // Check whether there is a previous confirmed entry to offer
  const [lastEntryRows] = await connection.execute(
    `SELECT se.content, sw.discord_display_name
     FROM story_entry se
     JOIN turn t ON se.turn_id = t.turn_id
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
     ORDER BY t.started_at DESC LIMIT 1`,
    [writer.story_id]
  );
  const hasPreviousEntry = lastEntryRows.length > 0;

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`finalize_entry_${writer.story_id}`)
      .setLabel(cfg.btnFinalizeEntry)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`skip_turn_${writer.story_id}`)
      .setLabel(cfg.btnSkipTurn)
      .setStyle(ButtonStyle.Secondary),
  ];

  if (hasPreviousEntry) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`view_last_entry_${writer.story_id}`)
        .setLabel(cfg.btnViewLastEntry)
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const row = new ActionRowBuilder().addComponents(buttons);

  await thread.send({
    content: welcomeContent,
    components: [row]
  });

  if (mediaConfigured) {
    const imageHelpText = await getConfigValue(connection, 'txtNormalModeImageHelp', guild_id);
    await thread.send(imageHelpText);
  }
}


/**
 * Post a short activity message to the story's active thread. Safe to fire-and-forget.
 */
export async function postStoryThreadActivity(connection, guild, storyId, message) {
  try {
    const [rows] = await connection.execute(
      `SELECT story_thread_id, restricted_thread_id, rating FROM story WHERE story_id = ?`, [storyId]
    );
    if (!rows[0]) return;
    const activeThreadId = getActiveThreadId(rows[0]);
    if (!activeThreadId) return;
    const thread = await guild.channels.fetch(activeThreadId).catch(() => null);
    if (thread) await thread.send(message);
  } catch (err) {
    log(`Could not post activity to story thread ${storyId}: ${err}`, { show: true, guildName: guild?.name });
  }
}

/**
 * Build and post (or update) the persistent status embed in the story's active thread.
 * Stores the message ID in story.status_message_id so it can be edited in place.
 * If the message has been deleted, a new one is posted automatically.
 */
export async function updateStoryStatusMessage(connection, guild, storyId) {
  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, quick_mode, turn_length_hours,
              timeout_reminder_percent, max_writers, allow_joins, show_authors,
              story_order_type, summary, tags, story_thread_id, restricted_thread_id, status_message_id, guild_id,
              next_writer_id, closed_at, rating, warnings, fandom, main_pairing,
              other_relationships, characters, dynamic, additional_tags
       FROM story WHERE story_id = ?`,
      [storyId]
    );
    if (storyRows.length === 0 || !getActiveThreadId(storyRows[0])) return;
    const story = storyRows[0];

    const [writers] = await connection.execute(
      `SELECT story_writer_id, discord_display_name, AO3_name, sw_status, writer_order
       FROM story_writer WHERE story_id = ? ORDER BY joined_at ASC`,
      [storyId]
    );

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_ends_at, t.story_writer_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    const activeTurn = activeTurnRows[0] ?? null;

    // Entry stats — count confirmed entries, words, and inline images
    const [confirmedEntries] = await connection.execute(
      `SELECT se.content FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed'`,
      [storyId]
    );
    const entryCount = confirmedEntries.length;
    const cdnImageRegex = /https:\/\/cdn\.discordapp\.com\/attachments\/[^\s<"]+/g;
    let wordCount = 0;
    let imageCount = 0;
    for (const e of confirmedEntries) {
      const images = e.content.match(cdnImageRegex) ?? [];
      imageCount += images.length;
      // Strip image URLs before counting words so they don't inflate the count
      const textOnly = e.content.replace(cdnImageRegex, '').trim();
      wordCount += textOnly.split(/\s+/).filter(w => w.length > 0).length;
    }

    const ratingBadgeCfgKey = ratingBadge[story.rating] ?? 'txtRatingBadgeNR';
    const { warningOptions } = await import('./story/metadata.js');
    const cfg = await getConfigValue(connection, [
      'txtActive', 'txtPaused', 'txtClosed',
      'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      ratingBadgeCfgKey,
      ...warningOptions,
    ], story.guild_id);
    const txtActive = cfg.txtActive;
    const txtPaused = cfg.txtPaused;
    const txtClosed = cfg.txtClosed;
    const txtOrderRandom = cfg.txtOrderRandom;
    const txtOrderRoundRobin = cfg.txtOrderRoundRobin;
    const txtOrderFixed = cfg.txtOrderFixed;
    const ratingBadgeDisplay = cfg[ratingBadgeCfgKey];

    const statusMap = { 1: `▶️ ${txtActive}`, 2: `⏸️ ${txtPaused}`, 3: `🔒 ${txtClosed}` };
    const orderMap = { 1: `🎲 ${txtOrderRandom}`, 2: `🔄 ${txtOrderRoundRobin}`, 3: `📋 ${txtOrderFixed}` };
    const colorMap = { 1: 0x57f287, 2: 0xfee75c, 3: 0xed4245 };

    const activeWriters = writers.filter(w => w.sw_status === 1);
    const pausedWriters = writers.filter(w => w.sw_status === 2);
    const leftWriters   = writers.filter(w => w.sw_status === 0);

    // Creator = first writer to join (first in joined_at ASC order among active writers)
    const creatorId = activeWriters[0]?.story_writer_id ?? null;

    const legendParts = ['⭐ Creator', '✍️ Current turn', '📌 Next up'];
    if (pausedWriters.length > 0) legendParts.push('⏸️ Paused');

    const writerLines = [
      ...activeWriters.map(w => {
        const isCurrent = activeTurn?.story_writer_id === w.story_writer_id;
        const isCreator = w.story_writer_id === creatorId;
        const isPinnedNext = story.next_writer_id && w.story_writer_id === story.next_writer_id;
        const ao3 = w.AO3_name && w.AO3_name !== w.discord_display_name ? ` (${w.AO3_name})` : '';
        const emojis = [isCreator ? '⭐' : '', isCurrent ? '✍️' : '', isPinnedNext ? '📌' : ''].filter(Boolean).join('');
        const prefix = emojis ? `${emojis} ` : '';
        return `${prefix}**${w.discord_display_name}**${ao3}`;
      }),
      ...pausedWriters.map(w => {
        const ao3 = w.AO3_name && w.AO3_name !== w.discord_display_name ? ` (${w.AO3_name})` : '';
        return `⏸️ ${w.discord_display_name}${ao3}`;
      }),
      ...leftWriters.map(w => `*${w.discord_display_name}*`),
      '',
      `*${legendParts.join('  ·  ')}*`
    ];

    let turnValue;
    if (activeTurn) {
      const endTimestamp = `<t:${Math.floor(new Date(activeTurn.turn_ends_at).getTime() / 1000)}:R>`;
      turnValue = `**${activeTurn.discord_display_name}** — ends ${endTimestamp}`;
    } else {
      turnValue = story.story_status === 1 ? 'No active turn' : '—';
    }

    // Next writer — only deterministic for Fixed order; Random and Round Robin are selected at turn change
    let nextWriterValue = '—';
    if (story.story_status === 1) {
      if (story.next_writer_id) {
        // Manually pinned via /storyadmin next
        const nw = writers.find(w => w.story_writer_id === story.next_writer_id);
        nextWriterValue = nw ? `📌 **${nw.discord_display_name}** *(manually set)*` : '📌 *(manually set)*';
      } else if (story.story_order_type === 3 && activeTurn) {
        // Fixed order — deterministic, safe to predict
        const sorted = [...activeWriters].sort((a, b) => (a.writer_order ?? 999) - (b.writer_order ?? 999));
        const currentIdx = sorted.findIndex(w => w.story_writer_id === activeTurn.story_writer_id);
        if (currentIdx >= 0) {
          const nextWriter = sorted[(currentIdx + 1) % sorted.length];
          nextWriterValue = `**${nextWriter.discord_display_name}** *(next in order)*`;
        }
      } else if (story.story_order_type === 2) {
        nextWriterValue = '*Round Robin selection*';
      } else {
        nextWriterValue = '*Random selection*';
      }
    }

    const reminderText = story.timeout_reminder_percent > 0
      ? ` · reminder at ${story.timeout_reminder_percent}%` : '';

    const imagePart = imageCount > 0 ? ` · ${imageCount} ${imageCount === 1 ? 'image' : 'images'}` : '';
    const statsValue = entryCount > 0
      ? `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} · ~${wordCount.toLocaleString()} words${imagePart}`
      : 'No entries yet';

    const { formatWarnings } = await import('./story/metadata.js');
    const warningLabels = Object.fromEntries(warningOptions.map(k => [k, cfg[k] ?? k]));
    const warningsDisplay = story.warnings ? formatWarnings(story.warnings, warningLabels) : null;

    const metadataFields = [];
    if (story.rating && story.rating !== 'NR') {
      metadataFields.push({ name: 'Rating', value: `${ratingBadgeDisplay} ${story.rating}`, inline: true });
    }
    if (story.fandom)        metadataFields.push({ name: 'Fandom', value: story.fandom, inline: true });
    if (story.main_pairing)  metadataFields.push({ name: 'Main Pairing', value: story.main_pairing, inline: true });
    if (warningsDisplay)     metadataFields.push({ name: 'Warnings', value: warningsDisplay, inline: false });
    if (story.characters)    metadataFields.push({ name: 'Characters', value: story.characters.length > 200 ? story.characters.slice(0, 197) + '...' : story.characters, inline: false });
    if (story.additional_tags) metadataFields.push({ name: 'Additional Tags', value: story.additional_tags.length > 500 ? story.additional_tags.slice(0, 497) + '...' : story.additional_tags, inline: false });

    const embed = new EmbedBuilder()
      .setTitle(`📚 ${story.title} (#${story.guild_story_id}) ${ratingBadgeDisplay}`)
      .setColor(colorMap[story.story_status] ?? 0x5865f2)
      .addFields(
        ...(story.tags ? [{ name: 'Tags', value: story.tags, inline: false }] : []),
        { name: 'Status', value: statusMap[story.story_status] ?? '—', inline: true },
        { name: 'Mode', value: story.quick_mode ? 'Quick' : 'Normal', inline: true },
        { name: 'Writer Order', value: orderMap[story.story_order_type] ?? '—', inline: true },
        { name: 'Turn Length', value: `${story.turn_length_hours}h${reminderText}`, inline: true },
        { name: 'Writers', value: `${activeWriters.length}/${story.max_writers || '∞'} · ${story.allow_joins && !(story.max_writers && activeWriters.length >= story.max_writers) ? 'Open' : 'Closed'}`, inline: true },
        { name: 'Show Authors', value: story.show_authors ? 'Yes' : 'No', inline: true },
        { name: 'Current Turn', value: turnValue, inline: true },
        { name: 'Next Writer', value: nextWriterValue, inline: true },
        { name: 'Entries', value: statsValue, inline: true },
        ...metadataFields,
        { name: 'Writer List', value: writerLines.join('\n') || 'None', inline: false }
      )
      .setTimestamp();

    if (story.summary) embed.setDescription(story.summary);
    if (story.story_status === 3 && story.closed_at) {
      const closedTimestamp = `<t:${Math.floor(new Date(story.closed_at).getTime() / 1000)}:D>`;
      embed.addFields({ name: 'Closed', value: closedTimestamp, inline: true });
    }

    const activeThreadId = getActiveThreadId(story);
    const storyThread = await guild.channels.fetch(activeThreadId).catch(() => null);
    if (!storyThread) return;

    // Keep story thread title in sync with current status
    try {
      const titleTemplate = await getConfigValue(connection, 'txtStoryThreadTitle', story.guild_id);
      const statusLabel = { 1: txtActive, 2: txtPaused, 3: txtClosed }[story.story_status] ?? txtActive;
      const expectedTitle = titleTemplate
        .replace('[story_id]', story.guild_story_id)
        .replace('[inputStoryTitle]', story.title)
        .replace('[story_status]', statusLabel);
      if (storyThread.name !== expectedTitle) {
        await storyThread.setName(expectedTitle).catch(() => {});
      }
    } catch {}

    // Add Join button if story is open for new writers
    const isJoinable = story.story_status !== 3
      && story.allow_joins
      && (!story.max_writers || activeWriters.length < story.max_writers);

    const components = [];
    const actionRow = new ActionRowBuilder();
    let hasActionButtons = false;

    if (isJoinable) {
      const btnJoinStory = await getConfigValue(connection, 'btnJoinStory', story.guild_id);
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`story_join_${storyId}`)
          .setLabel(btnJoinStory)
          .setStyle(ButtonStyle.Primary)
      );
      hasActionButtons = true;
    }

    // Add "Suggest a Tag" button for active stories
    if (story.story_status === 1) {
      const btnSubmitTag = await getConfigValue(connection, 'btnSubmitTag', story.guild_id);
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`story_submit_tag_${storyId}`)
          .setLabel(btnSubmitTag)
          .setStyle(ButtonStyle.Secondary)
      );
      hasActionButtons = true;
    }

    if (hasActionButtons) components.push(actionRow);

    let message = null;
    if (story.status_message_id) {
      message = await storyThread.messages.fetch(story.status_message_id).catch(() => null);
    }

    if (message) {
      await message.edit({ embeds: [embed], components });
    } else {
      const newMsg = await storyThread.send({ embeds: [embed], components });
      await newMsg.pin().catch(err => log(`Failed to pin status message in story thread ${storyId}: ${err.message}`, { show: true, guildName: guild?.name }));
      await connection.execute(
        `UPDATE story SET status_message_id = ? WHERE story_id = ?`,
        [newMsg.id, storyId]
      );
      // Post creator tip immediately after the first status embed so it's always message #2
      const creatorTip = await getConfigValue(connection, 'txtStoryThreadCreatorTip', story.guild_id).catch(() => null);
      if (creatorTip) {
        const tipMsg = creatorTip.replace('[story_id]', story.guild_story_id);
        await storyThread.send(tipMsg).catch(() => {});
      }
    }
  } catch (err) {
    log(`Failed to update story status message for story ${storyId}: ${err}`, { show: true, guildName: guild?.name });
  }
}

/**
 * Delete a turn/story thread and also remove the "started a thread" system
 * message Discord posts in the parent channel when the thread was created.
 * Safe to await directly — errors from the announcement deletion are swallowed
 * so the thread deletion always proceeds.
 */
export async function deleteThreadAndAnnouncement(thread) {
  try {
    const parent = thread.parent ?? await thread.guild.channels.fetch(thread.parentId).catch(() => null);
    if (parent) {
      const messages = await parent.messages.fetch({ around: thread.id, limit: 5 }).catch(() => null);
      if (messages) {
        const announcement = messages.find(m => m.type === MessageType.ThreadCreated && m.thread?.id === thread.id);
        if (announcement) await announcement.delete().catch(() => {});
      }
    }
  } catch {} // never block thread deletion
  await thread.delete();
}

/**
 * skipActiveTurn — ends a turn as a skip, cancels its pending jobs, and deletes its thread.
 * Shared by handleSkip and handleReassign so the skip logic lives in one place.
 */
export async function skipActiveTurn(connection, guild, turnId, threadId) {
  await connection.execute(
    `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
    [turnId]
  );
  await connection.execute(
    `UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`,
    [turnId]
  );
  if (threadId) {
    try {
      const thread = await guild.channels.fetch(threadId);
      if (thread) await deleteThreadAndAnnouncement(thread);
    } catch (err) {
      log(`Could not delete turn thread on skip: ${err}`, { show: true, guildName: guild?.name });
    }
  }
}

/**
 * turnEndTime function - calculates when a turn ends
 */
export function turnEndTimeFunction(turnLengthHours) {
  return new Date(Date.now() + (turnLengthHours * 60 * 60 * 1000));
}

/**
 * Build thread title string from config templates.
 */
async function buildThreadTitle(connection, story) {
  const [txtActive, txtPaused, txtClosed, titleTemplate] = await Promise.all([
    getConfigValue(connection, 'txtActive', story.guild_id),
    getConfigValue(connection, 'txtPaused', story.guild_id),
    getConfigValue(connection, 'txtClosed', story.guild_id),
    getConfigValue(connection, 'txtStoryThreadTitle', story.guild_id),
  ]);
  const statusLabel = { 1: txtActive, 2: txtPaused, 3: txtClosed }[story.story_status] ?? txtActive;
  return titleTemplate
    .replace('[story_id]', story.guild_story_id)
    .replace('[inputStoryTitle]', story.title)
    .replace('[story_status]', statusLabel);
}

/**
 * Migrate a story's thread when its rating crosses the M/E barrier.
 *
 * Two permanent thread IDs are stored in the DB:
 *   story_thread_id     — the unrestricted (main) feed channel thread; never changed after creation
 *   restricted_thread_id — the M/E restricted feed channel thread; set on first NR→M migration
 *
 * The "active" thread is whichever one matches the current rating (see getActiveThreadId).
 * Migration posts a cross-link message in the old thread, archives/locks it, posts a
 * continuation message in the new thread, and updates the DB accordingly.
 *
 * Returns { success, newThreadId } or { success: false, error }.
 */
export async function migrateStoryThread(connection, guild, storyId, newRating) {
  try {
    const [rows] = await connection.execute(
      `SELECT guild_story_id, title, story_status, story_thread_id, restricted_thread_id, guild_id
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

    // Post migration notice in old thread, then archive/lock it
    const oldThread = oldThreadId ? await guild.channels.fetch(oldThreadId).catch(() => null) : null;
    if (oldThread) {
      const txtOut = await getConfigValue(connection, 'txtStoryThreadMigratedOut', story.guild_id);
      const outMsg = (txtOut ?? 'This story has moved. Continue reading here: [new_thread_link]')
        .replace('[new_thread_link]', newThreadLink);
      await oldThread.send(outMsg).catch(() => {});
      await oldThread.setArchived(true).catch(() => {});
      await oldThread.setLocked(true).catch(() => {});
    }

    // Post continuation message in new/reopened thread
    const txtIn = await getConfigValue(connection, 'txtStoryThreadMigratedIn', story.guild_id);
    const inMsg = (txtIn ?? 'This story continues from a previous thread: [old_thread_link]')
      .replace('[old_thread_link]', oldThreadLink ?? 'a previous thread');
    await newThread.send(inMsg).catch(() => {});

    // DB update — always clear status_message_id so a fresh embed is posted
    dbUpdates.status_message_id = null;
    const setClauses = Object.keys(dbUpdates).map(k => `${k} = ?`).join(', ');
    await connection.execute(
      `UPDATE story SET ${setClauses} WHERE story_id = ?`,
      [...Object.values(dbUpdates), storyId]
    );

    log(`Migrated story ${storyId} to ${newRating} (newThread: ${newThread.id})`, { show: true, guildName: guild?.name });
    return { success: true, newThreadId: newThread.id };
  } catch (err) {
    log(`migrateStoryThread failed for story ${storyId}: ${err}`, { show: true, guildName: guild?.name });
    return { success: false, error: String(err) };
  }
}
