import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { logGuildEvent } from '../utilities.js';
import { makeFakeConnection } from './_fakeConnection.js';

// logGuildEvent's query sequence:
//  1. INSERT INTO guild_event (guild_id, event_type, detail) VALUES (?, ?, ?)

describe('logGuildEvent', () => {
  test('inserts a row with no detail', async () => {
    const conn = makeFakeConnection([{}]);
    await logGuildEvent(conn, '123', 'guild_joined');
    assert.equal(conn.calls.length, 1);
    assert.match(conn.calls[0].sql, /INSERT INTO guild_event/);
    assert.deepEqual(conn.calls[0].params, ['123', 'guild_joined', null]);
  });

  test('inserts a row with a JSON detail payload', async () => {
    const conn = makeFakeConnection([{}]);
    await logGuildEvent(conn, '123', 'setup_saved', { isFirstSetup: true, isOwner: false });
    assert.equal(conn.calls.length, 1);
    assert.deepEqual(conn.calls[0].params, ['123', 'setup_saved', JSON.stringify({ isFirstSetup: true, isOwner: false })]);
  });

  test('does not throw when the insert fails', async () => {
    const conn = makeFakeConnection([]); // empty queue — execute() throws
    await assert.doesNotReject(logGuildEvent(conn, '123', 'guild_joined'));
  });
});
