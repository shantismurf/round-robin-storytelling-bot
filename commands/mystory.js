import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId } from '../utilities.js';
import { PickNextWriter, NextTurn, deleteThreadAndAnnouncement } from '../story/_turn.js';
import { handleWriterHelp } from '../faq.js';

// Cached catchup pages keyed by "catchup_<userId>_<storyId>"
const pendingCatchUpData = new Map();

// Pending /mystory manage sessions keyed by user ID
const pendingMyStoryManageData = new Map();

const data = new SlashCommandBuilder()
  .setName('mystory')
  .setDescription('Your personal story dashboard')
  .addSubcommand(s =>
    s.setName('list')
      .setDescription('See all your stories — active, paused, delayed, and closed')
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
    s.setName('manage')
      .setDescription('Update settings or take action for one of your stories')
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
  log(`execute: entry subcommand=${interaction.options.getSubcommand()} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'list') await handleList(connection, interaction);
  else if (subcommand === 'catchup') await handleCatchUp(connection, interaction);
  else if (subcommand === 'manage') await handleMyStoryManage(connection, interaction);
  else if (subcommand === 'help') await handleWriterHelp(connection, interaction);
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('catchup_prev_') || interaction.customId.startsWith('catchup_next_')) {
    await handleCatchUpNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_list_prev_') || interaction.customId.startsWith('mystory_list_next_')) {
    await handleListNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_leave_confirm_')) {
    await handlePanelLeaveConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_leave_cancel_') || interaction.customId.startsWith('mystory_manage_pass_cancel_') || interaction.customId.startsWith('mystory_manage_pause_cancel_')) {
    await handlePanelActionCancel(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_pass_confirm_')) {
    await handlePanelPassConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_pause_confirm_')) {
    await handlePanelPauseConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('mystory_manage_')) {
    await handleMyStoryManageButton(connection, interaction);
  }
}


const LIST_PAGE_SIZE = 5;

/**
 * /mystory list — merged active+history, sorted active→paused→delayed→closed, paginated
 */
async function handleList(connection, interaction) {
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

async function handleListNavigation(connection, interaction) {
  await interaction.deferUpdate();
  const parts = interaction.customId.split('_');
  const direction = parts[2]; // 'prev' or 'next'
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

/**
 * /mystory catchup — paginated view of entries since user's last turn
 */
async function handleCatchUp(connection, interaction) {
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

    // Find the user's most recent turn that produced a confirmed entry.
    // Skipped/timed-out turns (turn_status=0, no confirmed entry) are excluded so
    // the anchor lands on the last turn the user actually wrote.
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

async function handleCatchUpNavigation(connection, interaction) {
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

// ---------------------------------------------------------------------------
// /mystory manage — self-service writer settings panel
// ---------------------------------------------------------------------------

function buildMyStoryManagePanel(state, cfg) {
  const statusLabel = state.writerStatus === 1
    ? cfg.txtMyStoryManageActiveStatus
    : cfg.txtMyStoryManagePausedStatus;

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtMyStoryManageTitle, { story_title: state.storyTitle }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblMyStoryManageStatus,  value: statusLabel,                                                      inline: true },
      { name: cfg.lblMyStoryManageAO3,     value: state.ao3Name || cfg.txtNotSet,                                   inline: true },
      { name: cfg.lblMyStoryManageNotif,   value: state.notificationPrefs === 'dm' ? cfg.txtNotifDM : cfg.txtNotifMention, inline: true },
      { name: cfg.lblMyStoryManagePrivacy, value: state.turnPrivacy ? cfg.txtPrivate : cfg.txtPublic,               inline: true }
    )
    .setDescription(cfg.txtMyStoryManagePanelDesc);

  const notifToggleLabel   = state.notificationPrefs === 'dm' ? cfg.btnManageUserSwitchMention : cfg.btnManageUserSwitchDM;
  const privacyToggleLabel = state.turnPrivacy ? cfg.btnManageUserMakePublic : cfg.btnManageUserMakePrivate;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_ao3').setLabel(cfg.btnAdminMUAO3Name).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_notif').setLabel(notifToggleLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mystory_manage_privacy').setLabel(privacyToggleLabel).setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mystory_manage_save').setLabel(cfg.btnMyStoryManageSave).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mystory_manage_cancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
  );

  const pauseResumeLabel = state.writerStatus === 1 ? cfg.btnMyStoryManagePause : cfg.btnMyStoryManageResume;
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mystory_manage_pass')
      .setLabel(cfg.btnMyStoryManagePass)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state.hasActiveTurn),
    new ButtonBuilder()
      .setCustomId(state.writerStatus === 1 ? 'mystory_manage_pause' : 'mystory_manage_resume')
      .setLabel(pauseResumeLabel)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mystory_manage_leave')
      .setLabel(cfg.btnMyStoryManageLeave)
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

async function handleMyStoryManage(connection, interaction) {
  log(`handleMyStoryManage: entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
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
      `SELECT story_writer_id, AO3_name, notification_prefs, turn_privacy, sw_status
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (1, 2)`,
      [storyId, interaction.user.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId) });
    }
    const writer = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, interaction.user.id]
    );
    log(`handleMyStoryManage: writerStatus=${writer.sw_status} hasActiveTurn=${activeTurnRows.length > 0}`, { show: false, guildName: interaction?.guild?.name });

    const cfg = await getConfigValue(connection, [
      'txtMyStoryManageTitle', 'lblMyStoryManageStatus', 'lblMyStoryManageAO3', 'lblMyStoryManageNotif',
      'lblMyStoryManagePrivacy', 'btnMyStoryManageSave', 'btnCancel', 'btnAdminMUAO3Name',
      'btnMyStoryManagePause', 'btnMyStoryManageResume', 'btnMyStoryManagePass', 'btnMyStoryManageLeave',
      'txtMyStoryManageActiveStatus', 'txtMyStoryManagePausedStatus',
      'txtNotSet', 'txtNotifDM', 'txtNotifMention', 'txtPrivate', 'txtPublic',
      'txtMyStoryManagePanelDesc',
      'btnManageUserSwitchMention', 'btnManageUserSwitchDM',
      'btnManageUserMakePublic', 'btnManageUserMakePrivate',
      'lblJoinSetAO3ModalTitle', 'lblMyStoryManageAO3', 'txtAdminMUAO3Placeholder',
    ], guildId);

    const state = {
      storyId,
      guildId,
      storyTitle: storyRows[0].title,
      storyWriterId: writer.story_writer_id,
      writerStatus: writer.sw_status,
      ao3Name: writer.AO3_name,
      notificationPrefs: writer.notification_prefs,
      turnPrivacy: writer.turn_privacy,
      hasActiveTurn: activeTurnRows.length > 0,
      originalInteraction: interaction,
      cfg
    };

    pendingMyStoryManageData.set(interaction.user.id, state);
    await interaction.editReply(buildMyStoryManagePanel(state, cfg));

  } catch (error) {
    log(`handleMyStoryManage failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleMyStoryManageButton(connection, interaction) {
  log(`handleMyStoryManageButton: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
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
      .setTitle(state.cfg.lblJoinSetAO3ModalTitle)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ao3_name_input')
            .setLabel(state.cfg.lblMyStoryManageAO3)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(state.cfg.txtAdminMUAO3Placeholder)
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
      log(`mystory manage saved for writer ${state.storyWriterId} in story ${state.storyId}`, { show: true, guildName: interaction?.guild?.name });
      pendingMyStoryManageData.delete(userId);
      await interaction.editReply({ content: await getConfigValue(connection, 'txtMyStoryManageSaved', state.guildId), embeds: [], components: [] });
    } catch (error) {
      log(`mystory manage save failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', state.guildId), embeds: [], components: [] });
    }

  } else if (customId === 'mystory_manage_cancel') {
    await interaction.deferUpdate();
    pendingMyStoryManageData.delete(userId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });

  } else if (customId === 'mystory_manage_pass') {
    await interaction.deferUpdate();
    const cfg = state.cfg;
    const confirmMsg = replaceTemplateVariables(cfg.txtMyPassConfirm, { story_title: state.storyTitle });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mystory_manage_pass_confirm_${state.storyId}`).setLabel(cfg.btnMyPassConfirm).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mystory_manage_pass_cancel_${state.storyId}`).setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ content: confirmMsg, embeds: [], components: [row] });

  } else if (customId === 'mystory_manage_pause') {
    await interaction.deferUpdate();
    const cfg = state.cfg;
    const confirmMsg = replaceTemplateVariables(cfg.txtMyPauseConfirm, { story_title: state.storyTitle });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mystory_manage_pause_confirm_${state.storyId}`).setLabel(cfg.btnMyPauseConfirm).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mystory_manage_pause_cancel_${state.storyId}`).setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ content: confirmMsg, embeds: [], components: [row] });

  } else if (customId === 'mystory_manage_resume') {
    await interaction.deferUpdate();
    try {
      await connection.execute(
        `UPDATE story_writer SET sw_status = 1 WHERE story_writer_id = ?`,
        [state.storyWriterId]
      );
      log(`${interaction.user.username} resumed in story ${state.storyId}`, { show: true, guildName: interaction?.guild?.name });
      state.writerStatus = 1;
      pendingMyStoryManageData.delete(userId);
      const successMsg = replaceTemplateVariables(state.cfg.txtMyResumeSuccess, { story_title: state.storyTitle });
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });
    } catch (error) {
      log(`mystory manage resume failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', state.guildId), embeds: [], components: [] });
    }

  } else if (customId === 'mystory_manage_leave') {
    await interaction.deferUpdate();
    const cfg = state.cfg;
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [state.storyId, userId]
    );
    const [writerCountRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [state.storyId, userId]
    );
    const isMyTurn = activeTurnRows.length > 0;
    const isLastWriter = writerCountRows[0].count === 0;

    let confirmKey;
    if (isLastWriter) confirmKey = 'txtLeaveConfirmLastWriter';
    else if (isMyTurn) confirmKey = 'txtLeaveConfirmMyTurn';
    else confirmKey = 'txtLeaveConfirm';

    const [confirmMsg, btnLeaveStory, btnCancel] = await Promise.all([
      getConfigValue(connection, confirmKey, state.guildId),
      getConfigValue(connection, 'btnLeaveStory', state.guildId),
      getConfigValue(connection, 'btnCancel', state.guildId)
    ]);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mystory_manage_leave_confirm_${state.storyId}`).setLabel(btnLeaveStory).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mystory_manage_leave_cancel_${state.storyId}`).setLabel(btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ content: replaceTemplateVariables(confirmMsg, { story_title: state.storyTitle }), embeds: [], components: [row] });
  }
}

