import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId, checkIsAdmin } from '../utilities.js';
import { handleManage } from '../story/manage.js';
import { PickNextWriter, NextTurn, skipActiveTurn, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';

async function logAdminAction(connection, adminUserId, actionType, storyId, targetUserId = null, reason = null) {
  try {
    await connection.execute(
      `INSERT INTO admin_action_log (admin_user_id, action_type, target_story_id, target_user_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [adminUserId, actionType, storyId ?? null, targetUserId ?? null, reason ?? null]
    );
  } catch (err) {
    log(`Failed to log admin action: ${err}`, { show: true });
  }
}

// Pending confirmation data keyed by admin user ID
const pendingManageUserData = new Map();

const data = new SlashCommandBuilder()
  .setName('storyadmin')
  .setDescription('Admin tools for story management')
  .addSubcommand(s =>
    s.setName('skip')
      .setDescription('Force-skip the current writer\'s turn and advance to the next writer')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('extend')
      .setDescription('Add hours to the current turn deadline')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addIntegerOption(o =>
        o.setName('hours').setDescription('Hours to add').setRequired(true).setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName('manage')
      .setDescription('Manage story settings, or a specific writer\'s settings')
      .addStringOption(o =>
        o.setName('story_id').setDescription('Story to manage').setRequired(true).setAutocomplete(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to manage (leave blank to manage story settings)').setRequired(false))
  )
  .addSubcommand(s =>
    s.setName('next')
      .setDescription('Designate which writer will get the next turn')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addUserOption(o =>
        o.setName('user').setDescription('Writer to designate as next').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('deleteentry')
      .setDescription('Soft-delete a specific story entry (hidden from read/export, restorable)')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
      .addIntegerOption(o =>
        o.setName('turn').setDescription('Turn number (as shown in /story read)').setRequired(true).setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName('restoreentry')
      .setDescription('Restore a previously deleted story entry')
      .addIntegerOption(o =>
        o.setName('entry_id').setDescription('Entry ID (shown when entry was deleted)').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('delete')
      .setDescription('Permanently delete a story and all its data')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('reassign')
      .setDescription('Give the previous writer another turn, then resume with the current writer')
      .addIntegerOption(o =>
        o.setName('story_id').setDescription('Story ID').setRequired(true))
  )
  .addSubcommand(s =>
    s.setName('help')
      .setDescription('Show all admin commands and what they do')
  )
  .addSubcommand(s =>
    s.setName('setup')
      .setDescription('Configure Round Robin StoryBot for this server')
  );

async function execute(connection, interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'help')  return await handleHelp(connection, interaction, guildId);
  if (subcommand === 'setup') return await handleSetup(connection, interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!await checkIsAdmin(connection, interaction, guildId)) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtAdminOnly', guildId),
    });
  }
  if (subcommand === 'manage')          await handleAdminManage(connection, interaction);
  else if (subcommand === 'skip')       await handleSkip(connection, interaction);
  else if (subcommand === 'reassign')   await handleReassign(connection, interaction);
  else if (subcommand === 'extend')     await handleExtend(connection, interaction);
  else if (subcommand === 'next')       await handleNext(connection, interaction);
  else if (subcommand === 'deleteentry')  await handleDeleteEntry(connection, interaction);
  else if (subcommand === 'restoreentry') await handleRestoreEntry(connection, interaction);
  else if (subcommand === 'delete')     await handleDelete(connection, interaction);
}

// ---------------------------------------------------------------------------
// /storyadmin help
// ---------------------------------------------------------------------------
async function handleHelp(connection, interaction, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtAdminHelpTitle', 'txtAdminHelpFooter',
    'lblAdminHelpSkip', 'txtAdminHelpSkip',
    'lblAdminHelpExtend', 'txtAdminHelpExtend',
    'lblAdminHelpManageUser', 'txtAdminHelpManageUser',
    'lblAdminHelpNext', 'txtAdminHelpNext',
    'lblAdminHelpReassign', 'txtAdminHelpReassign',
    'lblAdminHelpDelete', 'txtAdminHelpDelete',
    'lblAdminHelpSetup', 'txtAdminHelpSetup'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtAdminHelpTitle)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblAdminHelpSkip,        value: cfg.txtAdminHelpSkip,        inline: false },
      { name: cfg.lblAdminHelpExtend,      value: cfg.txtAdminHelpExtend,      inline: false },
      { name: cfg.lblAdminHelpManageUser,  value: cfg.txtAdminHelpManageUser,  inline: false },
      { name: cfg.lblAdminHelpNext,        value: cfg.txtAdminHelpNext,        inline: false },
      { name: cfg.lblAdminHelpReassign,    value: cfg.txtAdminHelpReassign,    inline: false },
      { name: cfg.lblAdminHelpDelete,      value: cfg.txtAdminHelpDelete,      inline: false },
      { name: cfg.lblAdminHelpSetup,       value: cfg.txtAdminHelpSetup,       inline: false }
    )
    .setFooter({ text: cfg.txtAdminHelpFooter });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// /storyadmin setup
// ---------------------------------------------------------------------------
async function handleSetup(connection, interaction) {
  if (!interaction.member.permissions.has('ManageGuild')) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtSetupNoPermission', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  const cfg = await getConfigValue(connection, [
    'txtSetupModalTitle',
    'lblSetupFeedChannel', 'txtSetupFeedChannelPlaceholder',
    'lblSetupMediaChannel', 'txtSetupMediaChannelPlaceholder',
    'lblSetupAdminRole', 'txtSetupAdminRolePlaceholder',
    'lblSetupRestrictedFeedChannel', 'txtSetupRestrictedFeedPlaceholder',
    'lblSetupRestrictedMediaChannel', 'txtSetupRestrictedMediaPlaceholder',
    'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName',
    'cfgRestrictedFeedChannelId', 'cfgRestrictedMediaChannelId'
  ], guildId);

  const modal = new ModalBuilder()
    .setCustomId('storyadmin_setup_modal')
    .setTitle(cfg.txtSetupModalTitle);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('feed_channel')
        .setLabel(cfg.lblSetupFeedChannel)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupFeedChannelPlaceholder)
        .setValue(cfg.cfgStoryFeedChannelId !== 'cfgStoryFeedChannelId' ? cfg.cfgStoryFeedChannelId : '')
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('media_channel')
        .setLabel(cfg.lblSetupMediaChannel)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupMediaChannelPlaceholder)
        .setValue(cfg.cfgMediaChannelId !== 'cfgMediaChannelId' ? cfg.cfgMediaChannelId : '')
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('restricted_feed_channel')
        .setLabel(cfg.lblSetupRestrictedFeedChannel ?? 'Mature/Explicit Feed Channel (optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupRestrictedFeedPlaceholder ?? 'Channel ID for M/E stories. Age-restrict if server is not 18+.')
        .setValue(cfg.cfgRestrictedFeedChannelId && cfg.cfgRestrictedFeedChannelId !== 'cfgRestrictedFeedChannelId' ? cfg.cfgRestrictedFeedChannelId : '')
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('restricted_media_channel')
        .setLabel(cfg.lblSetupRestrictedMediaChannel ?? 'Mature/Explicit Media Channel (optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupRestrictedMediaPlaceholder ?? 'Media channel for M/E stories. Age-restrict if server is not 18+.')
        .setValue(cfg.cfgRestrictedMediaChannelId && cfg.cfgRestrictedMediaChannelId !== 'cfgRestrictedMediaChannelId' ? cfg.cfgRestrictedMediaChannelId : '')
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('admin_role')
        .setLabel(cfg.lblSetupAdminRole)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(cfg.txtSetupAdminRolePlaceholder)
        .setValue(cfg.cfgAdminRoleName !== 'cfgAdminRoleName' ? cfg.cfgAdminRoleName : '')
        .setRequired(false)
    )
  );

  await interaction.showModal(modal);
}

async function handleSetupModalSubmit(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;

  const feedRaw             = sanitizeModalInput(interaction.fields.getTextInputValue('feed_channel'), 30);
  const mediaRaw            = sanitizeModalInput(interaction.fields.getTextInputValue('media_channel'), 30);
  const restrictedFeedRaw   = sanitizeModalInput(interaction.fields.getTextInputValue('restricted_feed_channel'), 30);
  const restrictedMediaRaw  = sanitizeModalInput(interaction.fields.getTextInputValue('restricted_media_channel'), 30);
  const roleRaw             = sanitizeModalInput(interaction.fields.getTextInputValue('admin_role'), 100);

  // Extract channel IDs from mention (<#ID>) or raw ID
  const feedChannelId            = feedRaw.match(/\d+/)?.[0];
  const mediaChannelId           = mediaRaw.match(/\d+/)?.[0];
  const restrictedFeedChannelId  = restrictedFeedRaw.match(/\d+/)?.[0];
  const restrictedMediaChannelId = restrictedMediaRaw.match(/\d+/)?.[0];

  // Validate feed channel exists
  const feedChannel = feedChannelId
    ? await interaction.guild.channels.fetch(feedChannelId).catch(() => null)
    : null;

  if (!feedChannel) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtSetupFeedChannelInvalid', guildId)
    });
  }

  // Validate media channel if provided
  let mediaChannel = null;
  if (mediaChannelId) {
    mediaChannel = await interaction.guild.channels.fetch(mediaChannelId).catch(() => null);
    if (!mediaChannel) {
      return await interaction.editReply({
        content: await getConfigValue(connection, 'txtSetupMediaChannelInvalid', guildId)
      });
    }
  }

  // Validate restricted feed channel if provided
  let restrictedFeedChannel = null;
  if (restrictedFeedChannelId) {
    restrictedFeedChannel = await interaction.guild.channels.fetch(restrictedFeedChannelId).catch(() => null);
    if (!restrictedFeedChannel) {
      return await interaction.editReply({
        content: await getConfigValue(connection, 'txtSetupRestrictedChannelInvalid', guildId)
      });
    }
  }

  // Validate restricted media channel if provided
  let restrictedMediaChannel = null;
  if (restrictedMediaChannelId) {
    restrictedMediaChannel = await interaction.guild.channels.fetch(restrictedMediaChannelId).catch(() => null);
    if (!restrictedMediaChannel) {
      return await interaction.editReply({
        content: await getConfigValue(connection, 'txtSetupRestrictedMediaInvalid', guildId)
      });
    }
  }

  // Write config values — INSERT or UPDATE if already set
  const upsert = (key, value) => connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES (?, ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [key, value, guildId]
  );

  await upsert('cfgStoryFeedChannelId', feedChannelId);
  if (mediaChannelId)           await upsert('cfgMediaChannelId', mediaChannelId);
  if (restrictedFeedChannelId)  await upsert('cfgRestrictedFeedChannelId', restrictedFeedChannelId);
  if (restrictedMediaChannelId) await upsert('cfgRestrictedMediaChannelId', restrictedMediaChannelId);
  if (roleRaw)        await upsert('cfgAdminRoleName', roleRaw);

  const botMember = interaction.guild.members.me;
  // Use the bot's managed integration role for permission overwrites — role-level overrides
  // work on private channels where user/member-level overrides fail due to Discord's restriction
  // that member overrides can only grant permissions already in the caller's effective channel perms.
  const botRole = interaction.guild.members.me?.roles.cache.find(r => r.managed) ?? null;

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
  if (roleRaw) {
    const adminRole = interaction.guild.roles.cache.find(r => r.name === roleRaw)
      ?? await interaction.guild.roles.fetch().then(roles => roles.find(r => r.name === roleRaw)).catch(() => null);
    if (adminRole) {
      await feedChannel.permissionOverwrites.edit(adminRole, {
        ViewChannel: true,
        ManageThreads: true
      }).catch(() => {});
      threadPermissionNote = ` *(Manage Threads granted on feed channel)*`;
    }
  }

  // Check effective bot permissions on each channel and warn about any gaps.
  // Re-fetch both channels so the permission overwrite changes above are reflected.
  const feedChannelFresh = await interaction.guild.channels.fetch(feedChannelId).catch(() => feedChannel);
  const mediaChannelFresh = mediaChannel
    ? await interaction.guild.channels.fetch(mediaChannelId).catch(() => mediaChannel)
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
      permWarnings.push(`⚠️ Bot is missing permissions on <#${feedChannelId}>: **${missingFeed.join(', ')}**`);
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
        permWarnings.push(`⚠️ Bot is missing permissions on <#${mediaChannelId}>: **${missingMedia.join(', ')}**`);
      }
    }
  }

  const feedPermsOk = !permWarnings.some(w => w.includes(`<#${feedChannelId}>`));
  const mediaPermsOk = !mediaChannelId || !permWarnings.some(w => w.includes(`<#${mediaChannelId}>`));

  const saved = [`${feedPermsOk ? '✅' : '⚠️'} Story feed channel: <#${feedChannelId}>`];
  if (mediaChannelId)           saved.push(`${mediaPermsOk ? '✅' : '⚠️'} Media channel: <#${mediaChannelId}>`);
  if (restrictedFeedChannelId)  saved.push(`✅ Mature/Explicit feed channel: <#${restrictedFeedChannelId}> *(Age-restrict this channel if the server is not already 18+)*`);
  if (restrictedMediaChannelId) saved.push(`✅ Mature/Explicit media channel: <#${restrictedMediaChannelId}>`);
  if (roleRaw)        saved.push(`✅ Admin role: **${roleRaw}**${threadPermissionNote}`);
  if (!mediaChannelId) saved.push(`ℹ️ No media channel set — images will not be processed.`);
  if (!roleRaw)        saved.push(`ℹ️ No admin role set — only Discord Administrators can use admin commands.`);
  if (permWarnings.length) {
    const botRoleName = botRole?.name ?? botMember?.displayName ?? 'the bot role';
    const fixMsg = replaceTemplateVariables(
      await getConfigValue(connection, 'txtSetupBotPermsFix', guildId),
      { feed_channel: `<#${feedChannelId}>`, bot_role_name: botRoleName }
    );
    saved.push('', ...permWarnings, '', fixMsg);
  }

  await interaction.editReply({ content: saved.join('\n') });
}

