import { Client, GatewayIntentBits, EmbedBuilder, Collection, Events, MessageFlags } from 'discord.js';
import { StoryBot } from './storybot.js';
import { loadConfig, formattedDate, DB, getConfigValue } from './utilities.js';
import { setupDatabase } from './database-setup.js';
import { startJobRunner } from './job-runner.js';
import fs from 'fs';

async function main() {
  const config = loadConfig();

  // Setup database before starting bot
  console.log(`${formattedDate()}: Initializing Round Robin Storybot...`);
  const dbSetupSuccess = await setupDatabase(config);

  if (!dbSetupSuccess) {
    console.error(`${formattedDate()}: Failed to setup database. Exiting...`);
    process.exit(1);
  }

  // Create single database connection
  const db = new DB(config.db);
  const connection = await db.connect();
  
  // create Discord client here (index.js owns the client)
  const client = new Client({ intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent] });
  // instantiate story engine
  const bot = new StoryBot(config);
  // Listen for publish events from RRStoryBot and post using the Discord client
  bot.on('publish', async (botContent) => {
    try {
      const channel = await client.channels.fetch(botContent.channelId);
      const embeds = (botContent.embeds || []).map(data => new EmbedBuilder()
        .setTitle(data.title || '')
        .setAuthor({ name: data.author || '' })
        .setDescription(data.description || '')
        .setFooter({ text: data.footer || '' })
      );
      await channel.send({ content: botContent.content || null, embeds, files: botContent.files });
    } catch (err) {
      console.error(`${formattedDate()}: Failed to publish botContent:`, err, botContent);
    }
  });
  // Create initiate slash commands
  client.commands = new Collection();
  async function loadCommands(dir) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const filePath = `${dir}/${file}`;
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          await loadCommands(filePath);
        } else if (file.endsWith('.js')) {
          const command = await import(filePath);
          if (command.default && command.default.data) {
            console.log(`Loaded command: ${command.default.data.name}`);
            client.commands.set(command.default.data.name, command.default);
          } else {
            console.log(`Skipping file ${filePath} as it doesn't export a command`);
          }
        }
      }
    } catch (error) {
      console.error(`${formattedDate()}: Error loading commands:`, error);
    }
  }
  client.once(Events.ClientReady, async () => {
    console.log(`Discord client ready as ${client.user.tag}`);
    await bot.start();
    await loadCommands('./commands');
    startJobRunner(connection, client);
  });
  // Listen for slash commands and modal interactions
  client.on(Events.InteractionCreate, async interaction => {
    console.log(`${formattedDate()}: InteractionCreate fired — type: ${interaction.type}, user: ${interaction.user.username}`);
    try {
      if (interaction.isChatInputCommand()) {
        console.log(`${formattedDate()}: ${interaction.user.username} in #${interaction.channel.name} triggered ${interaction.commandName}.`);
        const command = interaction.client.commands.get(interaction.commandName);
        if (command) {
          await command.execute(connection, interaction);
        }
      } else if (interaction.isModalSubmit()) {
        console.log(`${formattedDate()}: ${interaction.user.username} submitted modal ${interaction.customId}`);

        // Handle story modal submissions
        if (interaction.customId.startsWith('story_')) {
          const storyCommand = interaction.client.commands.get('story');
          if (storyCommand && storyCommand.handleModalSubmit) {
            await storyCommand.handleModalSubmit(connection, interaction);
          }
        } else if (interaction.customId.startsWith('storyadmin_')) {
          const adminCommand = interaction.client.commands.get('storyadmin');
          if (adminCommand && adminCommand.handleModalSubmit) {
            await adminCommand.handleModalSubmit(connection, interaction);
          }
        }
      } else if (interaction.isButton()) {
        console.log(`${formattedDate()}: ${interaction.user.username} clicked button ${interaction.customId}`);

        const isStoryadminButton = interaction.customId.startsWith('storyadmin_');
        const isMystoryButton = interaction.customId.startsWith('catchup_') || interaction.customId.startsWith('mystory_');
        const commandName = isStoryadminButton ? 'storyadmin' : isMystoryButton ? 'mystory' : 'story';
        const command = interaction.client.commands.get(commandName);
        if (command && command.handleButtonInteraction) {
          await command.handleButtonInteraction(connection, interaction);
        }
      } else if (interaction.isStringSelectMenu()) {
        console.log(`${formattedDate()}: ${interaction.user.username} used select menu ${interaction.customId}`);

        // Handle story select menu interactions
        if (interaction.customId.startsWith('story_')) {
          const storyCommand = interaction.client.commands.get('story');
          if (storyCommand && storyCommand.handleSelectMenuInteraction) {
            await storyCommand.handleSelectMenuInteraction(connection, interaction);
          }
        }
      } else {
        console.log(`${formattedDate()}: Unhandled interaction type ${interaction.type} from ${interaction.user.username} (customId: ${interaction.customId ?? 'n/a'})`);
      }
    } catch (error) {
      const guildId = interaction?.guild?.id || 'unknown';
      console.error(`${formattedDate()}:  Error handling interaction:`, error);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: await getConfigValue(connection,'errProcessingRequest', guildId),
          flags: MessageFlags.Ephemeral
        }).catch(console.error);
      } else if (interaction.deferred) {
        await interaction.editReply({
          content: await getConfigValue(connection,'errProcessingRequest', guildId),
        }).catch(console.error);
      }
    }
  });
  await client.login(config.token);
}

main().catch(err => {
  console.error(`${formattedDate()}: Fatal error starting StoryBot:`, err);
  process.exit(1);
});
