-- Add show_authors to story table
-- When 1, writer names appear on entry embeds and in the export file.
-- When 0, entries are posted and exported anonymously.

ALTER TABLE story ADD COLUMN show_authors TINYINT(1) DEFAULT 1 AFTER story_turn_privacy;
