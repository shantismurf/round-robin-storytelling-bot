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
import path from 'path';

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

    // Parse per-file so we can track which files contributed changes
    const fileEntriesByFile = new Map();
    let allFileEntries = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(configDir, file), 'utf8');
      const entries = parseConfigEntries(content);
      fileEntriesByFile.set(file, entries);
      allFileEntries = allFileEntries.concat(entries);
    }
    const fileEntries = allFileEntries;

    if (fileEntries.length === 0) {
      console.log(`No entries parsed from ${configDir} — check the file formats.`);
      return;
    }
    console.log(`${formattedDate()}: Parsed ${fileEntries.length} total entries from ${files.length} context files`);

    // Keys written by /storyadmin setup — vary per server, never touched by sync.
    //
    // This list only ever protects a key's guild_id=1 row (the one literally declared in a
    // config_files/*.sql file) from being resynced — it can't protect a specific guild's own
    // saved row, because that row never appears in any file at all, so the comparison loop below
    // never sees it regardless of this list. cfgWeeklyRoundup*/cfgChangelogEnabled being in this
    // list and still having a working guild_id=1 default only works because that default row was
    // synced once, before they were added here — added 2026-09-24: cfgTeenOrLowerOnly and
    // cfgGroundRules were mistakenly added to this list in the same commit that first declared
    // their guild_id=1 default rows in config_storyadmin.sql, which meant those defaults were
    // never actually inserted — every getConfigValue() call for a guild with no row of its own
    // logged "Config key not found" and fell back to the literal key name. Removed; their
    // guild_id=1 defaults need the normal sync path like everything else's.
    const setupOnlyKeys = [
      'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName',
      'cfgRestrictedFeedChannelId', 'cfgRestrictedMediaChannelId',
      'cfgWeeklyRoundupEnabled', 'cfgWeeklyRoundupChannelId', 'cfgWeeklyRoundupDay', 'cfgWeeklyRoundupHour',
      'cfgGuildRegisteredAt', 'cfgChangelogEnabled', 'cfgHubAnnouncementsChannelId',
      'cfgPrivacyPolicyMessageId',
      // Added 2026-09-25. Not a setup key -- runtime state that syncFaqPosts writes after
      // creating the Hub FAQ threads. It was declared in config_system.sql with eight literal
      // thread ids, so every deploy resynced the real ids away and the next FAQ sync tried to
      // delete threads that no longer existed, silently leaving the previous posts up and adding
      // a duplicate set. The trap described above does not apply: the literal row has been
      // removed from config_system.sql entirely, and a guild with no row is exactly the state
      // that makes syncFaqPosts correctly attempt no deletions.
      'cfgFaqPostIds',
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
    const setupKeysSet = new Set(setupOnlyKeys);

    // Build a reverse map from config_key to source filename for change tracking
    const keyToFile = new Map();
    for (const [file, entries] of fileEntriesByFile) {
      for (const entry of entries) {
        keyToFile.set(`${entry.guild_id}:${entry.config_key}`, file);
      }
    }

    const changedFiles = new Set();

    // Compare File entries vs Database entries
    for (const entry of fileEntries) {
      if (setupKeysSet.has(entry.config_key)) continue;
      const dbKey = `${entry.guild_id}:${entry.config_key}`;
      if (!dbMap.has(dbKey)) {
        missing.push(entry);
        changedFiles.add(keyToFile.get(dbKey));
      } else if (dbMap.get(dbKey) !== entry.config_value) {
        changed.push({ ...entry, old_value: dbMap.get(dbKey) });
        changedFiles.add(keyToFile.get(dbKey));
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
      extras.forEach(r => console.log(`  '${r.config_key}',`));
    }

    return { changedFiles };

  } catch (err) {
    console.error(`${formattedDate()}: Sync failed:`, err);
    process.exit(1);
  }
}
