/**
 * sync-config.js
 * Compares sample_config.sql against the live config table.
 *
 * Usage:
 *   npm run sync-config                              -- dry run: shows missing and changed entries, makes no changes
 *   npm run sync-config -- --apply                   -- inserts missing entries and updates changed entries
 *   node sync-config.js --set key value              -- directly sets a single key in the DB
 */

import fs from 'fs';
import { formattedDate } from './utilities.js';

function parseConfigEntries(sql) {
  const entries = [];
  // Match each VALUES row: ('key', 'value', 'lang', guild_id)
  // Handles both '' (SQL standard) and \' (MySQL extension) escapes inside strings
  const rowRegex = /\(\s*'((?:[^'\\]|\\.|'')*)'\s*,\s*'((?:[^'\\]|\\.|'')*)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*\)/g;
  let match;
  while ((match = rowRegex.exec(sql)) !== null) {
    entries.push({
      config_key:    match[1].replace(/''/g, "'").replace(/\\'/g, "'"),
      config_value:  match[2].replace(/''/g, "'").replace(/\\'/g, "'").replace(/\\n/g, '\n'),
      language_code: match[3],
      guild_id:      parseInt(match[4])
    });
  }
  return entries;
}
export async function syncConfig(connection) {
  try {
    // Point to the folder where the config files live
    const configDir = './db/config_files'; 
    const files = fs.readdirSync(configDir).filter(f => f.endsWith('.sql'));
    let sql = "";
    // Loop through and combine the files into one massive string
    for (const file of files) {
      const content = fs.readFileSync(path.join(configDir, file), 'utf8');
      sql += content + "\n\n";
    }
    // Parse the aggregated string
    const fileEntries = parseConfigEntries(sql);

    if (fileEntries.length === 0) {
      console.log(`No entries parsed from ${configDir} — check the file formats.`);
      return;
    }
    console.log(`${formattedDate()}: Parsed ${fileEntries.length} total entries from ${files.length} context files`);

    // Get all entries currently in the DB, exclude guild-specific setup keys that are
    // written by /storyadmin setup and vary per server (not managed by sample_config.sql).
    const setupOnlyKeys = [
      'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName',
      'cfgRestrictedFeedChannelId', 'cfgRestrictedMediaChannelId',
      'cfgWeeklyRoundupEnabled', 'cfgWeeklyRoundupChannelId', 'cfgWeeklyRoundupDay', 'cfgWeeklyRoundupHour',
      'cfgHubServerId', 'cfgHubFaqChannelId',
      'cfgFaqThreadOverview', 'cfgFaqThreadWriterCmds', 'cfgFaqThreadStoryCreation',
      'cfgFaqThreadManaging', 'cfgFaqThreadAdminCmds',
    ];
    const placeholders = setupOnlyKeys.map(() => '?').join(',');
    const [dbRows] = await connection.execute(
      `SELECT config_key, config_value, guild_id FROM config WHERE config_key NOT IN (${placeholders})`,
      setupOnlyKeys
    );
    
    const dbMap = new Map(dbRows.map(r => [`${r.guild_id}:${r.config_key}`, r.config_value]));
    console.log(`${formattedDate()}: Found ${dbRows.length} entries in the database\n`);

    const missing = [];
    const changed = [];
    // Convert the array to a Set for faster lookup
    const setupKeysSet = new Set(setupOnlyKeys);
    // Compare File entries vs Database entries
    for (const entry of fileEntries) {
      // Skip this entry if it's a setup-only key
      if (setupKeysSet.has(entry.config_key)) {
        continue; 
      }
      const dbKey = `${entry.guild_id}:${entry.config_key}`;
      if (!dbMap.has(dbKey)) {
        missing.push(entry);
      } else if (dbMap.get(dbKey) !== entry.config_value) {
        changed.push({ ...entry, old_value: dbMap.get(dbKey) });
      }
    }

    // Report / insert missing entries
    if (missing.length === 0) {
      console.log('No missing config entries.');
    } else {
      console.log(`\nInserting ${missing.length} missing config entries:`);
      for (const entry of missing) {
        console.log(`  + ${entry.config_key}`);
        await connection.execute(
          'INSERT IGNORE INTO config (config_key, config_value, language_code, guild_id) VALUES (?, ?, ?, ?)',
          [entry.config_key, entry.config_value, entry.language_code, entry.guild_id]
        );
      }
    }

    // Report / update changed entries
    if (changed.length === 0) {
      console.log('No changed config entries.');
    } else {
      console.log(`\nUpdating ${changed.length} changed config entries:`);
      for (const entry of changed) {
        console.log(`  ~ ${entry.config_key}`);
        console.log(`      was: ${entry.old_value}`);
        console.log(`      now: ${entry.config_value}`);
        await connection.execute(
          'UPDATE config SET config_value = ? WHERE config_key = ? AND guild_id = ?',
          [entry.config_value, entry.config_key, entry.guild_id]
        );
      }
    }

    // Report anything in the DB not in the file
    const fileKeys = new Set(fileEntries.map(e => `${e.guild_id}:${e.config_key}`));
    const extras = dbRows.filter(r => !fileKeys.has(`${r.guild_id}:${r.config_key}`));
    if (extras.length > 0) {
      console.log(`\nNote: ${extras.length} key(s) in DB not found in the config files (will not be touched):`);
      extras.forEach(r => console.log(`  ? ${r.config_key} (guild ${r.guild_id})`));
    }

  } catch (err) {
    console.error(`${formattedDate()}: Sync failed:`, err);
    process.exit(1);
  }
}
