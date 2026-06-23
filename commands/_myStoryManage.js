import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId } from '../utilities.js';
import { PickNextWriter, NextTurn, deleteThreadAndAnnouncement } from '../story/_turn.js';

// Pending /mystory manage sessions keyed by user ID
export const pendingMyStoryManageData = new Map();

// ─── Panel builder ───────────────────────────────────────────────────────────

export function buildMyStoryManagePanel(state, cfg) {
  const statusLabel = state.writerStatus === 1
    ? cfg.txtMyStoryManageActiveStatus
    : cfg.txtMyStoryManagePausedStatus;

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtMyStoryManageTitle, { story_title: state.storyTitle }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblMyStoryManageStatus,  value: statusLabel,                                                      inline: true },
      { name: cfg.lblMyStoryManageAO3,     value: state.ao3Name || cfg.txtNotSet,                                   inline: true },
      { name: cfg.lblMyStoryManageNotif,   value: state.notificationPrefs === 'dm' ? cfg.txtNotifDM : cfg.txtNotifMention, inline: true },
      { name: cfg.lblMyStoryManagePrivacy, value: state.turnPrivacy ? cfg.txtPrivate : cfg.txtPublic,               inline: true }
    )
    .setDescription(cfg.txtMyStoryManagePanelDesc);

  const notifToggleLabel   = state.notificationPrefs === 'dm' ? cfg.btnManageUserSwitchMention : cfg.btnManageUserSwitchDM;
  const privacyToggleLabel = state.turnPrivacy ? cfg.btnManageUserMakePublic : cfg.btnManageUserMakePrivate;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_ao3').setLabel(cfg.btnAdminMUAO3Name).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_notif').setLabel(notifToggleLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_privacy').setLabel(privacyToggleLabel).setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_save').setLabel(cfg.btnMyStoryManageSave).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mystory_manage_cancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
  );

  const pauseResumeLabel = state.writerStatus === 1 ? cfg.btnMyStoryManagePause : cfg.btnMyStoryManageResume;
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mystory_manage_pass')
      .setLabel(cfg.btnMyStoryManagePass)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state.hasActiveTurn),
    new ButtonBuilder()
      .setCustomId(state.writerStatus === 1 ? 'mystory_manage_pause' : 'mystory_manage_resume')
      .setLabel(pauseResumeLabel)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mystory_manage_leave')
      .setLabel(cfg.btnMyStoryManageLeave)
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

// ─── /mystory manage ─────────────────────────────────────────────────────────

