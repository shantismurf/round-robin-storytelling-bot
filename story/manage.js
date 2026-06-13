import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId, getTurnNumber, checkIsAdmin, checkIsCreator } from '../utilities.js';
import { PickNextWriter, NextTurn } from './_turn.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { migrateStoryThread } from './_migration.js';
import { ratingLabels, warningOptions, dynamicOptions, crossesBarrier, isRestricted } from './_metadata.js';
import { buildTurnActionsPanel, handleTurnActionButton, handleTurnActionConfirm, handleTurnActionCancel, handleTurnActionSelectMenu, handleTurnActionModal } from './_manageTurnActions.js';
import { handleManageEntriesButton, handleManageEntriesSelectMenu } from './_manageEntries.js';
import { buildTagReviewPanel, handleReviewTags, handleTagReviewButton } from './tags.js';
import { applyPauseActions, applyResumeActions, handleReopenStory } from './_managePauseResume.js';

const pendingManageData = new Map();

function buildManageMessage(cfg, state, activeTurn = null) {
  const orderEmojis = { 1: '\u{1F3B2}', 2: '\u{1F504}', 3: '\u{1F4CB}' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const isPaused = state.targetStatus === 2;
  const isSlowMode = state.storyMode === 2;

  const ratingLabel = cfg[ratingLabels[state.rating ?? 'NR']] ?? state.rating;
  const warningsDisplay = state.warnings?.length
    ? (Array.isArray(state.warnings) ? state.warnings : state.warnings.split(',').map(w => w.trim())).join(', ')
    : cfg.txtNone;

  const sectionLine = cfg.txtSectionBreakLine;
  const statusDisplay = isPaused
    ? (cfg.txtManageStoryStatusPaused ?? `⏸️ ${cfg.txtPaused}`)
    : (cfg.txtManageStoryStatusActive ?? `▶️ ${cfg.Active}`);
  const joinDisplay = state.allowJoins
    ? (cfg.txtManageJoinOpen ?? `\u{1F513} ${cfg.txtOpen}`)
    : (cfg.txtManageJoinClosed ?? `\u{1F512} ${cfg.txtClosed}`);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtManageEmbedTitle)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblManageStoryTitle, value: state.title, inline: false },
      { name: cfg.lblManageStoryStatus, value: statusDisplay, inline: true },
      { name: cfg.lblManageJoinStatus, value: joinDisplay, inline: true },
      { name: cfg.lblWriterOrder, value: `${orderEmoji} ${orderLabel}`, inline: true },
      { name: cfg.lblMaxWriters, value: state.maxWriters ? String(state.maxWriters) : cfg.txtInfinity, inline: true },
      { name: cfg.lblTurnLength, value: isSlowMode ? cfg.txtNA : `${state.turnLength} hours`, inline: true },
      { name: isSlowMode ? cfg.lblTimeoutReminderSlow : cfg.lblTimeoutReminder, value: state.timeoutReminder > 0 ? (isSlowMode ? `${state.timeoutReminder}h` : `${state.timeoutReminder}%`) : cfg.txtOff, inline: true },
      { name: cfg.lblPrivateToggle, value: state.turnPrivacy ? cfg.txtPrivate : cfg.txtPublic, inline: true },
      { name: cfg.lblShowAuthors, value: state.showAuthors ? cfg.txtYes : cfg.txtNo, inline: true },
      { name: sectionLine, value: cfg.txtManageSectionBreakMeta, inline: false },
      { name: cfg.lblRating, value: ratingLabel, inline: true },
      { name: cfg.lblDynamic, value: state.dynamic ? (cfg[state.dynamic] ?? state.dynamic) : cfg.txtNotSet, inline: true },
      { name: cfg.lblWarnings, value: warningsDisplay, inline: false },
      { name: cfg.lblTags, value: state.tags || cfg.txtNotSet, inline: false },
    );

  const modeLabelManage = { 0: cfg.txtNormalUC, 1: cfg.txtQuickUC, 2: cfg.txtSlowTC }[state.storyMode] ?? cfg.txtNormalUC;
  // Row 1 (4): Set Title | Mode: <> | Writer Order: <> | Join Status: <>
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_set_title')
      .setLabel(cfg.txtManageSetTitleModalTitle)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_cycle_mode')
      .setLabel(`${cfg.lblModeToggle}: ${modeLabelManage}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_cycle_order')
      .setLabel(`${cfg.lblWriterOrder}: ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_latejoins')
      .setLabel(`Join: ${state.allowJoins ? cfg.txtOpen : cfg.txtClosed}`)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 2 (3): Max Writers: <> | Turn Length: <> | Reminder: <> |
  const reminderBtnLabel = isSlowMode
    ? replaceTemplateVariables(cfg.btnSetTimeout, { reminder_interval: state.timeoutReminder > 0 ? `${state.timeoutReminder}h` : cfg.txtNone })
    : replaceTemplateVariables(cfg.btnSetTimeout, { reminder_interval: state.timeoutReminder > 0 ? `${state.timeoutReminder}%` : cfg.txtNone });
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_set_maxwriters')
      .setLabel(replaceTemplateVariables(cfg.btnSetMaxWriters, { max_writers: state.maxWriters ?? cfg.txtInfinity }))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_turnlength')
      .setLabel(isSlowMode ? cfg.txtNA : replaceTemplateVariables(cfg.btnSetTurnLength, { turn_length: `${state.turnLength} ${cfg.txtHrs}` }))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSlowMode),
    new ButtonBuilder()
      .setCustomId('story_manage_set_reminder')
      .setLabel(reminderBtnLabel)
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 3 (3): Show Names: <> | Hide Threads: <> | Pause/Resume or Reopen
  const isClosed = state.targetStatus === 3;
  const pauseResumeLabel = cfg.txtStory + ' ' + (isPaused ? cfg.txtResume : cfg.txtPause);
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? cfg.txtYes : cfg.txtNo}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_privacy')
      .setLabel(`${cfg.lblPrivateToggle}: ${state.turnPrivacy ? cfg.txtPrivate : cfg.txtPublic}`)
      .setStyle(ButtonStyle.Secondary),
    isClosed
      ? new ButtonBuilder()
          .setCustomId('story_manage_reopen')
          .setLabel(cfg.txtReopenStory)
          .setStyle(ButtonStyle.Success)
      : new ButtonBuilder()
          .setCustomId('story_manage_toggle_pauseresume')
          .setLabel(pauseResumeLabel)
          .setStyle(ButtonStyle.Secondary)
    );

  // Row 4 (3-4): Metadata | Manage Entries | Manage Turns | [Review Tags if pending]
  const row4Components = [
    new ButtonBuilder()
      .setCustomId('story_manage_open_metadata')
      .setLabel(cfg.btnSetMetadata)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_entries_open')
      .setLabel(cfg.btnManageEntries)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_turns_open')
      .setLabel(cfg.btnManageTurns)
      .setStyle(ButtonStyle.Secondary)
    ];
  if (state.pendingTagCount > 0) {
    row4Components.push(
      new ButtonBuilder()
        .setCustomId('story_manage_review_tags')
        .setLabel(replaceTemplateVariables(cfg.btnReviewTags, { count: state.pendingTagCount }))
        .setStyle(ButtonStyle.Primary)
    );
  }
  const row4 = new ActionRowBuilder().addComponents(...row4Components);

  // Row 5 (1): Save Settings
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_save')
      .setLabel(cfg.btnSaveSettings)
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

