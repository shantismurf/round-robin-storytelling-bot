/**
 * broadcast.js
 * Sends a hub announcement embed to every configured guild's story feed
 * channel. Replaces the old "post `# 📢 ...` in the hub channel" trigger —
 * run manually from a local machine with DB access instead of listening
 * for a magic message in a live gateway handler.
 *
 * Edit ANNOUNCEMENT below, then:
 *   node helper/broadcast.js            (dry run — lists target guilds only)
 *   node helper/broadcast.js --send     (actually sends)
 */

import { Client, GatewayIntentBits, EmbedBuilder, Events } from 'discord.js';
import { DB, loadConfig, getConfigValue, isGuildConfigured } from '../utilities.js';

const ANNOUNCEMENT = `# 📢 Announcement title goes here

Announcement body goes here.`;

const SEND = process.argv.includes('--send');

const config = loadConfig();
const db = new DB(config.db);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const connection = await db.connect();

  try {
    const [hubServerId, announcementTitle, announcementFooter] = await Promise.all([
      getConfigValue(connection, 'cfgHubServerId'),
      getConfigValue(connection, 'txtHubAnnouncementTitle'),
      getConfigValue(connection, 'txtHubAnnouncementFooter'),
    ]);

    const embed = new EmbedBuilder()
      .setTitle(announcementTitle)
      .setDescription(ANNOUNCEMENT.slice(0, 4096))
      .setColor(0xe91e63)
      .setFooter({ text: announcementFooter });

    let sent = 0;
    let skipped = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        if (guild.id === hubServerId) { skipped++; continue; }
        if (!await isGuildConfigured(connection, guild.id)) { skipped++; continue; }
        const changelogEnabled = await getConfigValue(connection, 'cfgChangelogEnabled', guild.id);
        if (changelogEnabled === '0') { skipped++; continue; }
        const feedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guild.id);

        if (!SEND) {
          console.log(`[dry run] would send to ${guild.name} (${guild.id}) — channel ${feedChannelId}`);
          sent++;
          continue;
        }

        const channel = await guild.channels.fetch(feedChannelId);
        if (!channel) { skipped++; continue; }
        await channel.send({ embeds: [embed] });
        console.log(`✅ Sent to ${guild.name} (${guild.id})`);
        sent++;
      } catch (err) {
        if (err?.code === 'GuildChannelUnowned') {
          console.log(`⚠️  Skipped ${guild.name} (${guild.id}): configured feed channel does not belong to this guild — config may be stale`);
        } else {
          console.log(`❌ Failed for ${guild.name} (${guild.id}): ${err.message}`);
        }
        skipped++;
      }
    }
    console.log(`\nDone — ${SEND ? 'sent' : 'would send'} ${sent}, skipped ${skipped}.`);
  } finally {
    await db.disconnect();
    client.destroy();
  }
});

client.login(config.token);
