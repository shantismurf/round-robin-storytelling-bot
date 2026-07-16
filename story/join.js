import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId, trimTrailingEmoji } from '../utilities.js';
import { StoryJoin, getActiveThreadId } from '../storybot.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { postStoryThreadActivity } from './_turn.js';
import { postStoryFeedJoinAnnouncement } from '../announcements.js';
import { STORY_STATUS, WRITER_STATUS } from '../constants.js';

// Pending join sessions keyed by userId
export const pendingJoinData = new Map();

async function getPreviousPenName(connection, userId) {
  try {
    const [rows] = await connection.execute(
      `SELECT pen_name FROM story_writer WHERE discord_user_id = ? AND pen_name IS NOT NULL AND pen_name != '' ORDER BY joined_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0]?.pen_name ?? null;
  } catch { return null; }
}

export async function validateJoinEligibility(connection, storyId, guildId, userId) {
  try {
    // Get story info with writer count
    const [storyInfo] = await connection.execute(`
      SELECT s.*, COUNT(sw.story_writer_id) as current_writers
      FROM story s
      LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = ?
      WHERE s.story_id = ? AND s.guild_id = ?
      GROUP BY s.story_id
    `, [WRITER_STATUS.ACTIVE, storyId, guildId]);

    if (storyInfo.length === 0) {
      return { success: false, error: await getConfigValue(connection,'txtStoryNotFound', guildId) };
    }

    const story = storyInfo[0];

    // Check if story is closed
    if (story.story_status === STORY_STATUS.CLOSED) {
      return { success: false, error: await getConfigValue(connection,'txtJoinStoryClosed', guildId) };
    }

    // Check if story allows new writers
    if (!story.allow_joins) {
      return { success: false, error: await getConfigValue(connection,'txtJoinNotAllowed', guildId) };
    }

    // Check if story is at capacity
    if (story.max_writers && story.current_writers >= story.max_writers) {
      return {
        success: false,
        error: replaceTemplateVariables(await getConfigValue(connection,'txtJoinStoryFull', guildId), { max_writers: story.max_writers })
      };
    }

    // Check if user already joined
    const [existingWriter] = await connection.execute(`
      SELECT story_writer_id FROM story_writer
      WHERE story_id = ? AND discord_user_id = ? AND sw_status = ?
    `, [storyId, userId, WRITER_STATUS.ACTIVE]);

    if (existingWriter.length > 0) {
      return { success: false, error: await getConfigValue(connection,'txtMemberStatusJoined', guildId) };
    }

    return { success: true, story };

  } finally {
    // Connection is persistent, no need to release
  }
}

export async function buildJoinEmbed(connection, state) {
  const { storyId, guildId, storyTitle, privacy, notificationPrefs, penName, displayName } = state;
  const cfg = await getConfigValue(connection, [
    'txtJoinEmbedDesc', 'lblJoinPrivacySelect', 'lblJoinNotifSelect',
    'lblJoinPenName', 'txtJoinPenNameNotSet', 'btnJoinSetPenName', 'btnJoinConfirm', 'btnCancel'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(`🎭 Join "${storyTitle}"`)
    .setDescription(cfg.txtJoinEmbedDesc)
    .addFields(
      { name: trimTrailingEmoji(cfg.lblJoinPrivacySelect), value: privacy === 'private' ? '🔒 Private' : '🌐 Public', inline: true },
      { name: trimTrailingEmoji(cfg.lblJoinNotifSelect), value: notificationPrefs === 'dm' ? '💬 DM' : '📢 Mention in channel', inline: true },
      { name: trimTrailingEmoji(cfg.lblJoinPenName), value: penName || (displayName ? `${displayName} (Discord display name)` : cfg.txtJoinPenNameNotSet), inline: false }
    );

  const privacyRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`story_join_privacy_${storyId}`)
      .addOptions([
        { label: 'Public', value: 'public', description: 'Your turn thread is visible to all server members', default: privacy === 'public' },
        { label: 'Private', value: 'private', description: 'Only you and admins can see your turn thread', default: privacy === 'private' }
      ])
  );

  const notifRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`story_join_notif_${storyId}`)
      .addOptions([
        { label: 'DM', value: 'dm', description: 'Receive turn notifications in your DMs', default: notificationPrefs === 'dm' },
        { label: 'Mention in channel', value: 'mention', description: 'Get @mentioned in the story feed channel', default: notificationPrefs === 'mention' }
      ])
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_join_set_penname_${storyId}`)
      .setLabel(cfg.btnJoinSetPenName)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`story_join_confirm_${storyId}`)
      .setLabel(cfg.btnJoinConfirm)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`story_join_cancel_${storyId}`)
      .setLabel(cfg.btnCancel)
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [privacyRow, notifRow, buttonRow] };
}

