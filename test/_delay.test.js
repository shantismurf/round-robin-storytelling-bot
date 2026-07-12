import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkStoryDelay } from '../story/_delay.js';
import { STORY_STATUS } from '../constants.js';
import { makeFakeConnection } from './_fakeConnection.js';

// checkStoryDelay reads getConfigValue via the shared utilities module for the
// unmet-condition message strings. We don't fake that import — getConfigValue itself
// takes a connection, so it flows through the same fake connection's execute() queue.

describe('checkStoryDelay', () => {
  test('activates when writer-count threshold is met and story is DELAYED', async () => {
    const conn = makeFakeConnection([
      // SELECT story_status, story_delay_hours, story_delay_users, created_at, turn_length_hours, guild_id
      [{ story_status: STORY_STATUS.DELAYED, story_delay_hours: 0, story_delay_users: 3, created_at: new Date(), turn_length_hours: 24, guild_id: 1 }],
      // SELECT COUNT(*) writer count
      [{ count: 3 }],
      // UPDATE story SET story_status = ACTIVE
      { affectedRows: 1 },
    ]);
    const result = await checkStoryDelay(conn, 42);
    assert.equal(result.madeActive, true);
  });

  test('does not activate when writer-count threshold is not yet met', async () => {
    const conn = makeFakeConnection([
      [{ story_status: STORY_STATUS.DELAYED, story_delay_hours: 0, story_delay_users: 5, created_at: new Date(), turn_length_hours: 24, guild_id: 1 }],
      [{ count: 2 }],
      // getConfigValue('txtMoreWritersDelay', ...) — config lookup
      [{ config_value: 'Need X more writers' }],
    ]);
    const result = await checkStoryDelay(conn, 42);
    assert.equal(result.madeActive, false);
    assert.match(result.writerDelayMessage, /3/);
  });

  test('activates when hour delay has elapsed and story is DELAYED', async () => {
    const createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    const conn = makeFakeConnection([
      [{ story_status: STORY_STATUS.DELAYED, story_delay_hours: 24, story_delay_users: 0, created_at: createdAt, turn_length_hours: 24, guild_id: 1 }],
      { affectedRows: 1 },
    ]);
    const result = await checkStoryDelay(conn, 42);
    assert.equal(result.madeActive, true);
  });

  test('does not activate when hour delay has not yet elapsed', async () => {
    const createdAt = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago
    const conn = makeFakeConnection([
      [{ story_status: STORY_STATUS.DELAYED, story_delay_hours: 24, story_delay_users: 0, created_at: createdAt, turn_length_hours: 24, guild_id: 1 }],
      [{ config_value: 'X hours left' }],
    ]);
    const result = await checkStoryDelay(conn, 42);
    assert.equal(result.madeActive, false);
    assert.match(result.hourDelayMessage, /23/);
  });

  test('does not re-activate an already-active story (regression guard for audit 1.9)', async () => {
    // Before the 1.9 fix, this guard compared story_status !== 2 instead of === 4 (DELAYED),
    // so an ACTIVE story with a stray delay job would never hit this early-return correctly.
    const conn = makeFakeConnection([
      [{ story_status: STORY_STATUS.ACTIVE, story_delay_hours: 0, story_delay_users: 0, created_at: new Date(), turn_length_hours: 24, guild_id: 1 }],
    ]);
    const result = await checkStoryDelay(conn, 42);
    assert.equal(result.madeActive, false);
  });

  test('returns madeActive:false for a nonexistent story', async () => {
    const conn = makeFakeConnection([[]]);
    const result = await checkStoryDelay(conn, 999);
    assert.equal(result.madeActive, false);
  });
});
