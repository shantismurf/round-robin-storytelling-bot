import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables } from '../utilities.js';
import { CreateStory } from '../storybot.js';

// Temporary storage for first modal data while user completes second modal
export const pendingStoryData = new Map();

async function getPreviousAO3Name(connection, userId) {
  try {
    const [rows] = await connection.execute(
      `SELECT AO3_name FROM story_writer WHERE discord_user_id = ? AND AO3_name IS NOT NULL AND AO3_name != '' ORDER BY joined_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0]?.AO3_name ?? null;
  } catch { return null; }
}

export async function handleAddStory(connection, interaction) {
  log('handleAddStory() - initializing ephemeral story form', { show: false, guildName: interaction?.guild?.name });

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cfg = await getConfigValue(connection, [
      'txtCreateStoryTitle', 'txtStoryAddIntro', 'txtStoryTitlePrompt',
      'txtNormalModeDesc', 'txtQuickModeDesc',
      'txtHideThreadsOffDesc', 'txtHideThreadsOnDesc',
      'btnSetTitle', 'btnSetTurnLength', 'btnSetTimeout',
      'btnSetAO3Name', 'btnSetDelayHours', 'btnSetDelayWriters', 'btnCreateStory',
      'lblModeToggle', 'lblHideToggle', 'lblPrivateToggle', 'txtPrivateOffDesc', 'txtPrivateOnDesc',
      'lblStoryTitle', 'lblTurnLength', 'lblTimeoutReminder',
      'lblDelayStart', 'txtDelayHint', 'lblYourAO3Name',
      'lblNoHours', 'lblNoWriters',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'txtOrderRandomDesc', 'txtOrderRoundRobinDesc', 'txtOrderFixedDesc',
      'lblShowAuthors', 'txtShowAuthorsOnDesc', 'txtShowAuthorsOffDesc',
      'lblMaxWriters', 'btnSetMaxWriters'
    ], interaction.guild.id);

    const state = {
      cfg,
      storyTitle: null,
      quickMode: 0,
      hideThreads: 0,
      turnLength: 24,
      timeoutReminder: 50,
      ao3Name: (await getPreviousAO3Name(connection, interaction.user.id)) || interaction.member?.displayName || interaction.user.displayName,
      keepPrivate: 0,
      delayHours: null,
      delayWriters: null,
      orderType: 1,
      showAuthors: 1,
      maxWriters: null
    };

    pendingStoryData.set(interaction.user.id, {
      ...state,
      originalInteraction: interaction
    });

    await interaction.editReply(buildStoryAddMessage(cfg, state));

    log('handleAddStory() - ephemeral form sent', { show: false, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in handleAddStory: ${error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: await getConfigValue(connection, 'txtFormOpenError', interaction.guild.id),
        flags: MessageFlags.Ephemeral
      });
    }
  }
}

export function buildStoryAddMessage(cfg, state) {
  const modeEmoji = state.quickMode ? '🟣' : '🟢';
  const modeLabel = state.quickMode ? 'Quick' : 'Normal';
  const modeDesc = state.quickMode ? cfg.txtQuickModeDesc : cfg.txtNormalModeDesc;
  const hideDesc = state.hideThreads ? cfg.txtHideThreadsOnDesc : cfg.txtHideThreadsOffDesc;
  const privateDesc = state.keepPrivate ? cfg.txtPrivateOnDesc : cfg.txtPrivateOffDesc;
  const privateLabel = state.keepPrivate ? 'Yes' : 'No';
  const showAuthorsDesc = state.showAuthors ? cfg.txtShowAuthorsOnDesc : cfg.txtShowAuthorsOffDesc;
  const timeoutDisplay = state.timeoutReminder === 0 ? 'None (0%)' : `${state.timeoutReminder}%`;
  const delayHours = state.delayHours ?? 0;
  const delayWriters = state.delayWriters ?? 0;
  const maxWritersDisplay = state.maxWriters ? String(state.maxWriters) : '∞';
  const titleDisplay = state.storyTitle || cfg.txtStoryTitlePrompt;
  const orderEmojis = { 1: '🎲', 2: '🔄', 3: '📋' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderDescs = { 1: cfg.txtOrderRandomDesc, 2: cfg.txtOrderRoundRobinDesc, 3: cfg.txtOrderFixedDesc };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const orderDesc = orderDescs[state.orderType];

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtCreateStoryTitle)
    .setDescription(cfg.txtStoryAddIntro)
    .addFields(
      { name: cfg.lblStoryTitle, value: titleDisplay, inline: false },
      { name: `${modeEmoji} ${cfg.lblModeToggle}`, value: `${modeLabel} — ${modeDesc}`, inline: false },
      { name: `${orderEmoji} ${cfg.lblWriterOrder}`, value: `${orderLabel} — ${orderDesc}`, inline: false },
      { name: cfg.lblTurnLength, value: `${state.turnLength} hours`, inline: true },
      { name: cfg.lblTimeoutReminder, value: timeoutDisplay, inline: true },
      { name: cfg.lblHideToggle, value: hideDesc, inline: false },
      { name: cfg.lblYourAO3Name, value: state.ao3Name, inline: true },
      { name: cfg.lblPrivateToggle, value: `${privateLabel} — ${privateDesc}`, inline: false },
      { name: cfg.lblShowAuthors, value: `${state.showAuthors ? 'Yes' : 'No'} — ${showAuthorsDesc}`, inline: false },
      { name: cfg.lblMaxWriters, value: maxWritersDisplay, inline: true },
      { name: cfg.lblDelayStart, value: `*${cfg.txtDelayHint}*\n${delayHours} hours / ${delayWriters} writers`, inline: false }
    )
    .setColor(state.quickMode ? 0xE040FB : 0x57F287);

  // Row 1: Set Story Title
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_set_title')
      .setLabel(cfg.btnSetTitle)
      .setStyle(ButtonStyle.Primary)
  );

  // Row 2: Story Mode toggle
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_toggle_mode')
      .setLabel(`${modeEmoji} ${cfg.lblModeToggle}: ${modeLabel}`)
      .setStyle(state.quickMode ? ButtonStyle.Secondary : ButtonStyle.Success)
  );

  // Row 3: Set Turn Length, Set Timeout Reminder Interval, Hide Threads toggle, Writer Order cycle, Show Authors toggle
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_set_turnlength')
      .setLabel(replaceTemplateVariables(cfg.btnSetTurnLength, { turn_length: `${state.turnLength} hrs` }))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_timeout')
      .setLabel(replaceTemplateVariables(cfg.btnSetTimeout, { reminder_interval: state.timeoutReminder > 0 ? `${state.timeoutReminder}%` : 'Disabled' }))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_toggle_hide')
      .setLabel(`${cfg.lblHideToggle}: ${state.hideThreads ? 'On' : 'Off'}`)
      .setStyle(state.hideThreads ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_cycle_order')
      .setLabel(`${orderEmoji} ${cfg.lblWriterOrder}: ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? 'Yes' : 'No'}`)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 4: Set AO3 Name, Keep Private toggle, Set Delay Hours, Set Delay Writers, Set Max Writers
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_set_ao3')
      .setLabel(cfg.btnSetAO3Name)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_toggle_private')
      .setLabel(`${cfg.lblPrivateToggle}: ${privateLabel}`)
      .setStyle(state.keepPrivate ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_delayhours')
      .setLabel(cfg.btnSetDelayHours)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_delaywriters')
      .setLabel(cfg.btnSetDelayWriters)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_maxwriters')
      .setLabel(replaceTemplateVariables(cfg.btnSetMaxWriters, { max_writers: maxWritersDisplay }))
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 5: Create Story — alone so it stands out
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_create')
      .setLabel(cfg.btnCreateStory)
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// Handle modal submissions from the story add ephemeral form
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

    } else if (customId === 'story_add_turnlength_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 10);
      const val = parseInt(raw);
      if (isNaN(val) || val < 1) {
        await interaction.reply({
          content: replaceTemplateVariables(
            await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
            { 'Field label text': state.cfg.lblTurnLength }
          ),
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      state.turnLength = val;

    } else if (customId === 'story_add_timeout_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('timeout_reminder'), 10);
      const val = parseInt(raw);
      if (isNaN(val) || val < 0 || val > 100) {
        await interaction.reply({ content: await getConfigValue(connection, 'txtTimeoutReminderValidation', interaction.guild.id), flags: MessageFlags.Ephemeral });
        return;
      }
      state.timeoutReminder = val;

    } else if (customId === 'story_add_ao3_modal') {
      state.ao3Name = sanitizeModalInput(interaction.fields.getTextInputValue('ao3_name'), 255) || null;

    } else if (customId === 'story_add_delayhours_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('delay_hours'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(
              await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
              { 'Field label text': state.cfg.lblNoHours }
            ),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.delayHours = val || null;
      } else {
        state.delayHours = null;
      }

    } else if (customId === 'story_add_delaywriters_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('delay_writers'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(
              await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
              { 'Field label text': state.cfg.lblNoWriters }
            ),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.delayWriters = val || null;
      } else {
        state.delayWriters = null;
      }

    } else if (customId === 'story_add_maxwriters_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(
              await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
              { 'Field label text': state.cfg.lblMaxWriters }
            ),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.maxWriters = val > 0 ? val : null; // 0 = no limit
      } else {
        state.maxWriters = null;
      }
    }

    // Acknowledge the modal and update the original form
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));
    await interaction.deleteReply();

  } catch (error) {
    log(`Error in handleAddStoryModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtActionFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }
  }
}

