import { getConfigValue, formattedDate } from './utilities.js';
import { checkStoryDelay, PickNextWriter, NextTurn, postStoryThreadActivity } from './storybot.js';
import { postStoryFeedActivationAnnouncement } from './announcements.js';

const JOB_POLL_INTERVAL_MS = 60 * 1000;
const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

export function startJobRunner(connection, client) {
  console.log(`${formattedDate()}: Job runner started, polling every 60s`);
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
    console.error(`${formattedDate()}: Job runner poll error:`, err);
  }
}

async function processJob(connection, client, job) {
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
      default:
        console.warn(`${formattedDate()}: Unknown job type: ${job.job_type} (job_id=${job.job_id})`);
    }
  } catch (err) {
    console.error(`${formattedDate()}: Job ${job.job_id} (${job.job_type}) failed on attempt ${attemptNumber}:`, err);
    if (attemptNumber < JOB_MAX_ATTEMPTS) {
      const retryAt = new Date(Date.now() + JOB_RETRY_DELAY_MS);
      await connection.execute(
        `UPDATE job SET job_status = 0, run_at = ? WHERE job_id = ?`,
        [retryAt, job.job_id]
      );
      console.log(`${formattedDate()}: Job ${job.job_id} scheduled for retry at ${retryAt.toISOString()} (attempt ${attemptNumber}/${JOB_MAX_ATTEMPTS})`);
    } else {
      await connection.execute(`UPDATE job SET job_status = 2 WHERE job_id = ?`, [job.job_id]);
      console.error(`${formattedDate()}: Job ${job.job_id} permanently failed after ${attemptNumber} attempts`);
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

  // checkStoryDelay handles both hour and writer-count conditions and activates the story
  const result = await checkStoryDelay(connection, storyId);

  if (result.madeActive) {
    const ctx = await buildSyntheticContext(client, guildId);
    await postStoryFeedActivationAnnouncement(connection, storyId, ctx, title);
    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) await NextTurn(connection, ctx, nextWriterId);
    console.log(`${formattedDate()}: checkStoryDelay job activated story ${storyId}`);
  } else {
    // Writer count condition not yet met — story stays paused until enough writers join
    console.log(`${formattedDate()}: checkStoryDelay job fired for story ${storyId} but writer count condition not met`);
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

  // Verify story is still active (not paused or closed)
  const [storyRows] = await connection.execute(
    `SELECT story_status FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== 1) {
    console.log(`${formattedDate()}: turnTimeout no-op for turn ${turnId} — story ${storyId} is not active`);
    return;
  }

  const activeTurn = turnRows[0];

  // End the turn
  await connection.execute(
    `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
    [turnId]
  );
  console.log(`${formattedDate()}: Turn ${turnId} timed out for story ${storyId}`);

  const ctx = await buildSyntheticContext(client, guildId);

  // Delete turn thread if one exists
  if (activeTurn.thread_id) {
    try {
      const thread = await ctx.guild.channels.fetch(activeTurn.thread_id);
      if (thread) await thread.delete();
    } catch (err) {
      console.error(`${formattedDate()}: Could not delete thread on timeout for turn ${turnId}:`, err);
    }
  }

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

  // Verify turn is still active
  const [turnRows] = await connection.execute(
    `SELECT turn_id FROM turn WHERE turn_id = ? AND turn_status = 1`,
    [turnId]
  );
  if (turnRows.length === 0) return;

  // Verify story is still active
  const [storyRows] = await connection.execute(
    `SELECT story_status, title, story_thread_id FROM story WHERE story_id = ?`,
    [storyId]
  );
  if (storyRows.length === 0 || storyRows[0].story_status !== 1) return;

  const story = storyRows[0];

  // Get writer's notification preference
  const [writerRows] = await connection.execute(
    `SELECT notification_prefs FROM story_writer
     WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
    [storyId, writerUserId]
  );
  if (writerRows.length === 0) return; // writer left

  const notificationPrefs = writerRows[0].notification_prefs;
  const ctx = await buildSyntheticContext(client, guildId);

  if (notificationPrefs === 'mention') {
    await sendMentionReminder(connection, ctx, guildId, story, writerUserId);
  } else {
    try {
      const user = await client.users.fetch(writerUserId);
      const txtDMTurnReminder = await getConfigValue(connection, 'txtDMTurnReminder', guildId);
      await user.send(txtDMTurnReminder.replace('[story_title]', story.title));
    } catch (dmErr) {
      // DM failed — fall back to channel mention
      await sendMentionReminder(connection, ctx, guildId, story, writerUserId);
    }
  }

  console.log(`${formattedDate()}: Turn reminder sent for turn ${turnId} (story ${storyId})`);
}

async function sendMentionReminder(connection, ctx, guildId, story, writerUserId) {
  const txtMentionTurnReminder = await getConfigValue(connection, 'txtMentionTurnReminder', guildId);
  const storyFeedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
  const channel = await ctx.guild.channels.fetch(storyFeedChannelId);
  await channel.send(`<@${writerUserId}> ${txtMentionTurnReminder.replace('[story_title]', story.title)}`);
}
