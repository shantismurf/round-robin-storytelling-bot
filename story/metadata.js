/**
 * Shared AO3 metadata helpers used by add, manage, read, list, and export.
 *
 * Ratings that require a restricted feed channel (M and E).
 */

export const RESTRICTED_RATINGS = new Set(['M', 'E']);

export const RATING_LABELS = {
  NR: '[NR] Not Rated',
  G:  '[G] General',
  T:  '[T] Teen',
  M:  '[M] Mature',
  E:  '[E] Explicit',
};

export const RATING_BADGE = {
  NR: '[NR]',
  G:  '[G]',
  T:  '[T]',
  M:  '[M]',
  E:  '[E]',
};

export const WARNING_OPTIONS = [
  'All Clear: No Content Warnings',
  'Graphic Violence',
  'Main Character Fatality',
  'Other: See Tags',
  'Rape/Lack of Consent',
  'Sex Involving a Minor',
  'Unspecified: Warnings May Apply',
];

export const CATEGORY_OPTIONS = [
  'Gen',
  'F/F',
  'F/M',
  'M/M',
  'Multi',
  'Other',
];

/**
 * Returns true if a rating is on the M/E side of the age barrier.
 */
export function isRestricted(rating) {
  return RESTRICTED_RATINGS.has(rating);
}

/**
 * Returns true if changing from oldRating to newRating crosses the M/E barrier.
 * Both directions (G/T/NR → M/E and M/E → G/T/NR) are considered a crossing.
 */
export function crossesBarrier(oldRating, newRating) {
  return isRestricted(oldRating) !== isRestricted(newRating);
}

/**
 * Formats stored warning CSV for display. Returns '*None*' if empty.
 */
export function formatWarnings(warningsStr) {
  if (!warningsStr) return '*None set*';
  return warningsStr.split(',').map(w => w.trim()).filter(Boolean).join(', ');
}

/**
 * Build a compact AO3-style metadata block for embed fields.
 * Returns an array of { name, value, inline } objects ready for addFields().
 */
export function buildMetadataFields(story, cfg = {}) {
  const fields = [];

  const ratingBadge = RATING_BADGE[story.rating] ?? '[NR]';
  const ratingLabel = RATING_LABELS[story.rating] ?? 'Not Rated';
  fields.push({ name: cfg.lblRating ?? 'Rating', value: `${ratingBadge} ${ratingLabel}`, inline: true });

  if (story.category) {
    fields.push({ name: cfg.lblCategory ?? 'Category', value: story.category, inline: true });
  }

  if (story.warnings) {
    fields.push({ name: cfg.lblWarnings ?? 'Content Warnings', value: formatWarnings(story.warnings), inline: false });
  }

  if (story.fandom) {
    fields.push({ name: cfg.lblFandom ?? 'Fandom', value: story.fandom, inline: true });
  }

  if (story.main_pairing) {
    fields.push({ name: cfg.lblMainPairing ?? 'Main Pairing', value: story.main_pairing, inline: true });
  }

  if (story.other_relationships) {
    fields.push({ name: cfg.lblOtherRelationships ?? 'Other Relationships', value: story.other_relationships, inline: false });
  }

  if (story.characters) {
    fields.push({ name: cfg.lblCharacters ?? 'Characters', value: story.characters, inline: false });
  }

  if (story.additional_tags) {
    fields.push({ name: cfg.lblAdditionalTags ?? 'Additional Tags', value: story.additional_tags, inline: false });
  }

  return fields;
}

/**
 * Resolve which feed channel ID to use for a story, based on its rating.
 * If the story is M or E and a restricted channel is configured, returns that ID.
 * Otherwise returns the main feed channel ID.
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
