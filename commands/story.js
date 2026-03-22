import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, formattedDate, replaceTemplateVariables, debugLog, isGuildConfigured } from '../utilities.js';
import { marked } from 'marked';
import { CreateStory, PickNextWriter, NextTurn, updateStoryStatusMessage, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';
import { postStoryFeedJoinAnnouncement, postStoryFeedClosedAnnouncement } from '../announcements.js';

// Temporary storage for first modal data while user completes second modal
const pendingStoryData = new Map();

// Pending manage edit sessions keyed by userId
const pendingManageData = new Map();

// Convert Discord markdown to HTML for export
function discordMarkdownToHtml(text) {
  // Pre-process Discord blockquote syntax before marked sees it
  const lines = text.split('\n');
  const processed = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
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

  // Convert Discord CDN image URLs to clickable <img> tags after marked has run
  // so marked can't escape the HTML we inject
  html = html.replace(
    /(?<!href=")(https:\/\/cdn\.discordapp\.com\/attachments\/[^\s<"]+)/g,
    '<a href="$1"><img src="$1" style="max-width:100%;display:block;margin:8px 0"></a>'
  );

  return html;
}

// Tracks pending DM reminder timeouts by entryId so they can be cancelled on confirm/discard
const pendingReminderTimeouts = new Map();

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
      .setDescription('Download the full story so far as a file')
      .addIntegerOption(option =>
        option.setName('story_id')
          .setDescription('Story ID to export')
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
      .setName('help')
      .setDescription('How to use Round Robin StoryBot')
  );

async function execute(connection, interaction) {
  const subcommand = interaction.options.getSubcommand();
  debugLog(`${formattedDate()}: execute() called with subcommand '${subcommand}'`);

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
  } else if (subcommand === 'help') {
    await handleHelp(connection, interaction);
  } else {
    console.log(`${formattedDate()}: execute() - unrecognized subcommand '${subcommand}', no handler matched`);
  }
}

