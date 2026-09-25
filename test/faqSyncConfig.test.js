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
