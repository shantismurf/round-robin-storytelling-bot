import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, resolveStoryId, chunkEntryContent, checkIsAdmin } from '../utilities.js';
import { pendingReadData, pendingEditData } from './state.js';
import { buildReadEmbed } from './read.js';

export { pendingEditData };

async function handleEdit(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (!storyId) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  const turnNumber = interaction.options.getInteger('turn');
  await openEditSession(connection, interaction, guildId, storyId, turnNumber, null);
}

// Shared session-setup used by both /story edit (handleEdit) and the contextual
// Edit button in /story read (handleReadEditButton).
// Pass turnNumber to resolve by turn, or entryId to resolve directly.
async function openEditSession(connection, interaction, guildId, storyId, turnNumber, entryId) {
  let entryRows;

  if (entryId != null) {
    // Path B: resolve directly from a known entry ID (from the read view Edit button)
    [entryRows] = await connection.execute(
      `SELECT se.story_entry_id, se.content, se.created_at, se.entry_status,
              sw.discord_user_id AS original_author_id, sw.discord_display_name AS author_name,
              s.guild_story_id, s.title,
              (SELECT COUNT(DISTINCT t2.turn_id)
               FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id
                 AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
              ) AS turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE se.story_entry_id = ?
         AND se.entry_status = 'confirmed'`,
      [entryId]
    );
  } else {
    // Path A: resolve by turn number — uses confirmed-only count to match /story read numbering
    [entryRows] = await connection.execute(
      `SELECT se.story_entry_id, se.content, se.created_at, se.entry_status,
              sw.discord_user_id AS original_author_id, sw.discord_display_name AS author_name,
              s.guild_story_id, s.title
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ?
         AND se.entry_status = 'confirmed'
         AND (
           SELECT COUNT(DISTINCT t2.turn_id)
           FROM turn t2
           JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
           JOIN story_entry se2 ON se2.turn_id = t2.turn_id
             AND se2.entry_status = 'confirmed'
           WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
         ) = ?`,
      [storyId, turnNumber]
    );
  }

  if (entryRows.length === 0) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId) });
  }
  const entry = entryRows[0];
  const resolvedTurnNumber = turnNumber ?? entry.turn_number;

  const isAdmin = await checkIsAdmin(connection, interaction, guildId);
  const isAuthor = String(entry.original_author_id) === interaction.user.id;

  if (!isAdmin && !isAuthor) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditNotAuthorized', guildId) });
  }

  const [histRows] = await connection.execute(
    `SELECT COUNT(*) AS cnt FROM story_entry_edit WHERE entry_id = ?`,
    [entry.story_entry_id]
  );
  const hasHistory = histRows[0].cnt > 0;
  const chunks = chunkEntryContent(entry.content);
  const storyTitle = entry.title.length > 50 ? entry.title.slice(0, 50) + '…' : entry.title;

  pendingEditData.set(interaction.user.id, {
    entryId: entry.story_entry_id,
    entryStatus: entry.entry_status,
    storyId,
    guildId,
    originalAuthorId: String(entry.original_author_id),
    createdAt: entry.created_at,
    currentContent: entry.content,
    chunks,
    chunkPage: 0,
    hasHistory,
    historyPage: 0,
    turnNumber: resolvedTurnNumber,
    storyTitle,
    guildStoryId: entry.guild_story_id,
    originalInteraction: interaction
  });

  await interaction.editReply(buildEditMessage(chunks, 0, hasHistory, resolvedTurnNumber, storyTitle, entry.guild_story_id));
}

function buildEditMessage(chunks, chunkPage, hasHistory, turnNumber, storyTitle, guildStoryId) {
  const chunk = chunks[chunkPage];
  const isFirstPage = chunkPage === 0;
  const isMultiPage = chunks.length > 1;
  const pageLabel = isMultiPage ? ` · Page ${chunkPage + 1} of ${chunks.length}` : '';

  const embed = new EmbedBuilder()
    .setTitle(`#${guildStoryId} ${storyTitle} · Turn #${turnNumber}${pageLabel}`)
    .setDescription(chunk.text)
    .setFooter({ text: `${chunk.text.length} / 3800 characters on this page` })
    .setColor(0xffd700);

  if (isMultiPage) {
    embed.addFields({
      name: '📄 Entry split across pages',
      value: `This entry is too long to show at once and has been split into **${chunks.length} pages**. Use ← Prev / Next → to navigate between pages. Click **Edit** on any page to edit that section independently.`
    });
  }

  // Only show navigation buttons when there are multiple pages.
  // Only show History button when edit history exists.
  const buttons = [];

  if (isMultiPage) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('story_edit_prev')
        .setLabel('← Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(chunkPage === 0),
      new ButtonBuilder()
        .setCustomId('story_edit_next')
        .setLabel('Next →')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(chunkPage === chunks.length - 1)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId('story_edit_open_modal')
      .setLabel('Edit')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(false)
  );

  if (hasHistory) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('story_edit_browse_history')
        .setLabel('History')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(false)
    );
  }

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons)] };
}

