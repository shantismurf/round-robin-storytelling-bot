import { REST, Routes } from 'discord.js';
import { loadConfig } from './utilities.js';
import fs from 'fs';

async function deploy() {
  const config = loadConfig();

  if (!config.clientId) {
    console.error('Missing clientId in config.json. Add your bot\'s application ID from the Discord Developer Portal.');
    process.exit(1);
  }
  if (config.testMode && !config.guildId) {
    console.error('Missing guildId in config.json. Required for guild-scoped registration in test mode.');
    process.exit(1);
  }

  // Load all commands from the commands directory
  const commands = [];
  const files = fs.readdirSync('./commands').filter(f => f.endsWith('.js'));

  for (const file of files) {
    const command = await import(`./commands/${file}`);
    if (command.default?.data) {
      commands.push(command.default.data.toJSON());
      console.log(`Loaded command: ${command.default.data.name}`);
    }
  }

  const rest = new REST().setToken(config.token);

  if (config.testMode) {
    console.log(`TEST MODE: Registering ${commands.length} command(s) to guild ${config.guildId} (instant)...`);
    const result = await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    console.log(`Successfully registered ${result.length} command(s) to guild.`);
  } else {
    console.log(`PRODUCTION: Registering ${commands.length} command(s) globally (up to 1 hour to propagate)...`);
    const result = await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commands }
    );
    console.log(`Successfully registered ${result.length} command(s) globally.`);
  }
}

deploy().catch(err => {
  console.error('Failed to deploy commands:', err);
  process.exit(1);
});
