import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId, validateStoryAccess, validateActiveWriter, splitAtParagraphs } from '../utilities.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';

// Pending reminder timeouts keyed by entryId
export const pendingReminderTimeouts = new Map();

async function handleWrite(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
    if (storyId === null) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
      return;
    }

    // Run all validation and config fetches in parallel
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

    // Create modal
    const modal = new ModalBuilder()
      .setCustomId(`story_write_${storyId}`)
      .setTitle(`✍️ ${storyInfo.story.title}`);

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
      content: await getConfigValue(connection,'txtWriteFormFailed', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
}

/**
 * Handle write modal submission
 */
async function handleWriteModalSubmit(connection, interaction) {
    const guildId = interaction.guild.id;
    const storyId = interaction.customId.split('_')[2];
    const content = interaction.fields.getTextInputValue('entry_content')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')  // remove zero-width chars
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
        // Update existing entry (re-draft after discard counts too)
        await connection.execute(`
          UPDATE story_entry SET content = ?, entry_status = 'pending', created_at = NOW()
          WHERE story_entry_id = ?
        `, [content, pendingEntry[0].story_entry_id]);
        entryId = String(pendingEntry[0].story_entry_id);
      } else {
        // Create new pending entry
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

    // Get timeout and create embed
    const timeoutMinutes = parseInt(await getConfigValue(connection,'cfgEntryTimeoutMinutes', guildId)) || 10;
    const expiresAt = new Date(Date.now() + (timeoutMinutes * 60 * 1000));
    const discordTimestamp = `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`;

    // Create preview embed
    const embed = await createPreviewEmbed(connection, content, guildId, discordTimestamp);

    // Create confirmation buttons
    const confirmRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_entry_${entryId}`)
          .setLabel(await getConfigValue(connection,'btnSubmit', guildId))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`discard_entry_${entryId}`)
          .setLabel(await getConfigValue(connection,'btnDiscard', guildId))
          .setStyle(ButtonStyle.Danger)
      );

    await interaction.editReply({
      embeds: [embed],
      components: [confirmRow]
    });

    // Send DM reminder after 5 minutes, cancelled if user confirms or discards before then
    const reminderTimeout = setTimeout(async () => {
      pendingReminderTimeouts.delete(entryId);
      try {
        const user = await interaction.client.users.fetch(interaction.user.id);
        await user.send(`${await getConfigValue(connection,'txtDMReminder', guildId)}\n\n${await getConfigValue(connection,'txtRecoveryInstructions', guildId)}\n\n⏰ Expires: ${discordTimestamp}`);
      } catch (error) {
        log(`Could not send DM reminder to user ${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
      }
    }, 5 * 60 * 1000);
    pendingReminderTimeouts.set(entryId, reminderTimeout);

  } catch (error) {
    log(`Error in handleWriteModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntryProcessFailed', interaction.guild.id)
    });
  }
}

/**
 * Collect per-message content parts from a sorted message collection.
 * Each message becomes one element (text + attachment lines joined with \n).
 * Callers join the returned array with \n\n to get the final entry string.
 */
function collectMessageParts(userMessages, resolveAttachment) {
  const parts = [];
  for (const msg of userMessages.values()) {
    const msgParts = [];
    if (msg.content) msgParts.push(msg.content);
    for (const attachment of msg.attachments.values()) {
      if (attachment.contentType?.startsWith('image/')) {
        msgParts.push(resolveAttachment(attachment));
      }
    }
    if (msgParts.length > 0) parts.push(msgParts.join('\n'));
  }
  return parts;
}

/**
 * Build an entry preview embed.
 * Content goes in the description (4096 limit), footer holds the instruction text,
 * and any extra fields (e.g. expiry, stats) are appended after overflow chunks.
 */
function buildEntryPreviewEmbed(content, title, footerText, extraFields = []) {
  const chunks = splitAtParagraphs(content, 4096);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(chunks[0])
    .setColor(0xffd700)
    .setFooter({ text: footerText });

  for (let i = 1; i < chunks.length; i++) {
    embed.addFields({ name: '​', value: chunks[i], inline: false });
  }

  if (extraFields.length > 0) embed.addFields(...extraFields);

  return embed;
}

/**
 * Create entry preview embed for quick mode (/story write)
 */
async function createPreviewEmbed(connection, content, guildId, discordTimestamp) {
  const [title, footer, expiresLabel, statsLabel, statsTemplate] = await Promise.all([
    getConfigValue(connection, 'txtPreviewTitle', guildId),
    getConfigValue(connection, 'txtPreviewDescription', guildId),
    getConfigValue(connection, 'txtPreviewExpires', guildId),
    getConfigValue(connection, 'lblEntryStats', guildId),
    getConfigValue(connection, 'txtEntryStatsTemplate', guildId),
  ]);

  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  const statsText = replaceTemplateVariables(statsTemplate, { char_count: content.length, word_count: wordCount });

  return buildEntryPreviewEmbed(content, title, footer, [
    { name: expiresLabel, value: discordTimestamp, inline: true },
    { name: statsLabel, value: statsText, inline: true },
  ]);
}

/**
 * Handle entry confirmation/discard
 */
async function handleEntryConfirmation(connection, interaction) {
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
      content: await getConfigValue(connection,'txtActionFailed', interaction.guild.id),
      components: []
    });
  }
}

/**
 * Confirm and finalize entry
 */
async function confirmEntry(connection, entryId, interaction) {
  if (pendingReminderTimeouts.has(entryId)) {
    clearTimeout(pendingReminderTimeouts.get(entryId));
    pendingReminderTimeouts.delete(entryId);
  }

  const txn = await connection.getConnection();
  await txn.beginTransaction();

  try {
    // Update entry status to confirmed
    await txn.execute(`
      UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?
    `, [entryId]);

    // Get story info for turn advancement and entry posting.
    // turn_number: count only confirmed-entry turns up to this one — matches /story read numbering.
    const [entryInfo] = await txn.execute(`
      SELECT se.turn_id, se.content, sw.story_id, sw.discord_user_id, sw.discord_display_name,
             s.story_thread_id, s.show_authors,
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
      throw new Error(`${formattedDate()}: Entry not found for ID ${entryId}`);
    }

    const { turn_id, content, story_id, discord_display_name, story_thread_id, show_authors, turn_number } = entryInfo[0];

    // Verify turn is still active — it may have timed out while the writer was composing
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

    // End current turn and cancel its pending jobs
    await txn.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [turn_id]);
    await txn.execute(`UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`, [turn_id]);

    // Advance to next writer
    const nextWriterId = await PickNextWriter(txn, story_id);
    await NextTurn(txn, interaction, nextWriterId);

    await txn.commit();

    // Post entry to story thread
    try {
      const storyThread = await interaction.guild.channels.fetch(story_thread_id);
      const entryEmbed = new EmbedBuilder()
        .setDescription(content);
      if (show_authors) entryEmbed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name}` });
      await storyThread.send({ embeds: [entryEmbed] });
    } catch (threadError) {
      log(`Failed to post entry to story thread: ${threadError}`, { show: true, guildName: interaction?.guild?.name });
    }

    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntrySubmitted', interaction.guild.id),
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

/**
 * Discard pending entry
 */
async function discardEntry(connection, entryId, interaction) {
  if (pendingReminderTimeouts.has(entryId)) {
    clearTimeout(pendingReminderTimeouts.get(entryId));
    pendingReminderTimeouts.delete(entryId);
  }

  try {
    await connection.execute(`
      UPDATE story_entry SET entry_status = 'discarded' WHERE story_entry_id = ?
    `, [entryId]);

    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntryDiscarded', interaction.guild.id),
      embeds: [],
      components: []
    });

  } catch (error) {
    log(`Error in discardEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    throw error;
  } finally {
    // Connection is persistent, no need to release
  }
}

