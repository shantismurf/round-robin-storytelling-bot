import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, checkIsAdmin, checkIsCreator, replaceTemplateVariables, resolveStoryId } from '../utilities.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildThreadPostButtons(submissionId, storyId, btnDelete, btnViewProposed, btnManageTags) {
  log(`buildThreadPostButtons entry: submissionId=${submissionId}, storyId=${storyId}`, { show: false });
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_tag_delete_${submissionId}`)
      .setLabel(btnDelete)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`story_tag_view_proposed_${storyId}`)
      .setLabel(btnViewProposed)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`story_tag_manage_${storyId}`)
      .setLabel(btnManageTags)
      .setStyle(ButtonStyle.Secondary)
  );
}

// ─── /story tag subcommand ───────────────────────────────────────────────────

export async function handleTagCommand(connection, interaction) {
  const guildStoryId = interaction.options.getString('story_id');
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const storyId = await resolveStoryId(connection, guildId, guildStoryId);
  if (!storyId) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
    return;
  }
  log(`handleTagCommand entry: user=${interaction.user.username}, guildStoryId=${guildStoryId}, storyId=${storyId}`, { show: false, guildName: interaction?.guild?.name });

  const [writerRows] = await connection.execute(
    `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
    [storyId, userId]
  );
  if (writerRows.length === 0) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagSubmitNotWriter', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = buildTagSubmitModal(storyId, {
    title: await getConfigValue(connection, 'txtTagSubmitModalTitle', guildId),
    label: await getConfigValue(connection, 'lblTagSubmitText', guildId),
    placeholder: await getConfigValue(connection, 'txtTagSubmitPlaceholder', guildId),
  });
  await interaction.showModal(modal);
}

// ─── Button: "Submit Tag" from read view ────────────────────────────────────

export async function handleTagSubmit(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  log(`handleTagSubmit entry: user=${interaction.user.username}, storyId=${storyId}`, { show: false, guildName: interaction?.guild?.name });

  const [writerRows] = await connection.execute(
    `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
    [storyId, userId]
  );
  if (writerRows.length === 0) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagSubmitNotWriter', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = buildTagSubmitModal(storyId, {
    title: await getConfigValue(connection, 'txtTagSubmitModalTitle', guildId),
    label: await getConfigValue(connection, 'lblTagSubmitText', guildId),
    placeholder: await getConfigValue(connection, 'txtTagSubmitPlaceholder', guildId),
  });
  await interaction.showModal(modal);
}

function buildTagSubmitModal(storyId, { title, label, placeholder }) {
  log(`buildTagSubmitModal entry: storyId=${storyId}`, { show: false });

  const modal = new ModalBuilder()
    .setCustomId(`story_tag_submit_modal_${storyId}`)
    .setTitle(title);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('tag_text')
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200)
        .setPlaceholder(placeholder)
    )
  );
  return modal;
}

// ─── Modal submit ────────────────────────────────────────────────────────────

export async function handleTagSubmitModalSubmit(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const displayName = interaction.member?.displayName ?? interaction.user.username;
  log(`handleTagSubmitModalSubmit entry: user=${displayName}(${userId}), storyId=${storyId}`, { show: false, guildName: interaction?.guild?.name });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tagText = sanitizeModalInput(interaction.fields.getTextInputValue('tag_text'), 200);
  if (!tagText) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagSubmitPlaceholder', guildId) });
    return;
  }

  const [existing] = await connection.execute(
    `SELECT submission_id FROM story_tag_submission
     WHERE story_id = ? AND tag_text = ? AND submission_status = 'pending'`,
    [storyId, tagText]
  );
  if (existing.length > 0) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagSubmitDuplicate', guildId) });
    return;
  }

  const [insertResult] = await connection.execute(
    `INSERT INTO story_tag_submission (story_id, submitter_user_id, submitter_display_name, tag_text)
     VALUES (?, ?, ?, ?)`,
    [storyId, userId, displayName, tagText]
  );
  const submissionId = insertResult.insertId;
  log(`Tag "${tagText}" submitted for story ${storyId} by ${displayName} (submission_id=${submissionId})`, { show: true, guildName: interaction?.guild?.name });

  let threadMessageId = null;
  try {
    const [storyRows] = await connection.execute(
      `SELECT story_thread_id FROM story WHERE story_id = ?`, [storyId]
    );
    log(`handleTagSubmitModalSubmit: story_thread_id=${storyRows[0]?.story_thread_id}`, { show: false, guildName: interaction?.guild?.name });
    const threadId = storyRows[0]?.story_thread_id;
    if (threadId) {
      const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
      if (thread) {
        const cfg = await getConfigValue(connection, [
          'txtTagSubmitPosted', 'txtDelete', 'btnViewProposedTags', 'btnManageTags'
        ], guildId);

        const postContent = replaceTemplateVariables(cfg.txtTagSubmitPosted, {
          submitter_name: displayName,
          tag_text: tagText
        });
        const threadRow = buildThreadPostButtons(submissionId, storyId, cfg.txtDelete, cfg.btnViewProposedTags, cfg.btnManageTags);
        const threadMsg = await thread.send({ content: postContent, components: [threadRow] });
        threadMessageId = threadMsg.id;
        log(`handleTagSubmitModalSubmit: posted to thread ${threadId} message_id=${threadMessageId}`, { show: false, guildName: interaction?.guild?.name });

        await threadMsg.react('👍').catch(err => log(`handleTagSubmitModalSubmit: 👍 react failed: ${err?.stack ?? err}`, { show: true }));
        await threadMsg.react('👎').catch(err => log(`handleTagSubmitModalSubmit: 👎 react failed: ${err?.stack ?? err}`, { show: true }));

        await connection.execute(
          `UPDATE story_tag_submission SET thread_message_id = ? WHERE submission_id = ?`,
          [threadMessageId, submissionId]
        );
      }
    }
  } catch (err) {
    log(`handleTagSubmitModalSubmit failed to post to story thread: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }

  const successKey = threadMessageId ? 'txtTagSubmitSuccess' : 'txtTagSubmitNoThread';
  await interaction.editReply({ content: await getConfigValue(connection, successKey, guildId) });
}

