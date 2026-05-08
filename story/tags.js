import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, checkIsAdmin, checkIsCreator, replaceTemplateVariables, resolveStoryId } from '../utilities.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the action row appended to every tag voting post in the story thread.
 * Two entry points: handleTagSubmitModalSubmit (new post) and public thread message buttons.
 * customIds:
 *   story_tag_delete_<submissionId>   — submitter / creator / admin only
 *   story_tag_view_proposed_<storyId> — all server members
 *   story_tag_manage_<storyId>        — creator / admin only (hidden from others via auth check on click)
 */
function buildThreadPostButtons(submissionId, storyId, btnDelete, btnViewProposed, btnManageTags) {
  log(`buildThreadPostButtons entry: submissionId=${submissionId}, storyId=${storyId}`, { show: false, guildName: interaction?.guild?.name });
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

/**
 * Slash command entry point: /story tag story_id:<id>
 * Opens the tag submission modal directly. Same modal as the read-view button.
 * customId: story_tag_submit_modal_<storyId>
 */
export async function handleTagCommand(connection, interaction) {
  const guildStoryId = interaction.options.getString('story_id');
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const storyId = await resolveStoryId(connection, guildId, guildStoryId);
  if (!storyId) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
    return;
  }
  log(`handleTagCommand entry: user=${userId}, guildStoryId=${guildStoryId}, storyId=${storyId}`, { show: false, guildName: interaction?.guild?.name });

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

/**
 * Button: "Submit Tag" — opens a modal for active writers to suggest a tag.
 * customId: story_submit_tag_<storyId>
 */
export async function handleTagSubmit(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  log(`handleTagSubmit entry: user=${userId}, storyId=${storyId}`, { show: false, guildName: interaction?.guild?.name });

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

  // Post to story thread for reaction voting
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

        // Add reaction votes
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

/**
 * First click: show ephemeral confirmation embed with confirm/cancel buttons.
 * customId: story_tag_delete_<submissionId>
 */
export async function handleTagDeleteButton(connection, interaction) {
  log(`handleTagDeleteButton: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
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

/**
 * Confirm delete: remove DB record, delete thread message, reply with success.
 * customId: story_tag_delete_confirm_<submissionId>
 */
export async function handleTagDeleteConfirm(connection, interaction) {
  log(`handleTagDeleteConfirm: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
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

  // Delete the thread voting post
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

  // Build success message with link to status post
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

/**
 * Cancel delete: dismiss the confirmation.
 * customId: story_tag_delete_cancel_<submissionId>
 */
export async function handleTagDeleteCancel(connection, interaction) {
  log(`handleTagDeleteCancel: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.update({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), embeds: [], components: [] });
}

// ─── Button: "View Proposed Tags" — all server members ──────────────────────

/**
 * Entry point from thread post button OR read view button.
 * customId: story_tag_view_proposed_<storyId>  (thread post)
 *           story_view_tags_<storyId>           (read view — kept for back-compat)
 */
export async function handleViewProposedTags(connection, interaction) {
  log(`handleViewProposedTags: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });

  // Support both customId patterns
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  const [rows] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text, thread_message_id
     FROM story_tag_submission
     WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [storyId]
  );

  const [storyRows] = await connection.execute(
    `SELECT title, story_thread_id FROM story WHERE story_id = ?`, [storyId]
  );
  const storyTitle = storyRows[0]?.title ?? '';
  const threadId = storyRows[0]?.story_thread_id;

  const cfg = await getConfigValue(connection, [
    'txtTagPendingTitlePublic', 'txtTagNoPendingPublic',
    'lblTagViewNameTag', 'lblTagViewNameVotes', 'btnManageTags'
  ], guildId);

  if (rows.length === 0) {
    await interaction.editReply({ content: cfg.txtTagNoPendingPublic });
    return;
  }

  // Fetch reaction counts for all tags
  let thread = null;
  if (threadId) {
    thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
  }

  const tagLines = [];
  for (let i = 0; i < rows.length; i++) {
    const tag = rows[i];
    let upVotes = 0;
    let downVotes = 0;
    let tagDisplay = `**"${tag.tag_text}"**`;

    if (tag.thread_message_id && thread) {
      try {
        const msg = await thread.messages.fetch(tag.thread_message_id).catch(() => null);
        if (msg) {
          upVotes = msg.reactions.cache.get('👍')?.count ?? 0;
          downVotes = msg.reactions.cache.get('👎')?.count ?? 0;
          const msgLink = `https://discord.com/channels/${guildId}/${threadId}/${tag.thread_message_id}`;
          tagDisplay = `[**"${tag.tag_text}"**](${msgLink})`;
        }
      } catch (err) {
        log(`handleViewProposedTags: reaction fetch failed for submission ${tag.submission_id}: ${err?.stack ?? err}`, { show: false, guildName: interaction?.guild?.name });
      }
    }

    tagLines.push(`${i + 1}. ${tagDisplay}:  👍(${upVotes}) 👎(${downVotes})`);
  }

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtTagPendingTitlePublic, { story_title: storyTitle }))
    .setDescription(
      `# ${cfg.lblTagViewNameTag} ​ ​ ​ ​ ${cfg.lblTagViewNameVotes}\n` +
      tagLines.join('\n')
    )
    .setColor(0x5865f2);

  const components = [];
  if (isCreator || isAdmin) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_manage_review_tags_read_${storyId}`)
        .setLabel(cfg.btnManageTags)
        .setStyle(ButtonStyle.Primary)
    ));
  }

  await interaction.editReply({ embeds: [embed], components });
}

// ─── Button: "Manage Tags" from thread post ──────────────────────────────────

/**
 * Entry point from thread post. Creator/admin only — opens the same review panel
 * as story_manage_review_tags_read_<storyId>. Auth check happens here so public
 * thread post button does not need per-user rendering.
 * customId: story_tag_manage_<storyId>
 */
export async function handleTagManageButton(connection, interaction) {
  log(`handleTagManageButton: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  if (!isCreator && !isAdmin) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagNotCreator', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  // Delegate to the shared Edit Tags handler (same panel, standalone entry point)
  await handleEditTagsButton(connection, interaction);
}

