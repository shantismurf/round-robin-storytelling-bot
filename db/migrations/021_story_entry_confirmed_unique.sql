-- Migration 021: prevent duplicate confirmed entries per turn (Fable Audit 1.11).
-- A finalize/timeout race that slips past the app-level guard (endTurnGuarded)
-- could otherwise insert two 'confirmed' story_entry rows for the same turn.
-- Confirmed empty via production query before writing this migration — no
-- existing duplicates, so no de-dupe step needed.
-- The unique index only constrains confirmed rows (via a generated column)
-- since a turn is expected to carry other-status rows too (pending/discarded/
-- deleted) as writers revise before submitting.

ALTER TABLE story_entry
  ADD COLUMN confirmed_turn_id BIGINT UNSIGNED
    GENERATED ALWAYS AS (CASE WHEN entry_status = 'confirmed' THEN turn_id ELSE NULL END) STORED,
  ADD UNIQUE KEY uq_story_entry_confirmed_turn (confirmed_turn_id);
