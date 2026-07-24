import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discordMarkdownToHtml } from '../story/export.js';
import {
  collectImageUrls,
  refreshAttachmentUrls,
  buildImageStore,
  buildImageDataBlock,
  discordProxyResizeUrl,
  wsrvResizeUrl,
  emojiUrl,
} from '../story/_exportImages.js';

// Builds a fetch-like Response stub. `bytes` sets Content-Length and the body size;
// omit it to have the body match `declaredBytes` (defaults to the buffer's own length).
function fakeResponse({ ok = true, status = 200, contentType = 'image/png', buffer = Buffer.from('fake-image-bytes'), declaredBytes } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => {
        if (name === 'content-type') return contentType;
        if (name === 'content-length') return String(declaredBytes ?? buffer.byteLength);
        return null;
      },
    },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    body: { cancel: async () => {} },
  };
}

describe('collectImageUrls', () => {
  test('extracts and dedups attachment URLs and emoji from raw text', () => {
    const texts = [
      'Look at this <:wave:111> photo ![](https://cdn.discordapp.com/attachments/1/2/a.png)',
      'Same photo again ![](https://cdn.discordapp.com/attachments/1/2/a.png) and <a:party:222>',
    ];
    const { attachmentUrls, emojiUrls } = collectImageUrls(texts);
    assert.deepEqual(attachmentUrls, ['https://cdn.discordapp.com/attachments/1/2/a.png']);
    assert.deepEqual(emojiUrls, [emojiUrl('111', false), emojiUrl('222', true)]);
  });

  test('ignores null/empty texts', () => {
    const { attachmentUrls, emojiUrls } = collectImageUrls([null, '', undefined]);
    assert.deepEqual(attachmentUrls, []);
    assert.deepEqual(emojiUrls, []);
  });
});

describe('discordProxyResizeUrl / wsrvResizeUrl', () => {
  test('rewrites the CDN host to the media proxy and appends resize params', () => {
    const url = discordProxyResizeUrl('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3', 1600);
    assert.equal(url, 'https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3&format=webp&width=1600');
  });

  test('returns null for non-CDN URLs', () => {
    assert.equal(discordProxyResizeUrl('https://example.com/a.png', 1600), null);
  });

  test('builds a wsrv.nl URL with the source URL encoded', () => {
    const url = wsrvResizeUrl('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1', 1600);
    assert.equal(url, `https://wsrv.nl/?url=${encodeURIComponent('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1')}&w=1600&output=webp&q=80`);
  });
});

describe('refreshAttachmentUrls', () => {
  test('batches requests at 50 URLs and merges refreshed_urls into a Map', async () => {
    const urls = Array.from({ length: 60 }, (_, i) => `https://cdn.discordapp.com/attachments/1/${i}/img.png`);
    const calls = [];
    const rest = {
      post: async (route, { body }) => {
        calls.push(body.attachment_urls.length);
        return { refreshed_urls: body.attachment_urls.map(u => ({ original: u, refreshed: `${u}&refreshed=1` })) };
      },
    };
    const map = await refreshAttachmentUrls(rest, urls);
    assert.deepEqual(calls, [50, 10]);
    assert.equal(map.size, 60);
    assert.equal(map.get(urls[0]), `${urls[0]}&refreshed=1`);
  });

  test('returns an empty map without throwing when the REST call fails', async () => {
    const rest = { post: async () => { throw new Error('boom'); } };
    const map = await refreshAttachmentUrls(rest, ['https://cdn.discordapp.com/attachments/1/2/a.png']);
    assert.equal(map.size, 0);
  });

  test('returns an empty map when rest is unavailable', async () => {
    const map = await refreshAttachmentUrls(null, ['https://cdn.discordapp.com/attachments/1/2/a.png']);
    assert.equal(map.size, 0);
  });
});

