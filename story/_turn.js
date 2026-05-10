import { ChannelType, MessageType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfigValue, getTurnNumber, log } from '../utilities.js';
import { resolveFeedChannelId } from './_metadata.js';
import { getActiveThreadId } from '../storybot.js';
import { updateStoryStatusMessage } from './_storyStatus.js';

/**
 * Selects the next writer based on story order type.
 * Called from NextTurn and job-runner (delay activation path).
 */
export async function PickNextWriter(connection, storyId) {
  log(`PickNextWriter: entry storyId=${storyId}`, { show: false });
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

    // Find the writer who went most recently before the current writer's last cycle
    const [prevCycleRows] = await connection.execute(
      `SELECT sw.story_writer_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.sw_status = 1 AND t.turn_id < ? AND t.turn_id > ?
       ORDER BY t.turn_id DESC LIMIT 1`,
      [storyId, currentTurnId, prevTurnId]
    );

    // Build writer list in join order
    const [orderedWriters] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY joined_at ASC`,
      [storyId]
    );

    if (prevCycleRows.length === 0) {
      // No previous cycle data — start from beginning
      const currentIdx = orderedWriters.findIndex(w => w.story_writer_id === currentWriterId);
      return orderedWriters[(currentIdx + 1) % orderedWriters.length].story_writer_id;
    }

    const lastInCycleId = prevCycleRows[0].story_writer_id;
    const lastIdx = orderedWriters.findIndex(w => w.story_writer_id === lastInCycleId);
    return orderedWriters[(lastIdx + 1) % orderedWriters.length].story_writer_id;
  }

  // For Random and Fixed: fetch active writers
  const [writers] = await connection.execute(
    `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY writer_order ASC`,
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
 * Creates a new turn for the given writer.
 * Cancels any pending jobs for the current active turn, inserts a turn record,
 * schedules timeout/reminder jobs, creates a thread (normal mode), and posts notifications.
 */
export async function NextTurn(connection, interaction, storyWriterId) {
  log(`NextTurn: entry storyWriterId=${storyWriterId}`, { show: false, guildName: interaction?.guild?.name });
  const guild_id = interaction.guild.id;
  try {

    // Get story and writer info
    const [writerInfo] = await connection.execute(
      `SELECT sw.story_id, sw.discord_user_id, sw.discord_display_name, sw.turn_privacy, sw.notification_prefs,
              s.mode, s.turn_length_hours, s.story_thread_id, s.restricted_thread_id, s.story_turn_privacy, s.title,
              s.reminder_timing, s.guild_id, s.guild_story_id, s.show_authors, s.rating
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

    const isSlowMode = writer.mode === 2;

    // Insert turn record — slow mode has no deadline (turn_ends_at stays NULL)
    let turnEndsAt = null;
    if (!isSlowMode) {
      turnEndsAt = new Date(Date.now() + (writer.turn_length_hours * 60 * 60 * 1000));
    }
    const [turnResult] = await connection.execute(
      `INSERT INTO turn (story_writer_id, started_at, turn_ends_at, turn_status) VALUES (?, NOW(), ?, 1)`,
      [storyWriterId, turnEndsAt]
    );

    const turnId = turnResult.insertId;
    log(`NextTurn: created turn ${turnId} for writer ${storyWriterId} (${writer.discord_display_name}) story ${writer.story_id} mode=${writer.mode}`, { show: false, guildName: interaction?.guild?.name });

    if (!isSlowMode) {
      // Schedule turnTimeout job
      await connection.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
        ['turnTimeout', JSON.stringify({ turnId, storyId: writer.story_id, guildId: writer.guild_id }), turnEndsAt, turnId]
      );

      // Schedule turnReminder job if configured (percent-based, fires once)
      if (writer.reminder_timing > 0) {
        const reminderMs = writer.turn_length_hours * (writer.reminder_timing / 100) * 60 * 60 * 1000;
        const reminderTime = new Date(Date.now() + reminderMs);
        await connection.execute(
          `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
          ['turnReminder', JSON.stringify({ turnId, storyId: writer.story_id, guildId: writer.guild_id, writerUserId: writer.discord_user_id }), reminderTime, turnId]
        );
      }
    } else if (writer.reminder_timing > 0) {
      // Slow mode: schedule repeating reminder (hours-based; re-schedules itself on each fire)
      const reminderTime = new Date(Date.now() + (writer.reminder_timing * 60 * 60 * 1000));
      await connection.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
        ['turnSlowReminder', JSON.stringify({ turnId, storyId: writer.story_id, guildId: writer.guild_id, writerUserId: writer.discord_user_id, reminderHours: writer.reminder_timing }), reminderTime, turnId]
      );
    }

    let threadId = null;
    let dmMessage = '';

    const turnNumber = await getTurnNumber(connection, writer.story_id);
    // turnEndTime is only meaningful for normal/quick mode
    const turnEndTime = isSlowMode ? null : turnEndTimeFunction(writer.turn_length_hours);

    if (writer.mode === 1) {
      // Quick mode — feed announcement, no turn thread
      await handleQuickModeNotification(connection, interaction, writer, guild_id);
      dmMessage = 'Quick mode notification sent';
    } else {
      // Normal and Slow mode — create turn thread on the feed channel
      const storyFeedChannelId = await resolveFeedChannelId(connection, guild_id, writer.rating ?? 'NR');
      const channel = await interaction.guild.channels.fetch(storyFeedChannelId);

      const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', guild_id);
      const threadTitle = threadTitleTemplate
        .replace('[story_id]', writer.guild_story_id)
        .replace('[storyTurnNumber]', turnNumber)
        .replace('[user display name]', writer.discord_display_name);

      const isPrivateThread = writer.story_turn_privacy || writer.turn_privacy;
      const thread = await channel.threads.create({
        name: threadTitle,
        type: isPrivateThread ? ChannelType.PrivateThread : ChannelType.PublicThread,
        reason: `Turn thread for story ${writer.story_id}`
      });

      threadId = thread.id;

      if (isPrivateThread) {
        await thread.members.add(writer.discord_user_id);
      }

      await connection.execute(
        `UPDATE turn SET thread_id = ? WHERE turn_id = ?`,
        [threadId, turnId]
      );

      await postWelcomeMessage(connection, thread, writer, guild_id, turnEndTime);
      await handleWriterNotification(connection, interaction, writer, threadId, guild_id);
      dmMessage = `${isSlowMode ? 'Slow' : 'Normal'} mode thread created and notification sent`;
    }

    // Update status embed then post activity log — order matters in the story thread
    updateStoryStatusMessage(connection, interaction.guild, writer.story_id)
      .then(async () => {
        const cfgKey = isSlowMode ? 'txtStoryThreadTurnStartSlow' : 'txtStoryThreadTurnStart';
        const template = await getConfigValue(connection, cfgKey, guild_id);
        let msg = template
          .replace('[turn_number]', turnNumber)
          .replace('[writer_name]', writer.discord_display_name);
        if (!isSlowMode && turnEndTime) {
          const unixTs = Math.floor(turnEndTime.getTime() / 1000);
          msg = msg
            .replace('[turn_end_full]', `<t:${unixTs}:F>`)
            .replace('[turn_end_relative]', `<t:${unixTs}:R>`);
        }
        return postStoryThreadActivity(connection, interaction.guild, writer.story_id, msg);
      })
      .catch(err => log(`NextTurn: status/activity post failed for story ${writer.story_id}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name }));

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
 * Delete a turn/story thread and also remove the "started a thread" system
 * message Discord posts in the parent channel when the thread was created.
 * Safe to await directly — errors from the announcement deletion are swallowed
 * so the thread deletion always proceeds.
 */