async function handleEditButton(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingEditData.get(userId);

  if (!state) {
    await interaction.deferUpdate();
    return;
  }

  const customId = interaction.customId;

  if (customId === 'story_edit_prev') {
    await interaction.deferUpdate();
    state.chunkPage = Math.max(0, state.chunkPage - 1);
    await state.originalInteraction.editReply(
      buildEditMessage(state.chunks, state.chunkPage, state.hasHistory, state.turnNumber, state.storyTitle, state.guildStoryId)
    );

  } else if (customId === 'story_edit_next') {
    await interaction.deferUpdate();
    state.chunkPage = Math.min(state.chunks.length - 1, state.chunkPage + 1);
    await state.originalInteraction.editReply(
      buildEditMessage(state.chunks, state.chunkPage, state.hasHistory, state.turnNumber, state.storyTitle, state.guildStoryId)
    );

  } else if (customId === 'story_edit_open_modal') {
    // No defer — showModal must be the first response
    // Use entryId in customId to prevent Discord from caching modal content across entries
    const isMultiPage = state.chunks.length > 1;
    const modalTitle = isMultiPage
      ? `Edit Entry — Page ${state.chunkPage + 1} of ${state.chunks.length}`
      : 'Edit Entry';
    const modal = new ModalBuilder()
      .setCustomId(`story_edit_modal_${state.entryId}`)
      .setTitle(modalTitle);
    const input = new TextInputBuilder()
      .setCustomId('entry_content')
      .setLabel('Entry content')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setValue(state.chunks[state.chunkPage].text.slice(0, 4000))
      .setPlaceholder('Edit this section. If you hit the character limit, save and return to continue on the next page.');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);

  } else if (customId === 'story_edit_browse_history') {
    // Open history as a separate ephemeral followUp so the edit embed stays intact underneath.
    await interaction.deferUpdate();
    state.historyMessage = await state.originalInteraction.followUp({
      ...(await renderHistoryPage(connection, interaction, state, 0, 0)),
      flags: MessageFlags.Ephemeral
    });

  } else if (customId === 'story_edit_history_prev') {
    await interaction.deferUpdate();
    await state.historyMessage.edit(
      await renderHistoryPage(connection, interaction, state, Math.max(0, state.historyPage - 1), 0)
    );

  } else if (customId === 'story_edit_history_next') {
    await interaction.deferUpdate();
    await state.historyMessage.edit(
      await renderHistoryPage(connection, interaction, state, state.historyPage + 1, 0)
    );

  } else if (customId === 'story_edit_hist_chunk_prev') {
    await interaction.deferUpdate();
    await state.historyMessage.edit(
      await renderHistoryPage(connection, interaction, state, state.historyPage, (state.histChunkPage ?? 0) - 1)
    );

  } else if (customId === 'story_edit_hist_chunk_next') {
    await interaction.deferUpdate();
    await state.historyMessage.edit(
      await renderHistoryPage(connection, interaction, state, state.historyPage, (state.histChunkPage ?? 0) + 1)
    );

  } else if (customId.startsWith('story_edit_restore_confirm_')) {
    const editId = parseInt(customId.split('_').at(-1));
    await handleRestoreExecute(connection, interaction, editId);

  } else if (customId.startsWith('story_edit_restore_')) {
    const editId = parseInt(customId.split('_').at(-1));
    await handleRestoreConfirm(connection, interaction, editId);

  } else if (customId === 'story_edit_restore_cancel') {
    await interaction.deferUpdate();
    await state.historyMessage.edit(
      await renderHistoryPage(connection, interaction, state, state.historyPage, state.histChunkPage ?? 0)
    );

  } else if (customId === 'story_edit_back') {
    // Close the history followUp and return focus to the edit embed.
    // Ephemeral followUps can't be deleted via message.delete() — must use the interaction webhook.
    await interaction.deferUpdate();
    await state.originalInteraction.deleteReply(state.historyMessage).catch(() => {});
    state.historyMessage = null;

  } else if (customId.startsWith('story_edit_next_entry_')) {
    const nextEntryId = parseInt(customId.split('_').at(-1));
    await interaction.deferUpdate();
    await openEditSession(connection, interaction, state.guildId, state.storyId, null, nextEntryId);

  } else if (customId.startsWith('story_repost_entry_')) {
    await handleRepostEntry(connection, interaction);
  }
}

