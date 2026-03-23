/**
 * deploy.js — Run all pre-launch steps in order.
 * Safe to run every time you push an update; all steps are idempotent.
 *
 *   npm run deploy
 *
 * Steps:
 *   1. Database migrations  — adds any new columns/keys to existing tables
 *   2. Config sync          — inserts missing config keys, updates changed values
 *   3. Command registration — registers slash commands with Discord (guild or global)
 */

import fs from 'fs';
import { DB, loadConfig, formattedDate } from './utilities.js';
import { runMigrations } from './database-setup.js';
import { REST, Routes } from 'discord.js';

function header(label) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(50));
}

function parseConfigEntries(sql) {
  const entries = [];
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

async function stepMigrations(connection) {
  header('Step 1 of 3 — Database migrations');
  await runMigrations(connection);
  console.log(`${formattedDate()}: Migrations complete.`);
}

async function stepSyncConfig(connection) {
  header('Step 2 of 3 — Config sync');

  const sql = fs.readFileSync('./db/sample_config.sql', 'utf8');
  const fileEntries = parseConfigEntries(sql);

  if (fileEntries.length === 0) {
    console.log('No entries parsed from sample_config.sql — check the file format.');
    return;
  }
  console.log(`${formattedDate()}: Parsed ${fileEntries.length} entries from sample_config.sql`);

  const [dbRows] = await connection.execute('SELECT config_key, config_value, guild_id FROM config');
  const dbMap = new Map(dbRows.map(r => [`${r.guild_id}:${r.config_key}`, r.config_value]));
  console.log(`${formattedDate()}: Found ${dbRows.length} entries in the database`);

  const missing = [];
  const changed = [];

  for (const entry of fileEntries) {
    const dbKey = `${entry.guild_id}:${entry.config_key}`;
    if (!dbMap.has(dbKey)) {
      missing.push(entry);
    } else if (dbMap.get(dbKey) !== entry.config_value) {
      changed.push({ ...entry, old_value: dbMap.get(dbKey) });
    }
  }

  if (missing.length === 0) {
    console.log('No missing config entries.');
  } else {
    console.log(`\nInserting ${missing.length} missing config entries:`);
    for (const entry of missing) {
      console.log(`  + ${entry.config_key}`);
      await connection.execute(
        'INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES (?, ?, ?, ?)',
        [entry.config_key, entry.config_value, entry.language_code, entry.guild_id]
      );
    }
  }

  if (changed.length === 0) {
    console.log('No changed config entries.');
  } else {
    console.log(`\nUpdating ${changed.length} changed config entries:`);
    for (const entry of changed) {
      console.log(`  ~ ${entry.config_key}`);
      await connection.execute(
        'UPDATE config SET config_value = ? WHERE config_key = ? AND guild_id = ?',
        [entry.config_value, entry.config_key, entry.guild_id]
      );
    }
  }

  const fileKeys = new Set(fileEntries.map(e => `${e.guild_id}:${e.config_key}`));
  const extras = dbRows.filter(r => !fileKeys.has(`${r.guild_id}:${r.config_key}`));
  if (extras.length > 0) {
    console.log(`\nNote: ${extras.length} key(s) in DB not in sample_config.sql (custom/manual — not touched):`);
    extras.forEach(r => console.log(`  ? ${r.config_key} (guild ${r.guild_id})`));
  }

  console.log(`\n${formattedDate()}: Config sync complete.`);
}

async function stepDeployCommands(config) {
  header('Step 3 of 3 — Slash command registration');

  const commands = [];
  const files = fs.readdirSync('./commands').filter(f => f.endsWith('.js'));
  for (const file of files) {
    const command = await import(`./commands/${file}`);
    if (command.default?.data) {
      commands.push(command.default.data.toJSON());
      console.log(`  Loaded: ${command.default.data.name}`);
    }
  }

  const rest = new REST().setToken(config.token);

  if (config.testMode) {
    console.log(`\nTEST MODE: Registering ${commands.length} command(s) to guild ${config.guildId}...`);
    const result = await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    console.log(`${formattedDate()}: Registered ${result.length} command(s) to guild (instant).`);
  } else {
    console.log(`\nPRODUCTION: Registering ${commands.length} command(s) globally...`);
    const result = await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commands }
    );
    console.log(`${formattedDate()}: Registered ${result.length} command(s) globally (up to 1 hour to propagate).`);
  }
}

async function main() {
  const config = loadConfig();

  if (!config.clientId) {
    console.error('Missing clientId in config.json.');
    process.exit(1);
  }
  if (config.testMode && !config.guildId) {
    console.error('Missing guildId in config.json (required for test mode).');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Round Robin StoryBot — Deploy`);
  console.log(`  ${config.testMode ? 'TEST MODE' : 'PRODUCTION'}`);
  console.log('═'.repeat(50));

  const db = new DB(config.db);
  const connection = await db.connect();

  try {
    await stepMigrations(connection);
    await stepSyncConfig(connection);
    await stepDeployCommands(config);

    console.log(`\n${'═'.repeat(50)}`);
    console.log('  Deploy complete. Restart the bot to apply changes.');
    console.log('═'.repeat(50));
  } finally {
    await db.disconnect();
  }
}

main().catch(err => {
  console.error(`${formattedDate()}: Deploy failed:`, err);
  process.exit(1);
});
