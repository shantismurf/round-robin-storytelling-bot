import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAtParagraphs,
  parseDuration,
  formatDuration,
  replaceTemplateVariables,
  trimTrailingEmoji,
  chunkEntryContent,
  createFailureThrottle,
  getConfigValue,
} from '../utilities.js';

describe('splitAtParagraphs', () => {
  test('returns the text unchanged as a single chunk when under maxLen', () => {
    assert.deepEqual(splitAtParagraphs('short text', 100), ['short text']);
  });
  test('splits on a paragraph break near maxLen', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50);
    const chunks = splitAtParagraphs(text, 60);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], 'a'.repeat(50));
    assert.equal(chunks[1], 'b'.repeat(50));
  });
  test('hard-splits when no break point is found', () => {
    const text = 'a'.repeat(200);
    const chunks = splitAtParagraphs(text, 100);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 100);
  });
});

describe('parseDuration', () => {
  test('parses bare numbers as hours', () => {
    assert.equal(parseDuration('24'), 24);
  });
  test('parses single-unit suffixes', () => {
    assert.equal(parseDuration('2d'), 48);
    assert.equal(parseDuration('6h'), 6);
    assert.equal(parseDuration('90m'), 2); // 90 min = 1.5h, rounds to 2
  });
  test('parses combined units', () => {
    assert.equal(parseDuration('2d6h'), 54);
  });
  test('parses decimals', () => {
    assert.equal(parseDuration('1.5d'), 36);
  });
  test('returns NaN for garbage input', () => {
    assert.ok(Number.isNaN(parseDuration('not a duration')));
    assert.ok(Number.isNaN(parseDuration('')));
    assert.ok(Number.isNaN(parseDuration(null)));
  });
});

describe('formatDuration', () => {
  test('formats under 24h as plain hours', () => {
    assert.equal(formatDuration(6), '6 hours');
  });
  test('formats exact multiples of 24h with a days suffix', () => {
    assert.equal(formatDuration(48), '48 hours (2 days)');
  });
  test('formats non-exact multiples with days + remainder hours', () => {
    assert.equal(formatDuration(50), '50 hours (2 days, 2 hours)');
  });
  test('handles zero explicitly rather than falling through', () => {
    assert.equal(formatDuration(0), '0 hours');
  });
});

describe('replaceTemplateVariables', () => {
  test('substitutes [token] placeholders', () => {
    const result = replaceTemplateVariables('Hello [name]!', { name: 'World' });
    assert.equal(result, 'Hello World!');
  });
  test('strips an optional block when its token is missing from the map', () => {
    const result = replaceTemplateVariables('Base{?, extra [missing]?} text', {});
    assert.equal(result, 'Base text');
  });
  test('keeps an optional block when its token is present', () => {
    const result = replaceTemplateVariables('Base{? — [extra]?} text', { extra: 'more' });
    assert.equal(result, 'Base — more text');
  });
});

describe('trimTrailingEmoji', () => {
  test('strips a trailing single emoji', () => {
    assert.equal(trimTrailingEmoji('🔏 Turn Thread Privacy 🔏'), '🔏 Turn Thread Privacy');
  });
  test('strips a trailing compound/ZWJ emoji as one grapheme, not one code point', () => {
    assert.equal(trimTrailingEmoji('🧑‍♂️ Characters 🧑‍♀️'), '🧑‍♂️ Characters');
  });
  test('leaves a label with no trailing emoji untouched, not eating its last letter', () => {
    assert.equal(trimTrailingEmoji('Story Mode'), 'Story Mode');
    assert.equal(trimTrailingEmoji('Writer Order'), 'Writer Order');
  });
  test('leaves a label with only a leading emoji untouched', () => {
    assert.equal(trimTrailingEmoji('📖 Story Title'), '📖 Story Title');
  });
});

