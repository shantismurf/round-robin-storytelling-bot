import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId, checkIsAdmin } from '../utilities.js';
import { handleManage } from '../story/manage.js';
import { PickNextWriter, NextTurn, skipActiveTurn, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';
import { cancelPendingRoundupJobs, scheduleNextRoundup } from '../story/roundup.js';

async function logAdminAction(connection, adminUserId, actionType, storyId, targetUserId = null, reason = null) {
  try {
    await connection.execute(
      `INSERT INTO admin_action_log (admin_user_id, action_type, target_story_id, target_user_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [adminUserId, actionType, storyId ?? null, targetUserId ?? null, reason ?? null]
    );
  } catch (err) {
    log(`Failed to log admin action: ${err}`, { show: true });
  }
}

// Pending confirmation data keyed by admin user ID
const pendingManageUserData = new Map();
const pendingSetupData = new Map();

const data = new SlashCommandBuilder()
  .setName('storyadmin')
  .setDescription('Admin tools for story management')
  .addSubcommand(s =>
    s.setName('skip')
      .setDescription('Force-skip the current writer\'s turn and advance to the next writer')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('extend')
      .setDescription('Add hours to the current turn deadline')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addIntegerOption(o =>
        o.setName('hours').setDescription('Hours to add').setRequired(true).setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName('manage')
      .setDescription('Manage story settings, or a specific writer\'s settings')
      .addStringOption(o =>
        o.setName('story_id').setDescription('Story to manage').setRequired(true).setAutocomplete(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to manage (leave blank to manage story settings)').setRequired(false))
  )
  .addSubcommand(s =>
    s.setName('next')
      .setDescription('Designate which writer will get the next turn')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to designate as next').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('deleteentry')
      .setDescription('Soft-delete a specific story entry (hidden from read/export, restorable)')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addIntegerOption(o =>
        o.setName('turn').setDescription('Turn number (as shown in /story read)').setRequired(true).setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName('restoreentry')
      .setDescription('Restore a previously deleted story entry')
      .addIntegerOption(o =>
        o.setName('entry_id').setDescription('Entry ID (shown when entry was deleted)').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('delete')
      .setDescription('Permanently delete a story and all its data')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('reassign')
      .setDescription('Give the previous writer another turn, then resume with the current writer')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Show all admin commands and what they do')
  )
  .addSubcommand(s =>
    s.setName('setup')
      .setDescription('Configure Round Robin StoryBot for this server')
  );

async function execute(connection, interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'help')  return await handleHelp(connection, interaction, guildId);
  if (subcommand === 'setup') return await handleSetup(connection, interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!await checkIsAdmin(connection, interaction, guildId)) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtAdminOnly', guildId),
    });
  }
  if (subcommand === 'manage')          await handleAdminManage(connection, interaction);
  else if (subcommand === 'skip')       await handleSkip(connection, interaction);
  else if (subcommand === 'reassign')   await handleReassign(connection, interaction);
  else if (subcommand === 'extend')     await handleExtend(connection, interaction);
  else if (subcommand === 'next')       await handleNext(connection, interaction);
  else if (subcommand === 'deleteentry')  await handleDeleteEntry(connection, interaction);
  else if (subcommand === 'restoreentry') await handleRestoreEntry(connection, interaction);
  else if (subcommand === 'delete')     await handleDelete(connection, interaction);
}

// ---------------------------------------------------------------------------
// /storyadmin help
// ---------------------------------------------------------------------------
async function handleHelp(connection, interaction, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtAdminHelpTitle', 'txtAdminHelpFooter',
    'lblAdminHelpSkip', 'txtAdminHelpSkip',
    'lblAdminHelpExtend', 'txtAdminHelpExtend',
    'lblAdminHelpManageUser', 'txtAdminHelpManageUser',
    'lblAdminHelpNext', 'txtAdminHelpNext',
    'lblAdminHelpReassign', 'txtAdminHelpReassign',
    'lblAdminHelpDelete', 'txtAdminHelpDelete',
    'lblAdminHelpSetup', 'txtAdminHelpSetup'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtAdminHelpTitle)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblAdminHelpSkip,        value: cfg.txtAdminHelpSkip,        inline: false },
      { name: cfg.lblAdminHelpExtend,      value: cfg.txtAdminHelpExtend,      inline: false },
      { name: cfg.lblAdminHelpManageUser,  value: cfg.txtAdminHelpManageUser,  inline: false },
      { name: cfg.lblAdminHelpNext,        value: cfg.txtAdminHelpNext,        inline: false },
      { name: cfg.lblAdminHelpReassign,    value: cfg.txtAdminHelpReassign,    inline: false },
      { name: cfg.lblAdminHelpDelete,      value: cfg.txtAdminHelpDelete,      inline: false },
      { name: cfg.lblAdminHelpSetup,       value: cfg.txtAdminHelpSetup,       inline: false }
    )
    .setFooter({ text: cfg.txtAdminHelpFooter });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// /storyadmin setup — embed control panel
// ---------------------------------------------------------------------------

function buildSetupPanel(state, cfg) {
  log(`storyadmin setup: buildSetupPanel started`, { show: false, guildName: 'system' });
  const fieldVal = (id, fallback = 'Not set') => id ? `<#${id}>` : `\`${fallback}\``;
  const strVal   = (v,  fallback = 'Not set') => v  ? `\`${v}\``  : `\`${fallback}\``;
  const desc     = (key) => `*${cfg[key]}*\n`;

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtSetupPanelTitle)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.txtSetupModalTitleFeed,           value: desc('txtSetupEmbedDescFeed')            + fieldVal(state.feedChannelId),                   inline: true },
      { name: cfg.txtSetupModalTitleMedia,          value: desc('txtSetupEmbedDescMedia')           + fieldVal(state.mediaChannelId),                  inline: true },
      { name: cfg.txtSetupModalTitleRole,           value: desc('txtSetupEmbedDescAdminRole')       + strVal(state.adminRoleName),                     inline: false },
      { name: cfg.txtSetupModalTitleRestrictedFeed, value: desc('txtSetupEmbedDescRestrictedFeed')  + fieldVal(state.restrictedFeedChannelId),         inline: true },
      { name: cfg.txtSetupModalTitleRestrictedMedia,value: desc('txtSetupEmbedDescRestrictedMedia') + fieldVal(state.restrictedMediaChannelId),        inline: true },
      { name: cfg.txtSetupModalTitleRoundupChannel, value: desc('txtSetupEmbedDescRoundupChannel')  + fieldVal(state.roundupChannelId, 'Disabled'),    inline: false },
      { name: cfg.txtSetupModalTitleRoundupDay,     value: desc('txtSetupEmbedDescRoundupDay')      + strVal(state.roundupDay),                        inline: true  },
      { name: cfg.txtSetupModalTitleRoundupHour,    value: desc('txtSetupEmbedDescRoundupHour')     + strVal(state.roundupHour),                       inline: true  },
      { name: '\u200b',                             value: cfg.txtSetupModalSaveWarning,                                                               inline: false }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_feed').setLabel(cfg.btnSetupFeed).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('storyadmin_setup_media').setLabel(cfg.btnSetupMedia).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('storyadmin_setup_role').setLabel(cfg.btnSetupRole).setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_restricted_feed').setLabel(cfg.btnSetupRestrictedFeed).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('storyadmin_setup_restricted_media').setLabel(cfg.btnSetupRestrictedMedia).setStyle(ButtonStyle.Primary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_roundup_channel').setLabel(cfg.btnSetupRoundupChannel).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('storyadmin_setup_roundup_day').setLabel(cfg.btnSetupRoundupDay).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('storyadmin_setup_roundup_hour').setLabel(cfg.btnSetupRoundupHour).setStyle(ButtonStyle.Primary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_save').setLabel(cfg.btnSetupSave).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('storyadmin_setup_cancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4] };
}

async function handleSetup(connection, interaction) {
  log(`storyadmin setup: handleSetup started`, { show: false, guildName: interaction.guild.name });
  if (!interaction.member.permissions.has('ManageGuild')) {
    log(`storyadmin setup: handleSetup error, user does not have Manage Guild`, { show: false, guildName: interaction.guild.name });
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtSetupNoPermission', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  const cfg = await getConfigValue(connection, [
    'txtSetupPanelTitle',
    'txtSetupModalTitleFeed', 'txtSetupModalTitleMedia', 'txtSetupModalTitleRole',
    'txtSetupModalTitleRestrictedFeed', 'txtSetupModalTitleRestrictedMedia',
    'txtSetupModalTitleRoundupChannel', 'txtSetupModalTitleRoundupDay', 'txtSetupModalTitleRoundupHour',
    'txtSetupModalSaveWarning',
    'txtSetupEmbedDescFeed', 'txtSetupEmbedDescMedia', 'txtSetupEmbedDescAdminRole',
    'txtSetupEmbedDescRestrictedFeed', 'txtSetupEmbedDescRestrictedMedia',
    'txtSetupEmbedDescRoundupChannel', 'txtSetupEmbedDescRoundupDay', 'txtSetupEmbedDescRoundupHour',
    'btnSetupFeed', 'btnSetupMedia', 'btnSetupRole',
    'btnSetupRestrictedFeed', 'btnSetupRestrictedMedia',
    'btnSetupRoundupChannel', 'btnSetupRoundupDay', 'btnSetupRoundupHour',
    'btnSetupSave', 'btnCancel',
    'txtSetupRoundupDayInvalid', 'txtSetupRoundupHourInvalid',
  ], guildId);

  // Load current guild-specific config values without falling back to guild_id=1
  const [cfgRows] = await connection.execute(
    `SELECT config_key, config_value FROM config
     WHERE guild_id = ? AND config_key IN (
       'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName',
       'cfgRestrictedFeedChannelId', 'cfgRestrictedMediaChannelId',
       'cfgWeeklyRoundupChannelId', 'cfgWeeklyRoundupDay', 'cfgWeeklyRoundupHour'
     )`,
    [guildId]
  );
  const guildCfg = Object.fromEntries(cfgRows.map(r => [r.config_key, r.config_value]));
  log(`storyadmin setup: config values retrieved from system and user data`, { show: false, guildName: interaction.guild.name });
  const state = {
    guildId,
    feedChannelId:            guildCfg.cfgStoryFeedChannelId    || '',
    mediaChannelId:           guildCfg.cfgMediaChannelId         || '',
    adminRoleName:            guildCfg.cfgAdminRoleName          || '',
    restrictedFeedChannelId:  guildCfg.cfgRestrictedFeedChannelId  || '',
    restrictedMediaChannelId: guildCfg.cfgRestrictedMediaChannelId || '',
    roundupChannelId:         guildCfg.cfgWeeklyRoundupChannelId || '',
    roundupDay:               guildCfg.cfgWeeklyRoundupDay       || '',
    roundupHour:              guildCfg.cfgWeeklyRoundupHour      || '',
    originalInteraction: interaction,
    cfg,
  };

  pendingSetupData.set(interaction.user.id, state);
  log(`handleSetup: begin opening panel for ${interaction.user.tag} in guild ${guildId}`, { show: true, guildName: interaction.guild.name });
  const panel = buildSetupPanel(state, cfg);
  log(`handleSetup: finished opening panel for ${interaction.user.tag} in guild ${guildId}`, { show: true, guildName: interaction.guild.name });
  await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
}

