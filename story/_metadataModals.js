import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, LabelBuilder, RadioGroupBuilder, RadioGroupOptionBuilder, CheckboxGroupBuilder, CheckboxGroupOptionBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, formatDuration, trimTrailingEmoji, replaceTemplateVariables } from '../utilities.js';
import { ratingCodes, ratingLabelKey, dynamicOptions, warningOptions } from './_metadata.js';
import { STORY_MODE } from '../constants.js';

// Wraps a plain text message (optionally with trailing components, e.g. a confirm row or an
// export-button row) as a one-block Components V2 Container — for terminal/interstitial states
// (save success/error, close-confirm, close success) that follow a V2 panel. Confirmed against
// Discord's docs that IsComponentsV2 can never be removed once a message carries it ("Once a
// message has been sent with this flag, it can't be removed from that message"), so anything
// editing a message that started as this panel must stay in this shape. Shared by manage.js and
// _manageClose.js — lives here rather than in either of them to avoid a circular import between
// the two.
export function finalMessage(text, extraComponents = []) {
  return {
    components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text)), ...extraComponents],
    flags: MessageFlags.IsComponentsV2,
  };
}

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
    'txtTurnPrivacyPublicDesc', 'txtTurnPrivacyPrivateDesc',
    'txtShowAuthorsOnDesc', 'txtShowAuthorsOffDesc',
    'txtPrivateOffDesc', 'txtPrivateOnDesc',
    'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
    'txtOrderRandomDesc', 'txtOrderRoundRobinDesc', 'txtOrderFixedDesc',
    'txtStoryAddSectionBreakInfo','txtStoryAddSectionBreakSettings', 'txtStoryAddSectionBreakMeta', 'txtStoryAddSectionBreakJoin', 'txtStoryAddSectionBreakTags',
    'lblStoryTitle', 'lblModeToggle', 'lblWriterOrder', 'lblTurnPrivacy', 'lblShowAuthors',
    'lblTurnLength', 'lblTimeoutReminder', 'lblTimeoutReminderSlow',
    'lblMaxWriters', 'lblDelayStart', 'txtDelayHint',
    'lblPrivateToggle', 'lblJoinPrivacySelect', 'lblJoinNotifSelect',
    'lblJoinNotifications', 'lblJoinPrivacy',
    'lblMyNotifications', 'lblYourPenName',
    'txtNotifDM', 'txtNotifMention',
    'lblMetaRating', 'lblMetadataAddon', 'lblMetaWarnings', 'lblMetaDynamic',
    'lblMetaMainRelationship', 'lblMetaOtherRelationships',
    'lblMetaCharacters', 'lblMetaTags', 'lblMetaSummary', 'lblMetaSceneBreakDivider',
    'txtMetaMainRelationshipPlaceholder', 'txtMetaSceneBreakDividerPlaceholder',
    'btnAddTitleAndSummary', 'btnAddStoryInfo', 'btnAddSettings', 'btnAddMetadata', 'btnAddTags', 'btnAddMySettings',
    'btnSaveSettings', 'btnCreateStory', 'btnPanelTabSettings', 'btnPanelTabMetadata', 'txtStoryManagementLabel', 'txtManageSaveWarning',
    'optWarnAllClear',
    ...ratingCodes.map(ratingLabelKey),
    ...dynamicOptions,
    ...warningOptions,
  ], guildId);
}

/**
 * Shared panel builder for /story add and /story manage — Components V2 Container.
 * isManage: shows Join Settings cluster only when false (join settings don't apply post-join);
 *   also gates the Review Tags button into the Metadata tab (tag review has no meaning pre-creation).
 * activeGroup: 'settings' | 'metadata' — which tab's field clusters render.
 * namespace: 'story_add' or 'story_manage' — customId prefix for the tab-toggle and edit buttons.
 * titleMetadata: header text to show instead of `title` while the Metadata tab is active. Add
 *   passes none (its "Create New Story" header holds regardless of tab); Manage passes a second
 *   title so the header itself reflects which tab you're on, not just the tab buttons' colors.
 *
 * Returns a ContainerBuilder, not a finished message payload — callers append their own
 * trailing components (e.g. manage's persistent story-action buttons, add's Create Story
 * button) before sending with `{ components: [...], flags: MessageFlags.IsComponentsV2 }`.
 */
