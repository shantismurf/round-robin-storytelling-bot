import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, TextDisplayBuilder, SeparatorBuilder, ContainerBuilder, LabelBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder, ChannelType } from 'discord.js';
import { getConfigValue, getSetupRequiredMessage, sanitizeModalInput, log, replaceTemplateVariables, logGuildEvent, checkIsAdmin } from '../utilities.js';
import { cancelPendingRoundupJobs, scheduleNextRoundup } from '../story/roundup.js';
import { finalMessage } from '../story/_metadataModals.js';
import { handleSetupSave } from './_storyadminSetupSave.js';

export const pendingSetupData = new Map();

// Dirty-state detection for the unsaved-changes warning below — same pattern as
// story/manage.js's STAGED_FIELDS/isManageDirty (see that file's comment for the full design
// rationale). Every field a setup modal or toggle button stages before Save is listed here;
// handleSetup() snapshots them into state.originalFields at panel open (when current ===
// original for all of them by construction), and buildSetupPanel() diffs current state against
// that snapshot on every render.
export const STAGED_FIELDS = [
  'feedChannelId', 'mediaChannelId', 'adminRoleName',
  'restrictedFeedChannelId', 'restrictedMediaChannelId',
  'roundupChannelId', 'roundupDay', 'roundupHour', 'changelogEnabled',
];

export function isSetupDirty(state) {
  if (!state.originalFields) return false;
  return STAGED_FIELDS.some((key) => state[key] !== state.originalFields[key]);
}

/**
 * Components V2 conversion (docs/plans/PLAN-panel-rework-and-ground-rules.md Part 2, step 2 of
 * the build order) — was a classic EmbedBuilder, now a ContainerBuilder, matching
 * buildStoryPanel() in story/_metadataModals.js. IsComponentsV2 is per-message and can never be
 * removed once a message carries it (verified against node_modules/discord.js/src/structures/
 * interfaces/TextBasedChannel.js), so every caller that edits this same panel message needs a
 * components-only payload from here on — no `content`, `embeds`, `stickers`, or `poll`.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.interactive=true] - false renders the read-only, saved terminal state
 *   (no action rows). Used once, by handleSetupSave after a successful save: pendingSetupData is
 *   gone by then, so live buttons would just dead-end into txtActionSessionExpired.
 * @param {string|null} [opts.prependMessage=null] - plain text shown above the panel body (the
 *   "setup required" onboarding message getSetupRequiredMessage returns). V2 forbids `content`
 *   alongside `components`, so this has to be a component in the same container rather than a
 *   sibling `content` field the way handleSetup's very first reply used to send it.
 * @param {boolean} [opts.tier1Visible=true] - whether to show the Manage-Server-only fields
 * (feed/media/restricted channels, admin role name) and their edit buttons. false renders only
 * the tier-2 fields (roundup, changelog) a story admin without Manage Server can reach — same
 * command, same panel, just fewer rows (docs/TODO.md's "two panels within /storyadmin setup
 * itself" design). This is presentation only; every handler that acts on a tier-1 customId
 * re-checks hasTier1Access() live before doing anything, since hiding a button doesn't stop a
 * replayed customId from someone who saw the tier-1 panel.
 */
