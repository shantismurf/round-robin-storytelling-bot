// Named status codes for story-engine state fields.
// Values verified against db/init.sql + db/migrations/*.sql (see migration 015 for
// story.mode, migration 003 for story_entry's entry_status ENUM).
// Do not add unrelated numeric constants here (turn numbers, counts, Discord bit
// flags, etc.) — this file is scoped to the five state-machine fields below.

export const STORY_STATUS = Object.freeze({
  ACTIVE: 1,
  PAUSED: 2,
  CLOSED: 3,
  DELAYED: 4,
});

export const TURN_STATUS = Object.freeze({
  ENDED: 0,
  ACTIVE: 1,
});

export const JOB_STATUS = Object.freeze({
  PENDING: 0,
  IN_PROGRESS: 1,
  FAILED: 2,
  CANCELLED: 3,
  COMPLETED: 4,
});

export const WRITER_STATUS = Object.freeze({
  LEFT: 0,
  ACTIVE: 1,
  PAUSED: 2,
});

export const ENTRY_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DISCARDED: 'discarded',
  DELETED: 'deleted',
});

export const STORY_MODE = Object.freeze({
  NORMAL: 0,
  QUICK: 1,
  SLOW: 2,
});
