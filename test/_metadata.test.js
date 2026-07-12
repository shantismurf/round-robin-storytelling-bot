import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crossesBarrier, formatWarnings, isRestricted } from '../story/_metadata.js';

describe('isRestricted', () => {
  test('M and E are restricted', () => {
    assert.equal(isRestricted('M'), true);
    assert.equal(isRestricted('E'), true);
  });
  test('NR, G, T are not restricted', () => {
    assert.equal(isRestricted('NR'), false);
    assert.equal(isRestricted('G'), false);
    assert.equal(isRestricted('T'), false);
  });
});

describe('crossesBarrier', () => {
  test('moving from unrestricted to restricted crosses the barrier', () => {
    assert.equal(crossesBarrier('T', 'M'), true);
  });
  test('moving from restricted to unrestricted crosses the barrier', () => {
    assert.equal(crossesBarrier('M', 'T'), true);
  });
  test('moving between two unrestricted ratings does not cross', () => {
    assert.equal(crossesBarrier('NR', 'T'), false);
  });
  test('moving between two restricted ratings does not cross', () => {
    assert.equal(crossesBarrier('M', 'E'), false);
  });
});

describe('formatWarnings', () => {
  test('maps option keys to display labels via the provided map', () => {
    const labels = { optWarnViolence: 'Violence', optWarnMinors: 'Minors' };
    const result = formatWarnings('optWarnViolence,optWarnMinors', labels);
    assert.equal(result, 'Violence, Minors');
  });
  test('falls back to the raw key when no label is present (regression guard for audit 1.33)', () => {
    // 1.33: buildMetadataFields used to key its label map by display label instead of
    // option key, so every lookup missed and fell back to the raw key — this test
    // pins the fallback behavior of formatWarnings itself, independent of that bug.
    const result = formatWarnings('optWarnUnspecified', {});
    assert.equal(result, 'optWarnUnspecified');
  });
  test('returns null for empty input', () => {
    assert.equal(formatWarnings('', {}), null);
    assert.equal(formatWarnings(null, {}), null);
  });
  test('trims whitespace and drops empty entries', () => {
    const labels = { optWarnViolence: 'Violence' };
    const result = formatWarnings('optWarnViolence, ,', labels);
    assert.equal(result, 'Violence');
  });
});
