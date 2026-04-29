-- Add turn_id column to job table for turn-level job cancellation

ALTER TABLE job ADD COLUMN IF NOT EXISTS turn_id BIGINT NULL;
