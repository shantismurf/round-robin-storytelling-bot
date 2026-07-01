import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from 'discord.js';
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
    'btnAddTitleAndSummary', 'btnAddSettings', 'btnAddMetadata', 'btnAddTags', 'btnAddMySettings',
    'btnSaveSettings', 'btnCreateStory',
    'optWarnAllClear',
    ...ratingCodes.map(ratingLabelKey),
    ...dynamicOptions,
    ...warningOptions,
  ], guildId);
}

/**
 * Shared embed builder for /story add and /story manage panels.
 * Returns an EmbedBuilder (not a full message payload).
 * Callers wrap it: { embeds: [buildStoryEmbed(cfg, state, opts)], components: [...] }
 *
 * options.title         — embed title (add: txtCreateStoryTitle, manage: txtManageEmbedTitle)
 * options.isManage      — suppresses My Join Settings section and intro description
 * options.showJoinSettings — explicit false also suppresses join section
 */
const s = v => (v == null ? '' : String(v));

export function buildStoryEmbed(cfg, state, options = {}) {
  const showJoinSettings = options.showJoinSettings !== false && !options.isManage;
  const title = options.title ?? cfg.txtCreateStoryTitle;

  const modeEmojis = { 0: '🟢', 1: '🟣', 2: '🔵' };
  const modeLabels = { 0: cfg.txtNormalUC, 1: cfg.txtQuickUC, 2: cfg.txtSlowTC };
  const modeDescs = { 0: cfg.txtNormalModeDesc, 1: cfg.txtQuickModeDesc, 2: cfg.txtSlowModeDesc };
  const orderEmojis = { 1: '\u{1F3B2}', 2: '\u{1F504}', 3: '\u{1F4CB}' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderDescs = { 1: cfg.txtOrderRandomDesc, 2: cfg.txtOrderRoundRobinDesc, 3: cfg.txtOrderFixedDesc };

  const isSlowMode = state.storyMode === 2;
  const modeEmoji = modeEmojis[state.storyMode] ?? '🟢';
  const modeLabel = modeLabels[state.storyMode] ?? cfg.txtNormalUC;
  const modeDesc = modeDescs[state.storyMode] ?? cfg.txtNormalModeDesc;
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const orderDesc = orderDescs[state.orderType];

  const ratingLabel = cfg[ratingLabelKey(state.rating ?? 'NR')] ?? state.rating;
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

  if (cfg.txtStoryAddIntro && !options.isManage) {
    embed.setDescription(cfg.txtStoryAddIntro);
  }

  embed.addFields(
    { name: s(sectionLine) || ' ', value: s(cfg.txtStoryAddSectionBreakSettings) || ' ', inline: true },
    { name: s(sectionLine) || ' ', value: ' ', inline: true },
    { name: s(cfg.lblStoryTitle) || ' ', value: s(titleDisplay) || ' ', inline: false },
    { name: s(`${modeEmoji} ${cfg.lblModeToggle}`) || ' ', value: s(`${modeLabel} — ${modeDesc}`) || ' ', inline: true },
    { name: s(`${orderEmoji} ${cfg.lblWriterOrder}`) || ' ', value: s(`${orderLabel} — ${orderDesc}`) || ' ', inline: true },
    { name: s(cfg.lblTurnLength) || ' ', value: s(isSlowMode ? cfg.txtNA : formatDuration(state.turnLength)) || ' ', inline: true },
    { name: s(isSlowMode ? cfg.lblTimeoutReminderSlow : cfg.lblTimeoutReminder) || ' ', value: s(timeoutDisplay) || ' ', inline: true },
    { name: s(cfg.lblHideToggle) || ' ', value: s(state.hideThreads ? cfg.txtHideThreadsOnDesc : cfg.txtHideThreadsOffDesc) || ' ', inline: true },
    { name: s(cfg.lblShowAuthors) || ' ', value: s(`${state.showAuthors ? cfg.txtYes : cfg.txtNo} — ${state.showAuthors ? cfg.txtShowAuthorsOnDesc : cfg.txtShowAuthorsOffDesc}`) || ' ', inline: true },
    { name: s(cfg.lblMaxWriters) || ' ', value: s(maxWritersDisplay) || ' ', inline: true },
    { name: s(cfg.lblDelayStart) || ' ', value: s(`*${cfg.txtDelayHint}*\n${delayHours} ${cfg.txtHoursLC} / ${delayWriters} ${cfg.txtWritersLC}`) || ' ', inline: true },
    { name: ' ', value: ' ', inline: false },
    { name: s(sectionLine) || ' ', value: s(cfg.txtStoryAddSectionBreakMeta) || ' ', inline: true },
    { name: s(sectionLine) || ' ', value: ' ', inline: true },
    { name: s(cfg.lblMetaRating) || ' ', value: s(ratingLabel) || ' ', inline: true },
    { name: s(cfg.lblMetaDynamic) || ' ', value: s(dynamicDisplay) || ' ', inline: true },
    { name: s(cfg.lblMetaWarnings) || ' ', value: s(warningsDisplay) || ' ', inline: false },
    { name: s(cfg.lblMetaMainRelationship) || ' ', value: s(mainPairingDisplay) || ' ', inline: true },
    { name: s(cfg.lblMetaOtherRelationships) || ' ', value: s(otherRelDisplay) || ' ', inline: true },
    { name: s(cfg.lblMetaCharacters) || ' ', value: s(charsDisplay) || ' ', inline: false },
    { name: s(cfg.lblMetaTags) || ' ', value: s(tagsDisplay) || ' ', inline: false },
    { name: s(cfg.lblMetaSummary) || ' ', value: s(summaryDisplay) || ' ', inline: false },
    { name: s(cfg.lblMetaSceneBreakDivider) || ' ', value: s(sceneBreakDisplay) || ' ', inline: true },
  );

  if (showJoinSettings) {
    embed.addFields(
      { name: ' ', value: ' ', inline: false },
      { name: s(sectionLine) || ' ', value: s(cfg.txtStoryAddSectionBreakJoin) || ' ', inline: true },
      { name: s(sectionLine) || ' ', value: ' ', inline: true },
      { name: s(cfg.lblYourPenName) || ' ', value: s(state.penName || cfg.txtNotSet) || ' ', inline: true },
      { name: s(cfg.lblJoinPrivacy ?? cfg.lblPrivateToggle) || ' ', value: s(state.keepPrivate ? cfg.txtPrivate : cfg.txtPublic) || ' ', inline: true },
      { name: s(cfg.lblJoinNotifications ?? cfg.lblMyNotifications) || ' ', value: s(state.notifications ? (cfg.txtNotifDM || cfg.txtOn) : (cfg.txtNotifMention || cfg.txtOff)) || ' ', inline: true },
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
    .addComponents(
      new ActionRowBuilder().addComponents(dynamicSelect),
      new ActionRowBuilder().addComponents(ratingSelect),
      new ActionRowBuilder().addComponents(warningsSelect),
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
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('scene_break_divider')
          .setLabel(cfg.lblMetaSceneBreakDivider)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setValue(state.sceneBreakDivider ?? '')
          .setPlaceholder(cfg.txtMetaSceneBreakDividerPlaceholder ?? '')
      ),
    );
}
