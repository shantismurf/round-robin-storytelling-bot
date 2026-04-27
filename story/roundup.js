import { EmbedBuilder } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from '../utilities.js';

const EMBED_FIELD_LIMIT = 1024;

function writerBadge(entryCount, isNew) {
  if (isNew) return '✨';
  if (entryCount >= 50) return '💫';
  if (entryCount >= 25) return '🌟';
  return '⭐';
}

function buildFieldWithOverflow(lines, overflowTemplate) {
  let value = '';
  let included = 0;
  for (const line of lines) {
    const next = value ? `${value}\n${line}` : line;
    if (next.length > EMBED_FIELD_LIMIT) break;
    value = next;
    included++;
  }
  const remaining = lines.length - included;
  if (remaining > 0) {
    const overflow = '\n' + replaceTemplateVariables(overflowTemplate, { count: String(remaining) });
    if ((value + overflow).length <= EMBED_FIELD_LIMIT) value += overflow;
  }
  return value;
}

export async function generateRoundupStats(connection, guildId) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [activeStories] = await connection.execute(
    `SELECT guild_story_id, title FROM story WHERE guild_id = ? AND story_status = 1 ORDER BY updated_at DESC`,
    [guildId]
  );

  const [[{ created }]] = await connection.execute(
    `SELECT COUNT(*) AS created FROM story WHERE guild_id = ? AND created_at >= ?`,
    [guildId, weekAgo]
  );
  const [[{ completed }]] = await connection.execute(
    `SELECT COUNT(*) AS completed FROM story WHERE guild_id = ? AND closed_at >= ?`,
    [guildId, weekAgo]
  );

  const [[{ submitted }]] = await connection.execute(
    `SELECT COUNT(DISTINCT t.turn_id) AS submitted
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     JOIN story s ON sw.story_id = s.story_id
     JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
     WHERE s.guild_id = ? AND t.ended_at >= ?`,
    [guildId, weekAgo]
  );
  const [[{ missed }]] = await connection.execute(
    `SELECT COUNT(DISTINCT t.turn_id) AS missed
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     JOIN story s ON sw.story_id = s.story_id
     LEFT JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
     WHERE s.guild_id = ? AND t.ended_at >= ? AND t.turn_status = 0 AND se.story_entry_id IS NULL`,
    [guildId, weekAgo]
  );

  const [[{ wordSum }]] = await connection.execute(
    `SELECT COALESCE(SUM(
       LENGTH(se.content) - LENGTH(REPLACE(se.content, ' ', '')) + 1
     ), 0) AS wordSum
     FROM story_entry se
     JOIN turn t ON se.turn_id = t.turn_id
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     JOIN story s ON sw.story_id = s.story_id
     WHERE s.guild_id = ? AND se.entry_status = 'confirmed' AND se.created_at >= ?`,
    [guildId, weekAgo]
  );

  // Writers who submitted at least one confirmed entry this week
  const [rawWriterRows] = await connection.execute(
    `SELECT sw.discord_user_id, sw.discord_display_name
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     JOIN story s ON sw.story_id = s.story_id
     JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
     WHERE s.guild_id = ? AND t.ended_at >= ?
     ORDER BY t.ended_at DESC`,
    [guildId, weekAgo]
  );

  // Deduplicate by user_id, keeping most recent display name
  const seenIds = new Set();
  const activeWriterRows = [];
  for (const r of rawWriterRows) {
    const id = String(r.discord_user_id);
    if (!seenIds.has(id)) {
      seenIds.add(id);
      activeWriterRows.push(r);
    }
  }

  // All-time entry counts and pre-week counts for active writers (for badge tiers and first-timer detection)
  const entryCountMap = new Map();
  const priorCountMap = new Map();
  if (activeWriterRows.length > 0) {
    const userIds = activeWriterRows.map(r => r.discord_user_id);
    const placeholders = userIds.map(() => '?').join(',');
    const [countRows] = await connection.execute(
      `SELECT sw.discord_user_id, COUNT(se.story_entry_id) AS entry_count
       FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       LEFT JOIN turn t ON t.story_writer_id = sw.story_writer_id
       LEFT JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
       WHERE s.guild_id = ? AND sw.discord_user_id IN (${placeholders})
       GROUP BY sw.discord_user_id`,
      [guildId, ...userIds]
    );
    const [priorRows] = await connection.execute(
      `SELECT sw.discord_user_id, COUNT(se.story_entry_id) AS entry_count
       FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       LEFT JOIN turn t ON t.story_writer_id = sw.story_writer_id
       LEFT JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed' AND se.created_at < ?
       WHERE s.guild_id = ? AND sw.discord_user_id IN (${placeholders})
       GROUP BY sw.discord_user_id`,
      [weekAgo, guildId, ...userIds]
    );
    for (const row of countRows) {
      entryCountMap.set(String(row.discord_user_id), Number(row.entry_count));
    }
    for (const row of priorRows) {
      priorCountMap.set(String(row.discord_user_id), Number(row.entry_count));
    }
  }

  const writers = activeWriterRows.map(r => ({
    displayName: r.discord_display_name,
    entryCount: entryCountMap.get(String(r.discord_user_id)) ?? 1,
    isNew: (priorCountMap.get(String(r.discord_user_id)) ?? 0) === 0
  }));
  writers.sort((a, b) => b.entryCount - a.entryCount);

  return {
    activeStories,
    created: Number(created),
    completed: Number(completed),
    submitted: Number(submitted),
    missed: Number(missed),
    wordSum: Number(wordSum),
    writers
  };
}

