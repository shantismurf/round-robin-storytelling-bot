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
import { DB, loadConfig, formattedDate, getConfigValue } from './utilities.js';
import { setupDatabase, dbSetup } from './database-setup.js';
import { deployCommands } from './deploy-commands.js';
import { syncConfig } from './sync-config.js';
import { syncFaqPosts } from './faq.js';
import { syncPrivacyPolicy } from './privacy-policy.js';
import { Client, GatewayIntentBits } from 'discord.js';

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
  const result = await syncConfig(connection);
  console.log(`\n${formattedDate()}: Config sync complete.`);
  return result ?? { changedFiles: new Set() };
}

async function stepDeployCommands(config) {
  header('Step 3 of 4 — Slash command registration');
  await deployCommands(config);
  console.log(`\n${formattedDate()}: Command registration complete.`);
}

async function stepSyncHubPosts(config, connection, changedFiles) {
  header('Step 4 of 4 — Hub post sync (FAQ + privacy policy)');
  if (config.testMode) {
    console.log(`${formattedDate()}: Test mode — skipping hub post sync.`);
    return;
  }
  const hubServerId = await getConfigValue(connection, 'cfgHubServerId', 1);
  if (!hubServerId) {
    console.log(`${formattedDate()}: cfgHubServerId not set in config table — skipping hub post sync.`);
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.token);
  await new Promise(resolve => client.once('clientReady', resolve));

  try {
    if (changedFiles.has('config_help.sql')) {
      // Sync FAQ for the hub guild (guild_id=1 defaults)
      const { errors, total } = await syncFaqPosts(client, connection, 1);
      if (errors === 0) {
        console.log(`${formattedDate()}: FAQ sync complete — ${total}/${total} pages updated.`);
      } else {
        console.log(`${formattedDate()}: FAQ sync complete — ${total - errors}/${total} pages updated, ${errors} error(s). Check logs.`);
      }
    } else {
      console.log(`${formattedDate()}: config_help.sql unchanged — skipping FAQ sync.`);
    }

    // Privacy policy has no file-diff signal to gate on (it lives in privacy-policy.js,
    // not a synced config file), so this runs every deploy — an idempotent edit-in-place
    // once a message exists, so the cost of running it unconditionally is one API call.
    const policyResult = await syncPrivacyPolicy(client, connection);
    console.log(policyResult.success
      ? `${formattedDate()}: Privacy policy sync complete.`
      : `${formattedDate()}: Privacy policy sync failed. Check logs.`);
  } finally {
    await client.destroy();
  }
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
    const { changedFiles } = await stepSyncConfig(connection);
    await stepDeployCommands(config);
    await stepSyncHubPosts(config, connection, changedFiles);

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