describe('createFailureThrottle', () => {
  test('alerts on the first failure and starts the streak at 1', () => {
    const throttle = createFailureThrottle({ burstCount: 2, summaryIntervalMs: 1000 });
    const result = throttle.onFailure();
    assert.deepEqual(result, { show: true, isSummary: false, consecutiveFailures: 1, downForMin: 0 });
  });

  test('keeps alerting on every failure through the end of the burst', () => {
    const throttle = createFailureThrottle({ burstCount: 2, summaryIntervalMs: 1000 });
    throttle.onFailure(); // 1st — burst
    const second = throttle.onFailure(); // 2nd — still within burstCount=2
    assert.equal(second.show, true);
    assert.equal(second.isSummary, false);
    assert.equal(second.consecutiveFailures, 2);
  });

  test('goes quiet once past the burst, before the summary interval elapses', () => {
    const throttle = createFailureThrottle({ burstCount: 2, summaryIntervalMs: 1000 });
    throttle.onFailure(); // 1st
    throttle.onFailure(); // 2nd — end of burst
    const third = throttle.onFailure(); // 3rd — past burst, summary interval not up yet
    assert.equal(third.show, false);
    assert.equal(third.isSummary, false);
    assert.equal(third.consecutiveFailures, 3);
  });

  test('emits a summary once the summary interval has elapsed', async () => {
    const throttle = createFailureThrottle({ burstCount: 1, summaryIntervalMs: 20 });
    throttle.onFailure(); // 1st — burst, also anchors lastAlertAt
    throttle.onFailure(); // 2nd — past burst, quiet
    await new Promise(resolve => setTimeout(resolve, 25));
    const result = throttle.onFailure(); // 3rd — summary interval elapsed
    assert.equal(result.show, true);
    assert.equal(result.isSummary, true);
    assert.equal(result.consecutiveFailures, 3);
  });

  test('onSuccess is a no-op when there is no ongoing failure streak', () => {
    const throttle = createFailureThrottle();
    assert.equal(throttle.onSuccess(), null);
  });

  test('onSuccess reports and resets an ongoing failure streak', () => {
    const throttle = createFailureThrottle({ burstCount: 2, summaryIntervalMs: 1000 });
    throttle.onFailure();
    throttle.onFailure();
    const recovery = throttle.onSuccess();
    assert.equal(recovery.consecutiveFailures, 2);
    assert.equal(typeof recovery.downForMin, 'number');

    // Reset confirmed: the next failure is treated as a fresh first failure, not a continuation.
    const freshFailure = throttle.onFailure();
    assert.deepEqual(freshFailure, { show: true, isSummary: false, consecutiveFailures: 1, downForMin: 0 });
  });
});

describe('chunkEntryContent', () => {
  test('returns a single chunk with full-range positions when under maxChunkSize', () => {
    const chunks = chunkEntryContent('short', 100);
    assert.deepEqual(chunks, [{ text: 'short', start: 0, end: 5 }]);
  });
  test('splits on paragraph breaks and tracks character positions', () => {
    const content = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50);
    const chunks = chunkEntryContent(content, 60);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].start, 0);
    assert.equal(chunks[1].end, content.length);
  });
});

describe('getConfigValue', () => {
  test('treats an empty-string guild config as a valid unset value instead of a missing key', async () => {
    const connection = {
      execute: async (sql, params) => {
        if (sql.includes('IN (')) {
          return [[{ config_key: 'cfgAdminRoleName', config_value: '', guild_id: 1509192156491940011 }]];
        }
        return [[{ config_value: '' }]];
      }
    };

    const value = await getConfigValue(connection, 'cfgAdminRoleName', 1509192156491940011);
    assert.equal(value, '');
  });

  test('preserves empty-string values when fetching multiple keys', async () => {
    const connection = {
      execute: async (sql, params) => {
        if (sql.includes('IN (')) {
          return [[
            { config_key: 'cfgAdminRoleName', config_value: '', guild_id: 1509192156491940011 },
            { config_key: 'cfgStoryFeedChannelId', config_value: '123', guild_id: 1509192156491940011 },
          ]];
        }
        return [[{ config_value: '' }]];
      }
    };

    const values = await getConfigValue(connection, ['cfgAdminRoleName', 'cfgStoryFeedChannelId'], 1509192156491940011);
    assert.equal(values.cfgAdminRoleName, '');
    assert.equal(values.cfgStoryFeedChannelId, '123');
  });
});
