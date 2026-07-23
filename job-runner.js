import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, discordTimestamp, closeOrphanedGuildStories, isGuildConfigured } from './utilities.js';
import { checkStoryDelay } from './story/_delay.js';
import { STORY_STATUS, TURN_STATUS, JOB_STATUS, WRITER_STATUS, STORY_MODE } from './constants.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, endTurnThread, endTurnGuarded, buildSyntheticContext, deleteThreadAndAnnouncement } from './story/_turn.js';
import { postStoryFeedActivationAnnouncement } from './announcements.js';
import { handleWeeklyRoundup, scheduleNextRoundup } from './story/roundup.js';
import { getActiveThreadId } from './storybot.js';
import { resolveFeedChannelId } from './story/_metadata.js';

const JOB_POLL_INTERVAL_MS = 60 * 1000;
const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const JOB_PURGE_EVERY_N_TICKS = 24 * 60; // once per day at a 60s poll interval
const JOB_PURGE_AGE_DAYS = 30;
const ONBOARDING_REMINDER_DAYS = { onboardingDay1: 1, onboardingDay7: 7, onboardingDay14: 14, onboardingDay30: 30 };

let pollTickCount = 0;

export async function startJobRunner(connection, client) {
  // Jobs only sit at job_status=1 while processJob's synchronous handler is running —
  // there's no code path that leaves one there and returns. So any job still at
  // status 1 when the runner starts must have been orphaned by a crash/restart
  // between claim and completion (the restricted host restarts on every deploy).
  // Re-queue them so they aren't silently lost, per Fable Audit 1.13.
  const [stuck] = await connection.execute(`SELECT job_id, job_type FROM job WHERE job_status = ?`, [JOB_STATUS.IN_PROGRESS]);
  if (stuck.length > 0) {
    await connection.execute(`UPDATE job SET job_status = ? WHERE job_status = ?`, [JOB_STATUS.PENDING, JOB_STATUS.IN_PROGRESS]);
    log(`Job runner startup: re-queued ${stuck.length} job(s) orphaned by a previous restart (${stuck.map(j => `${j.job_id}:${j.job_type}`).join(', ')})`, { show: true });
  }
  log('Job runner started, polling every 60s', { show: true });
  setInterval(() => runDueJobs(connection, client), JOB_POLL_INTERVAL_MS);
}

