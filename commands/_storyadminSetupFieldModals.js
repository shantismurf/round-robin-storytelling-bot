// storyadmin setup — the channels/role/roundup field-editing modals, extracted from
// commands/_storyadminSetup.js to keep that file under the 500-line CLAUDE.md standard once
// Ground Rules and the Teen or Lower Only toggle pushed it over. Pure field-editing modules: each
// modal builder plus its submit handler, staging values into the same shared `state` the panel
// itself reads. Tier-1 handlers (channels, role) re-check hasTier1Access() themselves rather than
// trusting handleSetupButton's own gate — see commands/_storyadminSetup.js's hasTier1Access doc
// comment for why a customId can be replayed.
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, TextDisplayBuilder, LabelBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder, ChannelType, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log } from '../utilities.js';
import { pendingSetupData, buildSetupPanel, hasTier1Access } from './_storyadminSetup.js';

export function buildSetupFieldModal(customId, title, fieldLabel, placeholder, currentValue) {
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

export function buildChannelsModal(cfg, state) {
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

export function buildRoundupModal(cfg, state) {
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
