import { EmbedBuilder } from 'discord.js';
import { getConfigValue, isGuildConfigured, log } from './utilities.js';

// Discord's hard caps for one message: the description of a single embed, and the
// combined total across every embed in the message. A broadcast is one shot to every
// server, so going over has to be caught before anything is sent, not after.
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_MESSAGE_TOTAL_LIMIT = 6000;

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
// story feed channel (skipping guilds that opted out via cfgChangelogEnabled), with the
// txtHubAnnouncementOptOut notice as a second embed. Logs the character count and refuses
// to send at all if the message would exceed Discord's limits, since a broadcast cannot be
// taken back once sent. dryRun logs what would be sent without actually sending — used by
// the manual helper/broadcast.js script; the deploy-triggered path (see deploy.js) always
// sends for real. Both paths log the character count.
export async function sendBroadcast(client, connection, { dryRun = false } = {}) {
  const [hubServerId, hubAnnouncementsChannelId, announcementTitle, announcementFooter, announcementOptOut] = await Promise.all([
    getConfigValue(connection, 'cfgHubServerId', 1),
    getConfigValue(connection, 'cfgHubAnnouncementsChannelId', 1),
    getConfigValue(connection, 'txtHubAnnouncementTitle', 1),
    getConfigValue(connection, 'txtHubAnnouncementFooter', 1),
    getConfigValue(connection, 'txtHubAnnouncementOptOut', 1),
  ]);

  // The opt-out notice rides along as a second embed on every broadcast. getConfigValue
  // returns the key name when a key has no row at all, so treat that as missing rather
  // than posting a raw config key into every server's feed.
  const hasOptOut = announcementOptOut !== 'txtHubAnnouncementOptOut';
  if (!hasOptOut) {
    log('sendBroadcast: txtHubAnnouncementOptOut not configured — sending without the opt-out notice', { show: true, hub: true });
  }

  // Length guard. The host offers no way to preview a broadcast, so this is the only
  // place an oversized announcement can be caught. Discord measures the resolved string,
  // so an escaped backtick in ANNOUNCEMENT costs one character here, not two.
  const optOutChars = hasOptOut ? announcementOptOut.length : 0;
  const totalChars = ANNOUNCEMENT.length + announcementTitle.length + announcementFooter.length + optOutChars;
  log(`sendBroadcast: announcement body ${ANNOUNCEMENT.length} of ${EMBED_DESCRIPTION_LIMIT} characters, ${totalChars} of ${EMBED_MESSAGE_TOTAL_LIMIT} across the whole message`, { show: true });

  if (ANNOUNCEMENT.length > EMBED_DESCRIPTION_LIMIT || totalChars > EMBED_MESSAGE_TOTAL_LIMIT) {
    log(`sendBroadcast failed: announcement too long to send intact — body ${ANNOUNCEMENT.length}/${EMBED_DESCRIPTION_LIMIT}, whole message ${totalChars}/${EMBED_MESSAGE_TOTAL_LIMIT}. Shorten ANNOUNCEMENT in broadcast.js and redeploy. Nothing was sent.`, { show: true, hub: true });
    return { sent: 0, skipped: 0 };
  }

  const embed = new EmbedBuilder()
    .setTitle(announcementTitle)
    .setDescription(ANNOUNCEMENT)
    .setColor(0xe91e63)
    .setFooter({ text: announcementFooter });

  // Second embed so the opt-out line renders its own markdown (footer text does not)
  // and costs nothing against the announcement's own description limit.
  const embeds = [embed];
  if (hasOptOut) {
    embeds.push(new EmbedBuilder().setDescription(announcementOptOut).setColor(0xe91e63));
  }

  // Post to the hub server's own announcements channel first — unlike the old
  // trigger, this message never originates there, so it won't show up unless
  // we send it explicitly.
  if (dryRun) {
    console.log(`[dry run] would send to hub announcements channel ${hubAnnouncementsChannelId}`);
  } else {
    try {
      const hubChannel = await client.channels.fetch(hubAnnouncementsChannelId);
      await hubChannel.send({ embeds });
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
      await channel.send({ embeds });
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
