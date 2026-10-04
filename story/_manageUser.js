import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId } from '../utilities.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, endTurnGuarded, endTurnThread, departWriter } from './_turn.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { buildWriterPanel } from './_writerPanel.js';
import { finalMessage } from './_metadataModals.js';
import { TURN_STATUS, WRITER_STATUS } from '../constants.js';

// Keyed by admin user ID
const pendingManageUserData = new Map();

async function logAdminAction(connection, adminUserId, actionType, storyId, targetUserId = null, reason = null) {
  try {
    await connection.execute(
      `INSERT INTO admin_action_log (admin_user_id, action_type, target_story_id, target_user_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [adminUserId, actionType, storyId ?? null, targetUserId ?? null, reason ?? null]
    );
  } catch (err) {
    log(`logAdminAction failed: ${err?.stack ?? err}`, { show: true });
  }
}

// The panel itself is shared with /mystory manage — see story/_writerPanel.js. Admin mode swaps
// the labels, the customId prefix and the bottom row; everything else is identical, which is the
// point: both panels stage the same three settings behind the same Save.
const buildManageUserPanel = (state) => buildWriterPanel(state, state.cfg, 'admin');

/**
 * Shared core: fetches writer data and shows the manage-user panel for a given story/writer
 * pair. Used by both /storyadmin user (direct slash command, storyId/targetUserId resolved
 * from options) and the /story manage panel's Manage Users button (two-step: pick a writer
 * from a modal, then this) — the management logic itself doesn't change between entry points.
 * writerDisplayName: optional pre-known display name (the panel-button path already has this
 * from the picker it just built, no Discord API call needed at this end); falls back to
 * story_writer's own stored discord_display_name if not given.
 */
export async function openManageUserPanel(connection, interaction, storyId, targetUserId, guildId, writerDisplayName = null) {
  log(`openManageUserPanel: entry storyId=${storyId} targetUserId=${targetUserId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      log(`openManageUserPanel: story ${storyId} not found in guild ${guildId}`, { show: false, guildName: interaction?.guild?.name });
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];
    log(`openManageUserPanel: story found — "${story.title}"`, { show: false, guildName: interaction?.guild?.name });

    const [writerRows] = await connection.execute(
      `SELECT story_writer_id, sw_status, pen_name, notification_prefs, turn_privacy, discord_display_name
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (?, ?)`,
      [storyId, targetUserId, WRITER_STATUS.ACTIVE, WRITER_STATUS.PAUSED]
    );
    if (writerRows.length === 0) {
      log(`openManageUserPanel: target user ${targetUserId} is not an active writer in story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: writerDisplayName ?? targetUserId }
        )
      });
    }
    const writer = writerRows[0];
    log(`openManageUserPanel: writer found — writerId=${writer.story_writer_id} status=${writer.sw_status} notif=${writer.notification_prefs} privacy=${writer.turn_privacy}`, { show: false, guildName: interaction?.guild?.name });

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = ?`,
      [storyId, targetUserId, TURN_STATUS.ACTIVE]
    );
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = ? AND discord_user_id != ?`,
      [storyId, WRITER_STATUS.ACTIVE, targetUserId]
    );
    log(`openManageUserPanel: activeTurn=${activeTurnRows.length > 0} remainingWriters=${remainingRows[0].count}`, { show: false, guildName: interaction?.guild?.name });

    const cfg = await getConfigValue(connection, [
      'txtManageUserPanelTitle', 'txtManageUserPanelSaveNote',
      'lblManageUserStatus', 'lblManageUserPenName',
      'lblAdminMUNotif', 'lblAdminMUPrivacy',
      'btnAdminMUPause', 'btnAdminMUUnpause', 'btnAdminMURemove', 'btnAdminMUPenName',
      'btnAdminMUSave', 'txtAdminMUSaved',
      'txtAdminMUPauseConfirmDesc', 'txtAdminMUActiveTurnWarning',
      'txtAdminMUUnpauseConfirmDesc', 'txtAdminMURemoveConfirmDesc',
      'txtAdminMULastWriterWarning', 'btnCancel',
      'txtMyStoryManageActiveStatus', 'txtMyStoryManagePausedStatus',
      'txtSelectionStaged',
      'txtNotifDM', 'txtNotifMention',
      'txtPrivate', 'txtPublic', 'txtNotSet',
      'btnManageUserSwitchMention', 'btnManageUserSwitchDM',
      'btnManageUserMakePublic', 'btnManageUserMakePrivate',
      'txtAdminMUPauseConfirmTitle', 'txtAdminMUUnpauseConfirmTitle',
      'txtAdminMURemoveConfirmTitle', 'txtAdminRemoveAutoClose',
      'lblJoinSetPenNameModalTitle', 'txtAdminMUPenNamePlaceholder',
    ], guildId);

    const isActiveTurn = activeTurnRows.length > 0;
    const writerName = writerDisplayName ?? writer.discord_display_name ?? targetUserId;

    const state = {
      action: null,
      storyId,
      guildId,
      guildName: interaction.guild.name,
      storyTitle: story.title,
      targetUserId,
      writerId: writer.story_writer_id,
      writerName,
      writerStatus: writer.sw_status,
      penName: writer.pen_name,
      notificationPrefs: writer.notification_prefs,
      writerTurnPrivacy: writer.turn_privacy,
      isActiveTurn,
      activeTurnId: isActiveTurn ? activeTurnRows[0].turn_id : null,
      activeTurnThreadId: isActiveTurn ? activeTurnRows[0].thread_id : null,
      isLastWriter: remainingRows[0].count === 0,
      originalInteraction: interaction,
      cfg
    };

    pendingManageUserData.set(interaction.user.id, state);
    log(`openManageUserPanel: panel built, sending reply`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageUserPanel(state));

  } catch (error) {
    log(`openManageUserPanel failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export async function handleManageUser(connection, interaction) {
  log(`handleManageUser: entry for user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));
  const targetUser = interaction.options.getUser('user');

  log(`handleManageUser: storyId=${storyId} targetUser=${targetUser?.username}`, { show: false, guildName: interaction?.guild?.name });

  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  await openManageUserPanel(connection, interaction, storyId, targetUser.id, guildId, targetUser.displayName || targetUser.username);
}

export async function handleManageUserButton(connection, interaction) {
  log(`handleManageUserButton: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  const customId = interaction.customId;

  if (!pending) {
    log(`handleManageUserButton: no pending session for user ${adminId}`, { show: false, guildName: interaction?.guild?.name });
    await interaction.deferUpdate();
    return await interaction.editReply(finalMessage(await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id)));
  }

  if (customId === 'storyadmin_mu_toggle_notif') {
    await interaction.deferUpdate();
    pending.notificationPrefs = pending.notificationPrefs === 'dm' ? 'mention' : 'dm';
    log(`handleManageUserButton: toggled notif to ${pending.notificationPrefs}`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageUserPanel(pending));

  } else if (customId === 'storyadmin_mu_toggle_privacy') {
    await interaction.deferUpdate();
    pending.writerTurnPrivacy = pending.writerTurnPrivacy ? 0 : 1;
    log(`handleManageUserButton: toggled privacy to ${pending.writerTurnPrivacy}`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageUserPanel(pending));

  } else if (customId === 'storyadmin_mu_save') {
    await interaction.deferUpdate();
    log(`handleManageUserButton: save initiated for writerId=${pending.writerId}`, { show: false, guildName: interaction?.guild?.name });
    try {
      await connection.execute(
        `UPDATE story_writer SET pen_name = ?, notification_prefs = ?, turn_privacy = ? WHERE story_writer_id = ?`,
        [pending.penName, pending.notificationPrefs, pending.writerTurnPrivacy, pending.writerId]
      );
      await logAdminAction(connection, adminId, 'update_writer_settings', pending.storyId, pending.targetUserId);
      log(`handleManageUserButton: save complete`, { show: false, guildName: interaction?.guild?.name });
      const msg = replaceTemplateVariables(pending.cfg.txtAdminMUSaved ?? '✅ Writer settings saved.', {
        writer_name: pending.writerName,
        story_title: pending.storyTitle
      });
      pendingManageUserData.delete(adminId);
      await interaction.editReply(finalMessage(msg));
    } catch (err) {
      log(`handleManageUserButton save failed: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply(finalMessage(await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id)));
    }

  } else if (customId === 'storyadmin_mu_pause') {
    pending.action = 'pause';
    await interaction.deferUpdate();
    log(`handleManageUserButton: showing pause confirm for ${pending.writerName}`, { show: false, guildName: interaction?.guild?.name });
    const parts = [
      `## ${pending.cfg.txtAdminMUPauseConfirmTitle}`,
      replaceTemplateVariables(pending.cfg.txtAdminMUPauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle }),
    ];
    if (pending.isActiveTurn) parts.push(replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUPause).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply(finalMessage(parts.join('\n\n'), [row]));

  } else if (customId === 'storyadmin_mu_unpause') {
    pending.action = 'unpause';
    await interaction.deferUpdate();
    log(`handleManageUserButton: showing unpause confirm for ${pending.writerName}`, { show: false, guildName: interaction?.guild?.name });
    const parts = [
      `## ${pending.cfg.txtAdminMUUnpauseConfirmTitle}`,
      replaceTemplateVariables(pending.cfg.txtAdminMUUnpauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle }),
    ];
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUUnpause).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply(finalMessage(parts.join('\n\n'), [row]));

  } else if (customId === 'storyadmin_mu_remove') {
    pending.action = 'remove';
    await interaction.deferUpdate();
    log(`handleManageUserButton: showing remove confirm for ${pending.writerName}`, { show: false, guildName: interaction?.guild?.name });
    const parts = [
      `## ${pending.cfg.txtAdminMURemoveConfirmTitle}`,
      replaceTemplateVariables(pending.cfg.txtAdminMURemoveConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle }),
    ];
    if (pending.isActiveTurn) parts.push(replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }));
    if (pending.isLastWriter) parts.push(replaceTemplateVariables(pending.cfg.txtAdminMULastWriterWarning, { user_name: pending.writerName }));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMURemove).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply(finalMessage(parts.join('\n\n'), [row]));

  } else if (customId === 'storyadmin_mu_penname') {
    log(`handleManageUserButton: showing pen name modal`, { show: false, guildName: interaction?.guild?.name });
    const modal = new ModalBuilder()
      .setCustomId('storyadmin_mu_penname_modal')
      .setTitle(pending.cfg.lblJoinSetPenNameModalTitle)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pen_name_input')
            .setLabel(pending.cfg.lblManageUserPenName)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(pending.cfg.txtAdminMUPenNamePlaceholder)
            .setValue(pending.penName ?? '')
        )
      );
    await interaction.showModal(modal);

  } else if (customId.startsWith('storyadmin_mu_confirm_')) {
    await handleManageUserConfirm(connection, interaction);

  } else if (customId.startsWith('storyadmin_mu_cancel_')) {
    await handleManageUserCancel(connection, interaction);
  }
}

