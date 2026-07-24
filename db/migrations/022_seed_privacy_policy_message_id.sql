-- Migration 022: seed cfgPrivacyPolicyMessageId with the ID of the privacy policy
-- message already pinned in the hub server's #rules channel. This key is setup-only
-- (see sync-config.js) so config sync never writes it — syncPrivacyPolicy() in
-- privacy-policy.js takes over from here, editing this message in place on future syncs.

INSERT IGNORE INTO config (config_key, config_value, language_code, guild_id)
VALUES ('cfgPrivacyPolicyMessageId', '1528880125498626179', 'en', 1)
