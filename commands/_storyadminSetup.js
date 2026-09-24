import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, TextDisplayBuilder, SeparatorBuilder, ContainerBuilder, SectionBuilder } from 'discord.js';
import { getConfigValue, getSetupRequiredMessage, log, replaceTemplateVariables, logGuildEvent, checkIsAdmin } from '../utilities.js';
import { finalMessage } from '../story/_metadataModals.js';
import { parseGroundRulesText, effectiveGroundRulesText, formatGroundRuleLabelList } from '../story/_groundRules.js';
import { handleSetupSave } from './_storyadminSetupSave.js';
import { buildChannelsModal, buildRoundupModal, buildSetupFieldModal, handleSetupChannelsModal, handleSetupRoundupModal, handleSetupRoleModal } from './_storyadminSetupFieldModals.js';
import {
  buildGroundRulesModal, handleSetupGroundRulesModal,
  handleSetupGroundRulesConfirm, handleSetupGroundRulesCancel, handleSetupGroundRulesRetry,
} from './_storyadminSetupGroundRules.js';

export const pendingSetupData = new Map();

// Dirty-state detection for the unsaved-changes warning below — same pattern as
// story/manage.js's STAGED_FIELDS/isManageDirty (see that file's comment for the full design
// rationale). Every field a setup modal or toggle button stages before Save is listed here;
// handleSetup() snapshots them into state.originalFields at panel open (when current ===
// original for all of them by construction), and buildSetupPanel() diffs current state against
// that snapshot on every render.
// groundRulesText is deliberately NOT staged here — it writes to cfgGroundRules directly via its
// own authoring flow (commands/_storyadminSetupGroundRules.js), not this panel's Save Settings.
// See that file's header comment for why.
export const STAGED_FIELDS = [
  'feedChannelId', 'mediaChannelId', 'adminRoleName',
  'restrictedFeedChannelId', 'restrictedMediaChannelId',
  'roundupChannelId', 'roundupDay', 'roundupHour', 'changelogEnabled', 'teenOrLowerOnly',
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
 * @param {boolean} [opts.tier1Visible=true] - whether this user can reach the Manage-Server-only
 * fields (feed/media/restricted channels, admin role name) at all — a story admin without
 * Manage Server never sees a tier-1 tab (docs/TODO.md's "two panels within /storyadmin setup
 * itself" design). This is presentation only; every handler that acts on a tier-1 customId
 * re-checks hasTier1Access() live before doing anything, since hiding a button doesn't stop a
 * replayed customId from someone who saw the tier-1 tab.
 * @param {'tier1'|'tier2'} [opts.activeTab='tier1'] - which tab is showing. Ignored (forced to
 * 'tier2') when tier1Visible is false — a story admin has only one tab worth of fields, so no
 * tab bar renders for them at all. A Manage Server holder defaults to tier1 (LeeAnn, 2026-09-24:
 * "I'm a server admin so I should only see full admin options, then I should have to click to a
 * separate tab to see the story admin options") and switches via the tab buttons.
 */
export function buildSetupPanel(state, cfg, { interactive = true, prependMessage = null, tier1Visible = true, activeTab = 'tier1' } = {}) {
  log(`storyadmin setup: buildSetupPanel started`, { show: false, guildName: 'system' });
  const fieldVal = (id) => id ? `<#${id}>` : `\`${cfg.txtNotSet}\``;
  const strVal   = (v)  => v  ? `\`${v}\``  : `\`${cfg.txtNotSet}\``;
  const desc     = (key) => `*${cfg[key]}*`;
  const effectiveTab = tier1Visible ? activeTab : 'tier2';

  const groundRulesLabels = parseGroundRulesText(effectiveGroundRulesText(state.groundRulesText, cfg.txtGroundRulesDefaultVocabulary)).map((r) => r.label);
  const groundRulesDisplay = groundRulesLabels.length
    ? `✅ ${formatGroundRuleLabelList(groundRulesLabels)}`
    : `❌ ${cfg.txtGroundRulesNoneConfigured}`;

  // One field-group per modal/toggle, each rendered as its own unit (a Components V2 Section:
  // its text plus a single button accessory sitting directly beside it) rather than the old
  // shape — every field's text stacked together, then a separate row of buttons below with no
  // visual tie to which field each one edits. LeeAnn, 2026-09-24: "the grouped buttons make no
  // sense... put the button next to the content it relates to." A Section holds 1-3 TextDisplay
  // components plus one button/thumbnail accessory (validated in
  // node_modules/@discordjs/builders/dist/index.js's SectionBuilder.toJSON) — the channels and
  // roundup groups each pack their several related fields into one TextDisplay (already
  // multi-line) rather than needing one Section per single field, since one button already edits
  // all of them together via one modal.
  const fieldGroups = {
    channels: {
      text: [
        desc('txtSetupChannelsPermissionNote'),
        `**${cfg.txtSetupModalTitleFeed}**\n` + desc('txtSetupEmbedDescFeed') + `-> ${fieldVal(state.feedChannelId)}`,
        `**${cfg.txtSetupModalTitleMedia}**\n` + desc('txtSetupEmbedDescMedia') + `-> ${fieldVal(state.mediaChannelId)}`,
        `**${cfg.txtSetupModalTitleRestrictedFeed}**\n` + desc('txtSetupEmbedDescRestrictedFeed') + `-> ${fieldVal(state.restrictedFeedChannelId)}`,
        `**${cfg.txtSetupModalTitleRestrictedMedia}**\n` + desc('txtSetupEmbedDescRestrictedMedia') + `-> ${fieldVal(state.restrictedMediaChannelId)}`,
      ].join('\n\n'),
      button: () => new ButtonBuilder().setCustomId('storyadmin_setup_channels').setLabel(cfg.btnSetupChannels).setStyle(ButtonStyle.Primary),
    },
    role: {
      text: `**${cfg.txtSetupModalTitleRole}**\n` + desc('txtSetupEmbedDescAdminRole') + `-> ${strVal(state.adminRoleName)}`,
      button: () => new ButtonBuilder().setCustomId('storyadmin_setup_role').setLabel(cfg.btnSetupRole).setStyle(ButtonStyle.Primary),
    },
    roundup: {
      text: [
        `**${cfg.txtSetupModalTitleRoundupChannel}**\n` + desc('txtSetupEmbedDescRoundupChannel') + `-> ${state.roundupChannelId ? `<#${state.roundupChannelId}>` : `\`${cfg.txtOff}\``}`,
        `**${cfg.txtSetupModalTitleRoundupDay}**\n` + desc('txtSetupEmbedDescRoundupDay') + `-> ${strVal(state.roundupDay)}`,
        `**${cfg.txtSetupModalTitleRoundupHour}**\n` + desc('txtSetupEmbedDescRoundupHour') + `-> ${strVal(state.roundupHour)}`,
      ].join('\n\n'),
      button: () => new ButtonBuilder().setCustomId('storyadmin_setup_roundup').setLabel(cfg.btnSetupRoundup).setStyle(ButtonStyle.Primary),
    },
    changelog: {
      text: `**${cfg.lblSetupChangelog}**\n` + desc('txtSetupEmbedDescChangelog') + `-> ${state.changelogEnabled ? cfg.txtOn : cfg.txtOff}`,
      button: () => new ButtonBuilder().setCustomId('storyadmin_setup_toggle_changelog').setLabel(`${cfg.lblSetupChangelog}: ${state.changelogEnabled ? cfg.txtOn : cfg.txtOff}`).setStyle(ButtonStyle.Secondary),
    },
    groundRules: {
      text: `**${cfg.txtSetupModalTitleGroundRules}**\n` + desc('txtSetupEmbedDescGroundRules') + `-> ${groundRulesDisplay}`,
      button: () => new ButtonBuilder().setCustomId('storyadmin_setup_groundrules').setLabel(cfg.btnSetupGroundRules).setStyle(ButtonStyle.Primary),
    },
    teenOrLowerOnly: {
      text: `**${cfg.lblSetupTeenOrLowerOnly}**\n` + desc('txtSetupEmbedDescTeenOrLowerOnly') + `-> ${state.teenOrLowerOnly ? cfg.txtOn : cfg.txtOff}`,
      button: () => new ButtonBuilder().setCustomId('storyadmin_setup_toggle_teenorlower').setLabel(`${cfg.lblSetupTeenOrLowerOnly}: ${state.teenOrLowerOnly ? cfg.txtOn : cfg.txtOff}`).setStyle(ButtonStyle.Secondary),
    },
  };

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

  // Tab toggle — only when this user actually has two tabs to switch between. Shown at the top
  // and, per LeeAnn 2026-09-24 (matching the same request already applied to /story add and
  // /story manage), repeated at the bottom too, so switching tabs never needs a scroll back up.
  const buildTabRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_tab_tier1').setLabel(cfg.btnSetupTabServer)
      .setStyle(effectiveTab === 'tier1' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('storyadmin_setup_tab_tier2').setLabel(cfg.btnSetupTabStory)
      .setStyle(effectiveTab === 'tier2' ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  if (tier1Visible && interactive) {
    container.addActionRowComponents(buildTabRow());
    container.addSeparatorComponents(new SeparatorBuilder());
  }

  const groupsForTab = effectiveTab === 'tier1'
    ? [fieldGroups.channels, fieldGroups.role]
    : [fieldGroups.roundup, fieldGroups.changelog, fieldGroups.groundRules, fieldGroups.teenOrLowerOnly];

  groupsForTab.forEach((group, i) => {
    if (interactive) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(group.text))
          .setButtonAccessory(group.button())
      );
    } else {
      // Terminal (non-interactive) state has no buttons at all, so no accessory to give a
      // Section — Discord requires one. Plain text instead.
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(group.text));
    }
    if (i < groupsForTab.length - 1) container.addSeparatorComponents(new SeparatorBuilder());
  });

  if (interactive) {
    if (tier1Visible) {
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addActionRowComponents(buildTabRow());
    }
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
    'txtSetupChannelsPermissionNote',
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
    'btnSetupGroundRules', 'txtSetupModalTitleGroundRules', 'txtSetupEmbedDescGroundRules',
    'txtSetupGroundRulesModalDesc', 'txtGroundRulesNoneConfigured',
    'txtGroundRulesDefaultVocabulary',
    'txtGroundRulesErrCount', 'txtGroundRulesErrRule', 'txtGroundRulesReasonLabelMissing',
    'txtGroundRulesReasonLabelTooLong', 'txtGroundRulesReasonDescTooLong',
    'txtGroundRulesConfirmTitle', 'txtGroundRulesConfirmBody',
    'lblGroundRulesAdded', 'lblGroundRulesRemoved', 'lblGroundRulesRenamed',
    'txtGroundRulesRemovedUsageNote', 'txtGroundRulesRenamedNote',
    'btnGroundRulesConfirm', 'btnGroundRulesCancel', 'btnGroundRulesTryAgain',
    'lblSetupTeenOrLowerOnly', 'txtSetupEmbedDescTeenOrLowerOnly',
    'btnSetupTabServer', 'btnSetupTabStory',
  ], guildId);

  // Load current guild-specific config values without falling back to guild_id=1
  const [cfgRows] = await connection.execute(
    `SELECT config_key, config_value FROM config
     WHERE guild_id = ? AND config_key IN (
       'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName',
       'cfgRestrictedFeedChannelId', 'cfgRestrictedMediaChannelId',
       'cfgWeeklyRoundupChannelId', 'cfgWeeklyRoundupDay', 'cfgWeeklyRoundupHour',
       'cfgChangelogEnabled', 'cfgGroundRules', 'cfgTeenOrLowerOnly'
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
    teenOrLowerOnly:          guildCfg.cfgTeenOrLowerOnly === '1',
    groundRulesText:          guildCfg.cfgGroundRules || '',
    hasManageGuild,
    // Manage Server holders default to the tier-1 tab (LeeAnn, 2026-09-24: "I'm a server admin
    // so I should only see full admin options"). Irrelevant for a tier-2-only story admin —
    // buildSetupPanel forces 'tier2' whenever tier1Visible is false, regardless of this value.
    activeSetupTab: 'tier1',
    originalInteraction: interaction,
    cfg,
  };
  // Baseline for diffGroundRules() on the next authoring-flow submit — see
  // commands/_storyadminSetupGroundRules.js. Not part of STAGED_FIELDS/originalFields below;
  // Ground Rules writes independently of this panel's Save Settings.
  state.originalGroundRulesRules = parseGroundRulesText(state.groundRulesText);
  // Snapshot for isSetupDirty — current === original for every STAGED_FIELDS entry right now,
  // by construction, since state was just built from the DB above.
  state.originalFields = Object.fromEntries(STAGED_FIELDS.map((key) => [key, state[key]]));

  pendingSetupData.set(interaction.user.id, state);
  log(`handleSetup: opening panel for ${interaction.user.tag} in guild ${guildId}`, { show: false, guildName: interaction.guild.name });
  // `setup` is exempt from the gate in index.js, so an admin who installs the bot and comes
  // straight here would otherwise never see the welcome or its prerequisites list — and this
  // is the moment they most need it, since creating a channel or a role means leaving the panel.
  const setupMessage = await getSetupRequiredMessage(connection, interaction);
  const panel = buildSetupPanel(state, cfg, { prependMessage: setupMessage, tier1Visible: hasManageGuild, activeTab: state.activeSetupTab });
  await interaction.reply({
    ...panel,
    flags: panel.flags | MessageFlags.Ephemeral,
  });
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
    return await state.originalInteraction.editReply(buildSetupPanel(state, cfg, { tier1Visible: hasTier1Access(interaction), activeTab: state.activeSetupTab }));
  }
  if (id === 'storyadmin_setup_toggle_teenorlower') {
    state.teenOrLowerOnly = !state.teenOrLowerOnly;
    await interaction.deferUpdate();
    return await state.originalInteraction.editReply(buildSetupPanel(state, cfg, { tier1Visible: hasTier1Access(interaction), activeTab: state.activeSetupTab }));
  }
  if (id === 'storyadmin_setup_tab_tier1' || id === 'storyadmin_setup_tab_tier2') {
    state.activeSetupTab = id === 'storyadmin_setup_tab_tier1' ? 'tier1' : 'tier2';
    await interaction.deferUpdate();
    return await state.originalInteraction.editReply(buildSetupPanel(state, cfg, { tier1Visible: hasTier1Access(interaction), activeTab: state.activeSetupTab }));
  }
  if (id === 'storyadmin_setup_groundrules') {
    return await interaction.showModal(buildGroundRulesModal(cfg, state));
  }
  if (id === 'storyadmin_setup_groundrules_confirm') return await handleSetupGroundRulesConfirm(connection, interaction);
  if (id === 'storyadmin_setup_groundrules_cancel') return await handleSetupGroundRulesCancel(connection, interaction);
  if (id === 'storyadmin_setup_groundrules_retry') return await handleSetupGroundRulesRetry(connection, interaction);
  if (id === 'storyadmin_setup_save') return await handleSetupSave(connection, interaction);
  if (id === 'storyadmin_setup_cancel') return await handleSetupCancel(connection, interaction);
}

export async function handleSetupCancel(connection, interaction) {
  pendingSetupData.delete(interaction.user.id);
  await interaction.deferUpdate();
  // finalMessage() (story/_metadataModals.js) wraps plain text as a one-block V2 Container —
  // {content, embeds: [], components: []} is the pre-V2 shape and is no longer valid once this
  // message carries IsComponentsV2 (see buildSetupPanel's doc comment).
  await interaction.editReply(finalMessage(await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id)));
}
