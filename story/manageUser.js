import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId } from '../utilities.js';
import { PickNextWriter, NextTurn, deleteThreadAndAnnouncement, postStoryThreadActivity } from '../storybot.js';

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

function buildManageUserPanel(state) {
  log(`buildManageUserPanel: storyId=${state.storyId} targetUser=${state.targetUserId} writerStatus=${state.writerStatus}`, { show: false, guildName: state.guildName });
  const cfg = state.cfg;

  const statusLabel    = state.writerStatus === 1 ? cfg.txtMyStoryManageActiveStatus ?? 'Active' : cfg.txtMyStoryManagePausedStatus ?? 'Paused';
  const notifLabel     = state.notificationPrefs === 'dm' ? 'DM' : 'Mention in channel';
  const privacyLabel   = state.turnPrivacy ? 'Private' : 'Public';

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtManageUserPanelTitle, {
      writer_name: state.writerName,
      story_title: state.storyTitle
    }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblManageUserStatus  ?? 'Status',         value: statusLabel,              inline: true },
      { name: cfg.lblManageUserAO3     ?? 'AO3 Name',       value: state.ao3Name || '*Not set*', inline: true },
      { name: cfg.lblAdminMUNotif      ?? 'Notifications',  value: notifLabel,               inline: true },
      { name: cfg.lblAdminMUPrivacy    ?? 'Turn Privacy',   value: privacyLabel,             inline: true }
    )
    .setDescription('-# Changes are staged — click **Save Settings** to apply notifications/privacy. Status actions (Pause/Restore/Remove) apply immediately.');

  const notifToggleLabel   = state.notificationPrefs === 'dm' ? 'Switch to: Mention' : 'Switch to: DM';
  const privacyToggleLabel = state.turnPrivacy ? 'Make Public' : 'Make Private';

  const row1 = new ActionRowBuilder().addComponents(
    state.writerStatus === 1
      ? new ButtonBuilder().setCustomId('storyadmin_mu_pause').setLabel(cfg.btnAdminMUPause ?? '⏸️ Pause').setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId('storyadmin_mu_unpause').setLabel(cfg.btnAdminMUUnpause ?? '▶️ Restore').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('storyadmin_mu_remove').setLabel(cfg.btnAdminMURemove ?? 'Remove').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('storyadmin_mu_ao3name').setLabel(cfg.btnAdminMUAO3Name ?? 'Update Name').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_mu_toggle_notif').setLabel(notifToggleLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('storyadmin_mu_toggle_privacy').setLabel(privacyToggleLabel).setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_mu_save').setLabel(cfg.btnAdminMUSave ?? '✅ Save Settings').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('storyadmin_mu_close').setLabel(cfg.btnManageUserClose ?? 'Close').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

