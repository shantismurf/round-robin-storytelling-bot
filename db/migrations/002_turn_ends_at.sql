-- Add turn_ends_at to turn table
-- Stores the deadline for each turn as a fixed timestamp at turn creation time.
-- This is independent of story turn_length_hours so that changes to turn length
-- take effect on the next turn only, not the current one.
-- Also used by the job runner to schedule reminders and timeout jobs.

ALTER TABLE turn ADD COLUMN turn_ends_at TIMESTAMP NULL AFTER started_at;
