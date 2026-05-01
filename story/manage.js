import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId, getTurnNumber, checkIsAdmin, checkIsCreator } from '../utilities.js';
import { PickNextWriter, NextTurn, updateStoryStatusMessage, migrateStoryThread } from '../storybot.js';
import { RATING_LABELS, WARNING_OPTIONS, CATEGORY_OPTIONS, crossesBarrier, isRestricted } from './metadata.js';
import { buildTurnActionsPanel, handleTurnActionButton, handleTurnActionConfirm, handleTurnActionCancel, handleTurnActionSelectMenu, handleTurnActionModal } from './manageTurnActions.js';
import { handleManageEntriesButton, handleManageEntriesSelectMenu } from './manageEntries.js';

const pendingManageData = new Map();

function buildManageMessage(cfg, state, activeTurn = null) {
  const orderEmojis = { 1: '\u{1F3B2}', 2: '\u{1F504}', 3: '\u{1F4CB}' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const isPaused = state.targetStatus === 2;

  const ratingLabel = RATING_LABELS[state.rating ?? 'NR'] ?? '[NR] Not Rated';
  const warningsDisplay = state.warnings?.length
    ? (Array.isArray(state.warnings) ? state.warnings : state.warnings.split(',').map(w => w.trim())).join(', ')
    : '*None set*';

  const barrierWarning = state.pendingRating && crossesBarrier(state.originalRating ?? state.rating, state.pendingRating)
    ? `\n\n${cfg.txtRatingChangeThreadWarning ?? '⚠️ Changing this rating will migrate the story to a new thread on the appropriate feed channel. The old thread will be archived and closed.'}`
    : '';

  const sectionLine = cfg.txtSectionBreakLine ?? '═══════════';
  const statusDisplay = isPaused
    ? (cfg.txtManageStoryStatusPaused ?? '⏸️ Paused')
    : (cfg.txtManageStoryStatusActive ?? '▶️ Active');
  const joinDisplay = state.allowJoins
    ? (cfg.txtManageJoinOpen ?? '\u{1F513} Open')
    : (cfg.txtManageJoinClosed ?? '\u{1F512} Closed');

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtManageEmbedTitle ?? 'Story Settings')
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblManageStoryTitle ?? '\u{1F4D6} Story Title', value: state.title, inline: false },
      { name: cfg.lblManageStoryStatus ?? 'Story Status', value: statusDisplay, inline: true },
      { name: cfg.lblManageJoinStatus ?? 'Join Status', value: joinDisplay, inline: true },
      { name: cfg.lblWriterOrder, value: `${orderEmoji} ${orderLabel}`, inline: true },
      { name: cfg.lblMaxWriters, value: state.maxWriters ? String(state.maxWriters) : '∞', inline: true },
      { name: cfg.lblTurnLength, value: `${state.turnLength} hours`, inline: true },
      { name: cfg.lblTimeoutReminder, value: state.timeoutReminder > 0 ? `${state.timeoutReminder}%` : 'Disabled', inline: true },
      { name: cfg.lblPrivateToggle, value: state.turnPrivacy ? 'Private' : 'Public', inline: true },
      { name: cfg.lblShowAuthors, value: state.showAuthors ? 'Yes' : 'No', inline: true },
      { name: sectionLine, value: cfg.txtManageSectionBreakMeta ?? '**\u{1F4CB} Story Metadata**', inline: false },
      { name: cfg.lblRating ?? 'Rating', value: ratingLabel + barrierWarning, inline: true },
      { name: cfg.lblCategory ?? 'Category', value: state.category || '*Not set*', inline: true },
      { name: cfg.lblWarnings ?? 'Warnings', value: warningsDisplay, inline: false },
      { name: cfg.lblTags, value: state.tags || '*Not set*', inline: false },
    );

  const currentRatingDisplay = state.pendingRating ? `${state.pendingRating} ⚠️` : (state.rating ?? 'NR');

  // Row 1 (4): Set Title | Writer Order: <> | Status: <> | Join Status: <>
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_set_title')
      .setLabel(cfg.txtManageSetTitleModalTitle ?? 'Set Title')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_manage_cycle_order')
      .setLabel(`${cfg.lblWriterOrder}: ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_status')
      .setLabel(`Status: ${isPaused ? 'Paused' : 'Active'}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_latejoins')
      .setLabel(`Join: ${state.allowJoins ? 'Open' : 'Closed'}`)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 2 (4): Max Writers: <> | Turn Length: <> | Reminder: <> | Metadata
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_set_maxwriters')
      .setLabel(replaceTemplateVariables(cfg.btnSetMaxWriters, { max_writers: state.maxWriters ?? '∞' }))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_turnlength')
      .setLabel(replaceTemplateVariables(cfg.btnSetTurnLength, { turn_length: `${state.turnLength} hrs` }))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_reminder')
      .setLabel(replaceTemplateVariables(cfg.btnSetTimeout, { reminder_interval: state.timeoutReminder > 0 ? `${state.timeoutReminder}%` : 'Disabled' }))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_open_metadata')
      .setLabel(cfg.btnSetMetadata ?? 'Metadata')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 3 (3): Show Names: <> | Hide Threads: <> | Manage Turns
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? 'Yes' : 'No'}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_privacy')
      .setLabel(`${cfg.lblPrivateToggle}: ${state.turnPrivacy ? 'Private' : 'Public'}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_turns_open')
      .setLabel(cfg.btnManageTurns ?? 'Manage Turns')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 4 (2-3): Manage Entries | [Review Tags if pending]
  const row4Components = [
    new ButtonBuilder()
      .setCustomId('story_manage_entries_open')
      .setLabel(cfg.btnManageEntries ?? 'Manage Entries')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (state.pendingTagCount > 0) {
    row4Components.push(
      new ButtonBuilder()
        .setCustomId('story_manage_review_tags')
        .setLabel(replaceTemplateVariables(cfg.btnReviewTags ?? 'Review Tags ([count])', { count: state.pendingTagCount }))
        .setStyle(ButtonStyle.Primary)
    );
  }
  const row4 = new ActionRowBuilder().addComponents(...row4Components);

  // Row 5 (2): Pause/Resume | Save Settings
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_pauseresume')
      .setLabel(isPaused ? 'Resume Story' : 'Pause Story')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_save')
      .setLabel(cfg.btnSaveSettings ?? cfg.btnAdminConfigSave ?? 'Save Settings')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

async function handleManage(connection, interaction, alreadyDeferred = false) {
  log(`handleManage: entry user=${interaction.user.id} alreadyDeferred=${alreadyDeferred}`, { show: false, guildName: interaction?.guild?.name });
  if (!alreadyDeferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, turn_length_hours, timeout_reminder_percent,
              max_writers, allow_joins, show_authors, story_order_type, summary, tags, story_turn_privacy,
              rating, warnings, fandom, main_pairing, other_relationships, characters, category, additional_tags
       FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    if (story.story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryAlreadyClosed', guildId) });
    }

    const isCreator = await checkIsCreator(connection, storyId, interaction.user.id);
    const isAdmin = await checkIsAdmin(connection, interaction, guildId);

    if (!isCreator && !isAdmin) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtManageNotAuthorized', guildId) });
    }

    const cfg = await getConfigValue(connection, [
      'txtManageEmbedTitle', 'btnAdminConfigSave', 'btnSaveSettings', 'btnCancel',
      'lblTurnLength', 'btnSetTurnLength',
      'lblTimeoutReminder', 'btnSetTimeout',
      'lblMaxWriters', 'btnSetMaxWriters',
      'lblOpenToWriters', 'lblShowAuthors',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'lblTags', 'btnSetTags',
      'lblPrivateToggle',
      'lblRating', 'lblWarnings', 'lblCategory',
      'txtRatingChangeThreadWarning',
      'btnSetMetadata', 'btnReviewTags',
      'txtSelectionStaged',
      'txtSectionBreakLine', 'txtManageSectionBreakMeta',
      'lblManageStoryTitle', 'lblManageStoryStatus', 'lblManageJoinStatus',
      'txtManageStoryStatusActive', 'txtManageStoryStatusPaused',
      'txtManageJoinOpen', 'txtManageJoinClosed',
      'txtManageSetTitleModalTitle', 'lblManageSetTitleField', 'txtManageSetTitlePlaceholder',
      'btnManageTurns', 'btnManageEntries',
      'txtManageTurnsPanelTitle', 'txtManageTurnsNoTurn', 'txtManageTurnsActiveTurn',
      // Turn action cfg keys
      'btnTurnSkip', 'btnTurnExtend', 'btnTurnNext', 'btnTurnReassign',
      'btnTurnDeleteEntry', 'btnTurnRestoreEntry', 'txtTurnSkipConfirm',
      'txtTurnReassignConfirm', 'txtTurnExtendModalTitle', 'lblTurnExtendHours',
      'txtTurnExtendPlaceholder', 'txtTurnDeleteEntryModalTitle', 'lblTurnDeleteEntryTurn',
      'txtTurnDeleteEntryPlaceholder', 'txtTurnRestoreEntryModalTitle', 'lblTurnRestoreEntryId',
      'txtTurnRestoreEntryPlaceholder', 'txtTurnNextSelectWrite'
    ], guildId);
    log(`handleManage: cfg loaded`, { show: false, guildName: interaction?.guild?.name });

    // Count pending tag submissions for this story
    const [[{ pendingTagCount }]] = await connection.execute(
      `SELECT COUNT(*) AS pendingTagCount FROM story_tag_submission WHERE story_id = ? AND submission_status = 'pending'`,
      [storyId]
    );

    // Fetch active turn for turn actions section
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
      turnLength: story.turn_length_hours,
      timeoutReminder: story.timeout_reminder_percent ?? 50,
      maxWriters: story.max_writers,
      allowJoins: story.allow_joins,
      showAuthors: story.show_authors,
      orderType: story.story_order_type,
      turnPrivacy: story.story_turn_privacy,
      summary: story.summary ?? '',
      tags: story.tags ?? '',
      originalStatus: story.story_status,
      targetStatus: story.story_status,
      originalInteraction: interaction,
      // AO3 metadata
      rating: story.rating ?? 'NR',
      originalRating: story.rating ?? 'NR',
      pendingRating: null,
      warnings: story.warnings ? story.warnings.split(',').map(w => w.trim()).filter(Boolean) : [],
      fandom: story.fandom ?? '',
      mainPairing: story.main_pairing ?? '',
      otherRelationships: story.other_relationships ?? '',
      characters: story.characters ?? '',
      category: story.category ?? '',
      additionalTags: story.additional_tags ?? '',
      pendingTagCount: Number(pendingTagCount),
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
  const userId = interaction.user.id;
  const state = pendingManageData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
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

  } else if (customId === 'story_manage_cycle_order') {
    state.orderType = state.orderType === 3 ? 1 : state.orderType + 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_toggle_pauseresume') {
    state.targetStatus = state.targetStatus === 1 ? 2 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_toggle_status') {
    // Legacy alias
    state.targetStatus = state.targetStatus === 1 ? 2 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));

  } else if (customId === 'story_manage_set_title') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_title_modal')
        .setTitle(state.cfg.txtManageSetTitleModalTitle ?? 'Edit Story Title')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('story_title')
            .setLabel(state.cfg.lblManageSetTitleField ?? 'New Title')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(500)
            .setValue(state.title || '')
            .setPlaceholder(state.cfg.txtManageSetTitlePlaceholder ?? 'Enter the new story title')
        ))
    );

  } else if (customId === 'story_manage_turns_open') {
    await interaction.reply(buildTurnActionsPanel(state, state.activeTurn, state.cfg));

  } else if (customId === 'story_manage_entries_open') {
    await handleManageEntriesButton(connection, interaction, state);

  } else if (customId === 'story_manage_open_metadata') {
    const { buildMetadataPanel } = await import('./addMetadata.js');
    const cfg2 = await getConfigValue(connection, [
      'txtMetaPanelTitle', 'txtMetaSaveSuccess', 'btnSaveSettings', 'btnCancel',
      'lblMetaCategory', 'lblMetaRating', 'lblMetaWarnings', 'lblMetaFandom',
      'lblMetaMainRelationship', 'lblMetaOtherRelationships', 'lblMetaCharacters', 'lblMetaTags',
      'txtMetaMainRelationshipPlaceholder',
    ], interaction.guild.id);
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
              .setPlaceholder('Enter number of hours')
          )
        )
    );

  } else if (customId === 'story_manage_set_reminder') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_reminder_modal')
        .setTitle(state.cfg.lblTimeoutReminder)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('timeout_reminder')
              .setLabel(state.cfg.lblTimeoutReminder)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.timeoutReminder))
              .setPlaceholder('Enter: 0, 25, 50, or 75')
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
              .setPlaceholder('Enter a number, or leave blank for no limit')
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
              .setPlaceholder('Comma-separated tags (e.g. fluff, AU, slow burn)')
          )
        )
    );

  } else if (customId === 'story_manage_review_tags') {
    await handleReviewTags(connection, interaction, state);
    return;

  } else if (customId.startsWith('story_manage_ta_')) {
    // Turn action buttons — delegate to manageTurnActions
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

async function showManageMetaModal(interaction, state) {
  const modal = new ModalBuilder()
    .setCustomId('story_manage_meta_modal')
    .setTitle('Story Metadata');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('fandom')
        .setLabel('Fandom (up to 100 characters)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100)
        .setValue(state.fandom ?? '')
        .setPlaceholder('e.g. My Hero Academia, Original Work')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('main_pairing')
        .setLabel('Main Pairing (up to 200 characters)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200)
        .setValue(state.mainPairing ?? '')
        .setPlaceholder('Full character names, e.g. Midoriya Izuku/Bakugou Katsuki')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('characters')
        .setLabel('Characters (up to 500 characters)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(500)
        .setValue(state.characters ?? '')
        .setPlaceholder('Comma-separated character names')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('other_relationships')
        .setLabel('Other Relationships (up to 1000 characters)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
        .setValue(state.otherRelationships ?? '')
        .setPlaceholder('Additional pairings or relationships, comma-separated')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('additional_tags')
        .setLabel('Additional Tags (up to 1000 characters)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
        .setValue(state.additionalTags ?? '')
        .setPlaceholder('Comma-separated tags, e.g. slow burn, hurt/comfort, AU')
    )
  );

  await interaction.showModal(modal);
}

async function handleReviewTags(connection, interaction, state) {
  const [rows] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text
     FROM story_tag_submission
     WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [state.storyId]
  );

  if (rows.length === 0) {
    await interaction.reply({
      content: state.cfg.txtTagNoPending ?? 'No pending tag suggestions.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const firstTag = rows[0];
  const queueNote = rows.length > 1 ? ` (${rows.length - 1} more pending)` : '';

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(state.cfg.txtTagPendingTitle ?? '🏷️ Pending Tags — [story_title]', { story_title: state.title }))
    .setDescription(`**"${firstTag.tag_text}"** — suggested by ${firstTag.submitter_display_name}${queueNote}`)
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_tag_approve_${firstTag.submission_id}_${state.storyId}`)
      .setLabel(state.cfg.btnTagApprove ?? '✅ Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`story_tag_reject_${firstTag.submission_id}_${state.storyId}`)
      .setLabel(state.cfg.btnTagReject ?? '❌ Reject')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

async function handleManageSave(connection, interaction, state) {
  const guildId = interaction.guild.id;
  try {
    const finalRating = state.pendingRating ?? state.rating;
    const warningsStr = Array.isArray(state.warnings) ? state.warnings.join(', ') : (state.warnings || null);

    await connection.execute(
      `UPDATE story SET title = ?, turn_length_hours = ?, timeout_reminder_percent = ?, max_writers = ?,
       allow_joins = ?, show_authors = ?, story_order_type = ?,
       story_turn_privacy = ?, summary = ?, tags = ?,
       rating = ?, warnings = ?, fandom = ?, main_pairing = ?,
       other_relationships = ?, characters = ?, category = ?, additional_tags = ?
       WHERE story_id = ?`,
      [
        state.title,
        state.turnLength, state.timeoutReminder, state.maxWriters ?? null,
        state.allowJoins, state.showAuthors, state.orderType,
        state.turnPrivacy, state.summary || null, state.tags || null,
        finalRating, warningsStr || null,
        state.fandom || null, state.mainPairing || null,
        state.otherRelationships || null, state.characters || null,
        state.category || null, state.additionalTags || null,
        state.storyId
      ]
    );

    // Migrate story thread if rating crossed the M/E barrier
    if (state.pendingRating && crossesBarrier(state.originalRating, state.pendingRating)) {
      const migResult = await migrateStoryThread(connection, interaction.guild, state.storyId, state.pendingRating);
      if (!migResult.success) {
        log(`Thread migration failed for story ${state.storyId}: ${migResult.error}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

    // Handle pause/resume if status changed
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

async function applyPauseActions(connection, interaction, state) {
  const [activeTurnRows] = await connection.execute(
    `SELECT t.turn_id, t.thread_id, sw.discord_display_name
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND t.turn_status = 1`,
    [state.storyId]
  );
  if (activeTurnRows.length === 0) return;

  const { turn_id: turnId, thread_id: threadId, discord_display_name } = activeTurnRows[0];

  // Cancel pending timeout and reminder jobs
  await connection.execute(
    `UPDATE job SET job_status = 2 WHERE job_status = 0
     AND job_type IN ('turnTimeout', 'turnReminder')
     AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
    [turnId]
  );

  if (!threadId) return; // Quick mode — no thread to lock

  try {
    const thread = await interaction.guild.channels.fetch(threadId);
    if (!thread) return;

    const turnNumber = await getTurnNumber(connection, state.storyId);
    const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
    const pausedTitle = threadTitleTemplate
      .replace('[story_id]', state.guildStoryId)
      .replace('[storyTurnNumber]', turnNumber)
      .replace('[user display name]', discord_display_name)
      .replace('[turnEndTime]', 'PAUSED');

    await thread.setName(pausedTitle);
    await thread.setLocked(true);
  } catch (err) {
    log(`Could not lock turn thread on pause (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  // Update story thread title to show PAUSED
  try {
    const [storyInfo] = await connection.execute(
      `SELECT story_thread_id FROM story WHERE story_id = ?`, [state.storyId]
    );
    if (storyInfo[0]?.story_thread_id) {
      const storyThread = await interaction.guild.channels.fetch(storyInfo[0].story_thread_id).catch(() => null);
      if (storyThread) {
        const [txtPaused, titleTemplate] = await Promise.all([
          getConfigValue(connection, 'txtPaused', state.guildId),
          getConfigValue(connection, 'txtStoryThreadTitle', state.guildId)
        ]);
        await storyThread.setName(
          titleTemplate.replace('[story_id]', state.guildStoryId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtPaused)
        );
      }
    }
  } catch (err) {
    log(`Could not update story thread title on pause (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

async function applyResumeActions(connection, interaction, state) {
  const [activeTurnRows] = await connection.execute(
    `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.discord_display_name, sw.notification_prefs
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND t.turn_status = 1`,
    [state.storyId]
  );

  // Update story thread title back to Active regardless of turn state
  try {
    const [storyInfo] = await connection.execute(
      `SELECT story_thread_id FROM story WHERE story_id = ?`, [state.storyId]
    );
    if (storyInfo[0]?.story_thread_id) {
      const storyThread = await interaction.guild.channels.fetch(storyInfo[0].story_thread_id).catch(() => null);
      if (storyThread) {
        const [txtActive, titleTemplate] = await Promise.all([
          getConfigValue(connection, 'txtActive', state.guildId),
          getConfigValue(connection, 'txtStoryThreadTitle', state.guildId)
        ]);
        await storyThread.setName(
          titleTemplate.replace('[story_id]', state.guildStoryId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtActive)
        );
      }
    }
  } catch (err) {
    log(`Could not update story thread title on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  if (activeTurnRows.length === 0) {
    // No active turn — start a new one
    const nextWriterId = await PickNextWriter(connection, state.storyId);
    if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
    return;
  }

  const activeTurn = activeTurnRows[0];
  const newTurnEndsAt = new Date(Date.now() + (state.turnLength * 60 * 60 * 1000));

  // Reset turn deadline
  await connection.execute(
    `UPDATE turn SET turn_ends_at = ? WHERE turn_id = ?`,
    [newTurnEndsAt, activeTurn.turn_id]
  );

  // Cancel any lingering jobs, then reschedule fresh
  await connection.execute(
    `UPDATE job SET job_status = 2 WHERE job_status = 0
     AND job_type IN ('turnTimeout', 'turnReminder')
     AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
    [activeTurn.turn_id]
  );
  await connection.execute(
    `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
    ['turnTimeout', JSON.stringify({ turnId: activeTurn.turn_id, storyId: state.storyId, guildId: state.guildId }), newTurnEndsAt]
  );
  if (state.timeoutReminder > 0) {
    const reminderMs = state.turnLength * (state.timeoutReminder / 100) * 60 * 60 * 1000;
    const reminderTime = new Date(Date.now() + reminderMs);
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
      ['turnReminder', JSON.stringify({ turnId: activeTurn.turn_id, storyId: state.storyId, guildId: state.guildId, writerUserId: activeTurn.discord_user_id }), reminderTime]
    );
  }

  if (activeTurn.thread_id) {
    // Normal mode — unlock thread, rebuild title, post resumed message
    try {
      const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
      if (thread) {
        const turnNumber = await getTurnNumber(connection, state.storyId);
        const formattedEndTime = newTurnEndsAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
        const newTitle = threadTitleTemplate
          .replace('[story_id]', state.guildStoryId)
          .replace('[storyTurnNumber]', turnNumber)
          .replace('[user display name]', activeTurn.discord_display_name)
          .replace('[turnEndTime]', formattedEndTime);

        await thread.setName(newTitle);
        await thread.setLocked(false);

        const newEndTimestamp = `<t:${Math.floor(newTurnEndsAt.getTime() / 1000)}:F>`;
        const txtTurnThreadResumed = await getConfigValue(connection, 'txtTurnThreadResumed', state.guildId);
        await thread.send(replaceTemplateVariables(txtTurnThreadResumed, { turn_end_time: newEndTimestamp }));
      }
    } catch (err) {
      log(`Could not unlock turn thread on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
    }
  } else {
    // Quick mode — notify writer via DM or mention that their turn is active again
    try {
      const txtDMTurnStart = await getConfigValue(connection, 'txtDMTurnStart', state.guildId);
      const user = await interaction.client.users.fetch(activeTurn.discord_user_id);
      await user.send(txtDMTurnStart);
    } catch {
      try {
        const txtMentionTurnStart = await getConfigValue(connection, 'txtMentionTurnStart', state.guildId);
        const storyFeedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', state.guildId);
        const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
        await channel.send(`<@${activeTurn.discord_user_id}> ${txtMentionTurnStart}`);
      } catch (err) {
        log(`Could not notify writer on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }
  }

}

async function handleManageModalSubmit(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingManageData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
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
      if (isNaN(val) || val < 0 || val > 100) {
        return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationTimeout', interaction.guild.id), flags: MessageFlags.Ephemeral });
      }
      state.timeoutReminder = val;

    } else if (interaction.customId === 'story_manage_maxwriters_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          return await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationMaxWriters', interaction.guild.id), flags: MessageFlags.Ephemeral });
        }
        state.maxWriters = val > 0 ? val : null; // 0 = no limit
      } else {
        state.maxWriters = null;
      }

    } else if (interaction.customId === 'story_manage_tags_modal') {
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 500) ?? '';

    } else if (interaction.customId === 'story_manage_meta_modal') {
      state.fandom             = sanitizeModalInput(interaction.fields.getTextInputValue('fandom'), 100) || '';
      state.mainPairing        = sanitizeModalInput(interaction.fields.getTextInputValue('main_pairing'), 200) || '';
      state.characters         = sanitizeModalInput(interaction.fields.getTextInputValue('characters'), 500) || '';
      state.otherRelationships = sanitizeModalInput(interaction.fields.getTextInputValue('other_relationships'), 1000, true) || '';
      state.additionalTags     = sanitizeModalInput(interaction.fields.getTextInputValue('additional_tags'), 1000, true) || '';
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stagedMsg = state.cfg.txtSelectionStaged ?? 'Selection saved — click **Save Settings** on the panel to apply.';
    await interaction.editReply({ content: stagedMsg });
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));
    await interaction.deleteReply();

  } catch (error) {
    log(`Error in handleManageModalSubmit: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

/**
 * Handle select menu interactions from the manage panel (rating/warnings/category).
 */
async function handleManageSelectMenu(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingManageData.get(userId);

  if (!state) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id), components: [] });
    return;
  }

  const customId = interaction.customId;

  if (customId === 'story_manage_rating_select') {
    state.pendingRating = interaction.values[0];
  } else if (customId === 'story_manage_warnings_select') {
    state.warnings = interaction.values;
  } else {
    return;
  }

  const stagedMsg = state.cfg.txtSelectionStaged ?? 'Selection saved — click **Save Settings** on the panel to apply.';
  await interaction.update({ content: stagedMsg, components: [] });
  await state.originalInteraction.editReply(buildManageMessage(state.cfg, state, state.activeTurn));
}

/**
 * Handle tag approval/rejection buttons (story_tag_approve_* / story_tag_reject_*).
 */
async function handleTagReviewButton(connection, interaction) {
  const parts = interaction.customId.split('_');
  // story_tag_approve_<submissionId>_<storyId>
  const action = parts[2]; // 'approve' or 'reject'
  const submissionId = parts[3];
  const storyId = parts[4];
  const guildId = interaction.guild.id;

  // Only story creator can approve/reject
  const isCreator = await checkIsCreator(connection, storyId, interaction.user.id);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);
  if (!isCreator && !isAdmin) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagNotCreator', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const [rows] = await connection.execute(
    `SELECT tag_text FROM story_tag_submission WHERE submission_id = ? AND submission_status = 'pending'`,
    [submissionId]
  );
  if (rows.length === 0) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagReviewSessionExpired', guildId), flags: MessageFlags.Ephemeral });
    return;
  }
  const { tag_text: tagText } = rows[0];

  await interaction.deferUpdate();

  if (action === 'approve') {
    await connection.execute(
      `UPDATE story_tag_submission SET submission_status = 'approved', reviewed_at = NOW() WHERE submission_id = ?`,
      [submissionId]
    );
    // Append tag to story's additional_tags
    const [storyRows] = await connection.execute(`SELECT additional_tags FROM story WHERE story_id = ?`, [storyId]);
    const existing = storyRows[0]?.additional_tags?.trim() || '';
    const newTags = existing ? `${existing}, ${tagText}` : tagText;
    await connection.execute(`UPDATE story SET additional_tags = ? WHERE story_id = ?`, [newTags, storyId]);
    updateStoryStatusMessage(connection, interaction.guild, storyId).catch(() => {});
    const txt = replaceTemplateVariables(await getConfigValue(connection, 'txtTagApproved', guildId), { tag_text: tagText });
    await interaction.editReply({ content: txt, embeds: [], components: [] });
  } else {
    await connection.execute(
      `UPDATE story_tag_submission SET submission_status = 'rejected', reviewed_at = NOW() WHERE submission_id = ?`,
      [submissionId]
    );
    const txt = replaceTemplateVariables(await getConfigValue(connection, 'txtTagRejected', guildId), { tag_text: tagText });
    await interaction.editReply({ content: txt, embeds: [], components: [] });
  }
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