// Handle button interactions from the story add ephemeral form
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

  if (customId === 'story_add_toggle_mode') {
    state.quickMode = state.quickMode ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

  } else if (customId === 'story_add_toggle_hide') {
    state.hideThreads = state.hideThreads ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

  } else if (customId === 'story_add_toggle_private') {
    state.keepPrivate = state.keepPrivate ? 0 : 1;
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

  } else if (customId === 'story_add_set_title') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_title_modal')
        .setTitle(state.cfg.txtCreateStoryTitle)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('story_title')
              .setLabel(state.cfg.lblStoryTitle)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(500)
              .setValue(state.storyTitle || '')
          )
        )
    );

  } else if (customId === 'story_add_set_turnlength') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_turnlength_modal')
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

  } else if (customId === 'story_add_set_timeout') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_timeout_modal')
        .setTitle(state.cfg.lblTimeoutReminder)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('timeout_reminder')
              .setLabel(state.cfg.lblTimeoutReminder)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.timeoutReminder))
              .setPlaceholder('Enter 0–100 (0 = no reminder)')
          )
        )
    );

  } else if (customId === 'story_add_set_ao3') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_ao3_modal')
        .setTitle(state.cfg.lblYourAO3Name)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ao3_name')
              .setLabel(state.cfg.lblYourAO3Name)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.ao3Name || '')
              .setPlaceholder('Your AO3 username (optional)')
          )
        )
    );

  } else if (customId === 'story_add_set_delayhours') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_delayhours_modal')
        .setTitle(state.cfg.lblNoHours)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('delay_hours')
              .setLabel(state.cfg.lblNoHours)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.delayHours != null ? String(state.delayHours) : '')
              .setPlaceholder('Enter number of hours (optional)')
          )
        )
    );

  } else if (customId === 'story_add_set_delaywriters') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_delaywriters_modal')
        .setTitle(state.cfg.lblNoWriters)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('delay_writers')
              .setLabel(state.cfg.lblNoWriters)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.delayWriters != null ? String(state.delayWriters) : '')
              .setPlaceholder('Enter number of writers (optional)')
          )
        )
    );

  } else if (customId === 'story_add_set_maxwriters') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_maxwriters_modal')
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

  } else if (customId === 'story_add_create') {
    await handleCreateStorySubmit(connection, interaction, state);
  }
}

// Handle Create Story button — validates and submits to CreateStory
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
      quickMode: state.quickMode,
      hideTurnThreads: state.hideThreads,
      turnLength: state.turnLength,
      timeoutReminder: state.timeoutReminder,
      ao3Name: state.ao3Name,
      keepPrivate: state.keepPrivate,
      delayHours: state.delayHours,
      delayWriters: state.delayWriters,
      orderType: state.orderType,
      showAuthors: state.showAuthors,
      maxWriters: state.maxWriters
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
    log(`Error creating story: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtStoryCreationError', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
}