export async function deleteThreadAndAnnouncement(thread) {
  log(`deleteThreadAndAnnouncement: entry threadId=${thread.id}`, { show: false, guildName: thread?.guild?.name });
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
  log(`skipActiveTurn: entry turnId=${turnId} threadId=${threadId}`, { show: false, guildName: guild?.name });
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
 * Returns a Date for when a turn of the given length will end.
 */
export function turnEndTimeFunction(turnLengthHours) {
  return new Date(Date.now() + (turnLengthHours * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Private helpers — not exported
// ---------------------------------------------------------------------------

async function handleQuickModeNotification(connection, interaction, writer, guild_id) {
  log(`handleQuickModeNotification: entry storyId=${writer.story_id} (${writer.title}) writerId=${writer.discord_user_id} (${writer.discord_display_name})`, { show: false, guildName: interaction?.guild?.name });
  const turnEndTime = turnEndTimeFunction(writer.turn_length_hours);
  const discordTimestamp = `<t:${Math.floor(turnEndTime.getTime() / 1000)}:F>`;

  // Send notification to writer using the active story thread as the link
  await handleWriterNotification(connection, interaction, writer, getActiveThreadId(writer), guild_id);

  // Post feed announcement to the appropriate channel (restricted if M/E rated)
  const txtQuickModeTurnStart = await getConfigValue(connection, 'txtQuickModeTurnStart', guild_id);
  const feedMessage = txtQuickModeTurnStart
    .replace('[story_id]', writer.guild_story_id)
    .replace('[story_title]', writer.title)
    .replace('[current_writer]', writer.discord_display_name)
    .replace('[turn_end_date]', discordTimestamp);

  const storyFeedChannelId = await resolveFeedChannelId(connection, guild_id, writer.rating ?? 'NR');
  const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
  await channel.send(feedMessage);
}

async function handleWriterNotification(connection, interaction, writer, linkToThreadId, guild_id) {
  log(`handleWriterNotification: entry writerId=${writer.discord_user_id} (${writer.discord_display_name}) prefs=${writer.notification_prefs} mode=${writer.mode}`, { show: false, guildName: interaction?.guild?.name });
  const linkToUse = linkToThreadId || writer.story_thread_id;
  const threadUrl = `https://discord.com/channels/${guild_id}/${linkToUse}`;
  const modeKey = writer.mode === 1 ? 'Quick' : writer.mode === 2 ? 'Slow' : 'Normal';

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
      log(`handleWriterNotification: DM failed for user ${writer.discord_user_id}, falling back to mention: ${dmError?.message}`, { show: true, guildName: interaction?.guild?.name });
      const mentionKey = `txtMentionTurnStart${modeKey}`;
      const mentionTxt = applyTokens(await getConfigValue(connection, mentionKey, guild_id));
      const feedChannelId = await resolveFeedChannelId(connection, guild_id, writer.rating ?? 'NR');
      const channel = await interaction.guild.channels.fetch(feedChannelId);
      await channel.send(`<@${writer.discord_user_id}> ${mentionTxt}`);
    }
  }
}

async function postWelcomeMessage(connection, thread, writer, guild_id, turnEndTime) {
  log(`postWelcomeMessage: entry storyId=${writer.story_id} (${writer.title}) writerId=${writer.discord_user_id} (${writer.discord_display_name}) mode=${writer.mode}`, { show: false });
  const isSlowMode = writer.mode === 2;
  const mediaChannelId = await getConfigValue(connection, 'cfgMediaChannelId', guild_id);
  const mediaConfigured = mediaChannelId && mediaChannelId !== 'cfgMediaChannelId';

  let welcomeKey;
  if (isSlowMode) {
    welcomeKey = mediaConfigured ? ['txtSlowModeWelcome', 'txtNormalModeImageHelp'] : ['txtSlowModeWelcomeNoMedia'];
  } else {
    welcomeKey = mediaConfigured ? ['txtNormalModeWelcome', 'txtNormalModeImageHelp'] : ['txtNormalModeWelcomeNoMedia'];
  }

  const cfgKeys = [...welcomeKey, 'btnFinalizeEntry', 'btnSkipTurn', 'btnViewLastEntry'];
  const cfg = await getConfigValue(connection, cfgKeys, guild_id);
  const welcomeMsg = welcomeKey.map(key => cfg[key]).join('\n\n');

  let welcomeContent = welcomeMsg
    .replace('[story_title]', writer.title)
    .replace('[story_id]', writer.guild_story_id);

  if (!isSlowMode && turnEndTime) {
    const unixTs = Math.floor(turnEndTime.getTime() / 1000);
    welcomeContent = welcomeContent
      .replace('[turn_end_full]', `<t:${unixTs}:F>`)
      .replace('[turn_end_relative]', `<t:${unixTs}:R>`);
  }

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
}