async function purgeOldJobs(connection) {
  const [result] = await connection.execute(
    `DELETE FROM job WHERE job_status IN (?, ?, ?) AND run_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [JOB_STATUS.FAILED, JOB_STATUS.CANCELLED, JOB_STATUS.COMPLETED, JOB_PURGE_AGE_DAYS]
  );
  if (result.affectedRows > 0) {
    log(`Job runner: purged ${result.affectedRows} completed/cancelled/failed job(s) older than ${JOB_PURGE_AGE_DAYS} days`, { show: false });
  }
}

async function runDueJobs(connection, client) {
  try {
    pollTickCount++;
    if (pollTickCount % JOB_PURGE_EVERY_N_TICKS === 0) {
      await purgeOldJobs(connection).catch(err => log(`Job purge error: ${err}`, { show: true }));
    }
    const [jobs] = await connection.execute(
      `SELECT * FROM job WHERE job_status = ? AND run_at <= NOW() ORDER BY run_at ASC LIMIT 20`,
      [JOB_STATUS.PENDING]
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
    `UPDATE job SET job_status = ?, attempts = attempts + 1 WHERE job_id = ? AND job_status = ?`,
    [JOB_STATUS.IN_PROGRESS, job.job_id, JOB_STATUS.PENDING]
  );
  if (claimed.affectedRows === 0) return;

  const attemptNumber = job.attempts + 1;
  const payload = JSON.parse(job.payload);

  try {
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
      case 'onboardingDay1':
      case 'onboardingDay7':
      case 'onboardingDay14':
        await handleOnboardingReminder(connection, client, payload, job.job_type);
        break;
      case 'onboardingDay30':
        await handleOnboardingRemoval(connection, client, payload);
        break;
      default:
        log(`Unknown job type: ${job.job_type} (job_id=${job.job_id})`, { show: true });
    }
    await connection.execute(`UPDATE job SET job_status = ? WHERE job_id = ?`, [JOB_STATUS.COMPLETED, job.job_id]);
  } catch (err) {
    if (err?.code === 10004 && payload.guildId) {
      log(`Job ${job.job_id} (${job.job_type}): guild ${payload.guildId} no longer has the bot installed; closing its stories`, { show: true, hub: true });
      await closeOrphanedGuildStories(connection, payload.guildId);
      await connection.execute(`UPDATE job SET job_status = ? WHERE job_id = ?`, [JOB_STATUS.CANCELLED, job.job_id]);
      return;
    }
    log(`Job ${job.job_id} (${job.job_type}) failed on attempt ${attemptNumber}: ${err}`, { show: true });
    if (attemptNumber < JOB_MAX_ATTEMPTS) {
      const retryAt = new Date(Date.now() + JOB_RETRY_DELAY_MS);
      await connection.execute(
        `UPDATE job SET job_status = ?, run_at = ? WHERE job_id = ?`,
        [JOB_STATUS.PENDING, retryAt, job.job_id]
      );
      log(`Job ${job.job_id} scheduled for retry at ${retryAt.toISOString()} (attempt ${attemptNumber}/${JOB_MAX_ATTEMPTS})`, { show: true });
    } else {
      await connection.execute(`UPDATE job SET job_status = ? WHERE job_id = ?`, [JOB_STATUS.FAILED, job.job_id]);
      log(`⚠️ Job ${job.job_id} (${job.job_type}) permanently failed after ${attemptNumber} attempts: ${err}`, { show: true });
      if (job.job_type === 'weeklyRoundup' && payload.guildId) {
        // handleWeeklyRoundup deliberately doesn't reschedule on a throw (so retries
        // aren't cancelled out from under it) — once retries are exhausted here,
        // schedule the next window so the guild doesn't lose the feature entirely.
        await scheduleNextRoundup(connection, payload.guildId).catch(schedErr =>
          log(`Failed to reschedule weeklyRoundup for guild ${payload.guildId} after permanent failure: ${schedErr}`, { show: true })
        );
      }
    }
  }
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
  if (storyRows.length === 0 || storyRows[0].story_status !== STORY_STATUS.DELAYED) return; // gone or already active

  const { guild_id: guildId, title } = storyRows[0];
  log(`handleCheckStoryDelay entry for story ${storyId} "${title}"`, { show: false });

  // checkStoryDelay handles both hour and writer-count conditions and activates the story
  const result = await checkStoryDelay(connection, storyId);

  if (result.madeActive) {
    const ctx = await buildSyntheticContext(client, guildId);
    await postStoryFeedActivationAnnouncement(connection, storyId, ctx, title);
    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) {
      const turnResult = await NextTurn(connection, ctx, nextWriterId);
      if (!turnResult.success) {
        log(`checkStoryDelay: NextTurn failed activating story ${storyId} — story has no active turn: ${turnResult.error}`, { show: true, guildName: ctx.guild?.name, hub: true });
      }
    } else {
      log(`checkStoryDelay: no eligible writer to start the first turn for story ${storyId} — story has no active turn`, { show: true, guildName: ctx.guild?.name, hub: true });
    }
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
    `SELECT t.turn_id, t.thread_id, sw.discord_display_name, sw.discord_user_id
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE t.turn_id = ? AND t.turn_status = ?`,
    [turnId, TURN_STATUS.ACTIVE]
  );
  if (turnRows.length === 0) return; // already ended or advanced by someone else
  log(`handleTurnTimeout entry for turn ${turnId} story ${storyId} writer ${turnRows[0].discord_display_name}`, { show: false });

  // Verify story is still active (not paused or closed)
  const [storyRows] = await connection.execute(
    `SELECT story_status FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== STORY_STATUS.ACTIVE) {
    log(`turnTimeout no-op for turn ${turnId} — story ${storyId} is not active`, { show: false });
    return;
  }

  const activeTurn = turnRows[0];

  // End the turn and cancel its pending jobs. Guarded so a finalize that races
  // this timeout (both reading turn_status=1 in the same window) only advances once.
  const ended = await endTurnGuarded(connection, turnId);
  if (!ended) {
    log(`turnTimeout no-op for turn ${turnId} — already ended by a race (finalize/skip)`, { show: true, guildName: guildId });
    return;
  }

  const ctx = await buildSyntheticContext(client, guildId);
  log(`Turn ${turnId} timed out for story ${storyId}`, { show: true, guildName: ctx.guild?.name });

  await endTurnThread(connection, ctx.guild, activeTurn.thread_id, activeTurn.discord_user_id, guildId);

  const nextWriterId = await PickNextWriter(connection, storyId);
  if (nextWriterId) {
    const turnResult = await NextTurn(connection, ctx, nextWriterId);
    if (!turnResult.success) {
      log(`handleTurnTimeout: NextTurn failed for story ${storyId} after turn ${turnId} timed out — story has no active turn: ${turnResult.error}`, { show: true, guildName: ctx.guild?.name, hub: true });
    }
  } else {
    log(`handleTurnTimeout: no eligible next writer for story ${storyId} after turn ${turnId} timed out — story has no active turn`, { show: true, guildName: ctx.guild?.name, hub: true });
  }

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
    `SELECT turn_id, turn_ends_at FROM turn WHERE turn_id = ? AND turn_status = ?`,
    [turnId, TURN_STATUS.ACTIVE]
  );
  if (turnRows.length === 0) return;

  // Verify story is still active
  const [storyRows] = await connection.execute(
    `SELECT story_status, title, story_thread_id, restricted_thread_id, rating FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== STORY_STATUS.ACTIVE) return;

  const story = storyRows[0];

  // Get writer's notification preference
  const [writerRows] = await connection.execute(
    `SELECT sw.notification_prefs, s.mode, t.thread_id
     FROM story_writer sw
     JOIN story s ON sw.story_id = s.story_id
     LEFT JOIN turn t ON t.turn_id = ? AND t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND sw.discord_user_id = ? AND sw.sw_status = ?`,
    [turnId, storyId, writerUserId, WRITER_STATUS.ACTIVE]
  );
  if (writerRows.length === 0) return; // writer left

  const { notification_prefs: notificationPrefs, mode, thread_id: turnThreadId } = writerRows[0];
  const ctx = await buildSyntheticContext(client, guildId);

  // Build thread link — quick mode links to the story thread; normal/slow link to the turn thread
  const linkThreadId = (mode !== STORY_MODE.QUICK && turnThreadId) ? turnThreadId : getActiveThreadId(story);
  const threadUrl = `https://discord.com/channels/${guildId}/${linkThreadId}`;
  const modeKey = mode === STORY_MODE.QUICK ? 'Quick' : mode === STORY_MODE.SLOW ? 'Slow' : 'Normal';

  const reminderTokenMap = {
    story_title: story.title,
    turn_end_full: discordTimestamp(new Date(turnRows[0].turn_ends_at).getTime(), 'F'),
    turn_end_relative: discordTimestamp(new Date(turnRows[0].turn_ends_at).getTime(), 'R'),
    turn_thread_link: threadUrl,
  };

  function applyReminderTokens(text) {
    return replaceTemplateVariables(text, reminderTokenMap);
  }

  if (notificationPrefs === 'mention') {
    await sendMentionReminder(connection, ctx, guildId, writerUserId, modeKey, applyReminderTokens, story.rating);
  } else {
    try {
      const user = await client.users.fetch(writerUserId);
      const dmKey = `txtDMTurnReminder${modeKey}`;
      const txt = await getConfigValue(connection, dmKey, guildId);
      await user.send(applyReminderTokens(txt));
    } catch (dmErr) {
      log(`handleTurnReminder DM failed for user ${writerUserId}, falling back to mention: ${dmErr}`, { show: true, guildName: ctx.guild?.name });
      await sendMentionReminder(connection, ctx, guildId, writerUserId, modeKey, applyReminderTokens, story.rating);
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
    `SELECT turn_id, thread_id FROM turn WHERE turn_id = ? AND turn_status = ?`,
    [turnId, TURN_STATUS.ACTIVE]
  );
  if (turnRows.length === 0) return; // turn ended

  // Verify story is still active
  const [storyRows] = await connection.execute(
    `SELECT story_status, title, story_thread_id, restricted_thread_id, rating FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== STORY_STATUS.ACTIVE) return;

  const story = storyRows[0];
  const turnThreadId = turnRows[0].thread_id;

  // Get writer notification preference
  const [writerRows] = await connection.execute(
    `SELECT notification_prefs FROM story_writer
     WHERE story_id = ? AND discord_user_id = ? AND sw_status = ?`,
    [storyId, writerUserId, WRITER_STATUS.ACTIVE]
  );
  if (writerRows.length === 0) return; // writer left

  const { notification_prefs: notificationPrefs } = writerRows[0];
  const ctx = await buildSyntheticContext(client, guildId);

  const linkThreadId = turnThreadId || getActiveThreadId(story);
  const threadUrl = `https://discord.com/channels/${guildId}/${linkThreadId}`;

  const slowTokenMap = {
    story_title: story.title,
    turn_thread_link: threadUrl,
  };

  function applySlowTokens(text) {
    return replaceTemplateVariables(text, slowTokenMap);
  }

  if (notificationPrefs === 'mention') {
    await sendMentionReminder(connection, ctx, guildId, writerUserId, 'Slow', applySlowTokens, story.rating);
  } else {
    try {
      const user = await client.users.fetch(writerUserId);
      const txt = await getConfigValue(connection, 'txtDMTurnReminderSlow', guildId);
      await user.send(applySlowTokens(txt));
    } catch (dmErr) {
      log(`handleSlowTurnReminder DM failed for user ${writerUserId} turn ${turnId}, falling back to mention: ${dmErr}`, { show: true, guildName: ctx.guild?.name });
      await sendMentionReminder(connection, ctx, guildId, writerUserId, 'Slow', applySlowTokens, story.rating);
    }
  }

  // Re-schedule for the next interval
  const nextRun = new Date(Date.now() + (reminderHours * 60 * 60 * 1000));
  await connection.execute(
    `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, ?, ?)`,
    ['turnSlowReminder', JSON.stringify({ turnId, storyId, guildId, writerUserId, reminderHours }), nextRun, JOB_STATUS.PENDING, turnId]
  );

  log(`Slow reminder sent for turn ${turnId} story ${storyId} (${story.title}) writer ${writerUserId}; next at ${nextRun.toISOString()}`, { show: true, guildName: ctx.guild?.name });
}

async function sendMentionReminder(connection, ctx, guildId, writerUserId, modeKey, applyTokens, rating = 'NR') {
  const mentionKey = `txtMentionTurnReminder${modeKey}`;
  const txt = await getConfigValue(connection, mentionKey, guildId);
  const storyFeedChannelId = await resolveFeedChannelId(connection, guildId, rating);
  const channel = await ctx.guild.channels.fetch(storyFeedChannelId);
  await channel.send(`<@${writerUserId}> ${applyTokens(txt)}`);
}

// ---------------------------------------------------------------------------
// Onboarding reminder sequence — nudges guild owners to complete /storyadmin
// setup, then leaves the guild if it's still unconfigured after 30 days.
// ---------------------------------------------------------------------------

/**
 * Schedules the full day-1/7/14/30 onboarding reminder sequence for a guild,
 * relative to fromDate. Cancels any existing pending onboarding jobs for the
 * guild first, so this is safe to call more than once (e.g. a backfill re-run).
 */
export async function scheduleOnboardingReminders(connection, guildId, fromDate) {
  await connection.execute(
    `UPDATE job SET job_status = ?
     WHERE job_type IN ('onboardingDay1', 'onboardingDay7', 'onboardingDay14', 'onboardingDay30')
     AND job_status IN (?, ?)
     AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.guildId')) = ?`,
    [JOB_STATUS.CANCELLED, JOB_STATUS.PENDING, JOB_STATUS.IN_PROGRESS, String(guildId)]
  );
  for (const [jobType, days] of Object.entries(ONBOARDING_REMINDER_DAYS)) {
    const runAt = new Date(fromDate.getTime() + days * 24 * 60 * 60 * 1000);
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, ?)`,
      [jobType, JSON.stringify({ guildId: String(guildId) }), runAt, JOB_STATUS.PENDING]
    );
  }
  log(`Scheduled onboarding reminder sequence for guild ${guildId} starting from ${fromDate.toISOString()}`, { show: true });
}

async function handleOnboardingReminder(connection, client, payload, jobType) {
  const { guildId } = payload;
  if (await isGuildConfigured(connection, guildId)) {
    log(`${jobType}: guild ${guildId} has since completed setup — skipping reminder`, { show: false });
    return;
  }
  const guild = await client.guilds.fetch(guildId);
  const owner = await guild.fetchOwner();
  const configKey = { onboardingDay1: 'txtOnboardingDay1', onboardingDay7: 'txtOnboardingDay7', onboardingDay14: 'txtOnboardingDay14' }[jobType];
  const [message, hubInviteUrl] = await Promise.all([
    getConfigValue(connection, configKey),
    getConfigValue(connection, 'cfgHubInviteUrl'),
  ]);
  await owner.send(replaceTemplateVariables(message, { hubInviteUrl }));
  log(`Onboarding reminder (${jobType}) sent to owner ${owner.user.tag} for guild ${guild.name} (${guildId})`, { show: true });
}

async function handleOnboardingRemoval(connection, client, payload) {
  const { guildId } = payload;
  if (await isGuildConfigured(connection, guildId)) {
    log(`onboardingDay30: guild ${guildId} has since completed setup — skipping removal`, { show: false });
    return;
  }
  const guild = await client.guilds.fetch(guildId);
  const owner = await guild.fetchOwner();
  const [message, hubInviteUrl] = await Promise.all([
    getConfigValue(connection, 'txtOnboardingDay30Removal'),
    getConfigValue(connection, 'cfgHubInviteUrl'),
  ]);
  await owner.send(replaceTemplateVariables(message, { hubInviteUrl }));
  log(`Onboarding reminder (onboardingDay30) sent to owner ${owner.user.tag} for guild ${guild.name} (${guildId})`, { show: true });
  const joinedAt = guild.joinedAt?.toISOString();
  await guild.leave();
  log(`Left guild ${guild.name} (${guildId}) — never configured within 30 days of joining (joined ${joinedAt})`, { show: true, hub: true });
}