export function buildSetupPanel(state, cfg, { interactive = true, prependMessage = null, tier1Visible = true } = {}) {
  log(`storyadmin setup: buildSetupPanel started`, { show: false, guildName: 'system' });
  const fieldVal = (id) => id ? `<#${id}>` : `\`${cfg.txtNotSet}\``;
  const strVal   = (v)  => v  ? `\`${v}\``  : `\`${cfg.txtNotSet}\``;
  const desc     = (key) => `*${cfg[key]}*`;

  const tier1Items = [
    `**${cfg.txtSetupModalTitleFeed}**\n` + desc('txtSetupEmbedDescFeed') + `-> ${fieldVal(state.feedChannelId)}`,
    `**${cfg.txtSetupModalTitleMedia}**\n` + desc('txtSetupEmbedDescMedia') + `-> ${fieldVal(state.mediaChannelId)}`,
    `**${cfg.txtSetupModalTitleRole}**\n` + desc('txtSetupEmbedDescAdminRole') + `-> ${strVal(state.adminRoleName)}`,
    `**${cfg.txtSetupModalTitleRestrictedFeed}**\n` + desc('txtSetupEmbedDescRestrictedFeed') + `-> ${fieldVal(state.restrictedFeedChannelId)}`,
    `**${cfg.txtSetupModalTitleRestrictedMedia}**\n` + desc('txtSetupEmbedDescRestrictedMedia') + `-> ${fieldVal(state.restrictedMediaChannelId)}`,
  ];
  const tier2Items = [
    `**${cfg.txtSetupModalTitleRoundupChannel}**\n` + desc('txtSetupEmbedDescRoundupChannel') + `-> ${state.roundupChannelId ? `<#${state.roundupChannelId}>` : `\`${cfg.txtOff}\``}`,
    `**${cfg.txtSetupModalTitleRoundupDay}**\n` + desc('txtSetupEmbedDescRoundupDay') + `-> ${strVal(state.roundupDay)}`,
    `**${cfg.txtSetupModalTitleRoundupHour}**\n` + desc('txtSetupEmbedDescRoundupHour') + `-> ${strVal(state.roundupHour)}`,
    `**${cfg.lblSetupChangelog}**\n` + desc('txtSetupEmbedDescChangelog') + `-> ${state.changelogEnabled ? cfg.txtOn : cfg.txtOff}`,
  ];

  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  if (prependMessage) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(prependMessage));
    container.addSeparatorComponents(new SeparatorBuilder());
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${cfg.txtSetupPanelTitle}`));

  // Dirty-state-only warning — same pattern/reasoning as story/manage.js's Part 1c indicator.
  if (isSetupDirty(state)) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${cfg.lblUnsavedChangesTitle}**\n${replaceTemplateVariables(cfg.txtUnsavedChangesBody, { save_label: cfg.btnSetupSave })}`
    ));
  }
  container.addSeparatorComponents(new SeparatorBuilder());

  if (tier1Visible) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(tier1Items.join('\n\n')));
    if (interactive) {
      container.addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('storyadmin_setup_channels').setLabel(cfg.btnSetupChannels).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('storyadmin_setup_role').setLabel(cfg.btnSetupRole).setStyle(ButtonStyle.Primary),
      ));
    }
    container.addSeparatorComponents(new SeparatorBuilder());
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(tier2Items.join('\n\n')));

  if (interactive) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('storyadmin_setup_roundup').setLabel(cfg.btnSetupRoundup).setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('storyadmin_setup_toggle_changelog')
        .setLabel(`${cfg.lblSetupChangelog}: ${state.changelogEnabled ? cfg.txtOn : cfg.txtOff}`)
        .setStyle(ButtonStyle.Secondary),
    ));
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('storyadmin_setup_save').setLabel(cfg.btnSetupSave).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('storyadmin_setup_cancel').setLabel(cfg.btnCancel).setStyle(ButtonStyle.Secondary),
    ));
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Tier-1 fields (escalation-capable: feed/media/restricted channels, admin role name — editing
// cfgAdminRoleName lets whoever holds it repoint the admin role at one they control, so it stays
// Manage Server only) are gated to Manage Server. Tier-2 (roundup, changelog, and — per
// docs/plans/PLAN-panel-rework-and-ground-rules.md Part 2 — Ground Rules and the Teen or Lower
// Only toggle) is reachable by Manage Server OR the story admin role (checkIsAdmin). Hiding a
// tier from the rendered panel is presentation, not enforcement — every handler that actually
// writes a tier-1 field or opens a tier-1 modal re-checks this live against the interaction that
// triggered it, not a cached flag on state, since a tier-1 customId can be replayed by anyone
// who has seen the panel (docs/TODO.md, "Split /storyadmin setup into two permission tiers").
export function hasTier1Access(interaction) {
  return interaction.member.permissions.has('ManageGuild');
}

export async function handleSetup(connection, interaction) {
  log(`storyadmin setup: handleSetup started`, { show: false, guildName: interaction.guild.name });
  const guildId = interaction.guild.id;
  const hasManageGuild = hasTier1Access(interaction);
  // `handleSetup`'s early return used to be a flat refusal for anyone without Manage Server — it
  // now renders the tier-2 panel instead, for any story admin (checkIsAdmin: Administrator, or
  // holding cfgAdminRoleName) who isn't also a Manage Server holder.
  const isStoryAdmin = hasManageGuild || await checkIsAdmin(connection, interaction, guildId);
  if (!isStoryAdmin) {
    log(`storyadmin setup: handleSetup error, user has neither Manage Guild nor the story admin role`, { show: false, guildName: interaction.guild.name });
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtSetupNoPermission', guildId),
      flags: MessageFlags.Ephemeral
    });
  }

  const isOwner = interaction.user.id === interaction.guild.ownerId;
  await logGuildEvent(connection, guildId, 'setup_opened', { isOwner, hasManageGuild });
  const cfg = await getConfigValue(connection, [
    'txtSetupPanelTitle',
    'txtSetupModalTitleFeed', 'txtSetupModalTitleMedia', 'txtSetupModalTitleRole',
    'txtSetupModalTitleRestrictedFeed', 'txtSetupModalTitleRestrictedMedia',
    'txtSetupModalTitleRoundupChannel', 'txtSetupModalTitleRoundupDay', 'txtSetupModalTitleRoundupHour',
    'lblUnsavedChangesTitle', 'txtUnsavedChangesBody',
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
    'txtSetupSupportInvite', 'cfgHubInviteUrl', 'lblSetupChangelog',
    'lblSetupModalFieldRole', 'txtSetupModalPlaceholderRole',
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
    hasManageGuild,
    originalInteraction: interaction,
    cfg,
  };
  // Snapshot for isSetupDirty — current === original for every STAGED_FIELDS entry right now,
  // by construction, since state was just built from the DB above.
  state.originalFields = Object.fromEntries(STAGED_FIELDS.map((key) => [key, state[key]]));

  pendingSetupData.set(interaction.user.id, state);
  log(`handleSetup: opening panel for ${interaction.user.tag} in guild ${guildId}`, { show: false, guildName: interaction.guild.name });
  // `setup` is exempt from the gate in index.js, so an admin who installs the bot and comes
  // straight here would otherwise never see the welcome or its prerequisites list — and this
  // is the moment they most need it, since creating a channel or a role means leaving the panel.
  const setupMessage = await getSetupRequiredMessage(connection, interaction);
  const panel = buildSetupPanel(state, cfg, { prependMessage: setupMessage, tier1Visible: hasManageGuild });
  await interaction.reply({
    ...panel,
    flags: panel.flags | MessageFlags.Ephemeral,
  });
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

  // Tier-1 customIds only render on the tier-1 panel, but that's presentation, not enforcement —
  // a story admin who saw the tier-1 panel once (e.g. as a former Manage Server holder, or by
  // inspecting the message) could replay these. Re-check live rather than trust state.
  if (id === 'storyadmin_setup_channels') {
    if (!hasTier1Access(interaction)) {
      return await interaction.reply({
        content: await getConfigValue(connection, 'txtSetupNoPermission', interaction.guild.id),
        flags: MessageFlags.Ephemeral
      });
    }
    return await interaction.showModal(buildChannelsModal(cfg, state));
  }
  if (id === 'storyadmin_setup_role') {
    if (!hasTier1Access(interaction)) {
      return await interaction.reply({
        content: await getConfigValue(connection, 'txtSetupNoPermission', interaction.guild.id),
        flags: MessageFlags.Ephemeral
      });
    }
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
    return await state.originalInteraction.editReply(buildSetupPanel(state, cfg, { tier1Visible: hasTier1Access(interaction) }));
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
  // Tier-1 fields — this modal can only be reached via handleSetupButton's own gate above, but
  // re-checked here too, at the point the fields actually get written into state, rather than
  // trusting that gate alone.
  if (!hasTier1Access(interaction)) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtSetupNoPermission', interaction.guild.id),
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

  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg, { tier1Visible: true }));
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

  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg, { tier1Visible: hasTier1Access(interaction) }));
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
  // Tier-1 field (cfgAdminRoleName) — same re-check as handleSetupChannelsModal above.
  if (!hasTier1Access(interaction)) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtSetupNoPermission', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  state.adminRoleName = sanitizeModalInput(interaction.fields.getTextInputValue('value'), 100);
  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg, { tier1Visible: true }));
  await interaction.deleteReply();
}

export async function handleSetupCancel(connection, interaction) {
  pendingSetupData.delete(interaction.user.id);
  await interaction.deferUpdate();
  // finalMessage() (story/_metadataModals.js) wraps plain text as a one-block V2 Container —
  // {content, embeds: [], components: []} is the pre-V2 shape and is no longer valid once this
  // message carries IsComponentsV2 (see buildSetupPanel's doc comment).
  await interaction.editReply(finalMessage(await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id)));
}
