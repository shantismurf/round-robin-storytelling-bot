INSERT IGNORE INTO config (config_key, config_value, language_code, guild_id)
SELECT 'cfgGuildRegisteredAt', NOW(), 'en', guild_id
FROM config
WHERE config_key = 'cfgStoryFeedChannelId'
