import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables, resolveStoryId } from '../utilities.js';
import { StoryJoin, updateStoryStatusMessage, postStoryThreadActivity } from '../storybot.js';
import { postStoryFeedJoinAnnouncement } from '../announcements.js';

// Pending join sessions keyed by userId
export const pendingJoinData = new Map();

async function getPreviousAO3Name(connection, userId) {
  try {
    const [rows] = await connection.execute(
      `SELECT AO3_name FROM story_writer WHERE discord_user_id = ? AND AO3_name IS NOT NULL AND AO3_name != '' ORDER BY joined_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0]?.AO3_name ?? null;
  } catch { return null; }
}

export async function validateJoinEligibility(connection, storyId, guildId, userId) {
  try {
    // Get story info with writer count
    const [storyInfo] = await connection.execute(`
      SELECT s.*, COUNT(sw.story_writer_id) as current_writers
      FROM story s
      LEFT JOIN story_writer sw ON s.story_id = sw.story_id AND sw.sw_status = 1
      WHERE s.story_id = ? AND s.guild_id = ?
      GROUP BY s.story_id
    `, [storyId, guildId]);

    if (storyInfo.length === 0) {
      return { success: false, error: await getConfigValue(connection,'txtStoryNotFound', guildId) };
    }

    const story = storyInfo[0];

    // Check if story is closed
    if (story.story_status === 3) {
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
      WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1
    `, [storyId, userId]);

    if (existingWriter.length > 0) {
      return { success: false, error: await getConfigValue(connection,'txtMemberStatusJoined', guildId) };
    }

    return { success: true, story };

  } finally {
    // Connection is persistent, no need to release
  }
}

export async function buildJoinEmbed(connection, state) {
  const { storyId, guildId, storyTitle, privacy, notificationPrefs, ao3Name, displayName } = state;
  const cfg = await getConfigValue(connection, [
    'txtJoinEmbedDesc', 'lblJoinPrivacySelect', 'lblJoinNotifSelect',
    'lblJoinAO3Name', 'txtJoinAO3NotSet', 'btnJoinSetAO3', 'btnJoinConfirm', 'btnCancel'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(`🎭 Join "${storyTitle}"`)
    .setDescription(cfg.txtJoinEmbedDesc)
    .addFields(
      { name: cfg.lblJoinPrivacySelect, value: privacy === 'private' ? '🔒 Private' : '🌐 Public', inline: true },
      { name: cfg.lblJoinNotifSelect, value: notificationPrefs === 'dm' ? '💬 DM' : '📢 Mention in channel', inline: true },
      { name: cfg.lblJoinAO3Name, value: ao3Name || (displayName ? `${displayName} (Discord display name)` : cfg.txtJoinAO3NotSet), inline: false }
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
      .setCustomId(`story_join_set_ao3_${storyId}`)
      .setLabel(cfg.btnJoinSetAO3)
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
  try {
    const guildId = interaction.guild.id;
    let storyId;
    if (buttonStoryId !== null) {
      storyId = buttonStoryId;
    } else {
      storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
      if (storyId === null) {
        await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
        return;
      }
    }

    const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
    if (!joinInfo.success) {
      await interaction.reply({ content: joinInfo.error, flags: MessageFlags.Ephemeral });
      return;
    }

    const existingAO3Name = await getPreviousAO3Name(connection, interaction.user.id);
    const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
    const state = { storyId, guildId, storyTitle: joinInfo.story.title, privacy: 'public', notificationPrefs: 'dm', ao3Name: existingAO3Name, displayName };
    pendingJoinData.set(interaction.user.id, state);

    // Add user to thread before replying so the ephemeral is visible to them
    if (interaction.channel?.isThread?.()) {
      await interaction.channel.members.add(interaction.user.id).catch(() => {});
    }

    const embedData = await buildJoinEmbed(connection, state);
    await interaction.reply({ ...embedData, flags: MessageFlags.Ephemeral });

  } catch (error) {
    log(`handleJoin failed for user=${interaction.user.id} storyId=${buttonStoryId ?? 'slash'}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
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
  const cfg = await getConfigValue(connection, ['lblJoinAO3Name', 'txtJoinAO3Placeholder'], interaction.guild.id);
  const state = pendingJoinData.get(interaction.user.id);

  const modal = new ModalBuilder()
    .setCustomId(`story_join_ao3_${storyId}`)
    .setTitle('Set AO3 Username');

  const input = new TextInputBuilder()
    .setCustomId('ao3_name')
    .setLabel(cfg.lblJoinAO3Name)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder(cfg.txtJoinAO3Placeholder)
    .setMaxLength(255);

  if (state?.ao3Name) input.setValue(state.ao3Name);

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
  state.ao3Name = sanitizeModalInput(interaction.fields.getTextInputValue('ao3_name'), 255) || '';
  pendingJoinData.set(interaction.user.id, state);

  await interaction.deferUpdate();
  await interaction.editReply(await buildJoinEmbed(connection, state));
}

export async function handleJoinConfirm(connection, interaction) {
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;
  const state = pendingJoinData.get(interaction.user.id);

  if (!state) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtJoinFormFailed', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  // Re-validate eligibility in case story changed while user was deciding
  const joinInfo = await validateJoinEligibility(connection, storyId, guildId, interaction.user.id);
  if (!joinInfo.success) {
    await interaction.editReply({ content: joinInfo.error, embeds: [], components: [] });
    pendingJoinData.delete(interaction.user.id);
    return;
  }

  const joinInput = {
    ao3Name: state.ao3Name || null,
    turnPrivacy: state.privacy === 'private' ? 1 : 0,
    notificationPrefs: state.notificationPrefs
  };

  const txn = await connection.getConnection();
  await txn.beginTransaction();
  try {
    const result = await StoryJoin(txn, interaction, joinInput, storyId);

    if (result.success) {
      await txn.commit();
      pendingJoinData.delete(interaction.user.id);

      const [[writerCount], [storyInfo]] = await Promise.all([
        connection.execute(`SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1`, [storyId]),
        connection.execute(`SELECT title, story_thread_id FROM story WHERE story_id = ?`, [storyId])
      ]);

      const txtJoinSuccess = await getConfigValue(connection, 'txtJoinSuccess', guildId);
      const successMessage = replaceTemplateVariables(txtJoinSuccess, {
        story_title: storyInfo[0].title,
        writer_number: writerCount[0].count
      });

      await interaction.editReply({ content: `${successMessage}${result.confirmationMessage || ''}`, embeds: [], components: [] });

      await postStoryFeedJoinAnnouncement(connection, storyId, interaction, storyInfo[0].title);
      updateStoryStatusMessage(connection, interaction.guild, storyId).catch(() => {});

      if (storyInfo[0].story_thread_id) {
        interaction.guild.channels.fetch(storyInfo[0].story_thread_id.toString())
          .then(thread => thread?.members.add(interaction.user.id))
          .catch(() => {});
      }

      const writerName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
      getConfigValue(connection, 'txtStoryThreadWriterJoin', guildId).then(template =>
        postStoryThreadActivity(connection, interaction.guild, storyId, template.replace('[writer_name]', writerName))
      ).catch(() => {});

    } else {
      await txn.rollback();
      await interaction.editReply({ content: result.error, embeds: [], components: [] });
    }
  } catch (error) {
    await txn.rollback();
    log(`handleJoinConfirm failed for storyId=${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtJoinProcessFailed', guildId), embeds: [], components: [] });
  } finally {
    txn.release();
  }
}
