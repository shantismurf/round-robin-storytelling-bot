import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, LabelBuilder, SeparatorBuilder, ContainerBuilder, TextDisplayBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId, checkIsAdmin, checkIsCreator, parseDuration, formatDuration } from '../utilities.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { ratingCodes, ratingLabelKey, warningOptions, dynamicOptions, crossesBarrier, isRestricted } from './_metadata.js';
import { parseGroundRulesText, effectiveGroundRulesText } from './_groundRules.js';
import { getMetaCfg, buildStoryPanel, buildMetadataModal, buildTagsModal, buildStoryInfoModal, finalMessage } from './_metadataModals.js';
import { buildTurnActionsPanel, handleTurnActionButton, handleTurnActionConfirm, handleTurnActionCancel, handleTurnActionSelectMenu, handleTurnActionModal } from './_manageTurnActions.js';
import { handleManageEntriesButton, handleManageEntriesSelectMenu } from './_manageEntries.js';
import { buildTagReviewPanel, handleReviewTags, handleTagReviewButton } from './tags.js';
import { handleTogglePauseResume, handleReopenStory } from './_managePauseResume.js';
import { openManageUserPanel } from './_manageUser.js';
import { handleManageCloseConfirm } from './_manageClose.js';
import { handleManageSave } from './_manageSave.js';
import { STORY_STATUS, TURN_STATUS, STORY_MODE, WRITER_STATUS } from '../constants.js';

const pendingManageData = new Map();

// Part 1c (docs/plans/PLAN-panel-rework-and-ground-rules.md) — dirty-state detection for the
// unsaved-changes warning below. Every field a manage-panel modal or toggle button stages before
// Save Settings is listed here; handleManage() snapshots them into state.originalFields at panel
// open (when current === original for all of them by construction), and buildManageMessage()
// diffs current state against that snapshot on every render. Deliberately a flat list diffed
// generically rather than a matching originalX field per entry (the originalRating pattern this
// plan's design note started from) — one list to keep in sync with the staging call sites below,
// instead of two.
//
// targetStatus (Pause/Resume) and allowJoins (Close/Open Joins) are deliberately NOT here: unlike
// every other field on this list, both apply immediately when toggled (see
// story_manage_toggle_pauseresume/story_manage_toggle_latejoins below), same as Close and Reopen
// — not staged behind Save Settings. All four buttons share one row under "Change Story Status",
// so they read to the user as one set of do-it-now controls, not a batch of edits to preview and
// commit together. targetStatus was tracked here originally, which produced a real bug (a false
// "unsaved changes" warning right after Reopen, since Reopen's immediate DB write desynced from
// this snapshot) — removed 2026-08-22 by making Pause/Resume immediate too, instead of patching
// the tracking; allowJoins was made immediate for the same reason before it could develop the same
// bug (2026-08-26). See docs/plans/PLAN-panel-rework-and-ground-rules.md's Part 1c note.
const STAGED_FIELDS = [
  'title', 'summary', 'storyMode', 'orderType', 'showAuthors', 'storyTurnPrivacy',
  'sceneBreakDivider', 'turnLength', 'timeoutReminder', 'maxWriters',
  'dynamic', 'rating', 'warnings', 'mainPairing', 'otherRelationships', 'characters', 'tags',
  'groundRules',
];