// ---------------------------------------------------------------------------
// /storyadmin skip
// ---------------------------------------------------------------------------
async function handleSkip(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const activeTurn = activeTurnRows[0];
    await skipActiveTurn(connection, interaction.guild, activeTurn.turn_id, activeTurn.thread_id);

    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);

    await logAdminAction(connection, interaction.user.id, 'skip', storyId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminSkipSuccess', guildId) });

  } catch (error) {
    log(`Error in handleSkip: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin reassign
// ---------------------------------------------------------------------------
async function handleReassign(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.story_writer_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const currentTurn = activeTurnRows[0];

    const [prevTurnRows] = await connection.execute(
      `SELECT sw.story_writer_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 0
       ORDER BY t.ended_at DESC LIMIT 1`,
      [storyId]
    );
    if (prevTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminReassignNoPreviousWriter', guildId) });
    }

    const prevWriter = prevTurnRows[0];

    await skipActiveTurn(connection, interaction.guild, currentTurn.turn_id, currentTurn.thread_id);
    await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [prevWriter.story_writer_id, storyId]);

    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);

    await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [currentTurn.story_writer_id, storyId]);

    await logAdminAction(connection, interaction.user.id, 'reassign', storyId);
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminReassignSuccess', guildId),
        { prev_writer: prevWriter.discord_display_name, current_writer: currentTurn.discord_display_name }
      )
    });

  } catch (error) {
    log(`Error in handleReassign: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin extend
// ---------------------------------------------------------------------------
async function handleExtend(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  const hours = interaction.options.getInteger('hours');
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (activeTurnRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminNoActiveTurn', guildId) });
    }

    const turnId = activeTurnRows[0].turn_id;
    await connection.execute(
      `UPDATE turn SET turn_ends_at = DATE_ADD(COALESCE(turn_ends_at, NOW()), INTERVAL ? HOUR) WHERE turn_id = ?`,
      [hours, turnId]
    );

    const [updatedRows] = await connection.execute(
      `SELECT UNIX_TIMESTAMP(turn_ends_at) as new_end_unix, turn_ends_at FROM turn WHERE turn_id = ?`,
      [turnId]
    );
    const { new_end_unix: newEndUnix, turn_ends_at: newTurnEndsAt } = updatedRows[0];

    // Cancel the old turnTimeout job and schedule a new one at the updated deadline
    await connection.execute(
      `UPDATE job SET job_status = 2 WHERE job_type = 'turnTimeout' AND job_status = 0
       AND CAST(JSON_EXTRACT(payload, '$.turnId') AS UNSIGNED) = ?`,
      [turnId]
    );
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status) VALUES (?, ?, ?, 0)`,
      ['turnTimeout', JSON.stringify({ turnId, storyId, guildId }), newTurnEndsAt]
    );

    await logAdminAction(connection, interaction.user.id, 'extend', storyId, null, `+${hours}h`);
    const msg = replaceTemplateVariables(await getConfigValue(connection, 'txtAdminExtendSuccess', guildId), {
      hours,
      new_end_time: `<t:${newEndUnix}:f>`
    });
    await interaction.editReply({ content: msg });

  } catch (error) {
    log(`Error in handleExtend: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}


// ---------------------------------------------------------------------------
// /storyadmin manage — dispatch
// ---------------------------------------------------------------------------
async function handleAdminManage(connection, interaction) {
  const targetUser = interaction.options.getUser('user');
  if (targetUser) {
    await handleManageUser(connection, interaction);
  } else {
    await handleManage(connection, interaction);
  }
}

function buildManageUserPanel(state, cfg) {
  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtManageUserPanelTitle, {
      writer_name: state.writerName,
      story_title: state.storyTitle
    }))
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblManageUserStatus,  value: state.writerStatus === 1 ? 'Active' : 'Paused',                 inline: true },
      { name: cfg.lblManageUserAO3,     value: state.ao3Name || '*Not set*',                                   inline: true },
      { name: cfg.lblManageUserNotif,   value: state.notificationPrefs === 'dm' ? 'DM' : 'Mention in channel', inline: true },
      { name: cfg.lblManageUserPrivacy, value: state.turnPrivacy ? 'Private' : 'Public',                       inline: true }
    );

  const row1 = new ActionRowBuilder().addComponents(
    state.writerStatus === 1
      ? new ButtonBuilder().setCustomId('storyadmin_mu_pause').setLabel(cfg.btnAdminMUPause).setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId('storyadmin_mu_unpause').setLabel(cfg.btnAdminMUUnpause).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('storyadmin_mu_remove').setLabel(cfg.btnAdminMURemove).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('storyadmin_mu_ao3name').setLabel(cfg.btnAdminMUAO3Name).setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('storyadmin_mu_close').setLabel(cfg.btnManageUserClose).setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function handleManageUser(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  const targetUser = interaction.options.getUser('user');

  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    const [writerRows] = await connection.execute(
      `SELECT story_writer_id, sw_status, AO3_name, notification_prefs, turn_privacy
       FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (1, 2)`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }
    const writer = writerRows[0];

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, targetUser.id]
    );
    const [remainingRows] = await connection.execute(
      `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND discord_user_id != ?`,
      [storyId, targetUser.id]
    );

    const cfg = await getConfigValue(connection, [
      'txtManageUserPanelTitle', 'lblManageUserStatus', 'lblManageUserAO3',
      'lblManageUserNotif', 'lblManageUserPrivacy', 'btnManageUserClose',
      'btnAdminMUPause', 'btnAdminMUUnpause', 'btnAdminMURemove', 'btnAdminMUAO3Name',
      'txtAdminMUPauseConfirmDesc', 'txtAdminMUActiveTurnWarning',
      'txtAdminMUUnpauseConfirmDesc', 'txtAdminMURemoveConfirmDesc',
      'txtAdminMULastWriterWarning', 'btnCancel'
    ], guildId);

    const isActiveTurn = activeTurnRows.length > 0;
    const writerName = targetUser.displayName || targetUser.username;

    const state = {
      action: null,
      storyId,
      guildId,
      storyTitle: story.title,
      targetUserId: targetUser.id,
      writerId: writer.story_writer_id,
      writerName,
      writerStatus: writer.sw_status,
      ao3Name: writer.AO3_name,
      notificationPrefs: writer.notification_prefs,
      turnPrivacy: writer.turn_privacy,
      isActiveTurn,
      activeTurnId: isActiveTurn ? activeTurnRows[0].turn_id : null,
      activeTurnThreadId: isActiveTurn ? activeTurnRows[0].thread_id : null,
      isLastWriter: remainingRows[0].count === 0,
      originalInteraction: interaction,
      cfg
    };

    pendingManageUserData.set(interaction.user.id, state);
    await interaction.editReply(buildManageUserPanel(state, cfg));

  } catch (error) {
    log(`Error in handleManageUser: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleManageUserButton(connection, interaction) {
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  const customId = interaction.customId;

  if (customId === 'storyadmin_mu_close') {
    await interaction.deferUpdate();
    pendingManageUserData.delete(adminId);
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
    return;
  }

  if (!pending) {
    await interaction.deferUpdate();
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), embeds: [], components: [] });
  }

  if (customId === 'storyadmin_mu_pause') {
    pending.action = 'pause';
    await interaction.deferUpdate();
    const description = replaceTemplateVariables(pending.cfg.txtAdminMUPauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('⏸️ Pause Writer?').setDescription(description).setColor(0xfee75c);
    if (pending.isActiveTurn) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUPause).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_unpause') {
    pending.action = 'unpause';
    await interaction.deferUpdate();
    const description = replaceTemplateVariables(pending.cfg.txtAdminMUUnpauseConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('▶️ Restore to Rotation?').setDescription(description).setColor(0x57f287);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMUUnpause).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_remove') {
    pending.action = 'remove';
    await interaction.deferUpdate();
    const description = replaceTemplateVariables(pending.cfg.txtAdminMURemoveConfirmDesc, { user_name: pending.writerName, story_title: pending.storyTitle });
    const embed = new EmbedBuilder().setTitle('⚠️ Remove Writer?').setDescription(description).setColor(0xed4245);
    if (pending.isActiveTurn) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMUActiveTurnWarning, { user_name: pending.writerName }) });
    if (pending.isLastWriter) embed.addFields({ name: '​', value: replaceTemplateVariables(pending.cfg.txtAdminMULastWriterWarning, { user_name: pending.writerName }) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`storyadmin_mu_confirm_${adminId}`).setLabel(pending.cfg.btnAdminMURemove).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`storyadmin_mu_cancel_${adminId}`).setLabel(pending.cfg.btnCancel).setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });

  } else if (customId === 'storyadmin_mu_ao3name') {
    const modal = new ModalBuilder()
      .setCustomId('storyadmin_mu_ao3name_modal')
      .setTitle('Set AO3 Name')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ao3_name_input')
            .setLabel('AO3 Name')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Leave blank to clear')
            .setValue(pending.ao3Name ?? '')
        )
      );
    await interaction.showModal(modal);

  } else if (customId.startsWith('storyadmin_mu_confirm_')) {
    await handleManageUserConfirm(connection, interaction);

  } else if (customId.startsWith('storyadmin_mu_cancel_')) {
    await handleManageUserCancel(connection, interaction);
  }
}


// ---------------------------------------------------------------------------
// /storyadmin next
// ---------------------------------------------------------------------------
async function handleNext(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  const targetUser = interaction.options.getUser('user');
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, story_status FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    if (storyRows[0].story_status !== 1) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotActive', guildId) });
    }

    // Verify the target is an active writer
    const [writerRows] = await connection.execute(
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminKickNotWriter', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    // Check if there's an active turn
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, sw.discord_user_id as current_writer_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );

    const targetStoryWriterId = writerRows[0].story_writer_id;

    if (activeTurnRows.length === 0) {
      // No active turn — start theirs immediately (clear any existing override first)
      await connection.execute(`UPDATE story SET next_writer_id = NULL WHERE story_id = ?`, [storyId]);
      await NextTurn(connection, interaction, targetStoryWriterId);
      await logAdminAction(connection, interaction.user.id, 'next', storyId, targetUser.id);
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    const currentWriterId = activeTurnRows[0].current_writer_id;
    if (currentWriterId === targetUser.id) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminNextAlreadyCurrent', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    // Store override — will be applied when the current turn ends
    await connection.execute(`UPDATE story SET next_writer_id = ? WHERE story_id = ?`, [targetStoryWriterId, storyId]);
    await logAdminAction(connection, interaction.user.id, 'next', storyId, targetUser.id);
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminNextSuccess', guildId),
        { user_name: targetUser.displayName || targetUser.username }
      )
    });

  } catch (error) {
    log(`Error in handleNext: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin delete
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// /storyadmin deleteentry — soft-delete a specific story entry
// ---------------------------------------------------------------------------

async function handleDeleteEntry(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  const turnNumber = interaction.options.getInteger('turn');

  try {
    const [entryRows] = await connection.execute(
      `SELECT se.story_entry_id, se.content, sw.discord_display_name
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ?
         AND se.entry_status = 'confirmed'
         AND (
           SELECT COUNT(DISTINCT t2.turn_id)
           FROM turn t2
           JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
           JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
           WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
         ) = ?`,
      [storyId, turnNumber]
    );

    if (entryRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId) });
    }

    const entry = entryRows[0];
    const preview = entry.content.length > 300 ? entry.content.slice(0, 300) + '…' : entry.content;

    const embed = new EmbedBuilder()
      .setTitle(`Delete Turn ${turnNumber} — ${entry.discord_display_name}?`)
      .setDescription(preview)
      .addFields({ name: '\u200b', value: 'This entry will be hidden from `/story read` and exports. The entry ID shown after deletion can be used to restore it.' })
      .setColor(0xff6b6b);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_deleteentry_confirm_${entry.story_entry_id}`)
        .setLabel('Delete Entry')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('storyadmin_deleteentry_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`Error in handleDeleteEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDeleteEntryConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const entryId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;

  try {
    const [rows] = await connection.execute(
      `SELECT se.story_entry_id, se.entry_status, sw.discord_display_name, sw.story_id
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE se.story_entry_id = ? AND s.guild_id = ?`,
      [entryId, guildId]
    );

    if (rows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId), embeds: [], components: [] });
    }
    if (rows[0].entry_status === 'deleted') {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminDeleteEntryAlreadyDeleted', guildId), embeds: [], components: [] });
    }

    await connection.execute(
      `UPDATE story_entry SET entry_status = 'deleted' WHERE story_entry_id = ?`,
      [entryId]
    );

    await logAdminAction(connection, interaction.user.id, 'deleteentry', rows[0].story_id);

    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminDeleteEntrySuccess', guildId),
        { author_name: rows[0].discord_display_name, entry_id: String(entryId) }
      ),
      embeds: [],
      components: []
    });

  } catch (error) {
    log(`Error in handleDeleteEntryConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), embeds: [], components: [] });
  }
}

async function handleRestoreEntry(connection, interaction) {
  const guildId = interaction.guild.id;
  const entryId = interaction.options.getInteger('entry_id');

  try {
    const [rows] = await connection.execute(
      `SELECT se.story_entry_id, se.entry_status, sw.discord_display_name, sw.story_id
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE se.story_entry_id = ? AND s.guild_id = ?`,
      [entryId, guildId]
    );

    if (rows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtEditEntryNotFound', guildId) });
    }
    if (rows[0].entry_status !== 'deleted') {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtAdminRestoreEntryNotDeleted', guildId) });
    }

    await connection.execute(
      `UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?`,
      [entryId]
    );

    await logAdminAction(connection, interaction.user.id, 'restoreentry', rows[0].story_id);

    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminRestoreEntrySuccess', guildId),
        { author_name: rows[0].discord_display_name }
      )
    });

  } catch (error) {
    log(`Error in handleRestoreEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDelete(connection, interaction) {
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    const [txtAdminDeleteConfirm, btnConfirmDelete, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtAdminDeleteConfirm', guildId),
      getConfigValue(connection, 'btnConfirmDelete', guildId),
      getConfigValue(connection, 'btnCancel', guildId)
    ]);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_delete_confirm_${storyId}`)
        .setLabel(btnConfirmDelete)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`storyadmin_delete_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content: replaceTemplateVariables(txtAdminDeleteConfirm, { story_title: story.title }),
      components: [row]
    });

  } catch (error) {
    log(`Error in handleDelete: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDeleteConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_thread_id FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), components: [] });
    }
    const story = storyRows[0];

    // Log before deleting so the story_id still exists in the log
    await logAdminAction(connection, interaction.user.id, 'delete', storyId);

    // Hard delete — cascades to story_writer, turn, story_entry
    await connection.execute(`DELETE FROM story WHERE story_id = ?`, [storyId]);

    // Edit the reply before deleting the thread — if the command was run from inside
    // the story thread, deleting it first would destroy the ephemeral interaction context.
    await interaction.editReply({
      content: replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminDeleteSuccess', guildId),
        { story_title: story.title }
      ),
      components: []
    });

    // Delete the Discord story thread after replying
    if (story.story_thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(story.story_thread_id);
        if (thread) await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        log(`Story thread already gone for story ${storyId}`, { show: false, guildName: interaction?.guild?.name });
      }
    }

  } catch (error) {
    log(`Error in handleDeleteConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

async function handleDeleteCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({
    content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
    components: []
  });
}

// ---------------------------------------------------------------------------
// manageuser confirm / cancel button handlers
// ---------------------------------------------------------------------------
async function handleManageUserConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);

  if (!pending) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      embeds: [],
      components: []
    });
  }

  pendingManageUserData.delete(adminId);
  const { action, storyId, guildId, targetUserId, writerId, writerName, storyTitle,
          isActiveTurn, activeTurnId, activeTurnThreadId, isLastWriter } = pending;

  try {
    if (action === 'pause') {
      await connection.execute(`UPDATE story_writer SET sw_status = 2 WHERE story_writer_id = ?`, [writerId]);
      if (isActiveTurn) {
        await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurnId]);
        if (activeTurnThreadId) {
          try {
            const thread = await interaction.guild.channels.fetch(activeTurnThreadId);
            if (thread) await deleteThreadAndAnnouncement(thread);
          } catch (err) {
            log(`Could not delete thread on admin pause: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
        try {
          const nextWriterId = await PickNextWriter(connection, storyId);
          if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
        } catch (err) {
          log(`Could not advance turn after admin pause for story ${storyId}: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
      await logAdminAction(connection, adminId, 'pause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminPauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });

    } else if (action === 'unpause') {
      await connection.execute(`UPDATE story_writer SET sw_status = 1 WHERE story_writer_id = ?`, [writerId]);
      await logAdminAction(connection, adminId, 'unpause_user', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminUnpauseUserSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });

    } else if (action === 'remove') {
      if (isActiveTurn) {
        await connection.execute(`UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`, [activeTurnId]);
        if (activeTurnThreadId) {
          try {
            const thread = await interaction.guild.channels.fetch(activeTurnThreadId);
            if (thread) await deleteThreadAndAnnouncement(thread);
          } catch (err) {
            log(`Could not delete thread on kick: ${err}`, { show: true, guildName: interaction?.guild?.name });
          }
        }
      }
      await connection.execute(
        `UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_writer_id = ?`,
        [writerId]
      );
      if (isLastWriter) {
        await connection.execute(`UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`, [storyId]);
        log(`Story ${storyId} auto-closed after admin kick of last writer`, { show: true, guildName: interaction?.guild?.name });
      } else if (isActiveTurn) {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, interaction, nextWriterId);
      }
      await logAdminAction(connection, adminId, 'remove', storyId, targetUserId);
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminKickSuccess', guildId),
        { user_name: writerName, story_title: storyTitle }
      );
      const closeNote = isLastWriter ? '\n⚠️ Story auto-closed — no writers remain.' : '';
      await interaction.editReply({ content: successMsg + closeNote, embeds: [], components: [] });

      // Activity log (fire-and-forget)
      getConfigValue(connection, 'txtStoryThreadWriterRemove', guildId).then(template =>
        postStoryThreadActivity(connection, interaction.guild, storyId, template.replace('[writer_name]', writerName))
      ).catch(() => {});

    }

  } catch (error) {
    log(`Error in handleManageUserConfirm (${action}): ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({
      content: await getConfigValue(connection, 'errProcessingRequest', guildId),
      embeds: [],
      components: []
    });
  }
}


async function handleManageUserCancel(connection, interaction) {
  await interaction.deferUpdate();
  const pending = pendingManageUserData.get(interaction.user.id);
  if (!pending) {
    return await interaction.editReply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      embeds: [],
      components: []
    });
  }
  pending.action = null;
  await interaction.editReply(buildManageUserPanel(pending, pending.cfg));
}

async function handleButtonInteraction(connection, interaction) {
  if (interaction.customId.startsWith('storyadmin_deleteentry_confirm_')) {
    await handleDeleteEntryConfirm(connection, interaction);
  } else if (interaction.customId === 'storyadmin_deleteentry_cancel') {
    await interaction.deferUpdate();
    await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
  } else if (interaction.customId.startsWith('storyadmin_delete_confirm_')) {
    await handleDeleteConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_delete_cancel_')) {
    await handleDeleteCancel(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_mu_')) {
    await handleManageUserButton(connection, interaction);
  }
}

async function handleManageUserModalSubmit(connection, interaction) {
  const adminId = interaction.user.id;
  const pending = pendingManageUserData.get(adminId);
  if (!pending) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id),
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const rawName = interaction.fields.getTextInputValue('ao3_name_input');
    const newName = sanitizeModalInput(rawName, 100) || null;
    await connection.execute(
      `UPDATE story_writer SET AO3_name = ? WHERE story_writer_id = ?`,
      [newName, pending.writerId]
    );
    await logAdminAction(connection, adminId, 'ao3name', pending.storyId, pending.targetUserId, newName);
    pending.ao3Name = newName;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await pending.originalInteraction.editReply(buildManageUserPanel(pending, pending.cfg));
    await interaction.deleteReply();
  } catch (error) {
    log(`Error in handleManageUserModalSubmit: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.reply({ content: await getConfigValue(connection, 'errProcessingRequest', interaction.guild.id), flags: MessageFlags.Ephemeral });
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'storyadmin_setup_modal') {
    await handleSetupModalSubmit(connection, interaction);
  } else if (interaction.customId === 'storyadmin_mu_ao3name_modal') {
    await handleManageUserModalSubmit(connection, interaction);
  }
}

