import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntryPages } from '../story/_entryRenderer.js';

describe('buildEntryPages', () => {
  test('returns a single page for short content with no partIndex/partCount', () => {
    const pages = buildEntryPages('Once upon a time.', {
      turnNumber: 1, writerName: 'Alice', showAuthors: true, storyEntryId: 100,
    });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].content, 'Once upon a time.');
    assert.equal(pages[0].turnNumber, 1);
    assert.equal(pages[0].writerName, 'Alice');
    assert.equal(pages[0].partIndex, null);
    assert.equal(pages[0].partCount, null);
    assert.equal(pages[0].isFirstChunk, true);
  });

  test('hides the writer name when showAuthors is false', () => {
    const pages = buildEntryPages('Content here.', {
      turnNumber: 1, writerName: 'Alice', showAuthors: false, storyEntryId: 100,
    });
    assert.equal(pages[0].writerName, null);
  });

  test('splits long content into multiple numbered pages', () => {
    const longContent = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000);
    const pages = buildEntryPages(longContent, {
      turnNumber: 2, writerName: 'Bob', showAuthors: true, storyEntryId: 101,
    });
    assert.ok(pages.length > 1);
    assert.equal(pages[0].partIndex, 1);
    assert.equal(pages[0].partCount, pages.length);
    assert.equal(pages[pages.length - 1].partIndex, pages.length);
  });

  test('only the first chunk carries editInfo', () => {
    const longContent = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000);
    const editInfo = { editedByName: 'Alice', editedAt: new Date() };
    const pages = buildEntryPages(longContent, {
      turnNumber: 1, writerName: 'Alice', showAuthors: true, storyEntryId: 100, editInfo,
    });
    assert.equal(pages[0].editInfo, editInfo);
    assert.equal(pages[1].editInfo, null);
  });

  test('applies the scene-break divider before pagination', () => {
    const content = 'Before.\n[[break]]\nAfter.';
    const pages = buildEntryPages(content, {
      turnNumber: 1, writerName: 'Alice', showAuthors: true, storyEntryId: 100,
      sceneBreakDivider: '* * *',
    });
    assert.match(pages[0].content, /\* \* \*/);
    assert.doesNotMatch(pages[0].content, /\[\[break\]\]/);
  });

  test('extracts image URLs only onto the first chunk', () => {
    const url = 'https://cdn.discordapp.com/attachments/123/456/image.png';
    const content = 'a'.repeat(3000) + `\n\n![img](${url})\n\n` + 'b'.repeat(3000);
    const pages = buildEntryPages(content, {
      turnNumber: 1, writerName: 'Alice', showAuthors: true, storyEntryId: 100,
    });
    assert.ok(pages[0].imageUrls.length > 0 || pages.some(p => p.imageUrls.includes(url)));
    // Only the first chunk should ever carry image URLs per the implementation.
    const nonFirstWithImages = pages.slice(1).filter(p => p.imageUrls.length > 0);
    assert.equal(nonFirstWithImages.length, 0);
  });
});
