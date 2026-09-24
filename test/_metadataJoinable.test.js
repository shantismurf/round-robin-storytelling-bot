import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isStoryJoinable } from '../story/_metadata.js';
import { STORY_STATUS } from '../constants.js';

// Shared by the pinned status embed and the feed creation announcement. If these two ever
// disagree about what "open for joining" means, a reader sees a button that immediately
// refuses them, or no button on a story they could have joined.
describe('isStoryJoinable', () => {
  const open = { story_status: STORY_STATUS.ACTIVE, allow_joins: 1, max_writers: null };

  test('an active story with joins on and no cap is joinable', () => {
    assert.equal(isStoryJoinable(open, 1), true);
  });

  test('a closed story is not', () => {
    assert.equal(isStoryJoinable({ ...open, story_status: STORY_STATUS.CLOSED }, 1), false);
  });

  test('a delayed story still is — it is waiting on writers', () => {
    assert.equal(isStoryJoinable({ ...open, story_status: STORY_STATUS.DELAYED }, 1), true);
  });

  test('joins turned off closes it', () => {
    assert.equal(isStoryJoinable({ ...open, allow_joins: 0 }, 1), false);
  });

  test('at capacity is not joinable, below capacity is', () => {
    assert.equal(isStoryJoinable({ ...open, max_writers: 3 }, 3), false);
    assert.equal(isStoryJoinable({ ...open, max_writers: 3 }, 2), true);
  });

  test('over capacity is not joinable', () => {
    assert.equal(isStoryJoinable({ ...open, max_writers: 3 }, 4), false);
  });

  test('a missing story is not joinable rather than throwing', () => {
    assert.equal(isStoryJoinable(null, 0), false);
    assert.equal(isStoryJoinable(undefined, 0), false);
  });
});
