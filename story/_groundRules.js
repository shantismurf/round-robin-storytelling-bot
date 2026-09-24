/**
 * Ground Rules — server-defined per-story tone/conduct tags.
 * docs/plans/PLAN-panel-rework-and-ground-rules.md Part 2.
 *
 * Storage: the server vocabulary is one guild-scoped config value (cfgGroundRules) holding raw
 * blank-line-delimited "label\ndescription" blocks — same shape used for admin input and for
 * every read, no hidden per-rule ID (same pattern as cfgFaqPostIds). Per-story selection is a
 * comma-delimited list of stable slugs on story.ground_rules, derived from each rule's label —
 * see diffGroundRules()'s doc comment for how a label rename is told apart from a
 * delete-and-recreate.
 */
import { replaceTemplateVariables } from '../utilities.js';

export const GROUND_RULES_MAX_RULES = 10;
export const GROUND_RULES_LABEL_MAX = 40;
// Discord's own checkbox-group option description cap (node_modules/@discordjs/builders/dist/
// index.js, checkboxGroupOptionPredicate: description.lengthLessThanOrEqual(100)) — not a house
// rule like the label cap. A validator built past this would accept text Discord then refuses to
// render as a checkbox option.
export const GROUND_RULES_DESC_MAX = 100;

/**
 * Resolves the raw vocabulary text a guild is actually running: its own saved cfgGroundRules if
 * it has one, otherwise the approved default vocabulary. Per the plan's own words, the defaults
 * are "loaded for every new and existing server" — not merely a pre-fill suggestion shown once
 * in the setup modal. Every read of the vocabulary (the setup panel's display, the story-level
 * checkbox group, and story status/join panel resolution) needs this fallback, not just the
 * modal's own pre-fill — otherwise a guild that predates this feature, or simply hasn't opened
 * the setup modal yet, shows "no rules" and has no Ground Rules to pick from anywhere, when it
 * should be running the same defaults every other unconfigured guild gets.
 */
export function effectiveGroundRulesText(storedText, defaultText) {
  return (storedText && storedText.trim()) ? storedText : (defaultText ?? '');
}

/**
 * Parses the blank-line-delimited vocabulary format into [{ label, description }]. Tolerant of
 * doubled blank lines between blocks (splits on one-or-more consecutive blank lines). Line 1 of
 * each block is the label; remaining line(s) are the description. Blocks with no label (e.g. from
 * stray leading/trailing whitespace) are dropped rather than surfaced as empty rules.
 */
export function parseGroundRulesText(text) {
  if (!text || !text.trim()) return [];
  return text
    .trim()
    .split(/\n\s*\n+/)
    .map((block) => {
      const [labelLine, ...descLines] = block.split('\n');
      return {
        label: (labelLine ?? '').trim(),
        description: descLines.join('\n').trim(),
      };
    })
    .filter((rule) => rule.label);
}

/** Inverse of parseGroundRulesText() — used to pre-fill the modal on open and on re-show. */
export function formatGroundRulesText(rules) {
  return rules.map((r) => (r.description ? `${r.label}\n${r.description}` : r.label)).join('\n\n');
}

