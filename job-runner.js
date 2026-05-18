import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfigValue, log } from './utilities.js';
import { checkStoryDelay } from './story/_delay.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, endTurnThread } from './story/_turn.js';
import { postStoryFeedActivationAnnouncement } from './announcements.js';
import { handleWeeklyRoundup } from './story/roundup.js';

const JOB_POLL_INTERVAL_MS = 60 * 1000;
const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

export function startJobRunner(connection, client) {
  log('Job runner started, polling every 60s', { show: true });
  setInterval(() => runDueJobs(connection, client), JOB_POLL_INTERVAL_MS);
}

async function runDueJobs(connection, client) {
  try {
    const [jobs] = await connection.execute(
      `SELECT * FROM job WHERE job_status = 0 AND run_at <= NOW() ORDER BY run_at ASC LIMIT 20`
    );
    for (const job of jobs) {
      await processJob(connection, client, job);
    }
  } catch (err) {
    log(`Job runner poll error: ${err}`, { show: true });
  }
}

async function processJob(connection, client, job) {
  log(`processJob claiming job ${job.job_id} (type=${job.job_type})`, { show: false });
  // Claim the job atomically and increment attempt counter
  const [claimed] = await connection.execute(
    `UPDATE job SET job_status = 1, attempts = attempts + 1 WHERE job_id = ? AND job_status = 0`,
    [job.job_id]
  );
  if (claimed.affectedRows === 0) return;

  const attemptNumber = job.attempts + 1;

  try {
    const payload = JSON.parse(job.payload);
    switch (job.job_type) {
      case 'checkStoryDelay':
        await handleCheckStoryDelay(connection, client, payload);
        break;
      case 'turnTimeout':
        await handleTurnTimeout(connection, client, payload);
        break;
      case 'turnReminder':
        await handleTurnReminder(connection, client, payload);
        break;
      case 'turnSlowReminder':
        await handleSlowTurnReminder(connection, client, payload);
        break;
      case 'weeklyRoundup':
        await handleWeeklyRoundup(connection, client, payload);
        break;
      case 'threadDelete':
        await handleThreadDelete(connection, client, payload);
        break;
      default:
        log(`Unknown job type: ${job.job_type} (job_id=${job.job_id})`, { show: true });
    }
  } catch (err) {
    log(`Job ${job.job_id} (${job.job_type}) failed on attempt ${attemptNumber}: ${err}`, { show: true });
    if (attemptNumber < JOB_MAX_ATTEMPTS) {
      const retryAt = new Date(Date.now() + JOB_RETRY_DELAY_MS);
      await connection.execute(
        `UPDATE job SET job_status = 0, run_at = ? WHERE job_id = ?`,
        [retryAt, job.job_id]
      );
      log(`Job ${job.job_id} scheduled for retry at ${retryAt.toISOString()} (attempt ${attemptNumber}/${JOB_MAX_ATTEMPTS})`, { show: true });
    } else {
      await connection.execute(`UPDATE job SET job_status = 2 WHERE job_id = ?`, [job.job_id]);
      log(`⚠️ Job ${job.job_id} (${job.job_type}) permanently failed after ${attemptNumber} attempts: ${err}`, { show: true });
    }
  }
}

/**
 * Build a synthetic context object that satisfies the guild/client usage
 * in NextTurn and announcements without a real Discord interaction.
 */
async function buildSyntheticContext(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.roles.fetch(); // populate roles cache for thread membership checks
  return { guild, client };
}

