import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId, getTurnNumber, checkIsAdmin, checkIsCreator } from '../utilities.js';
import { PickNextWriter, NextTurn, updateStoryStatusMessage } from '../storybot.js';

const pendingManageData = new Map();

function buildManageMessage(cfg, state) {
  const orderEmojis = { 1: '🎲', 2: '🔄', 3: '📋' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const isPaused = state.targetStatus === 2;

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtAdminConfigTitle, { story_title: state.title }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblTurnLength, value: `${state.turnLength} hours`, inline: true },
      { name: cfg.lblTimeoutReminder, value: state.timeoutReminder > 0 ? `${state.timeoutReminder}%` : 'Disabled', inline: true },
      { name: cfg.lblMaxWriters, value: state.maxWriters ? String(state.maxWriters) : '∞', inline: true },
      { name: cfg.lblOpenToWriters, value: state.allowJoins ? 'Yes' : 'No', inline: true },
      { name: cfg.lblShowAuthors, value: state.showAuthors ? 'Yes' : 'No', inline: true },
      { name: cfg.lblPrivateToggle, value: state.turnPrivacy ? 'Private' : 'Public', inline: true },
      { name: cfg.lblWriterOrder, value: `${orderEmoji} ${orderLabel}`, inline: true },
      { name: cfg.lblSummary, value: state.summary || '*Not set*', inline: false },
      { name: cfg.lblTags, value: state.tags || '*Not set*', inline: false },
      { name: 'Story Status', value: isPaused ? '⏸️ Paused' : '▶️ Active', inline: true }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_set_turnlength')
      .setLabel(cfg.btnSetTurnLength)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_reminder')
      .setLabel(cfg.btnSetTimeout)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_maxwriters')
      .setLabel(`${cfg.btnSetMaxWriters}: ${state.maxWriters ?? '∞'}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_latejoins')
      .setLabel(`${cfg.lblOpenToWriters}: ${state.allowJoins ? 'Yes' : 'No'}`)
      .setStyle(state.allowJoins ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? 'Yes' : 'No'}`)
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_cycle_order')
      .setLabel(`${orderEmoji} ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_privacy')
      .setLabel(`${cfg.lblPrivateToggle}: ${state.turnPrivacy ? 'Private' : 'Public'}`)
      .setStyle(state.turnPrivacy ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_summary')
      .setLabel(cfg.btnSetSummary)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_tags')
      .setLabel(cfg.btnSetTags)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_status')
      .setLabel(isPaused ? '▶️ Resume Story' : '⏸️ Pause Story')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_save')
      .setLabel(cfg.btnAdminConfigSave)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('story_manage_cancel')
      .setLabel(cfg.btnCancel)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

async function handleManage(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, turn_length_hours, timeout_reminder_percent,
              max_writers, allow_joins, show_authors, story_order_type, summary, tags, story_turn_privacy
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
      'txtAdminConfigTitle', 'btnAdminConfigSave', 'btnCancel',
      'lblTurnLength', 'btnSetTurnLength',
      'lblTimeoutReminder', 'btnSetTimeout',
      'lblMaxWriters', 'btnSetMaxWriters',
      'lblOpenToWriters', 'lblShowAuthors',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'lblSummary', 'btnSetSummary',
      'lblTags', 'btnSetTags',
      'lblPrivateToggle'
    ], guildId);

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
      originalInteraction: interaction
    };

    pendingManageData.set(interaction.user.id, state);
    await interaction.editReply(buildManageMessage(cfg, state));

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
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_toggle_authors') {
    state.showAuthors = state.showAuthors ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_toggle_privacy') {
    state.turnPrivacy = state.turnPrivacy ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_cycle_order') {
    state.orderType = state.orderType === 3 ? 1 : state.orderType + 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_toggle_status') {
    state.targetStatus = state.targetStatus === 1 ? 2 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

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

  } else if (customId === 'story_manage_set_summary') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_summary_modal')
        .setTitle(state.cfg.lblSummary)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('summary')
              .setLabel(state.cfg.lblSummary)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setValue(state.summary)
              .setMaxLength(4000)
              .setPlaceholder('Enter a summary for this story (used in exports)')
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
    await connection.execute(
      `UPDATE story SET turn_length_hours = ?, timeout_reminder_percent = ?, max_writers = ?,
       allow_joins = ?, show_authors = ?, story_order_type = ?,
       story_turn_privacy = ?, summary = ?, tags = ? WHERE story_id = ?`,
      [
        state.turnLength, state.timeoutReminder, state.maxWriters ?? null,
        state.allowJoins, state.showAuthors, state.orderType,
        state.turnPrivacy, state.summary || null, state.tags || null,
        state.storyId
      ]
    );

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
    if (interaction.customId === 'story_manage_turnlength_modal') {
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

    } else if (interaction.customId === 'story_manage_summary_modal') {
      state.summary = sanitizeModalInput(interaction.fields.getTextInputValue('summary'), 4000, true) ?? '';

    } else if (interaction.customId === 'story_manage_tags_modal') {
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 500) ?? '';
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));
    await interaction.deleteReply();

  } catch (error) {
    log(`Error in handleManageModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

export {
  pendingManageData,
  buildManageMessage,
  handleManage,
  handleManageButton,
  handleManageSave,
  applyPauseActions,
  applyResumeActions,
  handleManageModalSubmit,
};
