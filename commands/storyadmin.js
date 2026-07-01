import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, TextDisplayBuilder, LabelBuilder, ChannelSelectMenuBuilder } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId, checkIsAdmin, storyLastActivitySQL } from '../utilities.js';
import { handleManageUser, handleManageUserButton, handleManageUserModalSubmit } from '../story/_manageUser.js';
import { syncFaqPosts, handleAdminHelp } from '../faq.js';
import { deleteThreadAndAnnouncement } from '../story/_turn.js';
import { handleSetup, handleSetupButton, handleSetupChannelsModal, handleSetupRoundupModal, handleSetupRoleModal } from './_storyadminSetup.js';

async function logAdminAction(connection, adminUserId, actionType, storyId, targetUserId = null, reason = null) {
  try {
    await connection.execute(
      `INSERT INTO admin_action_log (admin_user_id, action_type, target_story_id, target_user_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [adminUserId, actionType, storyId ?? null, targetUserId ?? null, reason ?? null]
    );
  } catch (err) {
    log(`Failed to log admin action: ${err}`, { show: true });
  }
}

const data = new SlashCommandBuilder()
  .setName('storyadmin')
  .setDescription('Admin tools for story management')
  .addSubcommand(s =>
    s.setName('user')
      .setDescription('Manage a writer\'s participation in a story')
      .addStringOption(o =>
        o.setName('story_id').setDescription('Story the writer is in').setRequired(true).setAutocomplete(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to manage').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('delete')
      .setDescription('Permanently delete a story and all its data')
      .addStringOption(o =>
        o.setName('story_id').setDescription('Story to delete').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('setup')
      .setDescription('Configure Round Robin StoryBot for this server')
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Show all admin commands and what they do')
  )
  .addSubcommand(s =>
    s.setName('faqsync')
      .setDescription('Re-sync the FAQ forum posts from current config values')
  )
  ;

async function execute(connection, interaction) {
  log(`execute entry subcommand=${interaction.options.getSubcommand()} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'help')  return await handleAdminHelp(connection, interaction, guildId);
  if (subcommand === 'setup') return await handleSetup(connection, interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!await checkIsAdmin(connection, interaction, guildId)) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtAdminOnly', guildId),
    });
  }
  if (subcommand === 'user')         await handleManageUser(connection, interaction);
  else if (subcommand === 'delete')  await handleDelete(connection, interaction);
  else if (subcommand === 'faqsync') await handleFaqSync(connection, interaction);
}

// ---------------------------------------------------------------------------
// [TEMP] /storyadmin modaltest — verify TextDisplay, LabelBuilder, ChannelSelect in modals
// ---------------------------------------------------------------------------

