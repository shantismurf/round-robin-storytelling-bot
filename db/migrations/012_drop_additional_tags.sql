-- Remove additional_tags column; all tags now stored in story.tags
ALTER TABLE story DROP COLUMN IF EXISTS additional_tags;
