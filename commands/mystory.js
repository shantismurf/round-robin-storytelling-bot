import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, formattedDate, replaceTemplateVariables } from '../utilities.js';
import { PickNextWriter, NextTurn, deleteThreadAndAnnouncement } from '../storybot.js';

// Cached catchup pages keyed by "catchup_<userId>_<storyId>"
const pendingCatchUpData = new Map();

const data = new SlashCommandBuilder()
  .setName('mystory')
  .setDescription('Your personal story dashboard')
  .addSubcommand(s =>
    s.setName('active')
      .setDescription('See your active and paused stories')
  )
  .addSubcommand(s =>
    s.setName('history')
      .setDescription('See all stories you\'ve been in, including completed ones')
      .addIntegerOption(o =>
        o.setName('page')
          .setDescription('Page number')
          .setRequired(false)
          .setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName('catchup')
      .setDescription('Read entries written since your last turn')
      .addIntegerOption(o =>
        o.setName('story_id')
          .setDescription('Story ID to catch up on')
          .setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('leave')
      .setDescription('Leave a story you\'re currently in')
      .addIntegerOption(o =>
        o.setName('story_id')
          .setDescription('Story ID to leave')
          .setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('pass')
      .setDescription('Skip (pass) your current turn in a story')
      .addIntegerOption(o =>
        o.setName('story_id')
          .setDescription('Story ID where you want to pass your turn')
          .setRequired(true))
  );

async function execute(connection, interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'active') await handleStatus(connection, interaction);
  else if (subcommand === 'history') await handleHistory(connection, interaction);
  else if (subcommand === 'catchup') await handleCatchUp(connection, interaction);
  else if (subcommand === 'leave') await handleLeave(connection, interaction);
  else if (subcommand === 'pass') await handlePass(connection, interaction);
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('catchup_prev_') || interaction.customId.startsWith('catchup_next_')) {
    await handleCatchUpNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_hist_prev_') || interaction.customId.startsWith('mystory_hist_next_')) {
    await handleHistoryNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_leave_confirm_')) {
    await handleLeaveConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_leave_cancel_')) {
    await handleLeaveCancel(connection, interaction);
  }
}

/**
 * /mystory status — personal dashboard showing all stories the user is in
 */
async function handleStatus(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const cfg = await getConfigValue(connection, [
      'txtMyStoriesTitle', 'txtMyStoryNone',
      'txtMyTurnQuick', 'txtMyTurnNormal', 'txtOthersTurn',
      'txtTurnWaiting', 'txtMyTurnHistory', 'txtMyTurnNoHistory',
      'txtModeQuick', 'txtModeNormal', 'errProcessingRequest'
    ], guildId);

    const [stories] = await connection.execute(
      `SELECT s.story_id, s.title, s.story_status, s.quick_mode
       FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.discord_user_id = ? AND sw.sw_status = 1 AND s.guild_id = ? AND s.story_status != 3
       ORDER BY s.story_status ASC, s.created_at DESC`,
      [userId, guildId]
    );

    if (stories.length === 0) {
      return await interaction.editReply({ content: cfg.txtMyStoryNone });
    }

    const storyIds = stories.map(s => s.story_id);
    const placeholders = storyIds.map(() => '?').join(',');

    // Active turns for each story
    const [activeTurns] = await connection.execute(
      `SELECT sw.story_id, sw.discord_user_id, sw.discord_display_name,
              UNIX_TIMESTAMP(t.turn_ends_at) as turn_ends_at_unix, t.thread_id
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id IN (${placeholders}) AND t.turn_status = 1`,
      storyIds
    );

    // User's personal turn history per story
    const [myTurns] = await connection.execute(
      `SELECT sw.story_id, COUNT(*) as my_turn_count, UNIX_TIMESTAMP(MAX(t.ended_at)) as my_last_turn_at_unix
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id IN (${placeholders}) AND sw.discord_user_id = ? AND t.turn_status = 0
       GROUP BY sw.story_id`,
      [...storyIds, userId]
    );

    const activeTurnMap = Object.fromEntries(activeTurns.map(t => [t.story_id, t]));
    const myTurnMap = Object.fromEntries(myTurns.map(t => [t.story_id, t]));

    const embed = new EmbedBuilder()
      .setTitle(cfg.txtMyStoriesTitle)
      .setColor(0x5865f2)
      .setTimestamp();

    for (const story of stories) {
      const activeTurn = activeTurnMap[story.story_id];
      const myHistory = myTurnMap[story.story_id];
      const isMyTurn = activeTurn && String(activeTurn.discord_user_id) === userId;

      const statusIcon = story.story_status === 1 ? '🟢' : story.story_status === 2 ? '⏸️' : '🏁';
      const modeLabel = story.quick_mode ? cfg.txtModeQuick : cfg.txtModeNormal;

      let turnLine = '';
      if (isMyTurn) {
        if (story.quick_mode) {
          turnLine = replaceTemplateVariables(cfg.txtMyTurnQuick, { story_id: story.story_id });
        } else {
          const threadRef = activeTurn.thread_id ? ` · <#${activeTurn.thread_id}>` : '';
          const endsAt = activeTurn.turn_ends_at_unix
            ? ` — ends <t:${activeTurn.turn_ends_at_unix}:R>`
            : '';
          turnLine = `${cfg.txtMyTurnNormal}${threadRef}${endsAt}`;
        }
      } else if (activeTurn) {
        const endsAt = activeTurn.turn_ends_at_unix
          ? ` — ends <t:${activeTurn.turn_ends_at_unix}:R>`
          : '';
        turnLine = replaceTemplateVariables(cfg.txtOthersTurn, { writer_name: activeTurn.discord_display_name }) + endsAt;
      } else if (story.story_status === 1) {
        turnLine = cfg.txtTurnWaiting;
      }

      const myTurnCount = myHistory?.my_turn_count ?? 0;
      const lastTurnUnix = myHistory?.my_last_turn_at_unix;
      const historyLine = lastTurnUnix
        ? replaceTemplateVariables(cfg.txtMyTurnHistory, {
            last_turn_at: `<t:${lastTurnUnix}:R>`,
            turn_count: myTurnCount
          })
        : cfg.txtMyTurnNoHistory;

      const lines = [turnLine, historyLine].filter(Boolean);
      let fieldValue;
      if (lines.length === 2) {
        fieldValue = `├ ${lines[0]}\n└ ${lines[1]}`;
      } else if (lines.length === 1) {
        fieldValue = `└ ${lines[0]}`;
      } else {
        fieldValue = '└ —';
      }

      embed.addFields({
        name: `${statusIcon} ${story.title} (#${story.story_id}) · ${modeLabel}`,
        value: fieldValue,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleStatus:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

const HISTORY_PAGE_SIZE = 5;

/**
 * /mystory history — all stories the user has ever been in, including closed
 */
async function handleHistory(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const page = Math.max(1, interaction.options.getInteger('page') ?? 1);

  try {
    const [stories] = await connection.execute(
      `SELECT s.story_id, s.title, s.story_status, s.quick_mode, s.created_at, s.closed_at,
              sw.sw_status,
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
       HAVING (COUNT(DISTINCT t.turn_id) > 0 OR sw.sw_status = 1)
       ORDER BY s.story_status ASC, s.created_at DESC`,
      [userId, guildId]
    );

    if (stories.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtMyStoryNone', guildId) });
    }

    const totalPages = Math.ceil(stories.length / HISTORY_PAGE_SIZE);
    const clampedPage = Math.min(page, totalPages);
    const pageStart = (clampedPage - 1) * HISTORY_PAGE_SIZE;
    const pageStories = stories.slice(pageStart, pageStart + HISTORY_PAGE_SIZE);

    const fmt = unix => unix ? `<t:${unix}:d>` : null;
    const statusIcon = s => s === 1 ? '🟢' : s === 2 ? '⏸️' : '🏁';
    const statusText = s => s === 1 ? 'Active' : s === 2 ? 'Paused' : 'Closed';

    const [txtModeQuick, txtModeNormal] = await Promise.all([
      getConfigValue(connection, 'txtModeQuick', guildId),
      getConfigValue(connection, 'txtModeNormal', guildId)
    ]);

    const embed = new EmbedBuilder()
      .setTitle(`📖 Your Story History (Page ${clampedPage}/${totalPages})`)
      .setColor(0x5865f2)
      .setTimestamp();

    for (const story of pageStories) {
      const modeLabel = story.quick_mode ? txtModeQuick : txtModeNormal;
      const dateRange = story.my_first_turn_unix
        ? `${fmt(story.my_first_turn_unix)} – ${fmt(story.my_last_turn_unix ?? story.my_first_turn_unix)}`
        : `Joined ${fmt(story.created_at_unix)}`;
      const myStats = story.my_turn_count > 0
        ? `Your turns: ${story.my_turn_count} · ~${Number(story.my_word_count).toLocaleString()} words`
        : 'No turns taken';
      const totalTurns = story.total_turn_count > 0
        ? `Story total: ${story.total_turn_count} turn(s)`
        : 'Story total: 0 turns';

      embed.addFields({
        name: `${statusIcon(story.story_status)} ${story.title} (#${story.story_id}) · ${modeLabel} · ${statusText(story.story_status)}`,
        value: `├ ${myStats} · ${totalTurns}\n└ ${dateRange}`,
        inline: false
      });
    }

    const components = [];
    if (totalPages > 1) {
      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mystory_hist_prev_${clampedPage}`)
          .setLabel('◀️ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(clampedPage === 1),
        new ButtonBuilder()
          .setCustomId(`mystory_hist_next_${clampedPage}`)
          .setLabel('Next ▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(clampedPage === totalPages)
      );
      components.push(navRow);

      // Cache story list for nav buttons
      pendingCatchUpData.set(`hist_${userId}`, { stories, txtModeQuick, txtModeNormal });
    }

    await interaction.editReply({ embeds: [embed], components });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleHistory:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleHistoryNavigation(connection, interaction) {
  await interaction.deferUpdate();
  const parts = interaction.customId.split('_');
  const direction = parts[2]; // 'prev' or 'next'
  const currentPage = parseInt(parts[3]);
  const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  const cached = pendingCatchUpData.get(`hist_${userId}`);
  if (!cached) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtCatchupSessionExpired', guildId), embeds: [], components: [] });
  }

  const { stories, txtModeQuick, txtModeNormal } = cached;
  const totalPages = Math.ceil(stories.length / HISTORY_PAGE_SIZE);
  const clampedPage = Math.min(Math.max(newPage, 1), totalPages);
  const pageStart = (clampedPage - 1) * HISTORY_PAGE_SIZE;
  const pageStories = stories.slice(pageStart, pageStart + HISTORY_PAGE_SIZE);

  const fmt = unix => unix ? `<t:${unix}:d>` : null;
  const statusIcon = s => s === 1 ? '🟢' : s === 2 ? '⏸️' : '🏁';
  const statusText = s => s === 1 ? 'Active' : s === 2 ? 'Paused' : 'Closed';

  const embed = new EmbedBuilder()
    .setTitle(`📖 Your Story History (Page ${clampedPage}/${totalPages})`)
    .setColor(0x5865f2)
    .setTimestamp();

  for (const story of pageStories) {
    const modeLabel = story.quick_mode ? txtModeQuick : txtModeNormal;
    const dateRange = story.my_first_turn_unix
      ? `${fmt(story.my_first_turn_unix)} – ${fmt(story.my_last_turn_unix ?? story.my_first_turn_unix)}`
      : `Joined ${fmt(story.created_at_unix)}`;
    const myStats = story.my_turn_count > 0
      ? `Your turns: ${story.my_turn_count} · ~${Number(story.my_word_count).toLocaleString()} words`
      : 'No turns taken';
    const totalTurns = story.total_turn_count > 0
      ? `Story total: ${story.total_turn_count} turn(s)`
      : 'Story total: 0 turns';

    embed.addFields({
      name: `${statusIcon(story.story_status)} ${story.title} (#${story.story_id}) · ${modeLabel} · ${statusText(story.story_status)}`,
      value: `├ ${myStats} · ${totalTurns}\n└ ${dateRange}`,
      inline: false
    });
  }

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mystory_hist_prev_${clampedPage}`)
      .setLabel('◀️ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage === 1),
    new ButtonBuilder()
      .setCustomId(`mystory_hist_next_${clampedPage}`)
      .setLabel('Next ▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage === totalPages)
  );

  await interaction.editReply({ embeds: [embed], components: [navRow] });
}

/**
 * /mystory catchup — paginated view of entries since user's last turn
 */
async function handleCatchUp(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    // Find the end of the user's most recent completed turn
    const [lastTurnRows] = await connection.execute(
      `SELECT t.ended_at FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 0
       ORDER BY t.ended_at DESC LIMIT 1`,
      [storyId, userId]
    );

    const afterTime = lastTurnRows.length > 0 ? lastTurnRows[0].ended_at : new Date(0);
    const [entries] = await connection.execute(
      `SELECT se.content, sw.discord_display_name,
              (SELECT COUNT(DISTINCT t2.turn_id) FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed' AND t.started_at > ?
       ORDER BY t.started_at, se.order_in_turn`,
      [storyId, afterTime]
    );

    if (entries.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtCatchupNoEntries', guildId) });
    }

    // Build one embed per turn
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
          .setAuthor({ name: `Turn ${entry.turn_number} — ${entry.discord_display_name}` });
      }
      currentText += entry.content + '\n\n';
    }
    if (currentEmbed) {
      currentEmbed.setDescription(currentText.trim());
      pages.push(currentEmbed);
    }

    const totalPages = pages.length;
    const storyTitle = storyRows[0].title;
    const intro = lastTurnRows.length > 0
      ? `📖 **${storyTitle}** — ${totalPages} turn(s) since your last turn.`
      : `📖 **${storyTitle}** — ${totalPages} turn(s) so far (you haven't had a turn yet).`;

    if (totalPages === 1) {
      return await interaction.editReply({ content: intro, embeds: [pages[0]] });
    }

    const navRow = buildCatchUpNavRow(0, totalPages);
    const catchUpKey = `catchup_${userId}_${storyId}`;
    pendingCatchUpData.set(catchUpKey, { pages, storyTitle });

    await interaction.editReply({ content: `${intro} (Page 1/${totalPages})`, embeds: [pages[0]], components: [navRow] });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleCatchUp:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleCatchUpNavigation(connection, interaction) {
  await interaction.deferUpdate();
  const [, action, currentPageStr] = interaction.customId.split('_');
  const currentPage = parseInt(currentPageStr);
  const newPage = action === 'next' ? currentPage + 1 : currentPage - 1;

  const catchUpKey = [...pendingCatchUpData.keys()].find(k => k.startsWith(`catchup_${interaction.user.id}_`));
  if (!catchUpKey) {
    const msg = await getConfigValue(connection, 'txtCatchupSessionExpired', interaction.guild.id);
    return await interaction.editReply({ content: msg, embeds: [], components: [] });
  }

  const { pages, storyTitle } = pendingCatchUpData.get(catchUpKey);
  const totalPages = pages.length;
  const navRow = buildCatchUpNavRow(newPage, totalPages);

  await interaction.editReply({
    content: `📖 **${storyTitle}** — (Page ${newPage + 1}/${totalPages})`,
    embeds: [pages[newPage]],
    components: [navRow]
  });
}

function buildCatchUpNavRow(currentPage, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`catchup_prev_${currentPage}`)
      .setLabel('◀️ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`catchup_next_${currentPage}`)
      .setLabel('Next ▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1)
  );
}

/**
 * /mystory leave — leave a story with confirmation
 */
async function handleLeave(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT s.story_id, s.title, s.story_status FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id
       WHERE s.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1`,
      [storyId, guildId, userId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId) });
    }
    const story = storyRows[0];

    // Check if it's currently the user's turn
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );
    const isMyTurn = activeTurnRows.length > 0;

    // Count remaining active writers (excluding this user)
    const [writerCountRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, userId]
    );
    const isLastWriter = writerCountRows[0].count === 0;

    let leaveConfirmKey;
    if (isLastWriter) {
      leaveConfirmKey = 'txtLeaveConfirmLastWriter';
    } else if (isMyTurn) {
      leaveConfirmKey = 'txtLeaveConfirmMyTurn';
    } else {
      leaveConfirmKey = 'txtLeaveConfirm';
    }

    const [txtLeaveConfirmKey, btnLeaveStory, btnCancel] = await Promise.all([
      getConfigValue(connection, leaveConfirmKey, guildId),
      getConfigValue(connection, 'btnLeaveStory', guildId),
      getConfigValue(connection, 'btnCancel', guildId)
    ]);

    const confirmMsg = replaceTemplateVariables(txtLeaveConfirmKey, { story_title: story.title });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mystory_leave_confirm_${storyId}`)
        .setLabel(btnLeaveStory)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`mystory_leave_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: confirmMsg, components: [row] });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleLeave:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleLeaveConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [writerRows] = await connection.execute(
      `SELECT sw.story_writer_id FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1`,
      [storyId, guildId, userId]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId), components: [] });
    }

    // If it's their turn, end it and advance before marking them as left
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );

    // Check if this user is the last active writer
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, userId]
    );
    const isLastWriter = remainingRows[0].count === 0;

    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      await connection.execute(
        `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
        [activeTurn.turn_id]
      );
      if (activeTurn.thread_id) {
        try {
          const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
          if (thread) await deleteThreadAndAnnouncement(thread);
        } catch (err) {
          console.error(`${formattedDate()}: Could not delete turn thread on leave:`, err);
        }
      }
    }

    // Mark as left
    await connection.execute(
      `UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_id = ? AND discord_user_id = ?`,
      [storyId, userId]
    );

    if (isLastWriter) {
      // No writers remain — auto-close the story
      await connection.execute(
        `UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`,
        [storyId]
      );
      console.log(`${formattedDate()}: Story ${storyId} auto-closed — last writer left`);
    } else if (activeTurnRows.length > 0) {
      // Had an active turn and other writers remain — advance to next
      try {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      } catch (err) {
        console.error(`${formattedDate()}: Could not advance turn after leave:`, err);
      }
    }

    console.log(`${formattedDate()}: ${interaction.user.username} left story ${storyId}`);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtLeftStorySuccess', guildId), components: [] });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleLeaveConfirm:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handleLeaveCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
}

/**
 * /mystory pass — skip the user's current turn in a story
 */
async function handlePass(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );

    if (turnInfo.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
    }

    const turn = turnInfo[0];

    await connection.execute(
      `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
      [turn.turn_id]
    );

    const nextWriterId = await PickNextWriter(connection, storyId);
    await NextTurn(connection, interaction, nextWriterId);

    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        if (thread) await thread.delete('Turn passed');
      } catch (err) {
        console.error(`${formattedDate()}: Failed to delete thread after pass:`, err);
      }
    }

    await interaction.editReply({ content: await getConfigValue(connection, 'txtPassSuccess', guildId) });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handlePass:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export default { data, execute, handleButtonInteraction };
