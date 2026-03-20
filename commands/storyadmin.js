import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, formattedDate, replaceTemplateVariables } from '../utilities.js';
import { PickNextWriter, NextTurn } from '../storybot.js';

// Pending config edit sessions keyed by userId
const pendingConfigData = new Map();

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
    s.setName('kick')
      .setDescription('Remove a writer from a story')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to remove').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('pause')
      .setDescription('Pause a story')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('resume')
      .setDescription('Resume a paused story')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('delete')
      .setDescription('Permanently delete a story and all its data')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('config')
      .setDescription('View and edit story settings')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Show all admin commands and what they do')
  );

async function execute(connection, interaction) {
  const guildId = interaction.guild.id;

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'help') return await handleHelp(interaction);

  if (!await checkIsAdmin(connection, interaction, guildId)) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtAdminOnly', guildId),
      flags: MessageFlags.Ephemeral
    });
  }
  if (subcommand === 'skip')        await handleSkip(connection, interaction);
  else if (subcommand === 'extend') await handleExtend(connection, interaction);
  else if (subcommand === 'kick')   await handleKick(connection, interaction);
  else if (subcommand === 'pause')  await handlePause(connection, interaction);
  else if (subcommand === 'resume') await handleResume(connection, interaction);
  else if (subcommand === 'delete') await handleDelete(connection, interaction);
  else if (subcommand === 'config') await handleConfig(connection, interaction);
}

