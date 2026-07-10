import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId, checkIsAdmin, checkIsCreator, parseDuration, formatDuration } from '../utilities.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { migrateStoryThread } from './_migration.js';
import { ratingCodes, ratingLabelKey, warningOptions, dynamicOptions, crossesBarrier, isRestricted, isRestrictedChannelConfigured } from './_metadata.js';
import { getMetaCfg, buildStoryEmbed, buildMetadataModal, buildTagsModal, buildStoryInfoModal } from './_metadataModals.js';
import { buildTurnActionsPanel, handleTurnActionButton, handleTurnActionConfirm, handleTurnActionCancel, handleTurnActionSelectMenu, handleTurnActionModal } from './_manageTurnActions.js';
import { handleManageEntriesButton, handleManageEntriesSelectMenu } from './_manageEntries.js';
import { buildTagReviewPanel, handleReviewTags, handleTagReviewButton } from './tags.js';
import { applyPauseActions, applyResumeActions, handleReopenStory } from './_managePauseResume.js';

const pendingManageData = new Map();

function buildManageMessage(cfg, state, activeTurn = null) {
  const isPaused = state.targetStatus === 2;
  const isClosed = state.targetStatus === 3;

  const embed = buildStoryEmbed(cfg, state, cfg.txtManageEmbedTitle, true);

  // Row 1 (3): Set Title and Summary | Story Info | Story Settings
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_open_titlesummary')
      .setLabel(cfg.btnAddTitleAndSummary)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_open_storyinfo')
      .setLabel(cfg.btnAddStoryInfo)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_open_settings')
      .setLabel(cfg.btnAddSettings)
      .setStyle(ButtonStyle.Primary),
  );

  // Row 2 (2): Manage Entries | Manage Turns
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_entries_open')
      .setLabel(cfg.btnManageEntries)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_turns_open')
      .setLabel(cfg.btnManageTurns)
      .setStyle(ButtonStyle.Primary),
  );

  // Row 3 (3): Story Metadata | Story Tags | Review Tags (always shown, disabled if none pending)
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_open_metadata')
      .setLabel(cfg.btnAddMetadata)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_open_tags')
      .setLabel(cfg.btnAddTags)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_review_tags')
      .setLabel(replaceTemplateVariables(cfg.btnReviewTags, { count: state.pendingTagCount || 0 }))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!state.pendingTagCount),
  );

  // Row 4 (3): Open/Close Joins | Pause/Resume Story | Close/Reopen Story
  const pauseResumeLabel = cfg.txtStory + ' ' + (isPaused ? cfg.txtResume : cfg.txtPause);
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_latejoins')
      .setLabel(state.allowJoins ? cfg.btnManageJoinsClose : cfg.btnManageJoinsOpen)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_pauseresume')
      .setLabel(pauseResumeLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isClosed),
    isClosed
      ? new ButtonBuilder()
          .setCustomId('story_manage_reopen')
          .setLabel(cfg.txtReopenStory)
          .setStyle(ButtonStyle.Success)
      : new ButtonBuilder()
          .setCustomId('story_manage_close_open')
          .setLabel(cfg.btnCloseConfirm)
          .setStyle(ButtonStyle.Danger),
  );

  // Row 5 (1): Save Settings
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_save')
      .setLabel(cfg.btnSaveSettings)
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

