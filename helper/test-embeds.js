/**
 * test-embeds.js
 * Posts help page embeds and the weekly roundup to the test server channel
 * so you can preview formatting and check character counts before deploying.
 *
 * Usage:
 *   node test-embeds.js            -- posts all help pages + roundup
 *   node test-embeds.js help       -- help pages only
 *   node test-embeds.js roundup    -- roundup only
 *
 * Hardcoded to test server — safe to commit since it's gitignored.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { DB, loadConfig } from './utilities.js';
import { handleHelp, handleHelpSelect, handleWriterHelp, handleAdminHelp } from './faq.js';
import { generateRoundupStats, buildRoundupEmbed } from './story/roundup.js';

const TEST_GUILD_ID   = '1503426199064412362';
const TEST_CHANNEL_ID = '1503426199584641196';

// Uses guild_id=1 (hub defaults) for config lookups so you see production content
const CONFIG_GUILD_ID = '1';

// Builds a fake interaction that routes replies to the test channel
function fakeInteraction(channel, client) {
  let lastReply = null;
  return {
    user:  { id: 'test-user' },
    guild: { id: CONFIG_GUILD_ID, name: 'Test' },
    customId: '',
    async deferReply()  {},
    async deferUpdate() {},
    async reply(payload) {
      lastReply = payload;
      await channel.send(payload);
    },
    async editReply(payload) {
      lastReply = payload;
      await channel.send(payload);
    },
    _getLastReply() { return lastReply; },
  };
}

const PAGE_LABELS = [
  'Round Robin StoryBot Overview',
  'Your Stories & Turns',
  'Create a New Story — General Options',
  'Create a New Story — Join Options & Metadata',
  'Managing a Story',
  'Reading & Editing',
  'Writer Command Reference',
  'StoryAdmin Commands',
];

async function postHelpPages(channel, connection, client) {
  console.log('── Help Pages ──');
  const interaction = fakeInteraction(channel, client);

  // ToC
  console.log('ToC');
  await handleHelp(connection, interaction);

  // Pages 1–7 via handleHelpSelect
  for (let i = 0; i < 8; i++) {
    interaction.values = [String(i)];
    await handleHelpSelect(connection, interaction);
    const reply = interaction._getLastReply();
    const len = reply?.embeds?.[0]?.data?.description?.length ?? reply?.embeds?.[0]?.description?.length ?? 0;
    const status = len > 4000 ? `❌ OVER LIMIT (${len}/4000)` : `✅ ${len}/4000`;
    console.log(`Page ${i + 1} — ${PAGE_LABELS[i]}: ${status}`);
  }
}

async function postRoundup(channel, connection, client) {
  console.log('\n── Weekly Roundup ──');
  const stats = await generateRoundupStats(connection, TEST_GUILD_ID);
  const embed = await buildRoundupEmbed(connection, client, TEST_GUILD_ID, stats);
  const embedData = embed.toJSON();
  const descLen = embedData.description?.length ?? 0;
  const fieldLens = (embedData.fields ?? []).map(f => f.name.length + f.value.length);
  const totalLen = descLen + fieldLens.reduce((a, b) => a + b, 0);
  console.log(`  Total embed content: ${totalLen} chars`);
  (embedData.fields ?? []).forEach(f =>
    console.log(`  Field "${f.name}": ${f.value.length} chars`)
  );
  await channel.send({ content: '**Test: Weekly Roundup**', embeds: [embed] });
}

async function main() {
  const mode = process.argv[2] ?? 'all';
  const config = loadConfig();
  const db = new DB(config.db);
  const connection = await db.connect();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.token);
  await new Promise(resolve => client.once('clientReady', resolve));

  try {
    const guild   = await client.guilds.fetch(TEST_GUILD_ID);
    const channel = await guild.channels.fetch(TEST_CHANNEL_ID);
    console.log(`Posting to #${channel.name} in ${guild.name}`);

    if (mode === 'all' || mode === 'help')    await postHelpPages(channel, connection, client);
    if (mode === 'all' || mode === 'roundup') await postRoundup(channel, connection, client);

    console.log('\nDone.');
  } finally {
    await client.destroy();
    await db.disconnect();
  }
}

main().catch(err => {
  console.error('test-embeds.js failed:', err);
  process.exit(1);
});
