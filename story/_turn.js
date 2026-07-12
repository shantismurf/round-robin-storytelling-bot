import { ChannelType, MessageType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfigValue, getTurnNumber, log, replaceTemplateVariables, discordTimestamp } from '../utilities.js';
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
    const [allWriters] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND sw_status = 1`,
      [storyId]
    );
    if (allWriters.length === 0) return null;
    if (!currentWriterId) {
      return allWriters[Math.floor(Math.random() * allWriters.length)].story_writer_id;
    }

    // Find the current writer's previous turn
    const [prevTurnRows] = await connection.execute(
      `SELECT turn_id FROM turn
       WHERE story_writer_id = ? AND turn_id < ?
       ORDER BY turn_id DESC LIMIT 1`,
      [currentWriterId, currentTurnId]
    );
    const prevTurnId = prevTurnRows[0]?.turn_id ?? 0;

    // Writers who have already had a turn started in this cycle
    const [usedWriterRows] = await connection.execute(
      `SELECT DISTINCT sw.story_writer_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_id > ? AND t.turn_id <= ?`,
      [storyId, prevTurnId, currentTurnId]
    );
    const usedIds = new Set(usedWriterRows.map(r => r.story_writer_id));

    // Eligible: active writers not yet in this cycle, excluding the current writer
    const eligible = allWriters.filter(w =>
      w.story_writer_id !== currentWriterId && !usedIds.has(w.story_writer_id)
    );

    // Within a normal cycle, pick randomly from eligible writers
    if (eligible.length > 0) {
      return eligible[Math.floor(Math.random() * eligible.length)].story_writer_id;
    }

    // Cycle reset — exclude the most recently-turned writers from the reset pool so
    // the same writers don't dominate the start of each new cycle. excludeCount scales
    // at ~25% of group size (ceil(n * 0.25), minimum 1). At 1–4 writers this is 1,
    // meaning only the finalized writer is excluded — identical to previous behavior.
    // The finalized writer is always most-recent so always lands in the excluded group;
    // the safety filter below is a belt-and-suspenders guard.
    const n = allWriters.length;
    const excludeCount = Math.max(1, Math.ceil(n * 0.25));

    const [recencyRows] = await connection.execute(
      `SELECT sw.story_writer_id, MAX(t.turn_id) AS last_turn_id
       FROM story_writer sw
       LEFT JOIN turn t ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.sw_status = 1
       GROUP BY sw.story_writer_id`,
      [storyId]
    );

    // Sort most-recent first; treat NULL (never gone) as 0 so new joiners always land in the pool
    recencyRows.sort((a, b) => (b.last_turn_id ?? 0) - (a.last_turn_id ?? 0));

    // Drop top excludeCount entries, then safety-filter the finalized writer
    const fairPool = recencyRows
      .slice(excludeCount)
      .filter(r => r.story_writer_id !== currentWriterId);

    // Edge-case fallback: if fairPool is empty use the single longest-waiting eligible writer
    const pool = fairPool.length > 0
      ? fairPool
      : recencyRows.filter(r => r.story_writer_id !== currentWriterId).slice(-1);

    if (pool.length === 0) return currentWriterId;
    return pool[Math.floor(Math.random() * pool.length)].story_writer_id;
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
 * endTurnThread — handles turn thread disposal after a turn ends by any means
 * (skip, timeout, close). Checks for writer-authored content and either
 * schedules a 24h deletion with a Delete Now button, or deletes immediately.
 * Safe to call with a null/undefined threadId — returns early if no thread.
 */
export async function endTurnThread(connection, guild, threadId, writerDiscordUserId, guildId) {
  if (!threadId) return;
  try {
    const thread = await guild.channels.fetch(threadId).catch(() => null);
    if (!thread) return;
    const messages = await thread.messages.fetch({ limit: 50 });
    const hasContent = messages.some(m => !m.author.bot && m.author.id === String(writerDiscordUserId));
    if (hasContent) {
      const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const relativeTs = `<t:${Math.floor(deleteAt.getTime() / 1000)}:R>`;
      const [scheduleMsg, btnDeleteLabel] = await Promise.all([
        getConfigValue(connection, 'txtThreadScheduledDelete', guildId),
        getConfigValue(connection, 'btnDeleteNow', guildId)
      ]);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`story_thread_delete_now_${threadId}`)
          .setLabel(btnDeleteLabel)
          .setStyle(ButtonStyle.Danger)
      );
      await thread.send({ content: scheduleMsg.replace('[relative_timestamp]', relativeTs), components: [row] });
      await connection.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
        ['threadDelete', JSON.stringify({ threadId, guildId }), deleteAt]
      );
      log(`endTurnThread: thread ${threadId} has draft content — scheduled delete at ${deleteAt.toISOString()}`, { show: true, guildName: guild?.name });
    } else {
      await deleteThreadAndAnnouncement(thread);
      log(`endTurnThread: thread ${threadId} empty — deleted immediately`, { show: false, guildName: guild?.name });
    }
  } catch (err) {
    log(`endTurnThread failed for thread ${threadId}: ${err}`, { show: true, guildName: guild?.name });
  }
}

/**
 * endTurnGuarded — atomically ends a turn only if it's still active, and cancels
 * its pending jobs. The UPDATE's own WHERE clause is the concurrency guard: if two
 * callers race to end the same turn (e.g. finalize vs. timeout), only the first
 * UPDATE affects a row — the second sees affectedRows === 0 and must back off
 * instead of re-running PickNextWriter/NextTurn a second time.
 * Returns true if this call ended the turn, false if it was already ended.
 */
export async function endTurnGuarded(connection, turnId) {
  const [result] = await connection.execute(
    `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ? AND turn_status = 1`,
    [turnId]
  );
  if (result.affectedRows !== 1) return false;
  await connection.execute(
    `UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`,
    [turnId]
  );
  return true;
}

/**
 * Build a synthetic context object that satisfies the guild/client usage
 * in NextTurn and announcements without a real Discord interaction.
 * Shared by job-runner.js and any other non-interaction-driven caller.
 */
export async function buildSyntheticContext(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.roles.fetch(); // populate roles cache for thread membership checks
  return { guild, client };
}

/**
 * skipActiveTurn — ends a turn as a skip, cancels its pending jobs, and deletes its thread.
 * Shared by handleSkip and handleReassign so the skip logic lives in one place.
 */
export async function skipActiveTurn(connection, guild, turnId, threadId) {
  log(`skipActiveTurn: entry turnId=${turnId} threadId=${threadId}`, { show: false, guildName: guild?.name });
  const ended = await endTurnGuarded(connection, turnId);
  if (!ended) {
    log(`skipActiveTurn: turn ${turnId} already ended — skipping thread cleanup and turn advance`, { show: true, guildName: guild?.name });
    return false;
  }
  if (threadId) {
    try {
      const thread = await guild.channels.fetch(threadId);
      if (thread) await deleteThreadAndAnnouncement(thread);
    } catch (err) {
      log(`Could not delete turn thread on skip: ${err}`, { show: true, guildName: guild?.name });
    }
  }
  return true;
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
  const isSlowMode = writer.mode === 2;

  const tokenMap = {
    turn_thread_link: threadUrl,
    story_title: writer.title,
  };

  if (!isSlowMode) {
    const turnEndMs = Date.now() + (writer.turn_length_hours * 60 * 60 * 1000);
    tokenMap.relative_end_time = discordTimestamp(turnEndMs, 'R');
  }

  if (writer.reminder_timing > 0) {
    const reminderMs = isSlowMode
      ? writer.reminder_timing * 60 * 60 * 1000
      : writer.turn_length_hours * (writer.reminder_timing / 100) * 60 * 60 * 1000;
    tokenMap.relative_reminder_time = discordTimestamp(Date.now() + reminderMs, 'R');
  }

  function applyTokens(text) {
    return replaceTemplateVariables(text, tokenMap);
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

  const storyThreadLink = `https://discord.com/channels/${guild_id}/${getActiveThreadId(writer)}`;
  let welcomeContent = welcomeMsg
    .replace('[story_title]', writer.title)
    .replace('[story_id]', writer.guild_story_id)
    .replace('[story_thread_link]', storyThreadLink);

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
