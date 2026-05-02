import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from '../utilities.js';
import { ratingBadge } from './metadata.js';

export async function handleListStories(connection, interaction) {
  const guildId = interaction.guild.id;
  const filter = interaction.options.getString('filter') || 'all';
  const page = interaction.options.getInteger('page') || 1;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await renderStoryListReply(connection, interaction, filter, page);
  } catch (error) {
    log(`Error in handleListStories: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryListFailed', guildId) });
  }
}

/**
 * Handle list navigation buttons (prev/next page)
 */
export async function handleListNavigation(connection, interaction) {
  const [, , filter, pageStr] = interaction.customId.split('_');
  await interaction.deferUpdate();
  await renderStoryListReply(connection, interaction, filter, parseInt(pageStr));
}

/**
 * Handle filter button — show a select menu to choose a filter
 */
export async function handleFilterButton(connection, interaction) {
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;
  const [txtAll, txtJoinable, txtMine, txtActive, txtPaused] = await Promise.all([
    getConfigValue(connection, 'txtAllStories', guildId),
    getConfigValue(connection, 'txtJoinableStories', guildId),
    getConfigValue(connection, 'txtMyStories', guildId),
    getConfigValue(connection, 'txtActiveStories', guildId),
    getConfigValue(connection, 'txtPausedStories', guildId),
  ]);
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('story_filter_select')
      .setPlaceholder('Choose a filter...')
      .addOptions([
        { label: txtAll, value: 'all' },
        { label: txtJoinable, value: 'joinable' },
        { label: txtMine, value: 'mine' },
        { label: txtActive, value: 'active' },
        { label: txtPaused, value: 'paused' },
        { label: '[G] General', value: 'rating_G' },
        { label: '[T] Teen', value: 'rating_T' },
        { label: '[M] Mature', value: 'rating_M' },
        { label: '[E] Explicit', value: 'rating_E' },
        { label: '[NR] Not Rated', value: 'rating_NR' },
      ])
  );
  await interaction.editReply({ content: await getConfigValue(connection, 'txtListFilterPrompt', interaction.guild.id), embeds: [], components: [row] });
}

/**
 * Render the story list embed and navigation into the current reply
 */
export async function renderStoryListReply(connection, interaction, filter, page) {
  const guildId = interaction.guild.id;
  const itemsPerPage = 5;

  // Fetch stories and all config values in parallel
  const [stories, cfg] = await Promise.all([
    getStoriesPaginated(connection, guildId, filter, page, itemsPerPage, interaction.user.id),
    getConfigValue(connection, [
      'txtStoriesPageTitle', 'txtStoriesPageDesc',
      'lblStoryStatus', 'lblStoryTurn', 'lblStoryWriters', 'lblStoryMode', 'lblStoryCreator',
      'txtModeQuick', 'txtModeNormal',
      'txtActive', 'txtPaused', 'txtClosed', 'txtDelayed',
      'txtMemberStatusJoined', 'txtMemberStatusCanJoin', 'txtMemberStatusCanNotJoin',
      'txtTurnWaiting', 'txtTurnOverdue', 'txtTurnTimeLeft',
      'btnPrev', 'btnNext', 'btnFilter',
      'txtQuickJoinPlaceholder', 'txtQuickJoinDesc',
      ...Object.values(ratingBadge),
    ], guildId),
  ]);

  const filterTitle = await getFilterTitle(connection, filter, guildId);
  const statusTextMap = { 1: cfg.txtActive, 2: cfg.txtPaused, 3: cfg.txtClosed, 4: cfg.txtDelayed };

  // Batch fetch active turns for all stories on this page in one query
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

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtStoriesPageTitle, {
      filter_title: filterTitle, page, total_pages: stories.totalPages
    }))
    .setDescription(replaceTemplateVariables(cfg.txtStoriesPageDesc, {
      showing: stories.data.length, total: stories.totalCount
    }))
    .setColor(0x3498db)
    .setTimestamp();

  for (const story of stories.data) {
    const statusIcon = getStatusIcon(story.story_status);
    const joinStatus = story.join_status === 2 ? cfg.txtMemberStatusJoined
      : story.join_status === 1 ? cfg.txtMemberStatusCanJoin
      : cfg.txtMemberStatusCanNotJoin;
    const modeText = story.quick_mode ? cfg.txtModeQuick : cfg.txtModeNormal;
    const statusText = statusTextMap[story.story_status] ?? '—';

    let currentTurn;
    if (story.story_status === 2) {
      currentTurn = cfg.txtPaused;
    } else if (story.story_status === 3) {
      currentTurn = cfg.txtClosed;
    } else if (story.story_status === 4) {
      currentTurn = cfg.txtDelayed;
    } else {
      const turn = activeTurnMap.get(story.story_id);
      if (!turn) {
        currentTurn = cfg.txtTurnWaiting;
      } else {
        const msLeft = new Date(turn.turn_ends_at).getTime() - Date.now();
        if (msLeft <= 0) {
          currentTurn = replaceTemplateVariables(cfg.txtTurnOverdue, { writer_name: turn.discord_display_name });
        } else {
          const hoursLeft = Math.ceil(msLeft / (1000 * 60 * 60));
          currentTurn = replaceTemplateVariables(cfg.txtTurnTimeLeft, { writer_name: turn.discord_display_name, hours: hoursLeft });
        }
      }
    }

    const ratingBadgeCfgKey = ratingBadge[story.rating] ?? 'txtRatingBadgeNR';
    embed.addFields({
      name: `${statusIcon} "${story.title}" (#${story.guild_story_id}) ${cfg[ratingBadgeCfgKey] ?? story.rating ?? ''}`,
      value: `├ ${cfg.lblStoryStatus} ${statusText} • ${cfg.lblStoryTurn} ${currentTurn}
├ ${cfg.lblStoryWriters} ${story.writer_count}/${story.max_writers || '∞'} • ${cfg.lblStoryMode} ${modeText}
└ ${cfg.lblStoryCreator} ${story.creator_name} • ${joinStatus}`,
      inline: false
    });
  }

  const components = [];
  const navRow = new ActionRowBuilder();
  if (stories.totalPages > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`story_list_${filter}_${page - 1}`)
        .setLabel(cfg.btnPrev)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`story_list_${filter}_${page + 1}`)
        .setLabel(cfg.btnNext)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === stories.totalPages)
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('story_filter')
      .setLabel(cfg.btnFilter)
      .setStyle(ButtonStyle.Secondary)
  );
  components.push(navRow);

  // Quick join menu — only stories the user can actually join
  const joinableStories = stories.data.filter(s => s.join_status === 1);
  if (joinableStories.length > 0) {
    const joinRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('story_quick_join')
        .setPlaceholder(cfg.txtQuickJoinPlaceholder)
        .addOptions(joinableStories.map(s => ({
          label: `${s.title} (#${s.guild_story_id})`,
          value: s.story_id.toString(),
          description: replaceTemplateVariables(cfg.txtQuickJoinDesc, {
            writer_count: s.writer_count,
            max_writers: s.max_writers || '∞',
            mode: s.quick_mode ? cfg.txtModeQuick : cfg.txtModeNormal,
          })
        })))
    );
    components.push(joinRow);
  }

  await interaction.editReply({ content: '', embeds: [embed], components });
}

