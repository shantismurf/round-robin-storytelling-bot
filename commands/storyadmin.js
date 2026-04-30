import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId, checkIsAdmin } from '../utilities.js';
import { handleManage } from '../story/manage.js';
import { handleManageUser, handleManageUserButton, handleManageUserModalSubmit } from '../story/manageUser.js';
import { deleteThreadAndAnnouncement } from '../storybot.js';
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

const pendingSetupData = new Map();

const data = new SlashCommandBuilder()
  .setName('storyadmin')
  .setDescription('Admin tools for story management')
  .addSubcommand(s =>
    s.setName('manage')
      .setDescription('Manage story settings, or a specific writer\'s settings')
      .addStringOption(o =>
        o.setName('story_id').setDescription('Story to manage').setRequired(true).setAutocomplete(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to manage (leave blank to manage story settings)').setRequired(false))
  )
  .addSubcommand(s =>
    s.setName('delete')
      .setDescription('Permanently delete a story and all its data')
      .addStringOption(o =>
        o.setName('story_id').setDescription('Story to delete').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand(s =>
    s.setName('setup')
      .setDescription('Configure Round Robin StoryBot for this server')
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Show all admin commands and what they do')
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
  if (subcommand === 'manage')  await handleAdminManage(connection, interaction);
  else if (subcommand === 'delete') await handleDelete(connection, interaction);
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
    roundupDay:               guildCfg.cfgWeeklyRoundupDay       || '1',
    roundupHour:              guildCfg.cfgWeeklyRoundupHour      || '9',
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
  const textInput = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(safeLabel)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(safePlaceholder)
    .setRequired(false);
  if (currentValue) textInput.setValue(currentValue);
  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
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

  const dayNames = await getConfigValue(connection, [
    'txtRoundupDay0', 'txtRoundupDay1', 'txtRoundupDay2', 'txtRoundupDay3',
    'txtRoundupDay4', 'txtRoundupDay5', 'txtRoundupDay6'
  ], guildId);

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
  if (state.restrictedFeedChannelId) {
    const rfNote = restrictedFeedChannel?.nsfw ? '' : ' *(Age-restrict this channel if the server is not already 18+)*';
    saved.push(`✅ Restricted feed channel: <#${state.restrictedFeedChannelId}>${rfNote}`);
  }
  if (state.restrictedMediaChannelId) saved.push(`✅ Restricted media channel: <#${state.restrictedMediaChannelId}>`);
  if (state.adminRoleName)            saved.push(`✅ Admin role: **${state.adminRoleName}**${threadPermissionNote}`);
  if (!state.mediaChannelId)          saved.push(`ℹ️ No media channel set — images will not be processed.`);
  if (!state.adminRoleName)           saved.push(`ℹ️ No admin role set — only Discord Administrators can use admin commands.`);
  if (state.roundupChannelId)         saved.push(`✅ Weekly roundup: <#${state.roundupChannelId}>, ${dayNames[`txtRoundupDay${state.roundupDay ?? 1}`]}s at ${state.roundupHour ?? 9}:00 UTC`);
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
// /storyadmin manage — dispatch
// ---------------------------------------------------------------------------
async function handleAdminManage(connection, interaction) {
  const targetUser = interaction.options.getUser('user');
  log(`handleAdminManage: targetUser=${targetUser?.id ?? 'none'} storyId=${interaction.options.getString('story_id')}`, { show: false, guildName: interaction?.guild?.name });
  if (targetUser) {
    await handleManageUser(connection, interaction);
  } else {
    await handleManage(connection, interaction, true); // already deferred in execute()
  }
}


// ---------------------------------------------------------------------------
// /storyadmin delete
// ---------------------------------------------------------------------------


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


async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('storyadmin_delete_confirm_')) {
    await handleDeleteConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_delete_cancel_')) {
    await handleDeleteCancel(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_mu_')) {
    await handleManageUserButton(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_setup_')) {
    await handleSetupButton(connection, interaction);
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
  } else if (interaction.customId.startsWith('storyadmin_mu_')) {
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
