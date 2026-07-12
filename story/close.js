import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, resolveStoryId, checkIsAdmin, checkIsCreator } from '../utilities.js';
import { endTurnThread, closeStoryInternals } from './_turn.js';
import { postStoryFeedClosedAnnouncement } from '../announcements.js';
import { generateStoryExport } from './export.js';
import { getActiveThreadId } from '../storybot.js';

// Direct stats query — independent of export generation, since export is now a manual, optional step after close.
async function getStoryStats(connection, storyId) {
  const [writerRows] = await connection.execute(
    `SELECT COUNT(*) AS writerCount FROM story_writer WHERE story_id = ? AND sw_status = 1`,
    [storyId]
  );
  const [entryRows] = await connection.execute(
    `SELECT se.content,
            (SELECT COUNT(DISTINCT t2.turn_id) FROM turn t2
             JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
             JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
             WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
     FROM story_entry se
     JOIN turn t ON se.turn_id = t.turn_id
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
     ORDER BY t.started_at`,
    [storyId]
  );
  const turnCount = entryRows.length ? entryRows[entryRows.length - 1].turn_number : 0;
  const wordCount = entryRows.reduce((total, e) => total + e.content.trim().split(/\s+/).length, 0);
  return { turnCount, wordCount, writerCount: writerRows[0].writerCount };
}

export async function handleClose(connection, interaction) {
  log(`handleClose entry user=${interaction.user.username} story=${interaction.options.getString('story_id')}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));
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
      log(`handleClose: unauthorized user=${interaction.user.username} story=${storyId}`, { show: false, guildName: interaction?.guild?.name });
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
  log(`handleCloseConfirm entry user=${interaction.user.username} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, story_thread_id, restricted_thread_id, rating, mode FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0 || storyRows[0].story_status === 3) {
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFoundOrClosed', guildId), components: [] });
    }
    const story = storyRows[0];

    // Capture the active turn before closeStoryInternals ends it, so we can dispose
    // of its thread (24h-preserving any draft) after the reply below — endTurnThread
    // may delete the thread the interaction itself was issued from.
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId]
    );
    const activeTurn = activeTurnRows.length > 0 ? activeTurnRows[0] : null;

    // Shared close core: ends the active turn, cancels pending jobs, sets story_status=3,
    // retitles any existing thread(s), and refreshes the status message.
    await closeStoryInternals(connection, interaction, storyId);

    // Story is now marked closed — gather stats directly (export is now a manual, optional step)
    const { turnCount, wordCount, writerCount } = await getStoryStats(connection, storyId);

    // Export buttons are offered publicly on the close announcement so any writer can grab a copy
    const [btnExportNoBreaks, btnExportWithBreaks] = await Promise.all([
      getConfigValue(connection, 'btnExportNoBreaks', guildId),
      getConfigValue(connection, 'btnExportWithBreaks', guildId),
    ]);
    const exportRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`story_export_close_noturns_${storyId}`)
        .setLabel(btnExportNoBreaks)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`story_export_close_withturns_${storyId}`)
        .setLabel(btnExportWithBreaks)
        .setStyle(ButtonStyle.Secondary)
    );

    // closeStoryInternals already retitled every existing thread (unrestricted and/or
    // restricted — a story that migrated at some point can have both). Post the close
    // message + export buttons once, to whichever is the currently-active thread.
    let postedPublicly = false;
    const activeThreadId = getActiveThreadId(story);
    if (activeThreadId) {
      try {
        const thread = await interaction.guild.channels.fetch(activeThreadId);
        if (thread) {
          const txtStoryClosedPublic = await getConfigValue(connection, 'txtStoryClosedPublic', guildId);
          const closedMsg = replaceTemplateVariables(txtStoryClosedPublic, {
            story_title: story.title,
            writer_count: writerCount,
            turn_count: turnCount,
            word_count: wordCount.toLocaleString()
          });
          await thread.send({ content: closedMsg, components: [exportRow] });
          postedPublicly = true;
        }
      } catch (err) {
        log(`Story thread ${activeThreadId} not available for close (story ${storyId})`, { show: false, guildName: interaction?.guild?.name });
      }
    }

    // Feed announcement — only if there are confirmed entries
    if (turnCount > 0) {
      await postStoryFeedClosedAnnouncement(connection, interaction, story.title, turnCount, wordCount, writerCount, story.rating);
    }

    log(`handleCloseConfirm: story ${storyId} closed successfully`, { show: true, guildName: interaction?.guild?.name });

    if (postedPublicly) {
      // Public close announcement already carries the confirmation and export buttons — dismiss the ephemeral prompt.
      await interaction.deleteReply();
    } else {
      // No thread to post the announcement in — fall back to offering export on the ephemeral reply.
      const txtStoryCloseSuccess = await getConfigValue(connection, 'txtStoryCloseSuccess', guildId);
      await interaction.editReply({ content: txtStoryCloseSuccess, components: [exportRow] });
    }

    // Clean up the active writer's turn thread now that the reply has been
    // sent — this may delete the thread the interaction was issued from.
    if (activeTurn && story.mode !== 1) {
      await endTurnThread(connection, interaction.guild, activeTurn.thread_id, activeTurn.discord_user_id, guildId);
    }

  } catch (error) {
    log(`Error in handleCloseConfirm: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export async function handleCloseCancel(connection, interaction) {
  await interaction.deferUpdate();
  await interaction.editReply({ content: await getConfigValue(connection, 'txtActionCancelled', interaction.guild.id), components: [] });
}

// story_export_close_noturns_<storyId> / story_export_close_withturns_<storyId> —
// manual export buttons offered on the close-success message (export is no longer automatic on close).
export async function handleCloseExportButton(connection, interaction) {
  await interaction.deferUpdate();
  const suppressBreaks = interaction.customId.startsWith('story_export_close_noturns_');
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;

  try {
    const result = await generateStoryExport(connection, storyId, guildId, interaction.guild, { suppressBreaks });
    if (result?.hasEntries) {
      const [ao3Instructions, btnPostLabel] = await Promise.all([
        getConfigValue(connection, 'txtExportAO3Instructions', guildId),
        getConfigValue(connection, 'btnExportPostPublicly', guildId),
      ]);
      const flagSegment = suppressBreaks ? 'noturns' : 'withturns';
      const postBtn = new ButtonBuilder()
        .setCustomId(`story_read_post_public_${flagSegment}_${storyId}`)
        .setLabel(btnPostLabel)
        .setStyle(ButtonStyle.Secondary);
      const btnRow = new ActionRowBuilder().addComponents(postBtn);
      await interaction.followUp({
        content: ao3Instructions,
        files: [{ attachment: result.buffer, name: result.filename }],
        components: [btnRow],
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    log(`Error generating HTML export from close flow: ${err}`, { show: true, guildName: interaction?.guild?.name });
  }
}
