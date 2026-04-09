import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, sanitizeModalInput, log, replaceTemplateVariables, resolveStoryId, checkIsAdmin } from '../utilities.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, deleteThreadAndAnnouncement } from '../storybot.js';

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
  .addSubcommandGroup(group =>
    group.setName('manageuser')
      .setDescription('Manage writer membership in a story')
      .addSubcommand(s =>
        s.setName('pause')
          .setDescription('Temporarily pause a writer — they skip turns until unpaused')
          .addIntegerOption(o =>
            o.setName('story_id').setDescription('Story ID').setRequired(true))
          .addUserOption(o =>
            o.setName('user').setDescription('Writer to pause').setRequired(true))
      )
      .addSubcommand(s =>
        s.setName('unpause')
          .setDescription('Restore a paused writer to active turn rotation')
          .addIntegerOption(o =>
            o.setName('story_id').setDescription('Story ID').setRequired(true))
          .addUserOption(o =>
            o.setName('user').setDescription('Writer to unpause').setRequired(true))
      )
      .addSubcommand(s =>
        s.setName('remove')
          .setDescription('Permanently remove a writer from a story')
          .addIntegerOption(o =>
            o.setName('story_id').setDescription('Story ID').setRequired(true))
          .addUserOption(o =>
            o.setName('user').setDescription('Writer to remove').setRequired(true))
      )
      .addSubcommand(s =>
        s.setName('ao3name')
          .setDescription('Update a writer\'s AO3 display name')
          .addIntegerOption(o =>
            o.setName('story_id').setDescription('Story ID').setRequired(true))
          .addUserOption(o =>
            o.setName('user').setDescription('Writer to update').setRequired(true))
          .addStringOption(o =>
            o.setName('name').setDescription('New AO3 name (leave blank to clear)').setRequired(false))
      )
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

  if (!await checkIsAdmin(connection, interaction, guildId)) {
    return await interaction.reply({
      content: await getConfigValue(connection, 'txtAdminOnly', guildId),
      flags: MessageFlags.Ephemeral
    });
  }
  const subcommandGroup = interaction.options.getSubcommandGroup();

  if (subcommandGroup === 'manageuser') {
    if (subcommand === 'pause')        await handleAdminPauseUser(connection, interaction);
    else if (subcommand === 'unpause') await handleAdminUnpauseUser(connection, interaction);
    else if (subcommand === 'remove')  await handleKick(connection, interaction);
    else if (subcommand === 'ao3name') await handleAdminAO3Name(connection, interaction);
  } else {
    if (subcommand === 'skip')              await handleSkip(connection, interaction);
    else if (subcommand === 'extend')       await handleExtend(connection, interaction);
    else if (subcommand === 'next')         await handleNext(connection, interaction);
    else if (subcommand === 'deleteentry')  await handleDeleteEntry(connection, interaction);
    else if (subcommand === 'restoreentry') await handleRestoreEntry(connection, interaction);
    else if (subcommand === 'delete')       await handleDelete(connection, interaction);
  }
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
    'cfgStoryFeedChannelId', 'cfgMediaChannelId', 'cfgAdminRoleName'
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

  const feedRaw  = sanitizeModalInput(interaction.fields.getTextInputValue('feed_channel'), 30);
  const mediaRaw = sanitizeModalInput(interaction.fields.getTextInputValue('media_channel'), 30);
  const roleRaw  = sanitizeModalInput(interaction.fields.getTextInputValue('admin_role'), 100);

  // Extract channel ID from mention (<#ID>) or raw ID
  const feedChannelId  = feedRaw.match(/\d+/)?.[0];
  const mediaChannelId = mediaRaw.match(/\d+/)?.[0];

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

  // Write config values — INSERT or UPDATE if already set
  const upsert = (key, value) => connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES (?, ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [key, value, guildId]
  );

  await upsert('cfgStoryFeedChannelId', feedChannelId);
  if (mediaChannelId) await upsert('cfgMediaChannelId', mediaChannelId);
  if (roleRaw)        await upsert('cfgAdminRoleName', roleRaw);

  const botMember = interaction.guild.members.me;

  // Grant the bot required permissions on the feed channel.
  // Note: As of January 12, 2026, PinMessages is a separate permission from ManageMessages.
  let botPermNote = '';
  if (botMember) {
    const ok = await feedChannel.permissionOverwrites.edit(botMember, {
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
    }).then(() => true).catch(() => false);
    botPermNote = ok
      ? ' *(bot permissions set)*'
      : ' *(⚠️ could not set bot permissions — check bot role)*';
  }

  // Grant the bot required permissions on the media channel.
  let mediaPermNote = '';
  if (mediaChannel && botMember) {
    const ok = await mediaChannel.permissionOverwrites.edit(botMember, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    }).then(() => true).catch(() => false);
    mediaPermNote = ok
      ? ' *(bot permissions set)*'
      : ' *(⚠️ could not set bot permissions — check bot role)*';
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

  const saved = [`✅ Story feed channel: <#${feedChannelId}>${botPermNote}`];
  if (mediaChannelId) saved.push(`✅ Media channel: <#${mediaChannelId}>${mediaPermNote}`);
  if (roleRaw)        saved.push(`✅ Admin role: **${roleRaw}**${threadPermissionNote}`);
  if (!mediaChannelId) saved.push(`ℹ️ No media channel set — images will not be processed.`);
  if (!roleRaw)        saved.push(`ℹ️ No admin role set — only Discord Administrators can use admin commands.`);
  if (permWarnings.length) saved.push('', ...permWarnings, '', '_To fix: ensure the bot role has these permissions in your server settings, or grant them manually on the channel._');

  await interaction.editReply({ content: saved.join('\n') });
}

