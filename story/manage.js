import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, LabelBuilder, SeparatorBuilder, ContainerBuilder, TextDisplayBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId, checkIsAdmin, checkIsCreator, parseDuration, formatDuration } from '../utilities.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { migrateStoryThread } from './_migration.js';
import { ratingCodes, ratingLabelKey, warningOptions, dynamicOptions, crossesBarrier, isRestricted, isRestrictedChannelConfigured } from './_metadata.js';
import { getMetaCfg, buildStoryPanel, buildMetadataModal, buildTagsModal, buildStoryInfoModal } from './_metadataModals.js';
import { buildTurnActionsPanel, handleTurnActionButton, handleTurnActionConfirm, handleTurnActionCancel, handleTurnActionSelectMenu, handleTurnActionModal } from './_manageTurnActions.js';
import { handleManageEntriesButton, handleManageEntriesSelectMenu } from './_manageEntries.js';
import { buildTagReviewPanel, handleReviewTags, handleTagReviewButton } from './tags.js';
import { applyPauseActions, applyResumeActions, handleReopenStory } from './_managePauseResume.js';
import { openManageUserPanel } from './_manageUser.js';
import { STORY_STATUS, TURN_STATUS, STORY_MODE, WRITER_STATUS } from '../constants.js';

const pendingManageData = new Map();

