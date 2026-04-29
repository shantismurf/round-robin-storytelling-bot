-- Rename txtSetupEmbedTitle* config keys to txtSetupEmbedDesc* to reflect their
-- new role as field description text (field names now come from txtSetupModalTitle* keys)

UPDATE config SET config_key = 'txtSetupEmbedDescFeed'            WHERE config_key = 'txtSetupEmbedTitleFeed';
UPDATE config SET config_key = 'txtSetupEmbedDescMedia'           WHERE config_key = 'txtSetupEmbedTitleMedia';
UPDATE config SET config_key = 'txtSetupEmbedDescAdminRole'       WHERE config_key = 'txtSetupEmbedTitleAdminRole';
UPDATE config SET config_key = 'txtSetupEmbedDescRestrictedFeed'  WHERE config_key = 'txtSetupEmbedTitleRestrictedFeed';
UPDATE config SET config_key = 'txtSetupEmbedDescRestrictedMedia' WHERE config_key = 'txtSetupEmbedTitleRestrictedMedia';
UPDATE config SET config_key = 'txtSetupEmbedDescRoundupChannel'  WHERE config_key = 'txtSetupEmbedTitleRoundupChannel';
UPDATE config SET config_key = 'txtSetupEmbedDescRoundupDay'      WHERE config_key = 'txtSetupEmbedTitleRoundupDay';
UPDATE config SET config_key = 'txtSetupEmbedDescRoundupHour'     WHERE config_key = 'txtSetupEmbedTitleRoundupHour';