// ---------------------------------------------------------------------------
// /storyadmin skip
// ---------------------------------------------------------------------------
async function handleSkip(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await connection.execute(
      `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
      [activeTurn.turn_id]
    );
    await connection.execute(
      `UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`,
      [activeTurn.turn_id]
    );

    if (activeTurn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
        if (thread) await deleteThreadAndAnnouncement(thread);
      } catch (err) {
        log(`Could not delete turn thread on admin skip: ${err}`, { show: true, guildName: interaction?.guild?.name });
      }
    }

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
// /storyadmin extend
// ---------------------------------------------------------------------------
async function handleExtend(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
// /storyadmin manageuser remove — confirmation step
// ---------------------------------------------------------------------------
async function handleKick(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
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

    const adminId = interaction.user.id;
    const writerName = targetUser.displayName || targetUser.username;
    const isActiveTurn = activeTurnRows.length > 0;
    const isLastWriter = remainingRows[0].count === 0;

    pendingManageUserData.set(adminId, {
      action: 'remove',
      storyId,
      guildId,
      targetUserId: targetUser.id,
      writerId: writerRows[0].story_writer_id,
      writerName,
      storyTitle: story.title,
      isActiveTurn,
      activeTurnId: isActiveTurn ? activeTurnRows[0].turn_id : null,
      activeTurnThreadId: isActiveTurn ? activeTurnRows[0].thread_id : null,
      isLastWriter,
    });

    const cfg = await getConfigValue(connection, [
      'txtAdminMURemoveConfirmDesc', 'txtAdminMUActiveTurnWarning',
      'txtAdminMULastWriterWarning', 'btnAdminMURemove', 'btnCancel'
    ], guildId);

    const description = replaceTemplateVariables(cfg.txtAdminMURemoveConfirmDesc, {
      user_name: writerName,
      story_title: story.title
    });

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Remove Writer?')
      .setDescription(description)
      .setColor(0xed4245);

    if (isActiveTurn) {
      embed.addFields({ name: '\u200b', value: replaceTemplateVariables(cfg.txtAdminMUActiveTurnWarning, { user_name: writerName }) });
    }
    if (isLastWriter) {
      embed.addFields({ name: '\u200b', value: replaceTemplateVariables(cfg.txtAdminMULastWriterWarning, { user_name: writerName }) });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_confirm_${adminId}`)
        .setLabel(cfg.btnAdminMURemove)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_cancel_${adminId}`)
        .setLabel(cfg.btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`Error in handleKick: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin manageuser pause — confirmation step
// ---------------------------------------------------------------------------
async function handleAdminPauseUser(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
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

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND sw.discord_user_id = ? AND t.turn_status = 1`,
      [storyId, targetUser.id]
    );

    const adminId = interaction.user.id;
    const writerName = targetUser.displayName || targetUser.username;
    const isActiveTurn = activeTurnRows.length > 0;

    pendingManageUserData.set(adminId, {
      action: 'pause',
      storyId,
      guildId,
      targetUserId: targetUser.id,
      writerId: writerRows[0].story_writer_id,
      writerName,
      storyTitle: story.title,
      isActiveTurn,
      activeTurnId: isActiveTurn ? activeTurnRows[0].turn_id : null,
      activeTurnThreadId: isActiveTurn ? activeTurnRows[0].thread_id : null,
    });

    const cfg = await getConfigValue(connection, [
      'txtAdminMUPauseConfirmDesc', 'txtAdminMUActiveTurnWarning',
      'btnAdminMUPause', 'btnCancel'
    ], guildId);

    const description = replaceTemplateVariables(cfg.txtAdminMUPauseConfirmDesc, {
      user_name: writerName,
      story_title: story.title
    });

    const embed = new EmbedBuilder()
      .setTitle('⏸️ Pause Writer?')
      .setDescription(description)
      .setColor(0xfee75c);

    if (isActiveTurn) {
      embed.addFields({ name: '\u200b', value: replaceTemplateVariables(cfg.txtAdminMUActiveTurnWarning, { user_name: writerName }) });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_confirm_${adminId}`)
        .setLabel(cfg.btnAdminMUPause)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_cancel_${adminId}`)
        .setLabel(cfg.btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`Error in handleAdminPauseUser: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin manageuser unpause — confirmation step
// ---------------------------------------------------------------------------
async function handleAdminUnpauseUser(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
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
      `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 2`,
      [storyId, targetUser.id]
    );
    if (writerRows.length === 0) {
      return await interaction.editReply({
        content: replaceTemplateVariables(
          await getConfigValue(connection, 'txtAdminUnpauseNotPaused', guildId),
          { user_name: targetUser.displayName || targetUser.username }
        )
      });
    }

    const adminId = interaction.user.id;
    const writerName = targetUser.displayName || targetUser.username;

    pendingManageUserData.set(adminId, {
      action: 'unpause',
      storyId,
      guildId,
      targetUserId: targetUser.id,
      writerId: writerRows[0].story_writer_id,
      writerName,
      storyTitle: story.title,
    });

    const cfg = await getConfigValue(connection, [
      'txtAdminMUUnpauseConfirmDesc', 'btnAdminMUUnpause', 'btnCancel'
    ], guildId);

    const description = replaceTemplateVariables(cfg.txtAdminMUUnpauseConfirmDesc, {
      user_name: writerName,
      story_title: story.title
    });

    const embed = new EmbedBuilder()
      .setTitle('▶️ Restore to Rotation?')
      .setDescription(description)
      .setColor(0x57f287);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_confirm_${adminId}`)
        .setLabel(cfg.btnAdminMUUnpause)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_cancel_${adminId}`)
        .setLabel(cfg.btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`Error in handleAdminUnpauseUser: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin manageuser ao3name — confirmation step
// ---------------------------------------------------------------------------
async function handleAdminAO3Name(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));
  const targetUser = interaction.options.getUser('user');
  const newName = interaction.options.getString('name') ?? null;
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
      `SELECT story_writer_id, AO3_name FROM story_writer
       WHERE story_id = ? AND discord_user_id = ? AND sw_status IN (1, 2)`,
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

    const adminId = interaction.user.id;
    const writerName = targetUser.displayName || targetUser.username;
    const currentAO3Name = writerRows[0].AO3_name;

    pendingManageUserData.set(adminId, {
      action: 'ao3name',
      storyId,
      guildId,
      targetUserId: targetUser.id,
      writerId: writerRows[0].story_writer_id,
      writerName,
      storyTitle: story.title,
      currentAO3Name,
      newAO3Name: newName,
    });

    const cfg = await getConfigValue(connection, ['btnAdminMUAO3Name', 'btnCancel'], guildId);

    const embed = new EmbedBuilder()
      .setTitle('✏️ Update AO3 Name?')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Writer',        value: writerName,                             inline: true },
        { name: 'Story',         value: story.title,                            inline: true },
        { name: '\u200b',        value: '\u200b',                               inline: true },
        { name: 'Current name',  value: currentAO3Name || '*none*',             inline: true },
        { name: 'New name',      value: newName        || '*(will be cleared)*', inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_confirm_${adminId}`)
        .setLabel(cfg.btnAdminMUAO3Name)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`storyadmin_mu_cancel_${adminId}`)
        .setLabel(cfg.btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });

  } catch (error) {
    log(`Error in handleAdminAO3Name: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin next
// ---------------------------------------------------------------------------
async function handleNext(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      return await interaction.editReply({ content: 'Entry not found.', embeds: [], components: [] });
    }
    if (rows[0].entry_status === 'deleted') {
      return await interaction.editReply({ content: 'This entry has already been deleted.', embeds: [], components: [] });
    }

    await connection.execute(
      `UPDATE story_entry SET entry_status = 'deleted' WHERE story_entry_id = ?`,
      [entryId]
    );

    await logAdminAction(connection, interaction.user.id, 'deleteentry', rows[0].story_id);

    await interaction.editReply({
      content: `Entry by **${rows[0].discord_display_name}** has been deleted. Entry ID: \`${entryId}\` — to restore, use \`/storyadmin restoreentry entry_id:${entryId}\`.`,
      embeds: [],
      components: []
    });

  } catch (error) {
    log(`Error in handleDeleteEntryConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), embeds: [], components: [] });
  }
}

async function handleRestoreEntry(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      return await interaction.editReply({ content: 'Entry not found.' });
    }
    if (rows[0].entry_status !== 'deleted') {
      return await interaction.editReply({ content: 'That entry is not deleted — nothing to restore.' });
    }

    await connection.execute(
      `UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?`,
      [entryId]
    );

    await logAdminAction(connection, interaction.user.id, 'restoreentry', rows[0].story_id);

    await interaction.editReply({
      content: `Entry by **${rows[0].discord_display_name}** has been restored and will appear in \`/story read\` and exports again.`
    });

  } catch (error) {
    log(`Error in handleRestoreEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

async function handleDelete(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
          isActiveTurn, activeTurnId, activeTurnThreadId, isLastWriter,
          newAO3Name } = pending;

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

    } else if (action === 'ao3name') {
      await connection.execute(`UPDATE story_writer SET AO3_name = ? WHERE story_writer_id = ?`, [newAO3Name, writerId]);
      await logAdminAction(connection, adminId, 'ao3name', storyId, targetUserId, newAO3Name);
      const displayName = newAO3Name ?? '(cleared)';
      const successMsg = replaceTemplateVariables(
        await getConfigValue(connection, 'txtAdminAO3NameSuccess', guildId),
        { user_name: writerName, ao3_name: displayName }
      );
      await interaction.editReply({ content: successMsg, embeds: [], components: [] });
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
  const adminId = interaction.user.id;
  pendingManageUserData.delete(adminId);
  await interaction.editReply({
    content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id),
    embeds: [],
    components: []
  });
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
  } else if (interaction.customId.startsWith('storyadmin_mu_confirm_')) {
    await handleManageUserConfirm(connection, interaction);
  } else if (interaction.customId.startsWith('storyadmin_mu_cancel_')) {
    await handleManageUserCancel(connection, interaction);
  }
}

async function handleModalSubmit(connection, interaction) {
  if (interaction.customId === 'storyadmin_setup_modal') {
    await handleSetupModalSubmit(connection, interaction);
  }
}

export default { data, execute, handleButtonInteraction, handleModalSubmit };