// Terminal/interstitial-state messages (save success/error, cancel, close-confirm) — kept as
// Components V2 rather than plain `content`, since the panel that precedes them already uses
// IsComponentsV2 and whether that flag can be removed on a later edit is unconfirmed against
// Discord's docs. A one-block Container sidesteps the question entirely.
function finalMessage(text, extraComponents = []) {
  return {
    components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text)), ...extraComponents],
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildManageMessage(cfg, state, activeTurn = null) {
  const isPaused = state.targetStatus === STORY_STATUS.PAUSED;
  const isClosed = state.targetStatus === STORY_STATUS.CLOSED;

  const container = buildStoryPanel(cfg, state, cfg.txtManageEmbedTitle, {
    isManage: true,
    activeGroup: state.activeGroup ?? 'settings',
    namespace: 'story_manage',
    titleMetadata: cfg.txtManageEmbedTitleMetadata,
  });

  // Story-action area — Settings tab only. These used to sit on both tabs on the theory that
  // none of them edit a currently-shown field cluster, but Manage Entries/Turns/Users don't
  // relate to Metadata content at all, so there's no reason to pay their component cost (or
  // clutter the view) while metadata-editing — one click back to Settings gets them. Review
  // Tags moved the other way, into buildStoryPanel's Metadata branch, since it feeds the Tags
  // field shown there. Labeled per the entry-point audit finding that Manage Turns
  // (Skip/Extend/Reassign) had zero inline explanation anywhere.
  //
  // COMPONENT BUDGET: worst case (Settings tab, isAdminOrCreator = true, all fields populated)
  // recurses to 37 components counting every nested node (Container, each TextDisplay, each
  // ActionRow, and each Button inside it) — under Discord's documented 40-per-message ceiling
  // (docs.discord.com/developers/components/reference), with the Metadata tab well under that
  // at 25. @discordjs/builders does not validate this client-side, and it's unconfirmed whether
  // Discord's server-side enforcement counts nested children individually (as above) or only
  // top-level container children — so treat 37 as the number to watch if more fields are added
  // later, not as headroom already spent. If it ever needs trimming, the first cut is the
  // Separator on the line directly below this comment — the one purely decorative node in the
  // tree, removing 1 from the count without touching any label or button.
  if ((state.activeGroup ?? 'settings') === 'settings') {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtStoryManagementLabel));

    // One button per row, each followed by its own -# subtext caption — these hide multiple
    // sub-actions behind a single label (e.g. Manage Turns opens Skip/Extend/Reassign), so
    // knowing what's inside before clicking matters, the same reasoning as the inline mode
    // descriptions already used for Story Mode/Writer Order. Closes the entry-point audit's
    // Manage Turns finding directly, without waiting on the help redesign's contextual-popup
    // mechanism.
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('story_manage_entries_open').setLabel(cfg.btnManageEntries).setStyle(ButtonStyle.Primary)
    ));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtManageEntriesDesc));

    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('story_manage_turns_open').setLabel(cfg.btnManageTurns).setStyle(ButtonStyle.Primary)
    ));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtManageTurnsDesc));

    // Gated to creator-or-admin, matching /story manage's own access level — not admin-only like
    // the standalone /storyadmin user command. Deliberately broader here: managing writers in
    // your own story is a natural extension of the creator controls already on this panel.
    if (state.isAdminOrCreator) {
      container.addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('story_manage_users_open').setLabel(cfg.btnManageUsers).setStyle(ButtonStyle.Primary)
      ));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtManageUsersDesc));
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtChangeStoryStatusLabel));

  const pauseResumeLabel = cfg.txtStory + ' ' + (isPaused ? cfg.txtResume : cfg.txtPause);
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
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
  ));

  // TODO.md top-priority item: /story manage uses the identical stage-then-save pattern as
  // /storyadmin setup, which needed this exact warning (txtSetupModalSaveWarning) after a real
  // incident where an admin never clicked Save and got silently blocked. Reused verbatim here
  // (new key, same approved text) since this panel's save button is also called "Save Settings".
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtManageSaveWarning));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_save')
      .setLabel(cfg.btnSaveSettings)
      .setStyle(ButtonStyle.Success),
  ));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
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
      'btnManageUsers', 'txtManageUsersPickModalTitle', 'lblManageUsersPickSelect', 'txtManageUsersNoWriters',
      'txtManageEntriesDesc', 'txtManageTurnsDesc', 'txtReviewTagsDesc', 'txtManageUsersDesc', 'txtChangeStoryStatusLabel',
      'txtManageEmbedTitleMetadata',
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
       WHERE sw.story_id = ? AND t.turn_status = ?`,
      [storyId, TURN_STATUS.ACTIVE]
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
      storyMode: story.mode ?? STORY_MODE.NORMAL,
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
      activeGroup: 'settings',
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
    if (customId === 'story_manage_tab_settings' || customId === 'story_manage_tab_metadata') {
      state.activeGroup = customId === 'story_manage_tab_settings' ? 'settings' : 'metadata';
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

    } else if (customId === 'story_manage_open_storyinfo') {
      await interaction.showModal(buildStoryInfoModal(state.cfg, state, 'story_manage'));

    } else if (customId === 'story_manage_toggle_latejoins') {
      state.allowJoins = state.allowJoins ? 0 : 1;
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

    } else if (customId === 'story_manage_close_open') {
      // Reuses the standalone /story close confirm/cancel flow — story_close_confirm_<id> and
      // story_close_cancel_<id> are routed centrally in commands/story.js to handleCloseConfirm/handleCloseCancel.
      // Deliberately NOT converted to Components V2: those shared handlers (story/close.js) also
      // serve the standalone /story close command and reply with plain content/components — this
      // edit transitions FROM the (Components V2) manage panel TO that plain shape, and whether
      // Discord allows removing the IsComponentsV2 flag on an edit is unverified (undocumented,
      // no staging to test). Left exactly as it worked before this rework. If it breaks live,
      // the fix is converting close.js's shared handlers too — a separate, bigger change since
      // it's shared with a command outside this plan's scope.
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
      state.targetStatus = state.targetStatus === STORY_STATUS.ACTIVE ? STORY_STATUS.PAUSED : STORY_STATUS.ACTIVE;
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
                .setMaxLength(1024) // matches the embed field value limit this gets rendered into
                .setValue(state.summary || '')
            ),
          )
      );

    } else if (customId === 'story_manage_open_settings') {
      const cfg = state.cfg;
      const isSlowMode = state.storyMode === STORY_MODE.SLOW;
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

    } else if (customId === 'story_manage_users_open') {
      // Re-check server-side — the button is hidden for anyone who isn't creator-or-admin, but
      // hiding a button client-side is not an authorization boundary on its own. In practice this
      // is unreachable (handleManage's own entry gate already requires creator-or-admin), but
      // checked explicitly rather than assumed.
      if (!state.isAdminOrCreator) {
        await interaction.reply({ content: cfg.txtManageNotAuthorized, flags: MessageFlags.Ephemeral });
        return;
      }
      const [writerRows] = await connection.execute(
        `SELECT discord_user_id, discord_display_name, sw_status FROM story_writer
         WHERE story_id = ? AND sw_status IN (?, ?) ORDER BY discord_display_name`,
        [state.storyId, WRITER_STATUS.ACTIVE, WRITER_STATUS.PAUSED]
      );
      if (writerRows.length === 0) {
        await interaction.reply({ content: cfg.txtManageUsersNoWriters, flags: MessageFlags.Ephemeral });
        return;
      }
      // Discord select menus cap at 25 options — realistic round-robin story sizes are well
      // under that, but truncate defensively rather than error if one somehow isn't.
      const pickable = writerRows.slice(0, 25);
      if (writerRows.length > 25) {
        log(`handleManageButton: story ${state.storyId} has ${writerRows.length} writers, truncating picker to 25`, { show: true, guildName: interaction?.guild?.name });
      }
      const pickerSelect = new StringSelectMenuBuilder()
        .setCustomId('writer')
        .setRequired(true)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(pickable.map(w => ({
          label: w.discord_display_name || w.discord_user_id,
          value: w.discord_user_id,
          description: w.sw_status === WRITER_STATUS.PAUSED ? cfg.txtMyStoryManagePausedStatus : cfg.txtMyStoryManageActiveStatus,
        })));
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_manage_users_pick_modal')
          .setTitle(cfg.txtManageUsersPickModalTitle)
          .addLabelComponents(
            new LabelBuilder().setLabel(cfg.lblManageUsersPickSelect).setStringSelectMenuComponent(pickerSelect)
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

      if (state.targetStatus === STORY_STATUS.PAUSED) {
        await applyPauseActions(connection, interaction, state);
      } else if (state.targetStatus === STORY_STATUS.ACTIVE) {
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

    await state.originalInteraction.editReply(finalMessage(await getConfigValue(connection, 'txtAdminConfigSaved', guildId)));
  } catch (error) {
    log(`handleManageSave failed for storyId=${state.storyId}: ${error?.stack ?? error}`, { show: true, guildName: state.guildName });
    await state.originalInteraction.editReply(finalMessage(await getConfigValue(connection, 'errProcessingRequest', guildId)));
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
      // Capped at 1024, not the modal's usual generous limits: the embed renders this in a field, and Discord field values max out at 1024 chars.
      state.summary = sanitizeModalInput(interaction.fields.getTextInputValue('story_summary'), 1024, true) || '';

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
      const isSlowMode = state.storyMode === STORY_MODE.SLOW;

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
      const warningsRaw = interaction.fields.getCheckboxGroup('story_manage_metadata_warnings') ?? [];

      if (dynamic) state.dynamic = dynamic;
      if (rating) state.rating = rating;
      state.warnings = warningsRaw ?? [];
      log(`handleManageModalSubmit: metadata staged dynamic=${state.dynamic} rating=${state.rating} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

    } else if (customId === 'story_manage_tags_modal') {
      state.mainPairing = sanitizeModalInput(interaction.fields.getTextInputValue('main_pairing'), 200) || '';
      state.otherRelationships = sanitizeModalInput(interaction.fields.getTextInputValue('other_relationships'), 1000, true) || '';
      state.characters = sanitizeModalInput(interaction.fields.getTextInputValue('characters'), 500) || '';
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 1000, true) || '';

    } else if (customId === 'story_manage_users_pick_modal') {
      // Opens a new, separate ephemeral panel (the existing Manage User panel) rather than
      // re-rendering the story-manage panel — early return, skips the shared re-render tail below.
      if (!state.isAdminOrCreator) {
        return await interaction.reply({ content: state.cfg.txtManageNotAuthorized, flags: MessageFlags.Ephemeral });
      }
      const targetUserId = interaction.fields.getStringSelectValues('writer')?.[0];
      if (!targetUserId) {
        return await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await openManageUserPanel(connection, interaction, state.storyId, targetUserId, interaction.guild.id);
      return;
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

export {
  pendingManageData,
  buildManageMessage,
  handleManage,
  handleManageButton,
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