describe('buildImageStore', () => {
  test('embeds a small image directly as a data URI', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const fetchFn = async () => fakeResponse({ buffer: Buffer.from('small-image') });
    const store = await buildImageStore({
      attachmentUrls: [url], emojiUrls: [], refreshMap: new Map(),
      maxBytes: 1000000, totalBytes: 6000000, resizeWidth: 1600,
      placeholderText: '[unavailable]', fetchFn,
    });
    assert.equal(store.embeddedCount, 1);
    assert.equal(store.failedCount, 0);
    const entry = store.images.get(url);
    assert.match(entry.dataUri, /^data:image\/png;base64,/);
  });

  test('falls back to the discord proxy then wsrv.nl when an image is oversize', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const calls = [];
    const fetchFn = async (fetchUrl) => {
      calls.push(fetchUrl);
      if (fetchUrl === url) return fakeResponse({ declaredBytes: 5_000_000 }); // oversize, triggers resize
      if (fetchUrl.includes('media.discordapp.net')) return { ok: false, status: 500, headers: { get: () => null } };
      if (fetchUrl.includes('wsrv.nl')) return fakeResponse({ buffer: Buffer.from('resized'), contentType: 'image/webp' });
      throw new Error(`unexpected fetch: ${fetchUrl}`);
    };
    const store = await buildImageStore({
      attachmentUrls: [url], emojiUrls: [], refreshMap: new Map(),
      maxBytes: 1_000_000, totalBytes: 6_000_000, resizeWidth: 1600,
      placeholderText: '[unavailable]', fetchFn,
    });
    assert.equal(store.embeddedCount, 1);
    assert.match(store.images.get(url).dataUri, /^data:image\/webp;base64,/);
    assert.ok(calls.some(u => u.includes('media.discordapp.net')));
    assert.ok(calls.some(u => u.includes('wsrv.nl')));
  });

  test('produces a null-dataUri placeholder entry when all fetches fail', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const fetchFn = async () => ({ ok: false, status: 404, headers: { get: () => null } });
    const store = await buildImageStore({
      attachmentUrls: [url], emojiUrls: [], refreshMap: new Map(),
      maxBytes: 1000000, totalBytes: 6000000, resizeWidth: 1600,
      placeholderText: '[unavailable]', fetchFn,
    });
    assert.equal(store.embeddedCount, 0);
    assert.equal(store.failedCount, 1);
    assert.equal(store.images.get(url).dataUri, null);
  });

  test('skips embedding once the total byte budget is exhausted', async () => {
    const urlA = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const urlB = 'https://cdn.discordapp.com/attachments/1/3/b.png';
    const fetchFn = async () => fakeResponse({ buffer: Buffer.alloc(400), declaredBytes: 400 });
    const store = await buildImageStore({
      attachmentUrls: [urlA, urlB], emojiUrls: [], refreshMap: new Map(),
      maxBytes: 1000, totalBytes: 500, resizeWidth: 1600,
      placeholderText: '[unavailable]', fetchFn,
    });
    assert.equal(store.embeddedCount, 1);
    assert.equal(store.failedCount, 1);
  });

  test('uses the refreshed URL for fetching but keys the store by the original URL', async () => {
    const original = 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=old';
    const refreshed = 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=new';
    let fetchedUrl = null;
    const fetchFn = async (u) => { fetchedUrl = u; return fakeResponse(); };
    const store = await buildImageStore({
      attachmentUrls: [original], emojiUrls: [], refreshMap: new Map([[original, refreshed]]),
      maxBytes: 1000000, totalBytes: 6000000, resizeWidth: 1600,
      placeholderText: '[unavailable]', fetchFn,
    });
    assert.equal(fetchedUrl, refreshed);
    assert.ok(store.images.has(original));
  });
});

describe('buildImageDataBlock', () => {
  test('emits a JSON store and loader script keyed by image id, skipping failed entries', () => {
    const store = {
      embeddedCount: 1,
      images: new Map([
        ['https://cdn.discordapp.com/attachments/1/2/a.png', { id: 1, dataUri: 'data:image/png;base64,AAAA' }],
        ['https://cdn.discordapp.com/attachments/1/2/b.png', { id: 2, dataUri: null }],
      ]),
    };
    const block = buildImageDataBlock(store);
    assert.match(block, /storybot-images/);
    assert.match(block, /"1":"data:image\/png;base64,AAAA"/);
    assert.doesNotMatch(block, /"2":/);
  });

  test('returns an empty string when nothing was embedded', () => {
    assert.equal(buildImageDataBlock({ embeddedCount: 0, images: new Map() }), '');
    assert.equal(buildImageDataBlock(null), '');
  });
});

describe('discordMarkdownToHtml image handling', () => {
  test('renders a new-format [text](url) attachment link as a data-storybot-img placeholder, not a CDN src', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const imageStore = {
      images: new Map([[url, { id: 7, dataUri: 'data:image/png;base64,AAAA' }]]),
      placeholderText: '[unavailable]',
    };
    const html = await discordMarkdownToHtml(`[cover art](${url})`, null, null, imageStore);
    assert.match(html, /<img data-storybot-img="7"/);
    assert.doesNotMatch(html, /src="https:\/\/cdn\.discordapp\.com/);
    assert.doesNotMatch(html, /<a href/);
  });

  test('renders a visible placeholder span when the legacy ![]() image could not be embedded', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const imageStore = { images: new Map([[url, { id: 3, dataUri: null }]]), placeholderText: '[unavailable]' };
    const html = await discordMarkdownToHtml(`![](${url})`, null, null, imageStore);
    assert.match(html, /<span class="missing-img">\[unavailable\]<\/span>/);
  });

  test('renders custom and animated emoji as embedded placeholders', async () => {
    const imageStore = {
      images: new Map([
        [emojiUrl('111', false), { id: 1, dataUri: 'data:image/png;base64,AAAA' }],
        [emojiUrl('222', true), { id: 2, dataUri: 'data:image/gif;base64,BBBB' }],
      ]),
      placeholderText: '[unavailable]',
    };
    const html = await discordMarkdownToHtml('<:wave:111> <a:party:222>', null, null, imageStore);
    assert.match(html, /<img data-storybot-img="1"/);
    assert.match(html, /<img data-storybot-img="2"/);
  });

  test('without an imageStore, images always render as placeholders (never a CDN link)', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const html = await discordMarkdownToHtml(`![](${url})`, null, null, null);
    assert.doesNotMatch(html, /cdn\.discordapp\.com/);
    assert.match(html, /class="missing-img"/);
  });
});
