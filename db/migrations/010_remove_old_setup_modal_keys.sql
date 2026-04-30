-- Remove old setup modal config keys that were replaced by the lbl*/txt* naming convention refactor.
-- Also removes txtNotConfigured (unused) and cfgWeeklyRoundup* / cfgRestricted* guild-specific
-- keys with blank values that were written by old versions of the setup command.

DELETE FROM config WHERE config_key IN (
  'txtSetupModalTitle',
  'lblSetupFeedChannel',
  'txtSetupFeedChannelPlaceholder',
  'lblSetupMediaChannel',
  'txtSetupMediaChannelPlaceholder',
  'lblSetupAdminRole',
  'txtSetupAdminRolePlaceholder',
  'txtNotConfigured',
  'lblSetupRestrictedFeedChannel',
  'txtSetupRestrictedFeedPlaceholder',
  'lblSetupRestrictedMediaChannel',
  'txtSetupRestrictedMediaPlaceholder'
);

-- Remove blank guild-specific roundup/restricted entries written by old setup code.
-- Safe to remove: if blank they have no effect; setup will re-write them when saved.
DELETE FROM config
WHERE config_key IN (
  'cfgRestrictedFeedChannelId',
  'cfgRestrictedMediaChannelId',
  'cfgWeeklyRoundupEnabled',
  'cfgWeeklyRoundupChannelId',
  'cfgWeeklyRoundupDay',
  'cfgWeeklyRoundupHour'
)
AND config_value = ''
AND guild_id != 1;
