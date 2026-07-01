import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, TextDisplayBuilder, LabelBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder, ChannelType } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables } from '../utilities.js';
import { cancelPendingRoundupJobs, scheduleNextRoundup } from '../story/roundup.js';

export const pendingSetupData = new Map();

export function buildSetupPanel(state, cfg) {
  log(`storyadmin setup: buildSetupPanel started`, { show: false, guildName: 'system' });
  const fieldVal = (id) => id ? `<#${id}>` : `\`${cfg.txtNotSet}\``;
  const strVal   = (v)  => v  ? `\`${v}\``  : `\`${cfg.txtNotSet}\``;
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
      { name: cfg.txtSetupModalTitleRoundupChannel, value: desc('txtSetupEmbedDescRoundupChannel')  + (state.roundupChannelId ? `<#${state.roundupChannelId}>` : `\`${cfg.txtOff}\``), inline: false },
      { name: cfg.txtSetupModalTitleRoundupDay,     value: desc('txtSetupEmbedDescRoundupDay')      + strVal(state.roundupDay),                        inline: true  },
      { name: cfg.txtSetupModalTitleRoundupHour,    value: desc('txtSetupEmbedDescRoundupHour')     + strVal(state.roundupHour),                       inline: true  },
      { name: cfg.lblSetupChangelog,                value: desc('txtSetupEmbedDescChangelog')       + (state.changelogEnabled ? cfg.txtOn : cfg.txtOff), inline: false },
    )
    .setDescription(cfg.txtSetupModalSaveWarning)
    .setFooter({ text: cfg.txtSetupModalSaveWarning + ` ##` });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_channels').setLabel(cfg.btnSetupChannels).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('storyadmin_setup_role').setLabel(cfg.btnSetupRole).setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_roundup').setLabel(cfg.btnSetupRoundup).setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('storyadmin_setup_toggle_changelog')
      .setLabel(`${cfg.lblSetupChangelog}: ${state.changelogEnabled ? cfg.txtOn : cfg.txtOff}`)
      .setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_save').setLabel(cfg.btnSetupSave).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('storyadmin_setup_cancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

