-- Add per-story scene break divider text (dinkus replacement for [[break]])

ALTER TABLE story
  ADD COLUMN IF NOT EXISTS scene_break_divider VARCHAR(200) NULL AFTER summary;
