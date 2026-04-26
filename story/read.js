import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, resolveStoryId, chunkEntryContent, splitAtParagraphs, checkIsAdmin } from '../utilities.js';
import { generateStoryExport } from './export.js';
import { pendingReadData, lastReadPage, pendingEditData } from './state.js';
import { buildEditMessage } from './edit.js';

export { pendingReadData, lastReadPage };

// Build the pages array for a read session from raw story entries.
// editInfoMap: Map<story_entry_id, { editedByName, editedAt }> — populated by handleRead for footnotes
// hasAnyEditSet: Set<story_entry_id> — entries with any edit history (before grace-period filter)
export function buildPages(entries, showAuthors, editInfoMap = new Map(), hasAnyEditSet = new Set()) {
  const pages = [];
  // Group raw entry rows by turn number
  const turnMap = new Map();
  for (const row of entries) {
    if (!turnMap.has(row.turn_number)) {
      turnMap.set(row.turn_number, {
        turnNumber: row.turn_number,
        writerName: row.discord_display_name,
        parts: [],
        storyEntryId: row.story_entry_id,
        originalAuthorId: String(row.original_author_id),
        createdAt: row.created_at
      });
    }
    turnMap.get(row.turn_number).parts.push(row.content.trim());
  }
  for (const turn of turnMap.values()) {
    const fullContent = turn.parts.join('\n\n');
    const chunks = splitAtParagraphs(fullContent);
    chunks.forEach((chunk, i) => {
      pages.push({
        turnNumber: turn.turnNumber,
        writerName: showAuthors ? turn.writerName : null,
        content: chunk,
        partIndex: chunks.length > 1 ? i + 1 : null,
        partCount: chunks.length > 1 ? chunks.length : null,
        storyEntryId: turn.storyEntryId,
        originalAuthorId: turn.originalAuthorId,
        createdAt: turn.createdAt,
        isFirstChunk: i === 0,
        hasHistory: hasAnyEditSet.has(turn.storyEntryId),
        editInfo: i === 0 ? (editInfoMap.get(turn.storyEntryId) ?? null) : null
      });
    });
  }
  return pages;
}