function buildSetupFieldModal(customId, title, fieldLabel, placeholder, currentValue) {
  // Guard against key-name fallbacks reaching Discord's string validators
  log(`storyadmin setup: buildSetupFieldModal`, { show: false, guildName: 'system' });
  const safeTitle = (title && !title.startsWith('txt')) ? title : 'Setup';
  const safeLabel = (fieldLabel && !fieldLabel.startsWith('lbl')) ? fieldLabel : 'Value';
  const safePlaceholder = (placeholder && !placeholder.startsWith('txt') && placeholder.length <= 100) ? placeholder : '';
  const modal = new ModalBuilder().setCustomId(customId).setTitle(safeTitle);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel(safeLabel)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(safePlaceholder)
        .setValue(currentValue ?? '')
        .setRequired(false)
    )
  );
  return modal;
}

async function handleSetupButton(connection, interaction) {
  log(`storyadmin setup: handleSetupButton`, { show: false, guildName: interaction.guild.name });
  const state = pendingSetupData.get(interaction.user.id);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const cfg = state.cfg;
  const id = interaction.customId;
  log(`handleSetupButton: ${id} by ${interaction.user.tag} in guild ${state.guildId}`, { show: false, guildName: interaction.guild.name });

  if (id === 'storyadmin_setup_feed') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_feed_modal', cfg.txtSetupModalTitleFeed,
      cfg.lblSetupModalFieldFeed, cfg.txtSetupModalPlaceholderFeed, state.feedChannelId
    ));
  }
  if (id === 'storyadmin_setup_media') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_media_modal', cfg.txtSetupModalTitleMedia,
      cfg.lblSetupModalFieldMedia, cfg.txtSetupModalPlaceholderMedia, state.mediaChannelId
    ));
  }
  if (id === 'storyadmin_setup_role') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_role_modal', cfg.txtSetupModalTitleRole,
      cfg.lblSetupModalFieldRole, cfg.txtSetupModalPlaceholderRole, state.adminRoleName
    ));
  }
  if (id === 'storyadmin_setup_restricted_feed') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_restricted_feed_modal', cfg.txtSetupModalTitleRestrictedFeed,
      cfg.lblSetupModalFieldRestrictedFeed, cfg.txtSetupModalPlaceholderRestrictedFeed, state.restrictedFeedChannelId
    ));
  }
  if (id === 'storyadmin_setup_restricted_media') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_restricted_media_modal', cfg.txtSetupModalTitleRestrictedMedia,
      cfg.lblSetupModalFieldRestrictedMedia, cfg.txtSetupModalPlaceholderRestrictedMedia, state.restrictedMediaChannelId
    ));
  }
  if (id === 'storyadmin_setup_roundup_channel') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_roundup_channel_modal', cfg.txtSetupModalTitleRoundupChannel,
      cfg.lblSetupModalFieldRoundupChannel, cfg.txtSetupModalPlaceholderRoundupChannel, state.roundupChannelId
    ));
  }
  if (id === 'storyadmin_setup_roundup_day') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_roundup_day_modal', cfg.txtSetupModalTitleRoundupDay,
      cfg.lblSetupModalFieldRoundupDay, cfg.txtSetupModalPlaceholderRoundupDay, state.roundupDay
    ));
  }
  if (id === 'storyadmin_setup_roundup_hour') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_roundup_hour_modal', cfg.txtSetupModalTitleRoundupHour,
      cfg.lblSetupModalFieldRoundupHour, cfg.txtSetupModalPlaceholderRoundupHour, state.roundupHour
    ));
  }
  if (id === 'storyadmin_setup_save') return await handleSetupSave(connection, interaction);
  if (id === 'storyadmin_setup_cancel') return await handleSetupCancel(connection, interaction);
}