/**
 * Handle view last entry button — posts the previous confirmed entry as a permanent embed in the thread
 */
async function handleViewLastEntry(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [writerCheck] = await connection.execute(
      `SELECT sw.discord_user_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (!writerCheck.length || String(writerCheck[0].discord_user_id) !== interaction.user.id) {
      return await interaction.followUp({
        content: await getConfigValue(connection, 'txtRequestMoreTimeNotYourTurn', guildId),
        flags: MessageFlags.Ephemeral
      });
    }

    const [rows] = await connection.execute(
      `SELECT se.content, sw.discord_display_name, s.show_authors,
              (SELECT COUNT(DISTINCT t2.turn_id)
               FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId]
    );

    if (rows.length === 0) {
      return;
    }

    const { content, discord_display_name, show_authors, turn_number } = rows[0];
    const embed = new EmbedBuilder().setDescription(content);
    if (show_authors) {
      embed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name}` });
    }

    await interaction.channel.send({ embeds: [embed] });

  } catch (error) {
    log(`Error in handleViewLastEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}

/**
 * Handle finalize entry button click — show confirmation prompt
 */
async function handleFinalizeEntry(connection, interaction) {
  const storyId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }

    // Collect user messages from thread to build preview
    const thread = await interaction.guild.channels.fetch(turnInfo[0].thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === interaction.user.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (userMessages.size === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', guildId) });
      return;
    }

    // Build preview content — images shown as filename placeholders (not forwarded yet)
    // Convert elements that Discord embeds don't render (headers → bold, -# → italic)
    const previewContent = collectMessageParts(userMessages, att => `📎 ${att.name}`)
      .join('\n\n')
      .replace(/^#{1,3} (.+)$/gm, '**$1**')
      .replace(/^-# (.+)$/gm, '*$1*');

    const [txtFinalizeConfirm, txtFinalizeConfirmDesc, btnFinalizeConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtFinalizeConfirm', guildId),
      getConfigValue(connection, 'txtFinalizeConfirmDesc', guildId),
      getConfigValue(connection, 'btnFinalizeConfirm', guildId),
      getConfigValue(connection, 'btnCancel', guildId),
    ]);

    const embed = buildEntryPreviewEmbed(previewContent, txtFinalizeConfirm, txtFinalizeConfirmDesc);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_finalize_confirm_${storyId}`)
        .setLabel(btnFinalizeConfirm)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`story_finalize_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`handleFinalizeEntry failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', guildId) });
  }
}

/**
 * Handle finalize confirm button — execute the actual finalize
 */
async function handleFinalizeConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_')[3];

  await interaction.deferUpdate();

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', interaction.guild.id), components: [] });
      return;
    }

    const turn = turnInfo[0];
    const thread = await interaction.guild.channels.fetch(turn.thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });

    const userMessages = messages
      .filter(msg => msg.author.id === interaction.user.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (userMessages.size === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', interaction.guild.id), components: [] });
      return;
    }

    // Forward images to media channel and build entry content with images inline.
    // Uses the same per-message grouping as collectMessageParts — text + image URLs
    // joined with \n within a message, \n\n between messages.
    const [mediaChannelId, mediaPostLabelTemplate] = await Promise.all([
      getConfigValue(connection, 'cfgMediaChannelId', interaction.guild.id),
      getConfigValue(connection, 'txtMediaPostLabel', interaction.guild.id),
    ]);
    const mediaChannel = (mediaChannelId && mediaChannelId !== 'cfgMediaChannelId')
      ? await interaction.guild.channels.fetch(mediaChannelId).catch(() => null)
      : null;
    const entryParts = [];

    for (const msg of userMessages.values()) {
      const msgParts = [];
      if (msg.content) msgParts.push(msg.content);
      if (mediaChannel) {
        for (const attachment of msg.attachments.values()) {
          if (attachment.contentType?.startsWith('image/')) {
            try {
              const forwarded = await mediaChannel.send({
                content: replaceTemplateVariables(mediaPostLabelTemplate, { story_id: storyId, turn_id: turn.turn_id }),
                files: [attachment.url]
              });
              msgParts.push(forwarded.attachments.first().url);
            } catch (err) {
              log(`Failed to forward image to media channel: ${err}`, { show: true, guildName: interaction?.guild?.name });
            }
          }
        }
      }
      if (msgParts.length > 0) entryParts.push(msgParts.join('\n'));
    }

    const entryContent = entryParts.join('\n\n');

    const [storyInfo] = await connection.execute(
      `SELECT s.show_authors, s.story_thread_id, sw.discord_display_name
       FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       WHERE s.story_id = ?`,
      [interaction.user.id, storyId]
    );
    const { show_authors, story_thread_id, discord_display_name } = storyInfo[0];

    const txn = await connection.getConnection();
    await txn.beginTransaction();
    try {
      await txn.execute(
        `INSERT INTO story_entry (turn_id, content, entry_status, created_at) VALUES (?, ?, 'confirmed', NOW())`,
        [turn.turn_id, entryContent]
      );
      await txn.execute(
        `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
        [turn.turn_id]
      );
      const nextWriterId = await PickNextWriter(txn, storyId);
      await NextTurn(txn, interaction, nextWriterId);
      await txn.commit();
    } catch (txnError) {
      await txn.rollback();
      if (txnError.code === 'ER_DUP_ENTRY') {
        await interaction.editReply({ content: await getConfigValue(connection, 'txtWriteAlreadySubmitted', interaction.guild.id), components: [] });
        return;
      }
      throw txnError;
    } finally {
      txn.release();
    }

    // Fetch turn number after commit so the confirmed entry is included in the count
    const [turnNumResult] = await connection.execute(
      `SELECT COUNT(DISTINCT t2.turn_id) AS turn_number
       FROM turn t2
       JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
       JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
       WHERE sw2.story_id = ? AND t2.started_at <= (SELECT started_at FROM turn WHERE turn_id = ?)`,
      [storyId, turn.turn_id]
    );
    const turn_number = turnNumResult[0].turn_number;

    try {
      const storyThread = await interaction.guild.channels.fetch(story_thread_id);
      const entryEmbed = new EmbedBuilder().setDescription(entryContent);
      if (show_authors) entryEmbed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name}` });
      await storyThread.send({ embeds: [entryEmbed] });
    } catch (embedError) {
      log(`Failed to post finalized entry to story thread: ${embedError}`, { show: true, guildName: interaction?.guild?.name });
    }

    // Reply before deleting thread — interaction context is tied to the thread
    await interaction.editReply({ content: await getConfigValue(connection, 'txtEntryFinalized', interaction.guild.id), components: [] });

    await deleteThreadAndAnnouncement(thread);

  } catch (error) {
    log(`handleFinalizeConfirm failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    try {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', interaction.guild.id), components: [] });
    } catch {}
  }
}