// Build the embed + navigation buttons for a given page index.
export function buildReadEmbed(session, pageIndex) {
  const page = session.pages[pageIndex];
  const totalPages = session.pages.length;

  let turnLabel = `Turn ${page.turnNumber}`;
  if (page.writerName) turnLabel += ` — ${page.writerName}`;
  if (page.partIndex) turnLabel += ` (part ${page.partIndex}/${page.partCount})`;

  let description = page.content;
  if (page.editInfo) {
    description += `\n\n*edited by ${page.editInfo.editedByName} · ${page.editInfo.editedAt}*`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📖 ${session.title}`)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: `${turnLabel} · Page ${pageIndex + 1} of ${totalPages} · ~${session.wordCount.toLocaleString()} words total` });

  // Edit button appears between ← Previous and Next → when the user can edit this entry
  const canEdit = page.isFirstChunk && (
    session.isAdmin || page.originalAuthorId === session.userId
  );

  // Row 1: navigation — << -10 | ← Prev | [Edit] | Next → | +10 >>
  const navButtons = [
    new ButtonBuilder()
      .setCustomId('story_read_back10')
      .setLabel('«')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex === 0),
    new ButtonBuilder()
      .setCustomId('story_read_prev')
      .setLabel('← Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex === 0),
  ];
  if (canEdit) {
    navButtons.push(
      new ButtonBuilder()
        .setCustomId(`story_read_edit_${page.storyEntryId}`)
        .setLabel('Edit')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  navButtons.push(
    new ButtonBuilder()
      .setCustomId('story_read_next')
      .setLabel('Next →')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex === totalPages - 1),
    new ButtonBuilder()
      .setCustomId('story_read_fwd10')
      .setLabel('»')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex >= totalPages - 1)
  );

  const components = [new ActionRowBuilder().addComponents(...navButtons)];

  // Row 2: Jump to Page select menu — up to 25 options centered around current page
  if (totalPages > 1) {
    const maxOptions = 25;
    let rangeStart = Math.max(0, pageIndex - Math.floor(maxOptions / 2));
    const rangeEnd = Math.min(totalPages, rangeStart + maxOptions);
    rangeStart = Math.max(0, rangeEnd - maxOptions);

    const options = [];
    for (let i = rangeStart; i < rangeEnd; i++) {
      const p = session.pages[i];
      const label = `Page ${i + 1} — Turn ${p.turnNumber}${p.writerName ? ` (${p.writerName})` : ''}`.slice(0, 100);
      options.push({ label, value: String(i), default: i === pageIndex });
    }

    const jumpMenu = new StringSelectMenuBuilder()
      .setCustomId('story_read_jump')
      .setPlaceholder(`Page ${pageIndex + 1} of ${totalPages}`)
      .addOptions(options);

    components.push(new ActionRowBuilder().addComponents(jumpMenu));
  }

  // Row 3: utility actions
  const utilityButtons = [
    new ButtonBuilder()
      .setCustomId('story_read_download')
      .setLabel('⬇ Export Story')
      .setStyle(ButtonStyle.Secondary)
  ];
  if (session.pendingRepostEntryId && session.pendingRepostEntryId === page.storyEntryId && page.isFirstChunk) {
    utilityButtons.push(
      new ButtonBuilder()
        .setCustomId(`story_repost_entry_${session.pendingRepostEntryId}`)
        .setLabel(session.btnRepostEntry)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  components.push(new ActionRowBuilder().addComponents(...utilityButtons));

  return { embeds: [embed], components };
}

export async function handleRead(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT title, show_authors, guild_story_id FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    const [entries] = await connection.execute(
      `SELECT se.content, se.story_entry_id, se.created_at, sw.discord_user_id AS original_author_id,
              (SELECT COUNT(DISTINCT t2.turn_id)
               FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) AS turn_number,
              sw.discord_display_name
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
       ORDER BY t.started_at`,
      [storyId]
    );

    if (entries.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNoConfirmedEntries', guildId) });
    }

    // Batched query for edit footnotes — one query for all entries, avoids per-entry lookups
    const editInfoMap = new Map();
    let hasAnyEditSet = new Set();
    const entryIds = entries.map(e => e.story_entry_id);
    if (entryIds.length > 0) {
      const placeholders = entryIds.map(() => '?').join(',');
      const [editRows] = await connection.execute(
        `SELECT see.entry_id, see.edited_by, see.edited_by_name, see.edited_at
         FROM story_entry_edit see
         INNER JOIN (
           SELECT entry_id, MAX(edited_at) AS max_edited_at
           FROM story_entry_edit
           WHERE entry_id IN (${placeholders})
           GROUP BY entry_id
         ) latest ON see.entry_id = latest.entry_id AND see.edited_at = latest.max_edited_at`,
        entryIds
      );
      // Build hasAnyEditSet from raw rows before grace-period filter so History button is accurate
      hasAnyEditSet = new Set(editRows.map(r => r.entry_id));
      for (const row of editRows) {
        hasAnyEditSet.add(row.entry_id); // track before grace-period filter
        const entry = entries.find(e => e.story_entry_id === row.entry_id);
        if (!entry) continue;
        const createdMs = new Date(entry.created_at).getTime();
        const editedMs  = new Date(row.edited_at).getTime();
        const isGrace = String(row.edited_by) === String(entry.original_author_id) &&
                        (editedMs - createdMs) <= 60 * 60 * 1000;
        if (!isGrace) {
          editInfoMap.set(row.entry_id, { editedByName: row.edited_by_name, editedAt: row.edited_at });
        }
      }
    }

    // Build content map for read-path edit session (entryId → full content string)
    const contentMap = new Map();
    for (const entry of entries) {
      contentMap.set(entry.story_entry_id, entry.content);
    }

    // Check admin status for contextual Edit button in buildReadEmbed
    const isAdmin = await checkIsAdmin(connection, interaction, guildId);

    const wordCount = entries.reduce((total, e) => total + e.content.trim().split(/\s+/).length, 0);
    const pages = buildPages(entries, story.show_authors, editInfoMap, hasAnyEditSet);

    const savedPage = lastReadPage.get(`${interaction.user.id}_${storyId}`) ?? 0;
    const startPage = Math.min(savedPage, pages.length - 1);

    const session = { pages, contentMap, currentPage: startPage, storyId, guildStoryId: story.guild_story_id, title: story.title, wordCount, guildId, userId: interaction.user.id, isAdmin };
    pendingReadData.set(interaction.user.id, session);

    await interaction.editReply(buildReadEmbed(session, startPage));
  } catch (error) {
    log(`Error in handleRead: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export async function handleReadEditButton(connection, interaction, session, entryId) {
  // Load state entirely from the read session — no DB query needed, so showModal can be
  // the first (and only) response to this interaction within the 3-second window.
  const page = session.pages.find(p => p.storyEntryId === entryId && p.isFirstChunk);
  const fullContent = session.contentMap?.get(entryId) ?? null;

if (!page || fullContent === null) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtReadEntryNotFound', session?.guildId ?? interaction.guild.id), flags: MessageFlags.Ephemeral });
    return;
  }

  const chunks = chunkEntryContent(fullContent);
  const storyTitle = session.title.length > 50 ? session.title.slice(0, 50) + '…' : session.title;

  const isMultiChunk = chunks.length > 1;

  pendingEditData.set(interaction.user.id, {
    entryId,
    entryStatus: 'confirmed',
    storyId: session.storyId,
    guildId: session.guildId,
    originalAuthorId: page.originalAuthorId,
    createdAt: null,
    currentContent: fullContent,
    chunks,
    chunkPage: 0,
    hasHistory: page.hasHistory,
    historyPage: 0,
    turnNumber: page.turnNumber,
    storyTitle,
    guildStoryId: session.guildStoryId,
    originalInteraction: interaction,
    fromReadPath: !isMultiChunk,
  });

  if (isMultiChunk) {
    // Multi-chunk: show the paginated edit embed so all pages are reachable
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(
      buildEditMessage(chunks, 0, page.hasHistory, page.turnNumber, storyTitle, session.guildStoryId)
    );
  } else {
    // Single chunk: open modal directly — no embed needed
    // No defer — showModal must be the first response
    // Use entryId in customId to prevent Discord from caching modal content across entries
    const modal = new ModalBuilder()
      .setCustomId(`story_edit_modal_${entryId}`)
      .setTitle('Edit Entry');
    const input = new TextInputBuilder()
      .setCustomId('entry_content')
      .setLabel('Entry content')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setValue(chunks[0].text.slice(0, 4000))
      .setPlaceholder('Edit this section. If you hit the character limit, save and return to continue on the next page.');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }
}

export async function handleReadNav(connection, interaction) {
  const userId = interaction.user.id;
  const session = pendingReadData.get(userId);

  if (!session) {
    await interaction.update({ content: await getConfigValue(connection, 'txtReadSessionExpired', interaction.guild.id), embeds: [], components: [] });
    return;
  }

  // story_read_edit_<entryId> — opens edit session; full handler wired in Step 4
  if (interaction.customId.startsWith('story_read_edit_')) {
    const entryId = interaction.customId.split('_').at(-1); // keep as string — DB returns BIGINT as string (bigNumberStrings: true)
    await handleReadEditButton(connection, interaction, session, entryId);
    return;
  }

  if (interaction.customId === 'story_read_download') {
    await interaction.deferUpdate();
    try {
      const result = await generateStoryExport(connection, session.storyId, session.guildId, interaction.guild);
      if (result?.hasEntries) {
        const [ao3Instructions, btnPostLabel] = await Promise.all([
          getConfigValue(connection, 'txtExportAO3Instructions', session.guildId),
          getConfigValue(connection, 'btnExportPostPublicly', session.guildId),
        ]);
        const postBtn = new ButtonBuilder()
          .setCustomId(`story_read_post_public_${session.storyId}`)
          .setLabel(btnPostLabel)
          .setStyle(ButtonStyle.Secondary);
        const btnRow = new ActionRowBuilder().addComponents(postBtn);
        await interaction.followUp({
          content: ao3Instructions,
          files: [{ attachment: result.buffer, name: result.filename }],
          components: [btnRow],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      log(`Error generating HTML export from read session: ${err}`, { show: true, guildName: interaction?.guild?.name });
    }
    return;
  }

  if (interaction.customId === 'story_read_prev') {
    session.currentPage = Math.max(0, session.currentPage - 1);
  } else if (interaction.customId === 'story_read_next') {
    session.currentPage = Math.min(session.pages.length - 1, session.currentPage + 1);
  } else if (interaction.customId === 'story_read_back10') {
    session.currentPage = Math.max(0, session.currentPage - 10);
  } else if (interaction.customId === 'story_read_fwd10') {
    session.currentPage = Math.min(session.pages.length - 1, session.currentPage + 10);
  } else if (interaction.customId === 'story_read_jump') {
    const selected = parseInt(interaction.values[0]);
    if (!isNaN(selected)) session.currentPage = Math.min(session.pages.length - 1, Math.max(0, selected));
  }

  lastReadPage.set(`${userId}_${session.storyId}`, session.currentPage);
  await interaction.update(buildReadEmbed(session, session.currentPage));
}
