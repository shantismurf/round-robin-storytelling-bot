import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from '../utilities.js';
import { PickNextWriter, NextTurn, skipActiveTurn } from '../storybot.js';

// Keyed by admin user ID — holds context for the pending turn action
const pendingTurnActionData = new Map();

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

// Build the standalone Turn Actions ephemeral panel (opened via Manage Turns button).
export function buildTurnActionsPanel(state, activeTurn, cfg) {
  log(`buildTurnActionsPanel: storyId=${state.storyId} activeTurn=${!!activeTurn}`, { show: false, guildName: state.guildName });

  const activeDesc = activeTurn
    ? replaceTemplateVariables(cfg.txtManageTurnsActiveTurn, {
        writer_name: activeTurn.discord_display_name,
        turn_ends_unix: activeTurn.turn_ends_unix ?? ''
      })
    : cfg.txtManageTurnsNoTurn;

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtManageTurnsPanelTitle, { story_title: state.title }))
    .setDescription(activeDesc)
    .setColor(0x5865f2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('story_manage_ta_skip').setLabel(cfg.btnTurnSkip).setStyle(ButtonStyle.Danger).setDisabled(!activeTurn),
    new ButtonBuilder().setCustomId('story_manage_ta_extend').setLabel(cfg.btnTurnExtend).setStyle(ButtonStyle.Secondary).setDisabled(!activeTurn),
    new ButtonBuilder().setCustomId('story_manage_ta_next').setLabel(cfg.btnTurnNext).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('story_manage_ta_reassign').setLabel(cfg.btnTurnReassign).setStyle(ButtonStyle.Secondary).setDisabled(!activeTurn)
  );

  return { embeds: [embed], components: [row1], flags: MessageFlags.Ephemeral };
}

