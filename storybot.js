import { EventEmitter } from 'events';
import { getConfigValue, formattedDate } from './utilities.js';
import { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { postStoryFeedCreationAnnouncement, postStoryFeedActivationAnnouncement  } from './announcements.js';

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
    console.log('StoryBot engine initialized');
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
 * CreateStory function with explicit transaction handling
 */
export async function CreateStory(connection, interaction, storyInput) {
  const guild_id = interaction.guild.id;
  const txn = await connection.getConnection();
  await txn.beginTransaction();

  try {

    // Step 1: Insert story record
    const storyStatus = (storyInput.delayHours || storyInput.delayWriters) ? 2 : 1; // 2 = paused, 1 = active

    const [storyResult] = await txn.execute(
      `INSERT INTO story (guild_id, title, story_status, quick_mode, turn_length_hours,
       timeout_reminder_percent, story_turn_privacy, show_authors, story_delay_hours, story_delay_users, story_order_type, max_writers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guild_id,
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
        storyInput.maxWriters ?? null
      ]
    );

    const storyId = storyResult.insertId;

    // Step 2: Create delay job if needed
    if (storyInput.delayHours) {
      const delayTime = new Date(Date.now() + (storyInput.delayHours * 60 * 60 * 1000));
      await txn.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, ?)`,
        ['checkStoryDelay', JSON.stringify({ storyId }), delayTime, 0]
      );
    }

    // Step 3: Get story feed channel and create story thread
    const storyFeedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guild_id);
    const channel = await interaction.guild.channels.fetch(storyFeedChannelId);

    if (!channel) {
      throw new Error('Story feed channel not found');
    }

    // Get thread title template and replace variables
    const threadTitleTemplate = await getConfigValue(connection,'txtStoryThreadTitle', guild_id);
    const statusText = storyStatus === 1
      ? await getConfigValue(connection,'txtActive', guild_id)
      : await getConfigValue(connection,'txtPaused', guild_id);

    const threadTitle = threadTitleTemplate
      .replace('[story_id]', storyId)
      .replace('[inputStoryTitle]', storyInput.storyTitle)
      .replace('[story_status]', statusText);

    const storyThread = await channel.threads.create({
      name: threadTitle,
      type: ChannelType.PublicThread,
      reason: `Story thread for story ID ${storyId}`
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
    await postStoryFeedCreationAnnouncement(connection, storyId, interaction, storyInput.storyTitle, storyStatus, storyInput.delayHours, storyInput.delayWriters);

    return {
      success: true,
      message: `✅ **Story "${storyInput.storyTitle}" created successfully!**\n${writerResult.confirmationMessage}`
    };

  } catch (error) {
    await txn.rollback();
    console.error(`${formattedDate()}:  CreateStory failed:`, error);

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
    
    const [writerResult] = await connection.execute(
      `INSERT INTO story_writer (story_id, discord_user_id, discord_display_name, AO3_name, turn_privacy, notification_prefs) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [storyId, userId, displayName, ao3Name, turnPrivacy, notificationPrefs]
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
    console.error(`${formattedDate()}:  StoryJoin failed:`, error);
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
    if (story.story_delay_users && story.story_status === 2) {
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
    if (story.story_delay_hours && story.story_status === 2) {
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
    console.error(`${formattedDate()}: checkStoryDelay failed for story ${storyId}:`, error);
    return { madeActive: false };
  }
}

/**
 * PickNextWriter function - selects next writer based on story order type
 */
export async function PickNextWriter(connection, storyId) {
  // Get the most recent turn to determine who just went
  // (turn is already ended by the time PickNextWriter is called, so don't filter by status)
  const [lastTurn] = await connection.execute(
    `SELECT sw.story_writer_id FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ?
     ORDER BY t.started_at DESC LIMIT 1`,
    [storyId]
  );
  const currentWriterId = lastTurn.length > 0 ? lastTurn[0].story_writer_id : null;
  
  // Get story order type
  const [storyData] = await connection.execute(
    `SELECT story_order_type FROM story WHERE story_id = ?`,
    [storyId]
  );
  const story_order_type = storyData[0]?.story_order_type;
  
  let orderClause;
  switch (story_order_type) {
    case 1: // Random
    default:
      orderClause = '';
      break;
    case 2: // Round-robin by join time
      orderClause = 'ORDER BY joined_at';
      break;
    case 3: // Fixed order
      orderClause = 'ORDER BY writer_order';
      break;
  }
  const [writers] = await connection.execute(
    `SELECT story_writer_id FROM story_writer 
     WHERE story_id = ? AND sw_status = 1 ${orderClause}`,
    [storyId]
  );
  if (!currentWriterId) {
    // No active turn - default to first writer
    return writers[0].story_writer_id;
  }

  // Random selection — exclude previous writer unless they're the only one
  if (story_order_type === 1) {
    const eligible = writers.filter(w => w.story_writer_id !== currentWriterId);
    const pool = eligible.length > 0 ? eligible : writers;
    return pool[Math.floor(Math.random() * pool.length)].story_writer_id;
  }

  // Sequential selection (same for both round-robin and fixed)
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
              s.quick_mode, s.turn_length_hours, s.story_thread_id, s.story_turn_privacy, s.title,
              s.timeout_reminder_percent, s.guild_id
       FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_writer_id = ?`,
      [storyWriterId]
    );
    
    if (writerInfo.length === 0) {
      throw new Error('Writer not found');
    }
    
    const writer = writerInfo[0];
    
    // Insert turn record
    const turnEndsAt = new Date(Date.now() + (writer.turn_length_hours * 60 * 60 * 1000));
    const [turnResult] = await connection.execute(
      `INSERT INTO turn (story_writer_id, started_at, turn_ends_at, turn_status) VALUES (?, NOW(), ?, 1)`,
      [storyWriterId, turnEndsAt]
    );
    
    const turnId = turnResult.insertId;

    // Schedule turnTimeout job
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
      ['turnTimeout', JSON.stringify({ turnId, storyId: writer.story_id, guildId: writer.guild_id }), turnEndsAt]
    );

    // Schedule turnReminder job if configured
    if (writer.timeout_reminder_percent > 0) {
      const reminderMs = writer.turn_length_hours * (writer.timeout_reminder_percent / 100) * 60 * 60 * 1000;
      const reminderTime = new Date(Date.now() + reminderMs);
      await connection.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
        ['turnReminder', JSON.stringify({ turnId, storyId: writer.story_id, guildId: writer.guild_id, writerUserId: writer.discord_user_id }), reminderTime]
      );
    }

    let threadId = null;
    let dmMessage = '';
    
    // Handle quick mode vs normal mode
    if (writer.quick_mode) {
      // Quick mode - send notifications and post feed announcement
      await handleQuickModeNotification(connection, interaction, writer, turnId, guild_id);
      dmMessage = 'Quick mode notification sent';
    } else {
      // Normal mode - create private thread
      const storyFeedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guild_id);
      const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
      
      // Get turn number
      const turnNumber = await getTurnNumber(connection, writer.story_id);
      
      // Get turn end time
      const turnEndTime = turnEndTimeFunction(turnId, writer.turn_length_hours);
      const formattedEndTime = turnEndTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      // Create thread title (plain date — Discord doesn't render timestamps in thread names)
      const threadTitleTemplate = await getConfigValue(connection,'txtTurnThreadTitle', guild_id);
      const threadTitle = threadTitleTemplate
        .replace('[story_id]', writer.story_id)
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
        // Private thread — add writer and all admins individually
        await thread.members.add(writer.discord_user_id);
        const adminRoleName = await getConfigValue(connection,'cfgAdminRoleName', guild_id);
        const adminRole = interaction.guild.roles.cache.find(r => r.name === adminRoleName);
        if (adminRole) {
          for (const member of adminRole.members.values()) {
            try { await thread.members.add(member.id); } catch {}
          }
        }
      }
      // Public threads are visible to all — no membership changes needed
      
      // Update turn with thread ID
      await connection.execute(
        `UPDATE turn SET thread_id = ? WHERE turn_id = ?`,
        [threadId, turnId]
      );
      
      // Post welcome message with buttons
      await postWelcomeMessage(connection, thread, writer, guild_id);
      
      // Send notification to writer
      await handleWriterNotification(connection, interaction, writer, threadId, guild_id);
      dmMessage = 'Normal mode thread created and notification sent';
    }
    
    return {
      success: true,
      turnId,
      threadId,
      dmMessage
    };
    
  } catch (error) {
    console.error(`${formattedDate()}:  NextTurn failed:`, error);
    return {
      success: false,
      error: 'Failed to create turn'
    };
  }
}

