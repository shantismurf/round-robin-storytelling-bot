import { REST, Routes } from 'discord.js';
import { loadConfig } from './utilities.js';
import fs from 'fs';

async function deploy() {
  const config = loadConfig();

  if (!config.clientId) {
    console.error('Missing clientId in config.json. Add your bot\'s application ID from the Discord Developer Portal.');
    process.exit(1);
  }
  if (!config.guildId) {
    console.error('Missing guildId in config.json. Add your Discord server\'s ID.');
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

  console.log(`Registering ${commands.length} command(s) to guild ${config.guildId}...`);

  const result = await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commands }
  );

  console.log(`Successfully registered ${result.length} command(s).`);
}

deploy().catch(err => {
  console.error('Failed to deploy commands:', err);
  process.exit(1);
});
