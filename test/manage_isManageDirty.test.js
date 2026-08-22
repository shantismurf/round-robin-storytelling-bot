import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isManageDirty, STAGED_FIELDS } from '../story/manage.js';

function makeState(overrides = {}) {
  const base = {
    title: 'A Story', summary: 'A summary', storyMode: 1, orderType: 1, showAuthors: 1,
    storyTurnPrivacy: 0, sceneBreakDivider: '', turnLength: 24, timeoutReminder: 50,
    maxWriters: null, dynamic: 'general', rating: 'NR', warnings: ['allclear'],
    mainPairing: '', otherRelationships: '', characters: '', tags: '',
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

  test('reports dirty when a toggle-button-staged field changed', () => {
    const state = makeState({ allowJoins: 0 });
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
});
