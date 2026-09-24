import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isManageDirty, STAGED_FIELDS } from '../story/manage.js';

function makeState(overrides = {}) {
  const base = {
    title: 'A Story', summary: 'A summary', storyMode: 1, orderType: 1, showAuthors: 1,
    storyTurnPrivacy: 0, sceneBreakDivider: '', turnLength: 24, timeoutReminder: 50,
    maxWriters: null, dynamic: 'general', rating: 'NR', warnings: ['allclear'],
    mainPairing: '', otherRelationships: '', characters: '', tags: '', groundRules: [],
    allowJoins: 1, targetStatus: 'active',
  };
  const state = { ...base, ...overrides };
  state.originalFields = Object.fromEntries(STAGED_FIELDS.map((key) => [key, base[key]]));
  return state;
}

describe('isManageDirty', () => {
  test('reports clean when nothing has changed from the snapshot', () => {
    const state = makeState();
    assert.equal(isManageDirty(state), false);
  });

  test('reports dirty when a scalar staged field changed', () => {
    const state = makeState({ title: 'A Different Title' });
    assert.equal(isManageDirty(state), true);
  });

  test('reports dirty when a radio-group-staged field changed', () => {
    const state = makeState({ showAuthors: 0 });
    assert.equal(isManageDirty(state), true);
  });

  test('does not report dirty when the warnings array has the same members in a different order', () => {
    const state = makeState({ warnings: ['allclear'] });
    state.warnings = ['allclear']; // same content, would come back from a fresh checkbox submit
    state.originalFields.warnings = ['allclear'];
    // Reorder a multi-value case explicitly, since the single-item case above can't exercise it.
    state.warnings = ['b', 'a'];
    state.originalFields.warnings = ['a', 'b'];
    assert.equal(isManageDirty(state), false);
  });

  test('reports dirty when the warnings array content actually changed', () => {
    const state = makeState({ warnings: ['allclear', 'violence'] });
    assert.equal(isManageDirty(state), true);
  });

  test('is not dirty for an untracked field changing (e.g. activeGroup tab switch)', () => {
    const state = makeState();
    state.activeGroup = 'metadata';
    assert.equal(isManageDirty(state), false);
  });

  test('returns false when originalFields has not been snapshotted yet', () => {
    const state = makeState();
    delete state.originalFields;
    assert.equal(isManageDirty(state), false);
  });

  test('targetStatus (Pause/Resume/Reopen) is never tracked, since it applies immediately rather than being staged', () => {
    // Locks in the 2026-08-22 fix: targetStatus was originally in STAGED_FIELDS, which produced a
    // real bug — Reopen writes state.targetStatus directly (an immediate, already-committed DB
    // write, not a staged Save), which desynced it from the originalFields snapshot and made
    // isManageDirty falsely report unsaved changes right after reopening. Rather than patch that
    // one call site, Pause/Resume was made immediate too (matching Close/Reopen) and targetStatus
    // was dropped from STAGED_FIELDS entirely — so no mutation of it, from any source, should ever
    // register as dirty.
    const state = makeState({ targetStatus: 'closed' });
    state.targetStatus = 'active'; // simulates Reopen, or a Pause/Resume toggle, mutating it directly
    assert.equal(isManageDirty(state), false);
    assert.equal(STAGED_FIELDS.includes('targetStatus'), false);
  });

  test('allowJoins (Close/Open Joins) is never tracked, since it applies immediately rather than being staged', () => {
    // 2026-08-26: allowJoins shares one button row with targetStatus (Pause/Resume/Close/Reopen)
    // under "Change Story Status" — made immediate for the same reason before it could develop the
    // same false-positive bug targetStatus did, and to stop the row itself from being inconsistent
    // (some buttons instant, one silently deferred).
    const state = makeState({ allowJoins: 1 });
    state.allowJoins = 0; // simulates the toggle button mutating it directly
    assert.equal(isManageDirty(state), false);
    assert.equal(STAGED_FIELDS.includes('allowJoins'), false);
  });

  test('groundRules IS tracked and staged behind Save Settings, same shape as warnings', () => {
    assert.equal(STAGED_FIELDS.includes('groundRules'), true);
    const state = makeState({ groundRules: ['keep-it-clean'] });
    state.originalFields.groundRules = ['keep-it-clean'];
    assert.equal(isManageDirty(state), false);
    state.groundRules = ['keep-it-clean', 'anything-goes'];
    assert.equal(isManageDirty(state), true);
  });

  test('groundRules re-selected in a different order is not dirty', () => {
    const state = makeState({ groundRules: ['a', 'b'] });
    state.originalFields.groundRules = ['a', 'b'];
    state.groundRules = ['b', 'a'];
    assert.equal(isManageDirty(state), false);
  });
});