// ---------------------------------------------------------------------------
// checkStoryDelay — fires when the hour-delay window expires
// ---------------------------------------------------------------------------
async function handleCheckStoryDelay(connection, client, payload) {
  const { storyId } = payload;
  const [storyRows] = await connection.execute(
    `SELECT story_status, guild_id, title FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== 2) return; // gone or already active

  const { guild_id: guildId, title } = storyRows[0];
  log(`handleCheckStoryDelay entry for story ${storyId} "${title}"`, { show: false });

  // checkStoryDelay handles both hour and writer-count conditions and activates the story
  const result = await checkStoryDelay(connection, storyId);

  if (result.madeActive) {
    const ctx = await buildSyntheticContext(client, guildId);
    await postStoryFeedActivationAnnouncement(connection, storyId, ctx, title);
    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) await NextTurn(connection, ctx, nextWriterId);
    log(`checkStoryDelay job activated story ${storyId}`, { show: true, guildName: ctx.guild?.name });
  } else {
    // Writer count condition not yet met — story stays paused until enough writers join
    log(`checkStoryDelay job fired for story ${storyId} but writer count condition not met`, { show: false });
  }
}

// ---------------------------------------------------------------------------
// threadDelete — fires 24h after a preserved draft thread is scheduled for deletion
// ---------------------------------------------------------------------------
async function handleThreadDelete(connection, client, payload) {
  const { threadId, guildId } = payload;
  log(`handleThreadDelete entry for thread ${threadId}`, { show: false });
  try {
    const ctx = await buildSyntheticContext(client, guildId);
    const thread = await ctx.guild.channels.fetch(threadId).catch(() => null);
    if (thread) {
      await deleteThreadAndAnnouncement(thread);
      log(`handleThreadDelete: deleted preserved draft thread ${threadId}`, { show: true, guildName: ctx.guild?.name });
    } else {
      log(`handleThreadDelete: thread ${threadId} not found — likely already deleted`, { show: false });
    }
  } catch (err) {
    log(`handleThreadDelete failed for thread ${threadId}: ${err}`, { show: true });
  }
}

// ---------------------------------------------------------------------------
// turnTimeout — fires when a turn's deadline passes
// ---------------------------------------------------------------------------
async function handleTurnTimeout(connection, client, payload) {
  const { turnId, storyId, guildId } = payload;
  // Verify turn is still active
  const [turnRows] = await connection.execute(
    `SELECT t.turn_id, t.thread_id, sw.discord_display_name
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE t.turn_id = ? AND t.turn_status = 1`,
    [turnId]
  );
  if (turnRows.length === 0) return; // already ended or advanced by someone else
  log(`handleTurnTimeout entry for turn ${turnId} story ${storyId} writer ${turnRows[0].discord_display_name}`, { show: false });

  // Verify story is still active (not paused or closed)
  const [storyRows] = await connection.execute(
    `SELECT story_status FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== 1) {
    log(`turnTimeout no-op for turn ${turnId} — story ${storyId} is not active`, { show: false });
    return;
  }

  const activeTurn = turnRows[0];

  // End the turn and cancel its pending jobs
  await connection.execute(
    `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
    [turnId]
  );
  await connection.execute(
    `UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`,
    [turnId]
  );

  const ctx = await buildSyntheticContext(client, guildId);
  log(`Turn ${turnId} timed out for story ${storyId}`, { show: true, guildName: ctx.guild?.name });

  await endTurnThread(connection, ctx.guild, activeTurn.thread_id, activeTurn.discord_user_id, guildId);

  const nextWriterId = await PickNextWriter(connection, storyId);
  if (nextWriterId) await NextTurn(connection, ctx, nextWriterId);

  // Activity log (fire-and-forget)
  getConfigValue(connection, 'txtStoryThreadTurnTimeout', guildId).then(template =>
    postStoryThreadActivity(connection, ctx.guild, storyId, template.replace('[writer_name]', activeTurn.discord_display_name))
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// turnReminder — fires partway through a turn to remind the writer
// ---------------------------------------------------------------------------
async function handleTurnReminder(connection, client, payload) {
  const { turnId, storyId, guildId, writerUserId } = payload;
  log(`handleTurnReminder entry for turn ${turnId} story ${storyId} writer ${writerUserId}`, { show: false });

  // Verify turn is still active
  const [turnRows] = await connection.execute(
    `SELECT turn_id, turn_ends_at FROM turn WHERE turn_id = ? AND turn_status = 1`,
    [turnId]
  );
  if (turnRows.length === 0) return;
  const unixTs = Math.floor(new Date(turnRows[0].turn_ends_at).getTime() / 1000);

  // Verify story is still active
  const [storyRows] = await connection.execute(
    `SELECT story_status, title, story_thread_id FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== 1) return;

  const story = storyRows[0];

  // Get writer's notification preference
  const [writerRows] = await connection.execute(
    `SELECT sw.notification_prefs, s.mode, t.thread_id
     FROM story_writer sw
     JOIN story s ON sw.story_id = s.story_id
     LEFT JOIN turn t ON t.turn_id = ? AND t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1`,
    [turnId, storyId, writerUserId]
  );
  if (writerRows.length === 0) return; // writer left

  const { notification_prefs: notificationPrefs, mode, thread_id: turnThreadId } = writerRows[0];
  const ctx = await buildSyntheticContext(client, guildId);

  // Build thread link — quick mode links to the story thread; normal/slow link to the turn thread
  const linkThreadId = (mode !== 1 && turnThreadId) ? turnThreadId : story.story_thread_id;
  const threadUrl = `https://discord.com/channels/${guildId}/${linkThreadId}`;
  const modeKey = mode === 1 ? 'Quick' : mode === 2 ? 'Slow' : 'Normal';

  function applyReminderTokens(text) {
    return text
      .replace(/\[story_title\]/g, story.title)
      .replace(/\[turn_end_full\]/g, `<t:${unixTs}:F>`)
      .replace(/\[turn_end_relative\]/g, `<t:${unixTs}:R>`)
      .replace(/\[turn_thread_link\]/g, threadUrl);
  }

  if (notificationPrefs === 'mention') {
    await sendMentionReminder(connection, ctx, guildId, story, writerUserId, unixTs, threadUrl, modeKey, applyReminderTokens);
  } else {
    try {
      const user = await client.users.fetch(writerUserId);
      const dmKey = `txtDMTurnReminder${modeKey}`;
      const txt = await getConfigValue(connection, dmKey, guildId);
      await user.send(applyReminderTokens(txt));
    } catch (dmErr) {
      log(`handleTurnReminder DM failed for user ${writerUserId}, falling back to mention: ${dmErr}`, { show: true, guildName: ctx.guild?.name });
      await sendMentionReminder(connection, ctx, guildId, story, writerUserId, unixTs, threadUrl, modeKey, applyReminderTokens);
    }
  }

  log(`Turn reminder sent for turn ${turnId} story ${storyId} (${story.title}) writer ${writerUserId}`, { show: true, guildName: ctx.guild?.name });
}

