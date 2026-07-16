import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { STORY_STATUS, TURN_STATUS, JOB_STATUS, WRITER_STATUS, ENTRY_STATUS } from './constants.js';

export function loadConfig() {
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config.json');
  if (!fs.existsSync(cfgPath)) {
    log('Missing config.json. Copy config.example.json and fill values.', { show: true });
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}
export function formattedDate() {
    let now = new Date();
    now = now.toISOString().replace(/\.\d+Z$/, '')
    now = now.replace('T', ' ');
    return now;
}
export function discordTimestamp (input, form) {
    const unixSeconds = Math.floor(input / 1000);
    const result = `<t:${unixSeconds}:${form}>`; 
    return result;
    /*
    Style	Description	Example Output
    t	Short Time	8:24 PM
    T	Long Time	8:24:15 PM
    d	Short Date	04/26/2026
    D	Long Date	April 26, 2026
    f	Short Date/Time	April 26, 2026 8:24 PM
    F	Long Date/Time	Sunday, April 26, 2026 8:24 PM
    R	Relative Time	2 minutes ago or in 5 years
     */
}
export class DB {
  constructor(dbConfig) {
    this.dbConfig = dbConfig;
    this.connection = null;
  }
  
  async connect() {
    try {
      this.pool = mysql.createPool({
        host: this.dbConfig.host,
        port: this.dbConfig.port,
        user: this.dbConfig.user,
        password: this.dbConfig.password,
        database: this.dbConfig.database,
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectionLimit: 5,
        waitForConnections: true,
        timezone: '+00:00'
      });
      await this.pool.execute('SELECT 1');
      this.connection = this.pool;
      log('Database connected successfully', { show: true });
      return this.pool;
    } catch (error) {
      log(`Database connection failed: ${error.message}`, { show: true });
      throw error;
    }
  }

  async disconnect() {
    if (this.pool) {
      try {
        await this.pool.end();
        this.pool = null;
        log('Database disconnected successfully', { show: true });
      } catch (error) {
        log(`Database disconnection failed: ${error.message}`, { show: true });
        throw error;
      }
    }
  }
} 

// Sanitize input for Discord embed fields
export function sanitize(input, maxLength = 1021) {
    input = (!input ? '' : input);
    input = input
        .replace(/&quot;|&#34;/g, '\"')
        .replace(/&amp;|&#38;/g, '&')
        .replace(/&apos;|&#39;/g, '\'')
        .replace(/&nbsp;/g, ' ');
    //Special characters such as asterisks (*), underscores (_), and tildes (~) 
    //that are to be displayed must be escaped with the \ character.
    input = input
        .replace(/[\*]/g, '\\*')
        .replace(/[\_]/g, '\\_')
        .replace(/[\~]/g, '\\~');
    //replace common html tags with markdown
    input = input
        .replace(/<p[^>]*>/gi, '')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<s>/gi, '~~')
        .replace(/<\/s>/gi, '~~')
        .replace(/<i>/gi, '*')
        .replace(/<\/i>/gi, '*')
        .replace(/<b>/gi, '**')
        .replace(/<\/b>/gi, '**')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/gi, '')
        .replace(/\n\n\n/gi, '\n\n'); //remove excess new lines
    if (input.length > maxLength) {  //limit values to maxLength or 1024(1021+3) characters
        input = input.substring(0, maxLength) + '...';
    }
    return input;
}
export function sanitizeModalInput(input, maxLength = 1024, multiline = false) {
    if (!input) return '';
    let out = input
        .replace(/[\u200B-\u200D\uFEFF]/g, '');   // Remove zero-width chars
    if (multiline) {
        out = out
            .replace(/\r\n/g, '\n')               // Normalize line endings
            .replace(/[ \t]+/g, ' ')              // Collapse spaces/tabs but keep newlines
            .trim();
    } else {
        out = out
            .replace(/\s+/g, ' ')                 // Collapse all whitespace including newlines
            .trim();
    }
    return out.substring(0, maxLength);
}

let _testMode = false;
export function setTestMode(value) { _testMode = !!value; }

let _hubLogClient = null;
let _hubLogChannelId = null;

export function setHubLogClient(client, channelId) {
  _hubLogClient = client;
  _hubLogChannelId = channelId;
}

const HUB_LOG_PATTERNS = [
  'failed', 'error', 'Error', 'FAILED',
  'Config key not found', 'Config lookup failed',
  'not configured', 'Unhandled interaction', 'Unknown job type',
  'Setup required: blocked',
];

function shouldPostToHub(message) {
  if (typeof message !== 'string') return false;
  return HUB_LOG_PATTERNS.some(p => message.includes(p));
}

function postToHubChannel(message) {
  if (!_hubLogClient || !_hubLogChannelId) return;
  const text = typeof message === 'string' ? message : String(message);
  _hubLogClient.channels.fetch(_hubLogChannelId)
    .then(channel => channel.send(text.slice(0, 2000)))
    .catch(() => {});
}

/**
 * Unified Dynamic Logger
 * Detects content type and renders strings, tables, or deep objects.
 * Usage:
 *   log("Simple message");
 *   log("New guild registered", { show: true, hub: true });
 *   log(["Label", dataArray, { detail: 'obj' }], { show: true });
 *
 * Hub log: fires automatically when show:true and the message matches a known
 * error/problem pattern, or when hub:true is passed explicitly.
 */
export function log(content, { show = false, guildName = null, hub = false } = {}) {
  if (!_testMode && !show) return;

  const guildTag = guildName ? ` (${guildName})` : '';
  const timestamp = `${formattedDate()}${guildTag}: `;

  // Helper to handle specific data type rendering
  const renderItem = (item) => {
    if (Array.isArray(item)) {
      const activeKeys = [...new Set(item.flatMap(obj =>
        Object.keys(obj || {}).filter(key =>
          obj[key] !== null && obj[key] !== undefined && obj[key] !== ''
        )
      ))];
      console.table(item, activeKeys);
    } else if (typeof item === 'object' && item !== null) {
      console.dir(item, { depth: null, colors: true });
    } else {
      process.stdout.write(String(item) + '\n');
    }
  };

  // If content is an array, we assume it's a "Bundle" (Label + Data)
  if (Array.isArray(content) && content.some(i => typeof i === 'object')) {
    console.log(timestamp);
    content.forEach(renderItem);
  } else {
    process.stdout.write(timestamp);
    renderItem(content);
  }

  // Post to hub log channel if explicitly flagged or message matches error patterns
  if (show && (hub || shouldPostToHub(content))) {
    const guildPrefix = guildName ? `(${guildName}) ` : '';
    postToHubChannel(`${guildPrefix}${typeof content === 'string' ? content : '[non-string log]'}`);
  }
}

/**
 * Extract a guild-local story number from a submitted story_id option value.
 * Handles the normal case (a bare numeric string) and the case where Discord's
 * client submitted the autocomplete label instead of its value (e.g. "Title (#5)").
 * Returns an integer, or NaN if no number can be recovered.
 */
export function parseGuildStoryId(rawValue) {
  if (rawValue == null) return NaN;
  const str = String(rawValue);
  const labelMatch = str.match(/\(#(\d+)\)\s*$/);
  if (labelMatch) return parseInt(labelMatch[1], 10);
  return parseInt(str, 10);
}

/**
 * Resolve a guild-local story number (guild_story_id) to the internal PK (story_id).
 * Returns the internal story_id, or null if not found.
 */
export async function resolveStoryId(connection, guildId, guildStoryId) {
  const numericId = parseGuildStoryId(guildStoryId);
  try {
    const [rows] = await connection.execute(
      `SELECT story_id FROM story WHERE guild_id = ? AND guild_story_id = ?`,
      [guildId, numericId]
    );
    if (rows.length === 0) {
      log(`resolveStoryId: no story found for guild_story_id=${numericId} (raw="${guildStoryId}") in guild ${guildId}`, { show: true });
      return null;
    }
    return rows[0].story_id;
  } catch (err) {
    log(`resolveStoryId failed for guild_story_id=${numericId} (raw="${guildStoryId}") guild ${guildId}: ${err?.stack ?? err}`, { show: true });
    return null;
  }
}

export async function isGuildConfigured(connection, guildId) {
  const [rows] = await connection.execute(
    `SELECT config_value FROM config WHERE config_key = 'cfgStoryFeedChannelId' AND guild_id = ?`,
    [guildId]
  );
  return rows.length > 0 && !!rows[0].config_value;
}

/**
 * Mark every active/paused story in a guild as closed and cancel its pending jobs.
 * Used when the bot discovers a guild no longer has it installed (DiscordAPIError
 * 10004 "Unknown Guild"), whether via the GuildDelete event, a failed status refresh,
 * or a job that fails because its guild is gone.
 */
export async function closeOrphanedGuildStories(connection, guildId) {
  // End active turns before flipping story_status, since the join below only
  // matches turns belonging to still-open (1/2/4) stories.
  const [turnResult] = await connection.execute(
    `UPDATE turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     JOIN story s ON sw.story_id = s.story_id
     SET t.turn_status = ?, t.ended_at = NOW()
     WHERE s.guild_id = ? AND s.story_status IN (?, ?, ?) AND t.turn_status = ?`,
    [TURN_STATUS.ENDED, guildId, STORY_STATUS.ACTIVE, STORY_STATUS.PAUSED, STORY_STATUS.DELAYED, TURN_STATUS.ACTIVE]
  );
  const [storyResult] = await connection.execute(
    `UPDATE story SET story_status = ?, closed_at = NOW() WHERE guild_id = ? AND story_status IN (?, ?, ?)`,
    [STORY_STATUS.CLOSED, guildId, STORY_STATUS.ACTIVE, STORY_STATUS.PAUSED, STORY_STATUS.DELAYED]
  );
  const [jobResult] = await connection.execute(
    `UPDATE job SET job_status = ? WHERE job_status IN (?, ?) AND CAST(JSON_EXTRACT(payload, '$.guildId') AS CHAR) = ?`,
    [JOB_STATUS.CANCELLED, JOB_STATUS.PENDING, JOB_STATUS.IN_PROGRESS, String(guildId)]
  );
  log(`closeOrphanedGuildStories: ended ${turnResult.affectedRows} active turn(s), closed ${storyResult.affectedRows} story/stories, and cancelled ${jobResult.affectedRows} pending job(s) for guild ${guildId}`, { show: true, hub: true });
}

export async function getConfigValue(connection, key, guildId = 1) {
  try {
    if (Array.isArray(key)) {
      const placeholders = key.map(() => '?').join(', ');
      const [rows] = await connection.execute(
        `SELECT config_key, config_value, guild_id FROM config WHERE config_key IN (${placeholders}) AND guild_id IN (1, ?)`,
        [...key, guildId]
      );
      const result = {};
      for (const row of rows) {
        // Prefer guild-specific value over system default
        if (!result[row.config_key] || row.guild_id == guildId) {
          result[row.config_key] = row.config_value;
        }
      }
      // Fall back to key name for any that weren't found
      for (const k of key) {
        if (!result[k]) {
          log(`Config key not found: '${k}' (guild ${guildId})`, { show: true });
          result[k] = k;
        }
      }
      return result;
    }
    const [configRows] = await connection.execute(
      `SELECT config_value FROM config WHERE config_key = ? AND guild_id IN (1, ?) ORDER BY (guild_id = ?) DESC LIMIT 1`,
      [key, guildId, guildId]
    );
    if (!configRows[0]?.config_value) {
      log(`Config key not found: '${key}' (guild ${guildId})`, { show: true });
    }
    return configRows[0]?.config_value || key;
  } catch (error) {
    log(`Config lookup failed for key '${Array.isArray(key) ? key.join(', ') : key}': ${error?.stack ?? error}`, { show: true });
    if (Array.isArray(key)) {
      return Object.fromEntries(key.map(k => [k, k]));
    }
    return key;
  }
}

/**
 * Split entry content into chunks with character positions.
 * Used by the edit flow to paginate long entries without losing position info.
 * @param {string} content
 * @param {number} maxChunkSize - max chars per chunk (default 3800, leaves modal headroom)
 * @returns {{ text: string, start: number, end: number }[]}
 */
export function chunkEntryContent(content, maxChunkSize = 3800) {
  if (content.length <= maxChunkSize) {
    return [{ text: content, start: 0, end: content.length }];
  }

  const chunks = [];
  let pos = 0;

  while (pos < content.length) {
    const remaining = content.slice(pos);
    if (remaining.length <= maxChunkSize) {
      chunks.push({ text: remaining, start: pos, end: content.length });
      break;
    }

    // Try splitting on double line breaks
    let splitAt = -1;
    const doubleBreak = remaining.lastIndexOf('\n\n', maxChunkSize);
    if (doubleBreak > 0) {
      splitAt = doubleBreak + 2; // include the \n\n in the preceding chunk
    }

    // Fall back to single line break
    if (splitAt <= 0) {
      const singleBreak = remaining.lastIndexOf('\n', maxChunkSize);
      if (singleBreak > 0) splitAt = singleBreak + 1;
    }

    // Fall back to last word boundary
    if (splitAt <= 0) {
      const wordBreak = remaining.lastIndexOf(' ', maxChunkSize);
      if (wordBreak > 0) splitAt = wordBreak + 1;
    }

    // Hard split if no break found
    if (splitAt <= 0) splitAt = maxChunkSize;

    chunks.push({ text: remaining.slice(0, splitAt), start: pos, end: pos + splitAt });
    pos += splitAt;
  }

  return chunks;
}

/**
 * Returns the most recent edit info for an entry, or null if none or within grace period.
 * Grace period: author edits within 1 hour of entry creation suppress the read-view footnote.
 */
export async function getEntryEditInfo(connection, entryId, originalAuthorId, createdAt) {
  log(`getEntryEditInfo entry for entry ${entryId}`, { show: false });
  const [rows] = await connection.execute(
    `SELECT edited_by, edited_by_name, edited_at FROM story_entry_edit
     WHERE entry_id = ? ORDER BY edited_at DESC LIMIT 1`,
    [entryId]
  );
  if (rows.length === 0) return null;
  const { edited_by, edited_by_name, edited_at } = rows[0];
  const createdMs = new Date(createdAt).getTime();
  const editedMs  = new Date(edited_at).getTime();
  if (String(edited_by) === String(originalAuthorId) && (editedMs - createdMs) <= 60 * 60 * 1000) {
    return null;
  }
  return { editedByName: edited_by_name, editedAt: edited_at };
}

/**
 * Returns the turn number that will be assigned to the next confirmed entry in a story.
 * Counts only turns that produced a confirmed entry — skipped and timed-out turns are
 * excluded, keeping this consistent with the numbering shown in /story read.
 * Call this at the START of a new turn (before an entry exists), so +1 accounts for
 * the turn that is just beginning.
 */
export async function getTurnNumber(connection, storyId) {
  log(`getTurnNumber entry for story ${storyId}`, { show: false });
  const [result] = await connection.execute(
    `SELECT COUNT(DISTINCT t.turn_id) + 1 AS turn_number
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = ?
     WHERE sw.story_id = ?`,
    [ENTRY_STATUS.CONFIRMED, storyId]
  );
  log(`getTurnNumber result: ${result[0].turn_number} for story ${storyId}`, { show: false });
  return result[0].turn_number;
}

/**
 * Strip the trailing emoji (and the space before it) from a label that's
 * stored with matching emoji on both ends for modal display. Uses grapheme
 * segmentation so multi-codepoint emoji (variation selectors, ZWJ sequences)
 * are removed as a single unit rather than leaving a mangled remainder.
 */
export function trimTrailingEmoji(label) {
  const segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(label)];
  return segments.slice(0, -1).map(s => s.segment).join('').trimEnd();
}

export function replaceTemplateVariables(template, keyValueMap) {
  let result = template;
  for (const [key, value] of Object.entries(keyValueMap)) {
    result = result.replaceAll(`[${key}]`, value);
  }
  result = result.replace(/\{\?([^?]*)\?\}/g, (_, inner) => {
    return /\[[^\]]+\]/.test(inner) ? '' : inner;
  });
  return result;
}

/**
 * Returns true if the interaction user is a server Administrator or has the configured admin role.
 * Requires interaction.member (guild context).
 */
export async function checkIsAdmin(connection, interaction, guildId) {
  log(`checkIsAdmin entry for user ${interaction.user?.username} guild ${guildId}`, { show: false });
  const adminRoleName = await getConfigValue(connection, 'cfgAdminRoleName', guildId);
  const result = interaction.member.permissions.has('Administrator') ||
    (adminRoleName && interaction.member.roles.cache.some(r => r.name === adminRoleName));
  log(`checkIsAdmin result: ${result} for user ${interaction.user?.username}`, { show: false });
  return result;
}

/**
 * Validate if story exists, belongs to guild, and is active (status = 1).
 * Used by write, manage, close, timeleft handlers.
 */
export async function validateStoryAccess(connection, storyId, guildId) {
  log(`validateStoryAccess entry for story ${storyId} guild ${guildId}`, { show: false });
  try {
    const [storyInfo] = await connection.execute(`
      SELECT * FROM story WHERE story_id = ?
    `, [storyId]);

    if (storyInfo.length === 0) {
      log(`validateStoryAccess: story ${storyId} not found`, { show: false });
      return { success: false, error: await getConfigValue(connection,'txtStoryNotFound', guildId) };
    }

    const story = storyInfo[0];

    if (story.guild_id !== guildId) {
      log(`validateStoryAccess: story ${storyId} guild mismatch`, { show: false });
      return { success: false, error: await getConfigValue(connection,'txtStoryWrongGuild', guildId) };
    }

    if (story.story_status !== STORY_STATUS.ACTIVE) {
      log(`validateStoryAccess: story ${storyId} not active (status=${story.story_status})`, { show: false });
      return { success: false, error: await getConfigValue(connection,'txtStoryNotActive', guildId) };
    }

    log(`validateStoryAccess: story ${storyId} valid`, { show: false });
    return { success: true, story };
  } catch (error) {
    log(`validateStoryAccess failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true });
    return { success: false, error: 'internal' };
  }
}

/**
 * Validate if user is the active writer for a story.
 * Used by write and edit handlers.
 */
export async function validateActiveWriter(connection, userId, storyId) {
  log(`validateActiveWriter entry for user ${userId} story ${storyId}`, { show: false });
  try {
    const [writerInfo] = await connection.execute(`
      SELECT sw.discord_user_id as current_writer
      FROM turn t
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
      WHERE sw.story_id = ? AND t.turn_status = ?
      ORDER BY t.turn_id DESC LIMIT 1
    `, [storyId, TURN_STATUS.ACTIVE]);

    if (writerInfo.length === 0 || writerInfo[0].current_writer !== userId) {
      log(`validateActiveWriter: user ${userId} is not the active writer for story ${storyId}`, { show: false });
      const [storyInfo] = await connection.execute(`
        SELECT guild_id FROM story WHERE story_id = ?
      `, [storyId]);

      const guildId = storyInfo[0]?.guild_id;
      return { success: false, error: await getConfigValue(connection,'txtNotYourTurn', guildId) };
    }

    log(`validateActiveWriter: user ${userId} confirmed as active writer for story ${storyId}`, { show: false });
    return { success: true };
  } catch (error) {
    log(`validateActiveWriter failed for user ${userId} story ${storyId}: ${error?.stack ?? error}`, { show: true });
    return { success: false, error: 'internal' };
  }
}

/**
 * Returns true if userId is the creator (oldest active writer) of the story.
 * Used by manage, close, and ping handlers.
 */
export async function checkIsCreator(connection, storyId, userId) {
  const [rows] = await connection.execute(
    `SELECT discord_user_id FROM story_writer WHERE story_id = ? AND sw_status = ? ORDER BY joined_at ASC LIMIT 1`,
    [storyId, WRITER_STATUS.ACTIVE]
  );
  return rows.length > 0 && String(rows[0].discord_user_id) === userId;
}

/**
 * Split text into chunks at paragraph boundaries, staying under maxLen characters.
 * Used by entry preview embeds and the read display system.
 */
export function splitAtParagraphs(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < 50) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Parses a duration string into integer hours (rounded to nearest).
 * Supports d/h/m suffixes, combinations (2d6h), decimals (1.5d), bare numbers (treated as hours).
 */
export function parseDuration(input) {
  if (!input || typeof input !== 'string') return NaN;
  const trimmed = input.trim();
  if (!trimmed) return NaN;

  const combinedPattern = /^\s*(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*$/i;
  const match = trimmed.match(combinedPattern);
  if (match && (match[1] || match[2] || match[3])) {
    const days = parseFloat(match[1] || 0);
    const hours = parseFloat(match[2] || 0);
    const mins = parseFloat(match[3] || 0);
    return Math.round(days * 24 + hours + mins / 60);
  }

  const bare = parseFloat(trimmed);
  if (!isNaN(bare) && /^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(bare);

  return NaN;
}

/**
 * Formats an integer number of hours into a human-readable duration string.
 * < 24h → "X hours"; >= 24h → "X hours (Y days)" or "X hours (Y days, Z hours)"
 */
export function formatDuration(hours) {
  if (!hours && hours !== 0) return String(hours);
  const h = Math.round(hours);
  if (h < 24) return `${h} hours`;
  const days = Math.floor(h / 24);
  const remainder = h % 24;
  if (remainder === 0) return `${h} hours (${days} days)`;
  return `${h} hours (${days} days, ${remainder} hours)`;
}

export function storyLastActivitySQL(storyAlias = 's') {
  return `COALESCE(
    (SELECT MAX(t.ended_at)
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ${storyAlias}.story_id),
    ${storyAlias}.created_at
  )`;
}