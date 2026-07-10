import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, checkIsAdmin, checkIsCreator, replaceTemplateVariables } from '../utilities.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
export { handleTagCommand, handleTagSubmit, handleTagSubmitModalSubmit, handleTagDeleteButton, handleTagDeleteConfirm, handleTagDeleteCancel } from './_tagSubmit.js';

// ─── Button: "View Proposed Tags" — all server members ──────────────────────

export async function handleViewProposedTags(connection, interaction) {
  log(`handleViewProposedTags: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

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

export async function handleTagManageButton(connection, interaction) {
  log(`handleTagManageButton: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  if (!isCreator && !isAdmin) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagNotCreator', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  await handleEditTagsButton(connection, interaction);
}

// ─── Button: "Edit/Manage Tags" from read view ───────────────────────────────

export async function handleEditTagsButton(connection, interaction, pageIndex = 0) {
  log(`handleEditTagsButton: user=${interaction.user.username} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
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
    await replyFn({ content: cfg.txtTagNoPending, embeds: [], components: [], flags: MessageFlags.Ephemeral });
    return;
  }

  const page = Math.min(pageIndex, rows.length - 1);
  const { embeds, components } = await buildTagReviewPanel(rows, page, storyId, storyTitle, threadId, cfg, interaction.guild);
  const replyFn = interaction.replied || interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
  await replyFn({ embeds, components, flags: MessageFlags.Ephemeral });
}

export async function handleTagReviewNav(connection, interaction) {
  log(`handleTagReviewNav: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const parts = interaction.customId.split('_');
  const storyId = parts[4];
  const page = parseInt(parts[5]);
  const guildId = interaction.guild.id;

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
    await interaction.update({ content: cfg.txtTagNoPending, embeds: [], components: [] });
    return;
  }

  const safePage = Math.min(Math.max(page, 0), rows.length - 1);
  const { embeds, components } = await buildTagReviewPanel(rows, safePage, storyId, storyTitle, threadId, cfg, interaction.guild);
  await interaction.update({ embeds, components });
}

export async function buildTagReviewPanel(rows, pageIndex, storyId, storyTitle, threadId, cfg, guild) {
  const tag = rows[pageIndex];
  const total = rows.length;
  const pageLabel = total > 1 ? ` (${pageIndex + 1} of ${total})` : '';

  let upVotes = 0;
  let downVotes = 0;
  if (tag.thread_message_id && threadId) {
    try {
      const thread = await guild.channels.fetch(threadId).catch(() => null);
      if (thread) {
        const msg = await thread.messages.fetch(tag.thread_message_id).catch(() => null);
        if (msg) {
          upVotes = msg.reactions.cache.get('👍')?.count ?? 0;
          downVotes = msg.reactions.cache.get('👎')?.count ?? 0;
        }
      }
    } catch {
      // vote fetch is best-effort
    }
  }

  const voteText = replaceTemplateVariables(cfg.txtTagVoteCount, { up: upVotes, down: downVotes });
  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtTagPendingTitle, { story_title: storyTitle }))
    .setDescription(`**"${tag.tag_text}"** — suggested by ${tag.submitter_display_name}${pageLabel}\n${voteText}`)
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_tag_review_prev_${storyId}_${pageIndex - 1}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`story_tag_approve_${tag.submission_id}_${storyId}_${pageIndex}`)
      .setLabel(cfg.btnTagApprove)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`story_tag_reject_${tag.submission_id}_${storyId}_${pageIndex}`)
      .setLabel(cfg.btnTagReject)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`story_tag_review_next_${storyId}_${pageIndex + 1}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex === total - 1)
  );

  return { embeds: [embed], components: [row] };
}

// ─── Paginated "View Tags" — legacy read-view ────────────────────────────────

export async function handleViewTagsButton(connection, interaction) {
  await handleViewProposedTags(connection, interaction);
}

export async function handleViewTagsNav(connection, interaction) {
  log(`handleViewTagsNav: customId=${interaction.customId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
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

// ─── Tag Review (manage panel) ───────────────────────────────────────────────

export async function handleReviewTags(connection, interaction, state) {
  log(`handleReviewTags entry storyId=${state.storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  const [rows] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text, thread_message_id
     FROM story_tag_submission
     WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [state.storyId]
  );

  if (rows.length === 0) {
    await interaction.reply({ content: state.cfg.txtTagNoPending, flags: MessageFlags.Ephemeral });
    return;
  }

  const { embeds, components } = await buildTagReviewPanel(rows, 0, state.storyId, state.title, state.storyThreadId, state.cfg, interaction.guild);
  await interaction.reply({ embeds, components, flags: MessageFlags.Ephemeral });
}

export async function handleTagReviewButton(connection, interaction) {
  log(`handleTagReviewButton entry user=${interaction.user.username} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const parts = interaction.customId.split('_');
  const action = parts[2]; // 'approve' or 'reject'
  const submissionId = parts[3];
  const storyId = parts[4];
  const pageIndex = parseInt(parts[5] ?? '0');
  const guildId = interaction.guild.id;

  const isCreator = await checkIsCreator(connection, storyId, interaction.user.id);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);
  if (!isCreator && !isAdmin) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagNotCreator', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const [rows] = await connection.execute(
    `SELECT tag_text, thread_message_id FROM story_tag_submission WHERE submission_id = ? AND submission_status = 'pending'`,
    [submissionId]
  );
  if (rows.length === 0) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagReviewSessionExpired', guildId), flags: MessageFlags.Ephemeral });
    return;
  }
  const { tag_text: tagText, thread_message_id: threadMessageId } = rows[0];
  const reviewerName = interaction.member?.displayName ?? interaction.user.username;
  const reviewedAt = Date.now();

  await interaction.deferUpdate();

  const cfg = await getConfigValue(connection, ['txtTagApproved', 'txtTagRejected', 'txtTagStatus', 'txtApproved', 'txtRejected'], guildId);

  const isApprove = action === 'approve';
  const emojiStatus = isApprove ? `✅ ${cfg.txtApproved}` : `❌ ${cfg.txtRejected}`;
  const statusLine = replaceTemplateVariables(cfg.txtTagStatus, {
    emoji_status: emojiStatus,
    reviewed_by: reviewerName,
    reviewed_at: `<t:${Math.floor(reviewedAt / 1000)}:d> <t:${Math.floor(reviewedAt / 1000)}:T>`
  });

  const [storyThreadRows] = await connection.execute(`SELECT story_thread_id FROM story WHERE story_id = ?`, [storyId]);
  const storyThreadId = storyThreadRows[0]?.story_thread_id ?? null;
  if (threadMessageId && storyThreadId) {
    try {
      const thread = await interaction.guild.channels.fetch(storyThreadId).catch(() => null);
      if (thread) {
        const msg = await thread.messages.fetch(threadMessageId).catch(() => null);
        if (msg) {
          await msg.edit(`${msg.content}\n${statusLine}`).catch(err =>
            log(`handleTagReviewButton: failed to edit thread post ${threadMessageId}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name })
          );
        }
      }
    } catch (err) {
      log(`handleTagReviewButton: error editing thread post: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
    }
  }

  const txn = await connection.getConnection();
  await txn.beginTransaction();
  let staleReview = false;
  try {
    if (isApprove) {
      log(`handleTagReviewButton: approving tag "${tagText}" for story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
      const [claimResult] = await txn.execute(
        `UPDATE story_tag_submission SET submission_status = 'approved', reviewed_at = NOW(), reviewed_by_display_name = ? WHERE submission_id = ? AND submission_status = 'pending'`,
        [reviewerName, submissionId]
      );
      if (claimResult.affectedRows !== 1) {
        staleReview = true;
      } else {
        // Lock the story row so two concurrent approvals for the same story can't
        // both read the same pre-update tags value and clobber each other's append.
        const [storyRows] = await txn.execute(`SELECT tags FROM story WHERE story_id = ? FOR UPDATE`, [storyId]);
        const existingTags = (storyRows[0]?.tags?.trim() || '').split(',').map(t => t.trim()).filter(Boolean);
        if (!existingTags.includes(tagText)) {
          existingTags.push(tagText);
          await txn.execute(`UPDATE story SET tags = ? WHERE story_id = ?`, [existingTags.join(', '), storyId]);
        }
      }
    } else {
      log(`handleTagReviewButton: rejecting tag "${tagText}" for story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
      const [claimResult] = await txn.execute(
        `UPDATE story_tag_submission SET submission_status = 'rejected', reviewed_at = NOW(), reviewed_by_display_name = ? WHERE submission_id = ? AND submission_status = 'pending'`,
        [reviewerName, submissionId]
      );
      if (claimResult.affectedRows !== 1) staleReview = true;
    }
    await txn.commit();
  } catch (err) {
    await txn.rollback();
    throw err;
  } finally {
    txn.release();
  }

  if (staleReview) {
    log(`handleTagReviewButton: submission ${submissionId} already reviewed by another admin — no-op`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagReviewSessionExpired', guildId), embeds: [], components: [] });
    return;
  }

  if (isApprove) {
    updateStoryStatusMessage(connection, interaction.guild, storyId).catch(err => log(`updateStoryStatusMessage failed for story ${storyId} after tag approve: ${err}`, { show: true, guildName: interaction?.guild?.name }));
  }

  const [remaining] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text, thread_message_id
     FROM story_tag_submission WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [storyId]
  );

  const actionCfg = await getConfigValue(connection, [
    'txtTagPendingTitle', 'txtTagNoPending', 'btnTagApprove', 'btnTagReject',
    'txtTagVoteCount', 'txtTagApproved', 'txtTagRejected'
  ], guildId);

  if (remaining.length === 0) {
    const doneMsg = isApprove
      ? replaceTemplateVariables(actionCfg.txtTagApproved, { tag_text: tagText })
      : replaceTemplateVariables(actionCfg.txtTagRejected, { tag_text: tagText });
    await interaction.editReply({ content: doneMsg, embeds: [], components: [] });
    return;
  }

  const [storyMeta] = await connection.execute(`SELECT title, story_thread_id FROM story WHERE story_id = ?`, [storyId]);
  const nextPage = Math.min(pageIndex, remaining.length - 1);
  const { embeds, components } = await buildTagReviewPanel(
    remaining, nextPage, storyId, storyMeta[0]?.title ?? '', storyMeta[0]?.story_thread_id ?? null, actionCfg, interaction.guild
  );
  await interaction.editReply({ content: '', embeds, components });
}