async function renderHistoryPage(connection, interaction, state, histPage, histChunkPage = 0) {
  const [rows] = await connection.execute(
    `SELECT edit_id, content, edited_by_name, edited_at
     FROM story_entry_edit
     WHERE entry_id = ? ORDER BY edited_at DESC LIMIT 1 OFFSET ?`,
    [state.entryId, histPage]
  );
  const [countRow] = await connection.execute(
    `SELECT COUNT(*) AS cnt FROM story_entry_edit WHERE entry_id = ?`,
    [state.entryId]
  );
  const total = countRow[0].cnt;

  if (rows.length === 0) {
    return buildEditMessage(state.chunks, state.chunkPage, state.hasHistory, state.turnNumber, state.storyTitle, state.guildStoryId);
  }

  const histRow = rows[0];
  state.historyPage = histPage;
  state.histChunkPage = histChunkPage;

  const histChunks = chunkEntryContent(histRow.content);
  const chunk = histChunks[histChunkPage];
  const pageLabel = histChunks.length > 1 ? ` · Page ${histChunkPage + 1} of ${histChunks.length}` : '';

  const embed = new EmbedBuilder()
    .setTitle(`Edit History — Version ${total - histPage} of ${total}${pageLabel}`)
    .setDescription(chunk.text)
    .setFooter({ text: `Edited by ${histRow.edited_by_name} · ${histRow.edited_at}` })
    .setColor(0x99aab5);

  if (histChunkPage === 0 && histChunks.length > 1) {
    embed.addFields({ name: '\u200b', value: '*This version spans multiple pages. Restoring will replace your entire current entry and will alter the story\'s turn count.*' });
  } else if (histChunkPage === 0) {
    embed.addFields({ name: '\u200b', value: '*Restoring will replace your entire current entry and will alter the story\'s turn count.*' });
  }

  const buttons = [];

  if (histPage > 0) {
    buttons.push(new ButtonBuilder().setCustomId('story_edit_history_prev').setLabel('← Newer').setStyle(ButtonStyle.Secondary));
  }
  if (histChunkPage > 0) {
    buttons.push(new ButtonBuilder().setCustomId('story_edit_hist_chunk_prev').setLabel('← Prev Page').setStyle(ButtonStyle.Secondary));
  }
  if (histChunkPage === 0) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`story_edit_restore_${histRow.edit_id}`)
      .setLabel('Restore This Version')
      .setStyle(ButtonStyle.Primary));
  }
  if (histChunkPage < histChunks.length - 1) {
    buttons.push(new ButtonBuilder().setCustomId('story_edit_hist_chunk_next').setLabel('Next Page →').setStyle(ButtonStyle.Secondary));
  }
  if (histPage < total - 1) {
    buttons.push(new ButtonBuilder().setCustomId('story_edit_history_next').setLabel('Older →').setStyle(ButtonStyle.Secondary));
  }
  buttons.push(new ButtonBuilder().setCustomId('story_edit_back').setLabel('← Back to Entry').setStyle(ButtonStyle.Secondary));

  const components = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  }

  return { embeds: [embed], components };
}

