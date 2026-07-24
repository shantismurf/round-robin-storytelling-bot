import { EmbedBuilder } from 'discord.js';
import { getConfigValue, log } from './utilities.js';

// Single source of truth for the policy text posted to the hub server's #rules channel
// and mirrored (in slightly more verbose Markdown form) in docs/PRIVACY_POLICY.md.
// Edit here, bump "Last Updated", and both the automatic deploy-time sync (see
// syncPrivacyPolicy below, wired into deploy.js's hub post-sync step) and the manual
// helper/post-privacy-policy.js script will pick up the change.
export const POLICY_TEXT = `# Round Robin StoryBot Privacy Policy & Terms of Service
-# **Last Updated: July 24, 2026**
## Privacy Policy

By adding Round Robin StoryBot ("the Bot") to your server or interacting with it, you agree to the data collection practices outlined below.
### 1. Data We Collect
We only collect data necessary to provide the Bot's core features — running collaborative, turn-based stories. This includes:
- **Discord User IDs & Display Names:** To identify writers, track whose turn is active, attribute story entries, and handle configuration commands.
- **Story Entry Text:** When you write a turn to a story, the message(s) you post in your private turn thread or submit via a Quick Mode input are read by the Bot and stored as your story entry.
- **Story Metadata:** Titles, summaries, tags, ratings, warnings, and other descriptive fields users provide for a story.
- **Optional Pen Name:** A display alias you may set for a story, separate from your Discord username.
- **Moderation Records:** When a server admin takes an action on a story or writer (e.g. removing a writer, editing an entry), we log the admin's Discord user ID, the action taken, and any reason given.
- **Server Configuration:** Guild, channel, and thread IDs needed to operate the Bot in your server.
- **Story Images:** Images attached to story entries are included in story exports. Images too large to embed directly may be sent to a third-party image resizing service (wsrv.nl) to be shrunk to a manageable size before embedding — only the image file itself is sent, with no story text, usernames, or other identifying information attached.

We do **not** collect presence/online status, message content outside of writers' own turn threads, direct messages, email addresses, IP addresses, or payment information.

**We do not allow collected data to be used to train machine learning or AI models.**
### 2. How We Use Data
Collected data is used exclusively to operate, maintain, and provide the Bot's features — running story turns, displaying and exporting stories, and giving server admins moderation tools. We do not sell, trade, or share your data with external third parties, except for the limited image-resizing case described above.
### 3. Data Retention & Deletion
- **Retention:** Data is kept for as long as it's part of an active or archived story, including after the Bot is removed from a server — removal does not automatically delete stored records.
- **Deletion:** You can request removal of your personally-identifying data (Discord user ID, display name, and pen name) at any time by contacting the developer through our [support server](https://discord.gg/hKH9G5XFpJ) or directly: @shantismurf on Discord. Because Round Robin stories are collaborative works co-authored by multiple writers, the text of entries you contributed will remain as part of the shared story — with your identifying information anonymized — since removing it outright would alter the narrative for your co-authors. Server Admins may request removal of any and all data.
## Terms of Service
### 1. Agreement to Terms
By inviting or using the Bot, you agree to comply with these Terms, the Discord Terms of Service, and Discord Community Guidelines.
### 2. Usage Restrictions
You agree not to use the Bot to abuse, spam, or exploit bugs. Automated command spamming or attempting to reverse-engineer the Bot's framework is strictly prohibited.
### 3. Termination
The developer reserves the right to ban individual users or entire Discord servers from accessing the Bot at any time, without warning, for violating these terms.
### 4. Limitation of Liability
The Bot is provided "as-is" without warranties of any kind. The developer is not liable for any damages, data losses, or disruptions caused by using the Bot.`;

// Posts the privacy policy to the hub server's #rules channel, or edits the existing
// pinned message in place if we already have its ID (avoids losing the pin / re-posting
// on every deploy). Runs automatically as part of deploy.js's hub post-sync step, since
// the developer's hosting setup has no way to run one-off scripts between deploys.
export async function syncPrivacyPolicy(client, connection) {
  const [hubServerId, rulesChannelId, existingMessageId] = await Promise.all([
    getConfigValue(connection, 'cfgHubServerId', 1),
    getConfigValue(connection, 'cfgHubRulesChannelId', 1),
    getConfigValue(connection, 'cfgPrivacyPolicyMessageId', 1),
  ]);

  if (!hubServerId || !rulesChannelId) {
    log(`syncPrivacyPolicy: cfgHubServerId or cfgHubRulesChannelId not set — skipping`, { show: true });
    return { success: false };
  }

  const hubGuild = await client.guilds.fetch(hubServerId).catch(() => null);
  const rulesChannel = hubGuild ? await hubGuild.channels.fetch(rulesChannelId).catch(() => null) : null;
  if (!rulesChannel) {
    log(`syncPrivacyPolicy: could not fetch hub guild ${hubServerId} or rules channel ${rulesChannelId}`, { show: true });
    return { success: false };
  }

  const embed = new EmbedBuilder().setDescription(POLICY_TEXT.slice(0, 4096)).setColor(0xe91e63);
  const isSnowflake = id => /^\d{17,20}$/.test(id ?? '');

  if (isSnowflake(existingMessageId)) {
    const existingMessage = await rulesChannel.messages.fetch(existingMessageId).catch(() => null);
    if (existingMessage) {
      await existingMessage.edit({ embeds: [embed] });
      log(`syncPrivacyPolicy: edited existing message ${existingMessageId} in #${rulesChannel.name}`, { show: true });
      return { success: true };
    }
    log(`syncPrivacyPolicy: stored message ${existingMessageId} no longer exists — posting a new one`, { show: true });
  }

  const message = await rulesChannel.send({ embeds: [embed] });
  await message.pin().catch(err => log(`syncPrivacyPolicy: posted but could not pin: ${err?.stack ?? err}`, { show: true }));
  await connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES ('cfgPrivacyPolicyMessageId', ?, 'en', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [message.id]
  );
  log(`syncPrivacyPolicy: posted new message ${message.id} in #${rulesChannel.name}`, { show: true });
  return { success: true };
}
