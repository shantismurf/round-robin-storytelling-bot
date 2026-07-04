import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, LabelBuilder } from 'discord.js';
import { getConfigValue, formatDuration } from '../utilities.js';
import { ratingCodes, ratingLabelKey, dynamicOptions, warningOptions } from './_metadata.js';

export async function getMetaCfg(connection, guildId) {
  return await getConfigValue(connection, [
    'txtNotSet', 'txtNone', 'txtNA', 'txtOn', 'txtOff', 'txtYes', 'txtNo',
    'txtPublic', 'txtPrivate', 'txtInfinity',
    'txtHoursLC', 'txtHoursUC', 'txtWritersLC',
    'txtNormalUC', 'txtQuickUC', 'txtSlowTC',
    'txtSectionBreakLine',
    'txtCreateStoryTitle', 'txtStoryAddIntro', 'txtStoryTitlePrompt',
    'txtManageEmbedTitle',
    'txtNormalModeDesc', 'txtQuickModeDesc', 'txtSlowModeDesc',
    'txtHideThreadsOffDesc', 'txtHideThreadsOnDesc',
    'txtShowAuthorsOnDesc', 'txtShowAuthorsOffDesc',
    'txtPrivateOffDesc', 'txtPrivateOnDesc',
    'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
    'txtOrderRandomDesc', 'txtOrderRoundRobinDesc', 'txtOrderFixedDesc',
    'txtStoryAddSectionBreakSettings', 'txtStoryAddSectionBreakMeta', 'txtStoryAddSectionBreakJoin',
    'lblStoryTitle', 'lblModeToggle', 'lblWriterOrder', 'lblHideToggle', 'lblShowAuthors',
    'lblTurnLength', 'lblTimeoutReminder', 'lblTimeoutReminderSlow',
    'lblMaxWriters', 'lblDelayStart', 'txtDelayHint',
    'lblPrivateToggle', 'lblJoinPrivacySelect', 'lblJoinNotifSelect',
    'lblJoinNotifications', 'lblJoinPrivacy',
    'lblMyNotifications', 'lblYourPenName',
    'txtNotifDM', 'txtNotifMention',
    'lblMetaRating', 'lblMetaWarnings', 'lblMetaDynamic',
    'lblMetaMainRelationship', 'lblMetaOtherRelationships',
    'lblMetaCharacters', 'lblMetaTags', 'lblMetaSummary', 'lblMetaSceneBreakDivider',
    'txtMetaMainRelationshipPlaceholder', 'txtMetaSceneBreakDividerPlaceholder',
    'txtManageWarningSelectInstructions',
    'btnAddTitleAndSummary', 'btnAddSettings', 'btnAddMetadata', 'btnAddTags', 'btnAddMySettings', 'btnAddHideToggle',
    'btnSaveSettings', 'btnCreateStory',
    'optWarnAllClear',
    ...ratingCodes.map(ratingLabelKey),
    ...dynamicOptions,
    ...warningOptions,
  ], guildId);
}

/**
 * Shared embed builder for /story add and /story manage panels.
 * isManage: shows metadata section, hides join settings and intro description.
 */