export async function handleTurnActionButton(connection, interaction, manageState) {
  const customId = interaction.customId;
  const adminId = interaction.user.id;
  const guildId = interaction.guild.id;
  const storyId = manageState.storyId;
  log(`handleTurnActionButton: customId=${customId} storyId=${storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  try {
    if (customId === 'story_manage_ta_skip') {
    log(`handleTurnActionButton: skip — fetching active turn for story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_display_name
       FROM turn t JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      log(`handleTurnActionButton: skip — no active turn`, { show: false, guildName: interaction?.guild?.name });
      return await interaction.reply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId), flags: MessageFlags.Ephemeral });
    }
    const activeTurn = activeTurnRows[0];
    const cfg = await getConfigValue(connection, ['txtTurnSkipConfirm', 'btnTurnSkip', 'btnCancel'], guildId);
    const msg = replaceTemplateVariables(cfg.txtTurnSkipConfirm, { writer_name: activeTurn.discord_display_name, story_title: manageState.title });
    pendingTurnActionData.set(adminId, { action: 'skip', storyId, guildId, activeTurn });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('story_manage_ta_confirm').setLabel(cfg.btnTurnSkip).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('story_manage_ta_confirmcancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ content: msg, components: [row], flags: MessageFlags.Ephemeral });

  } else if (customId === 'story_manage_ta_extend') {
    log(`handleTurnActionButton: extend — showing modal`, { show: false, guildName: interaction?.guild?.name });
    const cfg = await getConfigValue(connection, ['txtTurnExtendModalTitle', 'lblTurnExtendHours', 'txtTurnExtendPlaceholder'], guildId);
    const modal = new ModalBuilder()
      .setCustomId('story_manage_ta_extend_modal')
      .setTitle(cfg.txtTurnExtendModalTitle)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('extend_hours')
          .setLabel(cfg.lblTurnExtendHours)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(cfg.txtTurnExtendPlaceholder)
      ));
    pendingTurnActionData.set(adminId, { action: 'extend', storyId, guildId });
    await interaction.showModal(modal);

  } else if (customId === 'story_manage_ta_next') {
    log(`handleTurnActionButton: next — fetching active writers for story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
    const [writers] = await connection.execute(
      `SELECT sw.story_writer_id, sw.discord_user_id, sw.discord_display_name
       FROM story_writer sw WHERE sw.story_id = ? AND sw.sw_status = 1
       ORDER BY sw.discord_display_name ASC LIMIT 25`,
      [storyId]
    );
    if (writers.length === 0) {
      return await interaction.reply({ content: await getConfigValue(connection, 'txtAdminKickNotWriter', guildId), flags: MessageFlags.Ephemeral });
    }
    log(`handleTurnActionButton: next — ${writers.length} active writers found`, { show: false, guildName: interaction?.guild?.name });
    const cfg = await getConfigValue(connection, ['txtTurnNextSelectWrite', 'btnCancel'], guildId);
    const select = new StringSelectMenuBuilder()
      .setCustomId('story_manage_ta_next_select')
      .setPlaceholder('Select the next writer...')
      .addOptions(writers.map(w => ({ label: w.discord_display_name.slice(0, 100), value: String(w.story_writer_id) })));
    pendingTurnActionData.set(adminId, { action: 'next', storyId, guildId, writers });
    await interaction.reply({
      content: cfg.txtTurnNextSelectWrite,
      components: [new ActionRowBuilder().addComponents(select)],
      flags: MessageFlags.Ephemeral
    });

  } else if (customId === 'story_manage_ta_reassign') {
    log(`handleTurnActionButton: reassign — fetching previous writer for story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
    const [prevRows] = await connection.execute(
      `SELECT sw.story_writer_id, sw.discord_display_name
       FROM turn t JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 0
       ORDER BY t.ended_at DESC LIMIT 1`,
      [storyId]
    );
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_display_name as current_writer_name
       FROM turn t JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.reply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId), flags: MessageFlags.Ephemeral });
    }
    if (prevRows.length === 0) {
      return await interaction.reply({ content: await getConfigValue(connection, 'txtAdminReassignNoPreviousWriter', guildId), flags: MessageFlags.Ephemeral });
    }
    const activeTurn = activeTurnRows[0];
    const prevWriter = prevRows[0];
    log(`handleTurnActionButton: reassign — prevWriter="${prevWriter.discord_display_name}" currentWriter="${activeTurn.current_writer_name}"`, { show: false, guildName: interaction?.guild?.name });
    const cfg = await getConfigValue(connection, ['txtTurnReassignConfirm', 'btnTurnReassign', 'btnCancel'], guildId);
    const msg = replaceTemplateVariables(cfg.txtTurnReassignConfirm, {
      prev_writer: prevWriter.discord_display_name,
      current_writer: activeTurn.current_writer_name
    });
    pendingTurnActionData.set(adminId, { action: 'reassign', storyId, guildId, activeTurn, prevWriter });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('story_manage_ta_confirm').setLabel(cfg.btnTurnReassign).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('story_manage_ta_confirmcancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ content: msg, components: [row], flags: MessageFlags.Ephemeral });

  } else if (customId === 'story_manage_ta_deleteentry') {
    log(`handleTurnActionButton: deleteentry — showing modal`, { show: false, guildName: interaction?.guild?.name });
    const cfg = await getConfigValue(connection, ['txtTurnDeleteEntryModalTitle', 'lblTurnDeleteEntryTurn', 'txtTurnDeleteEntryPlaceholder'], guildId);
    const modal = new ModalBuilder()
      .setCustomId('story_manage_ta_deleteentry_modal')
      .setTitle(cfg.txtTurnDeleteEntryModalTitle)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('turn_number')
          .setLabel(cfg.lblTurnDeleteEntryTurn)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(cfg.txtTurnDeleteEntryPlaceholder)
      ));
    pendingTurnActionData.set(adminId, { action: 'deleteentry', storyId, guildId });
    await interaction.showModal(modal);

  } else if (customId === 'story_manage_ta_restoreentry') {
    log(`handleTurnActionButton: restoreentry — showing modal`, { show: false, guildName: interaction?.guild?.name });
    const cfg = await getConfigValue(connection, ['txtTurnRestoreEntryModalTitle', 'lblTurnRestoreEntryId', 'txtTurnRestoreEntryPlaceholder'], guildId);
    const modal = new ModalBuilder()
      .setCustomId('story_manage_ta_restoreentry_modal')
      .setTitle(cfg.txtTurnRestoreEntryModalTitle)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('entry_id')
          .setLabel(cfg.lblTurnRestoreEntryId)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(cfg.txtTurnRestoreEntryPlaceholder)
      ));
    pendingTurnActionData.set(adminId, { action: 'restoreentry', storyId, guildId });
    await interaction.showModal(modal);
    }
  } catch (error) {
    log(`handleTurnActionButton failed for customId=${customId} story=${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied) {
      await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleTurnActionConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const adminId = interaction.user.id;
  const pending = pendingTurnActionData.get(adminId);
  log(`handleTurnActionConfirm: action=${pending?.action} storyId=${pending?.storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  if (!pending) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), components: [] });
  }

  pendingTurnActionData.delete(adminId);
  const { action, storyId, guildId } = pending;

  try {
    if (action === 'skip') {
      const { activeTurn } = pending;
      log(`handleTurnActionConfirm: executing skip — turnId=${activeTurn.turn_id}`, { show: false, guildName: interaction?.guild?.name });
      await skipActiveTurn(connection, interaction.guild, activeTurn.turn_id, activeTurn.thread_id);
      const nextWriterId = await PickNextWriter(connection, storyId);
      if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      await logAdminAction(connection, adminId, 'skip', storyId);
      await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminSkipSuccess', guildId), components: [] });

    } else if (action === 'reassign') {
      const { activeTurn, prevWriter } = pending;
      log(`handleTurnActionConfirm: executing reassign — prevWriterId=${prevWriter.story_writer_id}`, { show: false, guildName: interaction?.guild?.name });
      await skipActiveTurn(connection, interaction.guild, activeTurn.turn_id, activeTurn.thread_id);
      await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [prevWriter.story_writer_id, storyId]);
      const nextWriterId = await PickNextWriter(connection, storyId);
      if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      // Queue the original current writer to go after the reassigned turn
      await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [activeTurn.story_writer_id ?? null, storyId]);
      await logAdminAction(connection, adminId, 'reassign', storyId);
      const msg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminReassignSuccess', guildId),
        { prev_writer: prevWriter.discord_display_name, current_writer: activeTurn.current_writer_name }
      );
      await interaction.editReply({ content: msg, components: [] });
    }
  } catch (error) {
    log(`handleTurnActionConfirm (${action}) failed for story ${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export async function handleTurnActionCancel(connection, interaction) {
  await interaction.deferUpdate();
  const adminId = interaction.user.id;
  log(`handleTurnActionCancel: user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  pendingTurnActionData.delete(adminId);
  await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
}

export async function handleTurnActionSelectMenu(connection, interaction) {
  const customId = interaction.customId;
  const adminId = interaction.user.id;
  const pending = pendingTurnActionData.get(adminId);
  log(`handleTurnActionSelectMenu: customId=${customId} user=${interaction.user.username} hasPending=${!!pending}`, { show: false, guildName: interaction?.guild?.name });

  if (!pending) {
    await interaction.deferUpdate();
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), components: [] });
  }

  if (customId === 'story_manage_ta_next_select') {
    const selectedWriterId = interaction.values[0];
    const { storyId, guildId, writers } = pending;
    const selectedWriter = writers.find(w => String(w.story_writer_id) === selectedWriterId);
    log(`handleTurnActionSelectMenu: next — selectedWriterId=${selectedWriterId} writer="${selectedWriter?.discord_display_name}"`, { show: false, guildName: interaction?.guild?.name });

    if (!selectedWriter) {
      await interaction.deferUpdate();
      return await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
    }

    try {
      // If no active turn, start theirs immediately
      const [activeTurnRows] = await connection.execute(
        `SELECT t.turn_id, sw.discord_user_id as current_writer_id FROM turn t
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         WHERE sw.story_id = ? AND t.turn_status = 1`,
        [storyId]
      );

      if (activeTurnRows.length === 0) {
        log(`handleTurnActionSelectMenu: next — no active turn, starting immediately`, { show: false, guildName: interaction?.guild?.name });
        await connection.execute(`UPDATE story SET next_writer_id = NULL WHERE story_id = ?`, [storyId]);
        await NextTurn(connection, interaction, parseInt(selectedWriterId));
        await logAdminAction(connection, adminId, 'next', storyId, selectedWriter.discord_user_id);
        pendingTurnActionData.delete(adminId);
        await interaction.update({
          content: replaceTemplateVariables(
            await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
            { user_name: selectedWriter.discord_display_name }
          ),
          components: []
        });
        return;
      }

      const currentWriterId = activeTurnRows[0].current_writer_id;
      if (String(currentWriterId) === String(selectedWriter.discord_user_id)) {
        await interaction.update({
          content: replaceTemplateVariables(
            await getConfigValue(connection, 'txtAdminNextAlreadyCurrent', guildId),
            { user_name: selectedWriter.discord_display_name }
          ),
          components: []
        });
        pendingTurnActionData.delete(adminId);
        return;
      }

      log(`handleTurnActionSelectMenu: next — setting next_writer_id=${selectedWriterId}`, { show: false, guildName: interaction?.guild?.name });
      await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [selectedWriterId, storyId]);
      await logAdminAction(connection, adminId, 'next', storyId, selectedWriter.discord_user_id);
      pendingTurnActionData.delete(adminId);
      await interaction.update({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
          { user_name: selectedWriter.discord_display_name }
        ),
        components: []
      });

    } catch (error) {
      log(`handleTurnActionSelectMenu next failed for story ${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.update({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
    }
  }
}

export async function handleTurnActionModal(connection, interaction) {
  const customId = interaction.customId;
  const adminId = interaction.user.id;
  const pending = pendingTurnActionData.get(adminId);
  log(`handleTurnActionModal: customId=${customId} user=${interaction.user.username} hasPending=${!!pending}`, { show: false, guildName: interaction?.guild?.name });

  if (!pending) {
    return await interaction.reply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }

  const { storyId, guildId } = pending;

  if (customId === 'story_manage_ta_extend_modal') {
    const raw = interaction.fields.getTextInputValue('extend_hours');
    const hours = parseInt(raw, 10);
    log(`handleTurnActionModal: extend — raw="${raw}" hours=${hours}`, { show: false, guildName: interaction?.guild?.name });

    if (isNaN(hours) || hours < 1) {
      pendingTurnActionData.delete(adminId);
      return await interaction.reply({ content: '❌ Hours must be a positive number.', flags: MessageFlags.Ephemeral });
    }

    try {
      const [activeTurnRows] = await connection.execute(
        `SELECT t.turn_id FROM turn t JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         WHERE sw.story_id = ? AND t.turn_status = 1`,
        [storyId]
      );
      if (activeTurnRows.length === 0) {
        pendingTurnActionData.delete(adminId);
        return await interaction.reply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId), flags: MessageFlags.Ephemeral });
      }

      const turnId = activeTurnRows[0].turn_id;
      log(`handleTurnActionModal: extend — turnId=${turnId} adding ${hours}h`, { show: false, guildName: interaction?.guild?.name });
      await connection.execute(
        `UPDATE turn SET turn_ends_at = DATE_ADD(COALESCE(turn_ends_at, NOW()), INTERVAL ? HOUR) WHERE turn_id = ?`,
        [hours, turnId]
      );
      const [updatedRows] = await connection.execute(
        `SELECT UNIX_TIMESTAMP(turn_ends_at) as new_end_unix, turn_ends_at FROM turn WHERE turn_id = ?`,
        [turnId]
      );
      const { new_end_unix: newEndUnix, turn_ends_at: newTurnEndsAt } = updatedRows[0];

      // Cancel old timeout job and schedule new one
      await connection.execute(
        `UPDATE job SET job_status = 2 WHERE job_type = 'turnTimeout' AND job_status = 0
         AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
        [turnId]
      );
      await connection.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
        ['turnTimeout', JSON.stringify({ turnId, storyId, guildId }), newTurnEndsAt]
      );

      await logAdminAction(connection, adminId, 'extend', storyId, null, `+${hours}h`);
      pendingTurnActionData.delete(adminId);
      const msg = replaceTemplateVariables(await getConfigValue(connection, 'txtAdminExtendSuccess', guildId), {
        hours,
        new_end_time: `<t:${newEndUnix}:f>`
      });
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });

    } catch (error) {
      log(`handleTurnActionModal extend failed for story ${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      pendingTurnActionData.delete(adminId);
      await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), flags: MessageFlags.Ephemeral });
    }

  } else if (customId === 'story_manage_ta_deleteentry_modal') {
    const raw = interaction.fields.getTextInputValue('turn_number');
    const turnNumber = parseInt(raw, 10);
    log(`handleTurnActionModal: deleteentry — turnNumber=${turnNumber}`, { show: false, guildName: interaction?.guild?.name });

    if (isNaN(turnNumber) || turnNumber < 1) {
      pendingTurnActionData.delete(adminId);
      return await interaction.reply({ content: '❌ Turn number must be a positive integer.', flags: MessageFlags.Ephemeral });
    }

    try {
      const [entryRows] = await connection.execute(
        `SELECT se.story_entry_id, se.content, sw.discord_display_name
         FROM story_entry se
         JOIN turn t ON se.turn_id = t.turn_id
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
           AND (SELECT COUNT(DISTINCT t2.turn_id) FROM turn t2
                JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
                JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
                WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) = ?`,
        [storyId, turnNumber]
      );
      log(`handleTurnActionModal: deleteentry — found ${entryRows.length} entries for turn ${turnNumber}`, { show: false, guildName: interaction?.guild?.name });

      if (entryRows.length === 0) {
        pendingTurnActionData.delete(adminId);
        return await interaction.reply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId), flags: MessageFlags.Ephemeral });
      }

      const entry = entryRows[0];
      const preview = entry.content.length > 300 ? entry.content.slice(0, 300) + '…' : entry.content;

      const embed = new EmbedBuilder()
        .setTitle(`Delete Turn ${turnNumber} — ${entry.discord_display_name}?`)
        .setDescription(preview)
        .addFields({ name: '​', value: 'This entry will be hidden from `/story read` and exports. The entry ID shown after deletion can be used to restore it.' })
        .setColor(0xff6b6b);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`storyadmin_deleteentry_confirm_${entry.story_entry_id}`)
          .setLabel('Delete Entry')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('storyadmin_deleteentry_cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      pendingTurnActionData.delete(adminId);
      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

    } catch (error) {
      log(`handleTurnActionModal deleteentry failed for story ${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      pendingTurnActionData.delete(adminId);
      await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), flags: MessageFlags.Ephemeral });
    }

  } else if (customId === 'story_manage_ta_restoreentry_modal') {
    const raw = interaction.fields.getTextInputValue('entry_id');
    const entryId = parseInt(raw, 10);
    log(`handleTurnActionModal: restoreentry — entryId=${entryId}`, { show: false, guildName: interaction?.guild?.name });

    if (isNaN(entryId) || entryId < 1) {
      pendingTurnActionData.delete(adminId);
      return await interaction.reply({ content: '❌ Entry ID must be a positive integer.', flags: MessageFlags.Ephemeral });
    }

    try {
      const [rows] = await connection.execute(
        `SELECT se.story_entry_id, se.entry_status, sw.discord_display_name, sw.story_id
         FROM story_entry se
         JOIN turn t ON se.turn_id = t.turn_id
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         JOIN story s ON sw.story_id = s.story_id
         WHERE se.story_entry_id = ? AND s.guild_id = ?`,
        [entryId, guildId]
      );
      log(`handleTurnActionModal: restoreentry — found=${rows.length} status=${rows[0]?.entry_status}`, { show: false, guildName: interaction?.guild?.name });

      if (rows.length === 0) {
        pendingTurnActionData.delete(adminId);
        return await interaction.reply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId), flags: MessageFlags.Ephemeral });
      }
      if (rows[0].entry_status !== 'deleted') {
        pendingTurnActionData.delete(adminId);
        return await interaction.reply({ content: await getConfigValue(connection, 'txtAdminRestoreEntryNotDeleted', guildId), flags: MessageFlags.Ephemeral });
      }

      await connection.execute(`UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?`, [entryId]);
      await logAdminAction(connection, adminId, 'restoreentry', rows[0].story_id);
      pendingTurnActionData.delete(adminId);
      const msg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminRestoreEntrySuccess', guildId),
        { author_name: rows[0].discord_display_name }
      );
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });

    } catch (error) {
      log(`handleTurnActionModal restoreentry failed for entry ${entryId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      pendingTurnActionData.delete(adminId);
      await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), flags: MessageFlags.Ephemeral });
    }
  }
}

export { pendingTurnActionData };