export async function buildRoundupEmbed(connection, client, guildId, stats) {
  const cfg = await getConfigValue(connection, [
    'cfgWeeklyRoundupColor', 'cfgWeeklyRoundupThumbnail',
    'txtWeeklyRoundupTitle', 'txtRoundupNoActiveStories',
    'txtRoundupStoryLine', 'txtRoundupActivity', 'txtRoundupOverflow',
    'lblRoundupActiveStories', 'lblRoundupActivity', 'lblRoundupWriters'
  ], guildId);

  const color = parseInt((cfg.cfgWeeklyRoundupColor || '57F287').replace('#', ''), 16);

  const thumbnailUrl = cfg.cfgWeeklyRoundupThumbnail || client.user.displayAvatarURL();

  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const dateRange = `${fmt(weekAgo)}–${fmt(now)}`;

  const embed = new EmbedBuilder()
    .setTitle(`${cfg.txtWeeklyRoundupTitle} — ${dateRange}`)
    .setColor(color)
    .setThumbnail(thumbnailUrl)
    .setTimestamp();

  if (stats.activeStories.length > 0) {
    const lines = stats.activeStories.map(s =>
      replaceTemplateVariables(cfg.txtRoundupStoryLine, { story_title: s.title, story_id: String(s.guild_story_id) })
    );
    embed.addFields({ name: cfg.lblRoundupActiveStories, value: buildFieldWithOverflow(lines, cfg.txtRoundupOverflow), inline: false });
  } else {
    embed.addFields({ name: cfg.lblRoundupActiveStories, value: cfg.txtRoundupNoActiveStories, inline: false });
  }

  const activityValue = replaceTemplateVariables(cfg.txtRoundupActivity, {
    created:    String(stats.created),
    completed:  String(stats.completed),
    submitted:  String(stats.submitted),
    missed:     String(stats.missed),
    word_count: stats.wordSum.toLocaleString()
  });
  embed.addFields({ name: cfg.lblRoundupActivity, value: activityValue, inline: false });

  if (stats.writers.length > 0) {
    const lines = stats.writers.map(w => `${writerBadge(w.entryCount, w.isNew)} ${w.displayName}`);
    embed.addFields({ name: cfg.lblRoundupWriters, value: buildFieldWithOverflow(lines, cfg.txtRoundupOverflow), inline: false });
  }

  return embed;
}

