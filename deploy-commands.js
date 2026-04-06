import { REST, Routes } from 'discord.js';
import fs from 'fs';
import { formattedDate } from './utilities.js';

export async function deployCommands (config) {
  try {
    const rest = new REST().setToken(config.token);

    // Wipe guild-level command registrations (clears test-mode leftovers before global deploy)
    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [] });
      console.log('Cleared guild-scoped commands.');
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

    // Register commands  
    if (config.testMode) {
      console.log(`\nTEST MODE: Registering ${commands.length} command(s) to guild ${config.guildId} (instant)...`);
      const result = await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commands }
      );
      console.log(`${formattedDate()}: Registered ${result.length} command(s) to guild (instant).`);
    } else {
      console.log(`\nPRODUCTION: Registering ${commands.length} command(s) globally (up to 1 hour to propagate)...`);
      const result = await rest.put(
        Routes.applicationCommands(config.clientId),
        { body: commands }
      );
      console.log(`${formattedDate()}: Registered ${result.length} command(s) globally (up to 1 hour to propagate).`);
    }
  } catch (error) {
    console.error('Failed to deploy commands:', error);
    throw error;
  }
}