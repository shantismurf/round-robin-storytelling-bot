import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, getTurnNumber, sanitizeModalInput, log, replaceTemplateVariables, isGuildConfigured, resolveStoryId, chunkEntryContent, checkIsAdmin } from '../utilities.js';
import { marked } from 'marked';
import { CreateStory, PickNextWriter, NextTurn, updateStoryStatusMessage, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';
import { postStoryFeedJoinAnnouncement, postStoryFeedClosedAnnouncement } from '../announcements.js';

// Temporary storage for first modal data while user completes second modal
const pendingStoryData = new Map();

// Pending manage edit sessions keyed by userId
const pendingManageData = new Map();

// Pending join sessions keyed by userId
const pendingJoinData = new Map();

// Pending edit sessions keyed by userId
const pendingEditData = new Map();

// Convert Discord markdown to HTML for export
// guild is optional — pass the Discord guild object to resolve mentions, channels, and roles
async function discordMarkdownToHtml(text, guild = null) {
  // Custom emoji <:name:id> → Discord CDN img (static)
  text = text.replace(/<:([^:>]+):(\d+)>/g, (_, name, id) =>
    `<img src="https://cdn.discordapp.com/emojis/${id}.png" height="20" alt=":${name}:" style="vertical-align:middle">`
  );
  // Animated emoji <a:name:id> → Discord CDN img (animated gif)
  text = text.replace(/<a:([^:>]+):(\d+)>/g, (_, name, id) =>
    `<img src="https://cdn.discordapp.com/emojis/${id}.gif" height="20" alt=":${name}:" style="vertical-align:middle">`
  );

  // Discord timestamps <t:unix:format> → [timestamp]
  text = text.replace(/<t:\d+(?::[A-Za-z])?>/g, '[timestamp]');

  // Resolve mentions
  if (guild) {
    // Batch-fetch all mentioned users first (avoid duplicate requests)
    const userIds = [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map(m => m[1]))];
    const memberMap = new Map();
    for (const userId of userIds) {
      try {
        const member = await guild.members.fetch(userId);
        memberMap.set(userId, member.displayName);
      } catch {
        memberMap.set(userId, userId);
      }
    }
    text = text.replace(/<@!?(\d+)>/g, (_, id) => `@${memberMap.get(id) ?? id}`);
    text = text.replace(/<#(\d+)>/g, (_, id) => {
      const ch = guild.channels.cache.get(id);
      return ch ? `#${ch.name}` : `#${id}`;
    });
    text = text.replace(/<@&(\d+)>/g, (_, id) => {
      const role = guild.roles.cache.get(id);
      return role ? `@${role.name}` : `@${id}`;
    });
  } else {
    text = text.replace(/<@!?(\d+)>/g, '@[user]');
    text = text.replace(/<#(\d+)>/g, '#[channel]');
    text = text.replace(/<@&(\d+)>/g, '@[role]');
  }

  // Pre-process Discord blockquote syntax and -# subtext before marked sees it
  const lines = text.split('\n');
  const processed = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // -# subtext → wrapped in a styled paragraph (HTML block, marked leaves it alone)
    if (line.startsWith('-# ')) {
      processed.push(`<p class="subtext">${line.slice(3)}</p>`);
      i++;
      continue;
    }
    // Discord >>> multi-line quote: everything from here to end is one blockquote
    if (line.startsWith('>>> ') || line === '>>>') {
      const firstContent = line.startsWith('>>> ') ? line.slice(4) : '';
      if (firstContent) processed.push(`> ${firstContent}`);
      i++;
      while (i < lines.length) {
        processed.push(`> ${lines[i]}`);
        i++;
      }
      continue;
    }
    // Discord single-line > quote: only quotes that line, then closes
    if (line.startsWith('> ') || line === '>') {
      processed.push(line);
      // Insert blank line after to close blockquote if next line isn't also quoted
      if (i + 1 < lines.length && !lines[i + 1].startsWith('>')) {
        processed.push('');
      }
      i++;
      continue;
    }
    processed.push(line);
    i++;
  }
  text = processed.join('\n');

  // Discord __underline__ → <u> before marked sees it (marked treats __ as bold)
  text = text.replace(/__(.*?)__/gs, '<u>$1</u>');
  // Discord ||spoiler|| → styled span
  text = text.replace(/\|\|(.*?)\|\|/gs, '<span class="spoiler">$1</span>');
  // Strip any legacy ![]() image syntax so marked doesn't try to render it
  // (we'll handle image URLs after marked runs, to avoid marked escaping injected HTML)
  text = text.replace(/!\[\]\((https:\/\/cdn\.discordapp\.com\/attachments\/[^\s)]+)\)/g, '$1');

  // Run through marked with breaks:true so single newlines render as line breaks (matching Discord behaviour)
  let html = marked.parse(text, { breaks: true });

  // Convert Discord CDN attachment image URLs to clickable <img> tags after marked has run
  // so marked can't escape the HTML we inject
  html = html.replace(
    /(?<!href=")(https:\/\/cdn\.discordapp\.com\/attachments\/[^\s<"]+)/g,
    '<a href="$1"><img src="$1" style="max-width:100%;display:block;margin:8px 0"></a>'
  );

  return html;
}

// Tracks pending DM reminder timeouts by entryId so they can be cancelled on confirm/discard
const pendingReminderTimeouts = new Map();
const pendingReadData = new Map(); // userId -> { pages, currentPage, storyId, title, wordCount, showAuthors, guildId }
const lastReadPage = new Map();   // `${userId}_${storyId}` -> pageIndex (persists across /story read sessions)

const data = new SlashCommandBuilder()
  .setName('story')
  .setDescription('Manage stories')
  .addSubcommand(subcommand =>
    subcommand
      .setName('add')
      .setDescription('Create a new story')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('Browse available stories')
      .addStringOption(option =>
        option.setName('filter')
          .setDescription('Filter stories by type')
          .setRequired(false)
          .addChoices(
            { name: 'All Stories', value: 'all' },
            { name: 'Joinable Stories', value: 'joinable' },
            { name: 'My Stories', value: 'mine' },
            { name: 'Active Stories', value: 'active' },
            { name: 'Paused Stories', value: 'paused' }
          ))
      .addIntegerOption(option =>
        option.setName('page')
          .setDescription('Page number')
          .setRequired(false)
          .setMinValue(1))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('write')
      .setDescription('Submit your entry for a story (quick mode only)')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID where you want to submit')
          .setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('join')
      .setDescription('Join an existing story as a writer')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID you want to join')
          .setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('read')
      .setDescription('Read the story in Discord, page by page, with an option to export as HTML')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID to read')
          .setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('close')
      .setDescription('Close a story (creator or admin only)')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID to close')
          .setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('manage')
      .setDescription('Edit story settings, pause, or resume (creator or admin only)')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID to manage')
          .setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('timeleft')
      .setDescription('Check the current turn status for a story')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID to check')
          .setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('help')
      .setDescription('How to use Round Robin StoryBot')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('edit')
      .setDescription('Edit a confirmed story entry')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID (your guild-scoped story number)')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('turn')
          .setDescription('Turn number (as shown in /story read)')
          .setRequired(true)
          .setMinValue(1)
          .setAutocomplete(true))
  );

async function execute(connection, interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  log(`execute() called with subcommand '${subcommand}'`, { show: false, guildName: interaction?.guild?.name });

  if (!await isGuildConfigured(connection, interaction.guild.id)) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtNotConfigured', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'add') {
    await handleAddStory(connection, interaction);
  } else if (subcommand === 'list') {
    await handleListStories(connection, interaction);
  } else if (subcommand === 'write') {
    await handleWrite(connection, interaction);
  } else if (subcommand === 'join') {
    await handleJoin(connection, interaction);
  } else if (subcommand === 'read') {
    await handleRead(connection, interaction);
  } else if (subcommand === 'close') {
    await handleClose(connection, interaction);
  } else if (subcommand === 'manage') {
    await handleManage(connection, interaction);
  } else if (subcommand === 'timeleft') {
    await handleTimeleft(connection, interaction);
  } else if (subcommand === 'help') {
    await handleHelp(connection, interaction);
  } else if (subcommand === 'edit') {
    await handleEdit(connection, interaction);
  } else {
    log(`execute() - unrecognized subcommand '${subcommand}', no handler matched`, { show: false, guildName: interaction?.guild?.name });
  }
}

