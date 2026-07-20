import { Client, GatewayIntentBits, Collection, Events, MessageFlags } from 'discord.js';
import { updateStoryStatusMessage } from './story/_storyStatus.js';
import { loadConfig, DB, getConfigValue, isGuildConfigured, setTestMode, log, setHubLogClient, closeOrphanedGuildStories } from './utilities.js';
import { STORY_STATUS } from './constants.js';
import { handleWriterDeparted } from './story/_writerDeparted.js';
import { main as deploy } from './deploy.js';
import { startJobRunner, scheduleOnboardingReminders } from './job-runner.js';
import fs from 'fs';

/**
 * On startup, refresh status embeds for all active/paused stories so buttons
 * and content never go stale after a bot restart.
 */
async function refreshAllStatusMessages(connection, client) {
  try {
    const [stories] = await connection.execute(
      `SELECT story_id, guild_id FROM story WHERE story_status IN (?, ?) AND story_thread_id IS NOT NULL`,
      [STORY_STATUS.ACTIVE, STORY_STATUS.PAUSED]
    );
    log(`Refreshing status messages for ${stories.length} active/paused story/stories...`, { show: false });
    const orphanedGuildIds = new Set();
    for (const story of stories) {
      if (orphanedGuildIds.has(story.guild_id)) continue;
      try {
        const guild = await client.guilds.fetch(story.guild_id);
        await updateStoryStatusMessage(connection, guild, story.story_id);
      } catch (err) {
        if (err?.code === 10004) {
          log(`refreshAllStatusMessages: guild ${story.guild_id} no longer has the bot installed; closing its stories`, { show: true, hub: true });
          orphanedGuildIds.add(story.guild_id);
          await closeOrphanedGuildStories(connection, story.guild_id);
        } else {
          log(`Failed to refresh status for story ${story.story_id}: ${err}`, { show: true });
        }
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
  const processingModals = new Set();

  const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration] });
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

    const guildIds = [...client.guilds.cache.keys()];
    let registeredMap = new Map();
    if (guildIds.length > 0) {
      const placeholders = guildIds.map(() => '?').join(',');
      const [regRows] = await connection.execute(
        `SELECT guild_id, config_value AS registered_at FROM config WHERE config_key = 'cfgGuildRegisteredAt' AND guild_id IN (${placeholders})`,
        guildIds
      );
      registeredMap = new Map(regRows.map(r => [String(r.guild_id), r.registered_at]));
    }
    const sortedGuilds = [...client.guilds.cache.values()].sort((a, b) => {
      const aDate = registeredMap.get(a.id) ?? '';
      const bDate = registeredMap.get(b.id) ?? '';
      if (!aDate && !bDate) return 0;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.localeCompare(bDate);
    });
    const guildList = sortedGuilds.map(g => {
      const date = registeredMap.get(g.id);
      return `  • ${g.name} (${g.id})${date ? ` — since ${date.slice(0, 10)}` : ''}`;
    }).join('\n');
    log(`Installed on ${client.guilds.cache.size} server(s):\n${guildList}`, { show: true });

    const hubLogChannelId = await getConfigValue(connection, 'cfgHubLogChannelId');
    setHubLogClient(client, hubLogChannelId);
    const { version } = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    log(`✅ Bot online — v${version} on ${client.guilds.cache.size} server(s)`, { show: true, hub: true });
    log('Round Robin StoryBot engine initialized', { show: true });
    await loadCommands('./commands');
    startJobRunner(connection, client).catch(err => log(`startJobRunner failed: ${err?.stack ?? err}`, { show: true }));
    refreshAllStatusMessages(connection, client);
  });
  client.on(Events.GuildCreate, async guild => {
    log(`Bot added to guild ${guild.name} (${guild.id})`, { show: true, hub: true });
    await scheduleOnboardingReminders(connection, guild.id, guild.joinedAt).catch(err =>
      log(`scheduleOnboardingReminders failed for guild ${guild.id}: ${err?.stack ?? err}`, { show: true })
    );
  });
  client.on(Events.GuildDelete, async guild => {
    log(`Bot removed from guild ${guild.name ?? 'unknown'} (${guild.id})`, { show: true, hub: true });
    await closeOrphanedGuildStories(connection, guild.id);
  });
  client.on(Events.GuildMemberRemove, async member => {
    log(`Member left guild ${member.guild?.name ?? 'unknown'} (${member.guild?.id}): ${member.user?.tag ?? member.id}`, { show: false, guildName: member.guild?.name });
    await handleWriterDeparted(connection, client, member.guild.id, member.id).catch(err =>
      log(`handleWriterDeparted (leave) failed for guild ${member.guild?.id} user ${member.id}: ${err?.stack ?? err}`, { show: true })
    );
  });
  client.on(Events.GuildBanAdd, async ban => {
    log(`Member banned from guild ${ban.guild?.name ?? 'unknown'} (${ban.guild?.id}): ${ban.user?.tag ?? ban.user?.id}`, { show: false, guildName: ban.guild?.name });
    await handleWriterDeparted(connection, client, ban.guild.id, ban.user.id).catch(err =>
      log(`handleWriterDeparted (ban) failed for guild ${ban.guild?.id} user ${ban.user?.id}: ${err?.stack ?? err}`, { show: true })
    );
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
        log(formatCommandLog(interaction), { show: true, guildName: interaction?.guild?.name });
        const command = interaction.client.commands.get(interaction.commandName);
        if (command) {
          // Block all commands (except /storyadmin setup) if the bot has not been configured for this server
          const isSetupCommand = interaction.commandName === 'storyadmin'
            && interaction.options.getSubcommand(false) === 'setup';
          if (!isSetupCommand && interaction.guild) {
            const configured = await isGuildConfigured(connection, interaction.guild.id);
            if (!configured) {
              log(`Setup required: blocked /${interaction.commandName}`, { show: true, guildName: interaction.guild.name });
              const isAdmin = interaction.member?.permissions?.has('ManageGuild');
              const msgKey = isAdmin ? 'txtSetupRequiredAdmin' : 'txtSetupRequiredUser';
              const msg = await getConfigValue(connection, msgKey, 1);
              await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
              return;
            }
          }
          if (!interaction.replied) await command.execute(connection, interaction);
        }
      } else if (interaction.isModalSubmit()) {
        const significantModal = interaction.customId.startsWith('storyadmin_setup_');
        if (significantModal) {
          log(`${interaction.user.username} submitted modal ${interaction.customId}`, { show: true, guildName: interaction?.guild?.name });
        } else {
          log(`${interaction.user.username} submitted modal ${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
        }

        // Handle story modal submissions
        const modalDedupKey = `${interaction.user.id}:${interaction.customId}`;
        if (processingModals.has(modalDedupKey)) {
          log(`Duplicate modal suppressed: ${interaction.customId} from ${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
        } else {
          processingModals.add(modalDedupKey);
          try {
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
          } finally {
            processingModals.delete(modalDedupKey);
          }
        }
      } else if (interaction.isButton()) {
        log(`${interaction.user.username} clicked button ${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });

        const dedupKey = `${interaction.user.id}:${interaction.customId}`;
        if (processingButtons.has(dedupKey)) {
          log(`Duplicate button suppressed: ${interaction.customId} from ${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
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
      if (error.code === 10062 || error.code === 40060) {
        const ctx = interaction.isAutocomplete()
          ? `autocomplete for /${interaction.commandName}`
          : (interaction.customId ?? interaction.commandName ?? 'unknown');
        log(`Interaction already acknowledged or token expired (${error.code}) — ${ctx}`, { show: true, guildName: interaction?.guild?.name });
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
