/**
 * check-unconfigured.js
 * Lists all servers the bot is installed on, flagging any that have not
 * run /storyadmin setup (i.e. have no guild-specific cfgStoryFeedChannelId row).
 *
 *   node check-unconfigured.js
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { DB, loadConfig } from './utilities.js';

const config = loadConfig();
const db = new DB(config.db);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  const connection = await db.connect();

  try {
    const guilds = [...client.guilds.cache.values()];

    const results = await Promise.all(guilds.map(async guild => {
      const [rows] = await connection.execute(
        `SELECT config_value FROM config WHERE config_key = 'cfgStoryFeedChannelId' AND guild_id = ?`,
        [guild.id]
      );
      const configured = rows.length > 0 && !!rows[0].config_value;
      const owner = await guild.fetchOwner().catch(() => null);
      return { guild, configured, ownerTag: owner?.user?.tag ?? 'unknown', ownerId: owner?.user?.id ?? 'unknown' };
    }));

    const configured   = results.filter(r => r.configured);
    const unconfigured = results.filter(r => !r.configured);

    console.log(`\n✅ Configured (${configured.length}):`);
    for (const r of configured) {
      console.log(`  • ${r.guild.name} (${r.guild.id}) — owner: ${r.ownerTag}`);
    }

    console.log(`\n⚠️  Not configured (${unconfigured.length}):`);
    for (const r of unconfigured) {
      console.log(`  • ${r.guild.name} (${r.guild.id}) — owner: ${r.ownerTag} (${r.ownerId})`);
    }

    console.log('');
  } finally {
    await db.disconnect();
    client.destroy();
  }
});

client.login(config.token);
