import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId, checkIsAdmin, checkIsCreator } from '../utilities.js';
import { updateStoryStatusMessage, deleteThreadAndAnnouncement } from '../storybot.js';
import { postStoryFeedClosedAnnouncement } from '../announcements.js';
import { generateStoryExport } from './export.js';

export async function handleClose(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  if (storyId === null) {
    return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, title, story_status FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
    }
    const story = storyRows[0];

    if (story.story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryAlreadyClosed', guildId) });
    }

    // Auth: oldest active writer (creator) OR admin role
    const [creatorRows] = await connection.execute(
      `SELECT discord_user_id FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY joined_at ASC LIMIT 1`,
      [storyId]
    );
    const isCreator = creatorRows.length > 0 && String(creatorRows[0].discord_user_id) === interaction.user.id;
    const isAdmin = await checkIsAdmin(connection, interaction, guildId);

    if (!isCreator && !isAdmin) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryCloseNotAuthorized', guildId) });
    }

    const [txtStoryCloseConfirm, btnCloseConfirm, btnCancel] = await Promise.all([
      getConfigValue(connection, 'txtStoryCloseConfirm', guildId),
      getConfigValue(connection, 'btnCloseConfirm', guildId),
      getConfigValue(connection, 'btnCancel', guildId)
    ]);

    const confirmMsg = replaceTemplateVariables(txtStoryCloseConfirm, { story_title: story.title });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_close_confirm_${storyId}`)
        .setLabel(btnCloseConfirm)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`story_close_cancel_${storyId}`)
        .setLabel(btnCancel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: confirmMsg, components: [row] });

  } catch (error) {
    log(`Error in handleClose: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export async function handleCloseConfirm(connection, interaction) {
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, story_thread_id, quick_mode FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0 || storyRows[0].story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFoundOrClosed', guildId), components: [] });
    }
    const story = storyRows[0];

    // End active turn if exists, delete its thread in normal mode
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId]
    );
    if (activeTurnRows.length > 0) {
      const activeTurn = activeTurnRows[0];
      await connection.execute(
        `UPDATE turn SET turn_status = 0, ended_at = NOW() WHERE turn_id = ?`,
        [activeTurn.turn_id]
      );
      if (!story.quick_mode && activeTurn.thread_id) {
        try {
          const turnThread = await interaction.guild.channels.fetch(activeTurn.thread_id);
          if (turnThread) await deleteThreadAndAnnouncement(turnThread);
        } catch (err) {
          log(`Could not delete turn thread ${activeTurn.thread_id}: ${err}`, { show: true, guildName: interaction?.guild?.name });
        }
      }
    }

    // Close the story
    await connection.execute(
      `UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`,
      [storyId]
    );

    // Generate export (story is now marked closed so closed_at will be set in the file)
    const exportResult = await generateStoryExport(connection, storyId, guildId, interaction.guild);
    const turnCount = exportResult?.turnCount ?? 0;
    const wordCount = exportResult?.wordCount ?? 0;
    const writerCount = exportResult?.writerCount ?? 0;

    // Update story thread title and post close message (if thread still exists)
    if (story.story_thread_id) {
      try {
        const storyThread = await interaction.guild.channels.fetch(story.story_thread_id);
        if (storyThread) {
          // Update thread title to reflect closed status
          const [threadTitleTemplate, txtClosed] = await Promise.all([
            getConfigValue(connection, 'txtStoryThreadTitle', guildId),
            getConfigValue(connection, 'txtClosed', guildId)
          ]);
          const updatedTitle = threadTitleTemplate
            .replace('[story_id]', story.guild_story_id)
            .replace('[inputStoryTitle]', story.title)
            .replace('[story_status]', txtClosed);
          await storyThread.setName(updatedTitle);

          const txtStoryClosedPublic = await getConfigValue(connection, 'txtStoryClosedPublic', guildId);
          const closedMsg = replaceTemplateVariables(txtStoryClosedPublic, {
            story_title: story.title,
            writer_count: writerCount,
            turn_count: turnCount,
            word_count: wordCount.toLocaleString()
          });
          const messageOptions = { content: closedMsg };
          if (exportResult?.hasEntries) messageOptions.files = [{ attachment: exportResult.buffer, name: exportResult.filename }];
          await storyThread.send(messageOptions);
        }
      } catch (err) {
        log(`Story thread not available for close post (story ${storyId})`, { show: false, guildName: interaction?.guild?.name });
      }
    }

    // Feed announcement — only if there are confirmed entries
    if (turnCount > 0) {
      await postStoryFeedClosedAnnouncement(connection, interaction, story.title, turnCount, wordCount, writerCount, exportResult);
    }

    updateStoryStatusMessage(connection, interaction.guild, storyId).catch(() => {});

    // Clear confirmation buttons
    await interaction.editReply({ content: '✅', components: [] });

  } catch (error) {
    log(`Error in handleCloseConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export async function handleCloseCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
}