async function handleManage(connection, interaction, alreadyDeferred = false) {
  log(`handleManage: entry user=${interaction.user.username} alreadyDeferred=${alreadyDeferred}`, { show: false, guildName: interaction?.guild?.name });
  if (!alreadyDeferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
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

    const cfg = await getConfigValue(connection, [
      'txtYes','txtNo','txtOn','txtOff','txtNone','txtPublic','txtPrivate','txtInfinity','txtNA',
      'txtHoursLC','txtHoursUC','txtWritersLC','txtWritersUC',
      'txtQuickLC','txtQuickUC','txtNormalLC','txtNormalUC','txtSlowTC',
      'txtOpen','txtClosed','txtActive','txtPaused','txtHrs',
      'txtStory','txtPause','txtResume','txtRatingNR','txtNotSet',
      'txtManageEmbedTitle', 'btnAdminConfigSave', 'btnSaveSettings', 'btnCancel',
      'lblTurnLength', 'btnSetTurnLength',
      'lblTimeoutReminder', 'lblTimeoutReminderSlow', 'btnSetTimeout',
      'txtTimeoutReminderSlowPlaceholder', 'txtManageValidationSlowReminder',
      'lblMaxWriters', 'btnSetMaxWriters',
      'lblOpenToWriters', 'lblShowAuthors',
      'lblModeToggle',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'lblTags', 'btnSetTags',
      'lblPrivateToggle',
      'lblRating', 'lblWarnings', 'lblDynamic',
      'btnSetMetadata', 'btnReviewTags',
      'txtSelectionStaged',
      'txtSectionBreakLine', 'txtManageSectionBreakMeta',
      'lblManageStoryTitle', 'lblManageStoryStatus', 'lblManageJoinStatus',
      'txtManageStoryStatusActive', 'txtManageStoryStatusPaused',
      'txtManageJoinOpen', 'txtManageJoinClosed',
      'txtManageSetTitleModalTitle', 'lblManageSetTitleField', 'txtManageSetTitlePlaceholder',
      'txtTurnLengthPlaceholder', 'txtTimeoutReminderPlaceholder',
      'txtManageMaxWritersPlaceholder', 'txtManageTagsPlaceholder',
      'btnManageTurns', 'btnManageEntries',
      'txtTagPendingTitle', 'txtTagNoPending', 'btnTagApprove', 'btnTagReject', 'txtTagVoteCount',
      'txtManageTurnsPanelTitle', 'txtManageTurnsNoTurn', 'txtManageTurnsActiveTurn',
      'btnTurnSkip', 'btnTurnExtend', 'btnTurnNext', 'btnTurnReassign',
      'btnTurnDeleteEntry', 'btnTurnRestoreEntry', 'txtTurnSkipConfirm',
      'txtTurnReassignConfirm', 'txtTurnExtendModalTitle', 'lblTurnExtendHours',
      'txtTurnExtendPlaceholder', 'txtTurnDeleteEntryModalTitle', 'lblTurnDeleteEntryTurn',
      'txtTurnDeleteEntryPlaceholder', 'txtTurnRestoreEntryModalTitle', 'lblTurnRestoreEntryId',
      'txtTurnRestoreEntryPlaceholder', 'txtTurnNextSelectWrite',
      ...Object.values(ratingLabels),
      ...dynamicOptions,
      ...warningOptions,
      'txtManageWarningSelectInstructions',
      'txtReopenStory'
    ], guildId);
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
      storyMode: story.mode ?? 0,
      turnLength: story.turn_length_hours,
      timeoutReminder: story.reminder_timing ?? 50,
      maxWriters: story.max_writers,
      allowJoins: story.allow_joins,
      showAuthors: story.show_authors,
      orderType: story.story_order_type,
      turnPrivacy: story.story_turn_privacy,
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
      activeTurn
    };

    pendingManageData.set(interaction.user.id, state);
    log(`handleManage: sending panel`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageMessage(cfg, state, activeTurn));

  } catch (error) {
    log(`Error in handleManage: ${error}`, { show: true, guildName: interaction?.guild?.name });
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

  if (customId === 'story_manage_toggle_latejoins') {
    state.allowJoins = state.allowJoins ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_toggle_authors') {
    state.showAuthors = state.showAuthors ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_toggle_privacy') {
    state.turnPrivacy = state.turnPrivacy ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_cycle_mode') {
    state.storyMode = state.storyMode === 2 ? 0 : state.storyMode + 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_cycle_order') {
    state.orderType = state.orderType === 3 ? 1 : state.orderType + 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_reopen') {
    try {
      const { reopenMsg } = await handleReopenStory(connection, interaction, state);
      pendingManageData.set(interaction.user.id, state);
      await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, null));
      await interaction.followUp({ content: reopenMsg, flags: MessageFlags.Ephemeral });
    } catch (err) {
      await interaction.followUp({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }

  } else if (customId === 'story_manage_toggle_pauseresume') {
    state.targetStatus = state.targetStatus === 1 ? 2 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_set_title') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_title_modal')
        .setTitle(state.cfg.txtManageSetTitleModalTitle)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('story_title')
            .setLabel(state.cfg.lblManageSetTitleField)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(500)
            .setValue(state.title || '')
            .setPlaceholder(state.cfg.txtManageSetTitlePlaceholder)
        ))
    );

  } else if (customId === 'story_manage_turns_open') {
    await interaction.reply(buildTurnActionsPanel(state, state.activeTurn, state.cfg));

  } else if (customId === 'story_manage_entries_open') {
    await handleManageEntriesButton(connection, interaction, state);

  } else if (customId === 'story_manage_open_metadata') {
    const { buildMetadataPanel, getMetaCfg, registerMetaSession } = await import('./_addMetadata.js');
    const cfg2 = await getMetaCfg(connection, interaction.guild.id);
    log(`handleManageButton: registering meta session storyId=${state.storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
    registerMetaSession(interaction.user.id, { ...state }, interaction.guild.id, async (saveInteraction, metaFields, cfg) => {
      log(`manage onSave: entered for user=${saveInteraction.user.username} storyId=${state.storyId}`, { show: false, guildName: state.guildName });
      log(`manage onSave: metaFields=${JSON.stringify(metaFields)}`, { show: false, guildName: state.guildName });
      const warningsStr = Array.isArray(metaFields.warnings) ? metaFields.warnings.join(', ') : (metaFields.warnings || null);
      try {
        await connection.execute(
          `UPDATE story SET rating = ?, warnings = ?, main_pairing = ?,
           other_relationships = ?, characters = ?, dynamic = ?, tags = ?, summary = ?, scene_break_divider = ?
           WHERE story_id = ?`,
          [
            metaFields.rating, warningsStr || null,
            metaFields.mainPairing || null,
            metaFields.otherRelationships || null, metaFields.characters || null,
            metaFields.dynamic || null, metaFields.tags || null,
            metaFields.summary || null,
            metaFields.sceneBreakDivider || null,
            state.storyId
          ]
        );
        log(`manage onSave: metadata written to DB for storyId=${state.storyId}`, { show: true, guildName: state.guildName });

        if (metaFields.oldRating && crossesBarrier(metaFields.oldRating, metaFields.rating)) {
          const migResult = await migrateStoryThread(connection, saveInteraction.guild, state.storyId, metaFields.rating, metaFields.oldRating);
          if (!migResult.success) {
            log(`manage onSave: thread migration failed for storyId=${state.storyId}: ${migResult.error}`, { show: true, guildName: state.guildName });
          } else {
            await updateStoryStatusMessage(connection, saveInteraction.guild, state.storyId);
            const migratedThread = await saveInteraction.guild.channels.fetch(migResult.newThreadId).catch(() => null);
            if (migratedThread) await migratedThread.send({ embeds: [migResult.migratedInEmbed] }).catch(() => {});
          }
        } else {
          updateStoryStatusMessage(connection, saveInteraction.guild, state.storyId).catch(() => {});
        }

        Object.assign(state, metaFields);
        state.originalRating = metaFields.rating;

        await saveInteraction.update({ content: cfg.txtMetaSaveSuccess, embeds: [], components: [] });
        await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));
        log(`manage onSave: complete for storyId=${state.storyId}`, { show: false, guildName: state.guildName });
      } catch (error) {
        log(`manage onSave: failed for storyId=${state.storyId}: ${error?.stack ?? error}`, { show: true, guildName: state.guildName });
        await saveInteraction.update({ content: await getConfigValue(connection, 'errProcessingRequest', saveInteraction.guild.id), embeds: [], components: [] }).catch(() => {});
      }
    }, interaction);
    await interaction.reply({ ...buildMetadataPanel(cfg2, state), flags: MessageFlags.Ephemeral });

  } else if (customId === 'story_manage_set_turnlength') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_turnlength_modal')
        .setTitle(state.cfg.lblTurnLength)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('turn_length')
              .setLabel(state.cfg.lblTurnLength)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.turnLength))
              .setPlaceholder(state.cfg.txtTurnLengthPlaceholder)
          )
        )
    );

  } else if (customId === 'story_manage_set_reminder') {
    const isSlowMode = state.storyMode === 2;
    const reminderLabel = isSlowMode ? state.cfg.lblTimeoutReminderSlow : state.cfg.lblTimeoutReminder;
    const reminderPlaceholder = isSlowMode ? state.cfg.txtTimeoutReminderSlowPlaceholder : state.cfg.txtTimeoutReminderPlaceholder;
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_reminder_modal')
        .setTitle(reminderLabel)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('timeout_reminder')
              .setLabel(reminderLabel)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.timeoutReminder))
              .setPlaceholder(reminderPlaceholder)
          )
        )
    );

  } else if (customId === 'story_manage_set_maxwriters') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_maxwriters_modal')
        .setTitle(state.cfg.lblMaxWriters)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_writers')
              .setLabel(state.cfg.lblMaxWriters)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.maxWriters != null ? String(state.maxWriters) : '')
              .setPlaceholder(state.cfg.txtManageMaxWritersPlaceholder)
          )
        )
    );

  } else if (customId === 'story_manage_set_tags') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_tags_modal')
        .setTitle(state.cfg.lblTags)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('tags')
              .setLabel(state.cfg.lblTags)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.tags)
              .setPlaceholder(state.cfg.txtManageTagsPlaceholder)
          )
        )
    );

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
}

async function handleManageSave(connection, interaction, state) {
  const guildId = interaction.guild.id;
  try {
    log(`handleManageSave: storyId=${state.storyId} title=${state.title} mode=${state.storyMode} turnLength=${state.turnLength} reminder=${state.timeoutReminder}`, { show: false, guildName: state.guildName });
    await connection.execute(
      `UPDATE story SET title = ?, mode = ?, turn_length_hours = ?, reminder_timing = ?, max_writers = ?,
       allow_joins = ?, show_authors = ?, story_order_type = ?, story_turn_privacy = ?, tags = ?
       WHERE story_id = ?`,
      [
        state.title,
        state.storyMode, state.turnLength, state.timeoutReminder, state.maxWriters ?? null,
        state.allowJoins, state.showAuthors, state.orderType,
        state.turnPrivacy, state.tags || null,
        state.storyId
      ]
    );

    if (state.targetStatus !== state.originalStatus) {
      await connection.execute(`UPDATE story SET story_status = ? WHERE story_id = ?`, [state.targetStatus, state.storyId]);

      if (state.targetStatus === 2) {
        await applyPauseActions(connection, interaction, state);
      } else if (state.targetStatus === 1) {
        await applyResumeActions(connection, interaction, state);
      }
    }

    pendingManageData.delete(interaction.user.id);
    updateStoryStatusMessage(connection, interaction.guild, state.storyId).catch(() => {});

    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtAdminConfigSaved', guildId),
      embeds: [],
      components: []
    });
  } catch (error) {
    log(`Error saving manage settings: ${error}`, { show: true, guildName: interaction?.guild?.name });
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

  try {
    if (interaction.customId === 'story_manage_title_modal') {
      const value = sanitizeModalInput(interaction.fields.getTextInputValue('story_title'), 500);
      if (!value) {
        return await interaction.reply({ content: await getConfigValue(connection, 'txtAddValidationTitleEmpty', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }
      state.title = value;

    } else if (interaction.customId === 'story_manage_turnlength_modal') {
      const val = parseInt(sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 10));
      if (isNaN(val) || val < 1) {
        return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationTurnLength', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }
      state.turnLength = val;

    } else if (interaction.customId === 'story_manage_reminder_modal') {
      const val = parseInt(sanitizeModalInput(interaction.fields.getTextInputValue('timeout_reminder'), 10));
      const isSlowMode = state.storyMode === 2;
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

    } else if (interaction.customId === 'story_manage_maxwriters_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationMaxWriters', interaction.guild.id), flags: MessageFlags.Ephemeral });
        }
        state.maxWriters = val > 0 ? val : null;
      } else {
        state.maxWriters = null;
      }

    } else if (interaction.customId === 'story_manage_tags_modal') {
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 500) ?? '';
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stagedMsg = state.cfg.txtSelectionStaged;
    await interaction.editReply({ content: stagedMsg });
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));
    await interaction.deleteReply();

  } catch (error) {
    log(`Error in handleManageModalSubmit: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
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
  // Re-export turn action handlers for routing in story.js / storyadmin.js
  handleTurnActionConfirm,
  handleTurnActionCancel,
  handleTurnActionSelectMenu,
  handleTurnActionModal,
};

export default handleManage;
