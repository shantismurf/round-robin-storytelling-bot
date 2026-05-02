import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput } from '../utilities.js';
import { ratingLabels, dynamicOptions, warningOptions } from './metadata.js';
import { pendingStoryData, buildStoryAddMessage } from './add.js';

// Keyed by userId — tracks which interaction opened the metadata panel
const pendingMetaPanelData = new Map();

async function getMetaCfg(connection, guildId) {
  return await getConfigValue(connection, [
    'txtMetaPanelTitle', 'txtMetaSaveSuccess', 'btnSaveSettings', 'btnCancel',
    'lblMetaDynamic', 'lblMetaRating', 'lblMetaWarnings',
    'lblMetaFandom', 'lblMetaMainRelationship', 'lblMetaOtherRelationships',
    'lblMetaCharacters', 'lblMetaTags', 'lblMetaSummary',
    'txtMetaMainRelationshipPlaceholder', 'txtNotSet',
    'txtRatingNR',
    ...Object.values(ratingLabels),
    ...dynamicOptions,
    ...warningOptions,
  ], guildId);
}

export function buildMetadataPanel(cfg, state) {
  const ratingKey = ratingLabels[state.rating] ?? 'txtRatingNR';
  const ratingLabel = cfg[ratingKey] ?? state.rating;
  const dynamicDisplay = state.dynamic ? (cfg[state.dynamic] ?? state.dynamic) : cfg.txtNotSet;
  const warningsDisplay = state.warnings?.length
    ? state.warnings.map(k => cfg[k] ?? k).join(', ')
    : cfg.txtNotSet;
  const fandomDisplay = state.fandom || cfg.txtNotSet;
  const mainRelDisplay = state.mainPairing || cfg.txtNotSet;
  const otherRelDisplay = state.otherRelationships || cfg.txtNotSet;
  const charsDisplay = state.characters || cfg.txtNotSet;
  const tagsDisplay = state.additionalTags || cfg.txtNotSet;
  const summaryDisplay = state.summary || cfg.txtNotSet;

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtMetaPanelTitle)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblMetaDynamic, value: dynamicDisplay, inline: true },
      { name: cfg.lblMetaFandom, value: fandomDisplay, inline: true },
      { name: cfg.lblMetaRating, value: ratingLabel, inline: true },
      { name: cfg.lblMetaWarnings, value: warningsDisplay, inline: true },
      { name: cfg.lblMetaMainRelationship, value: mainRelDisplay, inline: true },
      { name: cfg.lblMetaOtherRelationships, value: otherRelDisplay, inline: true },
      { name: cfg.lblMetaCharacters, value: charsDisplay, inline: false },
      { name: cfg.lblMetaTags, value: tagsDisplay, inline: false },
      { name: cfg.lblMetaSummary, value: summaryDisplay, inline: false },
    );

  const currentDynamicLabel = state.dynamic ? (cfg[state.dynamic] ?? state.dynamic) : cfg.txtNotSet;

  // Row 1 (4): Dynamic: <> | Fandom | Rating: <> | Set Warnings
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_meta_cycle_dynamic')
      .setLabel(`${cfg.lblMetaDynamic}: ${currentDynamicLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_meta_set_fandom')
      .setLabel(cfg.lblMetaFandom)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_meta_cycle_rating')
      .setLabel(`${cfg.lblMetaRating}: ${ratingLabel}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_meta_set_warnings')
      .setLabel(cfg.lblMetaWarnings)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 2 (2): Main Relationship | Other Relationships
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_meta_set_mainrel')
      .setLabel(cfg.lblMetaMainRelationship)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_meta_set_otherrel')
      .setLabel(cfg.lblMetaOtherRelationships)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 3 (3): Characters | Tags | Set Summary
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_meta_set_characters')
      .setLabel(cfg.lblMetaCharacters)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_meta_set_tags')
      .setLabel(cfg.lblMetaTags)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_add_meta_set_summary')
      .setLabel(cfg.lblMetaSummary)
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 4 (1): Save Settings
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_add_meta_save')
      .setLabel(cfg.btnSaveSettings)
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4], flags: MessageFlags.Ephemeral };
}

