-- Rename the "Teen or Lower Only" config keys to "Ratings Filter" (LeeAnn, 2026-10-04).
--
-- Renamed in place rather than left to the config sync. Two reasons, the second the important one.
-- First, sync-config.js inserts and updates but never deletes, so the old rows would sit in the
-- table unreachable forever. Second, and the one that would actually be felt: a guild's own saved
-- cfgTeenOrLowerOnly row is written by handleSetupSave and appears in no config file, so the sync
-- can never recreate it under the new name. A server with the filter switched on would silently
-- revert to off, because getConfigValue returns the key name for a missing key and the string
-- 'cfgRatingsFilter' is not '1'. Renaming in place carries the saved value across.
--
-- Safe against the unique key on (config_key, guild_id) because deploy.js runs database_setup
-- before sync_config, so no row under a new name exists yet to collide with.
--
-- No semicolons anywhere in these comments -- the migration runner splits on the statement
-- separator before it strips comments, so one here would corrupt the next statement.

UPDATE config SET config_key = 'lblSetupRatingsFilter'          WHERE config_key = 'lblSetupTeenOrLowerOnly';
UPDATE config SET config_key = 'txtSetupEmbedDescRatingsFilter' WHERE config_key = 'txtSetupEmbedDescTeenOrLowerOnly';
UPDATE config SET config_key = 'cfgRatingsFilter'               WHERE config_key = 'cfgTeenOrLowerOnly';
UPDATE config SET config_key = 'lblHelp8RatingsFilter'          WHERE config_key = 'lblHelp8TeenOrLower';
UPDATE config SET config_key = 'txtHelp8RatingsFilter'          WHERE config_key = 'txtHelp8TeenOrLower';