// ---------------------------------------------------------------------------
// /storyadmin help
// ---------------------------------------------------------------------------
async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ StoryAdmin Commands')
    .setColor(0x5865f2)
    .addFields(
      {
        name: '/storyadmin skip <story_id>',
        value: 'Force-ends the active turn, deletes its thread, and advances to the next writer.',
        inline: false
      },
      {
        name: '/storyadmin extend <story_id> <hours>',
        value: 'Adds hours to the current turn deadline.',
        inline: false
      },
      {
        name: '/storyadmin kick <story_id> <user>',
        value: 'Removes a writer from a story. If it\'s their turn, advances to the next writer. If they\'re the last writer, the story is closed automatically.',
        inline: false
      },
      {
        name: '/storyadmin pause <story_id>',
        value: 'Pauses a story. The active turn is preserved and will resume when the story is unpaused.',
        inline: false
      },
      {
        name: '/storyadmin resume <story_id>',
        value: 'Resumes a paused story. If no turn is active, a new one is started immediately.',
        inline: false
      },
      {
        name: '/storyadmin delete <story_id>',
        value: 'Permanently deletes a story and all its turns, entries, and writer data. Requires confirmation.',
        inline: false
      },
      {
        name: '/storyadmin config <story_id>',
        value: 'Opens an edit form to change story settings: turn length, max writers, late joins, author visibility, and writer order.',
        inline: false
      }
    )
    .setFooter({ text: 'All actions are logged. All commands require the admin role or Discord Administrator.' });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
        if (thread) await thread.delete();
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
// /storyadmin kick
// ---------------------------------------------------------------------------
async function handleKick(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const targetUser = interaction.options.getUser('user');
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
          if (thread) await thread.delete();
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

    await logAdminAction(connection, interaction.user.id, 'kick', storyId, targetUser.id);
    const successMsg = replaceTemplateVariables(
      await getConfigValue(connection, 'txtAdminKickSuccess', guildId),
      { user_name: targetUser.displayName || targetUser.username, story_title: story.title }
    );
    const closeNote = isLastWriter ? '\n⚠️ Story auto-closed — no writers remain.' : '';
    await interaction.editReply({ content: successMsg + closeNote });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleKick:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin pause
// ---------------------------------------------------------------------------
async function handlePause(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_status FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    if (story.story_status === 2) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminAlreadyPaused', guildId) });
    }
    if (story.story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryAlreadyClosed', guildId) });
    }

    await connection.execute(`UPDATE story SET story_status = 2 WHERE story_id = ?`, [storyId]);
    await logAdminAction(connection, interaction.user.id, 'pause', storyId);

    await interaction.editReply({
      content: replaceTemplateVariables(await getConfigValue(connection, 'txtAdminPauseSuccess', guildId), {
        story_title: story.title
      })
    });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handlePause:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin resume
// ---------------------------------------------------------------------------
async function handleResume(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_status FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    if (story.story_status === 1) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminAlreadyActive', guildId) });
    }
    if (story.story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryAlreadyClosed', guildId) });
    }

    await connection.execute(`UPDATE story SET story_status = 1 WHERE story_id = ?`, [storyId]);

    // If no active turn exists, start one
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    let extraNote = '';
    if (activeTurnRows.length === 0) {
      const nextWriterId = await PickNextWriter(connection, storyId);
      if (nextWriterId) {
        await NextTurn(connection, interaction, nextWriterId);
        extraNote = ' The next turn has started.';
      }
    }

    await logAdminAction(connection, interaction.user.id, 'resume', storyId);
    await interaction.editReply({
      content: replaceTemplateVariables(await getConfigValue(connection, 'txtAdminResumeSuccess', guildId), {
        story_title: story.title
      }) + extraNote
    });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleResume:`, error);
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
        if (thread) await thread.delete();
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

// ---------------------------------------------------------------------------
// /storyadmin config — view and edit story settings
// ---------------------------------------------------------------------------
function buildConfigMessage(cfg, state) {
  const orderEmojis = { 1: '🎲', 2: '🔄', 3: '📋' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtAdminConfigTitle, { story_title: state.title }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblTurnLength, value: `${state.turnLength} hours`, inline: true },
      { name: cfg.lblMaxWriters, value: state.maxWriters ? String(state.maxWriters) : '∞', inline: true },
      { name: cfg.lblAllowLateJoins, value: state.allowLateJoins ? 'Yes' : 'No', inline: true },
      { name: cfg.lblShowAuthors, value: state.showAuthors ? 'Yes' : 'No', inline: true },
      { name: cfg.lblWriterOrder, value: `${orderEmoji} ${orderLabel}`, inline: true }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('storyadmin_config_set_turnlength')
      .setLabel(cfg.btnSetTurnLength)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('storyadmin_config_set_maxwriters')
      .setLabel(`${cfg.btnSetMaxWriters}: ${state.maxWriters ?? '∞'}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('storyadmin_config_toggle_latejoins')
      .setLabel(`${cfg.lblAllowLateJoins}: ${state.allowLateJoins ? 'Yes' : 'No'}`)
      .setStyle(state.allowLateJoins ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('storyadmin_config_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? 'Yes' : 'No'}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('storyadmin_config_cycle_order')
      .setLabel(`${orderEmoji} ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('storyadmin_config_save')
      .setLabel(cfg.btnAdminConfigSave)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('storyadmin_config_cancel')
      .setLabel(cfg.btnCancel)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function handleConfig(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, turn_length_hours, max_writers, allow_late_joins, show_authors, story_order_type
       FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    const cfg = await getConfigValue(connection, [
      'txtAdminConfigTitle', 'btnAdminConfigSave', 'btnCancel',
      'lblTurnLength', 'btnSetTurnLength',
      'lblMaxWriters', 'btnSetMaxWriters',
      'lblAllowLateJoins', 'lblShowAuthors',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed'
    ], guildId);

    const state = {
      cfg,
      storyId,
      title: story.title,
      turnLength: story.turn_length_hours,
      maxWriters: story.max_writers,
      allowLateJoins: story.allow_late_joins,
      showAuthors: story.show_authors,
      orderType: story.story_order_type,
      originalInteraction: interaction
    };

    pendingConfigData.set(interaction.user.id, state);
    await interaction.editReply(buildConfigMessage(cfg, state));

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleConfig:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleConfigButton(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingConfigData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const customId = interaction.customId;

  if (customId === 'storyadmin_config_toggle_latejoins') {
    state.allowLateJoins = state.allowLateJoins ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildConfigMessage(state.cfg, state));

  } else if (customId === 'storyadmin_config_toggle_authors') {
    state.showAuthors = state.showAuthors ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildConfigMessage(state.cfg, state));

  } else if (customId === 'storyadmin_config_cycle_order') {
    state.orderType = state.orderType === 3 ? 1 : state.orderType + 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildConfigMessage(state.cfg, state));

  } else if (customId === 'storyadmin_config_set_turnlength') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('storyadmin_config_turnlength_modal')
        .setTitle(state.cfg.lblTurnLength)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('turn_length')
              .setLabel(state.cfg.lblTurnLength)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.turnLength))
              .setPlaceholder('Enter number of hours')
          )
        )
    );

  } else if (customId === 'storyadmin_config_set_maxwriters') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('storyadmin_config_maxwriters_modal')
        .setTitle(state.cfg.lblMaxWriters)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_writers')
              .setLabel(state.cfg.lblMaxWriters)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.maxWriters != null ? String(state.maxWriters) : '')
              .setPlaceholder('Enter a number, or leave blank for no limit')
          )
        )
    );

  } else if (customId === 'storyadmin_config_save') {
    await interaction.deferUpdate();
    await handleConfigSave(connection, interaction, state);

  } else if (customId === 'storyadmin_config_cancel') {
    await interaction.deferUpdate();
    pendingConfigData.delete(userId);
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
}

async function handleConfigSave(connection, interaction, state) {
  const guildId = interaction.guild.id;
  try {
    await connection.execute(
      `UPDATE story SET turn_length_hours = ?, max_writers = ?, allow_late_joins = ?,
       show_authors = ?, story_order_type = ? WHERE story_id = ?`,
      [state.turnLength, state.maxWriters ?? null, state.allowLateJoins,
       state.showAuthors, state.orderType, state.storyId]
    );
    pendingConfigData.delete(interaction.user.id);
    await logAdminAction(connection, interaction.user.id, 'config', state.storyId);
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtAdminConfigSaved', guildId),
      embeds: [],
      components: []
    });
  } catch (error) {
    console.error(`${formattedDate()}: Error saving config:`, error);
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'errProcessingRequest', guildId),
      embeds: [],
      components: []
    });
  }
}

async function handleModalSubmit(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingConfigData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.customId === 'storyadmin_config_turnlength_modal') {
    const val = parseInt(sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 10));
    if (isNaN(val) || val < 1) {
      return await interaction.reply({ content: 'Turn length must be at least 1 hour.', flags: MessageFlags.Ephemeral });
    }
    state.turnLength = val;

  } else if (interaction.customId === 'storyadmin_config_maxwriters_modal') {
    const raw = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
    if (raw) {
      const val = parseInt(raw);
      if (isNaN(val) || val < 1) {
        return await interaction.reply({ content: 'Max writers must be at least 1, or leave blank for no limit.', flags: MessageFlags.Ephemeral });
      }
      state.maxWriters = val;
    } else {
      state.maxWriters = null;
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await state.originalInteraction.editReply(buildConfigMessage(state.cfg, state));
  await interaction.deleteReply();
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('storyadmin_delete_confirm_')) {
    await handleDeleteConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_delete_cancel_')) {
    await handleDeleteCancel(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_config_')) {
    await handleConfigButton(connection, interaction);
  }
}

export default { data, execute, handleModalSubmit, handleButtonInteraction };
