import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfigValue, sanitizeModalInput, formattedDate, replaceTemplateVariables } from '../utilities.js';
import { CreateStory, PickNextWriter } from '../storybot.js';
import { postStoryFeedJoinAnnouncement } from '../announcements.js';

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
  );

async function execute(connection, interaction) {
  const subcommand = interaction.options.getSubcommand();
  
  if (subcommand === 'add') {
    await handleAddStory(connection, interaction);
  } else if (subcommand === 'list') {
    await handleListStories(connection, interaction);
  } else if (subcommand === 'write') {
    await handleWrite(connection, interaction);
  } else if (subcommand === 'join') {
    await handleJoin(connection, interaction);
  }
}

async function handleAddStory(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    
    // Create modal
    const modal = new ModalBuilder()
      .setCustomId('story_add_modal')
      .setTitle('Create New Story');

    // Story Title - Required text input
    const storyTitleInput = new TextInputBuilder()
      .setCustomId('story_title')
      .setLabel(await getConfigValue(connection,'lblStoryTitle', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(500);

    // Quick Mode - Select Menu (converted to text input for modal)
    const quickModeInput = new TextInputBuilder()
      .setCustomId('quick_mode')
      .setLabel(await getConfigValue(connection,'lblQuickMode', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('off')
      .setPlaceholder(await getConfigValue(connection,'txtQuickModePlaceholder', guildId));

    // Turn Length - Required text input with default
    const turnLengthInput = new TextInputBuilder()
      .setCustomId('turn_length')
      .setLabel(await getConfigValue(connection,'lblTurnLength', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('24')
      .setPlaceholder(await getConfigValue(connection,'txtTurnLengthPlaceholder', guildId));

    // Timeout Reminder - Select Menu (converted to text input for modal)
    const timeoutReminderInput = new TextInputBuilder()
      .setCustomId('timeout_reminder')
      .setLabel(await getConfigValue(connection,'lblTimeoutReminder', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('50')
      .setPlaceholder(await getConfigValue(connection,'txtTimeoutReminderPlaceholder', guildId));

    // Create second modal for additional fields
    const hideTurnThreadsInput = new TextInputBuilder()
      .setCustomId('hide_turn_threads')
      .setLabel(await getConfigValue(connection,'lblHideTurnThreads', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('off')
      .setPlaceholder(await getConfigValue(connection,'txtHideTurnThreadsPlaceholder', guildId));

    // Add fields to modal (Discord limits to 5 components per modal)
    const row1 = new ActionRowBuilder().addComponents(storyTitleInput);
    const row2 = new ActionRowBuilder().addComponents(quickModeInput);
    const row3 = new ActionRowBuilder().addComponents(turnLengthInput);
    const row4 = new ActionRowBuilder().addComponents(timeoutReminderInput);
    const row5 = new ActionRowBuilder().addComponents(hideTurnThreadsInput);

    modal.addComponents(row1, row2, row3, row4, row5);

    await interaction.showModal(modal);

  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${guildId}] Error creating story modal:`, error);
    await interaction.reply({
      content: await getConfigValue(connection,'txtFormOpenError', guildId),
      ephemeral: true
    });
  }
}

// Handle modal submission
async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'story_add_modal') {
    await handleAddStoryModal(connection, interaction);
  } else if (interaction.customId.startsWith('story_write_')) {
    await handleWriteModalSubmit(connection, interaction);
  } else if (interaction.customId.startsWith('story_join_')) {
    await handleJoinModalSubmit(connection, interaction);
  }
}

// Handle story add modal (renamed for clarity)
async function handleAddStoryModal(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    
    // Get form values and sanitize
    const storyTitle = sanitizeModalInput(interaction.fields.getTextInputValue('story_title'), 500);
    const quickModeRaw = sanitizeModalInput(interaction.fields.getTextInputValue('quick_mode'), 10);
    const turnLengthRaw = sanitizeModalInput(interaction.fields.getTextInputValue('turn_length'), 10);
    const timeoutReminderRaw = sanitizeModalInput(interaction.fields.getTextInputValue('timeout_reminder'), 10);
    const hideTurnThreadsRaw = sanitizeModalInput(interaction.fields.getTextInputValue('hide_turn_threads'), 10);

    // Get error message template
    const txtMustBeNo = await getConfigValue(connection,'txtMustBeNo', guildId);
    const txtValidationErrors = await getConfigValue(connection,'txtValidationErrors', guildId);

    // Validate inputs
    const errors = [];

    // Validate quick mode
    const quickMode = quickModeRaw.toLowerCase();
    if (!['off', 'on'].includes(quickMode)) {
      errors.push(await getConfigValue(connection,'txtQuickModeValidation', guildId));
    }

    // Validate turn length (must be numeric)
    const turnLength = parseInt(turnLengthRaw);
    if (isNaN(turnLength) || turnLength < 1) {
      const lblTurnLength = await getConfigValue(connection,'lblTurnLength', guildId);
      errors.push(replaceTemplateVariables(txtMustBeNo, { 'Field label text': lblTurnLength }));
    }

    // Validate timeout reminder (must be 0, 25, 50, or 75)
    const timeoutReminder = parseInt(timeoutReminderRaw);
    if (![0, 25, 50, 75].includes(timeoutReminder)) {
      errors.push(await getConfigValue(connection,'txtTimeoutReminderValidation', guildId));
    }

    // Validate hide turn threads
    const hideTurnThreads = hideTurnThreadsRaw.toLowerCase();
    if (!['off', 'on'].includes(hideTurnThreads)) {
      errors.push(await getConfigValue(connection,'txtHideTurnThreadsValidation', guildId));
    }

    if (errors.length > 0) {
      await interaction.reply({
        content: `${txtValidationErrors}\n${errors.join('\n')}`,
        ephemeral: true
      });
      return;
    }

    // Show second modal for additional fields
    await showSecondModal(connection, interaction, {
      storyTitle,
      quickMode: quickMode === 'on' ? 1 : 0,
      turnLength,
      timeoutReminder,
      hideTurnThreads: hideTurnThreads === 'on' ? 1 : 0
    });

  } catch (error) {
    const guildId = interaction.guild.id;
    console.error(`${formattedDate()}: [Guild ${guildId}] Error processing story modal:`, error);
    await interaction.reply({
      content: await getConfigValue(connection,'txtFormProcessError', guildId),
      ephemeral: true
    });
  }
}

// Second modal for delay and writer options
async function showSecondModal(connection, interaction, storyData) {
  try {
    const guildId = interaction.guild.id;
    
    const secondModal = new ModalBuilder()
      .setCustomId(`story_add_modal_2_${JSON.stringify(storyData)}`)
      .setTitle('Story Settings & Writer Info');

    // Delay hours input
    const delayHoursInput = new TextInputBuilder()
      .setCustomId('delay_hours')
      .setLabel(await getConfigValue(connection,'lblNoHours', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(await getConfigValue(connection,'txtDelayHoursPlaceholder', guildId));

    // Delay writers input  
    const delayWritersInput = new TextInputBuilder()
      .setCustomId('delay_writers')
      .setLabel(await getConfigValue(connection,'lblNoWriters', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(await getConfigValue(connection,'txtDelayWritersPlaceholder', guildId));

    // AO3 name input
    const ao3NameInput = new TextInputBuilder()
      .setCustomId('ao3_name')
      .setLabel(await getConfigValue(connection,'lblYourAO3Name', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(await getConfigValue(connection,'txtAO3NamePlaceholder', guildId));

    // Private threads input
    const keepPrivateInput = new TextInputBuilder()
      .setCustomId('keep_private')
      .setLabel(await getConfigValue(connection,'lblKeepYourPrivate', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('no')
      .setPlaceholder(await getConfigValue(connection,'txtKeepPrivatePlaceholder', guildId));

    // Add to modal
    const row1 = new ActionRowBuilder().addComponents(delayHoursInput);
    const row2 = new ActionRowBuilder().addComponents(delayWritersInput);
    const row3 = new ActionRowBuilder().addComponents(ao3NameInput);
    const row4 = new ActionRowBuilder().addComponents(keepPrivateInput);

    secondModal.addComponents(row1, row2, row3, row4);

    await interaction.showModal(secondModal);

  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${guildId}] Error showing second modal:`, error);
    await interaction.followUp({
      content: await getConfigValue(connection,'txtAdditionalOptionsError', guildId),
      ephemeral: true
    });
  }
}

// Handle second modal submission
async function handleSecondModalSubmit(connection, interaction) {
  if (!interaction.customId.startsWith('story_add_modal_2_')) return;

  try {
    // Extract first modal data from customId
    const firstModalData = JSON.parse(interaction.customId.replace('story_add_modal_2_', ''));
    const guildId = interaction.guild.id;

    // Get second modal values
    const delayHoursRaw = sanitizeModalInput(interaction.fields.getTextInputValue('delay_hours') || '0', 10);
    const delayWritersRaw = sanitizeModalInput(interaction.fields.getTextInputValue('delay_writers') || '0', 10);
    const ao3Name = sanitizeModalInput(interaction.fields.getTextInputValue('ao3_name'), 255);
    const keepPrivateRaw = sanitizeModalInput(interaction.fields.getTextInputValue('keep_private'), 10);

    // Get error message
    const txtMustBeNo = await getConfigValue(connection,'txtMustBeNo', guildId);
    const txtValidationErrors = await getConfigValue(connection,'txtValidationErrors', guildId);

    // Validate second modal inputs
    const errors = [];

    // Validate delay hours
    const delayHours = parseInt(delayHoursRaw) || 0;
    if (delayHoursRaw && (isNaN(delayHours) || delayHours < 0)) {
      const lblNoHours = await getConfigValue(connection,'lblNoHours', guildId);
      errors.push(replaceTemplateVariables(txtMustBeNo, { 'Field label text': lblNoHours }));
    }

    // Validate delay writers
    const delayWriters = parseInt(delayWritersRaw) || 0;
    if (delayWritersRaw && (isNaN(delayWriters) || delayWriters < 0)) {
      const lblNoWriters = await getConfigValue(connection,'lblNoWriters', guildId);
      errors.push(replaceTemplateVariables(txtMustBeNo, { 'Field label text': lblNoWriters }));
    }

    // Validate keep private
    const keepPrivate = keepPrivateRaw.toLowerCase();
    if (!['yes', 'no'].includes(keepPrivate)) {
      errors.push(await getConfigValue(connection,'txtPrivacyValidation', guildId));
    }

    if (errors.length > 0) {
      await interaction.reply({
        content: `${txtValidationErrors}\n${errors.join('\n')}`,
        ephemeral: true
      });
      return;
    }

    // Acknowledge the interaction
    await interaction.deferReply({ ephemeral: true });

    // Combine all data
    const storyInput = {
      ...firstModalData,
      delayHours: delayHours || null,
      delayWriters: delayWriters || null,
      ao3Name: ao3Name || null,
      keepPrivate: keepPrivate === 'yes' ? 1 : 0
    };

    // Pass to CreateStory function
    const result = await CreateStory(connection, interaction, storyInput);

    if (result.success) {
      await interaction.editReply({
        content: result.message
      });
    } else {
      await interaction.editReply({
        content: result.error
      });
    }

  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${guildId}] Error processing second story modal:`, error);
    await interaction.editReply({
      content: await getConfigValue(connection,'txtStoryCreationError', guildId)
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
        ephemeral: true 
      });
      return;
    }
    
    // Validate join eligibility
    const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
    if (!joinInfo.success) {
      await interaction.reply({ 
        content: joinInfo.error, 
        ephemeral: true 
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

    // AO3 name input
    const ao3NameInput = new TextInputBuilder()
      .setCustomId('ao3_name')
      .setLabel(await getConfigValue(connection,'lblJoinAO3Name', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(await getConfigValue(connection,'txtJoinAO3Placeholder', guildId))
      .setMaxLength(255);
      
    if (existingAO3Name) {
      ao3NameInput.setValue(existingAO3Name);
    }

    // Privacy input
    const privacyInput = new TextInputBuilder()
      .setCustomId('turn_privacy')
      .setLabel(await getConfigValue(connection,'lblJoinPrivacy', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('public')
      .setPlaceholder(await getConfigValue(connection,'txtJoinPrivacyPlaceholder', guildId));

    // Notification preference input
    const notificationInput = new TextInputBuilder()
      .setCustomId('notification_prefs')
      .setLabel(await getConfigValue(connection,'lblJoinNotifications', guildId))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('dm')
      .setPlaceholder(await getConfigValue(connection,'txtJoinNotificationPlaceholder', guildId));

    // Add to modal
    const row1 = new ActionRowBuilder().addComponents(ao3NameInput);
    const row2 = new ActionRowBuilder().addComponents(privacyInput);
    const row3 = new ActionRowBuilder().addComponents(notificationInput);

    modal.addComponents(row1, row2, row3);

    await interaction.showModal(modal);

  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in handleJoin:`, error);
    await interaction.reply({
      content: await getConfigValue(connection,'txtJoinFormFailed', interaction.guild.id),
      ephemeral: true
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
    
    await interaction.deferReply({ ephemeral: true });
    
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
    try {
      await connection.beginTransaction();
      
      const result = await StoryJoin(connection, interaction, joinInput, parseInt(storyId));
      
      if (result.success) {
        await connection.commit();
        
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
        
      } else {
        await connection.rollback();
        await interaction.editReply({
          content: result.error
        });
      }
      
    } catch (error) {
      await connection.rollback();
      throw error;
//    } finally {
//      connection.release();
    }
    
  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in handleJoinModalSubmit:`, error);
    await interaction.editReply({
      content: await getConfigValue(connection,'txtJoinProcessFailed', interaction.guild.id)
    });
  }
}

/**
 * Handle /story write command
 */
async function handleWrite(interaction) {
  try {
    const guildId = interaction.guild.id;
    const storyId = interaction.options.getInteger('story_id');
    
    // Validate story access and get story info
    const storyInfo = await validateStoryAccess(connection, storyId, guildId);
    if (!storyInfo.success) {
      await interaction.reply({ 
        content: storyInfo.error, 
        ephemeral: true 
      });
      return;
    }
    
    // Validate active writer
    const writerInfo = await validateActiveWriter(connection, interaction.user.id, storyId);
    if (!writerInfo.success) {
      await interaction.reply({ 
        content: writerInfo.error, 
        ephemeral: true 
      });
      return;
    }
    
    // Check if story is quick mode
    if (!storyInfo.story.quick_mode) {
      await interaction.reply({ 
        content: await getConfigValue(connection,'txtNormalModeWrite', guildId), 
        ephemeral: true 
      });
      return;
    }
    
    // Get configurable text for warnings (used multiple times)
    const txtWriteWarning = await getConfigValue(connection,'txtWriteWarning', guildId);
    
    // Create modal
    const modal = new ModalBuilder()
      .setCustomId(`story_write_${storyId}`)
      .setTitle(`✍️ ${storyInfo.story.title}`);

    const entryInput = new TextInputBuilder()
      .setCustomId('entry_content')
      .setLabel(await getConfigValue(connection,'lblWriteEntry', guildId))
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder(`⚠️ ${txtWriteWarning}\n\n${await getConfigValue(connection,'txtWritePlaceholder', guildId)}`)
      .setMaxLength(4000)
      .setMinLength(10)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(entryInput);
    modal.addComponents(row);

    await interaction.showModal(modal);

  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in handleWrite:`, error);
    await interaction.reply({
      content: await getConfigValue(connection,'txtWriteFormFailed', interaction.guild.id),
      ephemeral: true
    });
  }
}

/**
 * Handle write modal submission
 */
async function handleWriteModalSubmit(connection, interaction) {
    const guildId = interaction.guild.id;
    const storyId = interaction.customId.split('_')[2];
    const content = sanitizeModalInput(interaction.fields.getTextInputValue('entry_content'), 4000);
    
    await interaction.deferReply({ ephemeral: true });
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
    
    // Send DM reminder
    try {
      const user = await interaction.client.users.fetch(interaction.user.id);
      await user.send(`${await getConfigValue(connection,'txtDMReminder', guildId)}\n\n${await getConfigValue(connection,'txtRecoveryInstructions', guildId)}\n\n⏰ Expires: ${discordTimestamp}`);
    } catch (error) {
      console.log(`${formattedDate()}: [Guild ${guildId}] Could not send DM reminder to user ${interaction.user.id}`);
    }

  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in handleWriteModalSubmit:`, error);
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
    console.error(`${formattedDate()}: [Guild ${guildId}] Error in validateStoryAccess:`, error);
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
    console.error(`${formattedDate()}: [Guild ${guildId}] Error in validateActiveWriter:`, error);
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
    if (story.story_status === 1 && !story.allow_late_joins) {
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
      return { success: false, error: await getConfigValue(connection,'txtAlreadyJoined', guildId) };
    }
    
    return { success: true, story };
    
  } finally {
    connection.release();
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
    .setFooter({ text: replaceTemplateVariables(await getConfigValue(connection,'txtPreviewExpires', guildId), { timestamp: discordTimestamp }) });
    
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
async function handleListStories(connection, interaction) {
  try {
    const guildId = interaction.guild.id;
    const filter = interaction.options.getString('filter') || 'all';
    const page = interaction.options.getInteger('page') || 1;
    const itemsPerPage = 5;

    await interaction.deferReply({ ephemeral: true });

    const stories = await getStoriesPaginated(guildId, filter, page, itemsPerPage, interaction.user.id);

    if (stories.data.length === 0) {
      const txtNoStoriesFound = await getConfigValue(connection,'txtNoStoriesFound', guildId);
      const filterTitle = await getFilterTitle(filter, guildId);
      await interaction.editReply({
        content: replaceTemplateVariables(txtNoStoriesFound, { filter_name: filterTitle })
      });
      return;
    }

    // Get configurable text for embed
    const filterTitle = await getFilterTitle(filter, guildId);
    
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
      const joinStatus = story.can_join 
        ? await getConfigValue(connection,'txtCanJoin', guildId)
        : await getConfigValue(connection,'txtCannotJoin', guildId);
      const currentTurn = await getCurrentTurnInfo(story, guildId);
      
      // Get configurable labels
      const lblStoryStatus = await getConfigValue(connection,'lblStoryStatus', guildId);
      const lblStoryTurn = await getConfigValue(connection,'lblStoryTurn', guildId);
      const lblStoryWriters = await getConfigValue(connection,'lblStoryWriters', guildId);
      const lblStoryMode = await getConfigValue(connection,'lblStoryMode', guildId);
      const lblStoryCreator = await getConfigValue(connection,'lblStoryCreator', guildId);
      const modeText = story.quick_mode 
        ? await getConfigValue(connection,'txtModeQuick', guildId)
        : await getConfigValue(connection,'txtModeNormal', guildId);
      
      embed.addFields({
        name: `${statusIcon} "${story.title}" (#${story.story_id})`,
        value: `├ ${lblStoryStatus} ${getStatusText(story.story_status, guildId)} • ${lblStoryTurn} ${currentTurn}
                ├ ${lblStoryWriters} ${story.writer_count}/${story.max_writers || '∞'} • ${lblStoryMode} ${modeText}
                └ ${lblStoryCreator} <@${story.creator_id}> • ${joinStatus}`,
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
    const joinableStories = stories.data.filter(s => s.can_join);
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
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in handleListStories:`, error);
    await interaction.editReply({
      content: await getConfigValue(connection,'txtStoryListFailed', interaction.guild.id),
    });
  }
}

/**
 * Handle button interactions for story list
 */
async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('story_list_')) {
    await handleListNavigationconnection, (interaction);
  } else if (interaction.customId.startsWith('confirm_entry_') || interaction.customId.startsWith('discard_entry_')) {
    await handleEntryConfirmation(connection, interaction);
  } else if (interaction.customId.startsWith('finalize_entry_')) {
    await handleFinalizeEntry(connection, interaction);
  } else if (interaction.customId.startsWith('skip_turn_')) {
    await handleSkipTurn(connection, interaction);
  }
}

/**
 * Handle list navigation buttons
 */
async function handleListNavigation(connection, interaction) {
  const [, , filter, pageStr] = interaction.customId.split('_');
  const page = parseInt(pageStr);
  
  // Update the message with new page
  const guildId = interaction.guild.id;
  const itemsPerPage = 5;
  
  await interaction.deferUpdate();
  
  const stories = await getStoriesPaginated(guildId, filter, page, itemsPerPage, interaction.user.id);
  
  // Get configurable text for embed
  const txtStoriesPageTitle = await getConfigValue(connection,'txtStoriesPageTitle', guildId);
  const txtStoriesPageDesc = await getConfigValue(connection,'txtStoriesPageDesc', guildId);
  const filterTitle = await getFilterTitle(filter, guildId);
  
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
    const joinStatus = story.can_join 
      ? await getConfigValue(connection,'txtCanJoin', guildId)
      : await getConfigValue(connection,'txtCannotJoin', guildId);
    const currentTurn = await getCurrentTurnInfo(story, guildId);
    
    // Get configurable labels
    const lblStoryStatus = await getConfigValue(connection,'lblStoryStatus', guildId);
    const lblStoryTurn = await getConfigValue(connection,'lblStoryTurn', guildId);
    const lblStoryWriters = await getConfigValue(connection,'lblStoryWriters', guildId);
    const lblStoryMode = await getConfigValue(connection,'lblStoryMode', guildId);
    const lblStoryCreator = await getConfigValue(connection,'lblStoryCreator', guildId);
    const modeText = story.quick_mode 
      ? await getConfigValue(connection,'txtModeQuick', guildId)
      : await getConfigValue(connection,'txtModeNormal', guildId);
    
    embed.addFields({
      name: `${statusIcon} "${story.title}" (#${story.story_id})`,
      value: `├ ${lblStoryStatus} ${await getStatusText(story.story_status, guildId)} • ${lblStoryTurn} ${currentTurn}
              ├ ${lblStoryWriters} ${story.writer_count}/${story.max_writers || '∞'} • ${lblStoryMode} ${modeText}
              └ ${lblStoryCreator} <@${story.creator_id}> • ${joinStatus}`,
      inline: false
    });
  }

  // Update navigation buttons
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
  }
  
  const btnFilter = await getConfigValue(connection,'btnFilter', guildId);
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('story_filter')
      .setLabel(btnFilter)
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    embeds: [embed],
    components: [navRow]
  });
}

/**
 * Handle entry confirmation/discard
 */
async function handleEntryConfirmation(interaction) {
  const [action, , entryId] = interaction.customId.split('_');
  
  try {
    await interaction.deferUpdate();
    
    if (action === 'confirm') {
      await confirmEntry(entryId, interaction);
    } else if (action === 'discard') {
      await discardEntry(entryId, interaction);
    }
    
  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in handleEntryConfirmation:`, error);
    await interaction.editReply({
      content: await getConfigValue(connection,'txtActionFailed', interaction.guild.id),
      components: []
    });
  }
}

/**
 * Confirm and finalize entry
 */
async function confirmEntry(entryId, interaction) {
  const connection = await getDBConnection();
  
  try {
    await connection.beginTransaction();
    
    // Update entry status to confirmed
    await connection.execute(`
      UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?
    `, [entryId]);
    
    // Get story info for turn advancement
    const [entryInfo] = await connection.execute(`
      SELECT se.turn_id, sw.story_id, sw.discord_user_id
      FROM story_entry se
      JOIN turn t ON se.turn_id = t.turn_id  
      JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
      WHERE se.story_entry_id = ?
    `, [entryId]);
    
    if (entryInfo.length === 0) {
      throw new Error(`${formattedDate()}: [Guild ${interaction.guild.id}] Entry not found for ID ${entryId}`);
    }
    
    const { turn_id, story_id } = entryInfo[0];
    
    // End current turn
    await connection.execute(`
      UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?
    `, [turn_id]);
    
    // Advance to next writer
    const nextWriterId = await PickNextWriter(connection, story_id);
    await NextTurn(connection, interaction, nextWriterId);
    
    await connection.commit();
    
    await interaction.editReply({
      content: await getConfigValue(connection,'txtEntrySubmitted', interaction.guild.id),
      embeds: [],
      components: []
    });
    
  } catch (error) {
    await connection.rollback();
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in confirmEntry:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Discard pending entry
 */
async function discardEntry(entryId, interaction) {
  const connection = await getDBConnection();
  
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
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Error in discardEntry:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Handle select menu interactions
 */
async function handleSelectMenuInteraction(interaction) {
  if (interaction.customId === 'story_quick_join') {
    const storyId = interaction.values[0];
    
    // Create a synthetic interaction for the join handler
    const syntheticOptions = {
      getInteger: (name) => name === 'story_id' ? parseInt(storyId) : null
    };
    
    const syntheticInteraction = {
      ...interaction,
      options: syntheticOptions
    };
    
    // Call the join handler
    await handleJoin(syntheticInteraction);
  }
}

/**
 * Get paginated stories from database
 */
async function getStoriesPaginated(guildId, filter, page, itemsPerPage, userId) {
  const connection = await getDBConnection();
  
  try {
    let whereClause = 'WHERE s.guild_id = ?';
    let params = [guildId];
    
    // Apply filters
    switch (filter) {
      case 'joinable':
        whereClause += ' AND s.story_status IN (1, 2) AND s.allow_late_joins = 1 AND (s.max_writers IS NULL OR writer_count < s.max_writers)';
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
        whereClause += ' AND s.story_status IN (1, 2)';
        break;
    }
    
    // Get total count
    const [countResult] = await connection.execute(`
      SELECT COUNT(*) as total FROM (
        SELECT s.story_id 
        FROM story s
        LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = 1
        GROUP BY s.story_id
        ${whereClause}
      ) as filtered_stories
    `, params);
    
    const totalCount = countResult[0].total;
    const totalPages = Math.ceil(totalCount / itemsPerPage);
    const offset = (page - 1) * itemsPerPage;
    
    // Get paginated results
    const [stories] = await connection.execute(`
      SELECT 
        s.*,
        COUNT(sw.story_writer_id) as writer_count,
        (SELECT discord_user_id FROM story_writer WHERE story_id = s.story_id ORDER BY joined_at ASC LIMIT 1) as creator_id,
        CASE 
          WHEN s.story_status IN (1, 2) 
           AND s.allow_late_joins = 1 
           AND (s.max_writers IS NULL OR COUNT(sw.story_writer_id) < s.max_writers)
           AND s.story_id NOT IN (SELECT DISTINCT story_id FROM story_writer WHERE discord_user_id = ? AND sw_status = 1)
          THEN 1 
          ELSE 0 
        END as can_join
      FROM story s
      LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = 1
      GROUP BY s.story_id
      ${whereClause}
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `, [...params, userId, itemsPerPage, offset]);
    
    return {
      data: stories,
      totalCount,
      totalPages,
      currentPage: page
    };
    
  } finally {
    connection.release();
  }
}

/**
 * Helper functions for story display
 */
async function getFilterTitle(filter, guildId) {
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

async function getStatusText(status, guildId) {
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

async function getCurrentTurnInfo(story, guildId) {
  if (story.story_status === 2) return await getConfigValue(connection,'txtPaused', guildId);
  if (story.story_status === 3) return await getConfigValue(connection,'txtClosed', guildId);
  
  // For active stories, get current turn info
  const connection = await getDBConnection();
  
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
    connection.release();
  }
}

/**
 * Handle finalize entry button click
 */
async function handleFinalizeEntry(connection,interaction) {
  const storyId = interaction.customId.split('_')[2];
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // Verify this is the current writer's turn
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );
    
    if (turnInfo.length === 0) {
      const txtNoActiveTurn = await getConfigValue(connection,'txtNoActiveTurn', interaction.guild.id);
      await interaction.editReply({ content: txtNoActiveTurn });
      return;
    }
    
    const turn = turnInfo[0];
    
    // Check if there are any messages in the thread (excluding the welcome message)
    const thread = await interaction.guild.channels.fetch(turn.thread_id);
    const messages = await thread.messages.fetch({ limit: 50 });
    
    // Filter out bot messages and find user content
    const userMessages = messages.filter(msg => 
      msg.author.id === interaction.user.id && 
      !msg.interaction // Exclude command responses
    );
    
    if (userMessages.size === 0) {
      const txtEmptyEntry = await getConfigValue(connection,'txtEmptyEntry', interaction.guild.id);
      await interaction.editReply({ content: txtEmptyEntry });
      return;
    }
    
    // Collect all user messages as the entry content
    const entryContent = userMessages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(msg => msg.content)
      .join('\n\n');
    
    // Create the story entry
    await connection.execute(
      `INSERT INTO story_entry (turn_id, content, created_at) VALUES (?, ?, NOW())`,
      [turn.turn_id, entryContent]
    );
    
    // Mark turn as completed
    await connection.execute(
      `UPDATE turn SET turn_status = 2, completed_at = NOW() WHERE turn_id = ?`,
      [turn.turn_id]
    );
    
    // Archive the thread (lock it)
    await thread.setLocked(true);
    
    // Advance to next writer
    const nextWriterId = await PickNextWriter(connection, story_id);
    await NextTurn(connection, interaction, nextWriterId);  

    const txtEntryFinalized = await getConfigValue(connection,'txtEntryFinalized', interaction.guild.id);
    await interaction.editReply({ content: txtEntryFinalized });
    
  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Finalize entry failed:`, error);
    const txtFailedtoFinalize = await getConfigValue(connection,'txtEntryFinalized', interaction.guild.id);
    await interaction.editReply({ content: txtFailedtoFinalize });
  }
}

/**
 * Handle skip turn button click
 */
async function handleSkipTurn(connection, interaction) {
  const storyId = interaction.customId.split('_')[2];
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // Verify this is the current writer's turn
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );
    
    if (turnInfo.length === 0) {
      await interaction.editReply({ content: 'You do not have an active turn in this story.' });
      return;
    }
    
    const turn = turnInfo[0];
    
    // Mark turn as skipped
    await connection.execute(
      `UPDATE turn SET turn_status = 3, completed_at = NOW() WHERE turn_id = ?`,
      [turn.turn_id]
    );
    
    // Archive the thread (lock it)
    const thread = await interaction.guild.channels.fetch(turn.thread_id);
    await thread.setLocked(true);
    
    // Advance to next writer
    const nextWriterId = await PickNextWriter(connection, storyId);
    await NextTurn(connection, interaction, nextWriterId);
    
    await interaction.editReply({ content: '⏭️ Turn skipped successfully! Moving to the next writer.' });
    
  } catch (error) {
    console.error(`${formattedDate()}: [Guild ${interaction.guild.id}] Skip turn failed:`, error);
    await interaction.editReply({ content: 'Failed to skip turn. Please try again.' });
  }
}

async function getDBConnection() {
  const { DB } = await import('../utilities.js');
  const config = await import('../config.json', { assert: { type: 'json' } });
  const db = new DB(config.default.db);
  await db.connect();
  return db.connection;
}

export default {
  data,
  execute,
  handleModalSubmit,
  handleSecondModalSubmit,
  handleButtonInteraction,
  handleSelectMenuInteraction
};