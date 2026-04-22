import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, isGuildConfigured, resolveStoryId, checkIsAdmin } from '../utilities.js';

// Sub-command handlers
import { handleAddStory, handleAddStoryModalSubmit, handleAddStoryButton } from '../story/add.js';
import { handleJoin, handleJoinSetAO3Button, handleJoinAO3ModalSubmit, handleJoinConfirm, buildJoinEmbed, pendingJoinData } from '../story/join.js';
import { handleWrite, handleWriteModalSubmit, handleEntryConfirmation, handleViewLastEntry, handleFinalizeEntry, handleFinalizeConfirm, handleSkipTurn, handleSkipConfirm } from '../story/write.js';
import { handleRead, handleReadNav } from '../story/read.js';
import { handleEdit, handleEditButton, handleEditModalSubmit, handleRepostEntry } from '../story/edit.js';
import { handleListStories, handleListNavigation, handleFilterButton, renderStoryListReply } from '../story/list.js';
import { handleManage, handleManageButton, handleManageModalSubmit } from '../story/manage.js';
import { handleClose, handleCloseConfirm, handleCloseCancel } from '../story/close.js';
import { handleTimeleft, handleRequestMoreTime } from '../story/timeleft.js';
import { handleExportPostPublic } from '../story/export.js';
import { handleHelp, handleHelpNavigation } from '../story/help.js';
import { handlePing } from '../story/ping.js';

