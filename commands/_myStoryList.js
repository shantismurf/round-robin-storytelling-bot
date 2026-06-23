import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId, splitAtParagraphs, storyLastActivitySQL } from '../utilities.js';
import { getStoriesPaginated } from '../story/list.js';
import { ratingBadge } from '../story/_metadata.js';

const LIST_PAGE_SIZE = 5;
const WIDE_SPACE = '　'; // unicode full-width space for field value indent

// Mode icons — defined here as UI chrome (not config strings per style standard)
const MODE_ICON = { 1: '🟣', 2: '🔵' }; // Quick=purple, Slow=blue, Normal=green (default)
const MODE_ICON_DEFAULT = '🟢';

// Cached list pages keyed by "list_<userId>_<view>"
// Cached catchup pages keyed by "catchup_<userId>_<storyId>"
export const pendingCatchUpData = new Map();

// ─── /mystory list ───────────────────────────────────────────────────────────

export async function handleList(connection, interaction, view = 'active') {
  log(`handleList: entry user=${interaction.user.username} view=${view}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const page = Math.max(1, interaction.options?.getInteger?.('page') ?? 1);

  try {
    const listCfg = await getConfigValue(connection, [
      'txtModeQuick', 'txtModeNormal', 'txtModeSlow',
      'txtActive', 'txtPaused', 'txtDelayed', 'txtClosed',
      'txtMyListTitleActive', 'txtMyListTitlePaused', 'txtMyListTitleClosed', 'txtMyListTitleJoinable',
      'txtMyListNoneActive', 'txtMyListNonePaused', 'txtMyListNoneClosed', 'txtMyListNoneJoinable',
      'txtMyListMyTurn', 'txtMyListOthersTurn', 'txtMyListNoActiveTurn',
      'txtMyListStats', 'txtMyListNoEntries', 'txtMyListPausedSuffix',
      'btnMyListViewActive', 'btnMyListViewPaused', 'btnMyListViewClosed', 'btnMyListViewJoinable',
      'btnPrev', 'btnNext',
      ...Object.values(ratingBadge),
    ], guildId);

    await renderListView(connection, interaction, view, page, guildId, userId, listCfg);

  } catch (error) {
    log(`handleList failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function renderListView(connection, interaction, view, page, guildId, userId, listCfg) {
  log(`renderListView: view=${view} page=${page}`, { show: false, guildName: interaction?.guild?.name });

  if (view === 'joinable') {
    await renderJoinableView(connection, interaction, page, guildId, userId, listCfg);
    return;
  }

  const stories = await fetchStoriesForView(connection, userId, guildId, view);
  log(`renderListView: fetched ${stories.length} stories for view=${view}`, { show: false, guildName: interaction?.guild?.name });

  const noneKey = { active: 'txtMyListNoneActive', paused: 'txtMyListNonePaused', closed: 'txtMyListNoneClosed' }[view];
  if (stories.length === 0) {
    const toggleRow = buildViewToggleRow(view, listCfg);
    return await interaction.editReply({ content: listCfg[noneKey], embeds: [], components: [toggleRow] });
  }

  const totalPages = Math.ceil(stories.length / LIST_PAGE_SIZE);
  const clampedPage = Math.min(Math.max(page, 1), totalPages);
  const pageStories = stories.slice((clampedPage - 1) * LIST_PAGE_SIZE, clampedPage * LIST_PAGE_SIZE);

  const storyIds = pageStories.map(s => s.story_id);
  const activeTurnMap = await fetchActiveTurnsForStories(connection, storyIds, userId);

  const embed = buildListEmbed(pageStories, clampedPage, totalPages, view, listCfg, activeTurnMap);
  const components = [buildViewToggleRow(view, listCfg)];
  if (totalPages > 1) {
    components.push(buildListNavRow(clampedPage, totalPages, view, listCfg));
    pendingCatchUpData.set(`list_${userId}_${view}`, { stories, listCfg, view });
  }

  await interaction.editReply({ embeds: [embed], components });
}

async function fetchStoriesForView(connection, userId, guildId, view) {
  const baseSelect = `
    SELECT s.story_id, s.guild_story_id, s.title, s.story_status, s.mode,
           sw.sw_status as writer_status,
           COUNT(DISTINCT t.turn_id) as my_turn_count,
           COALESCE(SUM(LENGTH(se.content) - LENGTH(REPLACE(se.content, ' ', '')) + 1), 0) as my_word_count,
           (SELECT COUNT(DISTINCT t3.turn_id) FROM turn t3
            JOIN story_writer sw3 ON t3.story_writer_id = sw3.story_writer_id
            JOIN story_entry se3 ON se3.turn_id = t3.turn_id AND se3.entry_status = 'confirmed'
            WHERE sw3.story_id = s.story_id) as total_turn_count,
           COALESCE((SELECT SUM(LENGTH(se2.content) - LENGTH(REPLACE(se2.content, ' ', '')) + 1)
            FROM story_entry se2
            JOIN turn t2 ON se2.turn_id = t2.turn_id
            JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
            WHERE sw2.story_id = s.story_id AND se2.entry_status = 'confirmed'), 0) as total_word_count
    FROM story_writer sw
    JOIN story s ON sw.story_id = s.story_id
    LEFT JOIN turn t ON t.story_writer_id = sw.story_writer_id AND t.turn_status = 0
    LEFT JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
    WHERE sw.discord_user_id = ? AND s.guild_id = ?`;

  let whereExtra, orderBy;

  if (view === 'active') {
    whereExtra = `AND s.story_status = 1 AND sw.sw_status = 1`;
    orderBy = `ORDER BY ${storyLastActivitySQL()} DESC`;
  } else if (view === 'paused') {
    whereExtra = `AND s.story_status IN (0, 2, 4) AND sw.sw_status != 0`;
    orderBy = `ORDER BY CASE s.story_status WHEN 2 THEN 0 WHEN 4 THEN 1 ELSE 2 END ASC, ${storyLastActivitySQL()} DESC`;
  } else {
    whereExtra = `AND (s.story_status = 3 OR sw.sw_status = 0)`;
    orderBy = `ORDER BY ${storyLastActivitySQL()} DESC`;
  }

  const [rows] = await connection.execute(
    `${baseSelect} ${whereExtra} GROUP BY s.story_id, sw.sw_status ${orderBy}`,
    [userId, guildId]
  );
  return rows;
}

async function fetchActiveTurnsForStories(connection, storyIds, userId) {
  const map = new Map();
  if (storyIds.length === 0) return map;
  const placeholders = storyIds.map(() => '?').join(',');
  const [turns] = await connection.execute(
    `SELECT sw.story_id, sw.discord_display_name, sw.discord_user_id, t.turn_ends_at
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id IN (${placeholders}) AND t.turn_status = 1`,
    storyIds
  );
  for (const t of turns) {
    map.set(t.story_id, {
      writer_name: t.discord_display_name,
      turn_ends_at: t.turn_ends_at,
      is_user_turn: t.discord_user_id === userId,
    });
  }
  return map;
}

function buildListEmbed(pageStories, page, totalPages, view, listCfg, activeTurnMap) {
  const titleKey = { active: 'txtMyListTitleActive', paused: 'txtMyListTitlePaused', closed: 'txtMyListTitleClosed' }[view];
  const title = replaceTemplateVariables(listCfg[titleKey], { page, total: totalPages });
  const embed = new EmbedBuilder().setTitle(title).setColor(0x5865f2).setTimestamp();

  const modeIcon = m => MODE_ICON[m] ?? MODE_ICON_DEFAULT;
  const modeLabel = m => m === 1 ? listCfg.txtModeQuick : m === 2 ? listCfg.txtModeSlow : listCfg.txtModeNormal;
  const statusText = s => {
    if (s === 1) return listCfg.txtActive;
    if (s === 2) return listCfg.txtPaused;
    if (s === 0 || s === 4) return listCfg.txtDelayed;
    return listCfg.txtClosed;
  };

  for (const story of pageStories) {
    const writerPaused = story.writer_status === 2 ? ` · ${listCfg.txtMyListPausedSuffix}` : '';
    const fieldName = `${modeIcon(story.mode)} ${story.title} (#${story.guild_story_id}) · ${modeLabel(story.mode)} · ${statusText(story.story_status)}${writerPaused}`;

    const activeTurn = activeTurnMap.get(story.story_id);
    let turnLine;
    if (!activeTurn) {
      turnLine = listCfg.txtMyListNoActiveTurn;
    } else if (activeTurn.is_user_turn) {
      const endsAt = new Date(activeTurn.turn_ends_at);
      const unix = Math.floor(endsAt.getTime() / 1000);
      turnLine = replaceTemplateVariables(listCfg.txtMyListMyTurn, {
        deadline_relative: `<t:${unix}:R>`,
        deadline_date: `<t:${unix}:D>`,
      });
    } else {
      const endsAt = new Date(activeTurn.turn_ends_at);
      const unix = Math.floor(endsAt.getTime() / 1000);
      turnLine = replaceTemplateVariables(listCfg.txtMyListOthersTurn, {
        writer_name: activeTurn.writer_name,
        deadline_relative: `<t:${unix}:R>`,
      });
    }

    const hasActivity = story.my_turn_count > 0 || Number(story.my_word_count) > 0;
    let statsLine;
    if (!hasActivity) {
      statsLine = listCfg.txtMyListNoEntries;
    } else {
      const totalWords = Number(story.total_word_count ?? 0).toLocaleString();
      statsLine = replaceTemplateVariables(listCfg.txtMyListStats, {
        my_turns: story.my_turn_count,
        total_turns: story.total_turn_count,
        my_words: Number(story.my_word_count).toLocaleString(),
        total_words: totalWords,
      });
    }

    embed.addFields({
      name: fieldName,
      value: `${WIDE_SPACE}${WIDE_SPACE}${turnLine}\n${WIDE_SPACE}${WIDE_SPACE}${statsLine}`,
      inline: false,
    });
  }
  return embed;
}

function buildViewToggleRow(currentView, listCfg) {
  const views = [
    { id: 'active',   label: listCfg.btnMyListViewActive,   style: ButtonStyle.Success },
    { id: 'paused',   label: listCfg.btnMyListViewPaused,   style: ButtonStyle.Secondary },
    { id: 'closed',   label: listCfg.btnMyListViewClosed,   style: ButtonStyle.Danger },
    { id: 'joinable', label: listCfg.btnMyListViewJoinable, style: ButtonStyle.Primary },
  ];
  return new ActionRowBuilder().addComponents(
    views.map(v =>
      new ButtonBuilder()
        .setCustomId(`mystory_list_view_${v.id}`)
        .setLabel(v.label)
        .setStyle(v.style)
        .setDisabled(v.id === currentView)
    )
  );
}

function buildListNavRow(page, totalPages, view, listCfg) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mystory_list_${view}_prev_${page}`)
      .setLabel(listCfg.btnPrev)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(`mystory_list_${view}_next_${page}`)
      .setLabel(listCfg.btnNext)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages)
  );
}

export async function handleViewToggle(connection, interaction) {
  log(`handleViewToggle: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const view = interaction.customId.split('_')[3];
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  for (const key of pendingCatchUpData.keys()) {
    if (key.startsWith(`list_${userId}_`)) pendingCatchUpData.delete(key);
  }

  try {
    const listCfg = await getConfigValue(connection, [
      'txtModeQuick', 'txtModeNormal', 'txtModeSlow',
      'txtActive', 'txtPaused', 'txtDelayed', 'txtClosed',
      'txtMyListTitleActive', 'txtMyListTitlePaused', 'txtMyListTitleClosed', 'txtMyListTitleJoinable',
      'txtMyListNoneActive', 'txtMyListNonePaused', 'txtMyListNoneClosed', 'txtMyListNoneJoinable',
      'txtMyListMyTurn', 'txtMyListOthersTurn', 'txtMyListNoActiveTurn',
      'txtMyListStats', 'txtMyListNoEntries', 'txtMyListPausedSuffix',
      'btnMyListViewActive', 'btnMyListViewPaused', 'btnMyListViewClosed', 'btnMyListViewJoinable',
      'btnPrev', 'btnNext',
      ...Object.values(ratingBadge),
    ], guildId);

    await renderListView(connection, interaction, view, 1, guildId, userId, listCfg);
  } catch (error) {
    log(`handleViewToggle failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), embeds: [], components: [] });
  }
}

export async function handleListNavigation(connection, interaction) {
  log(`handleListNavigation: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const parts = interaction.customId.split('_');
  const view = parts[3];
  const direction = parts[4];
  const currentPage = parseInt(parts[5]);
  const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  const cached = pendingCatchUpData.get(`list_${userId}_${view}`);
  if (!cached) {
    const toggleRow = buildViewToggleRow(view, await getConfigValue(connection, [
      'btnMyListViewActive', 'btnMyListViewPaused', 'btnMyListViewClosed', 'btnMyListViewJoinable',
    ], guildId));
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtCatchupSessionExpired', guildId), embeds: [], components: [toggleRow] });
  }

  const { stories, listCfg } = cached;
  const totalPages = Math.ceil(stories.length / LIST_PAGE_SIZE);
  const clampedPage = Math.min(Math.max(newPage, 1), totalPages);
  const pageStories = stories.slice((clampedPage - 1) * LIST_PAGE_SIZE, clampedPage * LIST_PAGE_SIZE);

  const storyIds = pageStories.map(s => s.story_id);
  const activeTurnMap = await fetchActiveTurnsForStories(connection, storyIds, userId);

  const embed = buildListEmbed(pageStories, clampedPage, totalPages, view, listCfg, activeTurnMap);
  const components = [buildViewToggleRow(view, listCfg)];
  if (totalPages > 1) components.push(buildListNavRow(clampedPage, totalPages, view, listCfg));
  await interaction.editReply({ embeds: [embed], components });
}

async function renderJoinableView(connection, interaction, page, guildId, userId, listCfg) {
  log(`renderJoinableView: page=${page}`, { show: false, guildName: interaction?.guild?.name });
  const stories = await getStoriesPaginated(connection, guildId, 'joinable', page, LIST_PAGE_SIZE, userId);

  const toggleRow = buildViewToggleRow('joinable', listCfg);

  if (stories.data.length === 0) {
    return await interaction.editReply({ content: listCfg.txtMyListNoneJoinable, embeds: [], components: [toggleRow] });
  }

  const title = replaceTemplateVariables(listCfg.txtMyListTitleJoinable, { page, total: stories.totalPages });
  const embed = new EmbedBuilder().setTitle(title).setColor(0x5865f2).setTimestamp();

  const storyIds = stories.data.map(s => s.story_id);
  const activeTurnMap = new Map();
  if (storyIds.length > 0) {
    const placeholders = storyIds.map(() => '?').join(',');
    const [turns] = await connection.execute(
      `SELECT sw.story_id, sw.discord_display_name, t.turn_ends_at
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id IN (${placeholders}) AND t.turn_status = 1`,
      storyIds
    );
    for (const t of turns) activeTurnMap.set(t.story_id, t);
  }

  const statusTextMap = { 1: listCfg.txtActive, 2: listCfg.txtPaused, 3: listCfg.txtClosed, 4: listCfg.txtDelayed };
  for (const story of stories.data) {
    const modeText = story.mode === 1 ? listCfg.txtModeQuick : story.mode === 2 ? listCfg.txtModeSlow : listCfg.txtModeNormal;
    const ratingBadgeCfgKey = ratingBadge[story.rating] ?? 'txtRatingBadgeNR';
    const turn = activeTurnMap.get(story.story_id);
    let turnLine;
    if (!turn) {
      turnLine = listCfg.txtMyListNoActiveTurn;
    } else {
      const unix = Math.floor(new Date(turn.turn_ends_at).getTime() / 1000);
      turnLine = replaceTemplateVariables(listCfg.txtMyListOthersTurn, {
        writer_name: turn.discord_display_name,
        deadline_relative: `<t:${unix}:R>`,
      });
    }
    embed.addFields({
      name: `${MODE_ICON[story.mode] ?? MODE_ICON_DEFAULT} ${story.title} (#${story.guild_story_id}) · ${modeText} · ${statusTextMap[story.story_status] ?? '—'} ${listCfg[ratingBadgeCfgKey] ?? ''}`,
      value: `${WIDE_SPACE}${WIDE_SPACE}${turnLine}\n${WIDE_SPACE}${WIDE_SPACE}${story.writer_count}/${story.max_writers || '∞'} writers · ${story.creator_name}`,
      inline: false,
    });
  }

  const components = [toggleRow];
  if (stories.totalPages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mystory_list_joinable_prev_${page}`)
        .setLabel(listCfg.btnPrev)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`mystory_list_joinable_next_${page}`)
        .setLabel(listCfg.btnNext)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === stories.totalPages)
    ));
  }

  const joinableStories = stories.data.filter(s => s.join_status === 1);
  if (joinableStories.length > 0) {
    const joinRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('story_quick_join')
        .setPlaceholder(await getConfigValue(connection, 'txtQuickJoinPlaceholder', guildId))
        .addOptions(joinableStories.map(s => ({
          label: `${s.title} (#${s.guild_story_id})`,
          value: s.story_id.toString(),
          description: `${s.writer_count}/${s.max_writers || '∞'} writers · ${s.mode === 1 ? listCfg.txtModeQuick : s.mode === 2 ? listCfg.txtModeSlow : listCfg.txtModeNormal}`,
        })))
    );
    components.push(joinRow);
  }

  await interaction.editReply({ embeds: [embed], components });
}