export async function handleJoin(connection, interaction, buttonStoryId = null) {
  log(`handleJoin entry: buttonStoryId=${buttonStoryId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  try {
    const guildId = interaction.guild.id;
    let storyId;
    if (buttonStoryId !== null) {
      storyId = buttonStoryId;
    } else {
      storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));
      if (storyId === null) {
        log(`handleJoin: storyId not found for input`, { show: false, guildName: interaction?.guild?.name });
        await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
        return;
      }
    }

    log(`handleJoin: calling validateJoinEligibility storyId=${storyId}`, { show: false, guildName: interaction?.guild?.name });
    const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
    log(`handleJoin: eligibility success=${joinInfo.success}`, { show: false, guildName: interaction?.guild?.name });
    if (!joinInfo.success) {
      await interaction.reply({ content: joinInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }

    log(`handleJoin: building embed`, { show: false, guildName: interaction?.guild?.name });
    const existingPenName = await getPreviousPenName(connection, interaction.user.id);
    const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
    const state = { storyId, guildId, storyTitle: joinInfo.story.title, privacy: 'public', notificationPrefs: 'dm', penName: existingPenName, displayName };
    pendingJoinData.set(interaction.user.id, state);

    const embedData = await buildJoinEmbed(connection, state);
    log(`handleJoin: replying`, { show: false, guildName: interaction?.guild?.name });
    await interaction.reply({ ...embedData, flags: MessageFlags.Ephemeral });
    log(`handleJoin: complete`, { show: false, guildName: interaction?.guild?.name });

  } catch (error) {
    log(`handleJoin failed for user=${interaction.user.username} storyId=${buttonStoryId ?? 'slash'}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    const errMsg = await getConfigValue(connection, 'txtJoinFormFailed', interaction.guild.id);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

/**
 * Handle join modal submission
 */
export async function handleJoinSetAO3Button(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const cfg = await getConfigValue(connection, ['lblJoinPenName', 'txtJoinPenNamePlaceholder', 'lblJoinSetPenNameModalTitle'], interaction.guild.id);
  const state = pendingJoinData.get(interaction.user.id);

  const modal = new ModalBuilder()
    .setCustomId(`story_join_penname_${storyId}`)
    .setTitle(cfg.lblJoinSetPenNameModalTitle);

  const input = new TextInputBuilder()
    .setCustomId('pen_name')
    .setLabel(cfg.lblJoinPenName)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder(cfg.txtJoinPenNamePlaceholder)
    .setMaxLength(255);

  if (state?.penName) input.setValue(state.penName);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleJoinAO3ModalSubmit(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const state = pendingJoinData.get(interaction.user.id);
  if (!state) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtJoinFormFailed', interaction.guild.id), flags: MessageFlags.Ephemeral });
    return;
  }
  state.penName = sanitizeModalInput(interaction.fields.getTextInputValue('pen_name'), 255) || '';
  pendingJoinData.set(interaction.user.id, state);

  await interaction.deferUpdate();
  await interaction.editReply(await buildJoinEmbed(connection, state));
}

export async function handleJoinConfirm(connection, interaction) {
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const state = pendingJoinData.get(interaction.user.id);
  log(`handleJoinConfirm entry: storyId=${storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  if (!state) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtJoinFormFailed', guildId), flags: MessageFlags.Ephemeral }).catch(error =>
      log(`handleJoinConfirm: no pending state, reply failed for storyId=${storyId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name })
    );
    return;
  }

  try {
    await interaction.deferUpdate();
  } catch (error) {
    log(`handleJoinConfirm: deferUpdate failed for storyId=${storyId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    return;
  }

  // Re-validate eligibility in case story changed while user was deciding
  const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
  log(`handleJoinConfirm: eligibility success=${joinInfo.success} storyId=${storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  if (!joinInfo.success) {
    await interaction.editReply({ content: joinInfo.error, embeds: [], components: [] }).catch(error =>
      log(`handleJoinConfirm: ineligible-reply edit failed for storyId=${storyId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name })
    );
    pendingJoinData.delete(interaction.user.id);
    return;
  }

  const joinInput = {
    penName: state.penName || null,
    writerTurnPrivacy: state.privacy === 'private' ? 1 : 0,
    notificationPrefs: state.notificationPrefs
  };

  // Transaction scope: only the DB write lives here. A failure past this point
  // must not be reported as a join failure, since the join already committed.
  const txn = await connection.getConnection();
  await txn.beginTransaction();
  let result;
  try {
    result = await StoryJoin(txn, interaction, joinInput, storyId);
    if (result.success) {
      await txn.commit();
    } else {
      await txn.rollback();
    }
  } catch (error) {
    await txn.rollback().catch(() => {});
    log(`handleJoinConfirm: transaction failed for storyId=${storyId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtJoinProcessFailed', guildId), embeds: [], components: [] }).catch(err =>
      log(`handleJoinConfirm: process-failed edit failed for storyId=${storyId} user=${interaction.user.username}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name })
    );
    return;
  } finally {
    txn.release();
  }

  if (!result.success) {
    await interaction.editReply({ content: result.error, embeds: [], components: [] }).catch(error =>
      log(`handleJoinConfirm: failure-reply edit failed for storyId=${storyId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name })
    );
    return;
  }

  // Join is committed. Everything below is best-effort notification/UI work —
  // each step is independent so one failing must not skip the others.
  pendingJoinData.delete(interaction.user.id);
  log(`handleJoinConfirm: join committed for storyId=${storyId} user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });

  const [[writerCount], [storyInfo]] = await Promise.all([
    connection.execute(`SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = ?`, [storyId, WRITER_STATUS.ACTIVE]),
    connection.execute(`SELECT title, story_thread_id, restricted_thread_id, rating FROM story WHERE story_id = ?`, [storyId])
  ]);

  const txtJoinSuccess = await getConfigValue(connection, 'txtJoinSuccess', guildId);
  const successMessage = replaceTemplateVariables(txtJoinSuccess, {
    story_title: storyInfo[0].title,
    writer_number: writerCount[0].count
  });

  await interaction.editReply({ content: `${successMessage}${result.confirmationMessage || ''}`, embeds: [], components: [] }).catch(error =>
    log(`handleJoinConfirm: success-confirmation edit failed for storyId=${storyId} user=${interaction.user.username} (join already committed): ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name })
  );

  await postStoryFeedJoinAnnouncement(connection, storyId, interaction, storyInfo[0].title);

  updateStoryStatusMessage(connection, interaction.guild, storyId).catch(error =>
    log(`handleJoinConfirm: updateStoryStatusMessage failed for storyId=${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name })
  );

  const activeThreadId = getActiveThreadId(storyInfo[0]);
  if (activeThreadId) {
    interaction.guild.channels.fetch(activeThreadId.toString())
      .then(thread => thread?.members.add(interaction.user.id))
      .catch(error =>
        log(`handleJoinConfirm: failed to add user=${interaction.user.username} to thread for storyId=${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name })
      );
  }

  const writerName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
  getConfigValue(connection, 'txtStoryThreadWriterJoin', guildId).then(template =>
    postStoryThreadActivity(connection, interaction.guild, storyId, replaceTemplateVariables(template, { writer_name: writerName }))
  ).catch(error =>
    log(`handleJoinConfirm: failed to post thread activity for storyId=${storyId} user=${interaction.user.username}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name })
  );
}
