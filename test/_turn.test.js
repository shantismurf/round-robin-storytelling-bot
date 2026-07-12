import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PickNextWriter } from '../story/_turn.js';
import { makeFakeConnection } from './_fakeConnection.js';

// PickNextWriter's query sequence (see story/_turn.js):
//  1. SELECT next_writer_id FROM story (admin override check)
//  2. SELECT last turn + current writer
//  3. SELECT story_order_type
// Then branches:
//  Round-Robin (2): SELECT active writers, [maybe] prev-turn lookup, used-writers-this-cycle,
//                    [maybe cycle reset] recency rows
//  Random (1) / Fixed (3): SELECT active writers ordered by writer_order

describe('PickNextWriter — admin override', () => {
  test('returns and clears an admin-designated next_writer_id before any order logic', async () => {
    const conn = makeFakeConnection([
      [{ next_writer_id: 77 }],
      { affectedRows: 1 }, // UPDATE clearing next_writer_id
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.equal(result, 77);
    assert.equal(conn.calls.length, 2);
  });
});

describe('PickNextWriter — Random order (type 1)', () => {
  test('excludes the current writer when others are available', async () => {
    const conn = makeFakeConnection([
      [{}], // no override
      [{ turn_id: 10, story_writer_id: 5 }], // last turn: writer 5 just went
      [{ story_order_type: 1 }],
      [{ story_writer_id: 5 }, { story_writer_id: 6 }, { story_writer_id: 7 }], // active writers
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.notEqual(result, 5);
    assert.ok([6, 7].includes(result));
  });

  test('picks the sole writer when they are the only one active', async () => {
    const conn = makeFakeConnection([
      [{}],
      [{ turn_id: 10, story_writer_id: 5 }],
      [{ story_order_type: 1 }],
      [{ story_writer_id: 5 }],
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.equal(result, 5);
  });

  test('returns null when there are no active writers', async () => {
    const conn = makeFakeConnection([
      [{}],
      [{ turn_id: 10, story_writer_id: 5 }],
      [{ story_order_type: 1 }],
      [],
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.equal(result, null);
  });

  test('picks the first active writer when no turn has ever run (story start)', async () => {
    const conn = makeFakeConnection([
      [{}],
      [], // no prior turn
      [{ story_order_type: 1 }],
      [{ story_writer_id: 9 }, { story_writer_id: 10 }],
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.equal(result, 9);
  });
});

describe('PickNextWriter — Fixed order (type 3)', () => {
  test('advances strictly sequentially by writer_order', async () => {
    const conn = makeFakeConnection([
      [{}],
      [{ turn_id: 10, story_writer_id: 6 }], // writer 6 (2nd in list) just went
      [{ story_order_type: 3 }],
      [{ story_writer_id: 5 }, { story_writer_id: 6 }, { story_writer_id: 7 }],
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.equal(result, 7);
  });

  test('wraps around from the last writer back to the first', async () => {
    const conn = makeFakeConnection([
      [{}],
      [{ turn_id: 10, story_writer_id: 7 }], // last writer in the list just went
      [{ story_order_type: 3 }],
      [{ story_writer_id: 5 }, { story_writer_id: 6 }, { story_writer_id: 7 }],
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.equal(result, 5);
  });
});

describe('PickNextWriter — Round-Robin order (type 2), primary cycle path', () => {
  test('picks from the eligible pool (active writers not yet used this cycle)', async () => {
    const conn = makeFakeConnection([
      [{}],
      [{ turn_id: 20, story_writer_id: 5 }], // writer 5 just went (turn 20)
      [{ story_order_type: 2 }],
      [{ story_writer_id: 5 }, { story_writer_id: 6 }, { story_writer_id: 7 }], // active writers
      [{ turn_id: 15 }], // writer 5's previous turn was turn 15
      [{ story_writer_id: 5 }], // writers used strictly between turn 15 and 20 (exclusive..inclusive) — only 5 (its own last turn)
    ]);
    const result = await PickNextWriter(conn, 1);
    // eligible = active writers minus current (5) minus used-this-cycle (5) = {6, 7}
    assert.ok([6, 7].includes(result));
  });

  test('cycle reset: when every other active writer has already gone this cycle, falls back to the recency pool instead of returning null', async () => {
    // This exercises 1.26's documented "cycle reset" fallback: once every writer besides
    // the current one has taken a turn in the current cycle, the eligible-pool path comes
    // up empty and PickNextWriter must not silently strand the story.
    const conn = makeFakeConnection([
      [{}],
      [{ turn_id: 40, story_writer_id: 5 }],
      [{ story_order_type: 2 }],
      [{ story_writer_id: 5 }, { story_writer_id: 6 }, { story_writer_id: 7 }], // 3 active writers
      [{ turn_id: 10 }], // writer 5's previous turn
      // used-writer rows between turn 10 (exclusive) and 40 (inclusive): everyone has gone
      [{ story_writer_id: 5 }, { story_writer_id: 6 }, { story_writer_id: 7 }],
      // recency rows for the cycle-reset pool (sw_status = ACTIVE)
      [
        { story_writer_id: 5, last_turn_id: 40 },
        { story_writer_id: 6, last_turn_id: 30 },
        { story_writer_id: 7, last_turn_id: 20 },
      ],
    ]);
    const result = await PickNextWriter(conn, 1);
    // n=3, excludeCount = ceil(3*0.25) = 1 -> drop only the most-recent (writer 5, last_turn_id 40)
    // fairPool = [6, 7] filtered to exclude current writer (5, already excluded) -> {6, 7}
    assert.ok([6, 7].includes(result));
    assert.notEqual(result, 5);
  });

  test('returns null when no active writers exist for round-robin order', async () => {
    const conn = makeFakeConnection([
      [{}],
      [{ turn_id: 20, story_writer_id: 5 }],
      [{ story_order_type: 2 }],
      [],
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.equal(result, null);
  });

  test('picks randomly among all active writers when no turn has run yet', async () => {
    const conn = makeFakeConnection([
      [{}],
      [], // no prior turn — story start
      [{ story_order_type: 2 }],
      [{ story_writer_id: 8 }, { story_writer_id: 9 }],
    ]);
    const result = await PickNextWriter(conn, 1);
    assert.ok([8, 9].includes(result));
  });
});
