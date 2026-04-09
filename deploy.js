/**
 * deploy.js — Run all pre-launch steps in order.
 * Safe to run every time you push an update; all steps are idempotent.
 *
 *   npm run deploy
 *
 * Steps:
 *   1. Database migrations  — database-setup.js  — adds any new columns/keys to existing tables
 *   2. Config sync          — sync-config.js     — inserts missing config keys, updates changed values
 *   3. Command registration — deploy-commands.js — registers slash commands with Discord (guild or global)
 */

import { fileURLToPath } from 'url';
import { DB, loadConfig, formattedDate } from './utilities.js';
import { setupDatabase, dbSetup } from './database-setup.js';
import { deployCommands } from './deploy-commands.js';
import { syncConfig } from './sync-config.js';

function header(label) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(50));
}

async function stepMigrations(config, connection) {
  header('Step 1 of 3 — Database schema + migrations');
  await setupDatabase(config);  // creates tables from init.sql if this is a fresh install
  await dbSetup(connection);    // applies incremental migrations to existing tables
  console.log(`${formattedDate()}: Migrations complete.`);
}

async function stepSyncConfig(connection) {
  header('Step 2 of 3 — Config sync');
  await syncConfig(connection);
  console.log(`\n${formattedDate()}: Config sync complete.`);
}

async function stepDeployCommands(config) {
  header('Step 3 of 3 — Slash command registration');
  await deployCommands(config);
  console.log(`\n${formattedDate()}: Command registration complete.`);
}

export async function main() {
  const config = loadConfig();

  if (!config.clientId) throw new Error('Missing clientId in config.json.');
  if (config.testMode && !config.guildId) throw new Error('Missing guildId in config.json (required for test mode).');

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Round Robin StoryBot — Deploy`);
  console.log(`  ${config.testMode ? 'TEST MODE' : 'PRODUCTION'}`);
  console.log('═'.repeat(50));

  const db = new DB(config.db);
  const connection = await db.connect();

  try {
    await stepMigrations(config, connection);
    await stepSyncConfig(connection);
    await stepDeployCommands(config);

    console.log(`\n${'═'.repeat(50)}`);
    console.log('  Deploy complete.');
    console.log('═'.repeat(50));
  } finally {
    await db.disconnect();
  }
}

// Only run automatically when executed directly (node deploy.js), not when imported by index.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`${formattedDate()}: Deploy failed:`, err);
    process.exit(1);
  });
}