/**
 * Handle quick mode notification and feed announcement
 */
async function handleQuickModeNotification(connection, interaction, writer, turnId, guild_id) {
  const turnEndTime = turnEndTimeFunction(turnId, writer.turn_length_hours);
  const discordTimestamp = `<t:${Math.floor(turnEndTime.getTime() / 1000)}:F>`;
  
  // Send notification to writer
  await handleWriterNotification(connection, interaction, writer, writer.story_thread_id, guild_id);
  
  // Post feed announcement
  const txtQuickModeTurnStart = await getConfigValue(connection,'txtQuickModeTurnStart', guild_id);
  const feedMessage = txtQuickModeTurnStart
    .replace('[story_id]', writer.story_id)
    .replace('[story_title]', writer.title)
    .replace('[current_writer]', writer.discord_display_name)
    .replace('[turn_end_date]', discordTimestamp);
  
  const storyFeedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guild_id);
  const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
  await channel.send(feedMessage);
}

/**
 * Handle writer notification based on their preference
 */
async function handleWriterNotification(connection, interaction, writer, linkToThreadId, guild_id) {
  const linkToUse = linkToThreadId || writer.story_thread_id;
  
  // Check notification preference
  if (writer.notification_prefs === 'mention') {
    // User prefers mentions - send mention in channel
    const txtMentionTurnStart = await getConfigValue(connection,'txtMentionTurnStart', guild_id);
    const storyFeedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guild_id);
    const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
    
    await channel.send(`<@${writer.discord_user_id}> ${txtMentionTurnStart}\nThread: <#${linkToUse}>`);
  } else {
    // Default to DM with fallback to mention
    const txtDMTurnStart = await getConfigValue(connection,'txtDMTurnStart', guild_id);
    
    try {
      // Try to send DM
      const user = await interaction.client.users.fetch(writer.discord_user_id);
      await user.send(`${txtDMTurnStart}\nThread: <#${linkToUse}>`);
    } catch (dmError) {
      // DM failed, send mention in channel as fallback
      const txtMentionTurnStart = await getConfigValue(connection,'txtMentionTurnStart', guild_id);
      const storyFeedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guild_id);
      const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
      
      await channel.send(`<@${writer.discord_user_id}> ${txtMentionTurnStart}\nThread: <#${linkToUse}>`);
    }
  }
}

