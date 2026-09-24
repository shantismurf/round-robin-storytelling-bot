// Ground Rules server-vocabulary authoring flow for the tier-2 /storyadmin setup panel
// (docs/plans/PLAN-panel-rework-and-ground-rules.md Part 2).
//
// Writes cfgGroundRules directly on Confirm (or immediately for a pure-addition diff), bypassing
// the outer panel's Save Settings staging that every other tier-2 field uses — a rename needs to
// migrate story.ground_rules rows in the same operation as the vocabulary write, which the
// generic STAGED_FIELDS diff (commands/_storyadminSetup.js) has no way to express, and the plan
// is explicit that nothing writes until this flow's own Confirm.
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, TextDisplayBuilder, SeparatorBuilder, ContainerBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, replaceTemplateVariables, log } from '../utilities.js';
import {
  parseGroundRulesText, formatGroundRulesText, validateGroundRules,
  diffGroundRules, isPureAddition, countStoriesUsingSlug, renameGroundRuleSlug,
  slugifyGroundRuleLabel,
} from '../story/_groundRules.js';
import { pendingSetupData, buildSetupPanel, hasTier1Access } from './_storyadminSetup.js';

// Discord's real TextInputStyle.Paragraph cap (node_modules/@discordjs/builders/dist/index.js,
// maxLengthValidator: 1–4000) — not a house rule.
const GROUND_RULES_TEXT_MAX = 4000;

/**
 * @param {object} [opts]
 * @param {string|null} [opts.prefillText] - overrides state's saved text (used to re-show the
 *   admin's own submitted text on validation failure or Cancel, per the plan's "don't discard
 *   their input" rule).
 * @param {string|null} [opts.error] - validation error to show above the field on a re-show.
 */
export function buildGroundRulesModal(cfg, state, { prefillText = null, error = null } = {}) {
  const modal = new ModalBuilder()
    .setCustomId('storyadmin_setup_groundrules_modal')
    .setTitle(cfg.txtSetupModalTitleGroundRules);

  if (error) {
    modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(`❌ ${error}`));
  }
  modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtSetupGroundRulesModalDesc));

  // Pre-filled with the approved default vocabulary only when the guild has genuinely never
  // configured any (state.groundRulesText empty) — once anything has been saved, even a later
  // empty save, the field reflects that instead.
  const defaultValue = prefillText ?? (state.groundRulesText || cfg.txtGroundRulesDefaultVocabulary);
  const textInput = new TextInputBuilder()
    .setCustomId('groundRulesText')
    .setLabel(cfg.txtSetupModalTitleGroundRules)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(GROUND_RULES_TEXT_MAX)
    .setValue((defaultValue ?? '').slice(0, GROUND_RULES_TEXT_MAX));

  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  return modal;
}

