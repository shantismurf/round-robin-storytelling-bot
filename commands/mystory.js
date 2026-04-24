import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId } from '../utilities.js';
import { PickNextWriter, NextTurn, deleteThreadAndAnnouncement } from '../storybot.js';

// Cached catchup pages keyed by "catchup_<userId>_<storyId>"
const pendingCatchUpData = new Map();

// Pending /mystory manage sessions keyed by user ID
const pendingMyStoryManageData = new Map();

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
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story to catch up on')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('leave')
      .setDescription('Leave a story you\'re currently in')
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story to leave')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('pass')
      .setDescription('Skip (pass) your current turn in a story')
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story where you want to pass your turn')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('pause')
      .setDescription('Pause your participation in a story (or all active stories)')
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story to pause — leave blank to pause all active stories')
          .setRequired(false)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('resume')
      .setDescription('Resume your participation in a paused story (or all paused stories)')
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story to resume — leave blank to resume all paused stories')
          .setRequired(false)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('manage')
      .setDescription('Update your AO3 name, notification preference, and turn privacy for a story')
      .addStringOption(o =>
        o.setName('story_id')
          .setDescription('Story to manage your settings for')
          .setRequired(true)
          .setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Quick reference for all writer commands')
  );

async function execute(connection, interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'active') await handleStatus(connection, interaction);
  else if (subcommand === 'history') await handleHistory(connection, interaction);
  else if (subcommand === 'catchup') await handleCatchUp(connection, interaction);
  else if (subcommand === 'leave') await handleLeave(connection, interaction);
  else if (subcommand === 'pass') await handlePass(connection, interaction);
  else if (subcommand === 'pause') await handlePause(connection, interaction);
  else if (subcommand === 'resume') await handleResume(connection, interaction);
  else if (subcommand === 'manage') await handleMyStoryManage(connection, interaction);
  else if (subcommand === 'help') await handleHelp(connection, interaction);
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
  } else if (interaction.customId.startsWith('mystory_manage_')) {
    await handleMyStoryManageButton(connection, interaction);
  }
}

/**
 * /mystory help — quick reference for all writer-facing commands
 */