async function handleManage(connection, interaction, alreadyDeferred = false) {
  log(`handleManage: entry user=${interaction.user.username} alreadyDeferred=${alreadyDeferred}`, { show: false, guildName: interaction?.guild?.name });
  if (!alreadyDeferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, mode, turn_length_hours, reminder_timing,
              max_writers, allow_joins, show_authors, story_order_type, summary, tags, story_turn_privacy,
              rating, warnings, main_pairing, other_relationships, characters, dynamic,
              story_thread_id, scene_break_divider
       FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    const isCreator = await checkIsCreator(connection, storyId, interaction.user.id);
    const isAdmin = await checkIsAdmin(connection, interaction, guildId);

    if (!isCreator && !isAdmin) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtManageNotAuthorized', guildId) });
    }

    const cfg = await getMetaCfg(connection, guildId);

    const extraCfg = await getConfigValue(connection, [
      'txtOpen', 'txtClosed', 'txtActive', 'txtPaused', 'txtHrs',
      'txtStory', 'txtPause', 'txtResume', 'txtNotSet',
      'btnAdminConfigSave', 'btnCancel',
      'lblOpenToWriters', 'lblTags', 'btnSetTags',
      'lblRating', 'lblWarnings', 'lblDynamic',
      'btnReviewTags',
      'txtSelectionStaged',
      'txtSectionBreakLine', 'txtManageSectionBreakMeta',
      'lblManageStoryTitle', 'lblManageStoryStatus', 'btnManageJoinsOpen', 'btnManageJoinsClose',
      'txtManageStoryStatusActive', 'txtManageStoryStatusPaused',
      'txtManageJoinOpen', 'txtManageJoinClosed',
      'txtManageSetTitleModalTitle', 'lblManageSetTitleField', 'txtManageSetTitlePlaceholder',
      'txtTurnLengthPlaceholder', 'txtTimeoutReminderPlaceholder', 'txtTimeoutReminderSlowPlaceholder',
      'txtManageMaxWritersPlaceholder', 'txtManageTagsPlaceholder',
      'txtManageValidationTurnLength', 'txtManageValidationSlowReminder',
      'txtManageValidationTimeout', 'txtManageValidationMaxWriters',
      'txtMustBeNo', 'txtTimeoutReminderValidation',
      'txtAddValidationTitleEmpty',
      'btnManageTurns', 'btnManageEntries',
      'txtTagPendingTitle', 'txtTagNoPending', 'btnTagApprove', 'btnTagReject', 'txtTagVoteCount',
      'txtManageTurnsPanelTitle', 'txtManageTurnsNoTurn', 'txtManageTurnsActiveTurn',
      'btnTurnSkip', 'btnTurnExtend', 'btnTurnNext', 'btnTurnReassign',
      'btnTurnDeleteEntry', 'btnTurnRestoreEntry', 'txtTurnSkipConfirm',
      'txtTurnReassignConfirm', 'txtTurnExtendModalTitle', 'lblTurnExtendHours',
      'txtTurnExtendPlaceholder', 'txtTurnDeleteEntryModalTitle', 'lblTurnDeleteEntryTurn',
      'txtTurnDeleteEntryPlaceholder', 'txtTurnRestoreEntryModalTitle', 'lblTurnRestoreEntryId',
      'txtTurnRestoreEntryPlaceholder', 'txtTurnNextSelectWrite',
      'txtReopenStory', 'txtStoryCloseConfirm', 'btnCloseConfirm',
      'txtAdminConfigSaved', 'errProcessingRequest', 'txtActionCancelled', 'txtActionSessionExpired',
      'txtManageNotAuthorized', 'txtStoryNotFound',
    ], guildId);

    Object.assign(cfg, extraCfg);

    log(`handleManage: cfg loaded`, { show: false, guildName: interaction?.guild?.name });

    const [[{ pendingTagCount }]] = await connection.execute(
      `SELECT COUNT(*) AS pendingTagCount FROM story_tag_submission WHERE story_id = ? AND submission_status = 'pending'`,
      [storyId]
    );

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_display_name, sw.discord_user_id,
              sw.story_writer_id, UNIX_TIMESTAMP(t.turn_ends_at) as turn_ends_unix
       FROM turn t JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    const activeTurn = activeTurnRows.length > 0 ? activeTurnRows[0] : null;
    log(`handleManage: activeTurn=${activeTurn ? activeTurn.turn_id : 'none'} isCreator=${isCreator} isAdmin=${isAdmin}`, { show: false, guildName: interaction?.guild?.name });

    const state = {
      cfg,
      storyId,
      guildStoryId: story.guild_story_id,
      guildId,
      title: story.title,
      storyTitle: story.title,
      storyMode: story.mode ?? 0,
      turnLength: story.turn_length_hours,
      timeoutReminder: story.reminder_timing ?? 50,
      maxWriters: story.max_writers,
      allowJoins: story.allow_joins,
      showAuthors: story.show_authors,
      orderType: story.story_order_type,
      storyTurnPrivacy: story.story_turn_privacy,
      summary: story.summary ?? '',
      sceneBreakDivider: story.scene_break_divider ?? '',
      tags: story.tags ?? '',
      originalStatus: story.story_status,
      targetStatus: story.story_status,
      originalInteraction: interaction,
      rating: story.rating ?? 'NR',
      originalRating: story.rating ?? 'NR',
      warnings: story.warnings ? story.warnings.split(',').map(w => w.trim()).filter(Boolean) : [],
      mainPairing: story.main_pairing ?? '',
      otherRelationships: story.other_relationships ?? '',
      characters: story.characters ?? '',
      dynamic: story.dynamic ?? '',
      pendingTagCount: Number(pendingTagCount),
      storyThreadId: story.story_thread_id ?? null,
      isAdminOrCreator: isCreator || isAdmin,
      guildName: interaction.guild.name,
      activeTurn,
      delayHours: null,
      delayWriters: null,
    };

    pendingManageData.set(interaction.user.id, state);
    log(`handleManage: sending panel`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageMessage(cfg, state, activeTurn));

  } catch (error) {
    log(`Error in handleManage: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleManageButton(connection, interaction) {
  log(`handleManageButton entry user=${interaction.user.username} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const userId = interaction.user.id;
  const state = pendingManageData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const customId = interaction.customId;

  try {
    if (customId === 'story_manage_open_storyinfo') {
      await interaction.showModal(buildStoryInfoModal(state.cfg, state, 'story_manage'));

    } else if (customId === 'story_manage_toggle_latejoins') {
      state.allowJoins = state.allowJoins ? 0 : 1;
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

    } else if (customId === 'story_manage_close_open') {
      // Reuses the standalone /story close confirm/cancel flow — story_close_confirm_<id> and
      // story_close_cancel_<id> are routed centrally in commands/story.js to handleCloseConfirm/handleCloseCancel.
      const cfg = state.cfg;
      const confirmMsg = replaceTemplateVariables(cfg.txtStoryCloseConfirm, { story_title: state.title });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`story_close_confirm_${state.storyId}`)
          .setLabel(cfg.btnCloseConfirm)
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`story_close_cancel_${state.storyId}`)
          .setLabel(cfg.btnCancel)
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.deferUpdate();
      await state.originalInteraction.editReply({ content: confirmMsg, embeds: [], components: [row] });

    } else if (customId === 'story_manage_reopen') {
      try {
        const { reopenMsg } = await handleReopenStory(connection, interaction, state);
        pendingManageData.set(userId, state);
        await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, null));
        await interaction.followUp({ content: reopenMsg, flags: MessageFlags.Ephemeral });
      } catch (err) {
        await interaction.followUp({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }

    } else if (customId === 'story_manage_toggle_pauseresume') {
      state.targetStatus = state.targetStatus === 1 ? 2 : 1;
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

    } else if (customId === 'story_manage_open_titlesummary') {
      const cfg = state.cfg;
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_manage_titlesummary_modal')
          .setTitle(cfg.btnAddTitleAndSummary)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('story_title')
                .setLabel(cfg.lblStoryTitle)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(500)
                .setValue(state.title || '')
                .setPlaceholder(cfg.txtManageSetTitlePlaceholder ?? '')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('story_summary')
                .setLabel(cfg.lblMetaSummary)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(4000)
                .setValue(state.summary || '')
            ),
          )
      );

    } else if (customId === 'story_manage_open_settings') {
      const cfg = state.cfg;
      const isSlowMode = state.storyMode === 2;
      const turnLengthLabel = isSlowMode ? cfg.txtNA : cfg.lblTurnLength;
      const reminderLabel = isSlowMode ? cfg.lblTimeoutReminderSlow : cfg.lblTimeoutReminder;
      const reminderPlaceholder = isSlowMode ? cfg.txtTimeoutReminderSlowPlaceholder : (cfg.txtTimeoutReminderPlaceholder ?? 'Enter 0–100 (0 = no reminder)');

      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_manage_settings_modal')
          .setTitle(cfg.btnAddSettings)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('turn_length')
                .setLabel(turnLengthLabel)
                .setStyle(TextInputStyle.Short)
                .setRequired(!isSlowMode)
                .setMaxLength(20)
                .setValue(isSlowMode ? '' : formatDuration(state.turnLength))
                .setPlaceholder(cfg.txtTurnLengthPlaceholder ?? 'e.g. 24h, 2d, 1d12h')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('timeout_reminder')
                .setLabel(reminderLabel)
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(10)
                .setValue(state.timeoutReminder > 0 ? String(state.timeoutReminder) : '')
                .setPlaceholder(reminderPlaceholder)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('max_writers')
                .setLabel(cfg.lblMaxWriters)
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(10)
                .setValue(state.maxWriters != null ? String(state.maxWriters) : '')
                .setPlaceholder(cfg.txtManageMaxWritersPlaceholder ?? 'Enter a number, or leave blank for no limit')
            ),
          )
      );

    } else if (customId === 'story_manage_open_metadata') {
      await interaction.showModal(buildMetadataModal(state.cfg, state, 'story_manage'));

    } else if (customId === 'story_manage_open_tags') {
      await interaction.showModal(buildTagsModal(state.cfg, state, 'story_manage'));

    } else if (customId === 'story_manage_turns_open') {
      await interaction.reply(buildTurnActionsPanel(state, state.activeTurn, state.cfg));

    } else if (customId === 'story_manage_entries_open') {
      await handleManageEntriesButton(connection, interaction, state);

    } else if (customId === 'story_manage_review_tags') {
      await handleReviewTags(connection, interaction, state);
      return;

    } else if (customId === 'story_manage_ta_confirm') {
      await handleTurnActionConfirm(connection, interaction);
      return;

    } else if (customId === 'story_manage_ta_confirmcancel') {
      await handleTurnActionCancel(connection, interaction);
      return;

    } else if (customId.startsWith('story_manage_ta_')) {
      await handleTurnActionButton(connection, interaction, state);
      return;

    } else if (customId === 'story_manage_save') {
      await interaction.deferUpdate();
      await handleManageSave(connection, interaction, state);

    } else if (customId === 'story_manage_cancel') {
      await interaction.deferUpdate();
      pendingManageData.delete(userId);
      await state.originalInteraction.editReply({
        content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
        embeds: [],
        components: []
      });
    }
  } catch (error) {
    log(`handleManageButton failed: customId=${customId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleManageSave(connection, interaction, state) {
  const guildId = interaction.guild.id;
  try {
    const warningsStr = Array.isArray(state.warnings) ? state.warnings.join(', ') : (state.warnings || null);
    log(`handleManageSave: storyId=${state.storyId} title=${state.title} mode=${state.storyMode} rating=${state.rating} originalRating=${state.originalRating}`, { show: false, guildName: state.guildName });

    await connection.execute(
      `UPDATE story SET
         title = ?, mode = ?, turn_length_hours = ?, reminder_timing = ?, max_writers = ?,
         allow_joins = ?, show_authors = ?, story_order_type = ?, story_turn_privacy = ?,
         rating = ?, warnings = ?, main_pairing = ?, other_relationships = ?,
         characters = ?, dynamic = ?, tags = ?, summary = ?, scene_break_divider = ?
       WHERE story_id = ?`,
      [
        state.title,
        state.storyMode, state.turnLength, state.timeoutReminder, state.maxWriters ?? null,
        state.allowJoins, state.showAuthors, state.orderType, state.storyTurnPrivacy,
        state.rating, warningsStr || null,
        state.mainPairing || null, state.otherRelationships || null,
        state.characters || null, state.dynamic || null, state.tags || null,
        state.summary || null, state.sceneBreakDivider || null,
        state.storyId
      ]
    );
    log(`handleManageSave: story fields written for storyId=${state.storyId}`, { show: true, guildName: state.guildName });

    if (state.targetStatus !== state.originalStatus) {
      await connection.execute(`UPDATE story SET story_status = ? WHERE story_id = ?`, [state.targetStatus, state.storyId]);

      if (state.targetStatus === 2) {
        await applyPauseActions(connection, interaction, state);
      } else if (state.targetStatus === 1) {
        await applyResumeActions(connection, interaction, state);
      }
    }

    // Skip migration only when moving INTO restricted with no restricted channel configured
    // (policy: story stays in the main feed, rating is informational-only). Moving back OUT
    // of restricted should always proceed normally — that direction can't create a redundant
    // thread since it's returning to the story's existing main-feed thread.
    const skipMigration = isRestricted(state.rating) && !(await isRestrictedChannelConfigured(connection, guildId));
    if (crossesBarrier(state.originalRating, state.rating) && !skipMigration) {
      log(`handleManageSave: rating barrier crossed ${state.originalRating}→${state.rating} for storyId=${state.storyId}`, { show: true, guildName: state.guildName });
      const migResult = await migrateStoryThread(connection, interaction.guild, state.storyId, state.rating, state.originalRating);
      if (!migResult.success) {
        log(`handleManageSave: thread migration failed for storyId=${state.storyId}: ${migResult.error}`, { show: true, guildName: state.guildName });
      } else {
        await updateStoryStatusMessage(connection, interaction.guild, state.storyId);
        const migratedThread = await interaction.guild.channels.fetch(migResult.newThreadId).catch(() => null);
        if (migratedThread) await migratedThread.send({ embeds: [migResult.migratedInEmbed] }).catch(() => {});
      }
    } else {
      if (crossesBarrier(state.originalRating, state.rating)) {
        log(`handleManageSave: rating barrier crossed ${state.originalRating}→${state.rating} for storyId=${state.storyId} but no restricted channel configured — staying in current thread per policy`, { show: false, guildName: state.guildName });
      }
      updateStoryStatusMessage(connection, interaction.guild, state.storyId).catch(() => {});
    }

    pendingManageData.delete(interaction.user.id);

    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtAdminConfigSaved', guildId),
      embeds: [],
      components: []
    });
  } catch (error) {
    log(`handleManageSave failed for storyId=${state.storyId}: ${error?.stack ?? error}`, { show: true, guildName: state.guildName });
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'errProcessingRequest', guildId),
      embeds: [],
      components: []
    });
  }
}

async function handleManageModalSubmit(connection, interaction) {
  log(`handleManageModalSubmit entry customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const userId = interaction.user.id;
  if (interaction.customId.startsWith('story_manage_ta_')) {
    return await handleTurnActionModal(connection, interaction, pendingManageData.get(userId));
  }
  const state = pendingManageData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const customId = interaction.customId;
  try {
    if (customId === 'story_manage_titlesummary_modal') {
      const value = sanitizeModalInput(interaction.fields.getTextInputValue('story_title'), 500);
      if (!value) {
        return await interaction.reply({ content: await getConfigValue(connection, 'txtAddValidationTitleEmpty', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }
      state.title = value;
      state.storyTitle = value;
      state.summary = sanitizeModalInput(interaction.fields.getTextInputValue('story_summary'), 4000, true) || '';

    } else if (customId === 'story_manage_storyinfo_modal') {
      const modeVal = interaction.fields.getRadioGroup('story_manage_storyinfo_mode');
      if (modeVal !== null) state.storyMode = parseInt(modeVal);
      const orderVal = interaction.fields.getRadioGroup('story_manage_storyinfo_order');
      if (orderVal !== null) state.orderType = parseInt(orderVal);
      const showVal = interaction.fields.getRadioGroup('story_manage_storyinfo_showauthors');
      if (showVal !== null) state.showAuthors = parseInt(showVal);
      const privacyVal = interaction.fields.getRadioGroup('story_manage_storyinfo_turnprivacy');
      if (privacyVal !== null) state.storyTurnPrivacy = parseInt(privacyVal);
      state.sceneBreakDivider = sanitizeModalInput(interaction.fields.getTextInputValue('scene_break_divider'), 200) || '';

    } else if (customId === 'story_manage_settings_modal') {
      const cfg = state.cfg;
      const isSlowMode = state.storyMode === 2;

      const rawTurnLength = sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 20);
      if (!isSlowMode && rawTurnLength) {
        const parsedTurnLength = parseDuration(rawTurnLength);
        if (isNaN(parsedTurnLength) || parsedTurnLength < 1) {
          return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationTurnLength', interaction.guild.id), flags: MessageFlags.Ephemeral });
        }
        state.turnLength = parsedTurnLength;
      }

      const rawReminder = sanitizeModalInput(interaction.fields.getTextInputValue('timeout_reminder'), 10);
      if (rawReminder) {
        const val = parseInt(rawReminder);
        if (isSlowMode) {
          if (isNaN(val) || val < 0) {
            return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationSlowReminder', interaction.guild.id), flags: MessageFlags.Ephemeral });
          }
        } else {
          if (isNaN(val) || val < 0 || val > 100) {
            return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationTimeout', interaction.guild.id), flags: MessageFlags.Ephemeral });
          }
        }
        state.timeoutReminder = val;
      }

      const rawMaxWriters = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
      if (rawMaxWriters) {
        const val = parseInt(rawMaxWriters);
        if (isNaN(val) || val < 0) {
          return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationMaxWriters', interaction.guild.id), flags: MessageFlags.Ephemeral });
        }
        state.maxWriters = val > 0 ? val : null;
      } else {
        state.maxWriters = null;
      }

    } else if (customId === 'story_manage_metadata_modal') {
      const dynamic = interaction.fields.getStringSelectValues('story_manage_metadata_dynamic')?.[0];
      const rating = interaction.fields.getStringSelectValues('story_manage_metadata_rating')?.[0];
      const warningsRaw = interaction.fields.getStringSelectValues('story_manage_metadata_warnings') ?? [];

      if (dynamic) state.dynamic = dynamic;
      if (rating) state.rating = rating;
      state.warnings = (warningsRaw ?? []).filter(v => v !== '__dismiss__');
      log(`handleManageModalSubmit: metadata staged dynamic=${state.dynamic} rating=${state.rating} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

    } else if (customId === 'story_manage_tags_modal') {
      state.mainPairing = sanitizeModalInput(interaction.fields.getTextInputValue('main_pairing'), 200) || '';
      state.otherRelationships = sanitizeModalInput(interaction.fields.getTextInputValue('other_relationships'), 1000, true) || '';
      state.characters = sanitizeModalInput(interaction.fields.getTextInputValue('characters'), 500) || '';
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 1000, true) || '';
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.deleteReply();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } catch (error) {
    log(`handleManageModalSubmit failed: customId=${customId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleManageSelectMenu(connection, interaction) {
  log(`handleManageSelectMenu entry user=${interaction.user.username} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const userId = interaction.user.id;
  const state = pendingManageData.get(userId);

  if (!state) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), components: [] });
    return;
  }

  const customId = interaction.customId;

  if (customId === 'story_manage_rating_select') {
    const newRating = interaction.values[0];
    const currentRating = state.rating;
    state.rating = newRating;
    log(`handleManageSelectMenu: rating staged ${currentRating}→${newRating} for user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
  } else if (customId === 'story_manage_warnings_select') {
    state.warnings = interaction.values.filter(v => v !== '__dismiss__');
    log(`handleManageSelectMenu: warnings staged for user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
  } else {
    return;
  }

  await interaction.deferUpdate();
  await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));
}

export {
  pendingManageData,
  buildManageMessage,
  handleManage,
  handleManageButton,
  handleManageSelectMenu,
  handleTagReviewButton,
  handleManageSave,
  applyPauseActions,
  applyResumeActions,
  handleManageModalSubmit,
  handleTurnActionConfirm,
  handleTurnActionCancel,
  handleTurnActionSelectMenu,
  handleTurnActionModal,
};

export default handleManage;
