import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, checkIsAdmin } from '../utilities.js';
import { PickNextWriter, NextTurn, deleteThreadAndAnnouncement, endTurnGuarded } from './_turn.js';
import { getActiveThreadId } from '../storybot.js';
import { buildEntryPages, buildEntryEmbed, postThreadEntry } from './_entryRenderer.js';
import { pendingPreviewData } from './_state.js';

export function collectMessageParts(userMessages, resolveAttachment) {
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

export function buildPreviewEmbed(userId, pageIndex, confirmRow) {
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

export async function handleFinalizeEntry(connection, interaction) {
  const storyId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isAdmin = await checkIsAdmin(connection, interaction, guildId);
  log(`handleFinalizeEntry entry user=${interaction.user.username} story=${storyId}${isAdmin ? ' (admin)' : ''}`, { show: false, guildName: interaction?.guild?.name });

  try {
    let turnInfo, writerId;
    if (isAdmin) {
      const [rows] = await connection.execute(
        `SELECT t.turn_id, t.thread_id, sw.discord_user_id, s.scene_break_divider
         FROM turn t
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         JOIN story s ON sw.story_id = s.story_id
         WHERE sw.story_id = ? AND t.turn_status = 1 AND t.thread_id = ?`,
        [storyId, interaction.channel.id]
      );
      turnInfo = rows;
      writerId = rows[0]?.discord_user_id;
    } else {
      const [rows] = await connection.execute(
        `SELECT t.turn_id, t.thread_id, sw.discord_user_id, s.scene_break_divider
         FROM turn t
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         JOIN story s ON sw.story_id = s.story_id
         WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
        [storyId, interaction.user.id]
      );
      turnInfo = rows;
      writerId = interaction.user.id;
    }

    if (turnInfo.length === 0) {
      log(`handleFinalizeEntry: no active turn — story ${storyId} channel ${interaction.channel.id} user ${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }
    log(`handleFinalizeEntry: found turn ${turnInfo[0].turn_id} for writer ${writerId}`, { show: false, guildName: interaction?.guild?.name });

    const thread = await interaction.guild.channels.fetch(turnInfo[0].thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === String(writerId))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    log(`handleFinalizeEntry: fetched ${userMessages.size} messages from writer ${writerId} in thread ${turnInfo[0].thread_id}`, { show: false, guildName: interaction?.guild?.name });

    if (userMessages.size === 0) {
      log(`handleFinalizeEntry: no messages found, rejecting`, { show: false, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', guildId) });
      return;
    }

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

    const pages = buildEntryPages(previewContent, { turnNumber: '—', writerName: null, showAuthors: false, storyEntryId: null, sceneBreakDivider: turnInfo[0].scene_break_divider });
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

    log(`handleFinalizeEntry: showing preview page 1/${pages.length} to user ${interaction.user.username} for writer ${writerId}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply(buildPreviewEmbed(interaction.user.id, 0, confirmRow));

  } catch (error) {
    log(`handleFinalizeEntry failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', guildId) });
  }
}

export async function handlePreviewNav(connection, interaction) {
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

export async function doFinalizeEntry(connection, interaction, storyId, writerId) {
  log(`doFinalizeEntry: start — story ${storyId}, writer ${writerId}, triggered by ${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
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
    log(`doFinalizeEntry: turn ${turn.turn_id}, thread ${turn.thread_id}`, { show: false, guildName: interaction?.guild?.name });

    const thread = await interaction.guild.channels.fetch(turn.thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === String(writerId))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    log(`doFinalizeEntry: ${userMessages.size} messages from writer ${writerId} fetched`, { show: false, guildName: interaction?.guild?.name });

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
      `SELECT s.show_authors, s.story_thread_id, s.restricted_thread_id, s.rating, s.scene_break_divider, sw.discord_display_name
       FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       WHERE s.story_id = ?`,
      [writerId, storyId]
    );
    const activeThreadId = getActiveThreadId(storyInfo[0]);
    log(`doFinalizeEntry: story info fetched — show_authors=${storyInfo[0]?.show_authors}, active_thread=${activeThreadId}`, { show: false, guildName: interaction?.guild?.name });
    const { show_authors, scene_break_divider, discord_display_name } = storyInfo[0];

    log(`doFinalizeEntry: beginning DB transaction — turn ${turn.turn_id}`, { show: false, guildName: interaction?.guild?.name });
    const txn = await connection.getConnection();
    await txn.beginTransaction();
    let nextTurnResult = null;
    try {
      const ended = await endTurnGuarded(txn, turn.turn_id);
      if (!ended) {
        await txn.rollback();
        log(`doFinalizeEntry: turn ${turn.turn_id} already ended (race with timeout/other finalize) — aborting`, { show: true, guildName: interaction?.guild?.name });
        await interaction.editReply({ content: await getConfigValue(connection, 'txtWriteTurnEnded', interaction.guild.id), components: [] });
        return;
      }
      await txn.execute(
        `INSERT INTO story_entry (turn_id, content, entry_status, created_at) VALUES (?, ?, 'confirmed', NOW())`,
        [turn.turn_id, entryContent]
      );
      const nextWriterId = await PickNextWriter(txn, storyId);
      nextTurnResult = nextWriterId
        ? await NextTurn(txn, interaction, nextWriterId)
        : { success: false, error: 'No eligible next writer' };
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

    if (!nextTurnResult?.success) {
      log(`doFinalizeEntry: NextTurn failed for story ${storyId} after turn ${turn.turn_id} was finalized — story has no active turn: ${nextTurnResult?.error}`, { show: true, guildName: interaction?.guild?.name, hub: true });
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
      const storyThread = await interaction.guild.channels.fetch(activeThreadId);
      const authorLine = show_authors ? `Turn ${turn_number} — ${discord_display_name}` : null;
      await postThreadEntry(storyThread, entryContent, authorLine, scene_break_divider);
      log(`doFinalizeEntry: entry posted to story thread ${activeThreadId} as turn ${turn_number}`, { show: true, guildName: interaction?.guild?.name });
    } catch (embedError) {
      log(`doFinalizeEntry: failed to post entry to story thread: ${embedError}`, { show: true, guildName: interaction?.guild?.name });
    }

    pendingPreviewData.delete(interaction.user.id);
    const txtProcessing = await getConfigValue(connection, 'txtEntrySubmittedProcessing', interaction.guild.id).catch(() => null);
    if (txtProcessing) await thread.send(txtProcessing).catch(() => {});
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

export async function handleFinalizeConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_')[3];
  const session = pendingPreviewData.get(interaction.user.id);
  const writerId = session?.writerId ?? interaction.user.id;
  log(`handleFinalizeConfirm entry user=${interaction.user.username} writer=${writerId} story=${storyId}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, writerId]
    );
    if (turnInfo.length === 0) {
      log(`handleFinalizeConfirm: no active turn for writer ${writerId} story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', interaction.guild.id), components: [] });
      return;
    }
    log(`handleFinalizeConfirm: turn ${turnInfo[0].turn_id} found, fetching thread messages`, { show: false, guildName: interaction?.guild?.name });
    const thread = await interaction.guild.channels.fetch(turnInfo[0].thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === String(writerId))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    log(`handleFinalizeConfirm: ${userMessages.size} messages from writer ${writerId} fetched`, { show: false, guildName: interaction?.guild?.name });
    if (userMessages.size === 0) {
      log(`handleFinalizeConfirm: no messages found, aborting`, { show: false, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', interaction.guild.id), components: [] });
      return;
    }

    const mediaChannelId = await getConfigValue(connection, 'cfgMediaChannelId', interaction.guild.id);
    const mediaChannel = (mediaChannelId && mediaChannelId !== 'cfgMediaChannelId')
      ? await interaction.guild.channels.fetch(mediaChannelId).catch(() => null)
      : null;

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

    log(`handleFinalizeConfirm: no images or no media channel — proceeding directly to finalize`, { show: false, guildName: interaction?.guild?.name });
    await doFinalizeEntry(connection, interaction, storyId, writerId);

  } catch (error) {
    log(`handleFinalizeConfirm failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    try {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', interaction.guild.id), components: [] });
    } catch {}
  }
}

export async function handleFinalizeImageConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const session = pendingPreviewData.get(interaction.user.id);
  const writerId = session?.writerId ?? interaction.user.id;
  log(`handleFinalizeImageConfirm entry user=${interaction.user.username} story=${storyId} writer=${writerId}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  await doFinalizeEntry(connection, interaction, storyId, writerId);
}