// ─── Button: "Delete" on thread post (submitter / creator / admin) ───────────

export async function handleTagDeleteButton(connection, interaction) {
  log(`handleTagDeleteButton: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const submissionId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  const [rows] = await connection.execute(
    `SELECT submission_id, story_id, submitter_user_id, tag_text, submission_status
     FROM story_tag_submission WHERE submission_id = ?`,
    [submissionId]
  );
  if (rows.length === 0 || rows[0].submission_status !== 'pending') {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagDeleteNotFound', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const { story_id: storyId, submitter_user_id: submitterUserId, tag_text: tagText } = rows[0];

  const isSubmitter = String(userId) === String(submitterUserId);
  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  if (!isSubmitter && !isCreator && !isAdmin) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagNotSubmitter', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const cfg = await getConfigValue(connection, [
    'txtTagDeleteConfirmTitle', 'txtTagDeleteConfirmBody', 'btnTagDeleteConfirm', 'btnCancel'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtTagDeleteConfirmTitle)
    .setDescription(replaceTemplateVariables(cfg.txtTagDeleteConfirmBody, { tag_text: tagText }))
    .setColor(0xed4245);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_tag_delete_confirm_${submissionId}`)
      .setLabel(cfg.btnTagDeleteConfirm)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`story_tag_delete_cancel_${submissionId}`)
      .setLabel(cfg.btnCancel)
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleTagDeleteConfirm(connection, interaction) {
  log(`handleTagDeleteConfirm: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const submissionId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  await interaction.deferUpdate();

  const [rows] = await connection.execute(
    `SELECT submission_id, story_id, submitter_user_id, tag_text, thread_message_id, submission_status
     FROM story_tag_submission WHERE submission_id = ?`,
    [submissionId]
  );
  if (rows.length === 0 || rows[0].submission_status !== 'pending') {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagDeleteNotFound', guildId), embeds: [], components: [] });
    return;
  }

  const { story_id: storyId, submitter_user_id: submitterUserId, tag_text: tagText, thread_message_id: threadMessageId } = rows[0];

  const isSubmitter = String(userId) === String(submitterUserId);
  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  if (!isSubmitter && !isCreator && !isAdmin) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagNotSubmitter', guildId), embeds: [], components: [] });
    return;
  }

  await connection.execute(`DELETE FROM story_tag_submission WHERE submission_id = ?`, [submissionId]);
  log(`Tag submission ${submissionId} deleted by user ${userId}`, { show: true, guildName: interaction?.guild?.name });

  if (threadMessageId) {
    try {
      const [storyRows] = await connection.execute(`SELECT story_thread_id FROM story WHERE story_id = ?`, [storyId]);
      const threadId = storyRows[0]?.story_thread_id;
      if (threadId) {
        const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
        if (thread) {
          const msg = await thread.messages.fetch(threadMessageId).catch(() => null);
          if (msg) await msg.delete().catch(err => log(`handleTagDeleteConfirm: failed to delete thread post ${threadMessageId}: ${err?.stack ?? err}`, { show: true }));
        }
      }
    } catch (err) {
      log(`handleTagDeleteConfirm: error removing thread post: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
    }
  }

  let successText = '';
  try {
    const [storyRows] = await connection.execute(
      `SELECT story_thread_id, status_message_id, guild_story_id FROM story WHERE story_id = ?`, [storyId]
    );
    const { story_thread_id: threadId, status_message_id: statusMsgId, guild_story_id: guildStoryId } = storyRows[0] ?? {};
    const txtTemplate = await getConfigValue(connection, 'txtTagDeleteSuccess', guildId);
    const threadLink = (threadId && statusMsgId)
      ? `https://discord.com/channels/${guildId}/${threadId}/${statusMsgId}`
      : (threadId ? `https://discord.com/channels/${guildId}/${threadId}` : '');
    successText = replaceTemplateVariables(txtTemplate, {
      tag_text: tagText,
      thread_link: threadLink,
      story_id: guildStoryId ?? storyId
    });
  } catch (err) {
    log(`handleTagDeleteConfirm: failed building success message: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
    successText = `"${tagText}" has been removed.`;
  }

  await interaction.editReply({ content: successText, embeds: [], components: [] });
}

export async function handleTagDeleteCancel(connection, interaction) {
  log(`handleTagDeleteCancel: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.update({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
}
