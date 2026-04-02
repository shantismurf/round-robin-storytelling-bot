import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

export function loadConfig() {
  const cfgPath = path.resolve(process.cwd(), 'config.json');
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
export function log(message, { show = false, guildName = null } = {}) {
  if (!_testMode && !show) return;
  const guildTag = guildName ? ` (${guildName})` : '';
  console.log(`${formattedDate()}${guildTag}: ${message}`);
}

/**
 * Resolve a guild-local story number (guild_story_id) to the internal PK (story_id).
 * Returns the internal story_id, or null if not found.
 */
export async function resolveStoryId(connection, guildId, guildStoryId) {
  try {
    const [rows] = await connection.execute(
      `SELECT story_id FROM story WHERE guild_id = ? AND guild_story_id = ?`,
      [guildId, guildStoryId]
    );
    return rows[0]?.story_id ?? null;
  } catch (err) {
    log(`resolveStoryId failed: ${err}`, { show: true });
    return null;
  }
}

export async function isGuildConfigured(connection, guildId) {
  const val = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
  return val && val !== 'cfgStoryFeedChannelId';
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
        if (!result[k]) result[k] = k;
      }
      return result;
    }
    const [configRows] = await connection.execute(
      `SELECT config_value FROM config WHERE config_key = ? AND guild_id IN (1, ?) ORDER BY (guild_id = ?) DESC LIMIT 1`,
      [key, guildId, guildId]
    );
    return configRows[0]?.config_value || key;
  } catch (error) {
    log(`Config lookup failed for key '${Array.isArray(key) ? key.join(', ') : key}': ${error}`, { show: true });
    if (Array.isArray(key)) {
      return Object.fromEntries(key.map(k => [k, k]));
    }
    return key;
  }
}

export async function sendUserMessage(connection, interaction, storyWriterId, cfgMessageKey) {
  // Get writer and story info
  const [writerInfo] = await connection.execute(
    `SELECT sw.discord_user_id, s.guild_id 
     FROM story_writer sw 
     JOIN story s ON sw.story_id = s.story_id 
     WHERE sw.story_writer_id = ?`,
    [storyWriterId]
  );
  const { discord_user_id, guild_id } = writerInfo[0];
  
  // Get messages from config, use dm key name to get mention key name
  const dmMessage = await getConfigValue(connection,cfgMessageKey, guild_id);
  const mentionKey = cfgMessageKey.replace('txtDM', 'txtMention'); // txtDMTurnStart -> txtMentionTurnStart
  const mentionMessage = await getConfigValue(connection,mentionKey, guild_id);
  
  try {
    const user = await interaction.client.users.fetch(discord_user_id);
    await user.send(dmMessage);
    return `${formattedDate()}:  ` + cfgMessageKey + ' DM sent successfully';
  } catch (dmError) {
    const storyFeedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guild_id);
    const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
    await channel.send(`<@${discord_user_id}> ${mentionMessage}`);
    return `${formattedDate()}:  ` + cfgMessageKey + ' Mention sent in channel';
  }
}

/**
 * Split entry content into chunks with character positions.
 * Used by the edit flow to paginate long entries without losing position info.
 * @param {string} content
 * @param {number} maxChunkSize - max chars per chunk (default 3500, leaves modal headroom)
 * @returns {{ text: string, start: number, end: number }[]}
 */
export function chunkEntryContent(content, maxChunkSize = 3500) {
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

export function replaceTemplateVariables(template, keyValueMap) {
  let result = template;
  for (const [key, value] of Object.entries(keyValueMap)) {
    result = result.replaceAll(`[${key}]`, value);
  }
  return result;
}

/**
 * Creates a Discord thread with appropriate permissions
 * @param {Object} interaction - Discord interaction object
 * @param {string} guildID - Guild ID
 * @param {Object} keyValueMap - Configuration object containing:
 *   - titleTemplateKey: Config key for thread title template
 *   - threadType: ChannelType.PublicThread or ChannelType.PrivateThread
 *   - reason: Reason for audit log
 *   - targetUserId: (optional) User ID for thread permissions
 *   - Any template variables for title replacement (story_id, etc.)
 * @returns {Object} Created Discord thread
 */
export async function createThread(interaction, guildID, keyValueMap) {
  // Set up thread configuration
  const { titleTemplateKey, threadType, reason, targetUserId } = keyValueMap;
  const storyFeedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guildID);
  const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
  
  if (!channel) {
    throw new Error(`${formattedDate()}: Story feed channel not found`);
  }
  
  // Get admin role (used for both public and private thread permissions)
  const adminRoleName = await getConfigValue(connection,'cfgAdminRoleName', guildID);
  const adminRole = interaction.guild.roles.cache.find(r => r.name === adminRoleName);
  
  if (!adminRole) {
    log(`Admin role '${adminRoleName}' not found - skipping admin permissions`, { show: true });
  }
  
  // Get and build thread title
  const titleTemplate = await getConfigValue(connection,titleTemplateKey, guildID);
  const threadTitle = replaceTemplateVariables(titleTemplate, keyValueMap);
  
  // Create thread
  const thread = await channel.threads.create({
    name: threadTitle,
    type: threadType,
    reason: reason
  });
  
  // Set permissions if needed
  if (threadType === ChannelType.PublicThread && targetUserId) {
    // Public thread with restricted permissions
    await thread.permissionOverwrites.create(interaction.guild.roles.everyone, {
      SendMessages: false,
      AddReactions: true,
      ViewChannel: true
    });
    
    await thread.permissionOverwrites.create(targetUserId, {
      SendMessages: true,
      ViewChannel: true
    });
    
    if (adminRole) {
      await thread.permissionOverwrites.create(adminRole.id, {
        SendMessages: true,
        ManageMessages: true,
        ViewChannel: true
      });
    }
  } else if (threadType === ChannelType.PrivateThread && targetUserId) {
    // Private thread - add target user and admin
    await thread.members.add(targetUserId);
    if (adminRole) {
      // Add each admin user individually (Discord limitation for private threads)
      for (const member of adminRole.members.values()) {
        try {
          await thread.members.add(member.id);
        } catch (error) {
          log(`Failed to add admin ${member.displayName} to private thread: ${error}`, { show: true });
        }
      }
    }
  }
  
  return thread;
}