export async function handleManageUser(connection, interaction) {
  log(`handleManageUser: entry for user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  const targetUser = interaction.options.getUser('user');

  log(`handleManageUser: storyId=${storyId} targetUser=${targetUser?.id}`, { show: false, guildName: interaction?.guild?.name });

  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      log(`handleManageUser: story ${storyId} not found in guild ${guildId}`, { show: false, guildName: interaction?.guild?.name });
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];
    log(`handleManageUser: story found — "${story.title}"`, { show: false, guildName: interaction?.guild?.name });

    const [writerRows] = await connection.execute(
      `SELECT story_writer_id, sw_status, AO3_name, notification_prefs, turn_privacy
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (1, 2)`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      log(`handleManageUser: target user ${targetUser.id} is not an active writer in story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }
    const writer = writerRows[0];
    log(`handleManageUser: writer found — writerId=${writer.story_writer_id} status=${writer.sw_status} notif=${writer.notification_prefs} privacy=${writer.turn_privacy}`, { show: false, guildName: interaction?.guild?.name });

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, targetUser.id]
    );
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, targetUser.id]
    );
    log(`handleManageUser: activeTurn=${activeTurnRows.length > 0} remainingWriters=${remainingRows[0].count}`, { show: false, guildName: interaction?.guild?.name });

    const cfg = await getConfigValue(connection, [
      'txtManageUserPanelTitle', 'lblManageUserStatus', 'lblManageUserAO3',
      'lblAdminMUNotif', 'lblAdminMUPrivacy', 'btnManageUserClose',
      'btnAdminMUPause', 'btnAdminMUUnpause', 'btnAdminMURemove', 'btnAdminMUAO3Name',
      'btnAdminMUToggleNotif', 'btnAdminMUTogglePrivacy',
      'btnAdminMUSave', 'txtAdminMUSaved',
      'txtAdminMUPauseConfirmDesc', 'txtAdminMUActiveTurnWarning',
      'txtAdminMUUnpauseConfirmDesc', 'txtAdminMURemoveConfirmDesc',
      'txtAdminMULastWriterWarning', 'btnCancel',
      'txtMyStoryManageActiveStatus', 'txtMyStoryManagePausedStatus',
      'txtSelectionStaged'
    ], guildId);

    const isActiveTurn = activeTurnRows.length > 0;
    const writerName = targetUser.displayName || targetUser.username;

    const state = {
      action: null,
      storyId,
      guildId,
      guildName: interaction.guild.name,
      storyTitle: story.title,
      targetUserId: targetUser.id,
      writerId: writer.story_writer_id,
      writerName,
      writerStatus: writer.sw_status,
      ao3Name: writer.AO3_name,
      notificationPrefs: writer.notification_prefs,
      turnPrivacy: writer.turn_privacy,
      // Stage copies for save
      stagedNotificationPrefs: writer.notification_prefs,
      stagedTurnPrivacy: writer.turn_privacy,
      isActiveTurn,
      activeTurnId: isActiveTurn ? activeTurnRows[0].turn_id : null,
      activeTurnThreadId: isActiveTurn ? activeTurnRows[0].thread_id : null,
      isLastWriter: remainingRows[0].count === 0,
      originalInteraction: interaction,
      cfg
    };

    pendingManageUserData.set(interaction.user.id, state);
    log(`handleManageUser: panel built, sending reply`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageUserPanel(state));

  } catch (error) {
    log(`handleManageUser failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export async function handleManageUserButton(connection, interaction) {
  log(`handleManageUserButton: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  const customId = interaction.customId;

  if (customId === 'storyadmin_mu_close') {
    await interaction.deferUpdate();
    pendingManageUserData.delete(adminId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
    return;
  }

  if (!pending) {
    log(`handleManageUserButton: no pending session for user ${adminId}`, { show: false, guildName: interaction?.guild?.name });
    await interaction.deferUpdate();
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), embeds: [], components: [] });
  }

  if (customId === 'storyadmin_mu_toggle_notif') {
    await interaction.deferUpdate();
    pending.notificationPrefs = pending.notificationPrefs === 'dm' ? 'mention' : 'dm';
    log(`handleManageUserButton: toggled notif to ${pending.notificationPrefs}`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageUserPanel(pending));

  } else if (customId === 'storyadmin_mu_toggle_privacy') {
    await interaction.deferUpdate();
    pending.turnPrivacy = pending.turnPrivacy ? 0 : 1;
    log(`handleManageUserButton: toggled privacy to ${pending.turnPrivacy}`, { show: false, guildName: interaction?.guild?.name });
    await interaction.editReply(buildManageUserPanel(pending));

  } else if (customId === 'storyadmin_mu_save') {
    await interaction.deferUpdate();
    log(`handleManageUserButton: save initiated for writerId=${pending.writerId}`, { show: false, guildName: interaction?.guild?.name });
    try {
      await connection.execute(
        `UPDATE story_writer SET notification_prefs = ?, turn_privacy = ? WHERE story_writer_id = ?`,
        [pending.notificationPrefs, pending.turnPrivacy, pending.writerId]
      );
      await logAdminAction(connection, adminId, 'update_writer_settings', pending.storyId, pending.targetUserId);
      log(`handleManageUserButton: save complete`, { show: false, guildName: interaction?.guild?.name });
      const msg = replaceTemplateVariables(pending.cfg.txtAdminMUSaved ?? '✅ Writer settings saved.', {
        writer_name: pending.writerName,
        story_title: pending.storyTitle
      });
      pendingManageUserData.delete(adminId);
      await interaction.editReply({ content: msg, embeds: [], components: [] });
    } catch (err) {
      log(`handleManageUserButton save failed: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), embeds: [], components: [] });
    }

  } else if (customId === 'storyadmin_mu_pause') {
    pending.action = 'pause';
    await interaction.deferUpdate();
    log(`handleManageUserButton: showing pause confirm for ${pending.writerName}`, { show: false, guildName: interaction?.guild?.name });
    const description = replaceTemplateVariables(pending.cfg.txtAdminMUPauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('⏸️ Pause Writer?').setDescription(description).setColor(0xfee75c);
    if (pending.isActiveTurn) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUPause ?? '⏸️ Pause').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel ?? 'Cancel').setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_unpause') {
    pending.action = 'unpause';
    await interaction.deferUpdate();
    log(`handleManageUserButton: showing unpause confirm for ${pending.writerName}`, { show: false, guildName: interaction?.guild?.name });
    const description = replaceTemplateVariables(pending.cfg.txtAdminMUUnpauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('▶️ Restore to Rotation?').setDescription(description).setColor(0x57f287);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUUnpause ?? '▶️ Restore').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel ?? 'Cancel').setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_remove') {
    pending.action = 'remove';
    await interaction.deferUpdate();
    log(`handleManageUserButton: showing remove confirm for ${pending.writerName}`, { show: false, guildName: interaction?.guild?.name });
    const description = replaceTemplateVariables(pending.cfg.txtAdminMURemoveConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('⚠️ Remove Writer?').setDescription(description).setColor(0xed4245);
    if (pending.isActiveTurn) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }) });
    if (pending.isLastWriter) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMULastWriterWarning, { user_name: pending.writerName }) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMURemove ?? 'Remove').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel ?? 'Cancel').setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_ao3name') {
    log(`handleManageUserButton: showing AO3 name modal`, { show: false, guildName: interaction?.guild?.name });
    const modal = new ModalBuilder()
      .setCustomId('storyadmin_mu_ao3name_modal')
      .setTitle('Set AO3 Name')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ao3_name_input')
            .setLabel('AO3 Name')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Leave blank to clear')
            .setValue(pending.ao3Name ?? '')
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
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), embeds: [], components: [] });
  }

  pendingManageUserData.delete(adminId);
  const { action, storyId, guildId, targetUserId, writerId, writerName, storyTitle,
          isActiveTurn, activeTurnId, activeTurnThreadId, isLastWriter } = pending;

  try {
    if (action === 'pause') {
      log(`handleManageUserConfirm: pausing writer ${writerId}`, { show: false, guildName: interaction?.guild?.name });
      await connection.execute(`UPDATE story_writer SET sw_status = 2 WHERE story_writer_id = ?`, [writerId]);
      if (isActiveTurn) {
        await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurnId]);
        if (activeTurnThreadId) {
          try {
            const thread = await interaction.guild.channels.fetch(activeTurnThreadId);
            if (thread) await deleteThreadAndAnnouncement(thread);
          } catch (err) {
            log(`handleManageUserConfirm: could not delete thread on pause: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
        try {
          const nextWriterId = await PickNextWriter(connection, storyId);
          if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
        } catch (err) {
          log(`handleManageUserConfirm: could not advance turn after pause for story ${storyId}: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
      await logAdminAction(connection, adminId, 'pause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminPauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });

    } else if (action === 'unpause') {
      log(`handleManageUserConfirm: unpausing writer ${writerId}`, { show: false, guildName: interaction?.guild?.name });
      await connection.execute(`UPDATE story_writer SET sw_status = 1 WHERE story_writer_id = ?`, [writerId]);
      await logAdminAction(connection, adminId, 'unpause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminUnpauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });

    } else if (action === 'remove') {
      log(`handleManageUserConfirm: removing writer ${writerId} isActiveTurn=${isActiveTurn} isLastWriter=${isLastWriter}`, { show: false, guildName: interaction?.guild?.name });
      if (isActiveTurn) {
        await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurnId]);
        if (activeTurnThreadId) {
          try {
            const thread = await interaction.guild.channels.fetch(activeTurnThreadId);
            if (thread) await deleteThreadAndAnnouncement(thread);
          } catch (err) {
            log(`handleManageUserConfirm: could not delete thread on remove: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
      }
      await connection.execute(`UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_writer_id = ?`, [writerId]);
      if (isLastWriter) {
        await connection.execute(`UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`, [storyId]);
        log(`handleManageUserConfirm: story ${storyId} auto-closed — last writer removed`, { show: true, guildName: interaction?.guild?.name });
      } else if (isActiveTurn) {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      }
      await logAdminAction(connection, adminId, 'remove', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminKickSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      const closeNote = isLastWriter ? '\n⚠️ Story auto-closed — no writers remain.' : '';
      await interaction.editReply({ content: successMsg + closeNote, embeds: [], components: [] });

      getConfigValue(connection, 'txtStoryThreadWriterRemove', guildId).then(template =>
        postStoryThreadActivity(connection, interaction.guild, storyId, template.replace('[writer_name]', writerName))
      ).catch(() => {});
    }

  } catch (error) {
    log(`handleManageUserConfirm (${action}) failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), embeds: [], components: [] });
  }
}

async function handleManageUserCancel(connection, interaction) {
  await interaction.deferUpdate();
  const pending = pendingManageUserData.get(interaction.user.id);
  log(`handleManageUserCancel: user=${interaction.user.id} hasPending=${!!pending}`, { show: false, guildName: interaction?.guild?.name });
  if (!pending) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), embeds: [], components: [] });
  }
  pending.action = null;
  await interaction.editReply(buildManageUserPanel(pending));
}

export async function handleManageUserModalSubmit(connection, interaction) {
  log(`handleManageUserModalSubmit: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  if (!pending) {
    return await interaction.reply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
  try {
    const rawName = interaction.fields.getTextInputValue('ao3_name_input');
    const newName = sanitizeModalInput(rawName, 100) || null;
    log(`handleManageUserModalSubmit: new AO3 name="${newName}" for writerId=${pending.writerId}`, { show: false, guildName: interaction?.guild?.name });
    await connection.execute(`UPDATE story_writer SET AO3_name = ? WHERE story_writer_id = ?`, [newName, pending.writerId]);
    await logAdminAction(connection, adminId, 'ao3name', pending.storyId, pending.targetUserId, newName);
    pending.ao3Name = newName;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await pending.originalInteraction.editReply(buildManageUserPanel(pending));
    await interaction.deleteReply();
  } catch (error) {
    log(`handleManageUserModalSubmit failed for story ${pending?.storyId} guild ${pending?.guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

export { pendingManageUserData };
