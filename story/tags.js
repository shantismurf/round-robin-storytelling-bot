import { ModalBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, checkIsAdmin, checkIsCreator, replaceTemplateVariables } from '../utilities.js';

/**
 * Button: "Suggest a Tag" — opens a modal for active writers to submit a tag.
 * customId: story_submit_tag (must carry story ID in a separate location —
 * stored in the button's customId as story_submit_tag_<storyId>).
 */
export async function handleTagSubmit(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;

  // Only active writers in this story can submit
  const [writerRows] = await connection.execute(
    `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
    [storyId, userId]
  );
  if (writerRows.length === 0) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagSubmitNotWriter', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`story_tag_submit_modal_${storyId}`)
    .setTitle(await getConfigValue(connection, 'txtTagSubmitModalTitle', guildId));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('tag_text')
        .setLabel(await getConfigValue(connection, 'lblTagSubmitText', guildId))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200)
        .setPlaceholder(await getConfigValue(connection, 'txtTagSubmitPlaceholder', guildId))
    )
  );

  await interaction.showModal(modal);
}

export async function handleTagSubmitModalSubmit(connection, interaction) {
  // customId: story_tag_submit_modal_<storyId>
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;
  const displayName = interaction.member?.displayName ?? interaction.user.username;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tagText = sanitizeModalInput(interaction.fields.getTextInputValue('tag_text'), 200);
  if (!tagText) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagSubmitPlaceholder', guildId) });
    return;
  }

  // Check for duplicate pending submission
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
  log(`Tag "${tagText}" submitted for story ${storyId} by ${displayName} (submission_id=${submissionId})`, { show: false });

  // Post to story thread for reaction voting if thread exists
  let threadMessageId = null;
  try {
    const [storyRows] = await connection.execute(
      `SELECT story_thread_id FROM story WHERE story_id = ?`, [storyId]
    );
    log(`handleTagSubmitModalSubmit: story_thread_id=${storyRows[0]?.story_thread_id}`, { show: false });
    const threadId = storyRows[0]?.story_thread_id;
    if (threadId) {
      const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
      if (thread) {
        const txtTagSubmitPosted = await getConfigValue(connection, 'txtTagSubmitPosted', guildId);
        const postContent = replaceTemplateVariables(txtTagSubmitPosted, {
          submitter_name: displayName,
          tag_text: tagText
        });
        const threadMsg = await thread.send(postContent);
        threadMessageId = threadMsg.id;
        log(`handleTagSubmitModalSubmit: posted to thread ${threadId} message_id=${threadMessageId}`, { show: false });
        await connection.execute(
          `UPDATE story_tag_submission SET thread_message_id = ? WHERE submission_id = ?`,
          [threadMessageId, submissionId]
        );
      }
    }
  } catch (err) {
    log(`handleTagSubmitModalSubmit: failed to post to story thread: ${err?.stack ?? err}`, { show: true });
  }

  const successKey = threadMessageId ? 'txtTagSubmitSuccess' : 'txtTagSubmitNoThread';
  await interaction.editReply({ content: await getConfigValue(connection, successKey, guildId) });
}

/**
 * Button: "View Tags" — paginated view of pending tag submissions with live reaction counts.
 * customId: story_view_tags_<storyId>
 */
export async function handleViewTagsButton(connection, interaction) {
  log(`handleViewTagsButton: user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isCreator = await checkIsCreator(connection, storyId, userId);
  const isAdmin = await checkIsAdmin(connection, interaction, guildId);

  const [rows] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text, thread_message_id, submission_status
     FROM story_tag_submission
     WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [storyId]
  );
  log(`handleViewTagsButton: storyId=${storyId} pending=${rows.length}`, { show: false, guildName: interaction?.guild?.name });

  if (rows.length === 0) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagViewNone', guildId) });
    return;
  }

  const [storyRows] = await connection.execute(`SELECT title, story_thread_id FROM story WHERE story_id = ?`, [storyId]);
  const storyTitle = storyRows[0]?.title ?? '';
  const threadId = storyRows[0]?.story_thread_id;

  const cfg = await getConfigValue(connection, [
    'txtTagPendingTitle', 'txtTagVoteCount', 'txtTagVoteNote',
    'btnTagApprove', 'btnTagReject', 'txtTagNoPending'
  ], guildId);

  const pages = [];
  for (const tag of rows) {
    let upVotes = 0;
    let downVotes = 0;
    if (tag.thread_message_id && threadId) {
      try {
        const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
        if (thread) {
          const msg = await thread.messages.fetch(tag.thread_message_id).catch(() => null);
          if (msg) {
            const thumbsUp = msg.reactions.cache.get('👍');
            const thumbsDown = msg.reactions.cache.get('👎');
            upVotes = thumbsUp ? thumbsUp.count : 0;
            downVotes = thumbsDown ? thumbsDown.count : 0;
          }
        }
      } catch (err) {
        log(`handleViewTagsButton: failed to fetch reactions for submission ${tag.submission_id}: ${err?.stack ?? err}`, { show: false, guildName: interaction?.guild?.name });
      }
    }
    pages.push({ tag, upVotes, downVotes });
  }

  function buildTagPage(pageIndex) {
    const { tag, upVotes, downVotes } = pages[pageIndex];
    const voteText = replaceTemplateVariables(cfg.txtTagVoteCount, { up: upVotes, down: downVotes });
    const embed = new EmbedBuilder()
      .setTitle(replaceTemplateVariables(cfg.txtTagPendingTitle, { story_title: storyTitle }))
      .setDescription(`**"${tag.tag_text}"** — by ${tag.submitter_display_name}\n${voteText}\n${cfg.txtTagVoteNote}`)
      .setFooter({ text: `Tag ${pageIndex + 1} of ${pages.length}` })
      .setColor(0x5865f2);

    const components = [];

    if (pages.length > 1) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`story_tag_view_prev_${storyId}_${pageIndex}`)
          .setLabel('◀️ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageIndex === 0),
        new ButtonBuilder()
          .setCustomId(`story_tag_view_next_${storyId}_${pageIndex}`)
          .setLabel('Next ▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageIndex === pages.length - 1)
      ));
    }

    if (isCreator || isAdmin) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`story_tag_approve_${tag.submission_id}_${storyId}`)
          .setLabel(cfg.btnTagApprove ?? '✅ Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`story_tag_reject_${tag.submission_id}_${storyId}`)
          .setLabel(cfg.btnTagReject ?? '❌ Reject')
          .setStyle(ButtonStyle.Danger)
      ));
    }

    return { embeds: [embed], components };
  }

  await interaction.editReply(buildTagPage(0));
}

