import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, storyLastActivitySQL } from '../utilities.js';
import { ratingCodes, ratingBadgeKey } from './_metadata.js';
import { STORY_STATUS, TURN_STATUS, WRITER_STATUS, STORY_MODE } from '../constants.js';

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
  const parts = interaction.customId.split('_');
  const pageStr = parts.at(-1);
  const filter = parts.slice(2, -1).join('_');
  await interaction.deferUpdate();
  await renderStoryListReply(connection, interaction, filter, parseInt(pageStr));
}

/**
 * Handle filter button — show a select menu to choose a filter
 */
export async function handleFilterButton(connection, interaction) {
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;
  const cfg = await getConfigValue(connection, [
    'txtAllStories', 'txtJoinableStories', 'txtMyStories', 'txtActiveStories', 'txtPausedStories',
    'txtRatingG', 'txtRatingT', 'txtRatingM', 'txtRatingE', 'txtRatingNR',
    'txtListFilterPrompt',
  ], guildId);
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('story_filter_select')
      .setPlaceholder('Choose a filter...')
      .addOptions([
        { label: cfg.txtAllStories, value: 'all' },
        { label: cfg.txtJoinableStories, value: 'joinable' },
        { label: cfg.txtMyStories, value: 'mine' },
        { label: cfg.txtActiveStories, value: 'active' },
        { label: cfg.txtPausedStories, value: 'paused' },
        { label: cfg.txtRatingG, value: 'rating_G' },
        { label: cfg.txtRatingT, value: 'rating_T' },
        { label: cfg.txtRatingM, value: 'rating_M' },
        { label: cfg.txtRatingE, value: 'rating_E' },
        { label: cfg.txtRatingNR, value: 'rating_NR' },
      ])
  );
  await interaction.editReply({ content: cfg.txtListFilterPrompt, embeds: [], components: [row] });
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
      'txtModeQuick', 'txtModeNormal', 'txtModeSlow',
      'txtActive', 'txtPaused', 'txtClosed', 'txtDelayed',
      'txtMemberStatusJoined', 'txtMemberStatusCanJoin', 'txtMemberStatusCanNotJoin',
      'txtTurnWaiting', 'txtTurnOverdue', 'txtTurnTimeLeft',
      'btnPrev', 'btnNext', 'btnFilter',
      'txtQuickJoinPlaceholder', 'txtQuickJoinDesc',
      ...ratingCodes.map(ratingBadgeKey),
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
       WHERE sw.story_id IN (${placeholders}) AND t.turn_status = ?`,
      [...storyIds, TURN_STATUS.ACTIVE]
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
    const modeText = story.mode === STORY_MODE.QUICK ? cfg.txtModeQuick : story.mode === STORY_MODE.SLOW ? cfg.txtModeSlow : cfg.txtModeNormal;
    const statusText = statusTextMap[story.story_status] ?? '—';

    let currentTurn;
    if (story.story_status === STORY_STATUS.PAUSED) {
      currentTurn = cfg.txtPaused;
    } else if (story.story_status === STORY_STATUS.CLOSED) {
      currentTurn = cfg.txtClosed;
    } else if (story.story_status === STORY_STATUS.DELAYED) {
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

    const ratingBadgeCfgKey = ratingBadgeKey(story.rating ?? 'NR');
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
            mode: s.mode === STORY_MODE.QUICK ? cfg.txtModeQuick : s.mode === STORY_MODE.SLOW ? cfg.txtModeSlow : cfg.txtModeNormal,
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
        whereClause += ` AND s.story_status IN (?, ?, ?) AND s.allow_joins = 1
          AND (s.max_writers IS NULL OR (SELECT COUNT(*) FROM story_writer WHERE story_id = s.story_id AND sw_status = ?) < s.max_writers)
          AND s.story_id NOT IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = ?)`;
        params.push(STORY_STATUS.ACTIVE, STORY_STATUS.PAUSED, STORY_STATUS.DELAYED, WRITER_STATUS.ACTIVE, userId, WRITER_STATUS.ACTIVE);
        break;
      case 'mine':
        whereClause += ' AND s.story_id IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = ?)';
        params.push(userId, WRITER_STATUS.ACTIVE);
        break;
      case 'active':
        whereClause += ' AND s.story_status = ?';
        params.push(STORY_STATUS.ACTIVE);
        break;
      case 'paused':
        whereClause += ' AND s.story_status = ?';
        params.push(STORY_STATUS.PAUSED);
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
        LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = ?
        ${whereClause}
        GROUP BY s.story_id
      ) as filtered_stories
    `, [WRITER_STATUS.ACTIVE, ...params]);

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
          WHEN s.story_id IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = ?)
          THEN 2
          WHEN s.story_status != ? AND s.allow_joins = 1
           AND (s.max_writers IS NULL OR COUNT(sw.story_writer_id) < s.max_writers)
          THEN 1
          ELSE 0
        END as join_status
      FROM story s
      LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = ?
      ${whereClause}
      GROUP BY s.story_id
      ORDER BY ${storyLastActivitySQL()} DESC
      LIMIT ? OFFSET ?
    `, [userId, WRITER_STATUS.ACTIVE, STORY_STATUS.CLOSED, WRITER_STATUS.ACTIVE, ...params, itemsPerPage, offset]);
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
    const ratingKeyMap = { G: 'txtRatingG', T: 'txtRatingT', M: 'txtRatingM', E: 'txtRatingE', NR: 'txtRatingNR' };
    const key = ratingKeyMap[ratingValue] ?? 'txtAllStories';
    return await getConfigValue(connection, key, guildId);
  }

  const configKeys = {
    all: 'txtAllStories',
    joinable: 'txtJoinableStories',
    mine: 'txtMyStories',
    active: 'txtActiveStories',
    paused: 'txtPausedStories'
  };

  const configKey = configKeys[filter] || 'txtAllStories';
  return await getConfigValue(connection, configKey, guildId);
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
