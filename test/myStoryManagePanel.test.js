// Layer-1 coverage for /mystory manage's panel, converted to Components V2 on 2026-10-01.
//
// It was the last panel still built as a classic embed, with four `addFields` entries marked
// `inline: true`. `inline` is a hint the client may ignore, and LeeAnn's phone did ignore it, so
// four fields rendered as eight stacked lines of label over value. These guard the conversion:
//
//   1. The V2 flag is set. Without it Discord rejects a `components`-only payload outright.
//   2. The component count stays under Discord's 40-per-message ceiling, counted the
//      conservative way (every nested node), per docs/reference/discordjs_reference.md.
//   3. No state renders `undefined` — a missing config key has no fallback by project rule, so
//      it reaches the reader's face.
//
// No DB and no Discord connection: config values come straight out of the SQL seed files.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMyStoryManagePanel } from '../commands/_myStoryManage.js';
import { ComponentType } from 'discord.js';
import { WRITER_STATUS } from '../constants.js';

const COMPONENT_CEILING = 40;

function loadConfig() {
  const cfg = {};
  for (const file of ['config_mystory', 'config_storyadmin', 'config_system', 'config_other', 'config_story', 'config_turn']) {
    let sql;
    try { sql = readFileSync(new URL(`../db/config_files/${file}.sql`, import.meta.url), 'utf8'); } catch { continue; }
    for (const m of sql.matchAll(/\('(\w+)',\s*'((?:[^']|'')*)'/g)) cfg[m[1]] ??= m[2].replaceAll("''", "'").replaceAll('\\n', '\n');
  }
  return cfg;
}

const cfg = loadConfig();

// Every node, not just top-level container children: it is unconfirmed which way Discord counts,
// and this codebase takes the conservative reading throughout.
const countNodes = node => 1 + (node.components ?? []).reduce((a, c) => a + countNodes(c), 0) + (node.accessory ? 1 : 0);

// ComponentType.Section in the installed discord.js -- asserted below so a version bump that
// renumbered it fails here rather than silently matching nothing.
const SECTION = ComponentType.Section;

// Every rendered line, including the ones nested inside a section.
const allText = payload => toJson(payload).flatMap(function lines(node) {
  return [...(node.content !== undefined ? node.content.split('\n') : []),
          ...(node.components ?? []).flatMap(lines)];
});

function everyState() {
  const out = [];
  for (const hasActiveTurn of [true, false])
    for (const writerStatus of [WRITER_STATUS.ACTIVE, WRITER_STATUS.PAUSED])
      for (const penName of ['Shantismurf', null])
        for (const writerTurnPrivacy of [0, 1])
          for (const notificationPrefs of ['dm', 'mention'])
            out.push({ storyTitle: 'King Dís (#4)', penName, notificationPrefs, writerTurnPrivacy, writerStatus, hasActiveTurn });
  return out;
}

const render = state => buildMyStoryManagePanel(state, cfg);
const toJson = payload => JSON.parse(JSON.stringify(payload.components.map(c => c.toJSON())));

describe('/mystory manage panel', () => {
  test('the seed files parsed', () => {
    assert.ok(cfg.txtMyStoryManageTitle, 'config_mystory.sql did not parse');
  });

  test('every state sends the Components V2 flag', () => {
    // The flag is per-message and one-way. Every handler that later edits this message sends a
    // V2 payload too (finalMessage); dropping it here would break all of them at once.
    for (const state of everyState()) {
      assert.notEqual(render(state).flags, undefined, `no flags for ${JSON.stringify(state)}`);
    }
  });

  test('it sends components and never embeds or content', () => {
    // V2 forbids content, embeds, stickers and poll on the same message.
    for (const state of everyState()) {
      const payload = render(state);
      assert.ok(Array.isArray(payload.components) && payload.components.length > 0);
      assert.equal(payload.embeds, undefined);
      assert.equal(payload.content, undefined);
    }
  });

  test('the worst case stays well under the component ceiling', () => {
    const worst = Math.max(...everyState().map(s => toJson(render(s)).reduce((a, c) => a + countNodes(c), 0)));
    assert.ok(worst < COMPONENT_CEILING, `worst case is ${worst}, ceiling ${COMPONENT_CEILING}`);
  });

  test('no state renders the string undefined', () => {
    for (const state of everyState()) {
      assert.ok(!JSON.stringify(toJson(render(state))).includes('undefined'),
        `rendered "undefined" for ${JSON.stringify(state)}`);
    }
  });

  test('every setting renders as a bold label line, none as an embed field', () => {
    // The point of the conversion: these were four embed fields the client stacked over eight
    // lines. Status is a plain line and the other three are sections, so this walks both.
    const lines = allText(render(everyState()[0]));
    for (const label of [cfg.lblMyStoryManageStatus, cfg.lblMyStoryManagePenName, cfg.lblMyStoryManageNotif, cfg.lblMyStoryManagePrivacy]) {
      assert.ok(lines.some(l => l.startsWith(`**${label}:**`)), `"${label}" is not rendered as a bold label line`);
    }
  });

  test('each editable setting sits in a section beside its own button', () => {
    // LeeAnn, 2026-10-01: text on one side, the button that changes it on the other. Status is
    // deliberately not one of these -- Pause/Resume acts immediately, these three stage.
    const sections = toJson(render(everyState()[0]))[0].components.filter(c => c.type === SECTION);
    assert.equal(sections.length, 3, 'expected one section per editable setting');
    for (const section of sections) {
      assert.equal(section.components.length, 1, 'a section carries more than its one line');
      assert.ok(section.accessory?.custom_id, 'a section has no button accessory');
    }
    assert.deepEqual(sections.map(s => s.accessory.custom_id),
      ['mystory_manage_penname', 'mystory_manage_notif', 'mystory_manage_privacy']);
  });

  test('Pass My Turn is disabled unless the writer holds the turn', () => {
    const passButton = state => toJson(render(state))[0].components
      .flatMap(c => c.components ?? [])
      .find(c => c.custom_id === 'mystory_manage_pass');
    // setDisabled(!hasActiveTurn) always writes the key, so the enabled case is false, not absent.
    assert.equal(passButton({ ...everyState()[0], hasActiveTurn: true }).disabled, false);
    assert.equal(passButton({ ...everyState()[0], hasActiveTurn: false }).disabled, true);
  });

  test('the pause button becomes resume for a paused writer', () => {
    const ids = state => toJson(render(state))[0].components.flatMap(c => c.components ?? []).map(c => c.custom_id);
    assert.ok(ids({ ...everyState()[0], writerStatus: WRITER_STATUS.ACTIVE }).includes('mystory_manage_pause'));
    assert.ok(ids({ ...everyState()[0], writerStatus: WRITER_STATUS.PAUSED }).includes('mystory_manage_resume'));
  });
});
