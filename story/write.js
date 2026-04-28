import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId, validateStoryAccess, validateActiveWriter, checkIsAdmin } from '../utilities.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';
import { buildEntryPages, buildEntryEmbed, buildThreadEmbeds } from './entryRenderer.js';
import { pendingPreviewData, pendingViewData } from './state.js';

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
    const expiryTimestamp = `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`;

    // Create paginated preview
    const previewPayload = await createPreviewEmbed(connection, content, guildId, expiryTimestamp, entryId);
    await interaction.editReply(previewPayload);

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
 * Build the quick mode (/story write) preview embed.
 * Uses buildEntryPages for consistent pagination, adds expiry/stats as an extra row.
 */
async function createPreviewEmbed(connection, content, guildId, discordTimestamp, entryId) {
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

  const pages = buildEntryPages(content, { turnNumber: '—', writerName: null, showAuthors: false, storyEntryId: entryId });
  const page = pages[0];

  // For quick mode we always show only page 1 — the entry fits in 4000 chars (modal limit).
  // buildEntryEmbed handles paging if content ever exceeds that.
  const result = buildEntryEmbed(page, {
    title,
    pageIndex: 0,
    totalPages: pages.length,
    context: 'preview',
    extraButtons: [statsRow],
    guildId,
    imagePageIndex: 0,
  });

  // Replace footer with expiry + stats
  if (result.embeds[0]) {
    result.embeds[0].setFooter({ text: `${expiresLabel}: ${discordTimestamp} · ${statsText}` });
  }

  return result;
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
      const authorLine = show_authors ? `Turn ${turn_number} — ${discord_display_name}` : null;
      await storyThread.send({ embeds: buildThreadEmbeds(content, authorLine) });
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
    const authorLine = show_authors ? `Turn ${turn_number} — ${discord_display_name}` : null;
    await interaction.channel.send({ embeds: buildThreadEmbeds(content, authorLine) });

  } catch (error) {
    log(`Error in handleViewLastEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}

/**
 * Handle finalize entry button click — show paginated preview with Confirm/Cancel on every page.
 */
async function handleFinalizeEntry(connection, interaction) {
  const storyId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);
  log(`handleFinalizeEntry: user ${interaction.user.id} story ${storyId}${isAdmin ? ' (admin)' : ''}`, { show: true, guildName: interaction?.guild?.name });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    // Admins can finalize from inside the turn thread on behalf of the current writer.
    // Regular writers can only finalize their own active turn.
    let turnInfo, writerId;
    if (isAdmin) {
      const [rows] = await connection.execute(
        `SELECT t.turn_id, t.thread_id, sw.discord_user_id
         FROM turn t
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         WHERE sw.story_id = ? AND t.turn_status = 1 AND t.thread_id = ?`,
        [storyId, interaction.channel.id]
      );
      turnInfo = rows;
      writerId = rows[0]?.discord_user_id;
    } else {
      const [rows] = await connection.execute(
        `SELECT t.turn_id, t.thread_id, sw.discord_user_id
         FROM turn t
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
        [storyId, interaction.user.id]
      );
      turnInfo = rows;
      writerId = interaction.user.id;
    }

    if (turnInfo.length === 0) {
      log(`handleFinalizeEntry: no active turn found — story ${storyId} channel ${interaction.channel.id} user ${interaction.user.id}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }
    log(`handleFinalizeEntry: found turn ${turnInfo[0].turn_id} for writer ${writerId}`, { show: true, guildName: interaction?.guild?.name });

    const thread = await interaction.guild.channels.fetch(turnInfo[0].thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === String(writerId))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    log(`handleFinalizeEntry: fetched ${userMessages.size} messages from writer ${writerId} in thread ${turnInfo[0].thread_id}`, { show: true, guildName: interaction?.guild?.name });

    if (userMessages.size === 0) {
      log(`handleFinalizeEntry: no messages found, rejecting`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', guildId) });
      return;
    }

    // Build preview content. Convert elements Discord embeds don't render (headers → bold, -# → italic).
    const previewParts = [];
    let previewImageCount = 0;
    for (const msg of userMessages.values()) {
      const msgText = msg.content?.trim();
      const imageAtts = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/'));
      if (imageAtts.length === 0) {
        if (msgText) previewParts.push(msgText);
      } else {
        previewImageCount += imageAtts.length;
        for (const att of imageAtts) {
          previewParts.push(`📎 ${msgText || att.name}`);
        }
      }
    }
    log(`handleFinalizeEntry: preview built — ${previewParts.length} parts, ${previewImageCount} image(s)`, { show: false, guildName: interaction?.guild?.name });
    const previewContent = previewParts.join('\n\n')
      .replace(/^#{1,3} (.+)$/gm, '**$1**')
      .replace(/^-# (.+)$/gm, '*$1*');

    const [txtFinalizeConfirm, btnFinalizeConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtFinalizeConfirm', guildId),
      getConfigValue(connection, 'btnFinalizeConfirm', guildId),
      getConfigValue(connection, 'btnCancel', guildId),
    ]);

    const pages = buildEntryPages(previewContent, { turnNumber: '—', writerName: null, showAuthors: false, storyEntryId: null });
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_finalize_confirm_${storyId}`)
        .setLabel(btnFinalizeConfirm)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`story_finalize_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    pendingPreviewData.set(interaction.user.id, {
      pages,
      currentPage: 0,
      imagePageIndex: 0,
      storyId,
      guildId,
      writerId: String(writerId),
      title: txtFinalizeConfirm,
    });

    log(`handleFinalizeEntry: showing preview page 1/${pages.length} to user ${interaction.user.id} for writer ${writerId}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply(buildPreviewEmbed(interaction.user.id, 0, confirmRow));

  } catch (error) {
    log(`handleFinalizeEntry failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', guildId) });
  }
}

function buildPreviewEmbed(userId, pageIndex, confirmRow) {
  const session = pendingPreviewData.get(userId);
  if (!session) return { content: 'Preview session expired.', embeds: [], components: [] };
  const page = session.pages[pageIndex];
  return buildEntryEmbed(page, {
    title: session.title,
    pageIndex,
    totalPages: session.pages.length,
    context: 'preview',
    extraButtons: [confirmRow],
    guildId: session.guildId,
    imagePageIndex: session.imagePageIndex ?? 0,
  });
}

/**
 * Handle preview pagination (story_preview_prev / next / back10 / fwd10 / img_prev / img_next).
 */
async function handlePreviewNav(connection, interaction) {
  await interaction.deferUpdate();
  const session = pendingPreviewData.get(interaction.user.id);
  if (!session) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', interaction.guild.id), components: [] });
    return;
  }

  const id = interaction.customId;
  if (id === 'story_preview_prev') {
    session.currentPage = Math.max(0, session.currentPage - 1);
  } else if (id === 'story_preview_next') {
    session.currentPage = Math.min(session.pages.length - 1, session.currentPage + 1);
  } else if (id === 'story_preview_back10') {
    session.currentPage = Math.max(0, session.currentPage - 10);
  } else if (id === 'story_preview_fwd10') {
    session.currentPage = Math.min(session.pages.length - 1, session.currentPage + 10);
  } else if (id === 'story_preview_img_prev') {
    session.imagePageIndex = Math.max(0, (session.imagePageIndex ?? 0) - 1);
  } else if (id === 'story_preview_img_next') {
    const page = session.pages[session.currentPage];
    const total = Math.ceil((page.imageUrls?.length ?? 0) / 4);
    session.imagePageIndex = Math.min(total - 1, (session.imagePageIndex ?? 0) + 1);
  }

  const [btnFinalizeConfirm, btnCancel] = await Promise.all([
    getConfigValue(connection, 'btnFinalizeConfirm', session.guildId),
    getConfigValue(connection, 'btnCancel', session.guildId),
  ]);
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_finalize_confirm_${session.storyId}`)
      .setLabel(btnFinalizeConfirm)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`story_finalize_cancel_${session.storyId}`)
      .setLabel(btnCancel)
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply(buildPreviewEmbed(interaction.user.id, session.currentPage, confirmRow));
}

