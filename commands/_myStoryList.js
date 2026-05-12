import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId } from '../utilities.js';

const LIST_PAGE_SIZE = 5;

// Cached list pages keyed by "list_<userId>"
// Cached catchup pages keyed by "catchup_<userId>_<storyId>"
export const pendingCatchUpData = new Map();

// ─── /mystory list ───────────────────────────────────────────────────────────

export async function handleList(connection, interaction) {
  log(`handleList: entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const page = Math.max(1, interaction.options.getInteger('page') ?? 1);

  try {
    const [stories] = await connection.execute(
      `SELECT s.story_id, s.guild_story_id, s.title, s.story_status, s.mode,
              sw.sw_status as writer_status,
              COUNT(DISTINCT t.turn_id) as my_turn_count,
              COALESCE(SUM(LENGTH(se.content) - LENGTH(REPLACE(se.content, ' ', '')) + 1), 0) as my_word_count,
              UNIX_TIMESTAMP(MIN(t.started_at)) as my_first_turn_unix,
              UNIX_TIMESTAMP(MAX(t.ended_at)) as my_last_turn_unix,
              UNIX_TIMESTAMP(s.created_at) as created_at_unix,
              (SELECT COUNT(DISTINCT t3.turn_id) FROM turn t3
               JOIN story_writer sw3 ON t3.story_writer_id = sw3.story_writer_id
               JOIN story_entry se3 ON se3.turn_id = t3.turn_id AND se3.entry_status = 'confirmed'
               WHERE sw3.story_id = s.story_id) as total_turn_count
       FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       LEFT JOIN turn t ON t.story_writer_id = sw.story_writer_id AND t.turn_status = 0
       LEFT JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
       WHERE sw.discord_user_id = ? AND s.guild_id = ?
       GROUP BY s.story_id, sw.sw_status
       ORDER BY
         CASE WHEN sw.sw_status IN (1, 2) AND s.story_status != 3 THEN 0 ELSE 1 END ASC,
         CASE s.story_status WHEN 1 THEN 0 WHEN 2 THEN 1 WHEN 0 THEN 2 ELSE 3 END ASC,
         s.created_at DESC`,
      [userId, guildId]
    );
    log(`handleList: fetched ${stories.length} stories`, { show: false, guildName: interaction?.guild?.name });

    if (stories.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtMyListNone', guildId) });
    }

    const totalPages = Math.ceil(stories.length / LIST_PAGE_SIZE);
    const clampedPage = Math.min(page, totalPages);
    const pageStart = (clampedPage - 1) * LIST_PAGE_SIZE;
    const pageStories = stories.slice(pageStart, pageStart + LIST_PAGE_SIZE);

    const listCfg = await getConfigValue(connection, [
      'txtModeQuick', 'txtModeNormal', 'txtModeSlow', 'txtMyListTitle',
      'txtActive', 'txtPaused', 'txtDelayed', 'txtClosed',
      'txtMyListJoined', 'txtMyListMyStats', 'txtMyListNoTurns',
      'txtMyListStoryTotal', 'txtMyListPausedSuffix',
      'btnPrev', 'btnNext',
    ], guildId);

    const embed = buildListEmbed(pageStories, clampedPage, totalPages, listCfg);
    const components = [];
    if (totalPages > 1) {
      components.push(buildListNavRow(clampedPage, totalPages, listCfg));
      pendingCatchUpData.set(`list_${userId}`, { stories, listCfg });
    }

    await interaction.editReply({ embeds: [embed], components });

  } catch (error) {
    log(`handleList failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

function buildListEmbed(pageStories, clampedPage, totalPages, listCfg) {
  const fmt = unix => unix ? `<t:${unix}:d>` : null;
  const statusIcon = s => s === 1 ? '🟢' : s === 2 ? '⏸️' : s === 0 ? '⏳' : '🏁';
  const statusText = s => {
    if (s === 1) return listCfg.txtActive;
    if (s === 2) return listCfg.txtPaused;
    if (s === 0) return listCfg.txtDelayed;
    return listCfg.txtClosed;
  };

  const title = replaceTemplateVariables(listCfg.txtMyListTitle, { page: clampedPage, total: totalPages });
  const embed = new EmbedBuilder().setTitle(title).setColor(0x5865f2).setTimestamp();

  for (const story of pageStories) {
    const modeLabel = story.mode === 1 ? listCfg.txtModeQuick : story.mode === 2 ? listCfg.txtModeSlow : listCfg.txtModeNormal;
    const dateRange = story.my_first_turn_unix
      ? `${fmt(story.my_first_turn_unix)} – ${fmt(story.my_last_turn_unix ?? story.my_first_turn_unix)}`
      : replaceTemplateVariables(listCfg.txtMyListJoined, { date: fmt(story.created_at_unix) });
    const myStats = story.my_turn_count > 0
      ? replaceTemplateVariables(listCfg.txtMyListMyStats, { turn_count: story.my_turn_count, word_count: Number(story.my_word_count).toLocaleString() })
      : listCfg.txtMyListNoTurns;
    const totalTurns = replaceTemplateVariables(listCfg.txtMyListStoryTotal, { turn_count: story.total_turn_count });
    const writerPaused = story.writer_status === 2 ? ` · ${listCfg.txtMyListPausedSuffix}` : '';

    embed.addFields({
      name: `${statusIcon(story.story_status)} ${story.title} (#${story.guild_story_id}) · ${modeLabel} · ${statusText(story.story_status)}${writerPaused}`,
      value: `├ ${myStats} · ${totalTurns}\n└ ${dateRange}`,
      inline: false
    });
  }
  return embed;
}

function buildListNavRow(clampedPage, totalPages, listCfg) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mystory_list_prev_${clampedPage}`)
      .setLabel(listCfg.btnPrev)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage === 1),
    new ButtonBuilder()
      .setCustomId(`mystory_list_next_${clampedPage}`)
      .setLabel(listCfg.btnNext)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage === totalPages)
  );
}

export async function handleListNavigation(connection, interaction) {
  await interaction.deferUpdate();
  const parts = interaction.customId.split('_');
  const direction = parts[2];
  const currentPage = parseInt(parts[3]);
  const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  const cached = pendingCatchUpData.get(`list_${userId}`);
  if (!cached) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtCatchupSessionExpired', guildId), embeds: [], components: [] });
  }

  const { stories, listCfg } = cached;
  const totalPages = Math.ceil(stories.length / LIST_PAGE_SIZE);
  const clampedPage = Math.min(Math.max(newPage, 1), totalPages);
  const pageStart = (clampedPage - 1) * LIST_PAGE_SIZE;
  const pageStories = stories.slice(pageStart, pageStart + LIST_PAGE_SIZE);

  const embed = buildListEmbed(pageStories, clampedPage, totalPages, listCfg);
  const navRow = buildListNavRow(clampedPage, totalPages, listCfg);
  await interaction.editReply({ embeds: [embed], components: [navRow] });
}

// ─── /mystory catchup ────────────────────────────────────────────────────────

export async function handleCatchUp(connection, interaction) {
  log(`handleCatchUp: entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
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
    let currentEmbed = null;
    let currentText = '';

    for (const entry of entries) {
      if (entry.turn_number !== currentTurn) {
        if (currentEmbed) {
          currentEmbed.setDescription(currentText.trim());
          pages.push(currentEmbed);
        }
        currentTurn = entry.turn_number;
        currentText = '';
        currentEmbed = new EmbedBuilder()
          .setAuthor({ name: replaceTemplateVariables(catchupCfg.txtCatchupTurnHeader, { turn_number: entry.turn_number, writer_name: entry.discord_display_name }) });
      }
      currentText += entry.content + '\n\n';
    }
    if (currentEmbed) {
      currentEmbed.setDescription(currentText.trim());
      pages.push(currentEmbed);
    }

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