async function handleRestoreConfirm(connection, interaction, editId) {
  await interaction.deferUpdate();
  const state = pendingEditData.get(interaction.user.id);
  if (!state) return;

  const confirmText = state.entryStatus === 'deleted'
    ? 'Restore this entry to the story? It will reappear in `/story read` and exports, and will alter the story\'s turn count.'
    : 'Restore this version? This will replace your entire current entry, including content not shown on this page, and will alter the story\'s turn count.';

  const embed = new EmbedBuilder()
    .setTitle('Confirm Restore')
    .setDescription(confirmText)
    .setColor(0xff6b6b);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_edit_restore_confirm_${editId}`)
      .setLabel('Confirm Restore')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('story_edit_restore_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await state.historyMessage.edit({ embeds: [embed], components: [row] });
}

async function handleRestoreExecute(connection, interaction, editId) {
  await interaction.deferUpdate();
  const state = pendingEditData.get(interaction.user.id);
  if (!state) return;

  const [histRows] = await connection.execute(
    `SELECT content FROM story_entry_edit WHERE edit_id = ?`, [editId]
  );
  if (histRows.length === 0) {
    return await state.historyMessage.edit({ content: 'History version not found.', embeds: [], components: [] });
  }

  const editorName = interaction.member?.displayName ?? interaction.user.username;

  const txn = await connection.getConnection();
  await txn.beginTransaction();
  try {
    if (state.entryStatus === 'deleted') {
      await txn.execute(
        `UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?`,
        [state.entryId]
      );
    } else {
      const [current] = await txn.execute(
        `SELECT content FROM story_entry WHERE story_entry_id = ?`, [state.entryId]
      );
      await txn.execute(
        `INSERT INTO story_entry_edit (entry_id, content, edited_by, edited_by_name) VALUES (?, ?, ?, ?)`,
        [state.entryId, current[0].content, interaction.user.id, editorName]
      );
      await txn.execute(
        `UPDATE story_entry SET content = ? WHERE story_entry_id = ?`,
        [histRows[0].content, state.entryId]
      );
    }
    await txn.commit();
  } catch (err) {
    await txn.rollback();
    log(`handleRestoreExecute failed: ${err}`, { show: true, guildName: interaction?.guild?.name });
    throw err;
  } finally {
    txn.release();
  }

  // Close the history followUp and update the edit embed with restored content.
  await state.historyMessage?.delete().catch(() => {});
  state.historyMessage = null;
  state.currentContent = histRows[0].content;
  state.chunks = chunkEntryContent(state.currentContent);
  state.chunkPage = 0;
  state.hasHistory = true;

  const [btnRepostEntry, txtEditRestoreSuccess] = await Promise.all([
    getConfigValue(connection, 'btnRepostEntry', state.guildId),
    getConfigValue(connection, 'txtEditRestoreSuccess', state.guildId),
  ]);

  const repostRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_repost_entry_${state.entryId}`)
      .setLabel(btnRepostEntry)
      .setStyle(ButtonStyle.Secondary)
  );

  const editMsg = buildEditMessage(state.chunks, 0, true, state.turnNumber, state.storyTitle, state.guildStoryId);
  await state.originalInteraction.editReply({
    ...editMsg,
    content: txtEditRestoreSuccess,
    components: [...editMsg.components, repostRow]
  });
}

