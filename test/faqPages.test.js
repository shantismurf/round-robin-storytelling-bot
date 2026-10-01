// Layer-1 coverage for the help page definitions in faq.js.
//
// These guard three failure modes that have all actually bitten this project:
//   1. A PAGE_DEFS entry naming a config key that does not exist. Per CLAUDE.md a missing
//      config value is a logged error with no fallback, so the section renders as `undefined`
//      in the reader's face. Ground Rules shipped in 3.6.0 with no help coverage at all, which
//      is the same class of gap seen from the other side.
//   2. The jump targets of handleWriterHelp/handleAdminHelp. These used to be raw indices
//      (PAGE_DEFS[6], PAGE_DEFS[7]) guarded by a comment -- reordering the array silently
//      pointed /mystory help and /storyadmin help at the wrong page. They resolve by id now,
//      and pageById throws on an unknown one, so the guard is that those ids still exist.
//   3. A page outgrowing Discord's 4096-char embed description cap. There is roughly 2k of
//      headroom on the largest page today, and the help redesign plan intends to add content.
//
// No DB and no Discord connection: config values are read straight out of the SQL seed file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_DEFS, collectKeys, renderEntries, buildPageEmbed, pageById } from '../faq.js';

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

describe('page jump targets', () => {
  // These asserted PAGE_DEFS[6] and [7] until pages gained ids. Both pages still happen to sit
  // at those indices, so keeping the index assertions would have passed on a coincidence and
  // guarded nothing -- the handlers no longer read the array by position at all.
  test('/mystory help resolves to the writer command page', () => {
    assert.equal(pageById('writer-commands').titleKey, 'txtHelp7Title');
  });

  test('/storyadmin help resolves to the first admin page', () => {
    assert.equal(pageById('admin-server-setup').titleKey, 'txtHelp8Title');
  });

  test('both jumped-to pages carry the footer their handlers read', () => {
    // handleWriterHelp and handleAdminHelp both call setFooter unconditionally.
    for (const id of ['writer-commands', 'admin-server-setup']) {
      const page = pageById(id);
      assert.ok(page.footerKey, `page "${id}" has no footerKey`);
      assert.ok(page.footerKey in cfg, `${page.footerKey} has no config row`);
    }
  });
});

