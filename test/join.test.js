import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateJoinEligibility } from '../story/join.js';
import { makeFakeConnection } from './_fakeConnection.js';

// validateJoinEligibility's query sequence:
//  1. SELECT s.*, writer count (story lookup)
//  2. [if a rejection needs a config message] SELECT config_value
//  3. SELECT existing writer row for this user
//  4. [if joined already] SELECT config_value

describe('validateJoinEligibility', () => {
  test('rejects when the story does not exist', async () => {
    const conn = makeFakeConnection([
      [],
      [{ config_value: 'Story not found' }],
    ]);
    const result = await validateJoinEligibility(conn, 1, 1, 'user1');
    assert.equal(result.success, false);
  });

  test('rejects a closed story', async () => {
    const conn = makeFakeConnection([
      [{ story_id: 1, story_status: 3, allow_joins: 1, max_writers: null, current_writers: 2 }],
      [{ config_value: 'Story is closed' }],
    ]);
    const result = await validateJoinEligibility(conn, 1, 1, 'user1');
    assert.equal(result.success, false);
  });

  test('rejects when joins are disabled', async () => {
    const conn = makeFakeConnection([
      [{ story_id: 1, story_status: 1, allow_joins: 0, max_writers: null, current_writers: 2 }],
      [{ config_value: 'Joins closed' }],
    ]);
    const result = await validateJoinEligibility(conn, 1, 1, 'user1');
    assert.equal(result.success, false);
  });

  test('rejects when the story is at max capacity', async () => {
    const conn = makeFakeConnection([
      [{ story_id: 1, story_status: 1, allow_joins: 1, max_writers: 3, current_writers: 3 }],
      [{ config_value: 'Story is full (max [max_writers])' }],
    ]);
    const result = await validateJoinEligibility(conn, 1, 1, 'user1');
    assert.equal(result.success, false);
    assert.match(result.error, /3/);
  });

  test('rejects a user who already has an active writer row', async () => {
    const conn = makeFakeConnection([
      [{ story_id: 1, story_status: 1, allow_joins: 1, max_writers: null, current_writers: 2 }],
      [{ story_writer_id: 55 }], // existing writer row
      [{ config_value: 'Already joined' }],
    ]);
    const result = await validateJoinEligibility(conn, 1, 1, 'user1');
    assert.equal(result.success, false);
  });

  test('succeeds when all conditions are met', async () => {
    const conn = makeFakeConnection([
      [{ story_id: 1, story_status: 1, allow_joins: 1, max_writers: 5, current_writers: 2 }],
      [], // no existing writer row
    ]);
    const result = await validateJoinEligibility(conn, 1, 1, 'user1');
    assert.equal(result.success, true);
    assert.equal(result.story.story_id, 1);
  });
});