async function handleEditModalSubmit(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingEditData.get(userId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtEditSessionExpired', interaction.guild?.id ?? state?.guildId),
      flags: MessageFlags.Ephemeral
    });
  }

  const editedChunk = sanitizeModalInput(
    interaction.fields.getTextInputValue('entry_content'),
    4000, true
  );
  if (!editedChunk) {
    return await interaction.reply({ content: await getConfigValue(connection, 'txtEditEntryEmpty', state.guildId), flags: MessageFlags.Ephemeral });
  }

  // Read path: acknowledge without touching the read embed.
  // Command path: deferUpdate so the edit embed stays in place.
  if (state.fromReadPath) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else {
    await interaction.deferUpdate();
  }

  const [entryRows] = await connection.execute(
    `SELECT content FROM story_entry WHERE story_entry_id = ?`, [state.entryId]
  );
  if (entryRows.length === 0) {
    if (state.fromReadPath) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', state.guildId) });
    } else {
      await interaction.followUp({ content: await getConfigValue(connection, 'txtEditEntryNotFound', state.guildId), flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const currentContent = entryRows[0].content;
  const chunk = state.chunks[state.chunkPage];
  const newContent = currentContent.slice(0, chunk.start) + editedChunk + currentContent.slice(chunk.end);

  const editorName = interaction.member?.displayName ?? interaction.user.username;

  const txn = await connection.getConnection();
  await txn.beginTransaction();
  try {
    await txn.execute(
      `INSERT INTO story_entry_edit (entry_id, content, edited_by, edited_by_name) VALUES (?, ?, ?, ?)`,
      [state.entryId, currentContent, userId, editorName]
    );
    await txn.execute(
      `UPDATE story_entry SET content = ? WHERE story_entry_id = ?`,
      [newContent, state.entryId]
    );
    await txn.commit();
  } catch (err) {
    await txn.rollback();
    log(`handleEditModalSubmit failed: ${err}`, { show: true, guildName: interaction?.guild?.name });
    throw err;
  } finally {
    txn.release();
  }

  if (state.fromReadPath) {
    // Refresh the read embed in place with updated content; no edit embed shown.
    const session = pendingReadData.get(userId);
    if (session) {
      session.contentMap.set(state.entryId, newContent);
      session.wordCount = Array.from(session.contentMap.values())
        .reduce((total, c) => total + c.trim().split(/\s+/).filter(w => w.length > 0).length, 0);
      const readPage = session.pages[session.currentPage];
      if (readPage) {
        const freshChunks = chunkEntryContent(newContent);
        readPage.content = (freshChunks[state.chunkPage] ?? freshChunks[0]).text;
      }
      await state.originalInteraction.editReply(buildReadEmbed(session, session.currentPage));
    }
    await interaction.deleteReply();
    pendingEditData.delete(userId);
    return;
  }

  // Command path: update state with stable chunk boundaries (do NOT re-chunk from scratch,
  // as that shifts boundaries and causes orphaned content on subsequent edits).
  const delta = editedChunk.length - (chunk.end - chunk.start);
  state.chunks[state.chunkPage] = {
    text: editedChunk,
    start: chunk.start,
    end: chunk.start + editedChunk.length
  };
  for (let i = state.chunkPage + 1; i < state.chunks.length; i++) {
    state.chunks[i] = {
      ...state.chunks[i],
      start: state.chunks[i].start + delta,
      end: state.chunks[i].end + delta
    };
  }
  state.currentContent = newContent;
  state.hasHistory = true;

  const editMsg = buildEditMessage(
    state.chunks, state.chunkPage, state.hasHistory,
    state.turnNumber, state.storyTitle, state.guildStoryId
  );

  const extraButtons = [];

  const btnRepostEntry = await getConfigValue(connection, 'btnRepostEntry', state.guildId);
  extraButtons.push(
    new ButtonBuilder()
      .setCustomId(`story_repost_entry_${state.entryId}`)
      .setLabel(btnRepostEntry)
      .setStyle(ButtonStyle.Secondary)
  );

  // For admins: check if a next confirmed entry exists and offer to jump straight to editing it.
  const isAdmin = await checkIsAdmin(connection, interaction, state.guildId);
  if (isAdmin) {
    const [nextRows] = await connection.execute(
      `SELECT se.story_entry_id FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
         AND (
           SELECT COUNT(DISTINCT t2.turn_id)
           FROM turn t2
           JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
           JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
           WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
         ) = ?`,
      [state.storyId, state.turnNumber + 1]
    );
    if (nextRows.length > 0) {
      extraButtons.push(
        new ButtonBuilder()
          .setCustomId(`story_edit_next_entry_${nextRows[0].story_entry_id}`)
          .setLabel('Edit Next Entry →')
          .setStyle(ButtonStyle.Primary)
      );
    }
  }

  const extraRow = new ActionRowBuilder().addComponents(...extraButtons);
  await interaction.editReply({ ...editMsg, components: [...editMsg.components, extraRow] });
}

/**
 * Handle repost entry button — posts the current confirmed content of an entry to the story thread
 */
async function handleRepostEntry(connection, interaction) {
  await interaction.deferUpdate();

  const entryId = parseInt(interaction.customId.split('_').at(-1));

  try {
    const [rows] = await connection.execute(
      `SELECT se.content, sw.discord_display_name, s.story_thread_id, s.show_authors,
              (SELECT COUNT(DISTINCT t2.turn_id)
               FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) AS turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE se.story_entry_id = ? AND se.entry_status = 'confirmed'`,
      [entryId]
    );

    if (rows.length === 0) {
      return await interaction.editReply({
        content: await getConfigValue(connection, 'txtEditEntryNotFound', interaction.guild.id),
        components: []
      });
    }

    const { content, discord_display_name, story_thread_id, show_authors, turn_number } = rows[0];

    if (!story_thread_id) {
      return await interaction.editReply({
        content: 'Story thread not found — cannot repost.',
        components: []
      });
    }

    const storyThread = await interaction.guild.channels.fetch(story_thread_id).catch(() => null);
    if (!storyThread) {
      return await interaction.editReply({
        content: 'Story thread not found — cannot repost.',
        components: []
      });
    }

    const embed = new EmbedBuilder().setDescription(content);
    if (show_authors) {
      embed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name} *(edited)*` });
    }

    await storyThread.send({ embeds: [embed] });
    await interaction.editReply({
      content: await getConfigValue(connection, 'txtRepostSuccess', interaction.guild.id),
      components: []
    });

  } catch (error) {
    log(`Error in handleRepostEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id),
      components: []
    });
  }
}

export {
  handleEdit,
  openEditSession,
  buildEditMessage,
  handleEditButton,
  renderHistoryPage,
  handleRestoreConfirm,
  handleRestoreExecute,
  handleEditModalSubmit,
  handleRepostEntry,
};
