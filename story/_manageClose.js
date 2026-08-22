// Manage-panel close-confirm flow — story_manage_close_confirm's handler, dispatched from
// story/manage.js's handleManageButton.
//
// This is a DELIBERATE, TEMPORARY fork of story/close.js's handleCloseConfirm. The manage panel
// is Components V2, and Discord's docs confirm IsComponentsV2 can never be removed once a
// message carries it ("Once a message has been sent with this flag, it can't be removed from
// that message") — so every edit to that message, including the close-confirm outcome, must
// stay Components V2. close.js's handleCloseConfirm/handleCloseCancel reply in plain
// content/components for the standalone /story close command, which never carries the flag, and
// must keep doing so — reusing them directly here would just move the same crash one click
// later. What IS reused: the actual close logic (closeStoryInternals, getStoryStats, the
// export-row build, thread-post, feed announcement) — none of that is reply-format-coupled.
//
// INTENT (tracked in docs/TODO.md): once close.js's handleClose/handleCloseConfirm/
// handleCloseCancel are themselves converted to Components V2 — a separate, bigger change since
// it also affects the standalone /story close command — this file becomes redundant. At that
// point the manage panel should route story_manage_close_confirm/_cancel back to the shared
// close.js handlers directly, and this file should be deleted.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from '../utilities.js';
import { endTurnThread, closeStoryInternals } from './_turn.js';
import { postStoryFeedClosedAnnouncement } from '../announcements.js';
import { getActiveThreadId } from '../storybot.js';
import { getStoryStats } from './close.js';
import { finalMessage } from './_metadataModals.js';
import { STORY_STATUS, TURN_STATUS, STORY_MODE } from '../constants.js';

export async function handleManageCloseConfirm(connection, interaction, state) {
  log(`handleManageCloseConfirm entry user=${interaction.user.username} story=${state.storyId}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;
  const storyId = state.storyId;

  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, story_thread_id, restricted_thread_id, rating, mode FROM story WHERE story_id = ? AND guild_id = ?`,
      [storyId, guildId]
    );
    if (storyRows.length === 0 || storyRows[0].story_status === STORY_STATUS.CLOSED) {
      return await state.originalInteraction.editReply(finalMessage(await getConfigValue(connection, 'txtStoryNotFoundOrClosed', guildId)));
    }
    const story = storyRows[0];

    // Capture the active turn before closeStoryInternals ends it, so we can dispose of its
    // thread (24h-preserving any draft) after the reply below — endTurnThread may delete the
    // thread the interaction itself was issued from.
    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = ?
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId, TURN_STATUS.ACTIVE]
    );
    const activeTurn = activeTurnRows.length > 0 ? activeTurnRows[0] : null;

    // Shared close core: ends the active turn, cancels pending jobs, sets story_status=3,
    // retitles any existing thread(s), and refreshes the status message.
    await closeStoryInternals(connection, interaction, storyId);

    const { turnCount, wordCount, writerCount } = await getStoryStats(connection, storyId);

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
    // restricted). Post the close message + export buttons once, to whichever is the
    // currently-active thread — same as the standalone close flow.
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

    log(`handleManageCloseConfirm: story ${storyId} closed successfully`, { show: true, guildName: interaction?.guild?.name });

    // The public close announcement already carries the confirmation and export buttons when
    // one was posted, so the panel just shows a bare success line; otherwise the export buttons
    // land here instead, matching the standalone close flow's fallback.
    const txtStoryCloseSuccess = await getConfigValue(connection, 'txtStoryCloseSuccess', guildId);
    await state.originalInteraction.editReply(finalMessage(txtStoryCloseSuccess, postedPublicly ? [] : [exportRow]));

    // Clean up the active writer's turn thread now that the reply has been sent — this may
    // delete the thread the interaction was issued from.
    if (activeTurn && story.mode !== STORY_MODE.QUICK) {
      await endTurnThread(connection, interaction.guild, activeTurn.thread_id, activeTurn.discord_user_id, guildId);
    }

  } catch (error) {
    log(`handleManageCloseConfirm failed for story ${storyId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await state.originalInteraction.editReply(finalMessage(await getConfigValue(connection, 'errProcessingRequest', guildId)));
  }
}