function buildGroundRulesConfirmPanel(cfg, diff) {
  const container = new ContainerBuilder().setAccentColor(0xffa500);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${cfg.txtGroundRulesConfirmTitle}`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg.txtGroundRulesConfirmBody));
  container.addSeparatorComponents(new SeparatorBuilder());

  const sections = [];
  if (diff.added.length) {
    sections.push(`**${cfg.lblGroundRulesAdded}:** ${diff.added.map((a) => a.label).join(', ')}`);
  }
  if (diff.removed.length) {
    sections.push(
      `**${cfg.lblGroundRulesRemoved}:**\n` +
      diff.removed.map((r) => replaceTemplateVariables(cfg.txtGroundRulesRemovedUsageNote, { label: r.label, count: String(r.count ?? 0) })).join('\n')
    );
  }
  if (diff.renamed) {
    sections.push(`**${cfg.lblGroundRulesRenamed}:** ` + replaceTemplateVariables(cfg.txtGroundRulesRenamedNote, { old_label: diff.renamed.oldLabel, new_label: diff.renamed.newLabel }));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(sections.join('\n\n')));
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_setup_groundrules_confirm').setLabel(cfg.btnGroundRulesConfirm).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('storyadmin_setup_groundrules_cancel').setLabel(cfg.btnGroundRulesCancel).setStyle(ButtonStyle.Secondary),
  ));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

async function applyGroundRulesSave(connection, state, rules, diff) {
  const formatted = formatGroundRulesText(rules);
  await connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES ('cfgGroundRules', ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [formatted, state.guildId]
  );
  if (diff.renamed) {
    const newSlug = slugifyGroundRuleLabel(diff.renamed.newLabel);
    await renameGroundRuleSlug(connection, state.guildId, diff.renamed.slug, newSlug);
  }
  state.groundRulesText = formatted;
  state.originalGroundRulesRules = rules;
}

export async function handleSetupGroundRulesModal(connection, interaction) {
  const state = pendingSetupData.get(interaction.user.id);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  const cfg = state.cfg;
  const rawText = interaction.fields.getTextInputValue('groundRulesText') ?? '';
  const rules = parseGroundRulesText(rawText);
  const validation = validateGroundRules(rules, cfg);

  if (!validation.valid) {
    log(`handleSetupGroundRulesModal: validation failed guild=${state.guildId}: ${validation.error}`, { show: false, guildName: interaction.guild.name });
    // Must showModal before deferring or replying — verified against installed discord.js source
    // (@discordjs/builders' InteractionResponses.showModal, mixed into ModalSubmitInteraction via
    // InteractionResponses.applyToClass) that a fresh modal-submit interaction can show a new
    // modal directly, no intermediate "Try Again" reply needed.
    return await interaction.showModal(buildGroundRulesModal(cfg, state, { prefillText: rawText, error: validation.error }));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const diff = diffGroundRules(state.originalGroundRulesRules ?? [], rules);
  const tier1Visible = hasTier1Access(interaction);

  if (isPureAddition(diff)) {
    // Nothing existing can break from an addition alone — save immediately, no confirm screen.
    await applyGroundRulesSave(connection, state, rules, diff);
    log(`handleSetupGroundRulesModal: pure-addition save guild=${state.guildId} rules=${rules.length}`, { show: true, guildName: interaction.guild.name });
    await state.originalInteraction.editReply(buildSetupPanel(state, cfg, { tier1Visible }));
    await interaction.deleteReply();
    return;
  }

  // Needs confirmation. Attach a story-usage count to each removed rule for the confirm screen,
  // stash the pending submission on state — nothing is written to cfgGroundRules until Confirm —
  // and swap the panel message to the confirm screen.
  for (const entry of diff.removed) {
    entry.count = await countStoriesUsingSlug(connection, state.guildId, entry.slug);
  }
  state.pendingGroundRules = { rawText, rules, diff };
  log(`handleSetupGroundRulesModal: confirmation required guild=${state.guildId} added=${diff.added.length} removed=${diff.removed.length} renamed=${diff.renamed ? 1 : 0}`, { show: false, guildName: interaction.guild.name });
  await state.originalInteraction.editReply(buildGroundRulesConfirmPanel(cfg, diff));
  await interaction.deleteReply();
}

export async function handleSetupGroundRulesConfirm(connection, interaction) {
  const state = pendingSetupData.get(interaction.user.id);
  if (!state?.pendingGroundRules) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  await interaction.deferUpdate();
  const { rules, diff } = state.pendingGroundRules;
  await applyGroundRulesSave(connection, state, rules, diff);
  log(`handleSetupGroundRulesConfirm: applied guild=${state.guildId} added=${diff.added.length} removed=${diff.removed.length} renamed=${diff.renamed ? 1 : 0}`, { show: true, guildName: interaction.guild.name });
  delete state.pendingGroundRules;
  await state.originalInteraction.editReply(buildSetupPanel(state, state.cfg, { tier1Visible: hasTier1Access(interaction) }));
}

export async function handleSetupGroundRulesCancel(connection, interaction) {
  const state = pendingSetupData.get(interaction.user.id);
  if (!state?.pendingGroundRules) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  const { rawText } = state.pendingGroundRules;
  delete state.pendingGroundRules;
  log(`handleSetupGroundRulesCancel: guild=${state.guildId}`, { show: false, guildName: interaction.guild.name });
  // Fresh, unreplied interaction — safe to showModal directly (same source-verified behavior
  // noted in handleSetupGroundRulesModal above), pre-filled with what was submitted.
  await interaction.showModal(buildGroundRulesModal(state.cfg, state, { prefillText: rawText }));
}