async function handlePanelPassConfirm(connection, interaction) {
  log(`handlePanelPassConfirm: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_').at(-1));
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
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId), components: [] });
      return;
    }
    const turn = turnInfo[0];
    await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [turn.turn_id]);
    const nextWriterId = await PickNextWriter(connection, storyId);
    await NextTurn(connection, interaction, nextWriterId);
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        if (thread) await thread.delete('Turn passed from manage panel');
      } catch (err) {
        log(`handlePanelPassConfirm: failed to delete thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }
    pendingMyStoryManageData.delete(userId);
    log(`${interaction.user.username} passed turn in story ${storyId} via manage panel`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtMyPassSuccess', guildId), embeds: [], components: [] });
  } catch (error) {
    log(`handlePanelPassConfirm failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handlePanelPauseConfirm(connection, interaction) {
  log(`handlePanelPauseConfirm: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [writerRows] = await connection.execute(
      `SELECT sw.story_writer_id, s.title, s.guild_story_id FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status = 1`,
      [storyId, guildId, userId]
    );
    if (writerRows.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId), components: [] });
      return;
    }
    const story = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );

    await connection.execute(`UPDATE story_writer SET sw_status = 2 WHERE story_writer_id = ?`, [story.story_writer_id]);

    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurn.turn_id]);
      if (activeTurn.thread_id) {
        try {
          const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
          if (thread) await thread.delete('Writer paused — turn passed');
        } catch (err) {
          log(`handlePanelPauseConfirm: failed to delete thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
      try {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      } catch (err) {
        log(`handlePanelPauseConfirm: failed to advance turn: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

    pendingMyStoryManageData.delete(userId);
    log(`${interaction.user.username} paused in story ${storyId} via manage panel`, { show: true, guildName: interaction?.guild?.name });
    const storyTitle = `${story.title} (#${story.guild_story_id})`;
    const successMsg = replaceTemplateVariables(await getConfigValue(connection, 'txtMyPauseSuccess', guildId), { story_title: storyTitle });
    await interaction.editReply({ content: successMsg, embeds: [], components: [] });
  } catch (error) {
    log(`handlePanelPauseConfirm failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handlePanelLeaveConfirm(connection, interaction) {
  log(`handlePanelLeaveConfirm: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  try {
    const [writerRows] = await connection.execute(
      `SELECT sw.story_writer_id FROM story_writer sw
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status IN (1, 2)`,
      [storyId, guildId, userId]
    );
    if (writerRows.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNotActiveWriter', guildId), components: [] });
      return;
    }

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, userId]
    );
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, userId]
    );
    const isLastWriter = remainingRows[0].count === 0;

    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurn.turn_id]);
      if (activeTurn.thread_id) {
        try {
          const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
          if (thread) await deleteThreadAndAnnouncement(thread);
        } catch (err) {
          log(`handlePanelLeaveConfirm: failed to delete thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
    }

    await connection.execute(`UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_id = ? AND discord_user_id = ?`, [storyId, userId]);

    if (isLastWriter) {
      await connection.execute(`UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`, [storyId]);
      log(`Story ${storyId} auto-closed — last writer left via manage panel`, { show: true, guildName: interaction?.guild?.name });
    } else if (activeTurnRows.length > 0) {
      try {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      } catch (err) {
        log(`handlePanelLeaveConfirm: failed to advance turn: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

    pendingMyStoryManageData.delete(userId);
    log(`${interaction.user.username} left story ${storyId} via manage panel`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtLeftStorySuccess', guildId), embeds: [], components: [] });
  } catch (error) {
    log(`handlePanelLeaveConfirm failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handlePanelActionCancel(connection, interaction) {
  log(`handlePanelActionCancel: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const state = pendingMyStoryManageData.get(userId);
  if (state) {
    await interaction.editReply(buildMyStoryManagePanel(state, state.cfg));
  } else {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
  }
}

async function handleMyStoryManageModal(connection, interaction) {
  log(`handleMyStoryManageModal: entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
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
    log(`handleMyStoryManageModal failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
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

  if (subcommand === 'catchup') {
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
    [rows] = await connection.execute(
      `SELECT s.guild_story_id, s.title FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id
       WHERE s.guild_id = ? AND sw.discord_user_id = ? AND sw.sw_status IN (1, 2)
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