async function handleSetupChannelModal(connection, interaction, stateField, errorKey) {
  const adminId = interaction.user.id;
  const state = pendingSetupData.get(adminId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const raw = sanitizeModalInput(interaction.fields.getTextInputValue('value'), 30);
  const channelId = raw.match(/\d+/)?.[0] ?? null;
  log(`handleSetupChannelModal: field=${stateField} raw="${raw}" channelId=${channelId} guild=${state.guildId}`, { show: false, guildName: interaction.guild.name });

  if (channelId) {
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      log(`handleSetupChannelModal: channel ${channelId} not found for field ${stateField}`, { show: true, guildName: interaction.guild.name });
      return await interaction.editReply({ content: await getConfigValue(connection, errorKey, state.guildId) });
    }
    state[stateField] = channelId;
  } else {
    state[stateField] = '';
  }

  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg));
  await interaction.deleteReply();
}

async function handleSetupRoleModal(connection, interaction) {
  const adminId = interaction.user.id;
  const state = pendingSetupData.get(adminId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  state.adminRoleName = sanitizeModalInput(interaction.fields.getTextInputValue('value'), 100);
  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg));
  await interaction.deleteReply();
}

async function handleSetupRoundupDayModal(connection, interaction) {
  const adminId = interaction.user.id;
  const state = pendingSetupData.get(adminId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const raw = sanitizeModalInput(interaction.fields.getTextInputValue('value'), 10);
  const day = parseInt(raw, 10);
  if (isNaN(day) || day < 0 || day > 6) {
    return await interaction.editReply({ content: state.cfg.txtSetupRoundupDayInvalid });
  }
  state.roundupDay = String(day);
  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg));
  await interaction.deleteReply();
}

async function handleSetupRoundupHourModal(connection, interaction) {
  const adminId = interaction.user.id;
  const state = pendingSetupData.get(adminId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const raw = sanitizeModalInput(interaction.fields.getTextInputValue('value'), 10);
  const hour = parseInt(raw, 10);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    return await interaction.editReply({ content: state.cfg.txtSetupRoundupHourInvalid });
  }
  state.roundupHour = String(hour);
  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg));
  await interaction.deleteReply();
}