async function getPreviousAO3Name(connection, userId) {
  try {
    const [rows] = await connection.execute(
      `SELECT AO3_name FROM story_writer WHERE discord_user_id = ? AND AO3_name IS NOT NULL AND AO3_name != '' ORDER BY joined_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0]?.AO3_name ?? null;
  } catch { return null; }
}

async function handleAddStory(connection, interaction) {
  log('handleAddStory() - initializing ephemeral story form', { show: false, guildName: interaction?.guild?.name });

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cfg = await getConfigValue(connection, [
      'txtCreateStoryTitle', 'txtStoryAddIntro', 'txtStoryTitlePrompt',
      'txtNormalModeDesc', 'txtQuickModeDesc',
      'txtHideThreadsOffDesc', 'txtHideThreadsOnDesc',
      'btnSetTitle', 'btnSetTurnLength', 'btnSetTimeout',
      'btnSetAO3Name', 'btnSetDelayHours', 'btnSetDelayWriters', 'btnCreateStory',
      'lblModeToggle', 'lblHideToggle', 'lblPrivateToggle', 'txtPrivateOffDesc', 'txtPrivateOnDesc',
      'lblStoryTitle', 'lblTurnLength', 'lblTimeoutReminder',
      'lblDelayStart', 'txtDelayHint', 'lblYourAO3Name',
      'lblNoHours', 'lblNoWriters',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'txtOrderRandomDesc', 'txtOrderRoundRobinDesc', 'txtOrderFixedDesc',
      'lblShowAuthors', 'txtShowAuthorsOnDesc', 'txtShowAuthorsOffDesc',
      'lblMaxWriters', 'btnSetMaxWriters'
    ], interaction.guild.id);

    const state = {
      cfg,
      storyTitle: null,
      quickMode: 0,
      hideThreads: 0,
      turnLength: 24,
      timeoutReminder: 50,
      ao3Name: (await getPreviousAO3Name(connection, interaction.user.id)) || interaction.member?.displayName || interaction.user.displayName,
      keepPrivate: 0,
      delayHours: null,
      delayWriters: null,
      orderType: 1,
      showAuthors: 1,
      maxWriters: null
    };

    pendingStoryData.set(interaction.user.id, {
      ...state,
      originalInteraction: interaction
    });

    await interaction.editReply(buildStoryAddMessage(cfg, state));

    log('handleAddStory() - ephemeral form sent', { show: false, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in handleAddStory: ${error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: await getConfigValue(connection, 'txtFormOpenError', interaction.guild.id),
        flags: MessageFlags.Ephemeral
      });
    }
  }
}

function buildStoryAddMessage(cfg, state) {
  const modeEmoji = state.quickMode ? '🟣' : '🟢';
  const modeLabel = state.quickMode ? 'Quick' : 'Normal';
  const modeDesc = state.quickMode ? cfg.txtQuickModeDesc : cfg.txtNormalModeDesc;
  const hideDesc = state.hideThreads ? cfg.txtHideThreadsOnDesc : cfg.txtHideThreadsOffDesc;
  const privateDesc = state.keepPrivate ? cfg.txtPrivateOnDesc : cfg.txtPrivateOffDesc;
  const privateLabel = state.keepPrivate ? 'Yes' : 'No';
  const showAuthorsDesc = state.showAuthors ? cfg.txtShowAuthorsOnDesc : cfg.txtShowAuthorsOffDesc;
  const timeoutDisplay = state.timeoutReminder === 0 ? 'None (0%)' : `${state.timeoutReminder}%`;
  const delayHours = state.delayHours ?? 0;
  const delayWriters = state.delayWriters ?? 0;
  const maxWritersDisplay = state.maxWriters ? String(state.maxWriters) : '∞';
  const titleDisplay = state.storyTitle || cfg.txtStoryTitlePrompt;
  const orderEmojis = { 1: '🎲', 2: '🔄', 3: '📋' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderDescs = { 1: cfg.txtOrderRandomDesc, 2: cfg.txtOrderRoundRobinDesc, 3: cfg.txtOrderFixedDesc };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const orderDesc = orderDescs[state.orderType];

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtCreateStoryTitle)
    .setDescription(cfg.txtStoryAddIntro)
    .addFields(
      { name: cfg.lblStoryTitle, value: titleDisplay, inline: false },
      { name: `${modeEmoji} ${cfg.lblModeToggle}`, value: `${modeLabel} — ${modeDesc}`, inline: false },
      { name: `${orderEmoji} ${cfg.lblWriterOrder}`, value: `${orderLabel} — ${orderDesc}`, inline: false },
      { name: cfg.lblTurnLength, value: `${state.turnLength} hours`, inline: true },
      { name: cfg.lblTimeoutReminder, value: timeoutDisplay, inline: true },
      { name: cfg.lblHideToggle, value: hideDesc, inline: false },
      { name: cfg.lblYourAO3Name, value: state.ao3Name, inline: true },
      { name: cfg.lblPrivateToggle, value: `${privateLabel} — ${privateDesc}`, inline: false },
      { name: cfg.lblShowAuthors, value: `${state.showAuthors ? 'Yes' : 'No'} — ${showAuthorsDesc}`, inline: false },
      { name: cfg.lblMaxWriters, value: maxWritersDisplay, inline: true },
      { name: cfg.lblDelayStart, value: `*${cfg.txtDelayHint}*\n${delayHours} hours / ${delayWriters} writers`, inline: false }
    )
    .setColor(state.quickMode ? 0xE040FB : 0x57F287);

  // Row 1: Set Story Title
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_set_title')
      .setLabel(cfg.btnSetTitle)
      .setStyle(ButtonStyle.Primary)
  );

  // Row 2: Story Mode toggle
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_toggle_mode')
      .setLabel(`${modeEmoji} ${cfg.lblModeToggle}: ${modeLabel}`)
      .setStyle(state.quickMode ? ButtonStyle.Secondary : ButtonStyle.Success)
  );

  // Row 3: Set Turn Length, Set Timeout Reminder Interval, Hide Threads toggle, Writer Order cycle, Show Authors toggle
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_set_turnlength')
      .setLabel(cfg.btnSetTurnLength)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_timeout')
      .setLabel(cfg.btnSetTimeout)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_toggle_hide')
      .setLabel(`${cfg.lblHideToggle}: ${state.hideThreads ? 'On' : 'Off'}`)
      .setStyle(state.hideThreads ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_cycle_order')
      .setLabel(`${orderEmoji} ${cfg.lblWriterOrder}: ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? 'Yes' : 'No'}`)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 4: Set AO3 Name, Keep Private toggle, Set Delay Hours, Set Delay Writers, Set Max Writers
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_set_ao3')
      .setLabel(cfg.btnSetAO3Name)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_toggle_private')
      .setLabel(`${cfg.lblPrivateToggle}: ${privateLabel}`)
      .setStyle(state.keepPrivate ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_delayhours')
      .setLabel(cfg.btnSetDelayHours)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_delaywriters')
      .setLabel(cfg.btnSetDelayWriters)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_set_maxwriters')
      .setLabel(`${cfg.btnSetMaxWriters}: ${maxWritersDisplay}`)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 5: Create Story — alone so it stands out
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_create')
      .setLabel(cfg.btnCreateStory)
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// Handle modal submission routing
async function handleModalSubmit(connection, interaction) {
  if (interaction.customId.startsWith('story_add_')) {
    await handleAddStoryModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_write_')) {
    await handleWriteModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_ao3_')) {
    await handleJoinAO3ModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_manage_')) {
    await handleManageModalSubmit(connection, interaction);
  } else if (interaction.customId === 'story_edit_content_modal') {
    await handleEditModalSubmit(connection, interaction);
  }
}

// Handle modal submissions from the story add ephemeral form
async function handleAddStoryModalSubmit(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingStoryData.get(userId);

  if (!state) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const customId = interaction.customId;
  try {
    if (customId === 'story_add_title_modal') {
      const value = sanitizeModalInput(interaction.fields.getTextInputValue('story_title'), 500);
      if (!value) {
        await interaction.reply({ content: 'Story title cannot be empty.', flags: MessageFlags.Ephemeral });
        return;
      }
      state.storyTitle = value;

    } else if (customId === 'story_add_turnlength_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 10);
      const val = parseInt(raw);
      if (isNaN(val) || val < 1) {
        await interaction.reply({
          content: replaceTemplateVariables(
            await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
            { 'Field label text': state.cfg.lblTurnLength }
          ),
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      state.turnLength = val;

    } else if (customId === 'story_add_timeout_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('timeout_reminder'), 10);
      const val = parseInt(raw);
      if (isNaN(val) || val < 0 || val > 100) {
        await interaction.reply({ content: await getConfigValue(connection, 'txtTimeoutReminderValidation', interaction.guild.id), flags: MessageFlags.Ephemeral });
        return;
      }
      state.timeoutReminder = val;

    } else if (customId === 'story_add_ao3_modal') {
      state.ao3Name = sanitizeModalInput(interaction.fields.getTextInputValue('ao3_name'), 255) || null;

    } else if (customId === 'story_add_delayhours_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('delay_hours'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(
              await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
              { 'Field label text': state.cfg.lblNoHours }
            ),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.delayHours = val || null;
      } else {
        state.delayHours = null;
      }

    } else if (customId === 'story_add_delaywriters_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('delay_writers'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(
              await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
              { 'Field label text': state.cfg.lblNoWriters }
            ),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.delayWriters = val || null;
      } else {
        state.delayWriters = null;
      }

    } else if (customId === 'story_add_maxwriters_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          await interaction.reply({
            content: replaceTemplateVariables(
              await getConfigValue(connection, 'txtMustBeNo', interaction.guild.id),
              { 'Field label text': state.cfg.lblMaxWriters }
            ),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        state.maxWriters = val > 0 ? val : null; // 0 = no limit
      } else {
        state.maxWriters = null;
      }
    }

    // Acknowledge the modal and update the original form
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));
    await interaction.deleteReply();

  } catch (error) {
    log(`Error in handleAddStoryModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Failed to update. Please try again.', flags: MessageFlags.Ephemeral });
    }
  }
}

// Handle button interactions from the story add ephemeral form
async function handleAddStoryButton(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingStoryData.get(userId);

  if (!state) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const customId = interaction.customId;

  if (customId === 'story_add_toggle_mode') {
    state.quickMode = state.quickMode ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

  } else if (customId === 'story_add_toggle_hide') {
    state.hideThreads = state.hideThreads ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

  } else if (customId === 'story_add_toggle_private') {
    state.keepPrivate = state.keepPrivate ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

  } else if (customId === 'story_add_toggle_authors') {
    state.showAuthors = state.showAuthors ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

  } else if (customId === 'story_add_cycle_order') {
    state.orderType = state.orderType === 3 ? 1 : state.orderType + 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildStoryAddMessage(state.cfg, state));

  } else if (customId === 'story_add_set_title') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_title_modal')
        .setTitle(state.cfg.txtCreateStoryTitle)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('story_title')
              .setLabel(state.cfg.lblStoryTitle)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(500)
              .setValue(state.storyTitle || '')
          )
        )
    );

  } else if (customId === 'story_add_set_turnlength') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_turnlength_modal')
        .setTitle(state.cfg.lblTurnLength)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('turn_length')
              .setLabel(state.cfg.lblTurnLength)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.turnLength))
              .setPlaceholder('Enter number of hours')
          )
        )
    );

  } else if (customId === 'story_add_set_timeout') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_timeout_modal')
        .setTitle(state.cfg.lblTimeoutReminder)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('timeout_reminder')
              .setLabel(state.cfg.lblTimeoutReminder)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.timeoutReminder))
              .setPlaceholder('Enter 0–100 (0 = no reminder)')
          )
        )
    );

  } else if (customId === 'story_add_set_ao3') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_ao3_modal')
        .setTitle(state.cfg.lblYourAO3Name)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ao3_name')
              .setLabel(state.cfg.lblYourAO3Name)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.ao3Name || '')
              .setPlaceholder('Your AO3 username (optional)')
          )
        )
    );

  } else if (customId === 'story_add_set_delayhours') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_delayhours_modal')
        .setTitle(state.cfg.lblNoHours)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('delay_hours')
              .setLabel(state.cfg.lblNoHours)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.delayHours != null ? String(state.delayHours) : '')
              .setPlaceholder('Enter number of hours (optional)')
          )
        )
    );

  } else if (customId === 'story_add_set_delaywriters') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_delaywriters_modal')
        .setTitle(state.cfg.lblNoWriters)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('delay_writers')
              .setLabel(state.cfg.lblNoWriters)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.delayWriters != null ? String(state.delayWriters) : '')
              .setPlaceholder('Enter number of writers (optional)')
          )
        )
    );

  } else if (customId === 'story_add_set_maxwriters') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_add_maxwriters_modal')
        .setTitle(state.cfg.lblMaxWriters)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_writers')
              .setLabel(state.cfg.lblMaxWriters)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.maxWriters != null ? String(state.maxWriters) : '')
              .setPlaceholder('Enter a number, or leave blank for no limit')
          )
        )
    );

  } else if (customId === 'story_add_create') {
    await handleCreateStorySubmit(connection, interaction, state);
  }
}

// Handle Create Story button — validates and submits to CreateStory
async function handleCreateStorySubmit(connection, interaction, state) {
  if (!state.storyTitle) {
    await interaction.reply({
      content: 'Please set a story title before creating the story.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const storyInput = {
      storyTitle: state.storyTitle,
      quickMode: state.quickMode,
      hideTurnThreads: state.hideThreads,
      turnLength: state.turnLength,
      timeoutReminder: state.timeoutReminder,
      ao3Name: state.ao3Name,
      keepPrivate: state.keepPrivate,
      delayHours: state.delayHours,
      delayWriters: state.delayWriters,
      orderType: state.orderType,
      showAuthors: state.showAuthors,
      maxWriters: state.maxWriters
    };

    const result = await CreateStory(connection, interaction, storyInput);
    pendingStoryData.delete(interaction.user.id);

    if (result.success) {
      await state.originalInteraction.editReply({
        content: result.message,
        embeds: [],
        components: []
      });
    } else {
      await state.originalInteraction.editReply({
        content: result.error,
        embeds: [],
        components: []
      });
    }
  } catch (error) {
    log(`Error creating story: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtStoryCreationError', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
}

/**
 * Handle /story join command
 */
async function buildJoinEmbed(connection, state) {
  const { storyId, guildId, storyTitle, privacy, notificationPrefs, ao3Name, displayName } = state;
  const cfg = await getConfigValue(connection, [
    'txtJoinEmbedDesc', 'lblJoinPrivacySelect', 'lblJoinNotifSelect',
    'lblJoinAO3Name', 'txtJoinAO3NotSet', 'btnJoinSetAO3', 'btnJoinConfirm', 'btnCancel'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(`🎭 Join "${storyTitle}"`)
    .setDescription(cfg.txtJoinEmbedDesc)
    .addFields(
      { name: cfg.lblJoinPrivacySelect, value: privacy === 'private' ? '🔒 Private' : '🌐 Public', inline: true },
      { name: cfg.lblJoinNotifSelect, value: notificationPrefs === 'dm' ? '💬 DM' : '📢 Mention in channel', inline: true },
      { name: cfg.lblJoinAO3Name, value: ao3Name || (displayName ? `${displayName} (Discord display name)` : cfg.txtJoinAO3NotSet), inline: false }
    );

  const privacyRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`story_join_privacy_${storyId}`)
      .addOptions([
        { label: 'Public', value: 'public', description: 'Your turn thread is visible to all server members', default: privacy === 'public' },
        { label: 'Private', value: 'private', description: 'Only you and admins can see your turn thread', default: privacy === 'private' }
      ])
  );

  const notifRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`story_join_notif_${storyId}`)
      .addOptions([
        { label: 'DM', value: 'dm', description: 'Receive turn notifications in your DMs', default: notificationPrefs === 'dm' },
        { label: 'Mention in channel', value: 'mention', description: 'Get @mentioned in the story feed channel', default: notificationPrefs === 'mention' }
      ])
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_join_set_ao3_${storyId}`)
      .setLabel(cfg.btnJoinSetAO3)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`story_join_confirm_${storyId}`)
      .setLabel(cfg.btnJoinConfirm)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`story_join_cancel_${storyId}`)
      .setLabel(cfg.btnCancel)
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [privacyRow, notifRow, buttonRow] };
}