/**
 * Handle skip turn button click
 */
async function handleSkipTurn(connection, interaction) {
  const storyId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }

    const turn = turnInfo[0];

    // Check if the writer has posted any content in the turn thread
    let hasContent = false;
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        if (thread) {
          const messages = await thread.messages.fetch({ limit: 50 });
          hasContent = messages.some(m => !m.author.bot && m.author.id === interaction.user.id);
        }
      } catch {} // thread may not be accessible
    }

    const [txtConfirm, btnConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, hasContent ? 'txtSkipConfirmHasContent' : 'txtSkipConfirmNoContent', guildId),
      getConfigValue(connection, 'btnSkipConfirm', guildId),
      getConfigValue(connection, 'btnSkipCancel', guildId)
    ]);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_skip_confirm_${storyId}`)
        .setLabel(btnConfirm)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`story_skip_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: txtConfirm, components: [row] });

  } catch (error) {
    log(`Skip turn confirmation failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleSkipConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_')[3];
  const guildId = interaction.guild.id;

  await interaction.deferUpdate();

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId), components: [] });
      return;
    }

    const turn = turnInfo[0];

    await connection.execute(
      `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
      [turn.turn_id]
    );

    const nextWriterId = await PickNextWriter(connection, storyId);
    await NextTurn(connection, interaction, nextWriterId);

    // Activity log (fire-and-forget)
    getConfigValue(connection, 'txtStoryThreadTurnSkip', guildId).then(template =>
      postStoryThreadActivity(connection, interaction.guild, parseInt(storyId), template.replace('[writer_name]', turn.discord_display_name))
    ).catch(() => {});

    // Reply before deleting thread — interaction context is tied to the thread
    await interaction.editReply({ content: await getConfigValue(connection, 'txtSkipSuccess', guildId), components: [] });

    // Delete turn thread
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        log(`Failed to delete skipped turn thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

  } catch (error) {
    log(`Skip turn failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export {
  handleWrite,
  handleWriteModalSubmit,
  handleEntryConfirmation,
  confirmEntry,
  discardEntry,
  handleViewLastEntry,
  handleFinalizeEntry,
  handleFinalizeConfirm,
  handleSkipTurn,
  handleSkipConfirm,
  buildEntryPreviewEmbed,
  createPreviewEmbed,
};
