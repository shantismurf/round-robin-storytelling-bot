// Layer-1 coverage for the help page definitions in faq.js.
//
// These guard three failure modes that have all actually bitten this project:
//   1. A PAGE_DEFS entry naming a config key that does not exist. Per CLAUDE.md a missing
//      config value is a logged error with no fallback, so the section renders as `undefined`
//      in the reader's face. Ground Rules shipped in 3.6.0 with no help coverage at all, which
//      is the same class of gap seen from the other side.
//   2. The raw-index lookups in handleWriterHelp/handleAdminHelp. Both reach into PAGE_DEFS[6]
//      and PAGE_DEFS[7] trusting a comment to stay accurate -- reordering the array silently
//      points /mystory help and /storyadmin help at the wrong page with no error anywhere.
//   3. A page outgrowing Discord's 4096-char embed description cap. There is roughly 2k of
//      headroom on the largest page today, and the help redesign plan intends to add content.
//
// No DB and no Discord connection: config values are read straight out of the SQL seed file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_DEFS, collectKeys, renderEntries } from '../faq.js';

const EMBED_DESCRIPTION_LIMIT = 4096;

// Parse ('key', 'value', 'en', 1) rows out of the help seed file. Values use '' for a literal
// apostrophe and a literal \n for a line break, matching what getConfigValue hands the renderer.
function loadHelpConfig() {
  const sql = readFileSync(new URL('../db/config_files/config_help.sql', import.meta.url), 'utf8');
  const cfg = {};
  const row = /\('((?:txt|lbl|btn)Help[A-Za-z0-9]*)',\s*'([\s\S]*?)',\s*'en',\s*1\)/g;
  for (const m of sql.matchAll(row)) {
    cfg[m[1]] = m[2].replaceAll("''", "'").replaceAll('\\n', '\n');
  }
  return cfg;
}

const cfg = loadHelpConfig();

describe('help page definitions', () => {
  test('the seed file parsed and produced values', () => {
    assert.ok(Object.keys(cfg).length > 50, `only parsed ${Object.keys(cfg).length} help keys`);
  });

  test('every key referenced by PAGE_DEFS exists in config_help.sql', () => {
    const missing = [];
    for (const page of PAGE_DEFS) {
      for (const key of [page.titleKey, ...(page.footerKey ? [page.footerKey] : []), ...collectKeys(page.entries)]) {
        if (!(key in cfg)) missing.push(`${page.titleKey} -> ${key}`);
      }
    }
    assert.deepEqual(missing, [], `PAGE_DEFS references keys with no config row:\n${missing.join('\n')}`);
  });

  test('no page renders past the embed description limit', () => {
    const over = PAGE_DEFS
      .map(page => [page.titleKey, renderEntries(page.entries, cfg).length])
      .filter(([, len]) => len > EMBED_DESCRIPTION_LIMIT);
    assert.deepEqual(over, [], `pages over ${EMBED_DESCRIPTION_LIMIT} chars: ${JSON.stringify(over)}`);
  });

  test('every section declaring a txt key renders a non-empty body', () => {
    // renderEntries does `if (value) parts.push(value)`, so a missing or empty txt value is
    // silently skipped -- the section renders as a bare heading with no body and nothing
    // throws. That is quieter and harder to notice than an "undefined" in the output, so this
    // walks the tree and checks each declared body actually produced text.
    const empty = [];
    const walk = entries => {
      for (const entry of entries) {
        if (entry.txt && !(cfg[entry.txt] ?? '').trim()) empty.push(entry.txt);
        if (entry.children) walk(entry.children);
      }
    };
    for (const page of PAGE_DEFS) walk(page.entries);
    assert.deepEqual(empty, [], `sections whose txt key is missing or empty: ${empty.join(', ')}`);
  });

  test('no rendered page contains the string undefined', () => {
    for (const page of PAGE_DEFS) {
      assert.ok(!renderEntries(page.entries, cfg).includes('undefined'), `${page.titleKey} rendered "undefined"`);
    }
  });
});

describe('raw-index page lookups', () => {
  test('PAGE_DEFS[6] is the writer command page /mystory help jumps to', () => {
    assert.equal(PAGE_DEFS[6].titleKey, 'txtHelp7Title');
  });

  test('PAGE_DEFS[7] is the admin command page /storyadmin help jumps to', () => {
    assert.equal(PAGE_DEFS[7].titleKey, 'txtHelp8Title');
  });

  test('both indexed pages carry the footer their handlers read', () => {
    // handleWriterHelp and handleAdminHelp both call setFooter unconditionally.
    for (const idx of [6, 7]) {
      assert.ok(PAGE_DEFS[idx].footerKey, `PAGE_DEFS[${idx}] has no footerKey`);
      assert.ok(PAGE_DEFS[idx].footerKey in cfg, `${PAGE_DEFS[idx].footerKey} has no config row`);
    }
  });
});

describe('3.6.0 features are documented', () => {
  // Ground Rules, Teen or Lower Only and Hub announcements all shipped without help coverage.
  // These assert the coverage exists rather than asserting its wording, which is LeeAnn's.
  const rendered = PAGE_DEFS.map(p => renderEntries(p.entries, cfg)).join('\n');

  test('Ground Rules is documented for creators and for admins', () => {
    assert.ok(cfg.txtHelp4GroundRules, 'no story-side Ground Rules help');
    assert.ok(cfg.txtHelp8GroundRules, 'no server-side Ground Rules help');
  });

  test('Teen or Lower Only is documented', () => {
    assert.ok(cfg.txtHelp8TeenOrLower, 'no Teen or Lower Only help');
  });

  test('help uses the current channel names, not the pre-3.6.0 ones', () => {
    assert.match(rendered, /Story Media Channel/);
    assert.match(rendered, /Restricted Story Feed Channel/);
    assert.match(rendered, /Restricted Story Media Channel/);
  });

  test('the permissions section explains both setup tabs', () => {
    assert.match(cfg.txtHelp8SetupPermissions, /Server Admin/);
    assert.match(cfg.txtHelp8SetupPermissions, /Story Admin/);
  });
});
