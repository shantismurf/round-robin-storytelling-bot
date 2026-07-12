// Minimal fake DB connection for Layer-1 tests (see docs/Fable_Audit_2026-07.md 4.5).
// Scripts a queue of results: each call to execute() shifts the next entry off the
// queue and returns it as `[rows]`, matching mysql2/promise's execute() return shape.
// Unlike the real pool, this fake has no query-matching — tests must enqueue results
// in the exact order the function under test issues its queries. Read the function's
// source before writing a test to get the order right.

export function makeFakeConnection(resultQueue) {
  const queue = [...resultQueue];
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (queue.length === 0) {
        throw new Error(`makeFakeConnection: execute() called but result queue is empty (call #${calls.length}, sql: ${sql.slice(0, 80)}...)`);
      }
      const next = queue.shift();
      return [next];
    },
  };
}