async function handleAddStory(connection, interaction) {
  debugLog(`${formattedDate()}: handleAddStory() - initializing ephemeral story form`);

  if (!await isGuildConfigured(connection, interaction.guild.id)) {
    await interaction.reply({
      content: await getConfigValue(connection, 'txtNotConfigured', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  try {
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
      ao3Name: interaction.member?.displayName || interaction.user.displayName,
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(buildStoryAddMessage(cfg, state));

    debugLog(`${formattedDate()}: handleAddStory() - ephemeral form sent`);
  } catch (error) {
    console.error(`${formattedDate()}: Error in handleAddStory:`, error);
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
  } else if (interaction.customId.startsWith('story_join_')) {
    await handleJoinModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_manage_')) {
    await handleManageModalSubmit(connection, interaction);
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
    console.error(`${formattedDate()}: Error in handleAddStoryModalSubmit:`, error);
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
    console.error(`${formattedDate()}: Error creating story:`, error);
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
async function handleJoin(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    const storyId = interaction.options.getInteger('story_id');
    
    // Validate story access and get story info
    const storyInfo = await validateStoryAccess(connection, storyId, guildId);
    if (!storyInfo.success) {
      await interaction.reply({ 
        content: storyInfo.error, 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }
    
    // Validate join eligibility
    const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
    if (!joinInfo.success) {
      await interaction.reply({ 
        content: joinInfo.error, 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }
    
    // Check if user has existing AO3 name from other stories
    let existingAO3Name = '';
      try {
        const [existingWriter] = await connection.execute(`
          SELECT AO3_name FROM story_writer 
          WHERE discord_user_id = ? AND AO3_name IS NOT NULL AND AO3_name != ''
          ORDER BY joined_at DESC LIMIT 1
        `, [interaction.user.id]);
        
        if (existingWriter.length > 0) {
          existingAO3Name = existingWriter[0].AO3_name;
        }
      } catch (error) {
      // Continue if lookup fails
    }
    
    // Create modal
    const modal = new ModalBuilder()
      .setCustomId(`story_join_${storyId}`)
      .setTitle(`🎭 Join "${storyInfo.story.title}"`);

    const cfg = await getConfigValue(connection, [
      'lblJoinAO3Name', 'txtJoinAO3Placeholder',
      'lblJoinPrivacy', 'txtJoinPrivacyPlaceholder',
      'lblJoinNotifications', 'txtJoinNotificationPlaceholder'
    ], interaction.guild.id);

    const ao3NameInput = new TextInputBuilder()
      .setCustomId('ao3_name')
      .setLabel(cfg.lblJoinAO3Name)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(cfg.txtJoinAO3Placeholder)
      .setMaxLength(255);

    if (existingAO3Name) {
      ao3NameInput.setValue(existingAO3Name);
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(ao3NameInput),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('turn_privacy')
          .setLabel(cfg.lblJoinPrivacy)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue('public')
          .setPlaceholder(cfg.txtJoinPrivacyPlaceholder)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notification_prefs')
          .setLabel(cfg.lblJoinNotifications)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue('dm')
          .setPlaceholder(cfg.txtJoinNotificationPlaceholder)
      )
    );

    await interaction.showModal(modal);

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleJoin:`, error);
    await interaction.reply({
      content: await getConfigValue(connection,'txtJoinFormFailed', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
}

/**
 * Handle join modal submission
 */
async function handleJoinModalSubmit(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    const storyId = interaction.customId.split('_')[2];
    
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    // Get and validate form values
    const ao3Name = sanitizeModalInput(interaction.fields.getTextInputValue('ao3_name'), 255);
    const turnPrivacyRaw = sanitizeModalInput(interaction.fields.getTextInputValue('turn_privacy'), 10);
    const notificationPrefsRaw = sanitizeModalInput(interaction.fields.getTextInputValue('notification_prefs'), 10);
    
    // Get validation error messages
    const txtValidationErrors = await getConfigValue(connection,'txtValidationErrors', guildId);
    
    // Validate inputs
    const errors = [];
    
    // Validate turn privacy
    const turnPrivacy = turnPrivacyRaw.toLowerCase();
    if (!['public', 'private'].includes(turnPrivacy)) {
      errors.push(await getConfigValue(connection,'txtPrivacyValidation', guildId));
    }
    
    // Validate notification preferences
    const notificationPrefs = notificationPrefsRaw.toLowerCase();
    if (!['dm', 'mention'].includes(notificationPrefs)) {
      errors.push(await getConfigValue(connection,'txtNotificationValidation', guildId));
    }
    
    if (errors.length > 0) {
      await interaction.editReply({
        content: `${txtValidationErrors}\n${errors.join('\n')}`
      });
      return;
    }
    
    // Re-validate join eligibility (in case story changed)
    const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
    if (!joinInfo.success) {
      await interaction.editReply({
        content: joinInfo.error
      });
      return;
    }
    
    // Prepare join input for StoryJoin function
    const joinInput = {
      ao3Name: ao3Name || null,
      turnPrivacy: turnPrivacy === 'private' ? 0 : 1,
      notificationPrefs: notificationPrefs
    };
    
    // Import StoryJoin function and call it
    const { StoryJoin } = await import('../storybot.js');
    const txn = await connection.getConnection();
    await txn.beginTransaction();
    try {
      const result = await StoryJoin(txn, interaction, joinInput, parseInt(storyId));

      if (result.success) {
        await txn.commit();

        // Get current writer count for success message
        const [writerCount] = await connection.execute(`
          SELECT COUNT(*) as count FROM story_writer
          WHERE story_id = ? AND sw_status = 1
        `, [storyId]);

        const [storyInfo] = await connection.execute(`
          SELECT title FROM story WHERE story_id = ?
        `, [storyId]);

        const txtJoinSuccess = await getConfigValue(connection,'txtJoinSuccess', guildId);
        const successMessage = replaceTemplateVariables(txtJoinSuccess, {
          story_title: storyInfo[0].title,
          writer_number: writerCount[0].count
        });

        await interaction.editReply({
          content: `${successMessage}${result.confirmationMessage || ''}`
        });

        // Post announcement to story feed channel
        await postStoryFeedJoinAnnouncement(connection, storyId, interaction, storyInfo[0].title);
        updateStoryStatusMessage(connection, interaction.guild, parseInt(storyId)).catch(() => {});

        // Activity log (fire-and-forget)
        const writerName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
        getConfigValue(connection, 'txtStoryThreadWriterJoin', interaction.guild.id).then(template =>
          postStoryThreadActivity(connection, interaction.guild, parseInt(storyId), template.replace('[writer_name]', writerName))
        ).catch(() => {});

      } else {
        await txn.rollback();
        await interaction.editReply({
          content: result.error
        });
      }

    } catch (error) {
      await txn.rollback();
      throw error;
    } finally {
      txn.release();
    }
    
  } catch (error) {
    console.error(`${formattedDate()}: Error in handleJoinModalSubmit:`, error);
    await interaction.editReply({
      content: await getConfigValue(connection,'txtJoinProcessFailed', interaction.guild.id)
    });
  }
}

/**
 * Handle /story write command
 */
async function handleWrite(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    const storyId = interaction.options.getInteger('story_id');
    
    // Validate story access and get story info
    const storyInfo = await validateStoryAccess(connection, storyId, guildId);
    if (!storyInfo.success) {
      await interaction.reply({ 
        content: storyInfo.error, 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }
    
    // Validate active writer
    const writerInfo = await validateActiveWriter(connection, interaction.user.id, storyId);
    if (!writerInfo.success) {
      await interaction.reply({ 
        content: writerInfo.error, 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }
    
    // Check if story is quick mode
    if (!storyInfo.story.quick_mode) {
      await interaction.reply({ 
        content: await getConfigValue(connection,'txtNormalModeWrite', guildId), 
        flags: MessageFlags.Ephemeral 
      });
      return;
    }
    
    // Get configurable text for warnings (used multiple times)
    const txtWriteWarning = await getConfigValue(connection,'txtWriteWarning', guildId);
    
    // Create modal
    const modal = new ModalBuilder()
      .setCustomId(`story_write_${storyId}`)
      .setTitle(`✍️ ${storyInfo.story.title}`);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('entry_content')
          .setLabel(await getConfigValue(connection, 'lblWriteEntry', interaction.guild.id))
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder(`⚠️ ${txtWriteWarning}\n\n${await getConfigValue(connection, 'txtWritePlaceholder', interaction.guild.id)}`)
          .setMaxLength(4000)
          .setMinLength(10)
          .setRequired(true)
      )
    );

    await interaction.showModal(modal);

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleWrite:`, error);
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
        AND se.entry_status = 'pending'
      `, [storyId, interaction.user.id]);
      
      if (pendingEntry.length > 0) {
        // Update existing pending entry
        await connection.execute(`
          UPDATE story_entry SET content = ?, created_at = NOW() 
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
          INSERT INTO story_entry (turn_id, content, entry_status, order_in_turn)
          VALUES (?, ?, 'pending', 1)
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
        console.log(`${formattedDate()}: Could not send DM reminder to user ${interaction.user.id}`);
      }
    }, 5 * 60 * 1000);
    pendingReminderTimeouts.set(entryId, reminderTimeout);

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleWriteModalSubmit:`, error);
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
    console.error(`${formattedDate()}: Error in validateStoryAccess:`, error);
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
    console.error(`${formattedDate()}: Error in validateActiveWriter:`, error);
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
    
    // Check if story allows late joins (if story has started)
    if (story.story_status === 1 && !story.allow_joins) {
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
 * Create entry preview embed
 */
async function createPreviewEmbed(connection, content, guildId, discordTimestamp) {
  const lblYourEntry = await getConfigValue(connection,'lblYourEntry', guildId);
  const lblEntryContinued = await getConfigValue(connection,'lblEntryContinued', guildId);
  const txtEntryStatsTemplate = await getConfigValue(connection,'txtEntryStatsTemplate', guildId);
  
  const embed = new EmbedBuilder()
    .setTitle(await getConfigValue(connection,'txtPreviewTitle', guildId))
    .setDescription(await getConfigValue(connection,'txtPreviewDescription', guildId))
    .setColor(0xffd700)
    .addFields({ name: await getConfigValue(connection,'txtPreviewExpires', guildId), value: discordTimestamp, inline: false });
    
  // Handle long content by splitting into multiple fields
  const maxFieldLength = 1024;
  if (content.length <= maxFieldLength) {
    embed.addFields({
      name: lblYourEntry,
      value: content,
      inline: false
    });
  } else {
    let remainingContent = content;
    let fieldCount = 1;
    
    while (remainingContent.length > 0) {
      const fieldContent = remainingContent.length > maxFieldLength 
        ? remainingContent.substring(0, maxFieldLength)
        : remainingContent;
        
      const fieldName = fieldCount === 1 
        ? lblYourEntry 
        : replaceTemplateVariables(lblEntryContinued, { count: fieldCount });
        
      embed.addFields({
        name: fieldName,
        value: fieldContent,
        inline: false
      });
      
      remainingContent = remainingContent.substring(maxFieldLength);
      fieldCount++;
    }
  }
  
  // Add stats
  const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;
  const statsText = replaceTemplateVariables(txtEntryStatsTemplate, {
    char_count: content.length,
    word_count: wordCount
  });
    
  embed.addFields({
    name: await getConfigValue(connection,'lblEntryStats', guildId),
    value: statsText,
    inline: true
  });
  
  return embed;
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
    'txtHelp2Title', 'txtHelp2Footer', 'btnHelp2ToPage1', 'btnHelp2ToPage3',
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
  try {
    const guildId = interaction.guild.id;
    const filter = interaction.options.getString('filter') || 'all';
    const page = interaction.options.getInteger('page') || 1;
    const itemsPerPage = 5;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const stories = await getStoriesPaginated(connection, guildId, filter, page, itemsPerPage, interaction.user.id);

    if (stories.data.length === 0) {
      const txtNoStoriesFound = await getConfigValue(connection,'txtNoStoriesFound', guildId);
      const filterTitle = await getFilterTitle(connection, filter, guildId);
      await interaction.editReply({
        content: replaceTemplateVariables(txtNoStoriesFound, { filter_name: filterTitle })
      });
      return;
    }

    // Get configurable text for embed
    const filterTitle = await getFilterTitle(connection, filter, guildId);
    
    const embed = new EmbedBuilder()
      .setTitle(replaceTemplateVariables(await getConfigValue(connection,'txtStoriesPageTitle', guildId), {
        filter_title: filterTitle,
        page: page,
        total_pages: stories.totalPages
      }))
      .setDescription(replaceTemplateVariables(await getConfigValue(connection,'txtStoriesPageDesc', guildId), {
        showing: stories.data.length,
        total: stories.totalCount
      }))
      .setColor(0x3498db)
      .setTimestamp();

    // Add story fields
    for (const story of stories.data) {
      const statusIcon = getStatusIcon(story.story_status);
      const joinStatus = story.join_status === 2
        ? await getConfigValue(connection, 'txtMemberStatusJoined', guildId)
        : story.join_status === 1
          ? await getConfigValue(connection, 'txtMemberStatusCanJoin', guildId)
          : await getConfigValue(connection, 'txtMemberStatusCanNotJoin', guildId);
      const currentTurn = await getCurrentTurnInfo(connection, story, guildId);
      
      // Get configurable labels
      const lblStoryStatus = await getConfigValue(connection,'lblStoryStatus', guildId);
      const lblStoryTurn = await getConfigValue(connection,'lblStoryTurn', guildId);
      const lblStoryWriters = await getConfigValue(connection,'lblStoryWriters', guildId);
      const lblStoryMode = await getConfigValue(connection,'lblStoryMode', guildId);
      const lblStoryCreator = await getConfigValue(connection,'lblStoryCreator', guildId);
      const modeText = story.quick_mode 
        ? await getConfigValue(connection,'txtModeQuick', guildId)
        : await getConfigValue(connection,'txtModeNormal', guildId);
      const statusText = await getStatusText(connection, story.story_status, guildId);

      embed.addFields({
        name: `${statusIcon} "${story.title}" (#${story.story_id})`,
        value: `├ ${lblStoryStatus} ${statusText} • ${lblStoryTurn} ${currentTurn}
                ├ ${lblStoryWriters} ${story.writer_count}/${story.max_writers || '∞'} • ${lblStoryMode} ${modeText}
                └ ${lblStoryCreator} ${story.creator_name} • ${joinStatus}`,
        inline: false
      });
    }

  // Create navigation buttons
  const components = [];
  
  // Navigation row
  const navRow = new ActionRowBuilder();
  
  if (stories.totalPages > 1) {
    const btnPrev = await getConfigValue(connection,'btnPrev', guildId);
    const btnNext = await getConfigValue(connection,'btnNext', guildId);
    
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`story_list_${filter}_${page - 1}`)
        .setLabel(btnPrev)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`story_list_${filter}_${page + 1}`)
        .setLabel(btnNext)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === stories.totalPages)
    );
  }    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId('story_filter')
        .setLabel('🔍 Filter')
        .setStyle(ButtonStyle.Secondary)
    );
    
    components.push(navRow);

    // Quick join menu if there are joinable stories
    const joinableStories = stories.data.filter(s => s.join_status === 1);
    if (joinableStories.length > 0) {
      const txtQuickJoinPlaceholder = await getConfigValue(connection,'txtQuickJoinPlaceholder', guildId);
      const txtQuickJoinDesc = await getConfigValue(connection,'txtQuickJoinDesc', guildId);
      const txtModeQuick = await getConfigValue(connection,'txtModeQuick', guildId);
      const txtModeNormal = await getConfigValue(connection,'txtModeNormal', guildId);
      
      const joinRow = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('story_quick_join')
            .setPlaceholder(txtQuickJoinPlaceholder)
            .addOptions(joinableStories.map(s => ({
              label: `${s.title} (#${s.story_id})`,
              value: s.story_id.toString(),
              description: replaceTemplateVariables(txtQuickJoinDesc, {
                'writer_count': s.writer_count,
                'max_writers': s.max_writers || '∞',
                'mode': s.quick_mode ? txtModeQuick : txtModeNormal
              })
            })))
        );
      components.push(joinRow);
    }

    await interaction.editReply({
      embeds: [embed],
      components
    });

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleListStories:`, error);
    await interaction.editReply({
      content: await getConfigValue(connection,'txtStoryListFailed', interaction.guild.id),
    });
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
  } else if (interaction.customId === 'story_filter') {
    await handleFilterButton(connection, interaction);
  } else if (interaction.customId === 'story_help_page_1' || interaction.customId === 'story_help_page_2' || interaction.customId === 'story_help_page_3') {
    await handleHelpNavigation(connection, interaction);
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

  const stories = await getStoriesPaginated(connection, guildId, filter, page, itemsPerPage, interaction.user.id);

  const [txtStoriesPageTitle, txtStoriesPageDesc, filterTitle] = await Promise.all([
    getConfigValue(connection, 'txtStoriesPageTitle', guildId),
    getConfigValue(connection, 'txtStoriesPageDesc', guildId),
    getFilterTitle(connection, filter, guildId),
  ]);

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(txtStoriesPageTitle, {
      filter_title: filterTitle,
      page: page,
      total_pages: stories.totalPages
    }))
    .setDescription(replaceTemplateVariables(txtStoriesPageDesc, {
      showing: stories.data.length,
      total: stories.totalCount
    }))
    .setColor(0x3498db)
    .setTimestamp();

  for (const story of stories.data) {
    const statusIcon = getStatusIcon(story.story_status);
    const joinStatus = story.join_status === 2
      ? await getConfigValue(connection, 'txtMemberStatusJoined', guildId)
      : story.join_status === 1
        ? await getConfigValue(connection, 'txtMemberStatusCanJoin', guildId)
        : await getConfigValue(connection, 'txtMemberStatusCanNotJoin', guildId);
    const currentTurn = await getCurrentTurnInfo(connection, story, guildId);
    const [lblStoryStatus, lblStoryTurn, lblStoryWriters, lblStoryMode, lblStoryCreator, modeText, statusText] = await Promise.all([
      getConfigValue(connection, 'lblStoryStatus', guildId),
      getConfigValue(connection, 'lblStoryTurn', guildId),
      getConfigValue(connection, 'lblStoryWriters', guildId),
      getConfigValue(connection, 'lblStoryMode', guildId),
      getConfigValue(connection, 'lblStoryCreator', guildId),
      getConfigValue(connection, story.quick_mode ? 'txtModeQuick' : 'txtModeNormal', guildId),
      getStatusText(connection, story.story_status, guildId),
    ]);
    embed.addFields({
      name: `${statusIcon} "${story.title}" (#${story.story_id})`,
      value: `├ ${lblStoryStatus} ${statusText} • ${lblStoryTurn} ${currentTurn}
              ├ ${lblStoryWriters} ${story.writer_count}/${story.max_writers || '∞'} • ${lblStoryMode} ${modeText}
              └ ${lblStoryCreator} ${story.creator_name} • ${joinStatus}`,
      inline: false
    });
  }

  const navRow = new ActionRowBuilder();
  if (stories.totalPages > 1) {
    const [btnPrev, btnNext] = await Promise.all([
      getConfigValue(connection, 'btnPrev', guildId),
      getConfigValue(connection, 'btnNext', guildId),
    ]);
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`story_list_${filter}_${page - 1}`)
        .setLabel(btnPrev)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`story_list_${filter}_${page + 1}`)
        .setLabel(btnNext)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === stories.totalPages)
    );
  }

  const btnFilter = await getConfigValue(connection, 'btnFilter', guildId);
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('story_filter')
      .setLabel(btnFilter)
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ content: '', embeds: [embed], components: [navRow] });
}

