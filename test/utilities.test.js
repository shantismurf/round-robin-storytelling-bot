import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAtParagraphs,
  parseDuration,
  formatDuration,
  replaceTemplateVariables,
  chunkEntryContent,
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