async function handleAutocomplete(connection, interaction) {
  if (!interaction.guild) return interaction.respond([]);
  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name !== 'story_id') return interaction.respond([]);
  const guildId = interaction.guild.id;
  const typed = `%${focusedOption.value}%`;
  const typedPrefix = `${focusedOption.value}%`;
  const [rows] = await connection.execute(
    `SELECT s.guild_story_id, s.title,
       EXISTS (SELECT 1 FROM story_writer sw
         WHERE sw.story_id = s.story_id AND sw.discord_user_id = ?
           AND sw.story_writer_id = (SELECT MIN(story_writer_id) FROM story_writer WHERE story_id = s.story_id)
       ) AS is_creator
     FROM story s
     WHERE s.guild_id = ? AND s.story_status != 3
       AND (s.title LIKE ? OR CAST(s.guild_story_id AS CHAR) LIKE ?)
     ORDER BY is_creator DESC, s.guild_story_id LIMIT 25`,
    [interaction.user.id, guildId, typed, typedPrefix]
  );
  return interaction.respond(
    rows.map(r => ({
      name: `${r.title} (#${r.guild_story_id})`.slice(0, 100),
      value: String(r.guild_story_id)
    }))
  );
}

export default { data, execute, handleButtonInteraction, handleModalSubmit, handleAutocomplete };
