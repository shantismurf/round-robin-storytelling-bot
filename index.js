import { Client, GatewayIntentBits, EmbedBuilder, Collection, Events, MessageFlags } from 'discord.js';
import { StoryBot, updateStoryStatusMessage } from './storybot.js';
import { loadConfig, DB, getConfigValue, isGuildConfigured, setTestMode, log } from './utilities.js';
import { main as deploy } from './deploy.js';
import { startJobRunner } from './job-runner.js';
import { scheduleAllRoundupJobs } from './story/roundup.js';
import fs from 'fs';

/**
 * On startup, refresh status embeds for all active/paused stories so buttons
 * and content never go stale after a bot restart.
 */
async function refreshAllStatusMessages(connection, client) {
  try {
    const [stories] = await connection.execute(
      `SELECT story_id, guild_id FROM story WHERE story_status IN (1, 2) AND story_thread_id IS NOT NULL`
    );
    log(`Refreshing status messages for ${stories.length} active/paused story/stories...`, { show: false });
    for (const story of stories) {
      try {
        const guild = await client.guilds.fetch(story.guild_id);
        await updateStoryStatusMessage(connection, guild, story.story_id);
      } catch (err) {
        log(`Failed to refresh status for story ${story.story_id}: ${err}`, { show: true });
      }
    }
    log('Status message refresh complete.', { show: false });
  } catch (err) {
    log(`refreshAllStatusMessages failed: ${err}`, { show: true });
  }
}