// ─── /mystory catchup ────────────────────────────────────────────────────────

export async function handleCatchUp(connection, interaction) {
  log(`handleCatchUp: entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }
  const userId = interaction.user.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    const [lastTurnRows] = await connection.execute(
      `SELECT t.started_at FROM turn t
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 0
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId, userId]
    );

    const afterTime = lastTurnRows.length > 0 ? lastTurnRows[0].started_at : new Date(0);
    const [entries] = await connection.execute(
      `SELECT se.content, sw.discord_display_name,
              (SELECT COUNT(DISTINCT t2.turn_id) FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed' AND t.started_at >= ?
       ORDER BY t.started_at`,
      [storyId, afterTime]
    );

    if (entries.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtCatchupNoEntries', guildId) });
    }

    const catchupCfg = await getConfigValue(connection, [
      'txtCatchupIntro', 'txtCatchupIntroNoTurns', 'txtCatchupNavHeader',
      'txtCatchupTurnHeader', 'btnPrev', 'btnNext',
    ], guildId);

    const pages = [];
    let currentTurn = null;
    let currentWriterName = null;
    let currentEmbed = null;
    let currentText = '';

    const flushCurrentTurn = () => {
      if (!currentEmbed) return;
      const chunks = splitAtParagraphs(currentText.trim());
      for (const [i, chunk] of chunks.entries()) {
        const e = i === 0 ? currentEmbed : new EmbedBuilder()
          .setAuthor({ name: replaceTemplateVariables(catchupCfg.txtCatchupTurnHeader, { turn_number: currentTurn, writer_name: currentWriterName }) });
        pages.push(e.setDescription(chunk));
      }
    };

    for (const entry of entries) {
      if (entry.turn_number !== currentTurn) {
        flushCurrentTurn();
        currentTurn = entry.turn_number;
        currentWriterName = entry.discord_display_name;
        currentText = '';
        currentEmbed = new EmbedBuilder()
          .setAuthor({ name: replaceTemplateVariables(catchupCfg.txtCatchupTurnHeader, { turn_number: entry.turn_number, writer_name: entry.discord_display_name }) });
      }
      currentText += entry.content + '\n\n';
    }
    flushCurrentTurn();

    const totalPages = pages.length;
    const storyTitle = storyRows[0].title;
    const introKey = lastTurnRows.length > 0 ? 'txtCatchupIntro' : 'txtCatchupIntroNoTurns';
    const intro = replaceTemplateVariables(catchupCfg[introKey], { story_title: storyTitle, turn_count: totalPages });

    if (totalPages === 1) {
      return await interaction.editReply({ content: intro, embeds: [pages[0]] });
    }

    const navRow = buildCatchUpNavRow(0, totalPages, catchupCfg);
    const catchUpKey = `catchup_${userId}_${storyId}`;
    pendingCatchUpData.set(catchUpKey, { pages, storyTitle, catchupCfg });

    const firstPageContent = replaceTemplateVariables(catchupCfg.txtCatchupNavHeader, { story_title: storyTitle, page: 1, total: totalPages });
    await interaction.editReply({ content: `${intro}\n${firstPageContent}`, embeds: [pages[0]], components: [navRow] });

  } catch (error) {
    log(`handleCatchUp failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export async function handleCatchUpNavigation(connection, interaction) {
  log(`handleCatchUpNavigation: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const [, action, currentPageStr] = interaction.customId.split('_');
  const currentPage = parseInt(currentPageStr);
  const newPage = action === 'next' ? currentPage + 1 : currentPage - 1;

  const catchUpKey = [...pendingCatchUpData.keys()].find(k => k.startsWith(`catchup_${interaction.user.id}_`));
  if (!catchUpKey) {
    const msg = await getConfigValue(connection, 'txtCatchupSessionExpired', interaction.guild.id);
    return await interaction.editReply({ content: msg, embeds: [], components: [] });
  }

  const { pages, storyTitle, catchupCfg } = pendingCatchUpData.get(catchUpKey);
  const totalPages = pages.length;
  const navRow = buildCatchUpNavRow(newPage, totalPages, catchupCfg);
  const navHeader = replaceTemplateVariables(catchupCfg.txtCatchupNavHeader, { story_title: storyTitle, page: newPage + 1, total: totalPages });

  await interaction.editReply({
    content: navHeader,
    embeds: [pages[newPage]],
    components: [navRow]
  });
}

function buildCatchUpNavRow(currentPage, totalPages, catchupCfg) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`catchup_prev_${currentPage}`)
      .setLabel(catchupCfg.btnPrev)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`catchup_next_${currentPage}`)
      .setLabel(catchupCfg.btnNext)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1)
  );
}
