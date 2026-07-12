import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId } from '../utilities.js';
import { PickNextWriter, NextTurn, endTurnGuarded, endTurnThread, departWriter } from '../story/_turn.js';
import { WRITER_STATUS, TURN_STATUS } from '../constants.js';

// Pending /mystory manage sessions keyed by user ID
export const pendingMyStoryManageData = new Map();

// ─── Panel builder ───────────────────────────────────────────────────────────

export function buildMyStoryManagePanel(state, cfg) {
  const statusLabel = state.writerStatus === WRITER_STATUS.ACTIVE
    ? cfg.txtMyStoryManageActiveStatus
    : cfg.txtMyStoryManagePausedStatus;

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtMyStoryManageTitle, { story_title: state.storyTitle }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblMyStoryManageStatus,  value: statusLabel,                                                      inline: true },
      { name: cfg.lblMyStoryManagePenName,  value: state.penName || cfg.txtNotSet,                                   inline: true },
      { name: cfg.lblMyStoryManageNotif,   value: state.notificationPrefs === 'dm' ? cfg.txtNotifDM : cfg.txtNotifMention, inline: true },
      { name: cfg.lblMyStoryManagePrivacy, value: state.writerTurnPrivacy ? cfg.txtPrivate : cfg.txtPublic,               inline: true }
    )
    .setDescription(cfg.txtMyStoryManagePanelDesc);

  const notifToggleLabel   = state.notificationPrefs === 'dm' ? cfg.btnManageUserSwitchMention : cfg.btnManageUserSwitchDM;
  const privacyToggleLabel = state.writerTurnPrivacy ? cfg.btnManageUserMakePublic : cfg.btnManageUserMakePrivate;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_penname').setLabel(cfg.btnAdminMUPenName).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_notif').setLabel(notifToggleLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_privacy').setLabel(privacyToggleLabel).setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_save').setLabel(cfg.btnMyStoryManageSave).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mystory_manage_cancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
  );

  const pauseResumeLabel = state.writerStatus === WRITER_STATUS.ACTIVE ? cfg.btnMyStoryManagePause : cfg.btnMyStoryManageResume;
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mystory_manage_pass')
      .setLabel(cfg.btnMyStoryManagePass)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state.hasActiveTurn),
    new ButtonBuilder()
      .setCustomId(state.writerStatus === WRITER_STATUS.ACTIVE ? 'mystory_manage_pause' : 'mystory_manage_resume')
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
      `SELECT story_writer_id, pen_name, notification_prefs, turn_privacy, sw_status
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (?, ?)`,
      [storyId, interaction.user.id, WRITER_STATUS.ACTIVE, WRITER_STATUS.PAUSED]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId) });
    }
    const writer = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = ?`,
      [storyId, interaction.user.id, TURN_STATUS.ACTIVE]
    );
    log(`handleMyStoryManage: writerStatus=${writer.sw_status} hasActiveTurn=${activeTurnRows.length > 0}`, { show: false, guildName: interaction?.guild?.name });

    const cfg = await getConfigValue(connection, [
      'txtMyStoryManageTitle', 'lblMyStoryManageStatus', 'lblMyStoryManagePenName', 'lblMyStoryManageNotif',
      'lblMyStoryManagePrivacy', 'btnMyStoryManageSave', 'btnCancel', 'btnAdminMUPenName',
      'btnMyStoryManagePause', 'btnMyStoryManageResume', 'btnMyStoryManagePass', 'btnMyStoryManageLeave',
      'txtMyStoryManageActiveStatus', 'txtMyStoryManagePausedStatus',
      'txtNotSet', 'txtNotifDM', 'txtNotifMention', 'txtPrivate', 'txtPublic',
      'txtMyStoryManagePanelDesc',
      'btnManageUserSwitchMention', 'btnManageUserSwitchDM',
      'btnManageUserMakePublic', 'btnManageUserMakePrivate',
      'lblJoinSetPenNameModalTitle', 'lblMyStoryManagePenName', 'txtAdminMUPenNamePlaceholder',
      'txtMyPauseConfirm', 'txtMyPassConfirm', 'btnMyPauseConfirm', 'btnMyPassConfirm', 'txtMyResumeSuccess',
    ], guildId);

    const state = {
      storyId,
      guildId,
      storyTitle: storyRows[0].title,
      storyWriterId: writer.story_writer_id,
      writerStatus: writer.sw_status,
      penName: writer.pen_name,
      notificationPrefs: writer.notification_prefs,
      writerTurnPrivacy: writer.turn_privacy,
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
    state.writerTurnPrivacy = !state.writerTurnPrivacy;
    await interaction.editReply(buildMyStoryManagePanel(state, state.cfg));

  } else if (customId === 'mystory_manage_penname') {
    const modal = new ModalBuilder()
      .setCustomId('mystory_manage_penname_modal')
      .setTitle(state.cfg.lblJoinSetPenNameModalTitle)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pen_name_input')
            .setLabel(state.cfg.lblMyStoryManagePenName)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(state.cfg.txtAdminMUPenNamePlaceholder)
            .setValue(state.penName ?? '')
        )
      );
    await interaction.showModal(modal);

  } else if (customId === 'mystory_manage_save') {
    await interaction.deferUpdate();
    try {
      await connection.execute(
        `UPDATE story_writer SET pen_name = ?, notification_prefs = ?, turn_privacy = ? WHERE story_writer_id = ?`,
        [state.penName, state.notificationPrefs, state.writerTurnPrivacy, state.storyWriterId]
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
        `UPDATE story_writer SET sw_status = ? WHERE story_writer_id = ?`,
        [WRITER_STATUS.ACTIVE, state.storyWriterId]
      );
      log(`${interaction.user.username} resumed in story ${state.storyId}`, { show: true, guildName: interaction?.guild?.name });
      state.writerStatus = WRITER_STATUS.ACTIVE;
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
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = ?`,
      [state.storyId, userId, TURN_STATUS.ACTIVE]
    );
    const [writerCountRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = ? AND discord_user_id != ?`,
      [state.storyId, WRITER_STATUS.ACTIVE, userId]
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
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = ?`,
      [storyId, userId, TURN_STATUS.ACTIVE]
    );
    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId), components: [] });
      return;
    }
    const turn = turnInfo[0];
    const ended = await endTurnGuarded(connection, turn.turn_id);
    if (!ended) {
      log(`handlePanelPassConfirm: turn ${turn.turn_id} already ended (race), no-op`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtWriteTurnEnded', guildId), components: [] });
      return;
    }
    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) {
      const turnResult = await NextTurn(connection, interaction, nextWriterId);
      if (!turnResult.success) {
        log(`handlePanelPassConfirm: NextTurn failed for story ${storyId} — story has no active turn: ${turnResult.error}`, { show: true, guildName: interaction?.guild?.name, hub: true });
      }
    } else {
      log(`handlePanelPassConfirm: no eligible next writer for story ${storyId} — story has no active turn`, { show: true, guildName: interaction?.guild?.name, hub: true });
    }
    if (turn.thread_id) {
      await endTurnThread(connection, interaction.guild, turn.thread_id, userId, guildId);
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
       WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = ?`,
      [storyId, guildId, userId, WRITER_STATUS.ACTIVE]
    );
    if (writerRows.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId), components: [] });
      return;
    }
    const story = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = ?`,
      [storyId, userId, TURN_STATUS.ACTIVE]
    );

    await connection.execute(`UPDATE story_writer SET sw_status = ? WHERE story_writer_id = ?`, [WRITER_STATUS.PAUSED, story.story_writer_id]);

    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      const ended = await endTurnGuarded(connection, activeTurn.turn_id);
      if (!ended) {
        log(`handlePanelPauseConfirm: turn ${activeTurn.turn_id} already ended (race), skipping thread cleanup/advance`, { show: true, guildName: interaction?.guild?.name });
      } else {
        if (activeTurn.thread_id) {
          await endTurnThread(connection, interaction.guild, activeTurn.thread_id, userId, guildId);
        }
        try {
          const nextWriterId = await PickNextWriter(connection, storyId);
          if (nextWriterId) {
            const turnResult = await NextTurn(connection, interaction, nextWriterId);
            if (!turnResult.success) {
              log(`handlePanelPauseConfirm: NextTurn failed for story ${storyId} — story has no active turn: ${turnResult.error}`, { show: true, guildName: interaction?.guild?.name, hub: true });
            }
          } else {
            log(`handlePanelPauseConfirm: no eligible next writer for story ${storyId} — story has no active turn`, { show: true, guildName: interaction?.guild?.name, hub: true });
          }
        } catch (err) {
          log(`handlePanelPauseConfirm: failed to advance turn: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
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
       WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status IN (?, ?)`,
      [storyId, guildId, userId, WRITER_STATUS.ACTIVE, WRITER_STATUS.PAUSED]
    );
    if (writerRows.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId), components: [] });
      return;
    }

    const { isLastWriter } = await departWriter(connection, interaction, storyId, writerRows[0].story_writer_id, userId);
    if (isLastWriter) {
      log(`Story ${storyId} auto-closed — last writer left via manage panel`, { show: true, guildName: interaction?.guild?.name });
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
    const rawName = interaction.fields.getTextInputValue('pen_name_input');
    const newName = sanitizeModalInput(rawName, 100) || null;
    state.penName = newName;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildMyStoryManagePanel(state, state.cfg));
    await interaction.deleteReply();
  } catch (error) {
    log(`handleMyStoryManageModal failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}
