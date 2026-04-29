-- Add guild_story_id column to story table and backfill per-guild sequential IDs

ALTER TABLE story ADD COLUMN IF NOT EXISTS guild_story_id INT UNSIGNED NOT NULL DEFAULT 0 AFTER story_id;

-- Backfill: assign sequential IDs per guild in story_id order (safe to re-run; only updates rows where 0)
UPDATE story s
JOIN (
  SELECT story_id, ROW_NUMBER() OVER (PARTITION BY guild_id ORDER BY story_id ASC) AS rn
  FROM story
) t ON s.story_id = t.story_id
SET s.guild_story_id = t.rn
WHERE s.guild_story_id = 0;

-- Add unique constraint if it doesn't exist
ALTER TABLE story ADD CONSTRAINT IF NOT EXISTS uq_guild_story UNIQUE (guild_id, guild_story_id);
