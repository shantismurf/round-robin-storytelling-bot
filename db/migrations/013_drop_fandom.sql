-- Remove fandom column; field removed from all UI and export flows
ALTER TABLE story DROP COLUMN IF EXISTS fandom;