/**
 * "Edit Tags" button from read view — opens the same approve/reject review panel as /story manage.
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
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagNotCreator', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const [rows] = await connection.execute(
    `SELECT submission_id, submitter_display_name, tag_text
     FROM story_tag_submission WHERE story_id = ? AND submission_status = 'pending'
     ORDER BY submitted_at ASC`,
    [storyId]
  );
  const [storyRows] = await connection.execute(`SELECT title FROM story WHERE story_id = ?`, [storyId]);
  const storyTitle = storyRows[0]?.title ?? '';

  const cfg = await getConfigValue(connection, [
    'txtTagPendingTitle', 'txtTagNoPending', 'btnTagApprove', 'btnTagReject'
  ], guildId);

  if (rows.length === 0) {
    await interaction.reply({ content: cfg.txtTagNoPending ?? 'No pending tag suggestions.', flags: MessageFlags.Ephemeral });
    return;
  }

  const firstTag = rows[0];
  const queueNote = rows.length > 1 ? ` (${rows.length - 1} more pending)` : '';

  const embed = new EmbedBuilder()
    .setTitle(replaceTemplateVariables(cfg.txtTagPendingTitle ?? '🏷️ Pending Tags — [story_title]', { story_title: storyTitle }))
    .setDescription(`**"${firstTag.tag_text}"** — suggested by ${firstTag.submitter_display_name}${queueNote}`)
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_tag_approve_${firstTag.submission_id}_${storyId}`)
      .setLabel(cfg.btnTagApprove ?? '✅ Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`story_tag_reject_${firstTag.submission_id}_${storyId}`)
      .setLabel(cfg.btnTagReject ?? '❌ Reject')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

/**
 * Navigation buttons for the View Tags paginated panel.
 * customId: story_tag_view_prev_<storyId>_<pageIndex>
 *           story_tag_view_next_<storyId>_<pageIndex>
 */
export async function handleViewTagsNav(connection, interaction) {
  log(`handleViewTagsNav: customId=${interaction.customId} user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  const parts = interaction.customId.split('_');
  // story_tag_view_prev_<storyId>_<pageIndex>
  const direction = parts[3]; // 'prev' or 'next'
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
  for (const tag of rows) {
    let upVotes = 0;
    let downVotes = 0;
    if (tag.thread_message_id && threadId) {
      try {
        const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
        if (thread) {
          const msg = await thread.messages.fetch(tag.thread_message_id).catch(() => null);
          if (msg) {
            upVotes = msg.reactions.cache.get('👍')?.count ?? 0;
            downVotes = msg.reactions.cache.get('👎')?.count ?? 0;
          }
        }
      } catch { /* swallow — reaction fetch is best-effort */ }
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
        .setLabel(cfg.btnTagApprove ?? '✅ Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`story_tag_reject_${tag.submission_id}_${storyId}`)
        .setLabel(cfg.btnTagReject ?? '❌ Reject')
        .setStyle(ButtonStyle.Danger)
    ));
  }

  await interaction.editReply({ embeds: [embed], components });
}