describe('pages are addressed by id, never by position', () => {
  // Three things used to index PAGE_DEFS positionally: the two direct jumps, the contents menu's
  // option values, and the Hub FAQ thread map. Splitting or reordering a page silently repointed
  // all three, and for the FAQ sync that meant overwriting the wrong forum thread.
  test('every page has a unique, url-safe id', () => {
    const ids = PAGE_DEFS.map(p => p.id);
    assert.ok(ids.every(Boolean), 'a page is missing its id');
    assert.equal(new Set(ids).size, ids.length, 'two pages share an id');
    for (const id of ids) assert.match(id, /^[a-z0-9-]+$/, `id "${id}" is not url-safe`);
  });

  test('the ids the jump commands depend on still exist', () => {
    // /mystory help and /storyadmin help call pageById with these two literals.
    assert.ok(pageById('writer-commands'));
    assert.ok(pageById('admin-server-setup'));
  });

  test('pageById refuses an unknown id rather than returning undefined', () => {
    assert.throws(() => pageById('no-such-page'), /no help page with id/);
  });

  test('the admin pages each stay well inside the embed cap', () => {
    // The split exists because one page had reached 4095 of 4096. Assert headroom, not just
    // that it fits -- a page with 60 characters spare is a page that breaks on the next edit.
    for (const id of ['admin-server-setup', 'admin-story-setup', 'admin-commands']) {
      const len = renderEntries(pageById(id).entries, cfg).length;
      assert.ok(len < EMBED_DESCRIPTION_LIMIT - 1000,
        `page "${id}" renders ${len} chars, too close to the ${EMBED_DESCRIPTION_LIMIT} cap`);
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
    // LeeAnn's rewrite covers both restricted channels in one entry rather than naming each.
    assert.match(rendered, /Restricted Story Feed and Media Channels/);
  });

  test('the setup section explains both permission tiers', () => {
    // The two-tab explanation lives in the Setup intro now -- the section that used to carry it
    // was renamed Story Admin Role and narrowed to the role field itself.
    assert.match(cfg.txtHelp8Setup, /Server Admin/);
    assert.match(cfg.txtHelp8Setup, /Story Admin/);
  });
});

describe('buildPageEmbed', () => {
  // The Hub FAQ forum and the three interactive paths all render through this one function, so
  // the forum copy cannot drift from what people see in Discord. The forum previously posted
  // plain message content, which caps at 2000 rather than 4096 -- page 8 was already past that
  // and had been silently failing to post.
  test('every page produces an embed Discord will accept', () => {
    for (const page of PAGE_DEFS) {
      const json = buildPageEmbed(page, cfg, renderEntries(page.entries, cfg)).toJSON();
      assert.equal(json.title, cfg[page.titleKey]);
      assert.ok(json.description.length > 0, `${page.titleKey} has an empty description`);
      assert.ok(json.description.length <= EMBED_DESCRIPTION_LIMIT);
    }
  });

  test('the footer is set only for pages that declare one', () => {
    for (const page of PAGE_DEFS) {
      const json = buildPageEmbed(page, cfg, 'body').toJSON();
      if (page.footerKey) assert.equal(json.footer?.text, cfg[page.footerKey]);
      else assert.equal(json.footer, undefined, `${page.titleKey} got a footer it does not declare`);
    }
  });
});

describe('the 3.7.0 help restructure', () => {
  // The order below is LeeAnn's, agreed 2026-10-01: what the bot is, how to start a story, how
  // to join one, how to write a turn, then your own stories, running one, reading, reference and
  // admin. It is asserted in full because the order is a decision, not an implementation detail
  // -- an accidental reorder should fail here rather than quietly reshuffle the contents menu.
  test('the pages are in the agreed reading order', () => {
    assert.deepEqual(PAGE_DEFS.map(p => p.id), [
      'overview',
      'create-general',
      'create-join-metadata',
      'find-join',
      'writing-your-entry',
      'your-stories',
      'managing-a-story',
      'reading-editing',
      'writer-commands',
      'admin-server-setup',
      'admin-story-setup',
      'admin-commands',
    ]);
  });

  test('the overview page carries no headings', () => {
    // Deliberate: it is a conversational introduction, not the topical reference every other
    // page is. Adding a lbl to any of its entries would turn it back into a sectioned page.
    const headed = pageById('overview').entries.filter(e => e.lbl);
    assert.deepEqual(headed, [], 'the overview page gained a section heading');
  });

  test('find-join and writing-your-entry have title keys of their own', () => {
    // Both were section headings inside other pages before the split. Pointing either titleKey
    // back at a lblHelp2* key would make the page title and its first heading identical.
    assert.equal(pageById('find-join').titleKey, 'txtHelpFindJoinTitle');
    assert.equal(pageById('writing-your-entry').titleKey, 'txtHelpWritingTitle');
  });

  test('no two pages share a title', () => {
    // The contents menu labels every option from its page title, so a duplicate is unpickable.
    const titles = PAGE_DEFS.map(p => cfg[p.titleKey]);
    assert.equal(new Set(titles).size, titles.length, `duplicate page title: ${titles.join(' | ')}`);
  });

  test('the contents menu intro exists and links the Hub', () => {
    assert.ok((cfg.txtHelpTocIntro ?? '').trim(), 'txtHelpTocIntro has no value');
    assert.match(cfg.txtHelpTocIntro, /\[hubInviteUrl\]/,
      'the intro must carry the token, since buildTocEmbed substitutes it');
  });

  test('a label-less entry renders its body with no heading', () => {
    const out = renderEntries([{ txt: 'k' }], { k: 'lead paragraph' });
    assert.equal(out, 'lead paragraph');
    assert.ok(!out.includes('#'), 'a label-less entry rendered a heading');
  });

  test('collectKeys skips a label-less entry rather than emitting undefined', () => {
    // It used to push entry.lbl unconditionally, so a label-less entry put `undefined` into the
    // key list handed to getConfigValue.
    assert.deepEqual(collectKeys([{ txt: 'k' }]), ['k']);
    assert.ok(!collectKeys(PAGE_DEFS.flatMap(p => p.entries)).includes(undefined));
  });
});
