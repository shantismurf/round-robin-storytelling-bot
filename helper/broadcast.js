/**
 * broadcast.js
 * Manual override for sending a hub announcement — the normal path is arming
 * BROADCAST_ARMED in ../broadcast.js and restarting the bot (see deploy.js's
 * hub post sync step). Use this script instead if you have local DB access and
 * want to send without waiting for a deploy, or just want to dry-run it first.
 *
 *   node helper/broadcast.js            (dry run — lists target guilds only)
 *   node helper/broadcast.js --send     (actually sends)
 */

import { Client, GatewayIntentBits, Events } from 'discord.js';
import { DB, loadConfig } from '../utilities.js';
import { sendBroadcast } from '../broadcast.js';

const SEND = process.argv.includes('--send');

const config = loadConfig();
const db = new DB(config.db);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const connection = await db.connect();

  try {
    const { sent, skipped } = await sendBroadcast(client, connection, { dryRun: !SEND });
    console.log(`\nDone — ${SEND ? 'sent' : 'would send'} ${sent}, skipped ${skipped}.`);
  } finally {
    await db.disconnect();
    client.destroy();
  }
});

client.login(config.token);