/**
 * Core finalization logic — forwards images, inserts confirmed entry, advances turn.
 * Called by handleFinalizeConfirm (no images) and handleFinalizeImageConfirm (after image review).
 */
async function doFinalizeEntry(connection, interaction, storyId, writerId) {
  log(`doFinalizeEntry: start — story ${storyId}, writer ${writerId}, triggered by ${interaction.user.id}`, { show: true, guildName: interaction?.guild?.name });
  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, writerId]
    );
    if (turnInfo.length === 0) {
      log(`doFinalizeEntry: no active turn for writer ${writerId} story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', interaction.guild.id), components: [] });
      return;
    }
    const turn = turnInfo[0];
    log(`doFinalizeEntry: turn ${turn.turn_id}, thread ${turn.thread_id}`, { show: true, guildName: interaction?.guild?.name });

    const thread = await interaction.guild.channels.fetch(turn.thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === String(writerId))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    log(`doFinalizeEntry: ${userMessages.size} messages from writer ${writerId} fetched`, { show: true, guildName: interaction?.guild?.name });

    if (userMessages.size === 0) {
      log(`doFinalizeEntry: no messages found, aborting`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', interaction.guild.id), components: [] });
      return;
    }

    const [mediaChannelId, mediaPostLabelTemplate] = await Promise.all([
      getConfigValue(connection, 'cfgMediaChannelId', interaction.guild.id),
      getConfigValue(connection, 'txtMediaPostLabel', interaction.guild.id),
    ]);
    const mediaChannel = (mediaChannelId && mediaChannelId !== 'cfgMediaChannelId')
      ? await interaction.guild.channels.fetch(mediaChannelId).catch(() => null)
      : null;
    log(`doFinalizeEntry: media channel ${mediaChannel ? mediaChannel.id : 'not configured'}`, { show: false, guildName: interaction?.guild?.name });

    // Build entry content. Messages with images use the message text as the image's display
    // label, stored as [display text](cdn_url). Text-only messages are stored as-is.
    const entryParts = [];
    let imagesForwarded = 0;
    for (const msg of userMessages.values()) {
      const msgText = msg.content?.trim() || null;
      const imageAtts = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/'));
      if (imageAtts.length === 0) {
        if (msgText) entryParts.push(msgText);
      } else if (mediaChannel) {
        const imgLinks = [];
        for (const att of imageAtts) {
          log(`doFinalizeEntry: forwarding image "${att.name}" to media channel`, { show: true, guildName: interaction?.guild?.name });
          try {
            const forwarded = await mediaChannel.send({
              content: replaceTemplateVariables(mediaPostLabelTemplate, { story_id: storyId, turn_id: turn.turn_id }),
              files: [att.url]
            });
            imgLinks.push(`[${msgText || att.name}](${forwarded.attachments.first().url})`);
            imagesForwarded++;
            log(`doFinalizeEntry: image "${att.name}" forwarded successfully`, { show: false, guildName: interaction?.guild?.name });
          } catch (err) {
            log(`doFinalizeEntry: failed to forward image "${att.name}" to media channel: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
        if (imgLinks.length > 0) entryParts.push(imgLinks.join('\n'));
      }
    }

    const entryContent = entryParts.join('\n\n');
    log(`doFinalizeEntry: entry built — ${entryContent.length} chars, ${imagesForwarded} image(s) forwarded`, { show: false, guildName: interaction?.guild?.name });

    const [storyInfo] = await connection.execute(
      `SELECT s.show_authors, s.story_thread_id, sw.discord_display_name
       FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       WHERE s.story_id = ?`,
      [writerId, storyId]
    );
    log(`doFinalizeEntry: story info fetched — show_authors=${storyInfo[0]?.show_authors}, story_thread=${storyInfo[0]?.story_thread_id}`, { show: true, guildName: interaction?.guild?.name });
    const { show_authors, story_thread_id, discord_display_name } = storyInfo[0];

    log(`doFinalizeEntry: beginning DB transaction — turn ${turn.turn_id}`, { show: false, guildName: interaction?.guild?.name });
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
      log(`doFinalizeEntry: DB transaction committed — entry inserted, turn ${turn.turn_id} ended, next writer ${nextWriterId}`, { show: true, guildName: interaction?.guild?.name });
    } catch (txnError) {
      await txn.rollback();
      log(`doFinalizeEntry: DB transaction rolled back — ${txnError}\n${txnError?.stack ?? ''}`, { show: true, guildName: interaction?.guild?.name });
      if (txnError.code === 'ER_DUP_ENTRY') {
        await interaction.editReply({ content: await getConfigValue(connection, 'txtWriteAlreadySubmitted', interaction.guild.id), components: [] });
        return;
      }
      throw txnError;
    } finally {
      txn.release();
    }

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
      const authorLine = show_authors ? `Turn ${turn_number} — ${discord_display_name}` : null;
      await storyThread.send({ embeds: buildThreadEmbeds(entryContent, authorLine) });
      log(`doFinalizeEntry: entry posted to story thread ${story_thread_id} as turn ${turn_number}`, { show: true, guildName: interaction?.guild?.name });
    } catch (embedError) {
      log(`doFinalizeEntry: failed to post entry to story thread: ${embedError}`, { show: true, guildName: interaction?.guild?.name });
    }

    pendingPreviewData.delete(interaction.user.id);
    // Reply before deleting thread — interaction context is tied to the thread
    await interaction.editReply({ content: await getConfigValue(connection, 'txtEntryFinalized', interaction.guild.id), components: [] });
    log(`doFinalizeEntry: complete — deleting turn thread ${turn.thread_id}`, { show: true, guildName: interaction?.guild?.name });
    await deleteThreadAndAnnouncement(thread);

  } catch (error) {
    log(`doFinalizeEntry failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    try {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', interaction.guild.id), components: [] });
    } catch {}
  }
}

/**
 * Handle finalize confirm button.
 * When images are present and a media channel is configured, shows an image
 * display-text review step before committing. Otherwise finalizes immediately.
 */
async function handleFinalizeConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_')[3];
  const session = pendingPreviewData.get(interaction.user.id);
  const writerId = session?.writerId ?? interaction.user.id;
  log(`handleFinalizeConfirm: user ${interaction.user.id} confirming finalize for writer ${writerId} story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, writerId]
    );
    if (turnInfo.length === 0) {
      log(`handleFinalizeConfirm: no active turn for writer ${writerId} story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', interaction.guild.id), components: [] });
      return;
    }
    log(`handleFinalizeConfirm: turn ${turnInfo[0].turn_id} found, fetching thread messages`, { show: true, guildName: interaction?.guild?.name });
    const thread = await interaction.guild.channels.fetch(turnInfo[0].thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === String(writerId))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    log(`handleFinalizeConfirm: ${userMessages.size} messages from writer ${writerId} fetched`, { show: true, guildName: interaction?.guild?.name });
    if (userMessages.size === 0) {
      log(`handleFinalizeConfirm: no messages found, aborting`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', interaction.guild.id), components: [] });
      return;
    }

    const mediaChannelId = await getConfigValue(connection, 'cfgMediaChannelId', interaction.guild.id);
    const mediaChannel = (mediaChannelId && mediaChannelId !== 'cfgMediaChannelId')
      ? await interaction.guild.channels.fetch(mediaChannelId).catch(() => null)
      : null;

    // Collect image display texts for the review popup
    const imageInfos = [];
    for (const msg of userMessages.values()) {
      const displayText = msg.content?.trim() || null;
      for (const att of msg.attachments.values()) {
        if (att.contentType?.startsWith('image/')) {
          imageInfos.push({ filename: att.name, displayText: displayText || att.name });
        }
      }
    }
    log(`handleFinalizeConfirm: ${imageInfos.length} image(s) found, media channel: ${mediaChannel ? mediaChannel.id : 'not configured'}`, { show: false, guildName: interaction?.guild?.name });

    if (imageInfos.length > 0 && mediaChannel) {
      log(`handleFinalizeConfirm: showing image review popup`, { show: false, guildName: interaction?.guild?.name });
      const listLines = imageInfos.map(i => `- ${i.filename} : ${i.displayText}`).join('\n');
      const [reviewTemplate, btnConfirm, btnCancel] = await Promise.all([
        getConfigValue(connection, 'txtFinalizeImageReview', interaction.guild.id),
        getConfigValue(connection, 'btnFinalizeConfirm', interaction.guild.id),
        getConfigValue(connection, 'btnCancel', interaction.guild.id),
      ]);
      const embed = new EmbedBuilder()
        .setDescription(replaceTemplateVariables(reviewTemplate, { image_list: listLines }));
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`story_finalize_image_confirm_${storyId}`)
          .setLabel(btnConfirm)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`story_finalize_cancel_${storyId}`)
          .setLabel(btnCancel)
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({ content: '', embeds: [embed], components: [row] });
      return;
    }

    log(`handleFinalizeConfirm: no images or no media channel — proceeding directly to finalize`, { show: true, guildName: interaction?.guild?.name });
    await doFinalizeEntry(connection, interaction, storyId, writerId);

  } catch (error) {
    log(`handleFinalizeConfirm failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    try {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', interaction.guild.id), components: [] });
    } catch {}
  }
}

/**
 * Handle image display-text review confirm — runs the actual finalization.
 */
async function handleFinalizeImageConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const session = pendingPreviewData.get(interaction.user.id);
  const writerId = session?.writerId ?? interaction.user.id;
  log(`handleFinalizeImageConfirm: user ${interaction.user.id} confirmed image review for story ${storyId}, writer ${writerId}`, { show: true, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  await doFinalizeEntry(connection, interaction, storyId, writerId);
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
  handleFinalizeImageConfirm,
  handlePreviewNav,
  handleSkipTurn,
  handleSkipConfirm,
};
