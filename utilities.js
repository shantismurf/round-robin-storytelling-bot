import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

export function loadConfig() {
  const cfgPath = path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error(`${formattedDate()}: Missing config.json. Copy config.example.json and fill values.`);
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
      console.log('Database connected successfully');
      return this.pool;
    } catch (error) {
      console.error(`${formattedDate()}: Database connection failed:`, error.message);
      throw error;
    }
  }

  async disconnect() {
    if (this.pool) {
      try {
        await this.pool.end();
        this.pool = null;
        console.log('Database disconnected successfully');
      } catch (error) {
        console.error(`${formattedDate()}: Database disconnection failed:`, error.message);
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
export function debugLog(...args) { if (_testMode) console.log(...args); }

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
    console.error(`${formattedDate()}: resolveStoryId failed:`, err);
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
    console.error(`${formattedDate()}: Config lookup failed for key '${Array.isArray(key) ? key.join(', ') : key}':`, error);
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
    console.error(`${formattedDate()}: Admin role '${adminRoleName}' not found - skipping admin permissions`);
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
          console.error(`${formattedDate()}: Failed to add admin ${member.displayName} to private thread:`, error);
        }
      }
    }
  }
  
  return thread;
}