const data = new SlashCommandBuilder()
  .setName('story')
  .setDescription('Manage stories')
  .addSubcommand(subcommand =>
    subcommand
      .setName('add')
      .setDescription('Create a new story')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('Browse available stories')
      .addStringOption(option =>
        option.setName('filter')
          .setDescription('Filter stories by type')
          .setRequired(false)
          .addChoices(
            { name: 'All Stories', value: 'all' },
            { name: 'Joinable Stories', value: 'joinable' },
            { name: 'My Stories', value: 'mine' },
            { name: 'Active Stories', value: 'active' },
            { name: 'Paused Stories', value: 'paused' }
          ))
      .addIntegerOption(option =>
        option.setName('page')
          .setDescription('Page number')
          .setRequired(false)
          .setMinValue(1))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('write')
      .setDescription('Submit your entry for a story (quick mode only)')
      .addStringOption(option =>
        option.setName('story_id')
          .setDescription('Story to submit to')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('join')
      .setDescription('Join an existing story as a writer')
      .addStringOption(option =>
        option.setName('story_id')
          .setDescription('Story to join')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('read')
      .setDescription('Read the story in Discord, page by page, with an option to export as HTML')
      .addStringOption(option =>
        option.setName('story_id')
          .setDescription('Story to read')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('close')
      .setDescription('Close a story (creator or admin only)')
      .addStringOption(option =>
        option.setName('story_id')
          .setDescription('Story to close')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('manage')
      .setDescription('Edit story settings, pause, or resume (creator or admin only)')
      .addStringOption(option =>
        option.setName('story_id')
          .setDescription('Story to manage')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('timeleft')
      .setDescription('Check the current turn status for a story')
      .addStringOption(option =>
        option.setName('story_id')
          .setDescription('Story to check')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('help')
      .setDescription('How to use Round Robin StoryBot')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('ping')
      .setDescription('Ping all active writers in the story thread (creator or admin only)')
      .addStringOption(option =>
        option.setName('story_id').setDescription('Story to ping').setRequired(true).setAutocomplete(true))
      .addStringOption(option =>
        option.setName('message').setDescription('Optional message to include').setRequired(false))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('edit')
      .setDescription('Edit a confirmed story entry')
      .addStringOption(option =>
        option.setName('story_id')
          .setDescription('Story to edit in')
          .setRequired(true)
          .setAutocomplete(true))
      .addIntegerOption(option =>
        option.setName('turn')
          .setDescription('Turn number (as shown in /story read)')
          .setRequired(true)
          .setMinValue(1)
          .setAutocomplete(true))
  );

async function execute(connection, interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  log(`execute() called with subcommand '${subcommand}'`, { show: false, guildName: interaction?.guild?.name });

  if (!await isGuildConfigured(connection, interaction.guild.id)) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtNotConfigured', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'add') {
    await handleAddStory(connection, interaction);
  } else if (subcommand === 'list') {
    await handleListStories(connection, interaction);
  } else if (subcommand === 'write') {
    await handleWrite(connection, interaction);
  } else if (subcommand === 'join') {
    await handleJoin(connection, interaction);
  } else if (subcommand === 'read') {
    await handleRead(connection, interaction);
  } else if (subcommand === 'close') {
    await handleClose(connection, interaction);
  } else if (subcommand === 'manage') {
    await handleManage(connection, interaction);
  } else if (subcommand === 'timeleft') {
    await handleTimeleft(connection, interaction);
  } else if (subcommand === 'help') {
    await handleHelp(connection, interaction);
  } else if (subcommand === 'ping') {
    await handlePing(connection, interaction);
  } else if (subcommand === 'edit') {
    await handleEdit(connection, interaction);
  } else {
    log(`execute() - unrecognized subcommand '${subcommand}', no handler matched`, { show: false, guildName: interaction?.guild?.name });
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId.startsWith('story_add_')) {
    await handleAddStoryModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_write_')) {
    await handleWriteModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_ao3_')) {
    await handleJoinAO3ModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_manage_')) {
    await handleManageModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_edit_modal_')) {
    await handleEditModalSubmit(connection, interaction);
  }
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('story_add_')) {
    await handleAddStoryButton(connection, interaction);
  } else if (interaction.customId.startsWith('story_list_')) {
    await handleListNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('confirm_entry_') || interaction.customId.startsWith('discard_entry_')) {
    await handleEntryConfirmation(connection, interaction);
  } else if (interaction.customId.startsWith('view_last_entry_')) {
    await handleViewLastEntry(connection, interaction);
  } else if (interaction.customId.startsWith('finalize_entry_')) {
    await handleFinalizeEntry(connection, interaction);
  } else if (interaction.customId.startsWith('story_finalize_confirm_')) {
    await handleFinalizeConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_finalize_cancel_')) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
  } else if (interaction.customId.startsWith('skip_turn_')) {
    await handleSkipTurn(connection, interaction);
  } else if (interaction.customId.startsWith('story_skip_confirm_')) {
    await handleSkipConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_skip_cancel_')) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
  } else if (interaction.customId.startsWith('story_close_confirm_')) {
    await handleCloseConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_close_cancel_')) {
    await handleCloseCancel(connection, interaction);
  } else if (interaction.customId.startsWith('story_manage_')) {
    await handleManageButton(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_confirm_')) {
    await handleJoinConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_set_ao3_')) {
    await handleJoinSetAO3Button(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_cancel_')) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'btnCancel', interaction.guild.id), embeds: [], components: [] });
  } else if (interaction.customId.startsWith('story_join_')) {
    const storyId = parseInt(interaction.customId.split('_').at(-1));
    await handleJoin(connection, interaction, storyId);
  } else if (interaction.customId === 'story_filter') {
    await handleFilterButton(connection, interaction);
  } else if (interaction.customId === 'story_help_page_1' || interaction.customId === 'story_help_page_2' || interaction.customId === 'story_help_page_3') {
    await handleHelpNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('story_request_more_time_')) {
    await handleRequestMoreTime(connection, interaction);
  } else if (interaction.customId.startsWith('story_read_post_public_')) {
    await handleExportPostPublic(connection, interaction);
  } else if (interaction.customId.startsWith('story_repost_entry_')) {
    await handleRepostEntry(connection, interaction);
  } else if (interaction.customId.startsWith('story_edit_')) {
    await handleEditButton(connection, interaction);
  } else if (interaction.customId.startsWith('story_read_')) {
    await handleReadNav(connection, interaction);
  }
}

async function handleSelectMenuInteraction(connection, interaction) {
  if (interaction.customId === 'story_quick_join') {
    const storyId = parseInt(interaction.values[0]);
    await handleJoin(connection, interaction, storyId);

  } else if (interaction.customId.startsWith('story_join_privacy_')) {
    const state = pendingJoinData.get(interaction.user.id);
    if (!state) { await interaction.deferUpdate(); return; }
    state.privacy = interaction.values[0];
    pendingJoinData.set(interaction.user.id, state);
    await interaction.deferUpdate();
    await interaction.editReply(await buildJoinEmbed(connection, state));

  } else if (interaction.customId.startsWith('story_join_notif_')) {
    const state = pendingJoinData.get(interaction.user.id);
    if (!state) { await interaction.deferUpdate(); return; }
    state.notificationPrefs = interaction.values[0];
    pendingJoinData.set(interaction.user.id, state);
    await interaction.deferUpdate();
    await interaction.editReply(await buildJoinEmbed(connection, state));

  } else if (interaction.customId === 'story_filter_select') {
    const filter = interaction.values[0];
    await interaction.deferUpdate();
    await renderStoryListReply(connection, interaction, filter, 1);

  } else if (interaction.customId === 'story_read_jump') {
    await handleReadNav(connection, interaction);
  }
}

async function handleAutocomplete(connection, interaction) {
  if (!interaction.guild) return interaction.respond([]);

  const focusedOption = interaction.options.getFocused(true);
  const guildId = interaction.guild.id;
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  if (focusedOption.name === 'story_id') {
    const subcommand = interaction.options.getSubcommand();
    const typed = `%${focusedOption.value}%`;
    const typedPrefix = `${focusedOption.value}%`;
    let rows;

    if (subcommand === 'write') {
      [rows] = await connection.execute(
        `SELECT s.guild_story_id, s.title FROM story s
         JOIN story_writer sw ON sw.story_id = s.story_id
         JOIN turn t ON t.story_writer_id = sw.story_writer_id
         WHERE s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1 AND t.turn_status = 1
           AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
         ORDER BY s.guild_story_id LIMIT 25`,
        [guildId, interaction.user.id, typed, typedPrefix]
      );

    } else if (subcommand === 'join') {
      [rows] = await connection.execute(
        `SELECT s.guild_story_id, s.title FROM story s
         WHERE s.guild_id = ? AND s.story_status = 1 AND s.allow_joins = 1
           AND NOT EXISTS (SELECT 1 FROM story_writer sw
             WHERE sw.story_id = s.story_id AND sw.discord_user_id = ? AND sw.sw_status IN (1,2))
           AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
         ORDER BY s.guild_story_id LIMIT 25`,
        [guildId, interaction.user.id, typed, typedPrefix]
      );

    } else if (subcommand === 'read') {
      [rows] = await connection.execute(
        `SELECT s.guild_story_id, s.title,
           COALESCE(
             (SELECT MAX(se.created_at)
              FROM story_entry se
              JOIN turn t ON se.turn_id = t.turn_id
              JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
              WHERE sw.story_id = s.story_id AND se.entry_status = 'confirmed'),
             s.created_at
           ) AS last_activity
         FROM story s
         WHERE s.guild_id = ? AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
         ORDER BY last_activity DESC LIMIT 25`,
        [guildId, typed, typedPrefix]
      );

    } else if (subcommand === 'timeleft') {
      [rows] = await connection.execute(
        `SELECT s.guild_story_id, s.title,
           EXISTS (SELECT 1 FROM story_writer sw
             WHERE sw.story_id = s.story_id AND sw.discord_user_id = ? AND sw.sw_status IN (1,2)
           ) AS is_member
         FROM story s
         WHERE s.guild_id = ? AND s.story_status = 1
           AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
         ORDER BY is_member DESC, s.guild_story_id LIMIT 25`,
        [interaction.user.id, guildId, typed, typedPrefix]
      );

    } else if (subcommand === 'close' || subcommand === 'manage') {
      if (isAdmin) {
        [rows] = await connection.execute(
          `SELECT s.guild_story_id, s.title,
             EXISTS (SELECT 1 FROM story_writer sw
               WHERE sw.story_id = s.story_id AND sw.discord_user_id = ?
                 AND sw.story_writer_id = (SELECT MIN(story_writer_id) FROM story_writer WHERE story_id = s.story_id)
             ) AS is_creator
           FROM story s
           WHERE s.guild_id = ? AND s.story_status != 3
             AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
           ORDER BY is_creator DESC, s.guild_story_id LIMIT 25`,
          [interaction.user.id, guildId, typed, typedPrefix]
        );
      } else {
        [rows] = await connection.execute(
          `SELECT s.guild_story_id, s.title FROM story s
           JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
           WHERE s.guild_id = ? AND s.story_status != 3
             AND sw.story_writer_id = (SELECT MIN(story_writer_id) FROM story_writer WHERE story_id = s.story_id)
             AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
           ORDER BY s.guild_story_id LIMIT 25`,
          [interaction.user.id, guildId, typed, typedPrefix]
        );
      }

    } else if (subcommand === 'ping') {
      [rows] = await connection.execute(
        `SELECT s.guild_story_id, s.title FROM story s
         JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
         WHERE s.guild_id = ? AND sw.sw_status IN (1,2)
           AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
         ORDER BY s.guild_story_id LIMIT 25`,
        [interaction.user.id, guildId, typed, typedPrefix]
      );

    } else if (subcommand === 'edit') {
      [rows] = await connection.execute(
        `SELECT DISTINCT s.guild_story_id, s.title FROM story s
         JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
         JOIN turn t ON t.story_writer_id = sw.story_writer_id
         JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
         WHERE s.guild_id = ? AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
         ORDER BY s.guild_story_id LIMIT 25`,
        [interaction.user.id, guildId, typed, typedPrefix]
      );

    } else {
      return interaction.respond([]);
    }

    return interaction.respond(
      (rows ?? []).map(r => ({
        name: `${r.title} (#${r.guild_story_id})`.slice(0, 100),
        value: String(r.guild_story_id)
      }))
    );
  }

  if (focusedOption.name === 'turn') {
    const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
    if (!storyId) return interaction.respond([]);

    const typed = String(focusedOption.value);
    let rows;

    if (isAdmin) {
      [rows] = await connection.execute(
        `SELECT turn_number, discord_display_name, content FROM (
           SELECT
             (SELECT COUNT(DISTINCT t2.turn_id)
              FROM turn t2
              JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
              JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
              WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
             ) AS turn_number,
             sw.discord_display_name, se.content
           FROM story_entry se
           JOIN turn t ON se.turn_id = t.turn_id
           JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
           WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
         ) sub
         WHERE CAST(turn_number AS CHAR) LIKE ? OR discord_display_name LIKE ?
         ORDER BY turn_number LIMIT 25`,
        [storyId, `${typed}%`, `%${typed}%`]
      );
    } else {
      [rows] = await connection.execute(
        `SELECT turn_number, discord_display_name, content FROM (
           SELECT
             (SELECT COUNT(DISTINCT t2.turn_id)
              FROM turn t2
              JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
              JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
              WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
             ) AS turn_number,
             sw.discord_display_name, sw.discord_user_id, se.content
           FROM story_entry se
           JOIN turn t ON se.turn_id = t.turn_id
           JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
           WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
             AND sw.discord_user_id = ?
         ) sub
         WHERE CAST(turn_number AS CHAR) LIKE ? OR discord_display_name LIKE ?
         ORDER BY turn_number LIMIT 25`,
        [storyId, interaction.user.id, `${typed}%`, `%${typed}%`]
      );
    }

    return interaction.respond(
      rows.map(r => {
        const preview = r.content ? r.content.trim().slice(0, 25).trimEnd() : '';
        const label = preview
          ? `Turn ${r.turn_number} — ${r.discord_display_name} — "${preview}…"`
          : `Turn ${r.turn_number} — ${r.discord_display_name}`;
        return { name: label.slice(0, 100), value: r.turn_number };
      })
    );
  }

  return interaction.respond([]);
}

export default {
  data,
  execute,
  handleModalSubmit,
  handleButtonInteraction,
  handleSelectMenuInteraction,
  handleAutocomplete
};
