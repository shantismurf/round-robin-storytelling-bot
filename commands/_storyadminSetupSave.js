// storyadmin setup — save handler, extracted from commands/_storyadminSetup.js
// (docs/plans/PLAN-panel-rework-and-ground-rules.md, "Split the save handler out", step 1 of
// the panel-rework build order). This is the one place that re-validates every setup field and
// writes it to the DB, so it stays a single module rather than being split further along the
// tier-1/tier-2 boundary that commands/_storyadminSetup.js's panel rendering will grow later —
// splitting the save path by tier would duplicate the Manage Server re-check across two files,
// where it would drift. If a tier-2 rendering module is ever added, keep it presentation-only,
// with no enforcement of its own — enforcement belongs here.
import { MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, logGuildEvent } from '../utilities.js';
import { cancelPendingRoundupJobs, scheduleNextRoundup } from '../story/roundup.js';
import { pendingSetupData, buildSetupPanel, STAGED_FIELDS, hasTier1Access } from './_storyadminSetup.js';

export async function handleSetupSave(connection, interaction) {
  const state = pendingSetupData.get(interaction.user.id);
  if (!state) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferUpdate();
  const { guildId } = state;

  const [[{ priorSetupCount }]] = await connection.execute(
    `SELECT COUNT(*) as priorSetupCount FROM config WHERE config_key = 'cfgStoryFeedChannelId' AND guild_id = ?`,
    [guildId]
  );
  const isFirstSetup = Number(priorSetupCount) === 0;
  log(`handleSetupSave: isFirstSetup=${isFirstSetup} for guild ${guildId}`, { show: false, guildName: interaction.guild.name });

  const dayNames = await getConfigValue(connection, [
    'txtRoundupDay0', 'txtRoundupDay1', 'txtRoundupDay2', 'txtRoundupDay3',
    'txtRoundupDay4', 'txtRoundupDay5', 'txtRoundupDay6'
  ], guildId);

  // Re-validate all set channel IDs. V2 forbids editing this message's `content` alongside its
  // `components` (see buildSetupPanel's doc comment), so a validation failure re-renders the
  // unchanged panel and reports the error as a separate ephemeral follow-up rather than the old
  // "spread the panel, then override content" shape.
  const canEditTier1 = hasTier1Access(interaction);

  const reportValidationError = async (key) => {
    await interaction.editReply(buildSetupPanel(state, state.cfg, { tier1Visible: canEditTier1, activeTab: state.activeSetupTab }));
    await interaction.followUp({
      content: await getConfigValue(connection, key, guildId),
      flags: MessageFlags.Ephemeral
    });
  };

  const feedChannel = state.feedChannelId
    ? await interaction.guild.channels.fetch(state.feedChannelId).catch(() => null)
    : null;
  if (!feedChannel) return await reportValidationError('txtSetupFeedChannelInvalid');

  let mediaChannel = null;
  if (state.mediaChannelId) {
    mediaChannel = await interaction.guild.channels.fetch(state.mediaChannelId).catch(() => null);
    if (!mediaChannel) return await reportValidationError('txtSetupMediaChannelInvalid');
  }

  let restrictedFeedChannel = null;
  if (state.restrictedFeedChannelId) {
    restrictedFeedChannel = await interaction.guild.channels.fetch(state.restrictedFeedChannelId).catch(() => null);
    if (!restrictedFeedChannel) return await reportValidationError('txtSetupRestrictedChannelInvalid');
  }

  let restrictedMediaChannel = null;
  if (state.restrictedMediaChannelId) {
    restrictedMediaChannel = await interaction.guild.channels.fetch(state.restrictedMediaChannelId).catch(() => null);
    if (!restrictedMediaChannel) return await reportValidationError('txtSetupRestrictedMediaInvalid');
  }

  // Write config values
  const upsert = (key, value) => connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES (?, ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [key, value, guildId]
  );

  // Tier-1 fields — re-checked live here rather than trusted from state, since a customId from
  // the tier-1 panel (and cfgAdminRoleName specifically — see hasTier1Access's doc comment) can
  // be replayed by anyone who has seen it. A legitimate tier-2 save never changed these values in
  // the first place (no tier-2 button reaches them), so skipping is a safe no-op for the honest
  // case and the actual protection for a tampered one.
  if (canEditTier1) {
    await upsert('cfgStoryFeedChannelId', state.feedChannelId);
    await upsert('cfgMediaChannelId', state.mediaChannelId || '');
    await upsert('cfgRestrictedFeedChannelId', state.restrictedFeedChannelId || '');
    await upsert('cfgRestrictedMediaChannelId', state.restrictedMediaChannelId || '');
    await upsert('cfgAdminRoleName', state.adminRoleName || '');
  } else {
    log(`handleSetupSave: tier-1 fields not written for guild ${guildId} — ${interaction.user.tag} lacks Manage Server`, { show: true, guildName: interaction.guild.name });
  }

  const isOwner = interaction.user.id === interaction.guild.ownerId;
  await logGuildEvent(connection, guildId, 'setup_saved', { isFirstSetup, isOwner });

  // Roundup config
  if (state.roundupChannelId) {
    await upsert('cfgWeeklyRoundupChannelId', state.roundupChannelId);
    await upsert('cfgWeeklyRoundupEnabled', '1');
    await upsert('cfgWeeklyRoundupDay',  state.roundupDay  || '1');
    await upsert('cfgWeeklyRoundupHour', state.roundupHour || '9');
    await cancelPendingRoundupJobs(connection, guildId);
    await scheduleNextRoundup(connection, guildId);
  } else {
    await upsert('cfgWeeklyRoundupEnabled', '0');
    await cancelPendingRoundupJobs(connection, guildId);
  }

  // Changelog / hub announcement opt-out
  await upsert('cfgChangelogEnabled', state.changelogEnabled ? '1' : '0');

  // Teen or Lower Only — tier-2 field, no Manage Server gate needed.
  await upsert('cfgTeenOrLowerOnly', state.teenOrLowerOnly ? '1' : '0');

  const botMember = interaction.guild.members.me;
  // Use the bot's managed integration role for permission overwrites — role-level overrides
  // work on private channels where user/member-level overrides fail due to Discord's restriction
  // that member overrides can only grant permissions already in the caller's effective channel perms.
  const botRole = botMember?.roles.cache.find(r => r.managed) ?? null;

  // Attempt to set bot permissions on the feed channel automatically.
  // Note: As of January 12, 2026, PinMessages is a separate permission from ManageMessages.
  // This may silently fail on private channels — the effective permission check below is the
  // authoritative source of truth, so we don't surface whether this attempt succeeded.
  if (botRole) {
    await feedChannel.permissionOverwrites.edit(botRole, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
      ReadMessageHistory: true,
      ManageMessages: true,
      PinMessages: true,
      CreatePublicThreads: true,
      CreatePrivateThreads: true,
      ManageThreads: true,
    }).catch(() => {});
  }

  // Attempt to set bot permissions on the media channel automatically.
  if (mediaChannel && botRole) {
    await mediaChannel.permissionOverwrites.edit(botRole, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    }).catch(() => {});
  }

  // Grant admin role Manage Threads on the story feed channel so they can
  // see private turn threads without being explicitly added to each one.
  let threadPermissionNote = '';
  if (state.adminRoleName) {
    const adminRole = interaction.guild.roles.cache.find(r => r.name === state.adminRoleName)
      ?? await interaction.guild.roles.fetch().then(roles => roles.find(r => r.name === state.adminRoleName)).catch(() => null);
    if (adminRole) {
      await feedChannel.permissionOverwrites.edit(adminRole, {
        ViewChannel: true,
        ManageThreads: true
      }).catch(() => {});
      threadPermissionNote = ` *(Manage Threads granted on feed channel)*`;
    } else {
      // adminRoleName is free text, matched by exact string (checkIsAdmin does the same) — a
      // typo or case mismatch silently fails to grant anything, with no error shown to the
      // admin. Not fixed here (that's a separate field-type change), but logged so a future
      // "admin role isn't working" report is traceable instead of a guess.
      log(`handleSetupSave: adminRoleName "${state.adminRoleName}" did not match any role in guild ${guildId}`, { show: true, guildName: interaction.guild.name });
    }
  }

  // Check effective bot permissions and warn about any gaps.
  // Re-fetch channels so permission overwrite changes above are reflected.
  const feedChannelFresh = await interaction.guild.channels.fetch(state.feedChannelId).catch(() => feedChannel);
  const mediaChannelFresh = mediaChannel
    ? await interaction.guild.channels.fetch(state.mediaChannelId).catch(() => mediaChannel)
    : null;

  const permWarnings = [];
  if (botMember) {
    const feedPerms = feedChannelFresh.permissionsFor(botMember);
    const feedRequired = [
      ['ViewChannel', 'View Channel'],
      ['SendMessages', 'Send Messages'],
      ['EmbedLinks', 'Embed Links'],
      ['AttachFiles', 'Attach Files'],
      ['ReadMessageHistory', 'Read Message History'],
      ['ManageMessages', 'Manage Messages'],
      ['PinMessages', 'Pin Messages'],
      ['CreatePublicThreads', 'Create Public Threads'],
      ['CreatePrivateThreads', 'Create Private Threads'],
      ['ManageThreads', 'Manage Threads'],
    ];
    const missingFeed = feedRequired.filter(([flag]) => !feedPerms.has(flag)).map(([, label]) => label);
    if (missingFeed.length) {
      permWarnings.push(`⚠️ Bot is missing permissions on <#${state.feedChannelId}>: **${missingFeed.join(', ')}**`);
    }

    if (mediaChannelFresh) {
      const mediaPerms = mediaChannelFresh.permissionsFor(botMember);
      const mediaRequired = [
        ['ViewChannel', 'View Channel'],
        ['SendMessages', 'Send Messages'],
        ['EmbedLinks', 'Embed Links'],
        ['AttachFiles', 'Attach Files'],
      ];
      const missingMedia = mediaRequired.filter(([flag]) => !mediaPerms.has(flag)).map(([, label]) => label);
      if (missingMedia.length) {
        permWarnings.push(`⚠️ Bot is missing permissions on <#${state.mediaChannelId}>: **${missingMedia.join(', ')}**`);
      }
    }
  }

  // Logged so a future "setup finished but something still looked broken" report can check what
  // the admin actually saw, instead of guessing from downstream behavior (e.g. an uninstall).
  // The reply content itself isn't captured anywhere else.
  if (permWarnings.length) {
    log(`handleSetupSave: guild ${guildId} saved with permission warnings: ${permWarnings.map(w => w.replace(/\*\*|⚠️ /g, '')).join(' | ')}`, { show: true, guildName: interaction.guild.name });
  }

  const feedPermsOk = !permWarnings.some(w => w.includes(`<#${state.feedChannelId}>`));
  const mediaPermsOk = !state.mediaChannelId || !permWarnings.some(w => w.includes(`<#${state.mediaChannelId}>`));

  const saved = [`${feedPermsOk ? '✅' : '⚠️'} Story feed channel: <#${state.feedChannelId}>`];
  if (state.mediaChannelId)           saved.push(`${mediaPermsOk ? '✅' : '⚠️'} Media channel: <#${state.mediaChannelId}>`);
  if (state.restrictedFeedChannelId) {
    const rfNote = restrictedFeedChannel?.nsfw ? '' : ' ' + state.cfg.txtSetupAgeRestrictNote;
    saved.push(`✅ Restricted feed channel: <#${state.restrictedFeedChannelId}>${rfNote}`);
  }
  if (state.restrictedMediaChannelId) saved.push(`✅ Restricted media channel: <#${state.restrictedMediaChannelId}>`);
  if (state.adminRoleName)            saved.push(`✅ Admin role: **${state.adminRoleName}**${threadPermissionNote}`);
  if (!state.mediaChannelId)          saved.push(state.cfg.txtSetupNoMediaNote);
  if (!state.adminRoleName)           saved.push(state.cfg.txtSetupNoRoleNote);
  if (state.roundupChannelId)         saved.push(`✅ Weekly roundup: <#${state.roundupChannelId}>, ${dayNames[`txtRoundupDay${state.roundupDay ?? 1}`]}s at ${state.roundupHour ?? 9}:00 UTC`);
  else                                saved.push(state.cfg.txtSetupRoundupDisabledNote);
  saved.push(`${state.changelogEnabled ? '✅' : '🔕'} Hub announcements: ${state.changelogEnabled ? state.cfg.txtOn : state.cfg.txtOff}`);
  saved.push(`${state.teenOrLowerOnly ? '✅' : '🔕'} Teen or Lower Only: ${state.teenOrLowerOnly ? state.cfg.txtOn : state.cfg.txtOff}`);
  if (permWarnings.length) {
    const botRoleName = botRole?.name ?? botMember?.displayName ?? 'the bot role';
    const fixMsg = replaceTemplateVariables(
      await getConfigValue(connection, 'txtSetupBotPermsFix', guildId),
      { feed_channel: `<#${state.feedChannelId}>`, bot_role_name: botRoleName }
    );
    saved.push('', ...permWarnings, '', fixMsg);
  }

  saved.push('', replaceTemplateVariables(state.cfg.txtSetupSupportInvite, { hubInviteUrl: state.cfg.cfgHubInviteUrl }));

  // Refresh the dirty-state baseline now that these values are actually saved, so the panel
  // re-render below doesn't show a stale "Unsaved Changes" banner for changes that just landed.
  state.originalFields = Object.fromEntries(STAGED_FIELDS.map((key) => [key, state[key]]));

  pendingSetupData.delete(interaction.user.id);
  log(`handleSetupSave: complete for guild ${guildId} by ${interaction.user.tag}`, { show: true, guildName: interaction.guild.name });

  if (isFirstSetup) {
    await connection.execute(
      `INSERT IGNORE INTO config (config_key, config_value, language_code, guild_id) VALUES ('cfgGuildRegisteredAt', ?, 'en', ?)`,
      [new Date().toISOString(), guildId]
    );
    log(`🆕 New server setup: **${interaction.guild.name}** (${guildId}) by ${interaction.user.tag}`, { show: true, hub: true });
  }

  // V2 forbids editing this message back to plain content/embeds/components: [] (the old shape
  // here) — see buildSetupPanel's doc comment. Per the plan's chosen fix: leave the panel itself
  // live in its saved, read-only state (interactive: false — pendingSetupData is gone above, so
  // buttons would dead-end into txtActionSessionExpired) and post the detailed summary as a
  // separate ephemeral follow-up rather than overwriting the panel with it.
  await interaction.editReply(buildSetupPanel(state, state.cfg, { interactive: false, tier1Visible: canEditTier1, activeTab: state.activeSetupTab }));
  await interaction.followUp({ content: saved.join('\n'), flags: MessageFlags.Ephemeral });
}
