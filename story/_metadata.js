/**
 * Shared AO3 metadata helpers used by add, manage, read, list, and export.
 *
 * Ratings that require a restricted feed channel (M and E).
 */

import { STORY_STATUS } from '../constants.js';

export const restrictedRatings = new Set(['M', 'E']);

export const ratingCodes = ['NR', 'G', 'T', 'M', 'E'];

export const ratingLabelKey = code => `txtRating${code}`;
export const ratingBadgeKey = code => `txtRatingBadge${code}`;

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

/**
 * Whether a story is open for new writers.
 *
 * Three places ask this question — the pinned in-thread status embed, the feed creation
 * announcement, and (planned) the weekly roundup's open-stories section. Keeping the predicate
 * here stops them drifting apart on what "open" means.
 *
 * @param {{ story_status?: number, allow_joins?: number|boolean, max_writers?: number|null }} story
 * @param {number} activeWriterCount - writers with sw_status = WRITER_STATUS.ACTIVE
 * @returns {boolean}
 */
export function isStoryJoinable(story, activeWriterCount) {
  if (!story) return false;
  if (story.story_status === STORY_STATUS.CLOSED) return false;
  if (!story.allow_joins) return false;
  if (story.max_writers && activeWriterCount >= story.max_writers) return false;
  return true;
}

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
 * Whether a restricted feed channel is configured for this guild. When it's not,
 * policy (decided 2026-07-10) is that all stories — including M/E — stay in the
 * main feed and ratings are informational-only.
 */
export async function isRestrictedChannelConfigured(connection, guildId) {
  const { getConfigValue } = await import('../utilities.js');
  const restrictedId = await getConfigValue(connection, 'cfgRestrictedFeedChannelId', guildId);
  return !!(restrictedId && restrictedId !== 'cfgRestrictedFeedChannelId' && restrictedId !== '');
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