async function handleSetupSave(connection, interaction) {
  const state = pendingSetupData.get(interaction.user.id);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferUpdate();
  const { guildId } = state;

  // Re-validate all set channel IDs
  const feedChannel = state.feedChannelId
    ? await interaction.guild.channels.fetch(state.feedChannelId).catch(() => null)
    : null;
  if (!feedChannel) {
    return await interaction.editReply({
      ...buildSetupPanel(state, state.cfg),
      content: await getConfigValue(connection, 'txtSetupFeedChannelInvalid', guildId)
    });
  }

  let mediaChannel = null;
  if (state.mediaChannelId) {
    mediaChannel = await interaction.guild.channels.fetch(state.mediaChannelId).catch(() => null);
    if (!mediaChannel) {
      return await interaction.editReply({
        ...buildSetupPanel(state, state.cfg),
        content: await getConfigValue(connection, 'txtSetupMediaChannelInvalid', guildId)
      });
    }
  }

  let restrictedFeedChannel = null;
  if (state.restrictedFeedChannelId) {
    restrictedFeedChannel = await interaction.guild.channels.fetch(state.restrictedFeedChannelId).catch(() => null);
    if (!restrictedFeedChannel) {
      return await interaction.editReply({
        ...buildSetupPanel(state, state.cfg),
        content: await getConfigValue(connection, 'txtSetupRestrictedChannelInvalid', guildId)
      });
    }
  }

  let restrictedMediaChannel = null;
  if (state.restrictedMediaChannelId) {
    restrictedMediaChannel = await interaction.guild.channels.fetch(state.restrictedMediaChannelId).catch(() => null);
    if (!restrictedMediaChannel) {
      return await interaction.editReply({
        ...buildSetupPanel(state, state.cfg),
        content: await getConfigValue(connection, 'txtSetupRestrictedMediaInvalid', guildId)
      });
    }
  }

  // Write config values
  const upsert = (key, value) => connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES (?, ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [key, value, guildId]
  );

  await upsert('cfgStoryFeedChannelId', state.feedChannelId);
  if (state.mediaChannelId)           await upsert('cfgMediaChannelId', state.mediaChannelId);
  if (state.restrictedFeedChannelId)  await upsert('cfgRestrictedFeedChannelId', state.restrictedFeedChannelId);
  if (state.restrictedMediaChannelId) await upsert('cfgRestrictedMediaChannelId', state.restrictedMediaChannelId);
  if (state.adminRoleName)            await upsert('cfgAdminRoleName', state.adminRoleName);

  // Roundup config
  if (state.roundupChannelId) {
    await upsert('cfgWeeklyRoundupChannelId', state.roundupChannelId);
    await upsert('cfgWeeklyRoundupEnabled', '1');
    await upsert('cfgWeeklyRoundupDay',  state.roundupDay  || '1');
    await upsert('cfgWeeklyRoundupHour', state.roundupHour || '9');
    await cancelPendingRoundupJobs(connection, guildId);
    await scheduleNextRoundup(connection, guildId);
  } else {
    await upsert('cfgWeeklyRoundupEnabled', '0');
    await cancelPendingRoundupJobs(connection, guildId);
  }

  const botMember = interaction.guild.members.me;
  // Use the bot's managed integration role for permission overwrites — role-level overrides
  // work on private channels where user/member-level overrides fail due to Discord's restriction
  // that member overrides can only grant permissions already in the caller's effective channel perms.
  const botRole = botMember?.roles.cache.find(r => r.managed) ?? null;

  // Attempt to set bot permissions on the feed channel automatically.
  // Note: As of January 12, 2026, PinMessages is a separate permission from ManageMessages.
  // This may silently fail on private channels — the effective permission check below is the
  // authoritative source of truth, so we don't surface whether this attempt succeeded.
  if (botRole) {
    await feedChannel.permissionOverwrites.edit(botRole, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
      ReadMessageHistory: true,
      ManageMessages: true,
      PinMessages: true,
      CreatePublicThreads: true,
      CreatePrivateThreads: true,
      ManageThreads: true,
    }).catch(() => {});
  }

  // Attempt to set bot permissions on the media channel automatically.
  if (mediaChannel && botRole) {
    await mediaChannel.permissionOverwrites.edit(botRole, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    }).catch(() => {});
  }

  // Grant admin role Manage Threads on the story feed channel so they can
  // see private turn threads without being explicitly added to each one.
  let threadPermissionNote = '';
  if (state.adminRoleName) {
    const adminRole = interaction.guild.roles.cache.find(r => r.name === state.adminRoleName)
      ?? await interaction.guild.roles.fetch().then(roles => roles.find(r => r.name === state.adminRoleName)).catch(() => null);
    if (adminRole) {
      await feedChannel.permissionOverwrites.edit(adminRole, {
        ViewChannel: true,
        ManageThreads: true
      }).catch(() => {});
      threadPermissionNote = ` *(Manage Threads granted on feed channel)*`;
    }
  }

  // Check effective bot permissions and warn about any gaps.
  // Re-fetch channels so permission overwrite changes above are reflected.
  const feedChannelFresh = await interaction.guild.channels.fetch(state.feedChannelId).catch(() => feedChannel);
  const mediaChannelFresh = mediaChannel
    ? await interaction.guild.channels.fetch(state.mediaChannelId).catch(() => mediaChannel)
    : null;

  const permWarnings = [];
  if (botMember) {
    const feedPerms = feedChannelFresh.permissionsFor(botMember);
    const feedRequired = [
      ['ViewChannel', 'View Channel'],
      ['SendMessages', 'Send Messages'],
      ['EmbedLinks', 'Embed Links'],
      ['AttachFiles', 'Attach Files'],
      ['ReadMessageHistory', 'Read Message History'],
      ['ManageMessages', 'Manage Messages'],
      ['PinMessages', 'Pin Messages'],
      ['CreatePublicThreads', 'Create Public Threads'],
      ['CreatePrivateThreads', 'Create Private Threads'],
      ['ManageThreads', 'Manage Threads'],
    ];
    const missingFeed = feedRequired.filter(([flag]) => !feedPerms.has(flag)).map(([, label]) => label);
    if (missingFeed.length) {
      permWarnings.push(`⚠️ Bot is missing permissions on <#${state.feedChannelId}>: **${missingFeed.join(', ')}**`);
    }

    if (mediaChannelFresh) {
      const mediaPerms = mediaChannelFresh.permissionsFor(botMember);
      const mediaRequired = [
        ['ViewChannel', 'View Channel'],
        ['SendMessages', 'Send Messages'],
        ['EmbedLinks', 'Embed Links'],
        ['AttachFiles', 'Attach Files'],
      ];
      const missingMedia = mediaRequired.filter(([flag]) => !mediaPerms.has(flag)).map(([, label]) => label);
      if (missingMedia.length) {
        permWarnings.push(`⚠️ Bot is missing permissions on <#${state.mediaChannelId}>: **${missingMedia.join(', ')}**`);
      }
    }
  }

  const feedPermsOk = !permWarnings.some(w => w.includes(`<#${state.feedChannelId}>`));
  const mediaPermsOk = !state.mediaChannelId || !permWarnings.some(w => w.includes(`<#${state.mediaChannelId}>`));

  const saved = [`${feedPermsOk ? '✅' : '⚠️'} Story feed channel: <#${state.feedChannelId}>`];
  if (state.mediaChannelId)           saved.push(`${mediaPermsOk ? '✅' : '⚠️'} Media channel: <#${state.mediaChannelId}>`);
  if (state.restrictedFeedChannelId)  saved.push(`✅ Restricted feed channel: <#${state.restrictedFeedChannelId}> *(Age-restrict this channel if the server is not already 18+)*`);
  if (state.restrictedMediaChannelId) saved.push(`✅ Restricted media channel: <#${state.restrictedMediaChannelId}>`);
  if (state.adminRoleName)            saved.push(`✅ Admin role: **${state.adminRoleName}**${threadPermissionNote}`);
  if (!state.mediaChannelId)          saved.push(`ℹ️ No media channel set — images will not be processed.`);
  if (!state.adminRoleName)           saved.push(`ℹ️ No admin role set — only Discord Administrators can use admin commands.`);
  if (state.roundupChannelId)         saved.push(`✅ Weekly roundup: <#${state.roundupChannelId}>, ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][state.roundupDay ?? 1]}s at ${state.roundupHour ?? 9}:00 UTC`);
  else                                saved.push(`ℹ️ Weekly roundup disabled.`);
  if (permWarnings.length) {
    const botRoleName = botRole?.name ?? botMember?.displayName ?? 'the bot role';
    const fixMsg = replaceTemplateVariables(
      await getConfigValue(connection, 'txtSetupBotPermsFix', guildId),
      { feed_channel: `<#${state.feedChannelId}>`, bot_role_name: botRoleName }
    );
    saved.push('', ...permWarnings, '', fixMsg);
  }

  pendingSetupData.delete(interaction.user.id);
  log(`handleSetupSave: complete for guild ${guildId} by ${interaction.user.tag}`, { show: true, guildName: interaction.guild.name });
  await interaction.editReply({ content: saved.join('\n'), embeds: [], components: [] });
}