export function buildStoryPanel(cfg, state, title, { isManage = false, activeGroup = 'settings', namespace = 'story_add', titleMetadata = null } = {}) {
  title = title ?? cfg.txtCreateStoryTitle;
  const ns = namespace;
  const headerText = (activeGroup === 'metadata' && titleMetadata) ? titleMetadata : title;

  const modeEmojis = { 0: '🟢', 1: '🟣', 2: '🔵' };
  const modeLabels = { 0: cfg.txtNormalUC, 1: cfg.txtQuickUC, 2: cfg.txtSlowTC };
  const modeDescs = { 0: cfg.txtNormalModeDesc, 1: cfg.txtQuickModeDesc, 2: cfg.txtSlowModeDesc };
  const orderEmojis = { 1: '\u{1F3B2}', 2: '\u{1F504}', 3: '\u{1F4CB}' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderDescs = { 1: cfg.txtOrderRandomDesc, 2: cfg.txtOrderRoundRobinDesc, 3: cfg.txtOrderFixedDesc };

  const isSlowMode = state.storyMode === STORY_MODE.SLOW;
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

  const turnLengthDisplay = isSlowMode ? cfg.txtNA : formatDuration(state.turnLength);

  const container = new ContainerBuilder()
    .setAccentColor(state.storyMode === STORY_MODE.QUICK ? 0xE040FB : state.storyMode === STORY_MODE.SLOW ? 0x5865F2 : 0x57F287);

  // Tab toggle sits above the header now — the header text changes with it (Manage only; Add's
  // header is tab-independent), so the buttons need to read as "pick a view" before that view's
  // label, not as an action tucked under a static title. Active tab styled Success, inactive
  // Secondary, so "you are here" is unambiguous even without the header's help.
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ns}_tab_settings`).setLabel(cfg.btnPanelTabSettings)
      .setStyle(activeGroup === 'settings' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ns}_tab_metadata`).setLabel(cfg.btnPanelTabMetadata)
      .setStyle(activeGroup === 'metadata' ? ButtonStyle.Success : ButtonStyle.Secondary),
  ));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${headerText}`));

  if (cfg.txtStoryAddIntro && !isManage) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtStoryAddIntro));
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  if (activeGroup === 'settings') {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${trimTrailingEmoji(cfg.lblStoryTitle)}**\n${titleDisplay}\n\n**${trimTrailingEmoji(cfg.lblMetaSummary)}**\n${summaryDisplay}`
    ));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${ns}_open_titlesummary`).setLabel(cfg.btnAddTitleAndSummary).setStyle(ButtonStyle.Primary)
    ));
    container.addSeparatorComponents(new SeparatorBuilder());

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${cfg.txtStoryAddSectionBreakInfo}\n` +
      `${modeEmoji} **${trimTrailingEmoji(cfg.lblModeToggle)}:** ${modeLabel} — ${modeDesc}\n` +
      `${orderEmoji} **${trimTrailingEmoji(cfg.lblWriterOrder)}:** ${orderLabel} — ${orderDesc}\n` +
      `**${trimTrailingEmoji(cfg.lblShowAuthors)}:** ${state.showAuthors ? cfg.txtShowAuthorsOnDesc : cfg.txtShowAuthorsOffDesc}\n` +
      `**${trimTrailingEmoji(cfg.lblTurnPrivacy)}:** ${state.storyTurnPrivacy ? cfg.txtTurnPrivacyPrivateDesc : cfg.txtTurnPrivacyPublicDesc}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaSceneBreakDivider)}:** ${sceneBreakDisplay}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaRating)}${cfg.lblMetadataAddon}:** ${ratingLabel}`
    ));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${ns}_open_storyinfo`).setLabel(cfg.btnAddStoryInfo).setStyle(ButtonStyle.Primary)
    ));
    container.addSeparatorComponents(new SeparatorBuilder());

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${cfg.txtStoryAddSectionBreakSettings}\n` +
      `**${trimTrailingEmoji(cfg.lblTurnLength)}:** ${turnLengthDisplay}\n` +
      `**${isSlowMode ? trimTrailingEmoji(cfg.lblTimeoutReminderSlow) : trimTrailingEmoji(cfg.lblTimeoutReminder)}:** ${timeoutDisplay}\n` +
      `**${trimTrailingEmoji(cfg.lblDelayStart)}:** ${delayHours} ${cfg.txtHoursLC} / ${delayWriters} ${cfg.txtWritersLC} _(${cfg.txtDelayHint})_\n` +
      `**${trimTrailingEmoji(cfg.lblMaxWriters)}:** ${maxWritersDisplay}`
    ));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${ns}_open_settings`).setLabel(cfg.btnAddSettings).setStyle(ButtonStyle.Primary)
    ));

    if (!isManage) {
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `${cfg.txtStoryAddSectionBreakJoin}\n` +
        `**${cfg.lblYourPenName}:** ${state.penName || state.displayName || cfg.txtNotSet}\n` +
        `**${cfg.lblJoinPrivacy}:** ${state.keepPrivate ? cfg.txtPrivate : cfg.txtPublic}\n` +
        `**${cfg.lblJoinNotifications}:** ${state.notifications ? (cfg.txtNotifDM || cfg.txtOn) : (cfg.txtNotifMention || cfg.txtOff)}`
      ));
      container.addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${ns}_open_mysettings`).setLabel(cfg.btnAddMySettings).setStyle(ButtonStyle.Primary)
      ));
    }
  } else {
    // Rating shown again here (not just Settings tab) — mechanically relevant to Settings
    // (drives restricted-channel thread routing), but edited via this same Metadata modal
    // alongside Dynamic/Warnings, so the edit button naturally lives here.
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${cfg.txtStoryAddSectionBreakMeta}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaRating)}:** ${ratingLabel}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaDynamic)}:** ${dynamicDisplay}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaWarnings)}:** ${warningsDisplay}`
    ));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${ns}_open_metadata`).setLabel(cfg.btnAddMetadata).setStyle(ButtonStyle.Primary)
    ));
    container.addSeparatorComponents(new SeparatorBuilder());

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${cfg.txtStoryAddSectionBreakTags}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaMainRelationship)}:** ${mainPairingDisplay}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaOtherRelationships)}:** ${otherRelDisplay}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaCharacters)}:** ${charsDisplay}\n` +
      `**${trimTrailingEmoji(cfg.lblMetaTags)}:** ${tagsDisplay}`
    ));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${ns}_open_tags`).setLabel(cfg.btnAddTags).setStyle(ButtonStyle.Primary)
    ));

    if (isManage) {
      // Review Tags lives here, not with the other manage actions on the Settings tab — it
      // approves/rejects submissions that feed this Tags field directly, so it belongs with
      // the Metadata content it affects, not the story-lifecycle buttons on Settings. Caption
      // sits between the two buttons (not trailing, like the Settings-tab captions) — there's
      // headroom on this tab (25/40) to try it, and it reads as a note bridging Edit Story Tags
      // into the review action right below it.
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtReviewTagsDesc));
      container.addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('story_manage_review_tags')
          .setLabel(replaceTemplateVariables(cfg.btnReviewTags, { count: state.pendingTagCount || 0 }))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!state.pendingTagCount)
      ));
    }
  }

  return container;
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
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .addOptions(dynamicOptions.map(k => ({
      label: cfg[k] ?? k,
      value: k,
      default: state.dynamic === k,
    })));

  const ratingSelect = new StringSelectMenuBuilder()
    .setCustomId(`${ns}_metadata_rating`)
    .setPlaceholder(cfg.lblMetaRating)
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .addOptions(ratingCodes.map(code => ({
      label: cfg[ratingLabelKey(code)] ?? code,
      value: code,
      default: (state.rating ?? 'NR') === code,
    })));

  // Real checkbox group — no __dismiss__ placeholder needed. That workaround only existed
  // because StringSelectMenuBuilder needs at least one option to render; CheckboxGroupBuilder
  // has no such constraint, so an empty-selected group is a normal, directly representable state.
  const warningsGroup = new CheckboxGroupBuilder()
    .setCustomId(`${ns}_metadata_warnings`)
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(warningOptions.length)
    .addOptions(warningOptions.map(k => new CheckboxGroupOptionBuilder()
      .setLabel(cfg[k] ?? k)
      .setValue(k)
      .setDefault((Array.isArray(state.warnings) ? state.warnings : (state.warnings ?? '').split(',').map(w => w.trim())).includes(k))
    ));

  return new ModalBuilder()
    .setCustomId(`${ns}_metadata_modal`)
    .setTitle(cfg.btnAddMetadata)
    .addLabelComponents(
      new LabelBuilder().setLabel(cfg.lblMetaDynamic).setStringSelectMenuComponent(dynamicSelect),
      new LabelBuilder().setLabel(cfg.lblMetaRating).setStringSelectMenuComponent(ratingSelect),
      new LabelBuilder().setLabel(cfg.lblMetaWarnings).setCheckboxGroupComponent(warningsGroup),
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

/**
 * Builds the Story Info modal (mode, order, show authors, turn privacy radio groups + scene break text input).
 * namespace: 'story_add' or 'story_manage'
 */
export function buildStoryInfoModal(cfg, state, namespace) {
  const ns = namespace ?? 'story_add';

  const modeGroup = new RadioGroupBuilder()
    .setCustomId(`${ns}_storyinfo_mode`)
    .setRequired(false)
    .addOptions(
      new RadioGroupOptionBuilder().setLabel(cfg.txtNormalUC).setValue('0').setDescription(cfg.txtNormalModeDesc).setDefault(state.storyMode === STORY_MODE.NORMAL),
      new RadioGroupOptionBuilder().setLabel(cfg.txtQuickUC).setValue('1').setDescription(cfg.txtQuickModeDesc).setDefault(state.storyMode === STORY_MODE.QUICK),
      new RadioGroupOptionBuilder().setLabel(cfg.txtSlowTC).setValue('2').setDescription(cfg.txtSlowModeDesc).setDefault(state.storyMode === STORY_MODE.SLOW),
    );

  const orderGroup = new RadioGroupBuilder()
    .setCustomId(`${ns}_storyinfo_order`)
    .setRequired(false)
    .addOptions(
      new RadioGroupOptionBuilder().setLabel(cfg.txtOrderRandom).setValue('1').setDescription(cfg.txtOrderRandomDesc).setDefault(state.orderType === 1),
      new RadioGroupOptionBuilder().setLabel(cfg.txtOrderRoundRobin).setValue('2').setDescription(cfg.txtOrderRoundRobinDesc).setDefault(state.orderType === 2),
      new RadioGroupOptionBuilder().setLabel(cfg.txtOrderFixed).setValue('3').setDescription(cfg.txtOrderFixedDesc).setDefault(state.orderType === 3),
    );

  const showAuthorsGroup = new RadioGroupBuilder()
    .setCustomId(`${ns}_storyinfo_showauthors`)
    .setRequired(false)
    .addOptions(
      new RadioGroupOptionBuilder().setLabel(cfg.txtYes).setValue('1').setDescription(cfg.txtShowAuthorsOnDesc).setDefault(!!state.showAuthors),
      new RadioGroupOptionBuilder().setLabel(cfg.txtNo).setValue('0').setDescription(cfg.txtShowAuthorsOffDesc).setDefault(!state.showAuthors),
    );

  const turnPrivacyGroup = new RadioGroupBuilder()
    .setCustomId(`${ns}_storyinfo_turnprivacy`)
    .setRequired(false)
    .addOptions(
      new RadioGroupOptionBuilder().setLabel(cfg.txtPublic).setValue('0').setDescription(cfg.txtTurnPrivacyPublicDesc).setDefault(!state.storyTurnPrivacy),
      new RadioGroupOptionBuilder().setLabel(cfg.txtPrivate).setValue('1').setDescription(cfg.txtTurnPrivacyPrivateDesc).setDefault(!!state.storyTurnPrivacy),
    );

  return new ModalBuilder()
    .setCustomId(`${ns}_storyinfo_modal`)
    .setTitle(cfg.btnAddStoryInfo)
    .addLabelComponents(
      new LabelBuilder().setLabel(cfg.lblModeToggle).setRadioGroupComponent(modeGroup),
      new LabelBuilder().setLabel(cfg.lblWriterOrder).setRadioGroupComponent(orderGroup),
      new LabelBuilder().setLabel(cfg.lblShowAuthors).setRadioGroupComponent(showAuthorsGroup),
      new LabelBuilder().setLabel(cfg.lblTurnPrivacy).setRadioGroupComponent(turnPrivacyGroup),
    )
    .addComponents(
      new TextInputBuilder()
        .setCustomId('scene_break_divider')
        .setLabel(cfg.lblMetaSceneBreakDivider)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200)
        .setValue(state.sceneBreakDivider ?? '')
        .setPlaceholder(cfg.txtMetaSceneBreakDividerPlaceholder ?? '')
    );
}
