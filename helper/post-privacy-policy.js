/**
 * post-privacy-policy.js
 * Posts the privacy policy to the hub server's #rules channel as a
 * pinned embed. Edit POLICY_TEXT below whenever the policy changes, then
 * run manually — this is a rare, admin-only action, so it's a terminal
 * script rather than a bot command.
 *
 *   node helper/post-privacy-policy.js            (dry run — prints the embed)
 *   node helper/post-privacy-policy.js --send     (actually posts and pins)
 */

import { Client, GatewayIntentBits, EmbedBuilder, Events } from 'discord.js';
import { loadConfig } from '../utilities.js';

const RULES_CHANNEL_ID = '1499435586740682772';

const POLICY_TEXT = `# Round Robin StoryBot Privacy Policy & Terms of Service
-# **Last Updated: July 20, 2026**
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

We do **not** collect presence/online status, message content outside of writers' own turn threads, direct messages, email addresses, IP addresses, or payment information.

**We do not allow collected data to be used to train machine learning or AI models.**
### 2. How We Use Data
Collected data is used exclusively to operate, maintain, and provide the Bot's features — running story turns, displaying and exporting stories, and giving server admins moderation tools. We do not sell, trade, or share your data with external third parties.
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

const SEND = process.argv.includes('--send');

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // No separate embed title — the policy text's own "# ..." header line is the title.
  const embed = new EmbedBuilder()
    .setDescription(POLICY_TEXT.slice(0, 4096))
    .setColor(0xe91e63);

  if (!SEND) {
    console.log(`\n--- Dry run: would post to channel ${RULES_CHANNEL_ID} ---\n`);
    console.log(POLICY_TEXT);
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
