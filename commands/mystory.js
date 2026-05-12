import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { log } from '../utilities.js';
import { handleWriterHelp } from '../faq.js';
import { handleList, handleListNavigation, handleCatchUp, handleCatchUpNavigation } from './_myStoryList.js';
import { handleMyStoryManage, handleMyStoryManageButton, handlePanelPassConfirm, handlePanelPauseConfirm, handlePanelLeaveConfirm, handlePanelActionCancel, handleMyStoryManageModal } from './_myStoryManage.js';

const data = new SlashCommandBuilder()
  .setName('mystory')
  .setDescription('Your personal story dashboard')
  .addSubcommand(s =>
    s.setName('list')
      .setDescription('See all your stories — active, paused, delayed, and closed')
      .addIntegerOption(o =>
        o.setName('page')
          .setDescription('Page number')
          .setRequired(false)
          .setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName('catchup')
      .setDescription('Read entries written since your last turn')
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story to catch up on')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('manage')
      .setDescription('Update settings or take action for one of your stories')
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story to manage your settings for')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Quick reference for all writer commands')
  );

async function execute(connection, interaction) {
  log(`execute: entry subcommand=${interaction.options.getSubcommand()} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'list') await handleList(connection, interaction);
  else if (subcommand === 'catchup') await handleCatchUp(connection, interaction);
  else if (subcommand === 'manage') await handleMyStoryManage(connection, interaction);
  else if (subcommand === 'help') await handleWriterHelp(connection, interaction);
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('catchup_prev_') || interaction.customId.startsWith('catchup_next_')) {
    await handleCatchUpNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_list_prev_') || interaction.customId.startsWith('mystory_list_next_')) {
    await handleListNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_leave_confirm_')) {
    await handlePanelLeaveConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_leave_cancel_') || interaction.customId.startsWith('mystory_manage_pass_cancel_') || interaction.customId.startsWith('mystory_manage_pause_cancel_')) {
    await handlePanelActionCancel(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_pass_confirm_')) {
    await handlePanelPassConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_pause_confirm_')) {
    await handlePanelPauseConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_')) {
    await handleMyStoryManageButton(connection, interaction);
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'mystory_manage_ao3_modal') {
    await handleMyStoryManageModal(connection, interaction);
  }
}

async function handleAutocomplete(connection, interaction) {
  if (!interaction.guild) return interaction.respond([]);

  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== 'story_id') return interaction.respond([]);

  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();
  const typed = `%${focusedOption.value}%`;
  const typedPrefix = `${focusedOption.value}%`;

  let rows;

  if (subcommand === 'catchup') {
    [rows] = await connection.execute(
      `SELECT s.guild_story_id, s.title FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       WHERE s.guild_id = ? AND s.story_status != 3 AND sw.sw_status IN (1, 2)
         AND EXISTS (
           SELECT 1 FROM story_entry se
           JOIN turn t ON se.turn_id = t.turn_id
           JOIN story_writer sw2 ON t.story_writer_id = sw2.story_writer_id
           WHERE sw2.story_id = s.story_id AND se.entry_status = 'confirmed'
         )
         AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
       ORDER BY s.guild_story_id LIMIT 25`,
      [interaction.user.id, guildId, typed, typedPrefix]
    );

  } else {
    [rows] = await connection.execute(
      `SELECT s.guild_story_id, s.title FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id
       WHERE s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status IN (1, 2)
         AND s.story_status != 3
         AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
       ORDER BY s.guild_story_id LIMIT 25`,
      [guildId, interaction.user.id, typed, typedPrefix]
    );
  }

  return interaction.respond(
    (rows ?? []).map(r => ({
      name: `${r.title} (#${r.guild_story_id})`.slice(0, 100),
      value: String(r.guild_story_id)
    }))
  );
}

export default { data, execute, handleButtonInteraction, handleModalSubmit, handleAutocomplete };