// ─── Button: "Edit/Manage Tags" from read view ───────────────────────────────

/**
 * Entry point from read view and from handleTagManageButton.
 * Two entry points documented:
 *   1. story_manage_review_tags_read_<storyId>  — read view "Manage Tags" button
 *   2. story_tag_manage_<storyId>               — thread post "Manage Tags" button (via handleTagManageButton)
 * customId: story_manage_review_tags_read_<storyId>
 */
export async function handleEditTagsButton(connection, interaction) {
  log(`handleEditTagsButton: user=${interaction.user.id} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);
  if (!isCreator && !isAdmin) {
    const replyFn = interaction.replied || interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
    await replyFn({ content: await getConfigValue(connection, 'txtTagNotCreator', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const [rows] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text, thread_message_id
     FROM story_tag_submission WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [storyId]
  );
  const [storyRows] = await connection.execute(`SELECT title, story_thread_id FROM story WHERE story_id = ?`, [storyId]);
  const storyTitle = storyRows[0]?.title ?? '';
  const threadId = storyRows[0]?.story_thread_id ?? null;

  const cfg = await getConfigValue(connection, [
    'txtTagPendingTitle', 'txtTagNoPending', 'btnTagApprove', 'btnTagReject', 'txtTagVoteCount'
  ], guildId);

  if (rows.length === 0) {
    const replyFn = interaction.replied || interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
    await replyFn({ content: cfg.txtTagNoPending, flags: MessageFlags.Ephemeral });
    return;
  }

  const firstTag = rows[0];
  const queueNote = rows.length > 1 ? ` (${rows.length - 1} more pending)` : '';

  let upVotes = 0;
  let downVotes = 0;
  if (firstTag.thread_message_id && threadId) {
    try {
      const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
      if (thread) {
        const msg = await thread.messages.fetch(firstTag.thread_message_id).catch(() => null);
        if (msg) {
          upVotes = msg.reactions.cache.get('👍')?.count ?? 0;
          downVotes = msg.reactions.cache.get('👎')?.count ?? 0;
        }
      }
    } catch (err) {
      log(`handleEditTagsButton: reaction fetch failed for submission ${firstTag.submission_id}: ${err?.stack ?? err}`, { show: false, guildName: interaction?.guild?.name });
    }
  }

  const voteText = replaceTemplateVariables(cfg.txtTagVoteCount, { up: upVotes, down: downVotes });

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtTagPendingTitle, { story_title: storyTitle }))
    .setDescription(`**"${firstTag.tag_text}"** — suggested by ${firstTag.submitter_display_name}${queueNote}\n${voteText}`)
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_tag_approve_${firstTag.submission_id}_${storyId}`)
      .setLabel(cfg.btnTagApprove)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`story_tag_reject_${firstTag.submission_id}_${storyId}`)
      .setLabel(cfg.btnTagReject)
      .setStyle(ButtonStyle.Danger)
  );

  const replyFn = interaction.replied || interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
  await replyFn({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

// ─── Paginated "View Tags" — writers / creator / admin (legacy read-view) ────

/**
 * Original paginated view for writers with approve/reject controls.
 * customId: story_view_tags_<storyId>
 * Now routes to handleViewProposedTags for unified public view.
 */
export async function handleViewTagsButton(connection, interaction) {
  await handleViewProposedTags(connection, interaction);
}

/**
 * Navigation buttons for the paginated view (legacy — kept for any in-flight sessions).
 * customId: story_tag_view_prev_<storyId>_<pageIndex>
 *           story_tag_view_next_<storyId>_<pageIndex>
 */
export async function handleViewTagsNav(connection, interaction) {
  log(`handleViewTagsNav: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  const parts = interaction.customId.split('_');
  const direction = parts[3];
  const storyId = parts[4];
  const currentPage = parseInt(parts[5]);
  const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  await interaction.deferUpdate();

  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  const [rows] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text, thread_message_id
     FROM story_tag_submission
     WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [storyId]
  );

  if (rows.length === 0) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagViewNone', guildId), embeds: [], components: [] });
    return;
  }

  const [storyRows] = await connection.execute(`SELECT title, story_thread_id FROM story WHERE story_id = ?`, [storyId]);
  const storyTitle = storyRows[0]?.title ?? '';
  const threadId = storyRows[0]?.story_thread_id;

  const cfg = await getConfigValue(connection, [
    'txtTagPendingTitle', 'txtTagVoteCount', 'txtTagVoteNote', 'btnTagApprove', 'btnTagReject'
  ], guildId);

  const pages = [];
  const thread = threadId ? await interaction.guild.channels.fetch(threadId).catch(() => null) : null;
  for (const tag of rows) {
    let upVotes = 0;
    let downVotes = 0;
    if (tag.thread_message_id && thread) {
      try {
        const msg = await thread.messages.fetch(tag.thread_message_id).catch(() => null);
        if (msg) {
          upVotes = msg.reactions.cache.get('👍')?.count ?? 0;
          downVotes = msg.reactions.cache.get('👎')?.count ?? 0;
        }
      } catch { /* best-effort */ }
    }
    pages.push({ tag, upVotes, downVotes });
  }

  const clampedPage = Math.min(Math.max(newPage, 0), pages.length - 1);
  const { tag, upVotes, downVotes } = pages[clampedPage];
  const voteText = replaceTemplateVariables(cfg.txtTagVoteCount, { up: upVotes, down: downVotes });

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtTagPendingTitle, { story_title: storyTitle }))
    .setDescription(`**"${tag.tag_text}"** — by ${tag.submitter_display_name}\n${voteText}\n${cfg.txtTagVoteNote}`)
    .setFooter({ text: `Tag ${clampedPage + 1} of ${pages.length}` })
    .setColor(0x5865f2);

  const components = [];
  if (pages.length > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_tag_view_prev_${storyId}_${clampedPage}`)
        .setLabel('◀️ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(clampedPage === 0),
      new ButtonBuilder()
        .setCustomId(`story_tag_view_next_${storyId}_${clampedPage}`)
        .setLabel('Next ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(clampedPage === pages.length - 1)
    ));
  }
  if (isCreator || isAdmin) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_tag_approve_${tag.submission_id}_${storyId}`)
        .setLabel(cfg.btnTagApprove)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`story_tag_reject_${tag.submission_id}_${storyId}`)
        .setLabel(cfg.btnTagReject)
        .setStyle(ButtonStyle.Danger)
    ));
  }

  await interaction.editReply({ embeds: [embed], components });
}