async function main() {
  const config = loadConfig();
  setTestMode(config.testMode);

  log(`Initializing Round Robin StoryBot... (${config.testMode ? 'TEST MODE' : 'production'})`, { show: true });

  // Run all pre-launch steps: schema, migrations, config sync, command registration
  try {
    await deploy();
  } catch (err) {
    log(`Deploy failed: ${err.message}`, { show: true });
    process.exit(1);
  }

  // Create single database connection
  const db = new DB(config.db);
  const connection = await db.connect();
  
  // create Discord client here (index.js owns the client)
  const processingButtons = new Set();

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
      log(`Failed to publish botContent: ${err}`, { show: true });
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
            log(`Loaded command: ${command.default.data.name}`, { show: false });
            client.commands.set(command.default.data.name, command.default);
          } else {
            log(`Skipping file ${filePath} as it doesn't export a command`, { show: false });
          }
        }
      }
    } catch (error) {
      log(`Error loading commands: ${error}`, { show: true });
    }
  }
  client.once(Events.ClientReady, async () => {
    log(`Discord client ready as ${client.user.tag}`, { show: true });
    await bot.start();
    await loadCommands('./commands');
    startJobRunner(connection, client);
    scheduleAllRoundupJobs(connection);
    refreshAllStatusMessages(connection, client);
  });
  function formatCommandLog(interaction) {
    const subcommand = interaction.options.getSubcommand(false);
    const subOptions = subcommand
      ? (interaction.options.data[0]?.options ?? [])
      : interaction.options.data;
    const storyIdOpt = subOptions.find(o => o.name === 'story_id');
    const params = subOptions
      .filter(o => o.name !== 'story_id')
      .map(o => {
        if (o.type === 6) { // USER
          const user = interaction.options.getUser(o.name);
          return `${o.name}=${user?.username ?? o.value}`;
        }
        return `${o.name}=${o.value}`;
      })
      .join(' ');
    const parts = [subcommand, params].filter(Boolean).join(' ');
    const channel = interaction.channel?.name ?? 'DM';
    const storyPart = storyIdOpt ? ` for story ${storyIdOpt.value}` : '';
    return `${interaction.user.username} triggered ${interaction.commandName}${parts ? ` ${parts}` : ''} in #${channel}${storyPart}.`;
  }

  // Listen for slash commands and modal interactions
  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        log(formatCommandLog(interaction), { show: false, guildName: interaction?.guild?.name });
        const command = interaction.client.commands.get(interaction.commandName);
        if (command) {
          // Block all commands (except /storyadmin setup) if the bot has not been configured for this server
          const isSetupCommand = interaction.commandName === 'storyadmin'
            && interaction.options.getSubcommand(false) === 'setup';
          if (!isSetupCommand && interaction.guild) {
            const configured = await isGuildConfigured(connection, interaction.guild.id);
            if (!configured) {
              const isAdmin = interaction.member?.permissions?.has('ManageGuild');
              const msg = isAdmin
                ? '⚠️ **Round Robin StoryBot has not been configured for this server.** Please run `/storyadmin setup` to set the story feed channel and admin role before using any other commands.'
                : '⚠️ **Round Robin StoryBot has not been configured for this server yet.** Please ask a server admin to run `/storyadmin setup`.';
              await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
              return;
            }
          }
          await command.execute(connection, interaction);
        }
      } else if (interaction.isModalSubmit()) {
        const significantModal = interaction.customId === 'storyadmin_setup_modal';
        if (significantModal) {
          log(`${interaction.user.username} submitted modal ${interaction.customId}`, { show: true, guildName: interaction?.guild?.name });
        } else {
          log(`${interaction.user.username} submitted modal ${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
        }

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
        } else if (interaction.customId.startsWith('mystory_')) {
          const mystoryCommand = interaction.client.commands.get('mystory');
          if (mystoryCommand && mystoryCommand.handleModalSubmit) {
            await mystoryCommand.handleModalSubmit(connection, interaction);
          }
        }
      } else if (interaction.isButton()) {
        log(`${interaction.user.username} clicked button ${interaction.customId}`, { show: true, guildName: interaction?.guild?.name });

        const dedupKey = `${interaction.user.id}:${interaction.customId}`;
        if (processingButtons.has(dedupKey)) {
          await interaction.deferUpdate().catch(() => {});
        } else {
          processingButtons.add(dedupKey);
          try {
            const isStoryadminButton = interaction.customId.startsWith('storyadmin_');
            const isMystoryButton = interaction.customId.startsWith('catchup_') || interaction.customId.startsWith('mystory_');
            const commandName = isStoryadminButton ? 'storyadmin' : isMystoryButton ? 'mystory' : 'story';
            const command = interaction.client.commands.get(commandName);
            if (command && command.handleButtonInteraction) {
              await command.handleButtonInteraction(connection, interaction);
            }
          } finally {
            processingButtons.delete(dedupKey);
          }
        }
      } else if (interaction.isAutocomplete()) {
        const command = interaction.client.commands.get(interaction.commandName);
        if (command?.handleAutocomplete) {
          await command.handleAutocomplete(connection, interaction);
        }
      } else if (interaction.isStringSelectMenu()) {
        log(`${interaction.user.username} used select menu ${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });

        // Handle story select menu interactions
        if (interaction.customId.startsWith('story_')) {
          const storyCommand = interaction.client.commands.get('story');
          if (storyCommand && storyCommand.handleSelectMenuInteraction) {
            await storyCommand.handleSelectMenuInteraction(connection, interaction);
          }
        }
      } else {
        log(`Unhandled interaction type ${interaction.type} from ${interaction.user.username} (customId: ${interaction.customId ?? 'n/a'})`, { show: true, guildName: interaction?.guild?.name });
      }
    } catch (error) {
      if (error.code === 10062) {
        // Token expired before the bot could respond — harmless, usually autocomplete during DB slowness
        const ctx = interaction.isAutocomplete()
          ? `autocomplete for /${interaction.commandName}`
          : (interaction.customId ?? interaction.commandName ?? 'unknown');
        log(`Interaction token expired (10062) — ${ctx}`, { show: false, guildName: interaction?.guild?.name });
        return;
      }

      const guildId = interaction?.guild?.id || 'unknown';
      log(`Error handling interaction: ${error}\n${error?.stack ?? ''}`, { show: true, guildName: interaction?.guild?.name });

      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch(() => {});
      } else if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: await getConfigValue(connection,'errProcessingRequest', guildId),
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      } else if (interaction.deferred) {
        await interaction.editReply({
          content: await getConfigValue(connection,'errProcessingRequest', guildId),
        }).catch(() => {});
      }
    }
  });
  await client.login(config.token);
}

main().catch(err => {
  log(`Fatal error starting Round Robin StoryBot: ${err}`, { show: true });
  process.exit(1);
});