/**
 * Get paginated stories from database
 */
export async function getStoriesPaginated(connection, guildId, filter, page, itemsPerPage, userId) {

  try {
    let whereClause = 'WHERE s.guild_id = ?';
    let params = [guildId];
    log(`getStoriesPaginated - guildId: ${guildId}, filter: ${filter}`, { show: false });

    // Apply filters
    switch (filter) {
      case 'joinable':
        whereClause += ` AND s.story_status IN (1, 2, 4) AND s.allow_joins = 1
          AND (s.max_writers IS NULL OR (SELECT COUNT(*) FROM story_writer WHERE story_id = s.story_id AND sw_status = 1) < s.max_writers)
          AND s.story_id NOT IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = 1)`;
        params.push(userId);
        break;
      case 'mine':
        whereClause += ' AND s.story_id IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = 1)';
        params.push(userId);
        break;
      case 'active':
        whereClause += ' AND s.story_status = 1';
        break;
      case 'paused':
        whereClause += ' AND s.story_status = 2';
        break;
      default:
        // Rating filters: rating_G, rating_T, rating_M, rating_E, rating_NR
        if (filter.startsWith('rating_')) {
          const ratingValue = filter.slice(7); // e.g. 'G', 'T', 'M', 'E', 'NR'
          whereClause += ' AND s.rating = ?';
          params.push(ratingValue);
        }
        break; // no status filter — return all stories including closed
    }

    // Get total count
    const [countResult] = await connection.execute(`
      SELECT COUNT(*) as total FROM (
        SELECT s.story_id
        FROM story s
        LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = 1
        ${whereClause}
        GROUP BY s.story_id
      ) as filtered_stories
    `, params);

    const totalCount = countResult[0].total;
    log(`getStoriesPaginated - totalCount: ${totalCount}`, { show: false });
    const totalPages = Math.ceil(totalCount / itemsPerPage);
    const offset = (page - 1) * itemsPerPage;

    // Get paginated results
    const [stories] = await connection.execute(`
      SELECT
        s.*,
        COUNT(sw.story_writer_id) as writer_count,
        (SELECT discord_display_name FROM story_writer WHERE story_id = s.story_id ORDER BY joined_at ASC LIMIT 1) as creator_name,
        CASE
          WHEN s.story_id IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = 1)
          THEN 2
          WHEN s.story_status != 3 AND s.allow_joins = 1
           AND (s.max_writers IS NULL OR COUNT(sw.story_writer_id) < s.max_writers)
          THEN 1
          ELSE 0
        END as join_status
      FROM story s
      LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = 1
      ${whereClause}
      GROUP BY s.story_id
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `, [userId, ...params, itemsPerPage, offset]);
    log(`getStoriesPaginated - stories rows returned: ${stories.length}`, { show: false });

    return {
      data: stories,
      totalCount,
      totalPages,
      currentPage: page
    };

  } finally {
    // Connection is persistent, no need to release
  }
}

/**
 * Helper functions for story display
 */
export async function getFilterTitle(connection, filter, guildId) {
  if (filter.startsWith('rating_')) {
    const ratingValue = filter.slice(7);
    const ratingLabels = { G: '[G] General', T: '[T] Teen', M: '[M] Mature', E: '[E] Explicit', NR: '[NR] Not Rated' };
    return ratingLabels[ratingValue] ?? 'Stories';
  }

  const configKeys = {
    all: 'txtAllStories',
    joinable: 'txtJoinableStories',
    mine: 'txtMyStories',
    active: 'txtActiveStories',
    paused: 'txtPausedStories'
  };

  const configKey = configKeys[filter] || 'txtAllStories';
  return await getConfigValue(connection,configKey, guildId);
}

export function getStatusIcon(status) {
  const icons = {
    1: '🟢', // Active
    2: '⏸️', // Paused
    3: '🏁', // Closed
    4: '⏳'  // Waiting (delayed)
  };
  return icons[status] || '❓';
}