async function handleModalTest(interaction) {
  log(`handleModalTest entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const modal = new ModalBuilder()
    .setCustomId('storyadmin_modaltest_modal')
    .setTitle('Modal Component Test');

  modal.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Test Heading\nThis text is from a TextDisplayBuilder. If you can read this with heading formatting, TextDisplay works in modals.')
  );

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('Channel Select (pick any text channel)')
      .setChannelSelectMenuComponent(
        new ChannelSelectMenuBuilder()
          .setCustomId('testChannel')
          .addChannelTypes(4)
//          .setMinValues(0)
          .setMaxValues(1)
      )
  );

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('Text Input (type anything)')
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId('testText')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('optional text here')
      )
  );

  await interaction.showModal(modal);
}

async function handleModalTestSubmit(interaction) {
  log(`handleModalTestSubmit entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let channelResult = '(none selected)';
  let textResult = '(empty)';

  try {
    const channelField = interaction.fields.getField('testChannel');
    log(`handleModalTestSubmit: channelField raw`, { show: false, guildName: interaction?.guild?.name });
    log(channelField, { show: false, guildName: interaction?.guild?.name });
    const channelId = channelField?.channels?.first()?.id ?? channelField?.values?.[0] ?? null;
    if (channelId) channelResult = `<#${channelId}> (id: ${channelId})`;
  } catch (err) {
    channelResult = `ERROR reading channel: ${err.message}`;
    log(`handleModalTestSubmit: channel read failed: ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  try {
    const raw = interaction.fields.getTextInputValue('testText');
    if (raw) textResult = raw;
  } catch (err) {
    textResult = `ERROR reading text: ${err.message}`;
    log(`handleModalTestSubmit: text read failed: ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  await interaction.editReply({
    content: `**Modal Test Results**\nChannel: ${channelResult}\nText: ${textResult}`
  });
}

// ---------------------------------------------------------------------------
// /storyadmin faqsync
// ---------------------------------------------------------------------------

async function handleFaqSync(connection, interaction) {
  log(`handleFaqSync entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;

  const { errors, total } = await syncFaqPosts(interaction.client, connection, guildId);

  if (errors === 0) {
    const msg = await getConfigValue(connection, 'txtHelpFaqSyncSuccess', guildId);
    await interaction.editReply({ content: msg });
  } else if (errors === total) {
    const msg = await getConfigValue(connection, 'txtHelpFaqSyncNoThreads', guildId);
    await interaction.editReply({ content: msg });
  } else {
    const template = await getConfigValue(connection, 'txtHelpFaqSyncPartial', guildId);
    await interaction.editReply({ content: replaceTemplateVariables(template, { error_count: String(errors) }) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin delete
// ---------------------------------------------------------------------------

async function handleDelete(connection, interaction) {
  log(`handleDelete entry user=${interaction.user.username} story_id=${interaction.options.getString('story_id')}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    const [txtAdminDeleteConfirm, btnConfirmDelete, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtAdminDeleteConfirm', guildId),
      getConfigValue(connection, 'btnConfirmDelete', guildId),
      getConfigValue(connection, 'btnCancel', guildId)
    ]);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_delete_confirm_${storyId}`)
        .setLabel(btnConfirmDelete)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`storyadmin_delete_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content: replaceTemplateVariables(txtAdminDeleteConfirm, { story_title: story.title }),
      components: [row]
    });

  } catch (error) {
    log(`handleDelete failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDeleteConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  log(`handleDeleteConfirm entry storyId=${storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_thread_id FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), components: [] });
    }
    const story = storyRows[0];

    // Log before deleting so the story_id still exists in the log
    await logAdminAction(connection, interaction.user.id, 'delete', storyId);

    // Hard delete — cascades to story_writer, turn, story_entry
    await connection.execute(`DELETE FROM story WHERE story_id = ?`, [storyId]);

    // Edit the reply before deleting the thread — if the command was run from inside
    // the story thread, deleting it first would destroy the ephemeral interaction context.
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminDeleteSuccess', guildId),
        { story_title: story.title }
      ),
      components: []
    });

    // Delete the Discord story thread after replying
    if (story.story_thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(story.story_thread_id);
        if (thread) await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        log(`Story thread already gone for story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
      }
    }

  } catch (error) {
    log(`handleDeleteConfirm failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handleDeleteCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({
    content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
    components: []
  });
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('storyadmin_delete_confirm_')) {
    await handleDeleteConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_delete_cancel_')) {
    await handleDeleteCancel(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_mu_')) {
    await handleManageUserButton(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_setup_')) {
    await handleSetupButton(connection, interaction);
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'storyadmin_setup_channels_modal') {
    await handleSetupChannelsModal(connection, interaction);
  } else if (interaction.customId === 'storyadmin_setup_roundup_modal') {
    await handleSetupRoundupModal(connection, interaction);
  } else if (interaction.customId === 'storyadmin_setup_role_modal') {
    await handleSetupRoleModal(connection, interaction);
  } else if (interaction.customId === 'storyadmin_modaltest_modal') {
    await handleModalTestSubmit(interaction);
  } else if (interaction.customId.startsWith('storyadmin_mu_')) {
    await handleManageUserModalSubmit(connection, interaction);
  }
}

async function handleAutocomplete(connection, interaction) {
  if (!interaction.guild) return interaction.respond([]);
  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== 'story_id') return interaction.respond([]);
  const guildId = interaction.guild.id;
  const typed = `%${focusedOption.value}%`;
  const typedPrefix = `${focusedOption.value}%`;
  const [rows] = await connection.execute(
    `SELECT s.guild_story_id, s.title,
       EXISTS (SELECT 1 FROM story_writer sw
         WHERE sw.story_id = s.story_id AND sw.discord_user_id = ?
           AND sw.story_writer_id = (SELECT MIN(story_writer_id) FROM story_writer WHERE story_id = s.story_id)
       ) AS is_creator
     FROM story s
     WHERE s.guild_id = ? AND s.story_status != 3
       AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
     ORDER BY is_creator DESC, ${storyLastActivitySQL()} DESC LIMIT 25`,
    [interaction.user.id, guildId, typed, typedPrefix]
  );
  return interaction.respond(
    rows.map(r => ({
      name: `${r.title} (#${r.guild_story_id})`.slice(0, 100),
      value: String(r.guild_story_id)
    }))
  );
}

export default { data, execute, handleButtonInteraction, handleModalSubmit, handleAutocomplete };