// ---------------------------------------------------------------------------
// turnSlowReminder — fires on a repeating interval for slow mode turns
// ---------------------------------------------------------------------------
async function handleSlowTurnReminder(connection, client, payload) {
  const { turnId, storyId, guildId, writerUserId, reminderHours } = payload;
  log(`handleSlowTurnReminder entry for turn ${turnId} story ${storyId} writer ${writerUserId}`, { show: false });

  // Verify turn is still active
  const [turnRows] = await connection.execute(
    `SELECT turn_id, thread_id FROM turn WHERE turn_id = ? AND turn_status = 1`,
    [turnId]
  );
  if (turnRows.length === 0) return; // turn ended

  // Verify story is still active
  const [storyRows] = await connection.execute(
    `SELECT story_status, title, story_thread_id FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== 1) return;

  const story = storyRows[0];
  const turnThreadId = turnRows[0].thread_id;

  // Get writer notification preference
  const [writerRows] = await connection.execute(
    `SELECT notification_prefs FROM story_writer
     WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
    [storyId, writerUserId]
  );
  if (writerRows.length === 0) return; // writer left

  const { notification_prefs: notificationPrefs } = writerRows[0];
  const ctx = await buildSyntheticContext(client, guildId);

  const linkThreadId = turnThreadId || story.story_thread_id;
  const threadUrl = `https://discord.com/channels/${guildId}/${linkThreadId}`;

  function applySlowTokens(text) {
    return text
      .replace(/\[story_title\]/g, story.title)
      .replace(/\[turn_thread_link\]/g, threadUrl);
  }

  if (notificationPrefs === 'mention') {
    const txt = await getConfigValue(connection, 'txtMentionTurnReminderSlow', guildId);
    const storyFeedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
    const channel = await ctx.guild.channels.fetch(storyFeedChannelId);
    await channel.send(`<@${writerUserId}> ${applySlowTokens(txt)}`);
  } else {
    try {
      const user = await client.users.fetch(writerUserId);
      const txt = await getConfigValue(connection, 'txtDMTurnReminderSlow', guildId);
      await user.send(applySlowTokens(txt));
    } catch (dmErr) {
      log(`handleSlowTurnReminder DM failed for user ${writerUserId} turn ${turnId}, falling back to mention: ${dmErr}`, { show: true, guildName: ctx.guild?.name });
      const txt = await getConfigValue(connection, 'txtMentionTurnReminderSlow', guildId);
      const storyFeedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
      const channel = await ctx.guild.channels.fetch(storyFeedChannelId);
      await channel.send(`<@${writerUserId}> ${applySlowTokens(txt)}`);
    }
  }

  // Re-schedule for the next interval
  const nextRun = new Date(Date.now() + (reminderHours * 60 * 60 * 1000));
  await connection.execute(
    `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
    ['turnSlowReminder', JSON.stringify({ turnId, storyId, guildId, writerUserId, reminderHours }), nextRun, turnId]
  );

  log(`Slow reminder sent for turn ${turnId} story ${storyId} (${story.title}) writer ${writerUserId}; next at ${nextRun.toISOString()}`, { show: true, guildName: ctx.guild?.name });
}

async function sendMentionReminder(connection, ctx, guildId, story, writerUserId, unixTs, threadUrl, modeKey, applyTokens) {
  const mentionKey = `txtMentionTurnReminder${modeKey}`;
  const txt = await getConfigValue(connection, mentionKey, guildId);
  const storyFeedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
  const channel = await ctx.guild.channels.fetch(storyFeedChannelId);
  await channel.send(`<@${writerUserId}> ${applyTokens(txt)}`);
}