function isManageDirty(state) {
  if (!state.originalFields) return false;
  return STAGED_FIELDS.some((key) => {
    const current = state[key];
    const original = state.originalFields[key];
    // Arrays (warnings) are always reassigned wholesale, never mutated in place, so a reference
    // snapshot is safe — but the checkbox group can return the same set in a different order
    // than the DB-loaded original, which isn't a real edit. Sort before comparing.
    if (Array.isArray(current) || Array.isArray(original)) {
      return JSON.stringify([...(current ?? [])].sort()) !== JSON.stringify([...(original ?? [])].sort());
    }
    return current !== original;
  });
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

  // Part 1c: originally a static always-on warning here (same pattern/incident as
  // /storyadmin setup's txtSetupModalSaveWarning — an admin who never clicked Save got silently
  // blocked). Replaced with a real dirty-state check: only nag when there's actually something
  // unsaved, since /storyadmin setup's blanket warning already covers the "this panel stages,
  // remember to save" education and doesn't need repeating on every single render here too.
  if (isManageDirty(state)) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${cfg.lblUnsavedChangesTitle}**\n${replaceTemplateVariables(cfg.txtUnsavedChangesBody, { save_label: cfg.btnSaveSettings })}`
    ));
  }
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
              rating, warnings, main_pairing, other_relationships, characters, dynamic, ground_rules,
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
      'txtGroundRulesChangedNotice', 'txtGroundRulesChangedNoticeNone',
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

    const [groundRulesText, teenOrLowerOnly] = await Promise.all([
      getConfigValue(connection, 'cfgGroundRules', guildId),
      getConfigValue(connection, 'cfgTeenOrLowerOnly', guildId),
    ]);

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
      targetStatus: story.story_status,
      originalInteraction: interaction,
      rating: story.rating ?? 'NR',
      originalRating: story.rating ?? 'NR',
      warnings: story.warnings ? story.warnings.split(',').map(w => w.trim()).filter(Boolean) : [],
      mainPairing: story.main_pairing ?? '',
      otherRelationships: story.other_relationships ?? '',
      characters: story.characters ?? '',
      dynamic: story.dynamic ?? '',
      groundRules: story.ground_rules ? story.ground_rules.split(',').map(s => s.trim()).filter(Boolean) : [],
      groundRulesVocabulary: parseGroundRulesText(effectiveGroundRulesText(groundRulesText, cfg.txtGroundRulesDefaultVocabulary)),
      teenOrLowerOnly: teenOrLowerOnly === '1',
      pendingTagCount: Number(pendingTagCount),
      storyThreadId: story.story_thread_id ?? null,
      isAdminOrCreator: isCreator || isAdmin,
      guildName: interaction.guild.name,
      activeTurn,
      delayHours: null,
      delayWriters: null,
      activeGroup: 'settings',
    };

    // Snapshot after state is fully built — current === original for every staged field at this
    // point by construction, so this doubles as the dirty-check baseline (see STAGED_FIELDS/
    // isManageDirty above).
    state.originalFields = Object.fromEntries(STAGED_FIELDS.map((key) => [key, state[key]]));

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
      // Immediate, not staged — see STAGED_FIELDS's comment above. A simple flag with no side-effect
      // cascade (unlike Pause/Resume), so no dedicated handler file: just the write plus the same
      // status-message refresh Pause/Resume/Reopen already do.
      try {
        await interaction.deferUpdate();
        state.allowJoins = state.allowJoins ? 0 : 1;
        await connection.execute(`UPDATE story SET allow_joins = ? WHERE story_id = ?`, [state.allowJoins, state.storyId]);
        updateStoryStatusMessage(connection, interaction.guild, state.storyId).catch(() => {});
        await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));
      } catch (err) {
        log(`handleManageButton failed toggling allowJoins for storyId=${state.storyId}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
        await interaction.followUp({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }

    } else if (customId === 'story_manage_close_open') {
      // Own customIds (story_manage_close_confirm/story_manage_close_cancel), NOT the
      // standalone /story close command's story_close_confirm_<id>/story_close_cancel_<id> —
      // confirmed against Discord's docs that IsComponentsV2 can never be removed once a message
      // carries it ("Once a message has been sent with this flag, it can't be removed from that
      // message"), so this prompt and everything downstream of it must stay Components V2. The
      // standalone command's close.js handlers reply in plain content/components and must not be
      // reused directly here — see story/_manageClose.js for the manage-panel-specific confirm
      // flow (reuses close.js's actual close logic, just not its reply formatting).
      const cfg = state.cfg;
      const confirmMsg = replaceTemplateVariables(cfg.txtStoryCloseConfirm, { story_title: state.title });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('story_manage_close_confirm')
          .setLabel(cfg.btnCloseConfirm)
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('story_manage_close_cancel')
          .setLabel(cfg.btnCancel)
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(finalMessage(confirmMsg, [row]));

    } else if (customId === 'story_manage_close_confirm') {
      if (!state.isAdminOrCreator) {
        return await interaction.followUp({ content: await getConfigValue(connection, 'txtManageNotAuthorized', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }
      await handleManageCloseConfirm(connection, interaction, state);
      pendingManageData.delete(userId);

    } else if (customId === 'story_manage_close_cancel') {
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

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
      // Immediate, not staged — matches Close/Reopen rather than the rest of this panel's
      // edit-then-Save fields. Decided 2026-08-22: the toggle button used to only flip
      // state.targetStatus and defer the real UPDATE + applyPauseActions/applyResumeActions to
      // handleManageSave, same as every other field here — but that meant a Pause could silently
      // never take effect (writers never notified, thread never locked) if the panel timed out or
      // was dismissed before Save was clicked, for a toggle that's operationally meaningful the
      // moment it's clicked. handleTogglePauseResume mirrors handleReopenStory's shape.
      try {
        await handleTogglePauseResume(connection, interaction, state);
        pendingManageData.set(userId, state);
        await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));
      } catch (err) {
        await interaction.followUp({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }

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
      const cfg = state.cfg;
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

    } else if (customId === 'story_manage_rating_confirm') {
      // This button's own message is a classic (non-V2) reply from handleManageModalSubmit's
      // rating-confirm prompt, so interaction.update() with plain content/embeds is still valid
      // here — only the persistent panel message (state.originalInteraction) is V2-locked.
      state.rating = state.pendingRatingChange;
      delete state.pendingRatingChange;
      log(`handleManageButton: rating change confirmed, storyId=${state.storyId} rating=${state.rating} user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.update({ content: state.cfg.txtMetaApplied, embeds: [], components: [] });
      await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

    } else if (customId === 'story_manage_rating_revert') {
      delete state.pendingRatingChange;
      log(`handleManageButton: rating change reverted, storyId=${state.storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
      await interaction.update({ content: state.cfg.btnRatingChangeRevert, embeds: [], components: [] });

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
      const selectedRating = interaction.fields.getStringSelectValues('story_manage_metadata_rating')?.[0];
      const warningsRaw = interaction.fields.getCheckboxGroup('story_manage_metadata_warnings') ?? [];

      if (dynamic) state.dynamic = dynamic;
      state.warnings = warningsRaw ?? [];
      try {
        state.groundRules = interaction.fields.getCheckboxGroup('story_manage_metadata_groundrules') ?? [];
      } catch { /* group wasn't in this submission — vocabulary is empty */ }

      // Teen or Lower Only reset (docs/plans/PLAN-panel-rework-and-ground-rules.md Part 2): once
      // the toggle is on, M/E is no longer offered in the rating select at all (buildMetadataModal),
      // so a story that's currently M/E resets to NR the moment its metadata is next submitted —
      // there's no way for the admin to reaffirm M/E through this modal to avoid it.
      const forcedRating = (state.teenOrLowerOnly && isRestricted(state.rating)) ? 'NR' : null;
      const newRating = forcedRating ?? selectedRating ?? state.rating;

      // Restored rating-change confirmation flow — deleted in eefc881 (2026-07-01, "UX v3"),
      // approved copy (txtRatingChangeConfirmTitle/Body, btnRatingChangeConfirm/Revert) never
      // removed from config_metadata.sql. Manage-only (crossesBarrier moves a story's thread
      // between feed channels, a consequence /story add can't have before the story even exists).
      if (crossesBarrier(state.originalRating, newRating)) {
        log(`handleManageModalSubmit: rating change ${state.originalRating}→${newRating} requires confirmation, storyId=${state.storyId} user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
        state.pendingRatingChange = newRating;
        const oldLabel = cfg[ratingLabelKey(state.originalRating)] ?? state.originalRating;
        const newLabel = cfg[ratingLabelKey(newRating)] ?? newRating;
        const body = replaceTemplateVariables(cfg.txtRatingChangeConfirmBody, { old_rating: oldLabel, new_rating: newLabel });
        const confirmEmbed = new EmbedBuilder()
          .setTitle(cfg.txtRatingChangeConfirmTitle)
          .setDescription(body)
          .setColor(0xffa500);
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('story_manage_rating_confirm').setLabel(cfg.btnRatingChangeConfirm).setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('story_manage_rating_revert').setLabel(cfg.btnRatingChangeRevert).setStyle(ButtonStyle.Secondary),
        );
        // A new ephemeral message, not an edit of the V2 panel — a classic embed is still valid
        // here (see docs/reference/discordjs_reference.md's Components V2 section).
        await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], flags: MessageFlags.Ephemeral });
        return;
      }

      state.rating = newRating;
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
  handleManageModalSubmit,
  handleTurnActionConfirm,
  handleTurnActionCancel,
  handleTurnActionSelectMenu,
  handleTurnActionModal,
  isManageDirty,
  STAGED_FIELDS,
};

export default handleManage;
