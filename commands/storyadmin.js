import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, formattedDate, replaceTemplateVariables } from '../utilities.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';

async function checkIsAdmin(connection, interaction, guildId) {
  const adminRoleName = await getConfigValue(connection, 'cfgAdminRoleName', guildId);
  return interaction.member.permissions.has('Administrator') ||
    (adminRoleName && interaction.member.roles.cache.some(r => r.name === adminRoleName));
}

async function logAdminAction(connection, adminUserId, actionType, storyId, targetUserId = null, reason = null) {
  try {
    await connection.execute(
      `INSERT INTO admin_action_log (admin_user_id, action_type, target_story_id, target_user_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [adminUserId, actionType, storyId ?? null, targetUserId ?? null, reason ?? null]
    );
  } catch (err) {
    console.error(`${formattedDate()}: Failed to log admin action:`, err);
  }
}

const data = new SlashCommandBuilder()
  .setName('storyadmin')
  .setDescription('Admin tools for story management')
  .addSubcommand(s =>
    s.setName('skip')
      .setDescription('Force-skip the current writer\'s turn and advance to the next writer')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('extend')
      .setDescription('Add hours to the current turn deadline')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addIntegerOption(o =>
        o.setName('hours').setDescription('Hours to add').setRequired(true).setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName('remove')
      .setDescription('Remove a writer from a story')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to remove').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('next')
      .setDescription('Designate which writer will get the next turn')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to designate as next').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('delete')
      .setDescription('Permanently delete a story and all its data')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Show all admin commands and what they do')
  )
  .addSubcommand(s =>
    s.setName('setup')
      .setDescription('Configure Round Robin StoryBot for this server')
  );

async function execute(connection, interaction) {
  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'help')  return await handleHelp(connection, interaction, guildId);
  if (subcommand === 'setup') return await handleSetup(connection, interaction);

  if (!await checkIsAdmin(connection, interaction, guildId)) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtAdminOnly', guildId),
      flags: MessageFlags.Ephemeral
    });
  }
  if (subcommand === 'skip')        await handleSkip(connection, interaction);
  else if (subcommand === 'extend') await handleExtend(connection, interaction);
  else if (subcommand === 'remove') await handleKick(connection, interaction);
  else if (subcommand === 'next')   await handleNext(connection, interaction);
  else if (subcommand === 'delete') await handleDelete(connection, interaction);
}

// ---------------------------------------------------------------------------
// /storyadmin help
// ---------------------------------------------------------------------------
async function handleHelp(connection, interaction, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtAdminHelpTitle', 'txtAdminHelpFooter',
    'lblAdminHelpSkip', 'txtAdminHelpSkip',
    'lblAdminHelpExtend', 'txtAdminHelpExtend',
    'lblAdminHelpRemove', 'txtAdminHelpRemove',
    'lblAdminHelpNext', 'txtAdminHelpNext',
    'lblAdminHelpDelete', 'txtAdminHelpDelete',
    'lblAdminHelpSetup', 'txtAdminHelpSetup'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtAdminHelpTitle)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblAdminHelpSkip,   value: cfg.txtAdminHelpSkip,   inline: false },
      { name: cfg.lblAdminHelpExtend, value: cfg.txtAdminHelpExtend, inline: false },
      { name: cfg.lblAdminHelpRemove, value: cfg.txtAdminHelpRemove, inline: false },
      { name: cfg.lblAdminHelpNext,   value: cfg.txtAdminHelpNext,   inline: false },
      { name: cfg.lblAdminHelpDelete, value: cfg.txtAdminHelpDelete, inline: false },
      { name: cfg.lblAdminHelpSetup,  value: cfg.txtAdminHelpSetup,  inline: false }
    )
    .setFooter({ text: cfg.txtAdminHelpFooter });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// /storyadmin setup
// ---------------------------------------------------------------------------
async function handleSetup(connection, interaction) {
  if (!interaction.member.permissions.has('ManageGuild')) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtSetupNoPermission', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  const cfg = await getConfigValue(connection, [
    'txtSetupModalTitle',
    'lblSetupFeedChannel', 'txtSetupFeedChannelPlaceholder',
    'lblSetupMediaChannel', 'txtSetupMediaChannelPlaceholder',
    'lblSetupAdminRole', 'txtSetupAdminRolePlaceholder',
    'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName'
  ], guildId);

  const modal = new ModalBuilder()
    .setCustomId('storyadmin_setup_modal')
    .setTitle(cfg.txtSetupModalTitle);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('feed_channel')
        .setLabel(cfg.lblSetupFeedChannel)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupFeedChannelPlaceholder)
        .setValue(cfg.cfgStoryFeedChannelId !== 'cfgStoryFeedChannelId' ? cfg.cfgStoryFeedChannelId : '')
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('media_channel')
        .setLabel(cfg.lblSetupMediaChannel)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupMediaChannelPlaceholder)
        .setValue(cfg.cfgMediaChannelId !== 'cfgMediaChannelId' ? cfg.cfgMediaChannelId : '')
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('admin_role')
        .setLabel(cfg.lblSetupAdminRole)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupAdminRolePlaceholder)
        .setValue(cfg.cfgAdminRoleName !== 'cfgAdminRoleName' ? cfg.cfgAdminRoleName : '')
        .setRequired(false)
    )
  );

  await interaction.showModal(modal);
}

async function handleSetupModalSubmit(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;

  const feedRaw  = sanitizeModalInput(interaction.fields.getTextInputValue('feed_channel'), 30);
  const mediaRaw = sanitizeModalInput(interaction.fields.getTextInputValue('media_channel'), 30);
  const roleRaw  = sanitizeModalInput(interaction.fields.getTextInputValue('admin_role'), 100);

  // Extract channel ID from mention (<#ID>) or raw ID
  const feedChannelId  = feedRaw.match(/\d+/)?.[0];
  const mediaChannelId = mediaRaw.match(/\d+/)?.[0];

  // Validate feed channel exists
  const feedChannel = feedChannelId
    ? await interaction.guild.channels.fetch(feedChannelId).catch(() => null)
    : null;

  if (!feedChannel) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtSetupFeedChannelInvalid', guildId)
    });
  }

  // Validate media channel if provided
  if (mediaChannelId) {
    const mediaChannel = await interaction.guild.channels.fetch(mediaChannelId).catch(() => null);
    if (!mediaChannel) {
      return await interaction.editReply({
        content: await getConfigValue(connection, 'txtSetupMediaChannelInvalid', guildId)
      });
    }
  }

  // Write config values — INSERT or UPDATE if already set
  const upsert = (key, value) => connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES (?, ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [key, value, guildId]
  );

  await upsert('cfgStoryFeedChannelId', feedChannelId);
  if (mediaChannelId) await upsert('cfgMediaChannelId', mediaChannelId);
  if (roleRaw)        await upsert('cfgAdminRoleName', roleRaw);

  const saved = [`✅ Story feed channel: <#${feedChannelId}>`];
  if (mediaChannelId) saved.push(`✅ Media channel: <#${mediaChannelId}>`);
  if (roleRaw)        saved.push(`✅ Admin role: **${roleRaw}**`);
  if (!mediaChannelId) saved.push(`ℹ️ No media channel set — images will not be processed.`);
  if (!roleRaw)        saved.push(`ℹ️ No admin role set — only Discord Administrators can use admin commands.`);

  await interaction.editReply({ content: saved.join('\n') });
}

// ---------------------------------------------------------------------------
// /storyadmin skip
// ---------------------------------------------------------------------------
async function handleSkip(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const activeTurn = activeTurnRows[0];
    await connection.execute(
      `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
      [activeTurn.turn_id]
    );

    if (activeTurn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
        if (thread) await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        console.error(`${formattedDate()}: Could not delete turn thread on admin skip:`, err);
      }
    }

    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);

    await logAdminAction(connection, interaction.user.id, 'skip', storyId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminSkipSuccess', guildId) });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleSkip:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin extend
// ---------------------------------------------------------------------------
async function handleExtend(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const hours = interaction.options.getInteger('hours');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const turnId = activeTurnRows[0].turn_id;
    await connection.execute(
      `UPDATE turn SET turn_ends_at = DATE_ADD(COALESCE(turn_ends_at, NOW()), INTERVAL ? HOUR) WHERE turn_id = ?`,
      [hours, turnId]
    );

    const [updatedRows] = await connection.execute(
      `SELECT UNIX_TIMESTAMP(turn_ends_at) as new_end_unix, turn_ends_at FROM turn WHERE turn_id = ?`,
      [turnId]
    );
    const { new_end_unix: newEndUnix, turn_ends_at: newTurnEndsAt } = updatedRows[0];

    // Cancel the old turnTimeout job and schedule a new one at the updated deadline
    await connection.execute(
      `UPDATE job SET job_status = 2 WHERE job_type = 'turnTimeout' AND job_status = 0
       AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
      [turnId]
    );
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
      ['turnTimeout', JSON.stringify({ turnId, storyId, guildId }), newTurnEndsAt]
    );

    await logAdminAction(connection, interaction.user.id, 'extend', storyId, null, `+${hours}h`);
    const msg = replaceTemplateVariables(await getConfigValue(connection, 'txtAdminExtendSuccess', guildId), {
      hours,
      new_end_time: `<t:${newEndUnix}:f>`
    });
    await interaction.editReply({ content: msg });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleExtend:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin remove
// ---------------------------------------------------------------------------
async function handleKick(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const targetUser = interaction.options.getUser('user');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_thread_id FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    const [writerRows] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    // Check if it's their active turn
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, targetUser.id]
    );

    // Check if they're the last writer
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, targetUser.id]
    );
    const isLastWriter = remainingRows[0].count === 0;

    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurn.turn_id]);
      if (activeTurn.thread_id) {
        try {
          const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
          if (thread) await deleteThreadAndAnnouncement(thread);
        } catch (err) {
          console.error(`${formattedDate()}: Could not delete thread on kick:`, err);
        }
      }
    }

    await connection.execute(
      `UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_id = ? AND discord_user_id = ?`,
      [storyId, targetUser.id]
    );

    if (isLastWriter) {
      await connection.execute(`UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`, [storyId]);
      console.log(`${formattedDate()}: Story ${storyId} auto-closed after admin kick of last writer`);
    } else if (activeTurnRows.length > 0) {
      const nextWriterId = await PickNextWriter(connection, storyId);
      if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
    }

    await logAdminAction(connection, interaction.user.id, 'remove', storyId, targetUser.id);
    const removedName = targetUser.displayName || targetUser.username;
    const successMsg = replaceTemplateVariables(
      await getConfigValue(connection, 'txtAdminKickSuccess', guildId),
      { user_name: removedName, story_title: story.title }
    );
    const closeNote = isLastWriter ? '\n⚠️ Story auto-closed — no writers remain.' : '';
    await interaction.editReply({ content: successMsg + closeNote });

    // Activity log (fire-and-forget)
    getConfigValue(connection, 'txtStoryThreadWriterRemove', guildId).then(template =>
      postStoryThreadActivity(connection, interaction.guild, storyId, template.replace('[writer_name]', removedName))
    ).catch(() => {});

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleKick:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin next
// ---------------------------------------------------------------------------
async function handleNext(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const targetUser = interaction.options.getUser('user');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, story_status FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    if (storyRows[0].story_status !== 1) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotActive', guildId) });
    }

    // Verify the target is an active writer
    const [writerRows] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    // Check if there's an active turn
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, sw.discord_user_id as current_writer_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );

    const targetStoryWriterId = writerRows[0].story_writer_id;

    if (activeTurnRows.length === 0) {
      // No active turn — start theirs immediately (clear any existing override first)
      await connection.execute(`UPDATE story SET next_writer_id = NULL WHERE story_id = ?`, [storyId]);
      await NextTurn(connection, interaction, targetStoryWriterId);
      await logAdminAction(connection, interaction.user.id, 'next', storyId, targetUser.id);
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    const currentWriterId = activeTurnRows[0].current_writer_id;
    if (currentWriterId === targetUser.id) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminNextAlreadyCurrent', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    // Store override — will be applied when the current turn ends
    await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [targetStoryWriterId, storyId]);
    await logAdminAction(connection, interaction.user.id, 'next', storyId, targetUser.id);
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
        { user_name: targetUser.displayName || targetUser.username }
      )
    });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleNext:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin delete
// ---------------------------------------------------------------------------
async function handleDelete(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

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
    console.error(`${formattedDate()}: Error in handleDelete:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDeleteConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
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

    // Try to delete the Discord story thread
    if (story.story_thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(story.story_thread_id);
        if (thread) await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        console.log(`${formattedDate()}: Story thread already gone for story ${storyId}`);
      }
    }

    // Hard delete — cascades to story_writer, turn, story_entry
    await connection.execute(`DELETE FROM story WHERE story_id = ?`, [storyId]);

    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminDeleteSuccess', guildId),
        { story_title: story.title }
      ),
      components: []
    });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleDeleteConfirm:`, error);
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
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'storyadmin_setup_modal') {
    await handleSetupModalSubmit(connection, interaction);
  }
}

export default { data, execute, handleButtonInteraction, handleModalSubmit };