async function handleJoin(connection, interaction, buttonStoryId = null) {
  try {
    const guildId = interaction.guild.id;
    let storyId;
    if (buttonStoryId !== null) {
      storyId = buttonStoryId;
    } else {
      storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
      if (storyId === null) {
        await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
        return;
      }
    }

    const storyInfo = await validateStoryAccess(connection, storyId, guildId);
    if (!storyInfo.success) {
      await interaction.reply({ content: storyInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }

    const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
    if (!joinInfo.success) {
      await interaction.reply({ content: joinInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }

    const existingAO3Name = await getPreviousAO3Name(connection, interaction.user.id);
    const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
    const state = { storyId, guildId, storyTitle: storyInfo.story.title, privacy: 'public', notificationPrefs: 'dm', ao3Name: existingAO3Name, displayName };
    pendingJoinData.set(interaction.user.id, state);

    const embedData = await buildJoinEmbed(connection, state);
    await interaction.reply({ ...embedData, flags: MessageFlags.Ephemeral });

  } catch (error) {
    log(`Error in handleJoin: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'txtJoinFormFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

/**
 * Handle join modal submission
 */
async function handleJoinSetAO3Button(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const cfg = await getConfigValue(connection, ['lblJoinAO3Name', 'txtJoinAO3Placeholder'], interaction.guild.id);
  const state = pendingJoinData.get(interaction.user.id);

  const modal = new ModalBuilder()
    .setCustomId(`story_join_ao3_${storyId}`)
    .setTitle('Set AO3 Username');

  const input = new TextInputBuilder()
    .setCustomId('ao3_name')
    .setLabel(cfg.lblJoinAO3Name)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder(cfg.txtJoinAO3Placeholder)
    .setMaxLength(255);

  if (state?.ao3Name) input.setValue(state.ao3Name);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleJoinAO3ModalSubmit(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const state = pendingJoinData.get(interaction.user.id);
  if (!state) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtJoinFormFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
    return;
  }
  state.ao3Name = sanitizeModalInput(interaction.fields.getTextInputValue('ao3_name'), 255) || '';
  pendingJoinData.set(interaction.user.id, state);

  await interaction.deferUpdate();
  await interaction.editReply(await buildJoinEmbed(connection, state));
}

async function handleJoinConfirm(connection, interaction) {
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const state = pendingJoinData.get(interaction.user.id);

  if (!state) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtJoinFormFailed', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  // Re-validate eligibility in case story changed while user was deciding
  const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
  if (!joinInfo.success) {
    await interaction.editReply({ content: joinInfo.error, embeds: [], components: [] });
    pendingJoinData.delete(interaction.user.id);
    return;
  }

  const joinInput = {
    ao3Name: state.ao3Name || null,
    turnPrivacy: state.privacy === 'private' ? 1 : 0,
    notificationPrefs: state.notificationPrefs
  };

  const { StoryJoin } = await import('../storybot.js');
  const txn = await connection.getConnection();
  await txn.beginTransaction();
  try {
    const result = await StoryJoin(txn, interaction, joinInput, storyId);

    if (result.success) {
      await txn.commit();
      pendingJoinData.delete(interaction.user.id);

      const [[writerCount], [storyInfo]] = await Promise.all([
        connection.execute(`SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1`, [storyId]),
        connection.execute(`SELECT title FROM story WHERE story_id = ?`, [storyId])
      ]);

      const txtJoinSuccess = await getConfigValue(connection, 'txtJoinSuccess', guildId);
      const successMessage = replaceTemplateVariables(txtJoinSuccess, {
        story_title: storyInfo[0].title,
        writer_number: writerCount[0].count
      });

      await interaction.editReply({ content: `${successMessage}${result.confirmationMessage || ''}`, embeds: [], components: [] });

      await postStoryFeedJoinAnnouncement(connection, storyId, interaction, storyInfo[0].title);
      updateStoryStatusMessage(connection, interaction.guild, storyId).catch(() => {});

      const writerName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
      getConfigValue(connection, 'txtStoryThreadWriterJoin', guildId).then(template =>
        postStoryThreadActivity(connection, interaction.guild, storyId, template.replace('[writer_name]', writerName))
      ).catch(() => {});

    } else {
      await txn.rollback();
      await interaction.editReply({ content: result.error, embeds: [], components: [] });
    }
  } catch (error) {
    await txn.rollback();
    log(`Error in handleJoinConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtJoinProcessFailed', guildId), embeds: [], components: [] });
  } finally {
    txn.release();
  }
}

/**
 * Handle /story write command
 */
async function handleWrite(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
    if (storyId === null) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
      return;
    }

    // Run all validation and config fetches in parallel
    const [storyInfo, writerInfo, txtWriteWarning, lblWriteEntry, txtWritePlaceholder, txtNormalModeWrite] = await Promise.all([
      validateStoryAccess(connection, storyId, guildId),
      validateActiveWriter(connection, interaction.user.id, storyId),
      getConfigValue(connection, 'txtWriteWarning', guildId),
      getConfigValue(connection, 'lblWriteEntry', guildId),
      getConfigValue(connection, 'txtWritePlaceholder', guildId),
      getConfigValue(connection, 'txtNormalModeWrite', guildId),
    ]);

    if (!storyInfo.success) {
      await interaction.reply({ content: storyInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!writerInfo.success) {
      await interaction.reply({ content: writerInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!storyInfo.story.quick_mode) {
      await interaction.reply({ content: txtNormalModeWrite, flags: MessageFlags.Ephemeral });
      return;
    }

    // Create modal
    const modal = new ModalBuilder()
      .setCustomId(`story_write_${storyId}`)
      .setTitle(`✍️ ${storyInfo.story.title}`);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('entry_content')
          .setLabel(lblWriteEntry)
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder(`⚠️ ${txtWriteWarning}\n\n${txtWritePlaceholder}`)
          .setMaxLength(4000)
          .setMinLength(10)
          .setRequired(true)
      )
    );

    await interaction.showModal(modal);

  } catch (error) {
    log(`Error in handleWrite: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({
      content: await getConfigValue(connection,'txtWriteFormFailed', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
}

/**
 * Handle write modal submission
 */
async function handleWriteModalSubmit(connection, interaction) {
    const guildId = interaction.guild.id;
    const storyId = interaction.customId.split('_')[2];
    const content = interaction.fields.getTextInputValue('entry_content')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')  // remove zero-width chars
      .trim()
      .substring(0, 4000);
    
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let entryId = null;
    try {
      const [pendingEntry] = await connection.execute(`
        SELECT story_entry_id FROM story_entry se
        JOIN turn t ON se.turn_id = t.turn_id
        JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
        WHERE sw.story_id = ? AND sw.discord_user_id = ?
        AND se.entry_status IN ('pending', 'discarded')
      `, [storyId, interaction.user.id]);

      if (pendingEntry.length > 0) {
        // Update existing entry (re-draft after discard counts too)
        await connection.execute(`
          UPDATE story_entry SET content = ?, entry_status = 'pending', created_at = NOW()
          WHERE story_entry_id = ?
        `, [content, pendingEntry[0].story_entry_id]);
        entryId = pendingEntry[0].story_entry_id;
      } else {
        // Create new pending entry
        const [turnInfo] = await connection.execute(`
          SELECT t.turn_id FROM turn t
          JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
          WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1
        `, [storyId, interaction.user.id]);
        
        if (turnInfo.length === 0) {
          throw new Error('No active turn found');
        }
        
        const [result] = await connection.execute(`
          INSERT INTO story_entry (turn_id, content, entry_status)
          VALUES (?, ?, 'pending')
        `, [turnInfo[0].turn_id, content]);
        
        entryId = result.insertId;
      }
    
    // Get timeout and create embed
    const timeoutMinutes = parseInt(await getConfigValue(connection,'cfgEntryTimeoutMinutes', guildId)) || 10;
    const expiresAt = new Date(Date.now() + (timeoutMinutes * 60 * 1000));
    const discordTimestamp = `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`;
    
    // Create preview embed
    const embed = await createPreviewEmbed(connection, content, guildId, discordTimestamp);
    
    // Create confirmation buttons
    const confirmRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_entry_${entryId}`)
          .setLabel(await getConfigValue(connection,'btnSubmit', guildId))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`discard_entry_${entryId}`)
          .setLabel(await getConfigValue(connection,'btnDiscard', guildId))
          .setStyle(ButtonStyle.Danger)
      );
      
    await interaction.editReply({
      embeds: [embed],
      components: [confirmRow]
    });
    
    // Send DM reminder after 5 minutes, cancelled if user confirms or discards before then
    const reminderTimeout = setTimeout(async () => {
      pendingReminderTimeouts.delete(entryId);
      try {
        const user = await interaction.client.users.fetch(interaction.user.id);
        await user.send(`${await getConfigValue(connection,'txtDMReminder', guildId)}\n\n${await getConfigValue(connection,'txtRecoveryInstructions', guildId)}\n\n⏰ Expires: ${discordTimestamp}`);
      } catch (error) {
        log(`Could not send DM reminder to user ${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
      }
    }, 5 * 60 * 1000);
    pendingReminderTimeouts.set(entryId, reminderTimeout);

  } catch (error) {
    log(`Error in handleWriteModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntryProcessFailed', interaction.guild.id)
    });
  }
}

/**
 * Validate if story exists and belongs to guild
 */
async function validateStoryAccess(connection, storyId, guildId) {
  try {
    const [storyInfo] = await connection.execute(`
      SELECT * FROM story WHERE story_id = ?
    `, [storyId]);
    
    if (storyInfo.length === 0) {
      return { success: false, error: await getConfigValue(connection,'txtStoryNotFound', guildId) };
    }
    
    const story = storyInfo[0];
    
    if (story.guild_id !== guildId) {
      return { success: false, error: await getConfigValue(connection,'txtStoryWrongGuild', guildId) };
    }
    
    if (story.story_status !== 1) {
      return { success: false, error: await getConfigValue(connection,'txtStoryNotActive', guildId) };
    }
    
    return { success: true, story };
  } catch (error) {
    log(`Error in validateStoryAccess: ${error}`, { show: true });
  }
}

/**
 * Validate if user is the active writer for a story
 */
async function validateActiveWriter(connection, userId, storyId) {
  try {
    const [writerInfo] = await connection.execute(`
      SELECT sw.discord_user_id as current_writer
      FROM turn t
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
      WHERE sw.story_id = ? AND t.turn_status = 1
      ORDER BY t.turn_id DESC LIMIT 1
    `, [storyId]);
    
    if (writerInfo.length === 0 || writerInfo[0].current_writer !== userId) {
      // Get guild_id for config lookup - we need this for error messages
      const [storyInfo] = await connection.execute(`
        SELECT guild_id FROM story WHERE story_id = ?
      `, [storyId]);
      
      const guildId = storyInfo[0]?.guild_id;
      return { success: false, error: await getConfigValue(connection,'txtNotYourTurn', guildId) };
    }
    
    return { success: true };
  } catch (error) {
    log(`Error in validateActiveWriter: ${error}`, { show: true });
  }
}

/**
 * Validate if user can join a story
 */
async function validateJoinEligibility(connection, storyId, guildId, userId) {
  try {
    // Get story info with writer count
    const [storyInfo] = await connection.execute(`
      SELECT s.*, COUNT(sw.story_writer_id) as current_writers
      FROM story s
      LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = 1
      WHERE s.story_id = ? AND s.guild_id = ?
      GROUP BY s.story_id
    `, [storyId, guildId]);
    
    if (storyInfo.length === 0) {
      return { success: false, error: await getConfigValue(connection,'txtStoryNotFound', guildId) };
    }
    
    const story = storyInfo[0];
    
    // Check if story is closed
    if (story.story_status === 3) {
      return { success: false, error: await getConfigValue(connection,'txtJoinStoryClosed', guildId) };
    }
    
    // Check if story allows new writers
    if (!story.allow_joins) {
      return { success: false, error: await getConfigValue(connection,'txtJoinNotAllowed', guildId) };
    }
    
    // Check if story is at capacity
    if (story.max_writers && story.current_writers >= story.max_writers) {
      return { 
        success: false, 
        error: replaceTemplateVariables(await getConfigValue(connection,'txtJoinStoryFull', guildId), { max_writers: story.max_writers })
      };
    }
    
    // Check if user already joined
    const [existingWriter] = await connection.execute(`
      SELECT story_writer_id FROM story_writer 
      WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1
    `, [storyId, userId]);
    
    if (existingWriter.length > 0) {
      return { success: false, error: await getConfigValue(connection,'txtMemberStatusJoined', guildId) };
    }
    
    return { success: true, story };
    
  } finally {
    // Connection is persistent, no need to release
  }
}

/**
 * Build an entry preview embed.
 * Content goes in the description (4096 limit), footer holds the instruction text,
 * and any extra fields (e.g. expiry, stats) are appended after overflow chunks.
 */
function buildEntryPreviewEmbed(content, title, footerText, extraFields = []) {
  const chunks = splitAtParagraphs(content, 4096);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(chunks[0])
    .setColor(0xffd700)
    .setFooter({ text: footerText });

  for (let i = 1; i < chunks.length; i++) {
    embed.addFields({ name: '​', value: chunks[i], inline: false });
  }

  if (extraFields.length > 0) embed.addFields(...extraFields);

  return embed;
}

/**
 * Create entry preview embed for quick mode (/story write)
 */
async function createPreviewEmbed(connection, content, guildId, discordTimestamp) {
  const [title, footer, expiresLabel, statsLabel, statsTemplate] = await Promise.all([
    getConfigValue(connection, 'txtPreviewTitle', guildId),
    getConfigValue(connection, 'txtPreviewDescription', guildId),
    getConfigValue(connection, 'txtPreviewExpires', guildId),
    getConfigValue(connection, 'lblEntryStats', guildId),
    getConfigValue(connection, 'txtEntryStatsTemplate', guildId),
  ]);

  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  const statsText = replaceTemplateVariables(statsTemplate, { char_count: content.length, word_count: wordCount });

  return buildEntryPreviewEmbed(content, title, footer, [
    { name: expiresLabel, value: discordTimestamp, inline: true },
    { name: statsLabel, value: statsText, inline: true },
  ]);
}

/**
 * Handle /story list command
 */
async function buildHelpPage1(connection, guildId) {
  const mediaChannelId = await getConfigValue(connection, 'cfgMediaChannelId', guildId);
  const mediaConfigured = mediaChannelId && mediaChannelId !== 'cfgMediaChannelId';
  const writeNormalKey = mediaConfigured ? 'txtHelp1WriteNormal' : 'txtHelp1WriteNormalNoMedia';

  const cfg = await getConfigValue(connection, [
    'txtHelp1Title', 'txtHelp1Footer', 'btnHelp1ToPage2',
    'lblHelp1FindJoin', 'txtHelp1FindJoin',
    'lblHelp1Dashboard', 'txtHelp1Dashboard',
    'lblHelp1WriteNormal', writeNormalKey,
    'lblHelp1WriteQuick', 'txtHelp1WriteQuick',
    'lblHelp1ManageParticipation', 'txtHelp1ManageParticipation'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelp1Title)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblHelp1FindJoin, value: cfg.txtHelp1FindJoin, inline: false },
      { name: cfg.lblHelp1Dashboard, value: cfg.txtHelp1Dashboard, inline: false },
      { name: cfg.lblHelp1WriteNormal, value: cfg[writeNormalKey], inline: false },
      { name: cfg.lblHelp1WriteQuick, value: cfg.txtHelp1WriteQuick, inline: false },
      { name: cfg.lblHelp1ManageParticipation, value: cfg.txtHelp1ManageParticipation, inline: false }
    )
    .setFooter({ text: cfg.txtHelp1Footer });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_help_page_2')
      .setLabel(cfg.btnHelp1ToPage2)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function buildHelpPage2(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtHelp2Title', 'txtHelp2Footer', 
    'btnHelp2ToPage1', 'btnHelp2ToPage3',
    'lblHelp2StoryTitle', 'txtHelp2StoryTitle',
    'lblHelp2MaxWriters', 'txtHelp2MaxWriters',
    'lblHelp2TurnLength', 'txtHelp2TurnLength',
    'lblHelp2StoryMode', 'txtHelp2StoryMode',
    'lblHelp2WriterOrder', 'txtHelp2WriterOrder',
    'lblHelp2HideThreads', 'txtHelp2HideThreads',
    'lblHelp2ShowAuthors', 'txtHelp2ShowAuthors',
    'lblHelp2TimeoutReminder', 'txtHelp2TimeoutReminder',
    'lblHelp2DelayStart', 'txtHelp2DelayStart',
    'lblHelp2CreatorOptions', 'txtHelp2CreatorOptions'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelp2Title)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblHelp2StoryTitle, value: cfg.txtHelp2StoryTitle, inline: false },
      { name: cfg.lblHelp2MaxWriters, value: cfg.txtHelp2MaxWriters, inline: true },
      { name: cfg.lblHelp2TurnLength, value: cfg.txtHelp2TurnLength, inline: true },
      { name: cfg.lblHelp2StoryMode, value: cfg.txtHelp2StoryMode, inline: false },
      { name: cfg.lblHelp2WriterOrder, value: cfg.txtHelp2WriterOrder, inline: false },
      { name: cfg.lblHelp2HideThreads, value: cfg.txtHelp2HideThreads, inline: false },
      { name: cfg.lblHelp2ShowAuthors, value: cfg.txtHelp2ShowAuthors, inline: false },
      { name: cfg.lblHelp2TimeoutReminder, value: cfg.txtHelp2TimeoutReminder, inline: false },
      { name: cfg.lblHelp2DelayStart, value: cfg.txtHelp2DelayStart, inline: false },
      { name: cfg.lblHelp2CreatorOptions, value: cfg.txtHelp2CreatorOptions, inline: false }
    )
    .setFooter({ text: cfg.txtHelp2Footer });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_help_page_1')
      .setLabel(cfg.btnHelp2ToPage1)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_help_page_3')
      .setLabel(cfg.btnHelp2ToPage3)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function buildHelpPage3(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtHelp3Title', 'txtHelp3Footer', 'btnHelp3ToPage2',
    'lblHelp3WhoCanUse', 'txtHelp3WhoCanUse',
    'lblHelp3WhatEdit', 'txtHelp3WhatEdit',
    'lblHelp3PauseResume', 'txtHelp3PauseResume',
    'lblHelp3Closing', 'txtHelp3Closing',
    'lblHelp3AdminControls', 'txtHelp3AdminControls'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelp3Title)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblHelp3WhoCanUse, value: cfg.txtHelp3WhoCanUse, inline: false },
      { name: cfg.lblHelp3WhatEdit, value: cfg.txtHelp3WhatEdit, inline: false },
      { name: cfg.lblHelp3PauseResume, value: cfg.txtHelp3PauseResume, inline: false },
      { name: cfg.lblHelp3Closing, value: cfg.txtHelp3Closing, inline: false },
      { name: cfg.lblHelp3AdminControls, value: cfg.txtHelp3AdminControls, inline: false }
    )
    .setFooter({ text: cfg.txtHelp3Footer });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_help_page_2')
      .setLabel(cfg.btnHelp3ToPage2)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function handleHelp(connection, interaction) {
  await interaction.reply({ ...await buildHelpPage1(connection, interaction.guild.id), flags: MessageFlags.Ephemeral });
}

async function handleHelpNavigation(connection, interaction) {
  await interaction.deferUpdate();
  if (interaction.customId === 'story_help_page_2') {
    await interaction.editReply(await buildHelpPage2(connection, interaction.guild.id));
  } else if (interaction.customId === 'story_help_page_3') {
    await interaction.editReply(await buildHelpPage3(connection, interaction.guild.id));
  } else {
    await interaction.editReply(await buildHelpPage1(connection, interaction.guild.id));
  }
}

async function handleListStories(connection, interaction) {
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
 * Handle button interactions for story list
 */
async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('story_add_')) {
    await handleAddStoryButton(connection, interaction);
  } else if (interaction.customId.startsWith('story_list_')) {
    await handleListNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('confirm_entry_') || interaction.customId.startsWith('discard_entry_')) {
    await handleEntryConfirmation(connection, interaction);
  } else if (interaction.customId.startsWith('view_last_entry_')) {
    await handleViewLastEntry(connection, interaction);
  } else if (interaction.customId.startsWith('finalize_entry_')) {
    await handleFinalizeEntry(connection, interaction);
  } else if (interaction.customId.startsWith('story_finalize_confirm_')) {
    await handleFinalizeConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_finalize_cancel_')) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: '❌ Finalize cancelled.', components: [] });
  } else if (interaction.customId.startsWith('skip_turn_')) {
    await handleSkipTurn(connection, interaction);
  } else if (interaction.customId.startsWith('story_skip_confirm_')) {
    await handleSkipConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_skip_cancel_')) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: '❌ Skip cancelled.', components: [] });
  } else if (interaction.customId.startsWith('story_close_confirm_')) {
    await handleCloseConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_close_cancel_')) {
    await handleCloseCancel(connection, interaction);
  } else if (interaction.customId.startsWith('story_manage_')) {
    await handleManageButton(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_confirm_')) {
    await handleJoinConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_set_ao3_')) {
    await handleJoinSetAO3Button(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_cancel_')) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'btnCancel', interaction.guild.id), embeds: [], components: [] });
  } else if (interaction.customId.startsWith('story_join_')) {
    const storyId = parseInt(interaction.customId.split('_').at(-1));
    await handleJoin(connection, interaction, storyId);
  } else if (interaction.customId === 'story_filter') {
    await handleFilterButton(connection, interaction);
  } else if (interaction.customId === 'story_help_page_1' || interaction.customId === 'story_help_page_2' || interaction.customId === 'story_help_page_3') {
    await handleHelpNavigation(connection, interaction);
  } else if (interaction.customId.startsWith('story_request_more_time_')) {
    await handleRequestMoreTime(connection, interaction);
  } else if (interaction.customId.startsWith('story_read_post_public_')) {
    await handleExportPostPublic(connection, interaction);
  } else if (interaction.customId.startsWith('story_repost_entry_')) {
    await handleRepostEntry(connection, interaction);
  } else if (interaction.customId.startsWith('story_edit_')) {
    await handleEditButton(connection, interaction);
  } else if (interaction.customId.startsWith('story_read_')) {
    await handleReadNav(connection, interaction);
  }
}

/**
 * Handle list navigation buttons (prev/next page)
 */
async function handleListNavigation(connection, interaction) {
  const [, , filter, pageStr] = interaction.customId.split('_');
  await interaction.deferUpdate();
  await renderStoryListReply(connection, interaction, filter, parseInt(pageStr));
}

/**
 * Handle filter button — show a select menu to choose a filter
 */
async function handleFilterButton(connection, interaction) {
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
      ])
  );
  await interaction.editReply({ content: '🔍 **Filter stories:**', embeds: [], components: [row] });
}