export function buildStoryEmbed(cfg, state, title, isManage = false) {
  title = title ?? cfg.txtCreateStoryTitle;

  const modeEmojis = { 0: '🟢', 1: '🟣', 2: '🔵' };
  const modeLabels = { 0: cfg.txtNormalUC, 1: cfg.txtQuickUC, 2: cfg.txtSlowTC };
  const modeDescs = { 0: cfg.txtNormalModeDesc, 1: cfg.txtQuickModeDesc, 2: cfg.txtSlowModeDesc };
  const orderEmojis = { 1: '\u{1F3B2}', 2: '\u{1F504}', 3: '\u{1F4CB}' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderDescs = { 1: cfg.txtOrderRandomDesc, 2: cfg.txtOrderRoundRobinDesc, 3: cfg.txtOrderFixedDesc };

  const isSlowMode = state.storyMode === 2;
  const modeEmoji = modeEmojis[state.storyMode];
  const modeLabel = modeLabels[state.storyMode] ?? cfg.txtNormalUC;
  const modeDesc = modeDescs[state.storyMode] ?? cfg.txtNormalModeDesc;
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const orderDesc = orderDescs[state.orderType];

  const ratingLabel = cfg[ratingLabelKey(state.rating)] ?? state.rating;
  const warningsDisplay = state.warnings?.length
    ? (Array.isArray(state.warnings) ? state.warnings : state.warnings.split(',').map(w => w.trim()))
        .map(k => cfg[k] ?? k).join(', ')
    : cfg.optWarnAllClear ?? cfg.txtNone;
  const dynamicDisplay = state.dynamic ? (cfg[state.dynamic] ?? state.dynamic) : cfg.txtNotSet;

  const titleDisplay = state.storyTitle || cfg.txtStoryTitlePrompt;
  const summaryDisplay = state.summary || cfg.txtNotSet;
  const mainPairingDisplay = state.mainPairing || cfg.txtNotSet;
  const otherRelDisplay = state.otherRelationships || cfg.txtNotSet;
  const charsDisplay = state.characters || cfg.txtNotSet;
  const tagsDisplay = state.tags || cfg.txtNotSet;
  const sceneBreakDisplay = state.sceneBreakDivider || cfg.txtNotSet;
  const maxWritersDisplay = state.maxWriters ? String(state.maxWriters) : cfg.txtInfinity;
  const delayHours = state.delayHours ?? 0;
  const delayWriters = state.delayWriters ?? 0;

  const timeoutDisplay = isSlowMode
    ? (state.timeoutReminder === 0 ? cfg.txtNone : `${state.timeoutReminder}h`)
    : (state.timeoutReminder === 0 ? cfg.txtNone : `${state.timeoutReminder}%`);

  const sectionLine = cfg.txtSectionBreakLine;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(state.storyMode === 1 ? 0xE040FB : state.storyMode === 2 ? 0x5865F2 : 0x57F287);

  if (cfg.txtStoryAddIntro && !isManage) {
    embed.setDescription(cfg.txtStoryAddIntro);
  }

  embed.addFields(
    { name: '​', value: `${cfg.lblStoryTitle}\n${titleDisplay}\n\n${cfg.lblMetaSummary}\n${summaryDisplay}`, inline: false },
    { name: cfg.lblMetaRating, value: ratingLabel, inline: true },
    { name: cfg.lblMetaSceneBreakDivider, value: sceneBreakDisplay, inline: true },
    { name: '​', value: '​', inline: true },
    { name: sectionLine +' '+ cfg.txtStoryAddSectionBreakSettings +' '+ sectionLine, value: '​', inline: false },
    { name: `${modeEmoji} ${cfg.lblModeToggle}`, value: `${modeLabel} — ${modeDesc}`, inline: true },
    { name: `${orderEmoji} ${cfg.lblWriterOrder}`, value: `${orderLabel} — ${orderDesc}`, inline: true },
    { name: cfg.lblMaxWriters, value: maxWritersDisplay, inline: true },
    { name: cfg.lblDelayStart, value: `*${cfg.txtDelayHint}*\n${delayHours} ${cfg.txtHoursLC} / ${delayWriters} ${cfg.txtWritersLC}`, inline: true },
    { name: cfg.lblHideToggle, value: state.hideThreads ? cfg.txtHideThreadsOnDesc : cfg.txtHideThreadsOffDesc, inline: true },
    { name: cfg.lblShowAuthors, value: `${state.showAuthors ? cfg.txtYes : cfg.txtNo} — ${state.showAuthors ? cfg.txtShowAuthorsOnDesc : cfg.txtShowAuthorsOffDesc}`, inline: true },
    { name: cfg.lblTurnLength, value: isSlowMode ? cfg.txtNA : formatDuration(state.turnLength), inline: true },
    { name: isSlowMode ? cfg.lblTimeoutReminderSlow : cfg.lblTimeoutReminder, value: timeoutDisplay, inline: true },
    { name: '​', value: '​', inline: true },
  );

  if (isManage) {
    embed.addFields(
      { name: sectionLine +' '+ cfg.txtStoryAddSectionBreakMeta +' '+ sectionLine, value: '​', inline: false },
      { name: cfg.lblMetaDynamic, value: dynamicDisplay, inline: true },
      { name: cfg.lblMetaWarnings, value: warningsDisplay, inline: true },
      { name: '​', value: '​', inline: true },
      { name: '​', value: `${cfg.lblMetaMainRelationship}\n${mainPairingDisplay}\n\n${cfg.lblMetaCharacters}\n${charsDisplay}`, inline: true },
      { name: '​', value: `${cfg.lblMetaOtherRelationships}\n${otherRelDisplay}\n\n${cfg.lblMetaTags}\n${tagsDisplay}`, inline: true },
      { name: '​', value: '​', inline: true },
    );
  }

  if (!isManage) {
    embed.addFields(
      { name: sectionLine +' '+ cfg.txtStoryAddSectionBreakJoin +' '+ sectionLine, value: '​', inline: false },
      { name: cfg.lblYourPenName, value: state.penName, inline: true },
      { name: cfg.lblJoinPrivacy, value: state.keepPrivate ? cfg.txtPrivate : cfg.txtPublic, inline: true },
      { name: cfg.lblJoinNotifications, value: state.notifications ? (cfg.txtNotifDM || cfg.txtOn) : (cfg.txtNotifMention || cfg.txtOff), inline: true },
    );
  }

  return embed;
}

/**
 * Builds the Story Metadata modal (Dynamic, Rating, Warnings selects).
 * namespace: 'story_add' or 'story_manage'
 */
export function buildMetadataModal(cfg, state, namespace) {
  const ns = namespace ?? 'story_add';

  const dynamicSelect = new StringSelectMenuBuilder()
    .setCustomId(`${ns}_metadata_dynamic`)
    .setPlaceholder(cfg.lblMetaDynamic)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(dynamicOptions.map(k => ({
      label: cfg[k] ?? k,
      value: k,
      default: state.dynamic === k,
    })));

  const ratingSelect = new StringSelectMenuBuilder()
    .setCustomId(`${ns}_metadata_rating`)
    .setPlaceholder(cfg.lblMetaRating)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(ratingCodes.map(code => ({
      label: cfg[ratingLabelKey(code)] ?? code,
      value: code,
      default: (state.rating ?? 'NR') === code,
    })));

  const warningsSelect = new StringSelectMenuBuilder()
    .setCustomId(`${ns}_metadata_warnings`)
    .setPlaceholder(cfg.lblMetaWarnings)
    .setMinValues(1)
    .setMaxValues(warningOptions.length)
    .addOptions([
      { label: cfg.txtManageWarningSelectInstructions ?? cfg.txtNone, value: '__dismiss__', default: false },
      ...warningOptions.map(k => ({
        label: cfg[k] ?? k,
        value: k,
        default: (Array.isArray(state.warnings) ? state.warnings : (state.warnings ?? '').split(',').map(w => w.trim())).includes(k),
      })),
    ]);

  return new ModalBuilder()
    .setCustomId(`${ns}_metadata_modal`)
    .setTitle(cfg.btnAddMetadata)
    .addLabelComponents(
      new LabelBuilder().setLabel(cfg.lblMetaDynamic).setStringSelectMenuComponent(dynamicSelect),
      new LabelBuilder().setLabel(cfg.lblMetaRating).setStringSelectMenuComponent(ratingSelect),
      new LabelBuilder().setLabel(cfg.lblMetaWarnings).setStringSelectMenuComponent(warningsSelect),
    );
}

/**
 * Builds the Story Tags modal (5 text inputs).
 * namespace: 'story_add' or 'story_manage'
 */
export function buildTagsModal(cfg, state, namespace) {
  const ns = namespace ?? 'story_add';

  return new ModalBuilder()
    .setCustomId(`${ns}_tags_modal`)
    .setTitle(cfg.btnAddTags)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('main_pairing')
          .setLabel(cfg.lblMetaMainRelationship)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setValue(state.mainPairing ?? '')
          .setPlaceholder(cfg.txtMetaMainRelationshipPlaceholder ?? '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('other_relationships')
          .setLabel(cfg.lblMetaOtherRelationships)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
          .setValue(state.otherRelationships ?? '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('characters')
          .setLabel(cfg.lblMetaCharacters)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(500)
          .setValue(state.characters ?? '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tags')
          .setLabel(cfg.lblMetaTags)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
          .setValue(state.tags ?? '')
      ),
    );
}