async function handleHelp(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;

  const cfg = await getConfigValue(connection, [
    'txtMyHelpTitle', 'txtMyHelpFooter',
    'lblMyHelpDashboard', 'txtMyHelpDashboard',
    'lblMyHelpTurn', 'txtMyHelpTurn',
    'lblMyHelpPause', 'txtMyHelpPause',
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtMyHelpTitle)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblMyHelpDashboard, value: cfg.txtMyHelpDashboard, inline: false },
      { name: cfg.lblMyHelpTurn,      value: cfg.txtMyHelpTurn,      inline: false },
      { name: cfg.lblMyHelpPause,     value: cfg.txtMyHelpPause,     inline: false },
    )
    .setFooter({ text: cfg.txtMyHelpFooter });

  await interaction.editReply({ embeds: [embed] });
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
      'txtModeQuick', 'txtModeNormal', 'txtWriterStatusPaused', 'errProcessingRequest'
    ], guildId);

    const [stories] = await connection.execute(
      `SELECT s.story_id, s.guild_story_id, s.title, s.story_status, s.quick_mode, sw.sw_status as writer_status
       FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.discord_user_id = ? AND sw.sw_status IN (1, 2) AND s.guild_id = ? AND s.story_status != 3
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
          turnLine = replaceTemplateVariables(cfg.txtMyTurnQuick, { story_id: story.guild_story_id });
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

      const isPaused = story.writer_status === 2;
      const pausedLine = isPaused ? cfg.txtWriterStatusPaused : null;
      const lines = [pausedLine, turnLine, historyLine].filter(Boolean);
      let fieldValue;
      if (lines.length === 0) {
        fieldValue = '└ —';
      } else if (lines.length === 1) {
        fieldValue = `└ ${lines[0]}`;
      } else {
        const middleLines = lines.slice(0, -1).map(l => `├ ${l}`).join('\n');
        fieldValue = `${middleLines}\n└ ${lines[lines.length - 1]}`;
      }

      embed.addFields({
        name: `${statusIcon} ${story.title} (#${story.guild_story_id}) · ${modeLabel}`,
        value: fieldValue,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    log(`Error in handleStatus: ${error}`, { show: true, guildName: interaction?.guild?.name });
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
      `SELECT s.story_id, s.guild_story_id, s.title, s.story_status, s.quick_mode, s.created_at, s.closed_at,
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
        name: `${statusIcon(story.story_status)} ${story.title} (#${story.guild_story_id}) · ${modeLabel} · ${statusText(story.story_status)}`,
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
    log(`Error in handleHistory: ${error}`, { show: true, guildName: interaction?.guild?.name });
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
      name: `${statusIcon(story.story_status)} ${story.title} (#${story.guild_story_id}) · ${modeLabel} · ${statusText(story.story_status)}`,
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

    // Find the end of the user's most recent turn that produced a confirmed entry.
    // Skipped/timed-out turns (turn_status=0, no confirmed entry) are excluded so
    // the anchor lands on the last turn the user actually wrote.
//      `SELECT t.ended_at FROM turn t // changed to include author's last turn
    const [lastTurnRows] = await connection.execute(
      `SELECT t.started_at FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story_entry se ON se.turn_id = t.turn_id AND se.entry_status = 'confirmed'
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 0
       ORDER BY t.started_at DESC LIMIT 1`,
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
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed' AND t.started_at >= ?
       ORDER BY t.started_at`,
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
    log(`Error in handleCatchUp: ${error}`, { show: true, guildName: interaction?.guild?.name });
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
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }
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
    log(`Error in handleLeave: ${error}`, { show: true, guildName: interaction?.guild?.name });
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
          log(`Could not delete turn thread on leave: ${err}`, { show: true, guildName: interaction?.guild?.name });
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
      log(`Story ${storyId} auto-closed — last writer left`, { show: true, guildName: interaction?.guild?.name });
    } else if (activeTurnRows.length > 0) {
      // Had an active turn and other writers remain — advance to next
      try {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      } catch (err) {
        log(`Could not advance turn after leave: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

    log(`${interaction.user.username} left story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtLeftStorySuccess', guildId), components: [] });

  } catch (error) {
    log(`Error in handleLeaveConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
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
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }
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
        log(`Failed to delete thread after pass: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

    await interaction.editReply({ content: await getConfigValue(connection, 'txtPassSuccess', guildId) });

  } catch (error) {
    log(`Error in handlePass: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

/**
 * /mystory pause [story_id] — pause participation in one or all active stories.
 * If it is currently the user's turn, the turn is auto-passed before pausing.
 */
async function handlePause(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const _rawStoryId = interaction.options.getString('story_id');
  const guildStoryId = _rawStoryId != null ? parseInt(_rawStoryId, 10) : null;

  try {
    let storiesToPause;

    if (guildStoryId !== null) {
      const storyId = await resolveStoryId(connection, guildId, guildStoryId);
      if (storyId === null) {
        return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
      }
      const [rows] = await connection.execute(
        `SELECT sw.story_writer_id, s.story_id, s.title, s.guild_story_id
         FROM story_writer sw
         JOIN story s ON sw.story_id = s.story_id
         WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1`,
        [storyId, guildId, userId]
      );
      storiesToPause = rows;
    } else {
      const [rows] = await connection.execute(
        `SELECT sw.story_writer_id, s.story_id, s.title, s.guild_story_id
         FROM story_writer sw
         JOIN story s ON sw.story_id = s.story_id
         WHERE s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1`,
        [guildId, userId]
      );
      storiesToPause = rows;
    }

    if (storiesToPause.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveStoriesToPause', guildId) });
    }

    const pausedTitles = [];

    for (const story of storiesToPause) {
      // Check if it's currently the user's turn
      const [activeTurnRows] = await connection.execute(
        `SELECT t.turn_id, t.thread_id FROM turn t
         JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
         WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
        [story.story_id, userId]
      );

      // Pause the writer first so PickNextWriter excludes them
      await connection.execute(
        `UPDATE story_writer SET sw_status = 2 WHERE story_writer_id = ?`,
        [story.story_writer_id]
      );

      if (activeTurnRows.length > 0) {
        // Auto-pass: end the current turn and advance to the next writer
        const activeTurn = activeTurnRows[0];
        await connection.execute(
          `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
          [activeTurn.turn_id]
        );
        if (activeTurn.thread_id) {
          try {
            const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
            if (thread) await thread.delete('Writer paused — turn passed');
          } catch (err) {
            log(`Failed to delete thread on pause for story ${story.story_id}: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
        try {
          const nextWriterId = await PickNextWriter(connection, story.story_id);
          if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
        } catch (err) {
          log(`Could not advance turn after pause for story ${story.story_id}: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }

      pausedTitles.push(`${story.title} (#${story.guild_story_id})`);
    }

    const cfg = await getConfigValue(connection, ['txtPauseDM', 'txtPauseSuccess'], guildId);
    const storyList = pausedTitles.map(title => `• ${title}`).join('\n');
    const dmText = replaceTemplateVariables(cfg.txtPauseDM, {
      story_list: storyList,
      resume_command: '/mystory resume'
    });

    try {
      await interaction.user.send(dmText);
    } catch (dmErr) {
      log(`Could not send pause DM to ${interaction.user.username}: ${dmErr}`, { show: true, guildName: interaction?.guild?.name });
    }

    log(`${interaction.user.username} paused in ${pausedTitles.length} story(s): ${pausedTitles.join(', ')}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: cfg.txtPauseSuccess });

  } catch (error) {
    log(`Error in handlePause: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

/**
 * /mystory resume [story_id] — resume participation in one or all paused stories.
 */
async function handleResume(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const _rawStoryId = interaction.options.getString('story_id');
  const guildStoryId = _rawStoryId != null ? parseInt(_rawStoryId, 10) : null;

  try {
    let storiesToResume;

    if (guildStoryId !== null) {
      const storyId = await resolveStoryId(connection, guildId, guildStoryId);
      if (storyId === null) {
        return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
      }
      const [rows] = await connection.execute(
        `SELECT sw.story_writer_id, s.title, s.guild_story_id
         FROM story_writer sw
         JOIN story s ON sw.story_id = s.story_id
         WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 2`,
        [storyId, guildId, userId]
      );
      storiesToResume = rows;
    } else {
      const [rows] = await connection.execute(
        `SELECT sw.story_writer_id, s.title, s.guild_story_id
         FROM story_writer sw
         JOIN story s ON sw.story_id = s.story_id
         WHERE s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 2`,
        [guildId, userId]
      );
      storiesToResume = rows;
    }

    if (storiesToResume.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNotPaused', guildId) });
    }

    for (const story of storiesToResume) {
      await connection.execute(
        `UPDATE story_writer SET sw_status = 1 WHERE story_writer_id = ?`,
        [story.story_writer_id]
      );
    }

    const resumedTitles = storiesToResume.map(s => `${s.title} (#${s.guild_story_id})`).join(', ');
    log(`${interaction.user.username} resumed in: ${resumedTitles}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtResumeSuccess', guildId) });

  } catch (error) {
    log(`Error in handleResume: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /mystory manage — self-service writer settings panel
// ---------------------------------------------------------------------------

function buildMyStoryManagePanel(state, cfg) {
  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtMyStoryManageTitle, { story_title: state.storyTitle }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblMyStoryManageAO3,     value: state.ao3Name || '*Not set*',                                   inline: true },
      { name: cfg.lblMyStoryManageNotif,   value: state.notificationPrefs === 'dm' ? 'DM' : 'Mention in channel', inline: true },
      { name: cfg.lblMyStoryManagePrivacy, value: state.turnPrivacy ? 'Private' : 'Public',                       inline: true }
    );

  const notifToggleLabel   = state.notificationPrefs === 'dm' ? 'Switch to: Mention' : 'Switch to: DM';
  const privacyToggleLabel = state.turnPrivacy ? 'Make Public' : 'Make Private';

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_ao3').setLabel(cfg.btnAdminMUAO3Name).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_notif').setLabel(notifToggleLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_privacy').setLabel(privacyToggleLabel).setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_save').setLabel(cfg.btnMyStoryManageSave).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mystory_manage_cancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function handleMyStoryManage(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));

  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    const [writerRows] = await connection.execute(
      `SELECT story_writer_id, AO3_name, notification_prefs, turn_privacy
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (1, 2)`,
      [storyId, interaction.user.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId) });
    }
    const writer = writerRows[0];

    const cfg = await getConfigValue(connection, [
      'txtMyStoryManageTitle', 'lblMyStoryManageAO3', 'lblMyStoryManageNotif',
      'lblMyStoryManagePrivacy', 'btnMyStoryManageSave', 'btnCancel', 'btnAdminMUAO3Name'
    ], guildId);

    const state = {
      storyId,
      guildId,
      storyTitle: storyRows[0].title,
      storyWriterId: writer.story_writer_id,
      ao3Name: writer.AO3_name,
      notificationPrefs: writer.notification_prefs,
      turnPrivacy: writer.turn_privacy,
      originalInteraction: interaction,
      cfg
    };

    pendingMyStoryManageData.set(interaction.user.id, state);
    await interaction.editReply(buildMyStoryManagePanel(state, cfg));

  } catch (error) {
    log(`Error in handleMyStoryManage: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleMyStoryManageButton(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingMyStoryManageData.get(userId);
  const customId = interaction.customId;

  if (!state) {
    await interaction.deferUpdate();
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), embeds: [], components: [] });
  }

  if (customId === 'mystory_manage_notif') {
    await interaction.deferUpdate();
    state.notificationPrefs = state.notificationPrefs === 'dm' ? 'mention' : 'dm';
    await interaction.editReply(buildMyStoryManagePanel(state, state.cfg));

  } else if (customId === 'mystory_manage_privacy') {
    await interaction.deferUpdate();
    state.turnPrivacy = state.turnPrivacy ? 0 : 1;
    await interaction.editReply(buildMyStoryManagePanel(state, state.cfg));

  } else if (customId === 'mystory_manage_ao3') {
    const modal = new ModalBuilder()
      .setCustomId('mystory_manage_ao3_modal')
      .setTitle('Set AO3 Name')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ao3_name_input')
            .setLabel('AO3 Name')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Leave blank to clear')
            .setValue(state.ao3Name ?? '')
        )
      );
    await interaction.showModal(modal);

  } else if (customId === 'mystory_manage_save') {
    await interaction.deferUpdate();
    try {
      await connection.execute(
        `UPDATE story_writer SET AO3_name = ?, notification_prefs = ?, turn_privacy = ? WHERE story_writer_id = ?`,
        [state.ao3Name, state.notificationPrefs, state.turnPrivacy, state.storyWriterId]
      );
      pendingMyStoryManageData.delete(userId);
      await interaction.editReply({
        content: await getConfigValue(connection, 'txtMyStoryManageSaved', state.guildId),
        embeds: [],
        components: []
      });
    } catch (error) {
      log(`Error saving mystory manage: ${error}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', state.guildId), embeds: [], components: [] });
    }

  } else if (customId === 'mystory_manage_cancel') {
    await interaction.deferUpdate();
    pendingMyStoryManageData.delete(userId);
    await interaction.editReply({
      content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
}

async function handleMyStoryManageModal(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingMyStoryManageData.get(userId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const rawName = interaction.fields.getTextInputValue('ao3_name_input');
    const newName = sanitizeModalInput(rawName, 100) || null;
    state.ao3Name = newName;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildMyStoryManagePanel(state, state.cfg));
    await interaction.deleteReply();
  } catch (error) {
    log(`Error in handleMyStoryManageModal: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'mystory_manage_ao3_modal') {
    await handleMyStoryManageModal(connection, interaction);
  }
}

async function handleAutocomplete(connection, interaction) {
  if (!interaction.guild) return interaction.respond([]);

  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== 'story_id') return interaction.respond([]);

  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();
  const typed = `%${focusedOption.value}%`;
  const typedPrefix = `${focusedOption.value}%`;

  let rows;

  if (subcommand === 'pass') {
    // Only stories where it is currently the user's active turn
    [rows] = await connection.execute(
      `SELECT s.guild_story_id, s.title FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       JOIN turn t ON t.story_writer_id = sw.story_writer_id AND t.turn_status = 1
       WHERE s.guild_id = ? AND s.story_status = 1
         AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
       ORDER BY s.guild_story_id LIMIT 25`,
      [interaction.user.id, guildId, typed, typedPrefix]
    );

  } else if (subcommand === 'catchup') {
    // Non-closed stories the user is in that have at least one confirmed entry
    [rows] = await connection.execute(
      `SELECT s.guild_story_id, s.title FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       WHERE s.guild_id = ? AND s.story_status != 3 AND sw.sw_status IN (1, 2)
         AND EXISTS (
           SELECT 1 FROM story_entry se
           JOIN turn t ON se.turn_id = t.turn_id
           JOIN story_writer sw2 ON t.story_writer_id = sw2.story_writer_id
           WHERE sw2.story_id = s.story_id AND se.entry_status = 'confirmed'
         )
         AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
       ORDER BY s.guild_story_id LIMIT 25`,
      [interaction.user.id, guildId, typed, typedPrefix]
    );

  } else {
    const swStatusFilter =
      subcommand === 'pause'  ? '= 1' :
      subcommand === 'resume' ? '= 2' : 'IN (1, 2)';

    [rows] = await connection.execute(
      `SELECT s.guild_story_id, s.title FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id
       WHERE s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status ${swStatusFilter}
         AND s.story_status != 3
         AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
       ORDER BY s.guild_story_id LIMIT 25`,
      [guildId, interaction.user.id, typed, typedPrefix]
    );
  }

  return interaction.respond(
    (rows ?? []).map(r => ({
      name: `${r.title} (#${r.guild_story_id})`.slice(0, 100),
      value: String(r.guild_story_id)
    }))
  );
}

export default { data, execute, handleButtonInteraction, handleModalSubmit, handleAutocomplete };
