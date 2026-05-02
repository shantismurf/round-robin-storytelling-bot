-- Rename category column to dynamic on story table
ALTER TABLE story CHANGE COLUMN category dynamic VARCHAR(50) NULL;

-- Rename config keys
UPDATE config SET config_key = 'lblDynamic' WHERE config_key = 'lblCategory';
UPDATE config SET config_key = 'lblMetaDynamic' WHERE config_key = 'lblMetaCategory';