async function handleManageUserConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  log(`handleManageUserConfirm: action=${pending?.action} for story ${pending?.storyId}`, { show: false, guildName: interaction?.guild?.name });

  if (!pending) {
    return await interaction.editReply(finalMessage(await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id)));
  }

  pendingManageUserData.delete(adminId);
  const { action, storyId, guildId, targetUserId, writerId, writerName, storyTitle,
          isActiveTurn, activeTurnId, activeTurnThreadId, isLastWriter } = pending;

  try {
    if (action === 'pause') {
      log(`handleManageUserConfirm: pausing writer ${writerId}`, { show: false, guildName: interaction?.guild?.name });
      await connection.execute(`UPDATE story_writer SET sw_status = ? WHERE story_writer_id = ?`, [WRITER_STATUS.PAUSED, writerId]);
      let pauseStatusRefreshed = false;
      if (isActiveTurn) {
        const ended = await endTurnGuarded(connection, activeTurnId);
        if (!ended) {
          log(`handleManageUserConfirm: pause — turn ${activeTurnId} already ended (race), skipping thread cleanup/advance`, { show: true, guildName: interaction?.guild?.name });
        } else {
          if (activeTurnThreadId) {
            await endTurnThread(connection, interaction.guild, activeTurnThreadId, targetUserId, guildId);
          }
          try {
            const nextWriterId = await PickNextWriter(connection, storyId);
            if (nextWriterId) {
              const turnResult = await NextTurn(connection, interaction, nextWriterId);
              if (turnResult.success) {
                pauseStatusRefreshed = true;
              } else {
                log(`handleManageUserConfirm: NextTurn failed after pause for story ${storyId} — story has no active turn: ${turnResult.error}`, { show: true, guildName: interaction?.guild?.name, hub: true });
              }
            } else {
              log(`handleManageUserConfirm: no eligible next writer after pause for story ${storyId} — story has no active turn`, { show: true, guildName: interaction?.guild?.name, hub: true });
            }
          } catch (err) {
            log(`handleManageUserConfirm: could not advance turn after pause for story ${storyId}: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
      }
      if (!pauseStatusRefreshed) {
        await updateStoryStatusMessage(connection, interaction.guild, storyId).catch(err =>
          log(`handleManageUserConfirm: status message update failed after pause for story ${storyId}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name })
        );
      }
      await logAdminAction(connection, adminId, 'pause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminPauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply(finalMessage(successMsg));

    } else if (action === 'unpause') {
      log(`handleManageUserConfirm: unpausing writer ${writerId}`, { show: false, guildName: interaction?.guild?.name });
      await connection.execute(`UPDATE story_writer SET sw_status = ? WHERE story_writer_id = ?`, [WRITER_STATUS.ACTIVE, writerId]);
      await updateStoryStatusMessage(connection, interaction.guild, storyId).catch(err =>
        log(`handleManageUserConfirm: status message update failed after unpause for story ${storyId}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name })
      );
      await logAdminAction(connection, adminId, 'unpause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminUnpauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply(finalMessage(successMsg));

    } else if (action === 'remove') {
      log(`handleManageUserConfirm: removing writer ${writerId} isActiveTurn=${isActiveTurn} isLastWriter=${isLastWriter}`, { show: false, guildName: interaction?.guild?.name });
      const { isLastWriter: closedStory } = await departWriter(connection, interaction, storyId, writerId, targetUserId);
      if (closedStory) {
        log(`handleManageUserConfirm: story ${storyId} auto-closed — last writer removed`, { show: true, guildName: interaction?.guild?.name });
      }
      await logAdminAction(connection, adminId, 'remove', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminKickSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      const closeNote = closedStory ? '\n' + await getConfigValue(connection, 'txtAdminRemoveAutoClose', guildId) : '';
      await interaction.editReply(finalMessage(successMsg + closeNote));

      getConfigValue(connection, 'txtStoryThreadWriterRemove', guildId).then(template =>
        postStoryThreadActivity(connection, interaction.guild, storyId, replaceTemplateVariables(template, { writer_name: writerName }))
      ).catch(err => log(`postStoryThreadActivity failed after remove for story ${storyId}: ${err}`, { show: true, guildName: interaction?.guild?.name }));
    }

  } catch (error) {
    log(`handleManageUserConfirm (${action}) failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply(finalMessage(await getConfigValue(connection, 'errProcessingRequest', guildId)));
  }
}

async function handleManageUserCancel(connection, interaction) {
  await interaction.deferUpdate();
  const pending = pendingManageUserData.get(interaction.user.id);
  log(`handleManageUserCancel: user=${interaction.user.username} hasPending=${!!pending}`, { show: false, guildName: interaction?.guild?.name });
  if (!pending) {
    return await interaction.editReply(finalMessage(await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id)));
  }
  pending.action = null;
  await interaction.editReply(buildManageUserPanel(pending));
}

export async function handleManageUserModalSubmit(connection, interaction) {
  log(`handleManageUserModalSubmit: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  if (!pending) {
    return await interaction.reply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
  try {
    const rawName = interaction.fields.getTextInputValue('pen_name_input');
    const newName = sanitizeModalInput(rawName, 100) || null;
    // Staged, not written immediately — same as the Notifications/Turn Privacy toggles below,
    // committed together on storyadmin_mu_save. Pen Name used to save on modal submit directly,
    // which the panel's own note text never actually described correctly.
    log(`handleManageUserModalSubmit: staged pen name="${newName}" for writerId=${pending.writerId}`, { show: false, guildName: interaction?.guild?.name });
    pending.penName = newName;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await pending.originalInteraction.editReply(buildManageUserPanel(pending));
    await interaction.deleteReply();
  } catch (error) {
    log(`handleManageUserModalSubmit failed for story ${pending?.storyId} guild ${pending?.guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

export { pendingManageUserData };