export async function handleMetadataButton(connection, interaction) {
  const customId = interaction.customId;
  const userId = interaction.user.id;
  log(`handleMetadataButton: customId=${customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  try {
    const addState = pendingStoryData.get(userId);
    if (!addState) {
      log(`handleMetadataButton: no pendingStoryData for user=${interaction.user.username} customId=${customId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.reply({ content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id), flags: MessageFlags.Ephemeral });
      return;
    }

    const cfg = await getMetaCfg(connection, interaction.guild.id);

    if (customId === 'story_add_open_metadata') {
      pendingMetaPanelData.set(userId, { metaState: { ...addState }, guildId: interaction.guild.id });
      log(`handleMetadataButton: opened metadata panel for user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
      await interaction.reply(buildMetadataPanel(cfg, addState));
      return;
    }

    const metaEntry = pendingMetaPanelData.get(userId);
    if (!metaEntry) {
      log(`handleMetadataButton: no pendingMetaPanelData for user=${interaction.user.username} customId=${customId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.reply({ content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id), flags: MessageFlags.Ephemeral });
      return;
    }
    const metaState = metaEntry.metaState;

    if (customId === 'story_add_meta_cycle_dynamic') {
      const idx = dynamicOptions.indexOf(metaState.dynamic);
      metaState.dynamic = dynamicOptions[(idx + 1) % dynamicOptions.length];
      log(`handleMetadataButton: dynamic changed to '${metaState.dynamic}' for user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
      await interaction.update(buildMetadataPanel(cfg, metaState));

    } else if (customId === 'story_add_meta_cycle_rating') {
      const ratingKeys = Object.keys(ratingLabels);
      const idx = ratingKeys.indexOf(metaState.rating ?? 'NR');
      metaState.rating = ratingKeys[(idx + 1) % ratingKeys.length];
      log(`handleMetadataButton: rating changed to '${metaState.rating}' for user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
      await interaction.update(buildMetadataPanel(cfg, metaState));

    } else if (customId === 'story_add_meta_set_warnings') {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('story_add_meta_warnings_select')
        .setPlaceholder(cfg.lblMetaWarnings)
        .setMinValues(1)
        .setMaxValues(warningOptions.length)
        .addOptions(warningOptions.map(k => ({
          label: cfg[k] ?? k,
          value: k,
          default: (metaState.warnings ?? []).includes(k)
        })));
      await interaction.reply({
        content: cfg.lblMetaWarnings,
        components: [new ActionRowBuilder().addComponents(selectMenu)],
        flags: MessageFlags.Ephemeral
      });

    } else if (customId === 'story_add_meta_set_fandom') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_meta_fandom_modal')
          .setTitle(cfg.lblMetaFandom)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('fandom')
              .setLabel(cfg.lblMetaFandom)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(100)
              .setValue(metaState.fandom ?? '')
              .setPlaceholder('e.g. The Hobbit, Original Work')
          ))
      );

    } else if (customId === 'story_add_meta_set_mainrel') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_meta_mainrel_modal')
          .setTitle(cfg.lblMetaMainRelationship)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('main_relationship')
              .setLabel(cfg.lblMetaMainRelationship)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(200)
              .setValue(metaState.mainPairing ?? '')
              .setPlaceholder(cfg.txtMetaMainRelationshipPlaceholder)
          ))
      );

    } else if (customId === 'story_add_meta_set_otherrel') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_meta_otherrel_modal')
          .setTitle(cfg.lblMetaOtherRelationships)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('other_relationships')
              .setLabel(cfg.lblMetaOtherRelationships)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(1000)
              .setValue(metaState.otherRelationships ?? '')
          ))
      );

    } else if (customId === 'story_add_meta_set_characters') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_meta_characters_modal')
          .setTitle(cfg.lblMetaCharacters)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('characters')
              .setLabel(cfg.lblMetaCharacters)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(500)
              .setValue(metaState.characters ?? '')
          ))
      );

    } else if (customId === 'story_add_meta_set_tags') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_meta_tags_modal')
          .setTitle(cfg.lblMetaTags)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('additional_tags')
              .setLabel(cfg.lblMetaTags)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(1000)
              .setValue(metaState.additionalTags ?? '')
          ))
      );

    } else if (customId === 'story_add_meta_set_summary') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_add_meta_summary_modal')
          .setTitle(cfg.lblMetaSummary)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('summary')
              .setLabel(cfg.lblMetaSummary)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(4000)
              .setValue(metaState.summary ?? '')
          ))
      );

    } else if (customId === 'story_add_meta_save') {
      Object.assign(addState, {
        rating: metaState.rating,
        warnings: metaState.warnings,
        fandom: metaState.fandom,
        mainPairing: metaState.mainPairing,
        otherRelationships: metaState.otherRelationships,
        characters: metaState.characters,
        dynamic: metaState.dynamic,
        additionalTags: metaState.additionalTags,
        summary: metaState.summary,
      });
      pendingMetaPanelData.delete(userId);
      log(`handleMetadataButton: metadata saved for user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.update({ content: cfg.txtMetaSaveSuccess, embeds: [], components: [] });
      await addState.originalInteraction.editReply(buildStoryAddMessage(addState.cfg, addState));

    } else if (customId === 'story_add_meta_cancel') {
      pendingMetaPanelData.delete(userId);
      await interaction.update({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
    }
  } catch (error) {
    log(`handleMetadataButton failed: customId=${customId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtActionFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleMetadataModal(connection, interaction) {
  const customId = interaction.customId;
  const userId = interaction.user.id;
  log(`handleMetadataModal: customId=${customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  const metaEntry = pendingMetaPanelData.get(userId);
  if (!metaEntry) {
    log(`handleMetadataModal: no pendingMetaPanelData for user=${interaction.user.username} customId=${customId}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id), flags: MessageFlags.Ephemeral });
    return;
  }

  const metaState = metaEntry.metaState;
  const cfg = await getMetaCfg(connection, interaction.guild.id);

  try {
    if (customId === 'story_add_meta_fandom_modal') {
      metaState.fandom = sanitizeModalInput(interaction.fields.getTextInputValue('fandom'), 100) || '';
    } else if (customId === 'story_add_meta_mainrel_modal') {
      metaState.mainPairing = sanitizeModalInput(interaction.fields.getTextInputValue('main_relationship'), 200) || '';
    } else if (customId === 'story_add_meta_otherrel_modal') {
      metaState.otherRelationships = sanitizeModalInput(interaction.fields.getTextInputValue('other_relationships'), 1000, true) || '';
    } else if (customId === 'story_add_meta_characters_modal') {
      metaState.characters = sanitizeModalInput(interaction.fields.getTextInputValue('characters'), 500) || '';
    } else if (customId === 'story_add_meta_tags_modal') {
      metaState.additionalTags = sanitizeModalInput(interaction.fields.getTextInputValue('additional_tags'), 1000, true) || '';
    } else if (customId === 'story_add_meta_summary_modal') {
      metaState.summary = sanitizeModalInput(interaction.fields.getTextInputValue('summary'), 4000, true) || '';
    }

    await interaction.deferUpdate();
    await interaction.editReply(buildMetadataPanel(cfg, metaState));
  } catch (error) {
    log(`handleMetadataModal failed: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: await getConfigValue(connection, 'txtActionFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleMetadataSelectMenu(connection, interaction) {
  const customId = interaction.customId;
  const userId = interaction.user.id;
  log(`handleMetadataSelectMenu: customId=${customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  const metaEntry = pendingMetaPanelData.get(userId);
  if (!metaEntry) {
    await interaction.update({ content: await getConfigValue(connection, 'txtStoryAddSessionExpired', interaction.guild.id), components: [] });
    return;
  }

  const metaState = metaEntry.metaState;

  if (customId === 'story_add_meta_warnings_select') {
    metaState.warnings = interaction.values;
    const cfg = await getMetaCfg(connection, interaction.guild.id);
    log(`handleMetadataSelectMenu: warnings saved for user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.update({ content: cfg.txtMetaSaveSuccess, components: [] });
  }
}
