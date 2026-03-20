-- Add closed_at to story table
-- Stores when a story was closed, used for export metadata and filtering.

ALTER TABLE story ADD COLUMN closed_at TIMESTAMP NULL AFTER story_status;