/**
 * Validates a parsed rule list against the cap and per-rule length limits. Rejects the whole
 * submission on the first error found (docs/plans's "no partial saves"), naming the offending
 * rule by label (or position, if the label itself is the problem).
 *
 * cfg must carry txtGroundRulesErrCount, txtGroundRulesErrRule, txtGroundRulesReasonLabelMissing,
 * txtGroundRulesReasonLabelTooLong, txtGroundRulesReasonDescTooLong (all replaceTemplateVariables
 * templates — see the config_files entries for their tokens).
 *
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
export function validateGroundRules(rules, cfg) {
  if (rules.length > GROUND_RULES_MAX_RULES) {
    return { valid: false, error: replaceTemplateVariables(cfg.txtGroundRulesErrCount, { max: String(GROUND_RULES_MAX_RULES) }) };
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const position = String(i + 1);
    const ruleRef = rule.label ? `"${rule.label}"` : `#${position}`;
    if (!rule.label) {
      return { valid: false, error: replaceTemplateVariables(cfg.txtGroundRulesErrRule, { rule_ref: `#${position}`, reason: cfg.txtGroundRulesReasonLabelMissing }) };
    }
    if (rule.label.length > GROUND_RULES_LABEL_MAX) {
      return { valid: false, error: replaceTemplateVariables(cfg.txtGroundRulesErrRule, { rule_ref: ruleRef, reason: replaceTemplateVariables(cfg.txtGroundRulesReasonLabelTooLong, { max: String(GROUND_RULES_LABEL_MAX) }) }) };
    }
    if (rule.description.length > GROUND_RULES_DESC_MAX) {
      return { valid: false, error: replaceTemplateVariables(cfg.txtGroundRulesErrRule, { rule_ref: ruleRef, reason: replaceTemplateVariables(cfg.txtGroundRulesReasonDescTooLong, { max: String(GROUND_RULES_DESC_MAX) }) }) };
    }
  }
  return { valid: true };
}

/** Stable slug derived from a rule's label — used as the per-story selection value. */
export function slugifyGroundRuleLabel(label) {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics so accented labels still slugify to ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Diffs the previous vocabulary against a new submission, matched by exact label text (not
 * position — reordering must stay free). Returns:
 *   - unchanged: labels present in both, e.g. { label, slug }
 *   - added / removed: labels only on one side
 *   - renamed: populated ONLY when exactly one label disappeared and exactly one appeared in the
 *     same save — the one case where a rename can be told apart from an unrelated add+remove.
 *     Its `slug` is the OLD slug, not a fresh one from the new label — the save handler must
 *     migrate any story.ground_rules row referencing it (see renameGroundRuleSlugSql below),
 *     because nothing else in this storage design keeps a rule's identity across a label edit.
 *     Multi-swap changes (more than one on each side) are never guessed at — they show as
 *     separate added/removed entries instead, per the plan's own ambiguity rule.
 */
export function diffGroundRules(oldRules, newRules) {
  const oldLabels = oldRules.map((r) => r.label);
  const newLabels = newRules.map((r) => r.label);
  const oldSet = new Set(oldLabels);
  const newSet = new Set(newLabels);

  const unchangedLabels = oldLabels.filter((l) => newSet.has(l));
  const removedLabels = oldLabels.filter((l) => !newSet.has(l));
  const addedLabels = newLabels.filter((l) => !oldSet.has(l));

  const oldSlugByLabel = new Map(oldRules.map((r) => [r.label, slugifyGroundRuleLabel(r.label)]));
  const newSlugByLabel = new Map(newRules.map((r) => [r.label, slugifyGroundRuleLabel(r.label)]));

  const unchanged = unchangedLabels.map((l) => ({ label: l, slug: oldSlugByLabel.get(l) }));
  let removed = removedLabels.map((l) => ({ label: l, slug: oldSlugByLabel.get(l) }));
  let added = addedLabels.map((l) => ({ label: l, slug: newSlugByLabel.get(l) }));
  let renamed = null;

  if (removedLabels.length === 1 && addedLabels.length === 1) {
    renamed = {
      oldLabel: removedLabels[0],
      newLabel: addedLabels[0],
      slug: oldSlugByLabel.get(removedLabels[0]),
    };
    removed = [];
    added = [];
  }

  return { unchanged, removed, added, renamed };
}

/** True when a diff needs no confirmation screen — nothing existing can break from an addition alone. */
export function isPureAddition(diff) {
  return diff.removed.length === 0 && !diff.renamed;
}

/** Number of stories in a guild currently referencing a given slug — for the confirmation screen's "used by N stories" line. */
export async function countStoriesUsingSlug(connection, guildId, slug) {
  const [[{ count }]] = await connection.execute(
    `SELECT COUNT(*) AS count FROM story WHERE guild_id = ? AND FIND_IN_SET(?, ground_rules)`,
    [guildId, slug]
  );
  return Number(count);
}

/**
 * Migrates every story in a guild that references oldSlug to reference newSlug instead —
 * applied once, at save time, for the single-rename case diffGroundRules() detects. Pads with
 * commas so a partial-substring slug (e.g. "keep-it-clean" inside "keep-it-clean-2") can't be
 * matched or replaced by mistake — a plain string REPLACE on the raw column can't tell those
 * apart, FIND_IN_SET-style comma padding can.
 */
export async function renameGroundRuleSlug(connection, guildId, oldSlug, newSlug) {
  if (oldSlug === newSlug) return;
  await connection.execute(
    `UPDATE story
     SET ground_rules = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', ground_rules, ','), CONCAT(',', ?, ','), CONCAT(',', ?, ',')))
     WHERE guild_id = ? AND FIND_IN_SET(?, ground_rules)`,
    [oldSlug, newSlug, guildId, oldSlug]
  );
}

/**
 * Resolves a story's stored slugs against the guild's current vocabulary for display — a slug
 * with no matching current rule (an actually-deleted rule, not a rename) is dropped silently
 * rather than shown as an error, per the plan's storage section.
 */
export function resolveGroundRuleLabels(storedSlugsCsv, currentRules) {
  if (!storedSlugsCsv) return [];
  const storedSlugs = storedSlugsCsv.split(',').map((s) => s.trim()).filter(Boolean);
  if (storedSlugs.length === 0) return [];
  const labelBySlug = new Map(currentRules.map((r) => [slugifyGroundRuleLabel(r.label), r.label]));
  return storedSlugs.map((slug) => labelBySlug.get(slug)).filter(Boolean);
}