/**
 * Render the story list embed and navigation into the current reply
 */
async function renderStoryListReply(connection, interaction, filter, page) {
  const guildId = interaction.guild.id;
  const itemsPerPage = 5;

  // Fetch stories and all config values in parallel
  const [stories, cfg] = await Promise.all([
    getStoriesPaginated(connection, guildId, filter, page, itemsPerPage, interaction.user.id),
    getConfigValue(connection, [
      'txtStoriesPageTitle', 'txtStoriesPageDesc',
      'lblStoryStatus', 'lblStoryTurn', 'lblStoryWriters', 'lblStoryMode', 'lblStoryCreator',
      'txtModeQuick', 'txtModeNormal',
      'txtActive', 'txtPaused', 'txtClosed',
      'txtMemberStatusJoined', 'txtMemberStatusCanJoin', 'txtMemberStatusCanNotJoin',
      'txtTurnWaiting', 'txtTurnOverdue', 'txtTurnTimeLeft',
      'btnPrev', 'btnNext', 'btnFilter',
      'txtQuickJoinPlaceholder', 'txtQuickJoinDesc',
    ], guildId),
  ]);

  const filterTitle = await getFilterTitle(connection, filter, guildId);
  const statusTextMap = { 1: cfg.txtActive, 2: cfg.txtPaused, 3: cfg.txtClosed };

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

    embed.addFields({
      name: `${statusIcon} "${story.title}" (#${story.guild_story_id})`,
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
 * Handle entry confirmation/discard
 */
async function handleEntryConfirmation(connection, interaction) {
  const [action, , entryIdStr] = interaction.customId.split('_');
  const entryId = parseInt(entryIdStr);
  
  try {
    await interaction.deferUpdate();
    
    if (action === 'confirm') {
      await confirmEntry(connection, entryId, interaction);
    } else if (action === 'discard') {
      await discardEntry(connection, entryId, interaction);
    }
    
  } catch (error) {
    log(`Error in handleEntryConfirmation: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection,'txtActionFailed', interaction.guild.id),
      components: []
    });
  }
}

/**
 * Confirm and finalize entry
 */
async function confirmEntry(connection, entryId, interaction) {
  if (pendingReminderTimeouts.has(entryId)) {
    clearTimeout(pendingReminderTimeouts.get(entryId));
    pendingReminderTimeouts.delete(entryId);
  }

  const txn = await connection.getConnection();
  await txn.beginTransaction();

  try {
    // Update entry status to confirmed
    await txn.execute(`
      UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?
    `, [entryId]);

    // Get story info for turn advancement and entry posting.
    // turn_number: count only confirmed-entry turns up to this one — matches /story read numbering.
    const [entryInfo] = await txn.execute(`
      SELECT se.turn_id, se.content, sw.story_id, sw.discord_user_id, sw.discord_display_name,
             s.story_thread_id, s.show_authors,
             (SELECT COUNT(DISTINCT t2.turn_id)
              FROM turn t2
              JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
              JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
              WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
      FROM story_entry se
      JOIN turn t ON se.turn_id = t.turn_id
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
      JOIN story s ON sw.story_id = s.story_id
      WHERE se.story_entry_id = ?
    `, [entryId]);

    if (entryInfo.length === 0) {
      throw new Error(`${formattedDate()}: Entry not found for ID ${entryId}`);
    }

    const { turn_id, content, story_id, discord_display_name, story_thread_id, show_authors, turn_number } = entryInfo[0];

    // Verify turn is still active — it may have timed out while the writer was composing
    const [turnCheck] = await txn.execute(
      `SELECT turn_status FROM turn WHERE turn_id = ?`,
      [turn_id]
    );
    if (turnCheck.length === 0 || turnCheck[0].turn_status !== 1) {
      await txn.rollback();
      await interaction.editReply({
        content: 'Your turn has already ended — the story has moved on.',
        embeds: [],
        components: []
      });
      return;
    }

    // End current turn and cancel its pending jobs
    await txn.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [turn_id]);
    await txn.execute(`UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`, [turn_id]);

    // Advance to next writer
    const nextWriterId = await PickNextWriter(txn, story_id);
    await NextTurn(txn, interaction, nextWriterId);

    await txn.commit();

    // Post entry to story thread
    try {
      const storyThread = await interaction.guild.channels.fetch(story_thread_id);
      const entryEmbed = new EmbedBuilder()
        .setDescription(content);
      if (show_authors) entryEmbed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name}` });
      await storyThread.send({ embeds: [entryEmbed] });
    } catch (threadError) {
      log(`Failed to post entry to story thread: ${threadError}`, { show: true, guildName: interaction?.guild?.name });
    }

    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntrySubmitted', interaction.guild.id),
      embeds: [],
      components: []
    });

  } catch (error) {
    await txn.rollback();
    log(`Error in confirmEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    throw error;
  } finally {
    txn.release();
  }
}

/**
 * Discard pending entry
 */
async function discardEntry(connection, entryId, interaction) {
  if (pendingReminderTimeouts.has(entryId)) {
    clearTimeout(pendingReminderTimeouts.get(entryId));
    pendingReminderTimeouts.delete(entryId);
  }

  try {
    await connection.execute(`
      UPDATE story_entry SET entry_status = 'discarded' WHERE story_entry_id = ?
    `, [entryId]);
    
    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntryDiscarded', interaction.guild.id),
      embeds: [],
      components: []
    });
    
  } catch (error) {
    log(`Error in discardEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    throw error;
  } finally {
    // Connection is persistent, no need to release
  }
}

/**
 * Handle select menu interactions
 */
async function handleSelectMenuInteraction(connection, interaction) {
  if (interaction.customId === 'story_quick_join') {
    const storyId = parseInt(interaction.values[0]);
    await handleJoin(connection, interaction, storyId);

  } else if (interaction.customId.startsWith('story_join_privacy_')) {
    const state = pendingJoinData.get(interaction.user.id);
    if (!state) { await interaction.deferUpdate(); return; }
    state.privacy = interaction.values[0];
    pendingJoinData.set(interaction.user.id, state);
    await interaction.deferUpdate();
    await interaction.editReply(await buildJoinEmbed(connection, state));

  } else if (interaction.customId.startsWith('story_join_notif_')) {
    const state = pendingJoinData.get(interaction.user.id);
    if (!state) { await interaction.deferUpdate(); return; }
    state.notificationPrefs = interaction.values[0];
    pendingJoinData.set(interaction.user.id, state);
    await interaction.deferUpdate();
    await interaction.editReply(await buildJoinEmbed(connection, state));

  } else if (interaction.customId === 'story_filter_select') {
    const filter = interaction.values[0];
    await interaction.deferUpdate();
    await renderStoryListReply(connection, interaction, filter, 1);

  } else if (interaction.customId === 'story_read_jump') {
    await handleReadNav(connection, interaction);
  }
}

/**
 * Get paginated stories from database
 */
async function getStoriesPaginated(connection, guildId, filter, page, itemsPerPage, userId) {

  try {
    let whereClause = 'WHERE s.guild_id = ?';
    let params = [guildId];
    log(`getStoriesPaginated - guildId: ${guildId}, filter: ${filter}`, { show: false });
    
    // Apply filters
    switch (filter) {
      case 'joinable':
        whereClause += ` AND s.story_status IN (1, 2) AND s.allow_joins = 1
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
      case 'all':
      default:
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
async function getFilterTitle(connection, filter, guildId) {
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

function getStatusIcon(status) {
  const icons = {
    1: '🟢', // Active
    2: '⏸️', // Paused
    3: '🏁'  // Closed
  };
  return icons[status] || '❓';
}


/**
 * Handle view last entry button — posts the previous confirmed entry as a permanent embed in the thread
 */
async function handleViewLastEntry(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [rows] = await connection.execute(
      `SELECT se.content, sw.discord_display_name, s.show_authors,
              (SELECT COUNT(DISTINCT t2.turn_id)
               FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId]
    );

    if (rows.length === 0) {
      return;
    }

    const { content, discord_display_name, show_authors, turn_number } = rows[0];
    const embed = new EmbedBuilder().setDescription(content);
    if (show_authors) {
      embed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name}` });
    }

    await interaction.channel.send({ embeds: [embed] });

  } catch (error) {
    log(`Error in handleViewLastEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}

/**
 * Handle finalize entry button click — show confirmation prompt
 */
async function handleFinalizeEntry(connection, interaction) {
  const storyId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }

    // Collect user messages from thread to build preview
    const thread = await interaction.guild.channels.fetch(turnInfo[0].thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });
    const userMessages = messages
      .filter(msg => msg.author.id === interaction.user.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (userMessages.size === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', guildId) });
      return;
    }

    // Build preview content — images shown as filename placeholders (not forwarded yet)
    const previewParts = [];
    for (const msg of userMessages.values()) {
      if (msg.content) previewParts.push(msg.content);
      for (const attachment of msg.attachments.values()) {
        if (attachment.contentType?.startsWith('image/')) {
          previewParts.push(`📎 ${attachment.name}`);
        }
      }
    }

    // Convert elements that Discord embeds don't render (headers → bold, -# → italic)
    const previewContent = previewParts.join('\n')
      .replace(/^#{1,3} (.+)$/gm, '**$1**')
      .replace(/^-# (.+)$/gm, '*$1*');

    const [txtFinalizeConfirm, txtFinalizeConfirmDesc, btnFinalizeConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtFinalizeConfirm', guildId),
      getConfigValue(connection, 'txtFinalizeConfirmDesc', guildId),
      getConfigValue(connection, 'btnFinalizeConfirm', guildId),
      getConfigValue(connection, 'btnCancel', guildId),
    ]);

    const embed = buildEntryPreviewEmbed(previewContent, txtFinalizeConfirm, txtFinalizeConfirmDesc);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_finalize_confirm_${storyId}`)
        .setLabel(btnFinalizeConfirm)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`story_finalize_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`handleFinalizeEntry failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', guildId) });
  }
}

/**
 * Handle finalize confirm button — execute the actual finalize
 */
async function handleFinalizeConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_')[3];

  await interaction.deferUpdate();

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', interaction.guild.id), components: [] });
      return;
    }

    const turn = turnInfo[0];
    const thread = await interaction.guild.channels.fetch(turn.thread_id);
    const messages = await thread.messages.fetch({ limit: 100 });

    const userMessages = messages
      .filter(msg => msg.author.id === interaction.user.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (userMessages.size === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtEmptyEntry', interaction.guild.id), components: [] });
      return;
    }

    // Forward images to media channel and build entry content with images inline
    const mediaChannelId = await getConfigValue(connection, 'cfgMediaChannelId', interaction.guild.id);
    const mediaChannel = (mediaChannelId && mediaChannelId !== 'cfgMediaChannelId')
      ? await interaction.guild.channels.fetch(mediaChannelId).catch(() => null)
      : null;
    const entryParts = [];

    for (const msg of userMessages.values()) {
      const parts = [];
      if (msg.content) parts.push(msg.content);
      if (mediaChannel) {
        for (const attachment of msg.attachments.values()) {
          if (attachment.contentType?.startsWith('image/')) {
            try {
              const forwarded = await mediaChannel.send({
                content: `📎 Story #${storyId} — Turn ${turn.turn_id}`,
                files: [attachment.url]
              });
              parts.push(forwarded.attachments.first().url);
            } catch (err) {
              log(`Failed to forward image to media channel: ${err}`, { show: true, guildName: interaction?.guild?.name });
            }
          }
        }
      }
      if (parts.length > 0) entryParts.push(parts.join('\n'));
    }

    const entryContent = entryParts.join('\n\n');

    const [storyInfo] = await connection.execute(
      `SELECT s.show_authors, s.story_thread_id, sw.discord_display_name
       FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       WHERE s.story_id = ?`,
      [interaction.user.id, storyId]
    );
    const { show_authors, story_thread_id, discord_display_name } = storyInfo[0];

    const txn = await connection.getConnection();
    await txn.beginTransaction();
    try {
      await txn.execute(
        `INSERT INTO story_entry (turn_id, content, entry_status, created_at) VALUES (?, ?, 'confirmed', NOW())`,
        [turn.turn_id, entryContent]
      );
      await txn.execute(
        `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
        [turn.turn_id]
      );
      const nextWriterId = await PickNextWriter(txn, storyId);
      await NextTurn(txn, interaction, nextWriterId);
      await txn.commit();
    } catch (txnError) {
      await txn.rollback();
      if (txnError.code === 'ER_DUP_ENTRY') {
        await interaction.editReply({ content: '✅ Your entry has already been submitted.', components: [] });
        return;
      }
      throw txnError;
    } finally {
      txn.release();
    }

    // Fetch turn number after commit so the confirmed entry is included in the count
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
      const storyThread = await interaction.guild.channels.fetch(story_thread_id);
      const entryEmbed = new EmbedBuilder().setDescription(entryContent);
      if (show_authors) entryEmbed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name}` });
      await storyThread.send({ embeds: [entryEmbed] });
    } catch (embedError) {
      log(`Failed to post finalized entry to story thread: ${embedError}`, { show: true, guildName: interaction?.guild?.name });
    }

    // Reply before deleting thread — interaction context is tied to the thread
    await interaction.editReply({ content: await getConfigValue(connection, 'txtEntryFinalized', interaction.guild.id), components: [] });

    await deleteThreadAndAnnouncement(thread);

  } catch (error) {
    log(`handleFinalizeConfirm failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    try {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtFailedtoFinalize', interaction.guild.id), components: [] });
    } catch {}
  }
}

/**
 * Handle skip turn button click
 */
async function handleSkipTurn(connection, interaction) {
  const storyId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }

    const turn = turnInfo[0];

    // Check if the writer has posted any content in the turn thread
    let hasContent = false;
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        if (thread) {
          const messages = await thread.messages.fetch({ limit: 50 });
          hasContent = messages.some(m => !m.author.bot && m.author.id === interaction.user.id);
        }
      } catch {} // thread may not be accessible
    }

    const [txtConfirm, btnConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, hasContent ? 'txtSkipConfirmHasContent' : 'txtSkipConfirmNoContent', guildId),
      getConfigValue(connection, 'btnSkipConfirm', guildId),
      getConfigValue(connection, 'btnSkipCancel', guildId)
    ]);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_skip_confirm_${storyId}`)
        .setLabel(btnConfirm)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`story_skip_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: txtConfirm, components: [row] });

  } catch (error) {
    log(`Skip turn confirmation failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleSkipConfirm(connection, interaction) {
  const storyId = interaction.customId.split('_')[3];
  const guildId = interaction.guild.id;

  await interaction.deferUpdate();

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId), components: [] });
      return;
    }

    const turn = turnInfo[0];

    await connection.execute(
      `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
      [turn.turn_id]
    );

    const nextWriterId = await PickNextWriter(connection, storyId);
    await NextTurn(connection, interaction, nextWriterId);

    // Activity log (fire-and-forget)
    getConfigValue(connection, 'txtStoryThreadTurnSkip', guildId).then(template =>
      postStoryThreadActivity(connection, interaction.guild, parseInt(storyId), template.replace('[writer_name]', turn.discord_display_name))
    ).catch(() => {});

    // Reply before deleting thread — interaction context is tied to the thread
    await interaction.editReply({ content: await getConfigValue(connection, 'txtSkipSuccess', guildId), components: [] });

    // Delete turn thread
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        log(`Failed to delete skipped turn thread: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

  } catch (error) {
    log(`Skip turn failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

/**
 * /story read — generate and send full story as an HTML file
 */
/**
 * Shared export helper — builds the story HTML and returns stats.
 * Used by both /story read and /story close.
 * Returns null if story not found, or an object with { hasEntries, buffer, filename, title, turnCount, wordCount, writerCount }.
 */
async function generateStoryExport(connection, storyId, guildId, guild = null) {
  const [storyRows] = await connection.execute(
    `SELECT story_id, guild_story_id, title, created_at, story_status, quick_mode, closed_at, show_authors, summary, tags FROM story WHERE story_id = ? AND guild_id = ?`,
    [storyId, guildId]
  );
  if (storyRows.length === 0) return null;
  const story = storyRows[0];

  const [writers] = await connection.execute(
    `SELECT discord_display_name, AO3_name FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY joined_at ASC`,
    [storyId]
  );

  const [entries] = await connection.execute(
    `SELECT se.content, se.created_at, sw.discord_display_name,
            (SELECT COUNT(DISTINCT t2.turn_id) FROM turn t2
             JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
             JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
             WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
     FROM story_entry se
     JOIN turn t ON se.turn_id = t.turn_id
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
     ORDER BY t.started_at`,
    [storyId]
  );

  const writerCount = writers.length;
  if (entries.length === 0) {
    return { hasEntries: false, title: story.title, turnCount: 0, wordCount: 0, writerCount, buffer: null, filename: null };
  }

  const wordCount = entries.reduce((total, e) => total + e.content.trim().split(/\s+/).length, 0);
  const turnCount = entries[entries.length - 1].turn_number;

  const fmt = d => new Date(d).toISOString().slice(0, 10);
  const publishedDate = fmt(story.created_at);
  const isClosed = story.story_status === 3;
  const secondDateLabel = isClosed ? 'Completed' : 'Updated';
  const secondDate = isClosed && story.closed_at ? fmt(story.closed_at) : fmt(entries[entries.length - 1].created_at);
  const exportDate = fmt(new Date());

  const writersList = writers.map(w => `${w.AO3_name || w.discord_display_name} (${w.discord_display_name})`).join(', ');
  const modeLabel = story.quick_mode ? 'Quick Mode' : 'Normal Mode';

  let entriesHtml = '';
  let currentTurn = null;
  for (const entry of entries) {
    if (entry.turn_number !== currentTurn) {
      if (currentTurn !== null) entriesHtml += `</div>`;
      currentTurn = entry.turn_number;
      const turnHeader = story.show_authors
        ? `<h2>Turn ${entry.turn_number} — ${entry.discord_display_name}</h2>`
        : '';
      entriesHtml += `<div class="turn">${turnHeader}`;
    }
    entriesHtml += await discordMarkdownToHtml(entry.content, guild);
  }
  if (currentTurn !== null) entriesHtml += `</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${story.title}</title>
  <link rel="stylesheet" href="https://cdn.simplecss.org/simple.min.css">
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.7; }
    h1 { font-size: 2em; margin-bottom: 8px; }
    .meta { font-size: 0.9em; margin-bottom: 8px; }
    .meta-block { border-bottom: 1px solid; padding-bottom: 24px; margin-bottom: 40px; }
    .turn { margin-bottom: 40px; border-top: 1px solid; padding-top: 20px; }
    p { margin: 0 0 1em; }
    .spoiler { background: #222; color: #222; border-radius: 3px; padding: 0 2px; cursor: pointer; }
    .spoiler:hover { color: #fff; }
    .subtext { font-size: 0.75em; color: #888; margin: 0 0 0.5em; }
    .summary { font-style: italic; margin-bottom: 40px; border-top: 1px solid; padding-top: 20px; }
    .export-note { font-size: 0.8em; color: #999; border-top: 1px solid #eee; margin-top: 60px; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="meta-block">
    <h1>${story.title}</h1>
    <div class="meta">Started: ${publishedDate} &nbsp; ${secondDateLabel}: ${secondDate}</div>
    <div class="meta">Story #${story.guild_story_id} &nbsp;·&nbsp; ${modeLabel} &nbsp;·&nbsp; ${turnCount} turn(s) &nbsp;·&nbsp; ~${wordCount.toLocaleString()} words</div>
    <div class="meta">Writers: ${writersList}</div>${story.tags ? `\n    <div class="meta">Tags: ${story.tags}</div>` : ''}
    <div class="meta">Exported: ${exportDate}</div>
  </div>${story.summary ? `\n  <div class="summary"><p>${story.summary}</p></div>` : ''}
  ${entriesHtml}
  <div class="export-note">
    <p><strong>Export note:</strong> This file was generated by Round Robin StoryBot.
    Timestamps from Discord (e.g. turn deadlines in entries) are not included.
    Story images are hosted on Discord's CDN — if you need them to persist long-term,
    download and re-upload them to a permanent image host and update the links in this file.</p>
  </div>
</body>
</html>`;

  const buffer = Buffer.from(html, 'utf8');
  const filename = `storybot${storyId}_${story.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html`;
  return { hasEntries: true, title: story.title, turnCount, wordCount, writerCount, buffer, filename };
}

// Split text into chunks at paragraph breaks, staying under maxLen chars each.
function splitAtParagraphs(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < 50) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// Build the pages array for a read session from raw story entries.
// editInfoMap: Map<story_entry_id, { editedByName, editedAt }> — populated by handleRead for footnotes
// hasAnyEditSet: Set<story_entry_id> — entries with any edit history (before grace-period filter)
function buildPages(entries, showAuthors, editInfoMap = new Map(), hasAnyEditSet = new Set()) {
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
function buildReadEmbed(session, pageIndex) {
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
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('story_read_download')
        .setLabel('⬇ Export Story')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('story_read_close')
        .setLabel('✕ Close')
        .setStyle(ButtonStyle.Danger)
    )
  );

  return { embeds: [embed], components };
}

async function handleRead(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
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

async function handleReadEditButton(connection, interaction, session, entryId) {
  // Load state entirely from the read session — no DB query needed, so showModal can be
  // the first (and only) response to this interaction within the 3-second window.
  const page = session.pages.find(p => p.storyEntryId === entryId && p.isFirstChunk);
  const fullContent = session.contentMap?.get(entryId) ?? null;

if (!page || fullContent === null) {
    await interaction.reply({ content: 'Entry not found in session. Please use `/story read` again.', flags: MessageFlags.Ephemeral });
    return;
  }

  const chunks = chunkEntryContent(fullContent);
  const storyTitle = session.title.length > 50 ? session.title.slice(0, 50) + '…' : session.title;

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
    originalInteraction: interaction
  });

  // No defer — showModal must be the first response
  const modal = new ModalBuilder()
    .setCustomId('story_edit_content_modal')
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

async function handleReadNav(connection, interaction) {
  const userId = interaction.user.id;
  const session = pendingReadData.get(userId);

  if (!session) {
    await interaction.update({ content: 'This reading session has expired. Use `/story read` again.', embeds: [], components: [] });
    return;
  }

  if (interaction.customId === 'story_read_close') {
    pendingReadData.delete(userId);
    await interaction.deleteReply();
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

// ---------------------------------------------------------------------------
// /story timeleft — public turn status for a story
// ---------------------------------------------------------------------------

async function handleTimeleft(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (!storyId) {
    return interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
  }

  const [rows] = await connection.execute(
    `SELECT s.title, s.guild_story_id, s.show_authors, s.story_thread_id, s.quick_mode,
            sw.discord_display_name AS writer_name, sw.discord_user_id,
            t.turn_id, t.turn_ends_at, t.more_time_requested
     FROM story s
     JOIN story_writer sw ON sw.story_id = s.story_id
     JOIN turn t ON t.story_writer_id = sw.story_writer_id
     WHERE s.story_id = ? AND s.guild_id = ? AND t.turn_status = 1
     LIMIT 1`,
    [storyId, guildId]
  );

  if (!rows.length) {
    return interaction.reply({ content: 'No active turn found for that story.', flags: MessageFlags.Ephemeral });
  }
  const turn = rows[0];

  // Check for admin-designated next writer
  const [nextRows] = await connection.execute(
    `SELECT sw.discord_display_name FROM story s
     JOIN story_writer sw ON sw.story_writer_id = s.next_writer_id
     WHERE s.story_id = ? AND s.next_writer_id IS NOT NULL`,
    [storyId]
  );
  const nextWriter = nextRows[0]?.discord_display_name ?? null;

  const unixTs = Math.floor(new Date(turn.turn_ends_at).getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle(turn.title)
    .addFields(
      { name: 'Story', value: `#${turn.guild_story_id}`, inline: true },
      { name: 'Current Writer', value: turn.show_authors ? turn.writer_name : '*(hidden)*', inline: true },
      { name: 'Turn Ends', value: `<t:${unixTs}:F> (<t:${unixTs}:R>)`, inline: false }
    );
  if (nextWriter) embed.addFields({ name: 'Up Next', value: nextWriter, inline: true });

  const isCurrentWriter = interaction.user.id === String(turn.discord_user_id);
  const btnLabel = await getConfigValue(connection, 'btnRequestMoreTime', guildId);
  const requestBtn = new ButtonBuilder()
    .setCustomId(`story_request_more_time_${storyId}`)
    .setLabel(btnLabel)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!isCurrentWriter || !!turn.more_time_requested);
  const row = new ActionRowBuilder().addComponents(requestBtn);

  try {
    await interaction.reply({ embeds: [embed], components: [row] });
  } catch {
    // No posting permission in this channel — fall back to ephemeral
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  }
}

async function handleRequestMoreTime(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;

  const [rows] = await connection.execute(
    `SELECT sw.discord_user_id, t.turn_id, t.more_time_requested, s.title, s.story_thread_id
     FROM story s
     JOIN story_writer sw ON sw.story_id = s.story_id
     JOIN turn t ON t.story_writer_id = sw.story_writer_id
     WHERE s.story_id = ? AND s.guild_id = ? AND t.turn_status = 1
     LIMIT 1`,
    [storyId, guildId]
  );

  if (!rows.length) {
    return interaction.editReply({ content: 'No active turn found.' });
  }
  const turn = rows[0];

  if (interaction.user.id !== String(turn.discord_user_id)) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtRequestMoreTimeNotYourTurn', guildId) });
  }
  if (turn.more_time_requested) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtRequestMoreTimeAlreadyUsed', guildId) });
  }

  // Look up admin role for the mention
  const adminRoleName = await getConfigValue(connection, 'cfgAdminRoleName', guildId);
  let adminMention = adminRoleName ? `@${adminRoleName}` : '';
  if (adminRoleName) {
    const role = interaction.guild.roles.cache.find(r => r.name === adminRoleName);
    if (role) adminMention = `<@&${role.id}>`;
  }

  const txtPost = (await getConfigValue(connection, 'txtRequestMoreTimePost', guildId))
    .replace('[writer_name]', interaction.member.displayName)
    .replace('[story_title]', turn.title)
    .replace('[admin_role]', adminMention);

  try {
    const thread = await interaction.guild.channels.fetch(String(turn.story_thread_id));
    await thread.send(txtPost);
  } catch (err) {
    log(`handleRequestMoreTime: could not post to story thread: ${err}`, { show: true, guildName: interaction.guild.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  await connection.execute(`UPDATE turn SET more_time_requested = 1 WHERE turn_id = ?`, [turn.turn_id]);

  // Disable the button on the original timeleft message
  try {
    const disabledBtn = new ButtonBuilder()
      .setCustomId(`story_request_more_time_${storyId}`)
      .setLabel(btnLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    await interaction.message.edit({ components: [new ActionRowBuilder().addComponents(disabledBtn)] });
  } catch { /* timeleft message may have expired or been deleted — non-fatal */ }

  await interaction.editReply({ content: await getConfigValue(connection, 'txtRequestMoreTimeUsed', guildId) });
}

async function handleExportPostPublic(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;

  const [storyRows] = await connection.execute(
    `SELECT story_thread_id FROM story WHERE story_id = ? AND guild_id = ?`,
    [storyId, guildId]
  );
  if (!storyRows.length || !storyRows[0].story_thread_id) {
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  const result = await generateStoryExport(connection, storyId, guildId, interaction.guild);
  if (!result?.hasEntries) {
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  const ao3Instructions = await getConfigValue(connection, 'txtExportAO3Instructions', guildId);

  try {
    const thread = await interaction.guild.channels.fetch(String(storyRows[0].story_thread_id));
    await thread.send({ content: ao3Instructions, files: [{ attachment: result.buffer, name: result.filename }] });
  } catch (err) {
    log(`handleExportPostPublic: could not post to story thread: ${err}`, { show: true, guildName: interaction.guild.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  await interaction.editReply({ content: await getConfigValue(connection, 'txtExportPostedPublicly', guildId) });
}

// ---------------------------------------------------------------------------
// /story edit — edit a confirmed story entry
// ---------------------------------------------------------------------------

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
    .setFooter({ text: `${chunk.text.length} / 3500 characters on this page` })
    .setColor(0xffd700);

  // Only show navigation buttons when there are multiple pages.
  // Only show History button when edit history exists.
  // Edit is always shown but disabled when not on page 1.
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
      .setDisabled(!isFirstPage)
  );

  if (hasHistory) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('story_edit_browse_history')
        .setLabel('History')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!isFirstPage)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId('story_edit_close')
      .setLabel('✕ Close')
      .setStyle(ButtonStyle.Danger)
  );

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
    const modal = new ModalBuilder()
      .setCustomId('story_edit_content_modal')
      .setTitle('Edit Entry');
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
    await interaction.deferUpdate();
    await state.historyMessage.delete().catch(() => {});
    state.historyMessage = null;

  } else if (customId === 'story_edit_close') {
    await state.historyMessage?.delete().catch(() => {});
    pendingEditData.delete(userId);
    await interaction.deleteReply();

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
  buttons.push(new ButtonBuilder().setCustomId('story_edit_close').setLabel('✕ Close').setStyle(ButtonStyle.Danger));

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
    return await interaction.reply({ content: 'Entry content cannot be empty.', flags: MessageFlags.Ephemeral });
  }

  // deferUpdate so Discord resolves which message to update based on which button
  // triggered the modal: edit embed (command path) or read embed (read-button path).
  await interaction.deferUpdate();

  const [entryRows] = await connection.execute(
    `SELECT content FROM story_entry WHERE story_entry_id = ?`, [state.entryId]
  );
  if (entryRows.length === 0) {
    await interaction.followUp({ content: await getConfigValue(connection, 'txtEditEntryNotFound', state.guildId), flags: MessageFlags.Ephemeral });
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

  state.currentContent = newContent;
  state.chunks = chunkEntryContent(newContent);
  state.hasHistory = true;

  // Rebuild the edit embed with updated content so the user can continue editing,
  // and add a Repost button for optional public reposting.
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

// ---------------------------------------------------------------------------
// /story manage — edit story settings (creator or admin)
// ---------------------------------------------------------------------------

async function checkIsCreator(connection, storyId, userId) {
  const [rows] = await connection.execute(
    `SELECT discord_user_id FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY joined_at ASC LIMIT 1`,
    [storyId]
  );
  return rows.length > 0 && String(rows[0].discord_user_id) === userId;
}

function buildManageMessage(cfg, state) {
  const orderEmojis = { 1: '🎲', 2: '🔄', 3: '📋' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const isPaused = state.targetStatus === 2;

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtAdminConfigTitle, { story_title: state.title }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblTurnLength, value: `${state.turnLength} hours`, inline: true },
      { name: cfg.lblTimeoutReminder, value: state.timeoutReminder > 0 ? `${state.timeoutReminder}%` : 'Disabled', inline: true },
      { name: cfg.lblMaxWriters, value: state.maxWriters ? String(state.maxWriters) : '∞', inline: true },
      { name: cfg.lblOpenToWriters, value: state.allowJoins ? 'Yes' : 'No', inline: true },
      { name: cfg.lblShowAuthors, value: state.showAuthors ? 'Yes' : 'No', inline: true },
      { name: cfg.lblPrivateToggle, value: state.turnPrivacy ? 'Private' : 'Public', inline: true },
      { name: cfg.lblWriterOrder, value: `${orderEmoji} ${orderLabel}`, inline: true },
      { name: cfg.lblSummary, value: state.summary || '*Not set*', inline: false },
      { name: cfg.lblTags, value: state.tags || '*Not set*', inline: false },
      { name: 'Story Status', value: isPaused ? '⏸️ Paused' : '▶️ Active', inline: true }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_set_turnlength')
      .setLabel(cfg.btnSetTurnLength)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_reminder')
      .setLabel(cfg.btnSetTimeout)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_maxwriters')
      .setLabel(`${cfg.btnSetMaxWriters}: ${state.maxWriters ?? '∞'}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_latejoins')
      .setLabel(`${cfg.lblOpenToWriters}: ${state.allowJoins ? 'Yes' : 'No'}`)
      .setStyle(state.allowJoins ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_authors')
      .setLabel(`${cfg.lblShowAuthors}: ${state.showAuthors ? 'Yes' : 'No'}`)
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_cycle_order')
      .setLabel(`${orderEmoji} ${orderLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_privacy')
      .setLabel(`${cfg.lblPrivateToggle}: ${state.turnPrivacy ? 'Private' : 'Public'}`)
      .setStyle(state.turnPrivacy ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_summary')
      .setLabel(cfg.btnSetSummary)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_set_tags')
      .setLabel(cfg.btnSetTags)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_manage_toggle_status')
      .setLabel(isPaused ? '▶️ Resume Story' : '⏸️ Pause Story')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_manage_save')
      .setLabel(cfg.btnAdminConfigSave)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('story_manage_cancel')
      .setLabel(cfg.btnCancel)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

async function handleManage(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, turn_length_hours, timeout_reminder_percent,
              max_writers, allow_joins, show_authors, story_order_type, summary, tags, story_turn_privacy
       FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    if (story.story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryAlreadyClosed', guildId) });
    }

    const isCreator = await checkIsCreator(connection, storyId, interaction.user.id);
    const isAdmin = await checkIsAdmin(connection, interaction, guildId);

    if (!isCreator && !isAdmin) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtManageNotAuthorized', guildId) });
    }

    const cfg = await getConfigValue(connection, [
      'txtAdminConfigTitle', 'btnAdminConfigSave', 'btnCancel',
      'lblTurnLength', 'btnSetTurnLength',
      'lblTimeoutReminder', 'btnSetTimeout',
      'lblMaxWriters', 'btnSetMaxWriters',
      'lblOpenToWriters', 'lblShowAuthors',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'lblSummary', 'btnSetSummary',
      'lblTags', 'btnSetTags',
      'lblPrivateToggle'
    ], guildId);

    const state = {
      cfg,
      storyId,
      guildStoryId: story.guild_story_id,
      guildId,
      title: story.title,
      turnLength: story.turn_length_hours,
      timeoutReminder: story.timeout_reminder_percent ?? 50,
      maxWriters: story.max_writers,
      allowJoins: story.allow_joins,
      showAuthors: story.show_authors,
      orderType: story.story_order_type,
      turnPrivacy: story.story_turn_privacy,
      summary: story.summary ?? '',
      tags: story.tags ?? '',
      originalStatus: story.story_status,
      targetStatus: story.story_status,
      originalInteraction: interaction
    };

    pendingManageData.set(interaction.user.id, state);
    await interaction.editReply(buildManageMessage(cfg, state));

  } catch (error) {
    log(`Error in handleManage: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleManageButton(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingManageData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const customId = interaction.customId;

  if (customId === 'story_manage_toggle_latejoins') {
    state.allowJoins = state.allowJoins ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_toggle_authors') {
    state.showAuthors = state.showAuthors ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_toggle_privacy') {
    state.turnPrivacy = state.turnPrivacy ? 0 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_cycle_order') {
    state.orderType = state.orderType === 3 ? 1 : state.orderType + 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_toggle_status') {
    state.targetStatus = state.targetStatus === 1 ? 2 : 1;
    await interaction.deferUpdate();
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));

  } else if (customId === 'story_manage_set_turnlength') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_turnlength_modal')
        .setTitle(state.cfg.lblTurnLength)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('turn_length')
              .setLabel(state.cfg.lblTurnLength)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.turnLength))
              .setPlaceholder('Enter number of hours')
          )
        )
    );

  } else if (customId === 'story_manage_set_reminder') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_reminder_modal')
        .setTitle(state.cfg.lblTimeoutReminder)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('timeout_reminder')
              .setLabel(state.cfg.lblTimeoutReminder)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(state.timeoutReminder))
              .setPlaceholder('Enter: 0, 25, 50, or 75')
          )
        )
    );

  } else if (customId === 'story_manage_set_maxwriters') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_maxwriters_modal')
        .setTitle(state.cfg.lblMaxWriters)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('max_writers')
              .setLabel(state.cfg.lblMaxWriters)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.maxWriters != null ? String(state.maxWriters) : '')
              .setPlaceholder('Enter a number, or leave blank for no limit')
          )
        )
    );

  } else if (customId === 'story_manage_set_summary') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_summary_modal')
        .setTitle(state.cfg.lblSummary)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('summary')
              .setLabel(state.cfg.lblSummary)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setValue(state.summary)
              .setMaxLength(4000)
              .setPlaceholder('Enter a summary for this story (used in exports)')
          )
        )
    );

  } else if (customId === 'story_manage_set_tags') {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('story_manage_tags_modal')
        .setTitle(state.cfg.lblTags)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('tags')
              .setLabel(state.cfg.lblTags)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(state.tags)
              .setPlaceholder('Comma-separated tags (e.g. fluff, AU, slow burn)')
          )
        )
    );

  } else if (customId === 'story_manage_save') {
    await interaction.deferUpdate();
    await handleManageSave(connection, interaction, state);

  } else if (customId === 'story_manage_cancel') {
    await interaction.deferUpdate();
    pendingManageData.delete(userId);
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
}

async function handleManageSave(connection, interaction, state) {
  const guildId = interaction.guild.id;
  try {
    await connection.execute(
      `UPDATE story SET turn_length_hours = ?, timeout_reminder_percent = ?, max_writers = ?,
       allow_joins = ?, show_authors = ?, story_order_type = ?,
       story_turn_privacy = ?, summary = ?, tags = ? WHERE story_id = ?`,
      [
        state.turnLength, state.timeoutReminder, state.maxWriters ?? null,
        state.allowJoins, state.showAuthors, state.orderType,
        state.turnPrivacy, state.summary || null, state.tags || null,
        state.storyId
      ]
    );

    // Handle pause/resume if status changed
    if (state.targetStatus !== state.originalStatus) {
      await connection.execute(`UPDATE story SET story_status = ? WHERE story_id = ?`, [state.targetStatus, state.storyId]);

      if (state.targetStatus === 2) {
        await applyPauseActions(connection, interaction, state);
      } else if (state.targetStatus === 1) {
        await applyResumeActions(connection, interaction, state);
      }
    }

    pendingManageData.delete(interaction.user.id);
    updateStoryStatusMessage(connection, interaction.guild, state.storyId).catch(() => {});
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'txtAdminConfigSaved', guildId),
      embeds: [],
      components: []
    });
  } catch (error) {
    log(`Error saving manage settings: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await state.originalInteraction.editReply({
      content: await getConfigValue(connection, 'errProcessingRequest', guildId),
      embeds: [],
      components: []
    });
  }
}

async function applyPauseActions(connection, interaction, state) {
  const [activeTurnRows] = await connection.execute(
    `SELECT t.turn_id, t.thread_id, sw.discord_display_name
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND t.turn_status = 1`,
    [state.storyId]
  );
  if (activeTurnRows.length === 0) return;

  const { turn_id: turnId, thread_id: threadId, discord_display_name } = activeTurnRows[0];

  // Cancel pending timeout and reminder jobs
  await connection.execute(
    `UPDATE job SET job_status = 2 WHERE job_status = 0
     AND job_type IN ('turnTimeout', 'turnReminder')
     AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
    [turnId]
  );

  if (!threadId) return; // Quick mode — no thread to lock

  try {
    const thread = await interaction.guild.channels.fetch(threadId);
    if (!thread) return;

    const turnNumber = await getTurnNumber(connection, state.storyId);
    const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
    const pausedTitle = threadTitleTemplate
      .replace('[story_id]', state.guildStoryId)
      .replace('[storyTurnNumber]', turnNumber)
      .replace('[user display name]', discord_display_name)
      .replace('[turnEndTime]', 'PAUSED');

    await thread.setName(pausedTitle);
    await thread.setLocked(true);
  } catch (err) {
    log(`Could not lock turn thread on pause (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  // Update story thread title to show PAUSED
  try {
    const [storyInfo] = await connection.execute(
      `SELECT story_thread_id FROM story WHERE story_id = ?`, [state.storyId]
    );
    if (storyInfo[0]?.story_thread_id) {
      const storyThread = await interaction.guild.channels.fetch(storyInfo[0].story_thread_id).catch(() => null);
      if (storyThread) {
        const [txtPaused, titleTemplate] = await Promise.all([
          getConfigValue(connection, 'txtPaused', state.guildId),
          getConfigValue(connection, 'txtStoryThreadTitle', state.guildId)
        ]);
        await storyThread.setName(
          titleTemplate.replace('[story_id]', state.guildStoryId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtPaused)
        );
      }
    }
  } catch (err) {
    log(`Could not update story thread title on pause (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

async function applyResumeActions(connection, interaction, state) {
  const [activeTurnRows] = await connection.execute(
    `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.discord_display_name, sw.notification_prefs
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND t.turn_status = 1`,
    [state.storyId]
  );

  // Update story thread title back to Active regardless of turn state
  try {
    const [storyInfo] = await connection.execute(
      `SELECT story_thread_id FROM story WHERE story_id = ?`, [state.storyId]
    );
    if (storyInfo[0]?.story_thread_id) {
      const storyThread = await interaction.guild.channels.fetch(storyInfo[0].story_thread_id).catch(() => null);
      if (storyThread) {
        const [txtActive, titleTemplate] = await Promise.all([
          getConfigValue(connection, 'txtActive', state.guildId),
          getConfigValue(connection, 'txtStoryThreadTitle', state.guildId)
        ]);
        await storyThread.setName(
          titleTemplate.replace('[story_id]', state.guildStoryId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtActive)
        );
      }
    }
  } catch (err) {
    log(`Could not update story thread title on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  if (activeTurnRows.length === 0) {
    // No active turn — start a new one
    const nextWriterId = await PickNextWriter(connection, state.storyId);
    if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
    return;
  }

  const activeTurn = activeTurnRows[0];
  const newTurnEndsAt = new Date(Date.now() + (state.turnLength * 60 * 60 * 1000));

  // Reset turn deadline
  await connection.execute(
    `UPDATE turn SET turn_ends_at = ? WHERE turn_id = ?`,
    [newTurnEndsAt, activeTurn.turn_id]
  );

  // Cancel any lingering jobs, then reschedule fresh
  await connection.execute(
    `UPDATE job SET job_status = 2 WHERE job_status = 0
     AND job_type IN ('turnTimeout', 'turnReminder')
     AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
    [activeTurn.turn_id]
  );
  await connection.execute(
    `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
    ['turnTimeout', JSON.stringify({ turnId: activeTurn.turn_id, storyId: state.storyId, guildId: state.guildId }), newTurnEndsAt]
  );
  if (state.timeoutReminder > 0) {
    const reminderMs = state.turnLength * (state.timeoutReminder / 100) * 60 * 60 * 1000;
    const reminderTime = new Date(Date.now() + reminderMs);
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
      ['turnReminder', JSON.stringify({ turnId: activeTurn.turn_id, storyId: state.storyId, guildId: state.guildId, writerUserId: activeTurn.discord_user_id }), reminderTime]
    );
  }

  if (activeTurn.thread_id) {
    // Normal mode — unlock thread, rebuild title, post resumed message
    try {
      const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
      if (thread) {
        const turnNumber = await getTurnNumber(connection, state.storyId);
        const formattedEndTime = newTurnEndsAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
        const newTitle = threadTitleTemplate
          .replace('[story_id]', state.guildStoryId)
          .replace('[storyTurnNumber]', turnNumber)
          .replace('[user display name]', activeTurn.discord_display_name)
          .replace('[turnEndTime]', formattedEndTime);

        await thread.setName(newTitle);
        await thread.setLocked(false);

        const newEndTimestamp = `<t:${Math.floor(newTurnEndsAt.getTime() / 1000)}:F>`;
        const txtTurnThreadResumed = await getConfigValue(connection, 'txtTurnThreadResumed', state.guildId);
        await thread.send(replaceTemplateVariables(txtTurnThreadResumed, { turn_end_time: newEndTimestamp }));
      }
    } catch (err) {
      log(`Could not unlock turn thread on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
    }
  } else {
    // Quick mode — notify writer via DM or mention that their turn is active again
    try {
      const txtDMTurnStart = await getConfigValue(connection, 'txtDMTurnStart', state.guildId);
      const user = await interaction.client.users.fetch(activeTurn.discord_user_id);
      await user.send(txtDMTurnStart);
    } catch {
      try {
        const txtMentionTurnStart = await getConfigValue(connection, 'txtMentionTurnStart', state.guildId);
        const storyFeedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', state.guildId);
        const channel = await interaction.guild.channels.fetch(storyFeedChannelId);
        await channel.send(`<@${activeTurn.discord_user_id}> ${txtMentionTurnStart}`);
      } catch (err) {
        log(`Could not notify writer on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }
  }

}

async function handleManageModalSubmit(connection, interaction) {
  const userId = interaction.user.id;
  const state = pendingManageData.get(userId);

  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    if (interaction.customId === 'story_manage_turnlength_modal') {
      const val = parseInt(sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 10));
      if (isNaN(val) || val < 1) {
        return await interaction.reply({ content: 'Turn length must be at least 1 hour.', flags: MessageFlags.Ephemeral });
      }
      state.turnLength = val;

    } else if (interaction.customId === 'story_manage_reminder_modal') {
      const val = parseInt(sanitizeModalInput(interaction.fields.getTextInputValue('timeout_reminder'), 10));
      if (isNaN(val) || val < 0 || val > 100) {
        return await interaction.reply({ content: 'Timeout reminder must be a number between 0 and 100.', flags: MessageFlags.Ephemeral });
      }
      state.timeoutReminder = val;

    } else if (interaction.customId === 'story_manage_maxwriters_modal') {
      const raw = sanitizeModalInput(interaction.fields.getTextInputValue('max_writers'), 10);
      if (raw) {
        const val = parseInt(raw);
        if (isNaN(val) || val < 0) {
          return await interaction.reply({ content: 'Max writers must be at least 1, or leave blank for no limit.', flags: MessageFlags.Ephemeral });
        }
        state.maxWriters = val > 0 ? val : null; // 0 = no limit
      } else {
        state.maxWriters = null;
      }

    } else if (interaction.customId === 'story_manage_summary_modal') {
      state.summary = sanitizeModalInput(interaction.fields.getTextInputValue('summary'), 4000, true) ?? '';

    } else if (interaction.customId === 'story_manage_tags_modal') {
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 500) ?? '';
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));
    await interaction.deleteReply();

  } catch (error) {
    log(`Error in handleManageModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

async function handleClose(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_status FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    if (story.story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryAlreadyClosed', guildId) });
    }

    // Auth: oldest active writer (creator) OR admin role
    const [creatorRows] = await connection.execute(
      `SELECT discord_user_id FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY joined_at ASC LIMIT 1`,
      [storyId]
    );
    const isCreator = creatorRows.length > 0 && String(creatorRows[0].discord_user_id) === interaction.user.id;
    const isAdmin = await checkIsAdmin(connection, interaction, guildId);

    if (!isCreator && !isAdmin) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryCloseNotAuthorized', guildId) });
    }

    const [txtStoryCloseConfirm, btnCloseConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtStoryCloseConfirm', guildId),
      getConfigValue(connection, 'btnCloseConfirm', guildId),
      getConfigValue(connection, 'btnCancel', guildId)
    ]);

    const confirmMsg = replaceTemplateVariables(txtStoryCloseConfirm, { story_title: story.title });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_close_confirm_${storyId}`)
        .setLabel(btnCloseConfirm)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`story_close_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: confirmMsg, components: [row] });

  } catch (error) {
    log(`Error in handleClose: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleCloseConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, story_thread_id, quick_mode FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0 || storyRows[0].story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFoundOrClosed', guildId), components: [] });
    }
    const story = storyRows[0];

    // End active turn if exists, delete its thread in normal mode
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId]
    );
    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      await connection.execute(
        `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
        [activeTurn.turn_id]
      );
      if (!story.quick_mode && activeTurn.thread_id) {
        try {
          const turnThread = await interaction.guild.channels.fetch(activeTurn.thread_id);
          if (turnThread) await deleteThreadAndAnnouncement(turnThread);
        } catch (err) {
          log(`Could not delete turn thread ${activeTurn.thread_id}: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
    }

    // Close the story
    await connection.execute(
      `UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`,
      [storyId]
    );

    // Generate export (story is now marked closed so closed_at will be set in the file)
    const exportResult = await generateStoryExport(connection, storyId, guildId, interaction.guild);
    const turnCount = exportResult?.turnCount ?? 0;
    const wordCount = exportResult?.wordCount ?? 0;
    const writerCount = exportResult?.writerCount ?? 0;

    // Update story thread title and post close message (if thread still exists)
    if (story.story_thread_id) {
      try {
        const storyThread = await interaction.guild.channels.fetch(story.story_thread_id);
        if (storyThread) {
          // Update thread title to reflect closed status
          const [threadTitleTemplate, txtClosed] = await Promise.all([
            getConfigValue(connection, 'txtStoryThreadTitle', guildId),
            getConfigValue(connection, 'txtClosed', guildId)
          ]);
          const updatedTitle = threadTitleTemplate
            .replace('[story_id]', story.guild_story_id)
            .replace('[inputStoryTitle]', story.title)
            .replace('[story_status]', txtClosed);
          await storyThread.setName(updatedTitle);

          const txtStoryClosedPublic = await getConfigValue(connection, 'txtStoryClosedPublic', guildId);
          const closedMsg = replaceTemplateVariables(txtStoryClosedPublic, {
            story_title: story.title,
            writer_count: writerCount,
            turn_count: turnCount,
            word_count: wordCount.toLocaleString()
          });
          const messageOptions = { content: closedMsg };
          if (exportResult?.hasEntries) messageOptions.files = [{ attachment: exportResult.buffer, name: exportResult.filename }];
          await storyThread.send(messageOptions);
        }
      } catch (err) {
        log(`Story thread not available for close post (story ${storyId})`, { show: false, guildName: interaction?.guild?.name });
      }
    }

    // Feed announcement — only if there are confirmed entries
    if (turnCount > 0) {
      await postStoryFeedClosedAnnouncement(connection, interaction, story.title, turnCount, wordCount, writerCount, exportResult);
    }

    updateStoryStatusMessage(connection, interaction.guild, storyId).catch(() => {});

    // Clear confirmation buttons
    await interaction.editReply({ content: '✅', components: [] });

  } catch (error) {
    log(`Error in handleCloseConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handleCloseCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
}


async function handleAutocomplete(connection, interaction) {
  if (!interaction.guild) return interaction.respond([]);

  const focusedOption = interaction.options.getFocused(true);
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (!storyId) return interaction.respond([]);

  const typed = String(focusedOption.value);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  let rows;
  if (focusedOption.name === 'turn') {
    if (isAdmin) {
      [rows] = await connection.execute(
        `SELECT turn_number, discord_display_name, content FROM (
           SELECT
             (SELECT COUNT(DISTINCT t2.turn_id)
              FROM turn t2
              JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
              JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
              WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
             ) AS turn_number,
             sw.discord_display_name, se.content
           FROM story_entry se
           JOIN turn t ON se.turn_id = t.turn_id
           JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
           WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
         ) sub
         WHERE CAST(turn_number AS CHAR) LIKE ? OR discord_display_name LIKE ?
         ORDER BY turn_number LIMIT 25`,
        [storyId, `${typed}%`, `%${typed}%`]
      );
    } else {
      [rows] = await connection.execute(
        `SELECT turn_number, discord_display_name, content FROM (
           SELECT
             (SELECT COUNT(DISTINCT t2.turn_id)
              FROM turn t2
              JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
              JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
              WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
             ) AS turn_number,
             sw.discord_display_name, sw.discord_user_id, se.content
           FROM story_entry se
           JOIN turn t ON se.turn_id = t.turn_id
           JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
           WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
             AND sw.discord_user_id = ?
         ) sub
         WHERE CAST(turn_number AS CHAR) LIKE ? OR discord_display_name LIKE ?
         ORDER BY turn_number LIMIT 25`,
        [storyId, interaction.user.id, `${typed}%`, `%${typed}%`]
      );
    }

    return interaction.respond(
      rows.map(r => {
        const preview = r.content ? r.content.trim().slice(0, 25).trimEnd() : '';
        const label = preview
          ? `Turn ${r.turn_number} — ${r.discord_display_name} — "${preview}…"`
          : `Turn ${r.turn_number} — ${r.discord_display_name}`;
        return { name: label.slice(0, 100), value: r.turn_number };
      })
    );
  }

  return interaction.respond([]);
}

export default {
  data,
  execute,
  handleModalSubmit,
  handleButtonInteraction,
  handleSelectMenuInteraction,
  handleAutocomplete
};