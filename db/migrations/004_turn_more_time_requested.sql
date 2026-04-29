-- Add more_time_requested column to turn table

ALTER TABLE turn ADD COLUMN IF NOT EXISTS more_time_requested TINYINT(1) NOT NULL DEFAULT 0;
