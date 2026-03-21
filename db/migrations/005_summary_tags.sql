-- Add summary and tags to story table
-- summary: freeform description of the story, used in /story info and HTML export
-- tags: comma-separated tag string, used in /story info and HTML export

ALTER TABLE story ADD COLUMN summary TEXT NULL;
ALTER TABLE story ADD COLUMN tags TEXT NULL;
