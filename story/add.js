import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, parseDuration, formatDuration } from '../utilities.js';
import { CreateStory } from '../storybot.js';
import { getMetaCfg, buildStoryEmbed, buildMetadataModal, buildTagsModal } from './_metadataModals.js';

// Temporary storage for story add session state
export const pendingStoryData = new Map();

async function getPreviousPenName(connection, userId) {
  try {
    const [rows] = await connection.execute(
      `SELECT pen_name FROM story_writer WHERE discord_user_id = ? AND pen_name IS NOT NULL AND pen_name != '' ORDER BY joined_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0]?.pen_name ?? null;
  } catch { return null; }
}

export async function handleAddStory(connection, interaction) {
  log('handleAddStory() - initializing ephemeral story form', { show: false, guildName: interaction?.guild?.name });

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cfg = await getMetaCfg(connection, interaction.guild.id);

    const extraCfg = await getConfigValue(connection, [
      'txtAddValidationTitleEmpty', 'txtAddValidationTitleRequired',
      'txtMustBeNo', 'txtTimeoutReminderValidation', 'txtManageValidationSlowReminder',
      'txtTimeoutReminderSlowPlaceholder', 'txtTurnLengthPlaceholder',
      'txtDelayHoursPlaceholder', 'txtDelayWritersPlaceholder', 'txtManageMaxWritersPlaceholder',
      'lblNoHours', 'lblNoWriters',
      'txtStoryCreationError', 'txtFormOpenError', 'txtActionFailed',
    ], interaction.guild.id);

    Object.assign(cfg, extraCfg);

    const state = {
      cfg,
      storyTitle: null,
      storyMode: 0,
      hideThreads: 0,
      turnLength: 24,
      timeoutReminder: 50,
      penName: (await getPreviousPenName(connection, interaction.user.id)) || interaction.member?.displayName || interaction.user.displayName,
      keepPrivate: 0,
      notifications: 1,
      delayHours: null,
      delayWriters: null,
      orderType: 1,
      showAuthors: 1,
      maxWriters: null,
      rating: 'NR',
      warnings: [],
      mainPairing: '',
      otherRelationships: '',
      characters: '',
      dynamic: '',
      tags: '',
      summary: '',
      sceneBreakDivider: ''
    };

    pendingStoryData.set(interaction.user.id, {
      ...state,
      originalInteraction: interaction
    });

    await interaction.editReply(buildStoryAddMessage(cfg, state));

    log('handleAddStory() - ephemeral form sent', { show: false, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in handleAddStory: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: await getConfigValue(connection, 'txtFormOpenError', interaction.guild.id),
        flags: MessageFlags.Ephemeral
      });
    }
  }
}

export function buildStoryAddMessage(cfg, state) {
  const isSlowMode = state.storyMode === 2;
  const modeLabels = { 0: cfg.txtNormalUC, 1: cfg.txtQuickUC, 2: cfg.txtSlowTC };
  const modeLabel = modeLabels[state.storyMode] ?? cfg.txtNormalUC;
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderLabel = orderLabels[state.orderType];

  const embed = buildStoryEmbed(cfg, state);

  // Row 1: Set Title & Summary | Mode: <> | Order: <>
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_open_titlesummary')
      .setLabel(cfg.btnAddTitleAndSummary)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('story_add_cycle_mode')
      .setLabel(`${cfg.lblModeToggle}: ${modeLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_cycle_order')
      .setLabel(`${cfg.lblWriterOrder}: ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 2: Show Names: <> | Hide Threads: <>
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? cfg.txtYes : cfg.txtNo}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_toggle_hide')
      .setLabel(`${cfg.btnAddHideToggle}: ${state.hideThreads ? cfg.txtOn : cfg.txtOff}`)
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 3: Story Metadata | Story Tags
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_open_metadata')
      .setLabel(cfg.btnAddMetadata)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_open_tags')
      .setLabel(cfg.btnAddTags)
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 4: Story Settings | My Settings
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_open_settings')
      .setLabel(cfg.btnAddSettings)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_open_mysettings')
      .setLabel(cfg.btnAddMySettings)
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 5: Create Story
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_create')
      .setLabel(cfg.btnCreateStory)
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

export async function handleAddStoryModalSubmit(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingStoryData.get(userId);

  if (!state) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const customId = interaction.customId;
  try {
    if (customId === 'story_add_title_modal') {
      const value = sanitizeModalInput(interaction.fields.getTextInputValue('story_title'), 500);
      if (!value) {
        await interaction.reply({ content: await getConfigValue(connection, 'txtAddValidationTitleEmpty', interaction.guild.id), flags: MessageFlags.Ephemeral });
        return;
      }
      state.storyTitle = value;
      state.summary = sanitizeModalInput(interaction.fields.getTextInputValue('story_summary'), 4000, true) || '';

    } else if (customId === 'story_add_settings_modal') {
      const cfg = state.cfg;
      const isSlowMode = state.storyMode === 2;

      const rawTurnLength = sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 20);
      const parsedTurnLength = parseDuration(rawTurnLength);
      if (!isSlowMode) {
        if (isNaN(parsedTurnLength) || parsedTurnLength < 1) {
          await interaction.reply({
            content: replaceTemplateVariables(await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id), { 'Field label text': cfg.lblTurnLength }),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.turnLength = parsedTurnLength;
      }

      const rawReminder = sanitizeModalInput(interaction.fields.getTextInputValue('timeout_reminder'), 10);
      if (rawReminder) {
        const val = parseInt(rawReminder);
        if (isSlowMode) {
          if (isNaN(val) || val < 0) {
            await interaction.reply({ content: await getConfigValue(connection, 'txtManageValidationSlowReminder', interaction.guild.id), flags: MessageFlags.Ephemeral });
            return;
          }
        } else {
          if (isNaN(val) || val < 0 || val > 100) {
            await interaction.reply({ content: await getConfigValue(connection, 'txtTimeoutReminderValidation', interaction.guild.id), flags: MessageFlags.Ephemeral });
            return;
          }
        }
        state.timeoutReminder = val;
      }

      const rawDelayHours = sanitizeModalInput(interaction.fields.getTextInputValue('delay_hours'), 20);
      if (rawDelayHours) {
        const parsedDelay = parseDuration(rawDelayHours);
        if (isNaN(parsedDelay) || parsedDelay < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id), { 'Field label text': cfg.lblNoHours }),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.delayHours = parsedDelay || null;
      } else {
        state.delayHours = null;
      }

      const rawDelayWriters = sanitizeModalInput(interaction.fields.getTextInputValue('delay_writers'), 10);
      if (rawDelayWriters) {
        const val = parseInt(rawDelayWriters);
        if (isNaN(val) || val < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id), { 'Field label text': cfg.lblNoWriters }),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.delayWriters = val || null;
      } else {
        state.delayWriters = null;
      }

      const rawMaxWriters = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
      if (rawMaxWriters) {
        const val = parseInt(rawMaxWriters);
        if (isNaN(val) || val < 1) {
          await interaction.reply({
            content: replaceTemplateVariables(await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id), { 'Field label text': cfg.lblMaxWriters }),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.maxWriters = val;
      } else {
        state.maxWriters = null;
      }

    } else if (customId === 'story_add_metadata_modal') {
      const dynamic = interaction.fields.getStringSelectValues?.('story_add_metadata_dynamic')?.[0]
        ?? interaction.fields.getField?.('story_add_metadata_dynamic')?.values?.[0];
      const rating = interaction.fields.getStringSelectValues?.('story_add_metadata_rating')?.[0]
        ?? interaction.fields.getField?.('story_add_metadata_rating')?.values?.[0];
      const warningsRaw = interaction.fields.getStringSelectValues?.('story_add_metadata_warnings')
        ?? interaction.fields.getField?.('story_add_metadata_warnings')?.values ?? [];

      if (dynamic) state.dynamic = dynamic;
      if (rating) state.rating = rating;
      state.warnings = (warningsRaw ?? []).filter(v => v !== '__dismiss__');

    } else if (customId === 'story_add_tags_modal') {
      state.mainPairing = sanitizeModalInput(interaction.fields.getTextInputValue('main_pairing'), 200) || '';
      state.otherRelationships = sanitizeModalInput(interaction.fields.getTextInputValue('other_relationships'), 1000, true) || '';
      state.characters = sanitizeModalInput(interaction.fields.getTextInputValue('characters'), 500) || '';
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 1000, true) || '';
      state.sceneBreakDivider = sanitizeModalInput(interaction.fields.getTextInputValue('scene_break_divider'), 200) || '';

    } else if (customId === 'story_add_mysettings_modal') {
      const rawPenName = sanitizeModalInput(interaction.fields.getTextInputValue('pen_name'), 255);
      state.penName = rawPenName || null;

      const privacyVal = interaction.fields.getStringSelectValues?.('story_add_mysettings_privacy')?.[0]
        ?? interaction.fields.getField?.('story_add_mysettings_privacy')?.values?.[0];
      if (privacyVal === 'private') state.keepPrivate = 1;
      else if (privacyVal === 'public') state.keepPrivate = 0;

      const notifVal = interaction.fields.getStringSelectValues?.('story_add_mysettings_notifications')?.[0]
        ?? interaction.fields.getField?.('story_add_mysettings_notifications')?.values?.[0];
      if (notifVal === 'dm') state.notifications = 1;
      else if (notifVal === 'mention') state.notifications = 0;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));
    await interaction.deleteReply();

  } catch (error) {
    log(`Error in handleAddStoryModalSubmit: customId=${customId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtActionFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleAddStoryButton(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingStoryData.get(userId);

  if (!state) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const customId = interaction.customId;
  log(`handleAddStoryButton: customId=${customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  try {
    if (customId === 'story_add_cycle_mode') {
      state.storyMode = state.storyMode === 2 ? 0 : state.storyMode + 1;
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

    } else if (customId === 'story_add_toggle_hide') {
      state.hideThreads = state.hideThreads ? 0 : 1;
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

    } else if (customId === 'story_add_toggle_authors') {
      state.showAuthors = state.showAuthors ? 0 : 1;
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

    } else if (customId === 'story_add_cycle_order') {
      state.orderType = state.orderType === 3 ? 1 : state.orderType + 1;
      await interaction.deferUpdate();
      await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

    } else if (customId === 'story_add_open_titlesummary') {
      const cfg = state.cfg;
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_title_modal')
          .setTitle(cfg.btnAddTitleAndSummary)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('story_title')
                .setLabel(cfg.lblStoryTitle)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(500)
                .setValue(state.storyTitle || '')
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

    } else if (customId === 'story_add_open_settings') {
      const cfg = state.cfg;
      const isSlowMode = state.storyMode === 2;
      const turnLengthLabel = isSlowMode ? cfg.txtNA : cfg.lblTurnLength;
      const reminderLabel = isSlowMode ? cfg.lblTimeoutReminderSlow : cfg.lblTimeoutReminder;
      const reminderPlaceholder = isSlowMode ? cfg.txtTimeoutReminderSlowPlaceholder : 'Enter 0–100 (0 = no reminder)';

      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_settings_modal')
          .setTitle(cfg.btnAddSettings)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('turn_length')
                .setLabel(turnLengthLabel)
                .setStyle(TextInputStyle.Short)
                .setRequired(!isSlowMode)
                .setMaxLength(20)
                .setValue(isSlowMode ? '' : (state.turnLength ? formatDuration(state.turnLength) : ''))
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
                .setCustomId('delay_hours')
                .setLabel(cfg.lblNoHours)
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(20)
                .setValue(state.delayHours != null ? formatDuration(state.delayHours) : '')
                .setPlaceholder(cfg.txtDelayHoursPlaceholder ?? 'Enter number of hours (optional)')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('delay_writers')
                .setLabel(cfg.lblNoWriters)
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(10)
                .setValue(state.delayWriters != null ? String(state.delayWriters) : '')
                .setPlaceholder(cfg.txtDelayWritersPlaceholder ?? 'Enter number of writers (optional)')
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

    } else if (customId === 'story_add_open_metadata') {
      await interaction.showModal(buildMetadataModal(state.cfg, state, 'story_add'));

    } else if (customId === 'story_add_open_tags') {
      await interaction.showModal(buildTagsModal(state.cfg, state, 'story_add'));

    } else if (customId === 'story_add_open_mysettings') {
      const cfg = state.cfg;
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_mysettings_modal')
          .setTitle(cfg.btnAddMySettings)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('pen_name')
                .setLabel(cfg.lblYourPenName)
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(255)
                .setValue(state.penName || '')
                .setPlaceholder(cfg.txtJoinPenNamePlaceholder ?? 'Leave blank to use Discord display name')
            ),
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('story_add_mysettings_privacy')
                .setPlaceholder(cfg.lblJoinPrivacySelect)
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions([
                  { label: cfg.txtPublic, value: 'public', default: !state.keepPrivate },
                  { label: cfg.txtPrivate, value: 'private', default: !!state.keepPrivate },
                ])
            ),
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('story_add_mysettings_notifications')
                .setPlaceholder(cfg.lblJoinNotifSelect)
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions([
                  { label: cfg.txtNotifDM, value: 'dm', default: !!state.notifications },
                  { label: cfg.txtNotifMention, value: 'mention', default: !state.notifications },
                ])
            ),
          )
      );

    } else if (customId === 'story_add_create') {
      await handleCreateStorySubmit(connection, interaction, state);
    }
  } catch (error) {
    log(`handleAddStoryButton failed: customId=${customId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtActionFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleCreateStorySubmit(connection, interaction, state) {
  if (!state.storyTitle) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtAddValidationTitleRequired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const storyInput = {
      storyTitle: state.storyTitle,
      mode: state.storyMode,
      hideTurnThreads: state.hideThreads,
      turnLength: state.turnLength,
      timeoutReminder: state.timeoutReminder,
      penName: state.penName,
      keepPrivate: state.keepPrivate,
      notifications: state.notifications ?? 1,
      delayHours: state.delayHours,
      delayWriters: state.delayWriters,
      orderType: state.orderType,
      showAuthors: state.showAuthors,
      maxWriters: state.maxWriters,
      rating: state.rating ?? 'NR',
      warnings: state.warnings?.length ? state.warnings.join(', ') : null,
      mainPairing: state.mainPairing || null,
      otherRelationships: state.otherRelationships || null,
      characters: state.characters || null,
      dynamic: state.dynamic || null,
      tags: state.tags || null,
      summary: state.summary || null,
      sceneBreakDivider: state.sceneBreakDivider || null
    };

    const result = await CreateStory(connection, interaction, storyInput);
    pendingStoryData.delete(interaction.user.id);

    if (result.success) {
      await state.originalInteraction.editReply({
        content: result.message,
        embeds: [],
        components: []
      });
    } else {
      await state.originalInteraction.editReply({
        content: result.error,
        embeds: [],
        components: []
      });
    }
  } catch (error) {
    log(`Error creating story: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtStoryCreationError', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
}
