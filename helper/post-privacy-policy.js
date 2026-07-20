/**
 * post-privacy-policy.js
 * Posts docs/PRIVACY_POLICY.md to the hub server's #rules channel as a
 * pinned embed. Run manually whenever the policy changes — this is a rare,
 * admin-only action, so it's a terminal script rather than a bot command.
 *
 *   node helper/post-privacy-policy.js            (dry run — prints the embed)
 *   node helper/post-privacy-policy.js --send     (actually posts and pins)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Client, GatewayIntentBits, EmbedBuilder, Events } from 'discord.js';
import { loadConfig } from '../utilities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_CHANNEL_ID = '1499435586740682772';

const policyText = readFileSync(resolve(__dirname, '../docs/PRIVACY_POLICY.md'), 'utf8').trim();

const SEND = process.argv.includes('--send');

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const embed = new EmbedBuilder()
    .setTitle('Round Robin StoryBot — Privacy Policy & Terms of Service')
    .setDescription(policyText.slice(0, 4096))
    .setColor(0xe91e63);

  if (!SEND) {
    console.log(`\n--- Dry run: would post to channel ${RULES_CHANNEL_ID} ---\n`);
    console.log(policyText);
  } else {
    try {
      const channel = await client.channels.fetch(RULES_CHANNEL_ID);
      const message = await channel.send({ embeds: [embed] });
      console.log(`✅ Posted to #${channel.name} (${RULES_CHANNEL_ID})`);
      try {
        await message.pin();
        console.log('📌 Pinned.');
      } catch (err) {
        console.log(`⚠️  Could not pin (bot may be missing Pin Messages permission): ${err.message}`);
      }
    } catch (err) {
      console.log(`❌ Failed to post: ${err.message}`);
    }
  }

  client.destroy();
});

client.login(config.token);