/**
 * Post welcome message with buttons to normal mode thread
 */
async function postWelcomeMessage(connection, thread, writer, guild_id) {
  const txtNormalModeWelcome = await getConfigValue(connection,'txtNormalModeWelcome', guild_id);
  const btnFinalizeEntry = await getConfigValue(connection,'btnFinalizeEntry', guild_id);
  const btnSkipTurn = await getConfigValue(connection,'btnSkipTurn', guild_id);
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`finalize_entry_${writer.story_id}`)
        .setLabel(btnFinalizeEntry)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`skip_turn_${writer.story_id}`)
        .setLabel(btnSkipTurn)
        .setStyle(ButtonStyle.Secondary)
    );
  
  await thread.send({
    content: txtNormalModeWelcome,
    components: [row]
  });
}

/**
 * Helper function to get turn number for a story
 */
async function getTurnNumber(connection, storyId) {
  const [result] = await connection.execute(
    `SELECT COUNT(*) as turn_number FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ?`,
    [storyId]
  );
  return result[0].turn_number;
}

/**
 * turnEndTime function - calculates when a turn ends
 */
export function turnEndTimeFunction(turnId, turnLengthHours) {
  // For now, calculate from current time + turn length
  // In a real implementation, you'd get the turn's started_at from database
  return new Date(Date.now() + (turnLengthHours * 60 * 60 * 1000));
}