async function handleSetupCancel(connection, interaction) {
  pendingSetupData.delete(interaction.user.id);
  await interaction.deferUpdate();
  await interaction.editReply({
    content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
    embeds: [],
    components: []
  });
}

// ---------------------------------------------------------------------------
// /storyadmin skip
// ---------------------------------------------------------------------------
async function handleSkip(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
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

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const activeTurn = activeTurnRows[0];
    await skipActiveTurn(connection, interaction.guild, activeTurn.turn_id, activeTurn.thread_id);

    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);

    await logAdminAction(connection, interaction.user.id, 'skip', storyId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminSkipSuccess', guildId) });

  } catch (error) {
    log(`handleSkip failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin reassign
// ---------------------------------------------------------------------------
async function handleReassign(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.story_writer_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const currentTurn = activeTurnRows[0];

    const [prevTurnRows] = await connection.execute(
      `SELECT sw.story_writer_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 0
       ORDER BY t.ended_at DESC LIMIT 1`,
      [storyId]
    );
    if (prevTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminReassignNoPreviousWriter', guildId) });
    }

    const prevWriter = prevTurnRows[0];

    await skipActiveTurn(connection, interaction.guild, currentTurn.turn_id, currentTurn.thread_id);
    await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [prevWriter.story_writer_id, storyId]);

    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);

    await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [currentTurn.story_writer_id, storyId]);

    await logAdminAction(connection, interaction.user.id, 'reassign', storyId);
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminReassignSuccess', guildId),
        { prev_writer: prevWriter.discord_display_name, current_writer: currentTurn.discord_display_name }
      )
    });

  } catch (error) {
    log(`handleReassign failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin extend
// ---------------------------------------------------------------------------
async function handleExtend(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  const hours = interaction.options.getInteger('hours');
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

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const turnId = activeTurnRows[0].turn_id;
    await connection.execute(
      `UPDATE turn SET turn_ends_at = DATE_ADD(COALESCE(turn_ends_at, NOW()), INTERVAL ? HOUR) WHERE turn_id = ?`,
      [hours, turnId]
    );

    const [updatedRows] = await connection.execute(
      `SELECT UNIX_TIMESTAMP(turn_ends_at) as new_end_unix, turn_ends_at FROM turn WHERE turn_id = ?`,
      [turnId]
    );
    const { new_end_unix: newEndUnix, turn_ends_at: newTurnEndsAt } = updatedRows[0];

    // Cancel the old turnTimeout job and schedule a new one at the updated deadline
    await connection.execute(
      `UPDATE job SET job_status = 2 WHERE job_type = 'turnTimeout' AND job_status = 0
       AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
      [turnId]
    );
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
      ['turnTimeout', JSON.stringify({ turnId, storyId, guildId }), newTurnEndsAt]
    );

    await logAdminAction(connection, interaction.user.id, 'extend', storyId, null, `+${hours}h`);
    const msg = replaceTemplateVariables(await getConfigValue(connection, 'txtAdminExtendSuccess', guildId), {
      hours,
      new_end_time: `<t:${newEndUnix}:f>`
    });
    await interaction.editReply({ content: msg });

  } catch (error) {
    log(`handleExtend failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}


// ---------------------------------------------------------------------------
// /storyadmin manage — dispatch
// ---------------------------------------------------------------------------
async function handleAdminManage(connection, interaction) {
  const targetUser = interaction.options.getUser('user');
  if (targetUser) {
    await handleManageUser(connection, interaction);
  } else {
    await handleManage(connection, interaction);
  }
}

function buildManageUserPanel(state, cfg) {
  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtManageUserPanelTitle, {
      writer_name: state.writerName,
      story_title: state.storyTitle
    }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblManageUserStatus,  value: state.writerStatus === 1 ? 'Active' : 'Paused',                 inline: true },
      { name: cfg.lblManageUserAO3,     value: state.ao3Name || '*Not set*',                                   inline: true },
      { name: cfg.lblManageUserNotif,   value: state.notificationPrefs === 'dm' ? 'DM' : 'Mention in channel', inline: true },
      { name: cfg.lblManageUserPrivacy, value: state.turnPrivacy ? 'Private' : 'Public',                       inline: true }
    );

  const row1 = new ActionRowBuilder().addComponents(
    state.writerStatus === 1
      ? new ButtonBuilder().setCustomId('storyadmin_mu_pause').setLabel(cfg.btnAdminMUPause).setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId('storyadmin_mu_unpause').setLabel(cfg.btnAdminMUUnpause).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('storyadmin_mu_remove').setLabel(cfg.btnAdminMURemove).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('storyadmin_mu_ao3name').setLabel(cfg.btnAdminMUAO3Name).setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_mu_close').setLabel(cfg.btnManageUserClose).setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function handleManageUser(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  const targetUser = interaction.options.getUser('user');

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
    const story = storyRows[0];

    const [writerRows] = await connection.execute(
      `SELECT story_writer_id, sw_status, AO3_name, notification_prefs, turn_privacy
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (1, 2)`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }
    const writer = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, targetUser.id]
    );
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, targetUser.id]
    );

    const cfg = await getConfigValue(connection, [
      'txtManageUserPanelTitle', 'lblManageUserStatus', 'lblManageUserAO3',
      'lblManageUserNotif', 'lblManageUserPrivacy', 'btnManageUserClose',
      'btnAdminMUPause', 'btnAdminMUUnpause', 'btnAdminMURemove', 'btnAdminMUAO3Name',
      'txtAdminMUPauseConfirmDesc', 'txtAdminMUActiveTurnWarning',
      'txtAdminMUUnpauseConfirmDesc', 'txtAdminMURemoveConfirmDesc',
      'txtAdminMULastWriterWarning', 'btnCancel'
    ], guildId);

    const isActiveTurn = activeTurnRows.length > 0;
    const writerName = targetUser.displayName || targetUser.username;

    const state = {
      action: null,
      storyId,
      guildId,
      storyTitle: story.title,
      targetUserId: targetUser.id,
      writerId: writer.story_writer_id,
      writerName,
      writerStatus: writer.sw_status,
      ao3Name: writer.AO3_name,
      notificationPrefs: writer.notification_prefs,
      turnPrivacy: writer.turn_privacy,
      isActiveTurn,
      activeTurnId: isActiveTurn ? activeTurnRows[0].turn_id : null,
      activeTurnThreadId: isActiveTurn ? activeTurnRows[0].thread_id : null,
      isLastWriter: remainingRows[0].count === 0,
      originalInteraction: interaction,
      cfg
    };

    pendingManageUserData.set(interaction.user.id, state);
    await interaction.editReply(buildManageUserPanel(state, cfg));

  } catch (error) {
    log(`handleManageUser failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleManageUserButton(connection, interaction) {
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  const customId = interaction.customId;

  if (customId === 'storyadmin_mu_close') {
    await interaction.deferUpdate();
    pendingManageUserData.delete(adminId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
    return;
  }

  if (!pending) {
    await interaction.deferUpdate();
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), embeds: [], components: [] });
  }

  if (customId === 'storyadmin_mu_pause') {
    pending.action = 'pause';
    await interaction.deferUpdate();
    const description = replaceTemplateVariables(pending.cfg.txtAdminMUPauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('⏸️ Pause Writer?').setDescription(description).setColor(0xfee75c);
    if (pending.isActiveTurn) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUPause).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_unpause') {
    pending.action = 'unpause';
    await interaction.deferUpdate();
    const description = replaceTemplateVariables(pending.cfg.txtAdminMUUnpauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('▶️ Restore to Rotation?').setDescription(description).setColor(0x57f287);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUUnpause).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_remove') {
    pending.action = 'remove';
    await interaction.deferUpdate();
    const description = replaceTemplateVariables(pending.cfg.txtAdminMURemoveConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('⚠️ Remove Writer?').setDescription(description).setColor(0xed4245);
    if (pending.isActiveTurn) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }) });
    if (pending.isLastWriter) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMULastWriterWarning, { user_name: pending.writerName }) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMURemove).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_ao3name') {
    const modal = new ModalBuilder()
      .setCustomId('storyadmin_mu_ao3name_modal')
      .setTitle('Set AO3 Name')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ao3_name_input')
            .setLabel('AO3 Name')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Leave blank to clear')
            .setValue(pending.ao3Name ?? '')
        )
      );
    await interaction.showModal(modal);

  } else if (customId.startsWith('storyadmin_mu_confirm_')) {
    await handleManageUserConfirm(connection, interaction);

  } else if (customId.startsWith('storyadmin_mu_cancel_')) {
    await handleManageUserCancel(connection, interaction);
  }
}


// ---------------------------------------------------------------------------
// /storyadmin next
// ---------------------------------------------------------------------------
async function handleNext(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  const targetUser = interaction.options.getUser('user');
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, story_status FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    if (storyRows[0].story_status !== 1) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotActive', guildId) });
    }

    // Verify the target is an active writer
    const [writerRows] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    // Check if there's an active turn
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, sw.discord_user_id as current_writer_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );

    const targetStoryWriterId = writerRows[0].story_writer_id;

    if (activeTurnRows.length === 0) {
      // No active turn — start theirs immediately (clear any existing override first)
      await connection.execute(`UPDATE story SET next_writer_id = NULL WHERE story_id = ?`, [storyId]);
      await NextTurn(connection, interaction, targetStoryWriterId);
      await logAdminAction(connection, interaction.user.id, 'next', storyId, targetUser.id);
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    const currentWriterId = activeTurnRows[0].current_writer_id;
    if (currentWriterId === targetUser.id) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminNextAlreadyCurrent', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    // Store override — will be applied when the current turn ends
    await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [targetStoryWriterId, storyId]);
    await logAdminAction(connection, interaction.user.id, 'next', storyId, targetUser.id);
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
        { user_name: targetUser.displayName || targetUser.username }
      )
    });

  } catch (error) {
    log(`handleNext failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin delete
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// /storyadmin deleteentry — soft-delete a specific story entry
// ---------------------------------------------------------------------------

async function handleDeleteEntry(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  const turnNumber = interaction.options.getInteger('turn');

  try {
    const [entryRows] = await connection.execute(
      `SELECT se.story_entry_id, se.content, sw.discord_display_name
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ?
         AND se.entry_status = 'confirmed'
         AND (
           SELECT COUNT(DISTINCT t2.turn_id)
           FROM turn t2
           JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
           JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
           WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
         ) = ?`,
      [storyId, turnNumber]
    );

    if (entryRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId) });
    }

    const entry = entryRows[0];
    const preview = entry.content.length > 300 ? entry.content.slice(0, 300) + '…' : entry.content;

    const embed = new EmbedBuilder()
      .setTitle(`Delete Turn ${turnNumber} — ${entry.discord_display_name}?`)
      .setDescription(preview)
      .addFields({ name: '\u200b', value: 'This entry will be hidden from `/story read` and exports. The entry ID shown after deletion can be used to restore it.' })
      .setColor(0xff6b6b);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_deleteentry_confirm_${entry.story_entry_id}`)
        .setLabel('Delete Entry')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('storyadmin_deleteentry_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`handleDeleteEntry failed for story ${storyId} turn ${turnNumber} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDeleteEntryConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const entryId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;

  try {
    const [rows] = await connection.execute(
      `SELECT se.story_entry_id, se.entry_status, sw.discord_display_name, sw.story_id
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE se.story_entry_id = ? AND s.guild_id = ?`,
      [entryId, guildId]
    );

    if (rows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId), embeds: [], components: [] });
    }
    if (rows[0].entry_status === 'deleted') {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminDeleteEntryAlreadyDeleted', guildId), embeds: [], components: [] });
    }

    await connection.execute(
      `UPDATE story_entry SET entry_status = 'deleted' WHERE story_entry_id = ?`,
      [entryId]
    );

    await logAdminAction(connection, interaction.user.id, 'deleteentry', rows[0].story_id);

    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminDeleteEntrySuccess', guildId),
        { author_name: rows[0].discord_display_name, entry_id: String(entryId) }
      ),
      embeds: [],
      components: []
    });

  } catch (error) {
    log(`handleDeleteEntryConfirm failed for entry ${entryId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), embeds: [], components: [] });
  }
}

async function handleRestoreEntry(connection, interaction) {
  const guildId = interaction.guild.id;
  const entryId = interaction.options.getInteger('entry_id');

  try {
    const [rows] = await connection.execute(
      `SELECT se.story_entry_id, se.entry_status, sw.discord_display_name, sw.story_id
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE se.story_entry_id = ? AND s.guild_id = ?`,
      [entryId, guildId]
    );

    if (rows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId) });
    }
    if (rows[0].entry_status !== 'deleted') {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminRestoreEntryNotDeleted', guildId) });
    }

    await connection.execute(
      `UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?`,
      [entryId]
    );

    await logAdminAction(connection, interaction.user.id, 'restoreentry', rows[0].story_id);

    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminRestoreEntrySuccess', guildId),
        { author_name: rows[0].discord_display_name }
      )
    });

  } catch (error) {
    log(`handleRestoreEntry failed for entry ${entryId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDelete(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
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
    const story = storyRows[0];

    const [txtAdminDeleteConfirm, btnConfirmDelete, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtAdminDeleteConfirm', guildId),
      getConfigValue(connection, 'btnConfirmDelete', guildId),
      getConfigValue(connection, 'btnCancel', guildId)
    ]);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_delete_confirm_${storyId}`)
        .setLabel(btnConfirmDelete)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`storyadmin_delete_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content: replaceTemplateVariables(txtAdminDeleteConfirm, { story_title: story.title }),
      components: [row]
    });

  } catch (error) {
    log(`handleDelete failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDeleteConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_thread_id FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), components: [] });
    }
    const story = storyRows[0];

    // Log before deleting so the story_id still exists in the log
    await logAdminAction(connection, interaction.user.id, 'delete', storyId);

    // Hard delete — cascades to story_writer, turn, story_entry
    await connection.execute(`DELETE FROM story WHERE story_id = ?`, [storyId]);

    // Edit the reply before deleting the thread — if the command was run from inside
    // the story thread, deleting it first would destroy the ephemeral interaction context.
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminDeleteSuccess', guildId),
        { story_title: story.title }
      ),
      components: []
    });

    // Delete the Discord story thread after replying
    if (story.story_thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(story.story_thread_id);
        if (thread) await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        log(`Story thread already gone for story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
      }
    }

  } catch (error) {
    log(`handleDeleteConfirm failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handleDeleteCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({
    content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
    components: []
  });
}

// ---------------------------------------------------------------------------
// manageuser confirm / cancel button handlers
// ---------------------------------------------------------------------------
async function handleManageUserConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);

  if (!pending) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      embeds: [],
      components: []
    });
  }

  pendingManageUserData.delete(adminId);
  const { action, storyId, guildId, targetUserId, writerId, writerName, storyTitle,
          isActiveTurn, activeTurnId, activeTurnThreadId, isLastWriter } = pending;

  try {
    if (action === 'pause') {
      await connection.execute(`UPDATE story_writer SET sw_status = 2 WHERE story_writer_id = ?`, [writerId]);
      if (isActiveTurn) {
        await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurnId]);
        if (activeTurnThreadId) {
          try {
            const thread = await interaction.guild.channels.fetch(activeTurnThreadId);
            if (thread) await deleteThreadAndAnnouncement(thread);
          } catch (err) {
            log(`Could not delete thread on admin pause: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
        try {
          const nextWriterId = await PickNextWriter(connection, storyId);
          if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
        } catch (err) {
          log(`Could not advance turn after admin pause for story ${storyId}: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
      await logAdminAction(connection, adminId, 'pause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminPauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });

    } else if (action === 'unpause') {
      await connection.execute(`UPDATE story_writer SET sw_status = 1 WHERE story_writer_id = ?`, [writerId]);
      await logAdminAction(connection, adminId, 'unpause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminUnpauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });

    } else if (action === 'remove') {
      if (isActiveTurn) {
        await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurnId]);
        if (activeTurnThreadId) {
          try {
            const thread = await interaction.guild.channels.fetch(activeTurnThreadId);
            if (thread) await deleteThreadAndAnnouncement(thread);
          } catch (err) {
            log(`Could not delete thread on kick: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
      }
      await connection.execute(
        `UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_writer_id = ?`,
        [writerId]
      );
      if (isLastWriter) {
        await connection.execute(`UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`, [storyId]);
        log(`Story ${storyId} auto-closed after admin kick of last writer`, { show: true, guildName: interaction?.guild?.name });
      } else if (isActiveTurn) {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      }
      await logAdminAction(connection, adminId, 'remove', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminKickSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      const closeNote = isLastWriter ? '\n⚠️ Story auto-closed — no writers remain.' : '';
      await interaction.editReply({ content: successMsg + closeNote, embeds: [], components: [] });

      // Activity log (fire-and-forget)
      getConfigValue(connection, 'txtStoryThreadWriterRemove', guildId).then(template =>
        postStoryThreadActivity(connection, interaction.guild, storyId, template.replace('[writer_name]', writerName))
      ).catch(() => {});

    }

  } catch (error) {
    log(`handleManageUserConfirm (${action}) failed for story ${storyId} guild ${guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection, 'errProcessingRequest', guildId),
      embeds: [],
      components: []
    });
  }
}


async function handleManageUserCancel(connection, interaction) {
  await interaction.deferUpdate();
  const pending = pendingManageUserData.get(interaction.user.id);
  if (!pending) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
  pending.action = null;
  await interaction.editReply(buildManageUserPanel(pending, pending.cfg));
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('storyadmin_deleteentry_confirm_')) {
    await handleDeleteEntryConfirm(connection, interaction);
  } else if (interaction.customId === 'storyadmin_deleteentry_cancel') {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
  } else if (interaction.customId.startsWith('storyadmin_delete_confirm_')) {
    await handleDeleteConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_delete_cancel_')) {
    await handleDeleteCancel(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_mu_')) {
    await handleManageUserButton(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_setup_')) {
    await handleSetupButton(connection, interaction);
  }
}

async function handleManageUserModalSubmit(connection, interaction) {
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  if (!pending) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const rawName = interaction.fields.getTextInputValue('ao3_name_input');
    const newName = sanitizeModalInput(rawName, 100) || null;
    await connection.execute(
      `UPDATE story_writer SET AO3_name = ? WHERE story_writer_id = ?`,
      [newName, pending.writerId]
    );
    await logAdminAction(connection, adminId, 'ao3name', pending.storyId, pending.targetUserId, newName);
    pending.ao3Name = newName;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await pending.originalInteraction.editReply(buildManageUserPanel(pending, pending.cfg));
    await interaction.deleteReply();
  } catch (error) {
    log(`handleManageUserModalSubmit failed for story ${pending.storyId} guild ${pending.guildId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'storyadmin_setup_feed_modal') {
    await handleSetupChannelModal(connection, interaction, 'feedChannelId', 'txtSetupFeedChannelInvalid');
  } else if (interaction.customId === 'storyadmin_setup_media_modal') {
    await handleSetupChannelModal(connection, interaction, 'mediaChannelId', 'txtSetupMediaChannelInvalid');
  } else if (interaction.customId === 'storyadmin_setup_restricted_feed_modal') {
    await handleSetupChannelModal(connection, interaction, 'restrictedFeedChannelId', 'txtSetupRestrictedChannelInvalid');
  } else if (interaction.customId === 'storyadmin_setup_restricted_media_modal') {
    await handleSetupChannelModal(connection, interaction, 'restrictedMediaChannelId', 'txtSetupRestrictedMediaInvalid');
  } else if (interaction.customId === 'storyadmin_setup_roundup_channel_modal') {
    await handleSetupChannelModal(connection, interaction, 'roundupChannelId', 'txtSetupFeedChannelInvalid');
  } else if (interaction.customId === 'storyadmin_setup_role_modal') {
    await handleSetupRoleModal(connection, interaction);
  } else if (interaction.customId === 'storyadmin_setup_roundup_day_modal') {
    await handleSetupRoundupDayModal(connection, interaction);
  } else if (interaction.customId === 'storyadmin_setup_roundup_hour_modal') {
    await handleSetupRoundupHourModal(connection, interaction);
  } else if (interaction.customId === 'storyadmin_mu_ao3name_modal') {
    await handleManageUserModalSubmit(connection, interaction);
  }
}

async function handleAutocomplete(connection, interaction) {
  if (!interaction.guild) return interaction.respond([]);
  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== 'story_id') return interaction.respond([]);
  const guildId = interaction.guild.id;
  const typed = `%${focusedOption.value}%`;
  const typedPrefix = `${focusedOption.value}%`;
  const [rows] = await connection.execute(
    `SELECT s.guild_story_id, s.title,
       EXISTS (SELECT 1 FROM story_writer sw
         WHERE sw.story_id = s.story_id AND sw.discord_user_id = ?
           AND sw.story_writer_id = (SELECT MIN(story_writer_id) FROM story_writer WHERE story_id = s.story_id)
       ) AS is_creator
     FROM story s
     WHERE s.guild_id = ? AND s.story_status != 3
       AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
     ORDER BY is_creator DESC, s.guild_story_id LIMIT 25`,
    [interaction.user.id, guildId, typed, typedPrefix]
  );
  return interaction.respond(
    rows.map(r => ({
      name: `${r.title} (#${r.guild_story_id})`.slice(0, 100),
      value: String(r.guild_story_id)
    }))
  );
}

export default { data, execute, handleButtonInteraction, handleModalSubmit, handleAutocomplete };