/**
 * Handle entry confirmation/discard
 */
async function handleEntryConfirmation(connection, interaction) {
  const [action, , entryId] = interaction.customId.split('_');
  
  try {
    await interaction.deferUpdate();
    
    if (action === 'confirm') {
      await confirmEntry(connection, entryId, interaction);
    } else if (action === 'discard') {
      await discardEntry(connection, entryId, interaction);
    }
    
  } catch (error) {
    console.error(`${formattedDate()}: Error in handleEntryConfirmation:`, error);
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

    // Get story info for turn advancement and entry posting
    const [entryInfo] = await txn.execute(`
      SELECT se.turn_id, se.content, sw.story_id, sw.discord_user_id, sw.discord_display_name,
             s.story_thread_id, s.show_authors,
             (SELECT COUNT(*) FROM turn t2
              JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
              WHERE sw2.story_id = sw.story_id) as turn_number
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

    // End current turn
    await txn.execute(`
      UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?
    `, [turn_id]);

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
      console.error(`${formattedDate()}: Failed to post entry to story thread:`, threadError);
    }

    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntrySubmitted', interaction.guild.id),
      embeds: [],
      components: []
    });

  } catch (error) {
    await txn.rollback();
    console.error(`${formattedDate()}: Error in confirmEntry:`, error);
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
    console.error(`${formattedDate()}: Error in discardEntry:`, error);
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
    const storyId = interaction.values[0];
    const syntheticInteraction = {
      ...interaction,
      options: { getInteger: (name) => name === 'story_id' ? parseInt(storyId) : null }
    };
    await handleJoin(syntheticInteraction);

  } else if (interaction.customId === 'story_filter_select') {
    const filter = interaction.values[0];
    await interaction.deferUpdate();
    await renderStoryListReply(connection, interaction, filter, 1);
  }
}

/**
 * Get paginated stories from database
 */
async function getStoriesPaginated(connection, guildId, filter, page, itemsPerPage, userId) {

  try {
    let whereClause = 'WHERE s.guild_id = ?';
    let params = [guildId];
    debugLog(`${formattedDate()}: getStoriesPaginated - guildId: ${guildId}, filter: ${filter}`);
    
    // Apply filters
    switch (filter) {
      case 'joinable':
        whereClause += ' AND s.story_status IN (1, 2) AND s.allow_joins = 1 AND (s.max_writers IS NULL OR writer_count < s.max_writers)';
        whereClause += ' AND s.story_id NOT IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = 1)';
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
    debugLog(`${formattedDate()}: getStoriesPaginated - totalCount: ${totalCount}`);
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
          WHEN s.allow_joins = 1
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
    debugLog(`${formattedDate()}: getStoriesPaginated - stories rows returned: ${stories.length}`);

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

async function getStatusText(connection, status, guildId) {
  const configKeys = {
    1: 'txtActive',
    2: 'txtPaused',
    3: 'txtClosed'
  };

  const configKey = configKeys[status];
  if (configKey) {
    return await getConfigValue(connection,configKey, guildId);
  }
  return 'Unknown';
}

async function getCurrentTurnInfo(connection, story, guildId) {
  if (story.story_status === 2) return await getConfigValue(connection,'txtPaused', guildId);
  if (story.story_status === 3) return await getConfigValue(connection,'txtClosed', guildId);

  // For active stories, get current turn info
  
  try {
    const [turnInfo] = await connection.execute(`
      SELECT sw.discord_display_name, t.started_at, s.turn_length_hours
      FROM turn t
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
      JOIN story s ON sw.story_id = s.story_id
      WHERE sw.story_id = ? AND t.turn_status = 1
      ORDER BY t.started_at DESC LIMIT 1
    `, [story.story_id]);
    
    if (turnInfo.length === 0) {
      return await getConfigValue(connection,'txtTurnWaiting', guildId);
    }
    
    const turn = turnInfo[0];
    const endTime = new Date(turn.started_at.getTime() + (turn.turn_length_hours * 60 * 60 * 1000));
    const timeLeft = endTime.getTime() - Date.now();
    
    if (timeLeft <= 0) {
      const txtTurnOverdue = await getConfigValue(connection,'txtTurnOverdue', guildId);
      return replaceTemplateVariables(txtTurnOverdue, { writer_name: turn.discord_display_name });
    }
    
    const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
    const txtTurnTimeLeft = await getConfigValue(connection,'txtTurnTimeLeft', guildId);
    return replaceTemplateVariables(txtTurnTimeLeft, {
      writer_name: turn.discord_display_name,
      hours: hoursLeft
    });
    
  } catch (error) {
    return await getConfigValue(connection,'txtTurnUnknown', guildId);
  } finally {
    // Connection is persistent, no need to release
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
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }

    const [txtFinalizeConfirm, btnFinalizeConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtFinalizeConfirm', guildId),
      getConfigValue(connection, 'btnFinalizeConfirm', guildId),
      getConfigValue(connection, 'btnCancel', guildId),
    ]);

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

    await interaction.editReply({ content: txtFinalizeConfirm, components: [row] });

  } catch (error) {
    console.error(`${formattedDate()}: handleFinalizeEntry failed:`, error);
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
              console.error(`${formattedDate()}: Failed to forward image to media channel:`, err);
            }
          }
        }
      }
      if (parts.length > 0) entryParts.push(parts.join('\n'));
    }

    const entryContent = entryParts.join('\n\n');

    const [storyInfo] = await connection.execute(
      `SELECT s.show_authors, s.story_thread_id, sw.discord_display_name,
              (SELECT COUNT(*) FROM turn t2 JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               WHERE sw2.story_id = ?) as turn_number
       FROM story s
       JOIN story_writer sw ON sw.story_id = s.story_id AND sw.discord_user_id = ?
       WHERE s.story_id = ?`,
      [storyId, interaction.user.id, storyId]
    );
    const { show_authors, story_thread_id, discord_display_name, turn_number } = storyInfo[0];

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

    try {
      const storyThread = await interaction.guild.channels.fetch(story_thread_id);
      const entryEmbed = new EmbedBuilder().setDescription(entryContent);
      if (show_authors) entryEmbed.setAuthor({ name: `Turn ${turn_number} — ${discord_display_name}` });
      await storyThread.send({ embeds: [entryEmbed] });
    } catch (embedError) {
      console.error(`${formattedDate()}: Failed to post finalized entry to story thread:`, embedError);
    }

    await deleteThreadAndAnnouncement(thread);

  } catch (error) {
    console.error(`${formattedDate()}: handleFinalizeConfirm failed:`, error);
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
    console.error(`${formattedDate()}: Skip turn confirmation failed:`, error);
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

    // Delete turn thread
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        console.error(`${formattedDate()}: Failed to delete skipped turn thread:`, err);
      }
    }

    await interaction.editReply({ content: await getConfigValue(connection, 'txtEntryFinalized', guildId), components: [] });

  } catch (error) {
    console.error(`${formattedDate()}: Skip turn failed:`, error);
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
async function generateStoryExport(connection, storyId, guildId) {
  const [storyRows] = await connection.execute(
    `SELECT story_id, title, created_at, story_status, quick_mode, closed_at, show_authors, summary, tags FROM story WHERE story_id = ? AND guild_id = ?`,
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
     ORDER BY t.started_at, se.order_in_turn`,
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
    entriesHtml += discordMarkdownToHtml(entry.content);
  }
  if (currentTurn !== null) entriesHtml += `</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${story.title}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #222; line-height: 1.7; }
    h1 { font-size: 2em; margin-bottom: 8px; }
    .meta { color: #666; font-size: 0.9em; margin-bottom: 8px; }
    .meta-block { border-bottom: 1px solid #ddd; padding-bottom: 24px; margin-bottom: 40px; }
    .turn { margin-bottom: 40px; border-top: 1px solid #ddd; padding-top: 20px; }
    p { margin: 0 0 1em; }
    .spoiler { background: #222; color: #222; border-radius: 3px; padding: 0 2px; cursor: pointer; }
    .spoiler:hover { color: #fff; }
    .summary { color: #444; font-style: italic; margin-bottom: 40px; border-top: 1px solid #ddd; padding-top: 20px; }
  </style>
</head>
<body>
  <div class="meta-block">
    <h1>${story.title}</h1>
    <div class="meta">Started: ${publishedDate} &nbsp; ${secondDateLabel}: ${secondDate}</div>
    <div class="meta">Story #${story.story_id} &nbsp;·&nbsp; ${modeLabel} &nbsp;·&nbsp; ${turnCount} turn(s) &nbsp;·&nbsp; ~${wordCount.toLocaleString()} words</div>
    <div class="meta">Writers: ${writersList}</div>${story.tags ? `\n    <div class="meta">Tags: ${story.tags}</div>` : ''}
    <div class="meta">Exported: ${exportDate}</div>
  </div>${story.summary ? `\n  <div class="summary"><p>${story.summary}</p></div>` : ''}
  ${entriesHtml}
</body>
</html>`;

  const buffer = Buffer.from(html, 'utf8');
  const filename = `${story.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_story${storyId}.html`;
  return { hasEntries: true, title: story.title, turnCount, wordCount, writerCount, buffer, filename };
}

async function handleRead(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

  try {
    const result = await generateStoryExport(connection, storyId, guildId);
    if (!result) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    if (!result.hasEntries) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtNoConfirmedEntries', guildId) });
    }
    const { buffer, filename, title, turnCount, wordCount } = result;
    await interaction.editReply({
      content: `📖 Here is **${title}** (#${storyId} · ${turnCount} turn(s) · ~${wordCount.toLocaleString()} words).`,
      files: [{ attachment: buffer, name: filename }]
    });
  } catch (error) {
    console.error(`${formattedDate()}: Error in handleRead:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
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
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_status, turn_length_hours, timeout_reminder_percent,
              max_writers, allow_joins, show_authors, story_order_type, summary, tags
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
    const adminRoleName = await getConfigValue(connection, 'cfgAdminRoleName', guildId);
    const isAdmin = interaction.member.permissions.has('Administrator') ||
      (adminRoleName && interaction.member.roles.cache.some(r => r.name === adminRoleName));

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
      'lblTags', 'btnSetTags'
    ], guildId);

    const state = {
      cfg,
      storyId,
      guildId,
      title: story.title,
      turnLength: story.turn_length_hours,
      timeoutReminder: story.timeout_reminder_percent ?? 50,
      maxWriters: story.max_writers,
      allowJoins: story.allow_joins,
      showAuthors: story.show_authors,
      orderType: story.story_order_type,
      summary: story.summary ?? '',
      tags: story.tags ?? '',
      originalStatus: story.story_status,
      targetStatus: story.story_status,
      originalInteraction: interaction
    };

    pendingManageData.set(interaction.user.id, state);
    await interaction.editReply(buildManageMessage(cfg, state));

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleManage:`, error);
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
       summary = ?, tags = ? WHERE story_id = ?`,
      [
        state.turnLength, state.timeoutReminder, state.maxWriters ?? null,
        state.allowJoins, state.showAuthors, state.orderType,
        state.summary || null, state.tags || null,
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
    console.error(`${formattedDate()}: Error saving manage settings:`, error);
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

    const [turnCountResult] = await connection.execute(
      `SELECT COUNT(*) as turn_number FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ?`,
      [state.storyId]
    );
    const turnNumber = turnCountResult[0].turn_number;
    const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
    const pausedTitle = threadTitleTemplate
      .replace('[story_id]', state.storyId)
      .replace('[storyTurnNumber]', turnNumber)
      .replace('[user display name]', discord_display_name)
      .replace('[turnEndTime]', 'PAUSED');

    await thread.setName(pausedTitle);
    await thread.setLocked(true);
  } catch (err) {
    console.error(`${formattedDate()}: Could not lock turn thread on pause (story ${state.storyId}):`, err);
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
          titleTemplate.replace('[story_id]', state.storyId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtPaused)
        );
      }
    }
  } catch (err) {
    console.error(`${formattedDate()}: Could not update story thread title on pause (story ${state.storyId}):`, err);
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
          titleTemplate.replace('[story_id]', state.storyId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtActive)
        );
      }
    }
  } catch (err) {
    console.error(`${formattedDate()}: Could not update story thread title on resume (story ${state.storyId}):`, err);
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
        const [turnCountResult] = await connection.execute(
          `SELECT COUNT(*) as turn_number FROM turn t
           JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
           WHERE sw.story_id = ?`,
          [state.storyId]
        );
        const turnNumber = turnCountResult[0].turn_number;
        const formattedEndTime = newTurnEndsAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
        const newTitle = threadTitleTemplate
          .replace('[story_id]', state.storyId)
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
      console.error(`${formattedDate()}: Could not unlock turn thread on resume (story ${state.storyId}):`, err);
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
        console.error(`${formattedDate()}: Could not notify writer on resume (story ${state.storyId}):`, err);
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
      state.summary = sanitizeModalInput(interaction.fields.getTextInputValue('summary'), 2000) ?? '';

    } else if (interaction.customId === 'story_manage_tags_modal') {
      state.tags = sanitizeModalInput(interaction.fields.getTextInputValue('tags'), 500) ?? '';
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await state.originalInteraction.editReply(buildManageMessage(state.cfg, state));
    await interaction.deleteReply();

  } catch (error) {
    console.error(`${formattedDate()}: Error in handleManageModalSubmit:`, error);
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

async function handleClose(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = interaction.options.getInteger('story_id');
  const guildId = interaction.guild.id;

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
    const adminRoleName = await getConfigValue(connection, 'cfgAdminRoleName', guildId);
    const isAdmin = interaction.member.permissions.has('Administrator') ||
      (adminRoleName && interaction.member.roles.cache.some(r => r.name === adminRoleName));

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
    console.error(`${formattedDate()}: Error in handleClose:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleCloseConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_status, story_thread_id, quick_mode FROM story WHERE story_id = ? AND guild_id = ?`,
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
          console.error(`${formattedDate()}: Could not delete turn thread ${activeTurn.thread_id}:`, err);
        }
      }
    }

    // Close the story
    await connection.execute(
      `UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`,
      [storyId]
    );

    // Generate export (story is now marked closed so closed_at will be set in the file)
    const exportResult = await generateStoryExport(connection, storyId, guildId);
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
            .replace('[story_id]', storyId)
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
        console.log(`${formattedDate()}: Story thread not available for close post (story ${storyId})`);
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
    console.error(`${formattedDate()}: Error in handleCloseConfirm:`, error);
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handleCloseCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
}


export default {
  data,
  execute,
  handleModalSubmit,
  handleButtonInteraction,
  handleSelectMenuInteraction
};