import { Client, GatewayIntentBits } from 'discord.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(__dirname, 'config.json'), 'utf8'));

const USER_IDS = [
/*redacted*/
];

const MESSAGE = `Hello Server Admins!

This is the bot's developer sending you a one-time direct message through the app. 

First off — thanks for installing the bot, and apologies that this took so long! The original message was supposed to go out weeks ago, but there were a few technical hiccups. There was an issue that was preventing the storyadmin setup process from running, so several of you have the bot installed, but have been unable to configure it. That issue is resolved now, so you can now run setup to get started!

I also wanted to invite you to join the [Round Robin Storybot Hub server](https://discord.gg/hKH9G5XFpJ).  I wanted to have a central place where bot users could contact me (and vice versa). I promise I won't send messages like this unless there's a really critical issue, like not being able to configure the system! :sweat_smile:

The good news is that a *lot* has been built in the last few weeks, and Round Robin StoryBot is now at v2.5 with a whole bunch of new features including story metadata, optional restricted channels for mature works, and a collaborative story tagging system! The full changelog can be found on the Hub server.

Thanks for being an early adopter of the bot, and happy writing!

~Shantismurf`;

const SEND = process.argv.includes('--send');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (SEND) {
    for (const userId of USER_IDS) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(MESSAGE);
        console.log(`✅ Sent to ${user.tag} (${userId})`);
      } catch (err) {
        console.log(`❌ Failed for ${userId}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('Done.');
  } else {
    console.log('\n--- Current message ---\n');
    console.log(MESSAGE);
    console.log('\n--- Server owners (USER_IDS format) ---\n');

    const guilds = [...client.guilds.cache.values()];
    for (const guild of guilds) {
      const owner = await guild.fetchOwner().catch(() => null);
      const id = owner?.user?.id ?? 'unknown';
      const username = owner?.user?.username ?? 'unknown';
      console.log(`'${id}', // ${username} (${guild.name})`);
    }
    console.log('');
  }

  client.destroy();
});

client.login(config.token);