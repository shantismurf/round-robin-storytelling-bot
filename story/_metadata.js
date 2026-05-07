/**
 * Shared AO3 metadata helpers used by add, manage, read, list, and export.
 *
 * Ratings that require a restricted feed channel (M and E).
 */

export const restrictedRatings = new Set(['M', 'E']);

export const ratingLabels = {
  NR: 'txtRatingNR',
  G:  'txtRatingG',
  T:  'txtRatingT',
  M:  'txtRatingM',
  E:  'txtRatingE',
};

export const ratingBadge = {
  NR: 'txtRatingBadgeNR',
  G:  'txtRatingBadgeG',
  T:  'txtRatingBadgeT',
  M:  'txtRatingBadgeM',
  E:  'txtRatingBadgeE',
};

export const warningOptions = [
  'optWarnAllClear',
  'optWarnViolence',
  'optWarnCharacterDeath',
  'optWarnOther',
  'optWarnNonCon',
  'optWarnMinors',
  'optWarnUnspecified',
];

export const dynamicOptions = [
  'optDynamicGeneral',
  'optDynamicFF',
  'optDynamicFM',
  'optDynamicMM',
  'optDynamicPoly',
  'optDynamicOther',
];

export function isRestricted(rating) {
  return restrictedRatings.has(rating);
}

export function crossesBarrier(oldRating, newRating) {
  return isRestricted(oldRating) !== isRestricted(newRating);
}

/**
 * Formats stored warning CSV for display.
 * warningLabels is a map of optKey -> display string (from cfg).
 */
export function formatWarnings(warningsStr, warningLabels = {}) {
  if (!warningsStr) return null;
  return warningsStr
    .split(',')
    .map(w => w.trim())
    .filter(Boolean)
    .map(w => warningLabels[w] ?? w)
    .join(', ');
}

/**
 * Build a compact AO3-style metadata block for embed fields.
 * Returns an array of { name, value, inline } objects ready for addFields().
 * cfg must contain resolved label strings and rating/badge/warning/dynamic values.
 */
export function buildMetadataFields(story, cfg = {}) {
  const fields = [];

  const badge = cfg[ratingBadge[story.rating]] ?? story.rating ?? '';
  const label = cfg[ratingLabels[story.rating]] ?? story.rating ?? '';
  fields.push({ name: cfg.lblRating, value: `${badge} ${label}`.trim(), inline: true });

  if (story.dynamic) {
    fields.push({ name: cfg.lblDynamic, value: cfg[story.dynamic] ?? story.dynamic, inline: true });
  }

  if (story.warnings) {
    const warningLabels = Object.fromEntries(
      warningOptions.map(k => [cfg[k], cfg[k]]).filter(([k]) => k)
    );
    const formatted = formatWarnings(story.warnings, warningLabels);
    if (formatted) fields.push({ name: cfg.lblWarnings, value: formatted, inline: false });
  }

  if (story.fandom) {
    fields.push({ name: cfg.lblFandom, value: story.fandom, inline: true });
  }

  if (story.main_pairing) {
    fields.push({ name: cfg.lblMainPairing, value: story.main_pairing, inline: true });
  }

  if (story.other_relationships) {
    fields.push({ name: cfg.lblOtherRelationships, value: story.other_relationships, inline: false });
  }

  if (story.characters) {
    fields.push({ name: cfg.lblCharacters, value: story.characters, inline: false });
  }

  if (story.additional_tags) {
    fields.push({ name: cfg.lblAdditionalTags, value: story.additional_tags, inline: false });
  }

  return fields;
}

/**
 * Resolve which feed channel ID to use for a story, based on its rating.
 */
export async function resolveFeedChannelId(connection, guildId, rating) {
  const { getConfigValue } = await import('../utilities.js');
  const mainFeedId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
  if (!isRestricted(rating)) return mainFeedId;
  const restrictedId = await getConfigValue(connection, 'cfgRestrictedFeedChannelId', guildId);
  if (restrictedId && restrictedId !== 'cfgRestrictedFeedChannelId' && restrictedId !== '') {
    return restrictedId;
  }
  return mainFeedId;
}

/**
 * Resolve which media channel ID to use for a story, based on its rating.
 */
export async function resolveMediaChannelId(connection, guildId, rating) {
  const { getConfigValue } = await import('../utilities.js');
  if (!isRestricted(rating)) {
    return await getConfigValue(connection, 'cfgMediaChannelId', guildId);
  }
  const restrictedMediaId = await getConfigValue(connection, 'cfgRestrictedMediaChannelId', guildId);
  if (restrictedMediaId && restrictedMediaId !== 'cfgRestrictedMediaChannelId' && restrictedMediaId !== '') {
    return restrictedMediaId;
  }
  return await getConfigValue(connection, 'cfgMediaChannelId', guildId);
}
