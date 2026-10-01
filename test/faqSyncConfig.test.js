// Regression guards for the Hub FAQ duplicate-post bug found 2026-09-25.
//
// cfgFaqPostIds is runtime state: syncFaqPosts writes the thread ids it just created. It was
// also declared as a literal row in config_system.sql, and was not in sync-config.js's
// setupOnlyKeys list -- so step 2 of every deploy resynced the file's eight stale ids over the
// real ones, and step 4's FAQ sync then tried to delete threads that no longer existed. Both
// the fetch and the delete ended in `.catch(() => null)`, so the old posts stayed in the forum,
// a duplicate set was created, and nothing was logged.
//
// The runtime path needs a live Discord connection, so these assert the two file-level
// conditions that made it possible. Either one coming back reintroduces the bug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PAGE_DEFS, parseFaqPostIds, serializeFaqPostIds } from '../faq.js';

const ROOT = new URL('../', import.meta.url);

describe('cfgFaqPostIds is treated as runtime state, not authored config', () => {
  test('no config_files/*.sql declares it', () => {
    const dir = new URL('db/config_files/', ROOT);
    const offenders = readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .filter(f => /^\s*\('cfgFaqPostIds'/m.test(readFileSync(new URL(f, dir), 'utf8')));
    assert.deepEqual(offenders, [],
      `cfgFaqPostIds is declared in ${offenders.join(', ')}. A literal value there gets resynced ` +
      `over the real thread ids on the next deploy, which is what caused duplicate FAQ posts.`);
  });

  test('sync-config.js lists it in setupOnlyKeys', () => {
    const src = readFileSync(new URL('sync-config.js', ROOT), 'utf8');
    const block = src.slice(src.indexOf('const setupOnlyKeys'), src.indexOf('const placeholders'));
    assert.ok(block.length > 0, 'could not locate the setupOnlyKeys declaration');
    assert.match(block, /'cfgFaqPostIds'/,
      'cfgFaqPostIds must stay in setupOnlyKeys so the config sync cannot overwrite the thread ids');
  });
});

describe('the two FAQ sync entry points agree on which guild row they use', () => {
  // The Hub FAQ forum is one shared set of posts built from the guild_id=1 defaults. If these
  // two disagree, one path tracks thread ids the other cannot find, and the forum duplicates.
  const callOf = (file, fnName) => {
    const src = readFileSync(new URL(file, ROOT), 'utf8');
    const m = src.match(new RegExp(`${fnName}\\(([^)]*)\\)`));
    assert.ok(m, `no ${fnName}( call found in ${file}`);
    return m[1].split(',').map(a => a.trim());
  };

  test('deploy.js syncs guild 1', () => {
    assert.equal(callOf('deploy.js', 'await syncFaqPosts').at(-1), '1');
  });

  test('/storyadmin faqsync syncs guild 1, not the invoking guild', () => {
    assert.equal(callOf('commands/storyadmin.js', 'await syncFaqPosts').at(-1), '1');
  });
});

// ---------------------------------------------------------------------------
// cfgFaqPostIds is keyed on page id, and migrates off the old positional format
// ---------------------------------------------------------------------------
//
// The value used to be a bare pipe-delimited list of thread ids, one slot per page, read back
// by array index. Splitting the admin page into three (2026-10-01) would have shifted every
// slot after it, so the next sync would have overwritten the wrong forum thread with no error
// -- the same silent-failure shape as the duplicate-post bug above. Pairs fix that, but only
// if an already-deployed positional value still resolves to the right threads.

const isSnowflake = id => /^\d{17,20}$/.test(id);
const snowflake = n => String(n).repeat(18);

describe('cfgFaqPostIds parsing', () => {
  test('round-trips the pageId:threadId form', () => {
    const map = new Map([['find-join', snowflake(1)], ['admin-commands', snowflake(2)]]);
    assert.deepEqual(parseFaqPostIds(serializeFaqPostIds(map), isSnowflake), map);
  });

  test('migrates a legacy positional value onto the pages it meant', () => {
    const legacy = [1, 2, 3, 4, 5, 6, 7, 8].map(snowflake).join('|');
    const map = parseFaqPostIds(legacy, isSnowflake);
    // The first seven pages did not move, so their threads must still be tracked.
    assert.equal(map.get('find-join'), snowflake(1));
    assert.equal(map.get('writer-commands'), snowflake(7));
    // Slot 8 was the single admin page. Its thread belongs to the page that kept that title,
    // so the sync replaces it rather than abandoning it in the forum.
    assert.equal(map.get('admin-server-setup'), snowflake(8));
    // The two pages split out of it are new and have no thread yet.
    assert.ok(!map.has('admin-story-setup'));
    assert.ok(!map.has('admin-commands'));
  });

  test('a legacy value cannot silently claim a page id it never knew about', () => {
    const map = parseFaqPostIds([1, 2].map(snowflake).join('|'), isSnowflake);
    assert.deepEqual([...map.keys()], ['find-join', 'your-stories']);
  });

  test('drops entries that are not usable thread ids', () => {
    assert.equal(parseFaqPostIds('find-join:not-a-snowflake|garbage', isSnowflake).size, 0);
    assert.equal(parseFaqPostIds('', isSnowflake).size, 0);
    assert.equal(parseFaqPostIds(null, isSnowflake).size, 0);
  });

  test('every id the parser can produce is a page that exists, or is deliberately retired', () => {
    // A legacy slot naming a page that no longer exists is fine -- the sync deletes its thread.
    // What must never happen is a typo'd id in the frozen order silently tracking nothing.
    const legacy = Array.from({ length: 8 }, (_, i) => snowflake(i + 1)).join('|');
    const known = new Set(PAGE_DEFS.map(p => p.id));
    for (const id of parseFaqPostIds(legacy, isSnowflake).keys()) {
      assert.ok(known.has(id), `legacy order names "${id}", which is not a page`);
    }
  });
});