export async function handleSetup(connection, interaction) {
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
    'txtSetupEmbedDescChangelog',
    'btnSetupChannels', 'btnSetupRoundup', 'btnSetupRole',
    'btnSetupSave', 'btnCancel',
    'txtSetupModalTitleChannels', 'txtSetupModalTitleRoundup',
    'txtSetupChannelsModalDesc', 'txtSetupRoundupModalDesc',
    'txtRoundupDay0', 'txtRoundupDay1', 'txtRoundupDay2', 'txtRoundupDay3',
    'txtRoundupDay4', 'txtRoundupDay5', 'txtRoundupDay6',
    'txtNotSet', 'txtOff', 'txtOn',
    'txtSetupAgeRestrictNote', 'txtSetupNoMediaNote', 'txtSetupNoRoleNote', 'txtSetupRoundupDisabledNote',
    'txtSetupSupportInvite', 'lblSetupChangelog',
  ], guildId);

  // Load current guild-specific config values without falling back to guild_id=1
  const [cfgRows] = await connection.execute(
    `SELECT config_key, config_value FROM config
     WHERE guild_id = ? AND config_key IN (
       'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName',
       'cfgRestrictedFeedChannelId', 'cfgRestrictedMediaChannelId',
       'cfgWeeklyRoundupChannelId', 'cfgWeeklyRoundupDay', 'cfgWeeklyRoundupHour',
       'cfgChangelogEnabled'
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
    changelogEnabled:         guildCfg.cfgChangelogEnabled !== '0',
    originalInteraction: interaction,
    cfg,
  };

  pendingSetupData.set(interaction.user.id, state);
  log(`handleSetup: opening panel for ${interaction.user.tag} in guild ${guildId}`, { show: false, guildName: interaction.guild.name });
  const panel = buildSetupPanel(state, cfg);
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

function buildChannelsModal(cfg, state) {
  log(`storyadmin setup: buildChannelsModal`, { show: false, guildName: 'system' });
  const modal = new ModalBuilder()
    .setCustomId('storyadmin_setup_channels_modal')
    .setTitle(cfg.txtSetupModalTitleChannels);

  modal.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(cfg.txtSetupChannelsModalDesc)
  );

  const channelFields = [
    { customId: 'feedChannelId',            labelKey: 'txtSetupModalTitleFeed',            required: true,  currentId: state.feedChannelId },
    { customId: 'mediaChannelId',           labelKey: 'txtSetupModalTitleMedia',           required: false, currentId: state.mediaChannelId },
    { customId: 'restrictedFeedChannelId',  labelKey: 'txtSetupModalTitleRestrictedFeed',  required: false, currentId: state.restrictedFeedChannelId },
    { customId: 'restrictedMediaChannelId', labelKey: 'txtSetupModalTitleRestrictedMedia', required: false, currentId: state.restrictedMediaChannelId },
  ];

  for (const { customId, labelKey, required, currentId } of channelFields) {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(customId)
      .addChannelTypes(ChannelType.GuildText)
      .setMaxValues(1)
      .setRequired(required);
    if (!required) select.setMinValues(0);
    if (currentId) select.setDefaultChannels([currentId]);
    modal.addLabelComponents(
      new LabelBuilder().setLabel(cfg[labelKey]).setChannelSelectMenuComponent(select)
    );
  }

  return modal;
}

function buildRoundupModal(cfg, state) {
  log(`storyadmin setup: buildRoundupModal`, { show: false, guildName: 'system' });
  const modal = new ModalBuilder()
    .setCustomId('storyadmin_setup_roundup_modal')
    .setTitle(cfg.txtSetupModalTitleRoundup);

  modal.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(cfg.txtSetupRoundupModalDesc)
  );

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('roundupChannelId')
    .addChannelTypes(ChannelType.GuildText)
    .setMaxValues(1)
    .setRequired(false)
    .setMinValues(0);
  if (state.roundupChannelId) channelSelect.setDefaultChannels([state.roundupChannelId]);
  modal.addLabelComponents(
    new LabelBuilder().setLabel(cfg.txtSetupModalTitleRoundupChannel).setChannelSelectMenuComponent(channelSelect)
  );

  const dayOptions = [0, 1, 2, 3, 4, 5, 6].map(d => ({
    label: cfg[`txtRoundupDay${d}`],
    value: String(d),
    default: state.roundupDay === String(d),
  }));
  modal.addLabelComponents(
    new LabelBuilder().setLabel(cfg.txtSetupModalTitleRoundupDay).setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId('roundupDay').addOptions(dayOptions)
    )
  );

  const hourLabel = (h) => {
    if (h === 0)  return '12:00 AM (Midnight) UTC';
    if (h === 12) return '12:00 PM (Noon) UTC';
    return h < 12 ? `${h}:00 AM UTC` : `${h - 12}:00 PM UTC`;
  };
  const hourOptions = Array.from({ length: 24 }, (_, h) => ({
    label: hourLabel(h),
    value: String(h),
    default: state.roundupHour === String(h),
  }));
  modal.addLabelComponents(
    new LabelBuilder().setLabel(cfg.txtSetupModalTitleRoundupHour).setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId('roundupHour').addOptions(hourOptions)
    )
  );

  return modal;
}

export async function handleSetupButton(connection, interaction) {
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

  if (id === 'storyadmin_setup_channels') {
    return await interaction.showModal(buildChannelsModal(cfg, state));
  }
  if (id === 'storyadmin_setup_role') {
    return await interaction.showModal(buildSetupFieldModal(
      'storyadmin_setup_role_modal', cfg.txtSetupModalTitleRole,
      cfg.lblSetupModalFieldRole, cfg.txtSetupModalPlaceholderRole, state.adminRoleName
    ));
  }
  if (id === 'storyadmin_setup_roundup') {
    return await interaction.showModal(buildRoundupModal(cfg, state));
  }
  if (id === 'storyadmin_setup_toggle_changelog') {
    state.changelogEnabled = !state.changelogEnabled;
    await interaction.deferUpdate();
    return await state.originalInteraction.editReply(buildSetupPanel(state, cfg));
  }
  if (id === 'storyadmin_setup_save') return await handleSetupSave(connection, interaction);
  if (id === 'storyadmin_setup_cancel') return await handleSetupCancel(connection, interaction);
}

export async function handleSetupChannelsModal(connection, interaction) {
  const adminId = interaction.user.id;
  const state = pendingSetupData.get(adminId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const readChannelId = (customId) => {
    try {
      const field = interaction.fields.getField(customId);
      return field?.channels?.first()?.id ?? field?.values?.[0] ?? '';
    } catch { return ''; }
  };

  state.feedChannelId            = readChannelId('feedChannelId');
  state.mediaChannelId           = readChannelId('mediaChannelId');
  state.restrictedFeedChannelId  = readChannelId('restrictedFeedChannelId');
  state.restrictedMediaChannelId = readChannelId('restrictedMediaChannelId');

  log(`handleSetupChannelsModal: feed=${state.feedChannelId} media=${state.mediaChannelId} restrictedFeed=${state.restrictedFeedChannelId} restrictedMedia=${state.restrictedMediaChannelId} guild=${state.guildId}`, { show: false, guildName: interaction.guild.name });

  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg));
  await interaction.deleteReply();
}

export async function handleSetupRoundupModal(connection, interaction) {
  const adminId = interaction.user.id;
  const state = pendingSetupData.get(adminId);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const field = interaction.fields.getField('roundupChannelId');
    state.roundupChannelId = field?.channels?.first()?.id ?? field?.values?.[0] ?? '';
  } catch { state.roundupChannelId = ''; }

  try {
    const dayValues = interaction.fields.getStringSelectValues('roundupDay');
    if (dayValues?.[0] !== undefined) state.roundupDay = dayValues[0];
  } catch (err) {
    log(`handleSetupRoundupModal: day read failed: ${err}`, { show: true, guildName: interaction.guild.name });
  }

  try {
    const hourValues = interaction.fields.getStringSelectValues('roundupHour');
    if (hourValues?.[0] !== undefined) state.roundupHour = hourValues[0];
  } catch (err) {
    log(`handleSetupRoundupModal: hour read failed: ${err}`, { show: true, guildName: interaction.guild.name });
  }

  log(`handleSetupRoundupModal: channel=${state.roundupChannelId} day=${state.roundupDay} hour=${state.roundupHour} guild=${state.guildId}`, { show: false, guildName: interaction.guild.name });

  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg));
  await interaction.deleteReply();
}

export async function handleSetupRoleModal(connection, interaction) {
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

export async function handleSetupSave(connection, interaction) {
  const state = pendingSetupData.get(interaction.user.id);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferUpdate();
  const { guildId } = state;

  const [[{ priorSetupCount }]] = await connection.execute(
    `SELECT COUNT(*) as priorSetupCount FROM config WHERE config_key = 'cfgStoryFeedChannelId' AND guild_id = ?`,
    [guildId]
  );
  const isFirstSetup = Number(priorSetupCount) === 0;
  log(`handleSetupSave: isFirstSetup=${isFirstSetup} for guild ${guildId}`, { show: false, guildName: interaction.guild.name });

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

  // Changelog / hub announcement opt-out
  await upsert('cfgChangelogEnabled', state.changelogEnabled ? '1' : '0');

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
    const rfNote = restrictedFeedChannel?.nsfw ? '' : ' ' + state.cfg.txtSetupAgeRestrictNote;
    saved.push(`✅ Restricted feed channel: <#${state.restrictedFeedChannelId}>${rfNote}`);
  }
  if (state.restrictedMediaChannelId) saved.push(`✅ Restricted media channel: <#${state.restrictedMediaChannelId}>`);
  if (state.adminRoleName)            saved.push(`✅ Admin role: **${state.adminRoleName}**${threadPermissionNote}`);
  if (!state.mediaChannelId)          saved.push(state.cfg.txtSetupNoMediaNote);
  if (!state.adminRoleName)           saved.push(state.cfg.txtSetupNoRoleNote);
  if (state.roundupChannelId)         saved.push(`✅ Weekly roundup: <#${state.roundupChannelId}>, ${dayNames[`txtRoundupDay${state.roundupDay ?? 1}`]}s at ${state.roundupHour ?? 9}:00 UTC`);
  else                                saved.push(state.cfg.txtSetupRoundupDisabledNote);
  saved.push(`${state.changelogEnabled ? '✅' : '🔕'} Hub announcements: ${state.changelogEnabled ? state.cfg.txtOn : state.cfg.txtOff}`);
  if (permWarnings.length) {
    const botRoleName = botRole?.name ?? botMember?.displayName ?? 'the bot role';
    const fixMsg = replaceTemplateVariables(
      await getConfigValue(connection, 'txtSetupBotPermsFix', guildId),
      { feed_channel: `<#${state.feedChannelId}>`, bot_role_name: botRoleName }
    );
    saved.push('', ...permWarnings, '', fixMsg);
  }

  saved.push('', state.cfg.txtSetupSupportInvite);

  pendingSetupData.delete(interaction.user.id);
  log(`handleSetupSave: complete for guild ${guildId} by ${interaction.user.tag}`, { show: true, guildName: interaction.guild.name });

  if (isFirstSetup) {
    await connection.execute(
      `INSERT IGNORE INTO config (config_key, config_value, language_code, guild_id) VALUES ('cfgGuildRegisteredAt', ?, 'en', ?)`,
      [new Date().toISOString(), guildId]
    );
    log(`🆕 New server setup: **${interaction.guild.name}** (${guildId}) by ${interaction.user.tag}`, { show: true, hub: true });
  }

  await interaction.editReply({ content: saved.join('\n'), embeds: [], components: [] });
}

export async function handleSetupCancel(connection, interaction) {
  pendingSetupData.delete(interaction.user.id);
  await interaction.deferUpdate();
  await interaction.editReply({
    content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
    embeds: [],
    components: []
  });
}
