import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId, validateStoryAccess, validateActiveWriter } from '../utilities.js';
import { PickNextWriter, NextTurn } from './_turn.js';
import { buildEntryPages, buildEntryEmbed, postThreadEntry } from './_entryRenderer.js';

export const pendingReminderTimeouts = new Map();

export async function handleWrite(connection, interaction) {
  log(`handleWrite entry user=${interaction.user.username} story=${interaction.options.getString('story_id')}`, { show: false, guildName: interaction?.guild?.name });
  try {
    const guildId = interaction.guild.id;
    const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
    if (storyId === null) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
      return;
    }

    const [storyInfo, writerInfo, txtWriteWarning, lblWriteEntry, txtWritePlaceholder, txtNormalModeWrite] = await Promise.all([
      validateStoryAccess(connection, storyId, guildId),
      validateActiveWriter(connection, interaction.user.id, storyId),
      getConfigValue(connection, 'txtWriteWarning', guildId),
      getConfigValue(connection, 'lblWriteEntry', guildId),
      getConfigValue(connection, 'txtWritePlaceholder', guildId),
      getConfigValue(connection, 'txtNormalModeWrite', guildId),
    ]);

    if (!storyInfo.success) {
      await interaction.reply({ content: storyInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!writerInfo.success) {
      await interaction.reply({ content: writerInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!storyInfo.story.quick_mode) {
      await interaction.reply({ content: txtNormalModeWrite, flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`story_write_${storyId}`)
      .setTitle(storyInfo.story.title);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('entry_content')
          .setLabel(lblWriteEntry)
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder(`⚠️ ${txtWriteWarning}\n\n${txtWritePlaceholder}`)
          .setMaxLength(4000)
          .setMinLength(1)
          .setRequired(true)
      )
    );

    await interaction.showModal(modal);

  } catch (error) {
    log(`Error in handleWrite: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({
      content: await getConfigValue(connection, 'txtWriteFormFailed', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
}

export async function handleWriteModalSubmit(connection, interaction) {
  log(`handleWriteModalSubmit entry user=${interaction.user.username} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;
  const storyId = interaction.customId.split('_')[2];
  const content = interaction.fields.getTextInputValue('entry_content')
    .replace(/[​-‍﻿]/g, '')
    .trim()
    .substring(0, 4000);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let entryId = null;
  try {
    const [pendingEntry] = await connection.execute(`
      SELECT story_entry_id FROM story_entry se
      JOIN turn t ON se.turn_id = t.turn_id
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
      WHERE sw.story_id = ? AND sw.discord_user_id = ?
      AND se.entry_status IN ('pending', 'discarded')
    `, [storyId, interaction.user.id]);

    if (pendingEntry.length > 0) {
      await connection.execute(`
        UPDATE story_entry SET content = ?, entry_status = 'pending', created_at = NOW()
        WHERE story_entry_id = ?
      `, [content, pendingEntry[0].story_entry_id]);
      entryId = String(pendingEntry[0].story_entry_id);
    } else {
      const [turnInfo] = await connection.execute(`
        SELECT t.turn_id FROM turn t
        JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
        WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1
      `, [storyId, interaction.user.id]);

      if (turnInfo.length === 0) {
        throw new Error('No active turn found');
      }

      const [result] = await connection.execute(`
        INSERT INTO story_entry (turn_id, content, entry_status)
        VALUES (?, ?, 'pending')
      `, [turnInfo[0].turn_id, content]);

      entryId = String(result.insertId);
    }

    const timeoutMinutes = parseInt(await getConfigValue(connection, 'cfgEntryTimeoutMinutes', guildId)) || 10;
    const expiresAt = new Date(Date.now() + (timeoutMinutes * 60 * 1000));
    const expiryTimestamp = `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`;

    const [[storyRow]] = await connection.execute(
      `SELECT scene_break_divider FROM story WHERE story_id = ?`,
      [storyId]
    );

    const previewPayload = await createPreviewEmbed(connection, content, guildId, expiryTimestamp, entryId, storyRow?.scene_break_divider ?? null);
    await interaction.editReply(previewPayload);

    const reminderTimeout = setTimeout(async () => {
      pendingReminderTimeouts.delete(entryId);
      try {
        const user = await interaction.client.users.fetch(interaction.user.id);
        await user.send(`${await getConfigValue(connection, 'txtDMReminder', guildId)}\n\n${await getConfigValue(connection, 'txtRecoveryInstructions', guildId)}\n\n⏰ Expires: ${expiryTimestamp}`);
      } catch (error) {
        log(`Could not send DM reminder to user ${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
      }
    }, 5 * 60 * 1000);
    pendingReminderTimeouts.set(entryId, reminderTimeout);

  } catch (error) {
    log(`Error in handleWriteModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection, 'txtEntryProcessFailed', interaction.guild.id)
    });
  }
}

export async function handleEntryConfirmation(connection, interaction) {
  log(`handleEntryConfirmation entry action=${interaction.customId.split('_')[0]} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const [action, , entryIdStr] = interaction.customId.split('_');
  const entryId = entryIdStr;

  try {
    await interaction.deferUpdate();

    if (action === 'confirm') {
      await confirmEntry(connection, entryId, interaction);
    } else if (action === 'discard') {
      await discardEntry(connection, entryId, interaction);
    }

  } catch (error) {
    log(`Error in handleEntryConfirmation: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection, 'txtActionFailed', interaction.guild.id),
      components: []
    });
  }
}

export async function confirmEntry(connection, entryId, interaction) {
  log(`confirmEntry entry entryId=${entryId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  if (pendingReminderTimeouts.has(entryId)) {
    clearTimeout(pendingReminderTimeouts.get(entryId));
    pendingReminderTimeouts.delete(entryId);
  }

  const txn = await connection.getConnection();
  await txn.beginTransaction();

  try {
    await txn.execute(`
      UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?
    `, [entryId]);

    const [entryInfo] = await txn.execute(`
      SELECT se.turn_id, se.content, sw.story_id, sw.discord_user_id, sw.discord_display_name,
             s.story_thread_id, s.show_authors, s.scene_break_divider,
             (SELECT COUNT(DISTINCT t2.turn_id)
              FROM turn t2
              JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
              JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
              WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
      FROM story_entry se
      JOIN turn t ON se.turn_id = t.turn_id
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
      JOIN story s ON sw.story_id = s.story_id
      WHERE se.story_entry_id = ?
    `, [entryId]);

    if (entryInfo.length === 0) {
      throw new Error(`Entry not found for ID ${entryId}`);
    }

    const { turn_id, content, story_id, discord_display_name, story_thread_id, show_authors, scene_break_divider, turn_number } = entryInfo[0];

    const [turnCheck] = await txn.execute(
      `SELECT turn_status FROM turn WHERE turn_id = ?`,
      [turn_id]
    );
    if (turnCheck.length === 0 || turnCheck[0].turn_status !== 1) {
      await txn.rollback();
      await interaction.editReply({
        content: await getConfigValue(connection, 'txtWriteTurnEnded', interaction.guild.id),
        embeds: [],
        components: []
      });
      return;
    }

    await txn.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [turn_id]);
    await txn.execute(`UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`, [turn_id]);

    const nextWriterId = await PickNextWriter(txn, story_id);
    await NextTurn(txn, interaction, nextWriterId);

    await txn.commit();

    try {
      const storyThread = await interaction.guild.channels.fetch(story_thread_id);
      const authorLine = show_authors ? `Turn ${turn_number} — ${discord_display_name}` : null;
      await postThreadEntry(storyThread, content, authorLine, scene_break_divider);
    } catch (threadError) {
      log(`Failed to post entry to story thread: ${threadError}`, { show: true, guildName: interaction?.guild?.name });
    }

    await interaction.editReply({
      content: await getConfigValue(connection, 'txtEntrySubmitted', interaction.guild.id),
      embeds: [],
      components: []
    });

  } catch (error) {
    await txn.rollback();
    log(`Error in confirmEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    throw error;
  } finally {
    txn.release();
  }
}

export async function discardEntry(connection, entryId, interaction) {
  log(`discardEntry entry entryId=${entryId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  if (pendingReminderTimeouts.has(entryId)) {
    clearTimeout(pendingReminderTimeouts.get(entryId));
    pendingReminderTimeouts.delete(entryId);
  }

  try {
    await connection.execute(`
      UPDATE story_entry SET entry_status = 'discarded' WHERE story_entry_id = ?
    `, [entryId]);

    await interaction.editReply({
      content: await getConfigValue(connection, 'txtEntryDiscarded', interaction.guild.id),
      embeds: [],
      components: []
    });

  } catch (error) {
    log(`Error in discardEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    throw error;
  }
}

export async function createPreviewEmbed(connection, content, guildId, discordTimestamp, entryId, sceneBreakDivider = null) {
  const [title, expiresLabel, statsLabel, statsTemplate, btnSubmit, btnDiscard] = await Promise.all([
    getConfigValue(connection, 'txtPreviewTitle', guildId),
    getConfigValue(connection, 'txtPreviewExpires', guildId),
    getConfigValue(connection, 'lblEntryStats', guildId),
    getConfigValue(connection, 'txtEntryStatsTemplate', guildId),
    getConfigValue(connection, 'btnSubmit', guildId),
    getConfigValue(connection, 'btnDiscard', guildId),
  ]);

  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  const statsText = replaceTemplateVariables(statsTemplate, { char_count: content.length, word_count: wordCount });

  const statsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_entry_${entryId}`)
      .setLabel(btnSubmit)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`discard_entry_${entryId}`)
      .setLabel(btnDiscard)
      .setStyle(ButtonStyle.Danger)
  );

  const pages = buildEntryPages(content, { turnNumber: '—', writerName: null, showAuthors: false, storyEntryId: entryId, sceneBreakDivider });
  const page = pages[0];

  const result = buildEntryEmbed(page, {
    title,
    pageIndex: 0,
    totalPages: pages.length,
    context: 'preview',
    extraButtons: [statsRow],
    guildId,
    imagePageIndex: 0,
  });

  if (result.embeds[0]) {
    result.embeds[0].setFooter({ text: `${expiresLabel}: ${discordTimestamp} · ${statsText}` });
  }

  return result;
}