export function calcNextRoundupTime(dayOfWeek, hour) {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hour, 0, 0, 0);
  const currentDay = now.getUTCDay();
  let daysUntil = (dayOfWeek - currentDay + 7) % 7;
  if (daysUntil === 0 && now.getUTCHours() >= hour) daysUntil = 7;
  target.setUTCDate(target.getUTCDate() + daysUntil);
  return target;
}

export async function scheduleNextRoundup(connection, guildId) {
  const cfg = await getConfigValue(connection, ['cfgWeeklyRoundupDay', 'cfgWeeklyRoundupHour'], guildId);
  const day = parseInt(cfg.cfgWeeklyRoundupDay) || 1;
  const hour = parseInt(cfg.cfgWeeklyRoundupHour) || 9;
  const runAt = calcNextRoundupTime(day, hour);
  await connection.execute(
    `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
    ['weeklyRoundup', JSON.stringify({ guildId: String(guildId) }), runAt]
  );
  return runAt;
}

export async function cancelPendingRoundupJobs(connection, guildId) {
  await connection.execute(
    `UPDATE job SET job_status = 2
     WHERE job_type = 'weeklyRoundup' AND job_status = 0
     AND CAST(JSON_EXTRACT(payload, '$.guildId') AS CHAR) = ?`,
    [String(guildId)]
  );
}

export async function scheduleAllRoundupJobs(connection) {
  try {
    const [enabledRows] = await connection.execute(
      `SELECT guild_id FROM config WHERE config_key = 'cfgWeeklyRoundupEnabled' AND config_value = '1' AND guild_id != 1`
    );
    for (const { guild_id: guildId } of enabledRows) {
      const [pending] = await connection.execute(
        `SELECT job_id FROM job WHERE job_type = 'weeklyRoundup' AND job_status = 0
         AND CAST(JSON_EXTRACT(payload, '$.guildId') AS CHAR) = ?`,
        [String(guildId)]
      );
      if (pending.length === 0) {
        const runAt = await scheduleNextRoundup(connection, guildId);
        log(`Scheduled missing weeklyRoundup job for guild ${guildId}, next: ${runAt.toISOString()}`, { show: true });
      }
    }
  } catch (err) {
    log(`scheduleAllRoundupJobs error: ${err}`, { show: true });
  }
}

export async function handleWeeklyRoundup(connection, client, payload) {
  const { guildId } = payload;

  const enabled = await getConfigValue(connection, 'cfgWeeklyRoundupEnabled', guildId);
  if (enabled !== '1') return;

  const [channelIdRaw, feedChannelIdRaw] = await Promise.all([
    getConfigValue(connection, 'cfgWeeklyRoundupChannelId', guildId),
    getConfigValue(connection, 'cfgStoryFeedChannelId', guildId)
  ]);
  const targetChannelId = (channelIdRaw && channelIdRaw !== 'cfgWeeklyRoundupChannelId')
    ? channelIdRaw : feedChannelIdRaw;

  if (!targetChannelId || targetChannelId === 'cfgStoryFeedChannelId') {
    log(`weeklyRoundup: no channel configured for guild ${guildId}`, { show: true });
    await scheduleNextRoundup(connection, guildId);
    return;
  }

  try {
    const stats = await generateRoundupStats(connection, guildId);
    const embed = await buildRoundupEmbed(connection, client, guildId, stats);
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(targetChannelId);
    await channel.send({ embeds: [embed] });
    log(`Weekly roundup posted for guild ${guild.name}`, { show: true, guildName: guild.name });
  } catch (err) {
    log(`weeklyRoundup failed for guild ${guildId}: ${err}`, { show: true });
    throw err;
  }

  await scheduleNextRoundup(connection, guildId);
}
