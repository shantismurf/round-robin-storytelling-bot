/**
 * post-privacy-policy.js
 * Manual override for posting/updating the privacy policy in the hub server's
 * #rules channel. The normal path is automatic — deploy.js runs syncPrivacyPolicy()
 * on every deploy — so you only need this if you want to force a repost outside
 * of a deploy (e.g. to test a wording change).
 *
 *   node helper/post-privacy-policy.js            (dry run — prints the policy text)
 *   node helper/post-privacy-policy.js --send     (actually posts/edits and pins)
 */

import { Client, GatewayIntentBits, Events } from 'discord.js';
import { DB, loadConfig } from '../utilities.js';
import { POLICY_TEXT, syncPrivacyPolicy } from '../privacy-policy.js';

const SEND = process.argv.includes('--send');

const config = loadConfig();
const db = new DB(config.db);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (!SEND) {
    console.log(`\n--- Dry run: pass --send to post/edit the pinned message in the hub's #rules channel ---\n`);
    console.log(POLICY_TEXT);
    return client.destroy();
  }

  const connection = await db.connect();
  try {
    const result = await syncPrivacyPolicy(client, connection);
    console.log(result.success ? '✅ Privacy policy synced.' : '❌ Privacy policy sync failed — check logs.');
  } finally {
    await db.disconnect();
    client.destroy();
  }
});

client.login(config.token);
