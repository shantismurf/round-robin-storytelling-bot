import { EmbedBuilder } from 'discord.js';
import { getConfigValue, isGuildConfigured, log } from './utilities.js';

// Edit this before arming a broadcast, then flip BROADCAST_ARMED below to true.
export const ANNOUNCEMENT = `# 📢 Announcement title goes here

Announcement body goes here.`;

// Manual arm/disarm switch — the host has no way to run one-off scripts, so this
// is how a broadcast gets triggered: edit ANNOUNCEMENT above, flip this to true,
// push to main, restart the bot. Flip it back to false afterward. Unlike the FAQ
// and privacy-policy hub posts (idempotent edits-in-place), a broadcast is a
// one-shot send to every configured server's feed channel — deploy.js runs this
// step on every restart, so leaving this armed would resend on the next deploy too.
export const BROADCAST_ARMED = false;

// Sends ANNOUNCEMENT to the hub's announcements channel and every configured guild's
// story feed channel (skipping guilds that opted out via cfgChangelogEnabled).
// dryRun logs what would be sent without actually sending — used by the manual
// helper/broadcast.js script; the deploy-triggered path (see deploy.js) always sends for real.
export async function sendBroadcast(client, connection, { dryRun = false } = {}) {
  const [hubServerId, hubAnnouncementsChannelId, announcementTitle, announcementFooter] = await Promise.all([
    getConfigValue(connection, 'cfgHubServerId', 1),
    getConfigValue(connection, 'cfgHubAnnouncementsChannelId', 1),
    getConfigValue(connection, 'txtHubAnnouncementTitle', 1),
    getConfigValue(connection, 'txtHubAnnouncementFooter', 1),
  ]);

  const embed = new EmbedBuilder()
    .setTitle(announcementTitle)
    .setDescription(ANNOUNCEMENT.slice(0, 4096))
    .setColor(0xe91e63)
    .setFooter({ text: announcementFooter });

  // Post to the hub server's own announcements channel first — unlike the old
  // trigger, this message never originates there, so it won't show up unless
  // we send it explicitly.
  if (dryRun) {
    console.log(`[dry run] would send to hub announcements channel ${hubAnnouncementsChannelId}`);
  } else {
    try {
      const hubChannel = await client.channels.fetch(hubAnnouncementsChannelId);
      await hubChannel.send({ embeds: [embed] });
      log(`sendBroadcast: sent to hub announcements channel (${hubAnnouncementsChannelId})`, { show: true });
    } catch (err) {
      log(`sendBroadcast: failed to send to hub announcements channel: ${err?.stack ?? err}`, { show: true });
    }
  }

  let sent = 0;
  let skipped = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      if (guild.id === hubServerId) { skipped++; continue; }
      if (!await isGuildConfigured(connection, guild.id)) { skipped++; continue; }
      const changelogEnabled = await getConfigValue(connection, 'cfgChangelogEnabled', guild.id);
      if (changelogEnabled === '0') { skipped++; continue; }
      const feedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guild.id);

      if (dryRun) {
        console.log(`[dry run] would send to ${guild.name} (${guild.id}) — channel ${feedChannelId}`);
        sent++;
        continue;
      }

      const channel = await guild.channels.fetch(feedChannelId);
      if (!channel) { skipped++; continue; }
      await channel.send({ embeds: [embed] });
      log(`sendBroadcast: sent to ${guild.name} (${guild.id})`, { show: true, guildName: guild.name });
      sent++;
    } catch (err) {
      if (err?.code === 'GuildChannelUnowned') {
        log(`sendBroadcast: skipped ${guild.name} (${guild.id}) — configured feed channel does not belong to this guild`, { show: true, guildName: guild.name });
      } else {
        log(`sendBroadcast: failed for ${guild.name} (${guild.id}): ${err?.stack ?? err}`, { show: true, guildName: guild.name });
      }
      skipped++;
    }
  }

  log(`sendBroadcast: complete — ${dryRun ? 'would send' : 'sent'} ${sent}, skipped ${skipped}`, { show: true });
  return { sent, skipped };
}