export async function handleMyStoryManage(connection, interaction) {
  log(`handleMyStoryManage: entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));

  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    const [writerRows] = await connection.execute(
      `SELECT story_writer_id, AO3_name, notification_prefs, turn_privacy, sw_status
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (1, 2)`,
      [storyId, interaction.user.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId) });
    }
    const writer = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, interaction.user.id]
    );
    log(`handleMyStoryManage: writerStatus=${writer.sw_status} hasActiveTurn=${activeTurnRows.length > 0}`, { show: false, guildName: interaction?.guild?.name });

    const cfg = await getConfigValue(connection, [
      'txtMyStoryManageTitle', 'lblMyStoryManageStatus', 'lblMyStoryManageAO3', 'lblMyStoryManageNotif',
      'lblMyStoryManagePrivacy', 'btnMyStoryManageSave', 'btnCancel', 'btnAdminMUAO3Name',
      'btnMyStoryManagePause', 'btnMyStoryManageResume', 'btnMyStoryManagePass', 'btnMyStoryManageLeave',
      'txtMyStoryManageActiveStatus', 'txtMyStoryManagePausedStatus',
      'txtNotSet', 'txtNotifDM', 'txtNotifMention', 'txtPrivate', 'txtPublic',
      'txtMyStoryManagePanelDesc',
      'btnManageUserSwitchMention', 'btnManageUserSwitchDM',
      'btnManageUserMakePublic', 'btnManageUserMakePrivate',
      'lblJoinSetAO3ModalTitle', 'lblMyStoryManageAO3', 'txtAdminMUAO3Placeholder',
      'txtMyPauseConfirm', 'txtMyPassConfirm', 'btnMyPauseConfirm', 'btnMyPassConfirm', 'txtMyResumeSuccess',
    ], guildId);

    const state = {
      storyId,
      guildId,
      storyTitle: storyRows[0].title,
      storyWriterId: writer.story_writer_id,
      writerStatus: writer.sw_status,
      ao3Name: writer.AO3_name,
      notificationPrefs: writer.notification_prefs,
      turnPrivacy: writer.turn_privacy,
      hasActiveTurn: activeTurnRows.length > 0,
      originalInteraction: interaction,
      cfg
    };

    pendingMyStoryManageData.set(interaction.user.id, state);
    await interaction.editReply(buildMyStoryManagePanel(state, cfg));

  } catch (error) {
    log(`handleMyStoryManage failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export async function handleMyStoryManageButton(connection, interaction) {
  log(`handleMyStoryManageButton: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const userId = interaction.user.id;
  const state = pendingMyStoryManageData.get(userId);
  const customId = interaction.customId;

  if (!state) {
    await interaction.deferUpdate();
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), embeds: [], components: [] });
  }

  if (customId === 'mystory_manage_notif') {
    await interaction.deferUpdate();
    state.notificationPrefs = state.notificationPrefs === 'dm' ? 'mention' : 'dm';
    await interaction.editReply(buildMyStoryManagePanel(state, state.cfg));

  } else if (customId === 'mystory_manage_privacy') {
    await interaction.deferUpdate();
    state.turnPrivacy = state.turnPrivacy ? 0 : 1;
    await interaction.editReply(buildMyStoryManagePanel(state, state.cfg));

  } else if (customId === 'mystory_manage_ao3') {
    const modal = new ModalBuilder()
      .setCustomId('mystory_manage_ao3_modal')
      .setTitle(state.cfg.lblJoinSetAO3ModalTitle)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ao3_name_input')
            .setLabel(state.cfg.lblMyStoryManageAO3)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(state.cfg.txtAdminMUAO3Placeholder)
            .setValue(state.ao3Name ?? '')
        )
      );
    await interaction.showModal(modal);

  } else if (customId === 'mystory_manage_save') {
    await interaction.deferUpdate();
    try {
      await connection.execute(
        `UPDATE story_writer SET AO3_name = ?, notification_prefs = ?, turn_privacy = ? WHERE story_writer_id = ?`,
        [state.ao3Name, state.notificationPrefs, state.turnPrivacy, state.storyWriterId]
      );
      log(`mystory manage saved for writer ${state.storyWriterId} in story ${state.storyId}`, { show: true, guildName: interaction?.guild?.name });
      pendingMyStoryManageData.delete(userId);
      await interaction.editReply({ content: await getConfigValue(connection, 'txtMyStoryManageSaved', state.guildId), embeds: [], components: [] });
    } catch (error) {
      log(`mystory manage save failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', state.guildId), embeds: [], components: [] });
    }

  } else if (customId === 'mystory_manage_cancel') {
    await interaction.deferUpdate();
    pendingMyStoryManageData.delete(userId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });

  } else if (customId === 'mystory_manage_pass') {
    await interaction.deferUpdate();
    const cfg = state.cfg;
    const confirmMsg = replaceTemplateVariables(cfg.txtMyPassConfirm, { story_title: state.storyTitle });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mystory_manage_pass_confirm_${state.storyId}`).setLabel(cfg.btnMyPassConfirm).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mystory_manage_pass_cancel_${state.storyId}`).setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ content: confirmMsg, embeds: [], components: [row] });

  } else if (customId === 'mystory_manage_pause') {
    await interaction.deferUpdate();
    const cfg = state.cfg;
    const confirmMsg = replaceTemplateVariables(cfg.txtMyPauseConfirm, { story_title: state.storyTitle });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mystory_manage_pause_confirm_${state.storyId}`).setLabel(cfg.btnMyPauseConfirm).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mystory_manage_pause_cancel_${state.storyId}`).setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ content: confirmMsg, embeds: [], components: [row] });

  } else if (customId === 'mystory_manage_resume') {
    await interaction.deferUpdate();
    try {
      await connection.execute(
        `UPDATE story_writer SET sw_status = 1 WHERE story_writer_id = ?`,
        [state.storyWriterId]
      );
      log(`${interaction.user.username} resumed in story ${state.storyId}`, { show: true, guildName: interaction?.guild?.name });
      state.writerStatus = 1;
      pendingMyStoryManageData.delete(userId);
      const successMsg = replaceTemplateVariables(state.cfg.txtMyResumeSuccess, { story_title: state.storyTitle });
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });
    } catch (error) {
      log(`mystory manage resume failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', state.guildId), embeds: [], components: [] });
    }

  } else if (customId === 'mystory_manage_leave') {
    await interaction.deferUpdate();
    const cfg = state.cfg;
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [state.storyId, userId]
    );
    const [writerCountRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [state.storyId, userId]
    );
    const isMyTurn = activeTurnRows.length > 0;
    const isLastWriter = writerCountRows[0].count === 0;

    let confirmKey;
    if (isLastWriter) confirmKey = 'txtLeaveConfirmLastWriter';
    else if (isMyTurn) confirmKey = 'txtLeaveConfirmMyTurn';
    else confirmKey = 'txtLeaveConfirm';

    const [confirmMsg, btnLeaveStory, btnCancel] = await Promise.all([
      getConfigValue(connection, confirmKey, state.guildId),
      getConfigValue(connection, 'btnLeaveStory', state.guildId),
      getConfigValue(connection, 'btnCancel', state.guildId)
    ]);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mystory_manage_leave_confirm_${state.storyId}`).setLabel(btnLeaveStory).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mystory_manage_leave_cancel_${state.storyId}`).setLabel(btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ content: replaceTemplateVariables(confirmMsg, { story_title: state.storyTitle }), embeds: [], components: [row] });
  }
}

export async function handlePanelPassConfirm(connection, interaction) {
  log(`handlePanelPassConfirm: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );
    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId), components: [] });
      return;
    }
    const turn = turnInfo[0];
    await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [turn.turn_id]);
    const nextWriterId = await PickNextWriter(connection, storyId);
    await NextTurn(connection, interaction, nextWriterId);
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        if (thread) await thread.delete('Turn passed from manage panel');
      } catch (err) {
        log(`handlePanelPassConfirm: failed to delete thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }
    pendingMyStoryManageData.delete(userId);
    log(`${interaction.user.username} passed turn in story ${storyId} via manage panel`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtMyPassSuccess', guildId), embeds: [], components: [] });
  } catch (error) {
    log(`handlePanelPassConfirm failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export async function handlePanelPauseConfirm(connection, interaction) {
  log(`handlePanelPauseConfirm: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [writerRows] = await connection.execute(
      `SELECT sw.story_writer_id, s.title, s.guild_story_id FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1`,
      [storyId, guildId, userId]
    );
    if (writerRows.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId), components: [] });
      return;
    }
    const story = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );

    await connection.execute(`UPDATE story_writer SET sw_status = 2 WHERE story_writer_id = ?`, [story.story_writer_id]);

    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurn.turn_id]);
      if (activeTurn.thread_id) {
        try {
          const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
          if (thread) await thread.delete('Writer paused — turn passed');
        } catch (err) {
          log(`handlePanelPauseConfirm: failed to delete thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
      try {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      } catch (err) {
        log(`handlePanelPauseConfirm: failed to advance turn: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

    pendingMyStoryManageData.delete(userId);
    log(`${interaction.user.username} paused in story ${storyId} via manage panel`, { show: true, guildName: interaction?.guild?.name });
    const storyTitle = `${story.title} (#${story.guild_story_id})`;
    const successMsg = replaceTemplateVariables(await getConfigValue(connection, 'txtMyPauseSuccess', guildId), { story_title: storyTitle });
    await interaction.editReply({ content: successMsg, embeds: [], components: [] });
  } catch (error) {
    log(`handlePanelPauseConfirm failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export async function handlePanelLeaveConfirm(connection, interaction) {
  log(`handlePanelLeaveConfirm: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [writerRows] = await connection.execute(
      `SELECT sw.story_writer_id FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status IN (1, 2)`,
      [storyId, guildId, userId]
    );
    if (writerRows.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId), components: [] });
      return;
    }

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, userId]
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
          log(`handlePanelLeaveConfirm: failed to delete thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
    }

    await connection.execute(`UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_id = ? AND discord_user_id = ?`, [storyId, userId]);

    if (isLastWriter) {
      await connection.execute(`UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`, [storyId]);
      log(`Story ${storyId} auto-closed — last writer left via manage panel`, { show: true, guildName: interaction?.guild?.name });
    } else if (activeTurnRows.length > 0) {
      try {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      } catch (err) {
        log(`handlePanelLeaveConfirm: failed to advance turn: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

    pendingMyStoryManageData.delete(userId);
    log(`${interaction.user.username} left story ${storyId} via manage panel`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtLeftStorySuccess', guildId), embeds: [], components: [] });
  } catch (error) {
    log(`handlePanelLeaveConfirm failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export async function handlePanelActionCancel(connection, interaction) {
  log(`handlePanelActionCancel: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const state = pendingMyStoryManageData.get(userId);
  if (state) {
    await interaction.editReply(buildMyStoryManagePanel(state, state.cfg));
  } else {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
  }
}

export async function handleMyStoryManageModal(connection, interaction) {
  log(`handleMyStoryManageModal: entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const userId = interaction.user.id;
  const state = pendingMyStoryManageData.get(userId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const rawName = interaction.fields.getTextInputValue('ao3_name_input');
    const newName = sanitizeModalInput(rawName, 100) || null;
    state.ao3Name = newName;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildMyStoryManagePanel(state, state.cfg));
    await interaction.deleteReply();
  } catch (error) {
    log(`handleMyStoryManageModal failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}
