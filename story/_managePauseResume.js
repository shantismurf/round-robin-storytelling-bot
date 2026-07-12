import { getConfigValue, log, replaceTemplateVariables, getTurnNumber } from '../utilities.js';
import { PickNextWriter, NextTurn } from './_turn.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { isRestricted, resolveFeedChannelId } from './_metadata.js';
import { getActiveThreadId } from '../storybot.js';

export async function applyPauseActions(connection, interaction, state) {
  const [activeTurnRows] = await connection.execute(
    `SELECT t.turn_id, t.thread_id, sw.discord_display_name
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     WHERE sw.story_id = ? AND t.turn_status = 1`,
    [state.storyId]
  );
  if (activeTurnRows.length === 0) return;

  const { turn_id: turnId, thread_id: threadId, discord_display_name } = activeTurnRows[0];

  await connection.execute(
    `UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`,
    [turnId]
  );

  if (!threadId) return;

  try {
    const thread = await interaction.guild.channels.fetch(threadId);
    if (!thread) return;

    const turnNumber = await getTurnNumber(connection, state.storyId);
    const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
    const pausedTitle = threadTitleTemplate
      .replace('[story_id]', state.guildStoryId)
      .replace('[storyTurnNumber]', turnNumber)
      .replace('[user display name]', discord_display_name)
      .replace('[turnEndTime]', 'PAUSED');

    await thread.setName(pausedTitle);
    await thread.setLocked(true);
  } catch (err) {
    log(`Could not lock turn thread on pause (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  try {
    const [storyInfo] = await connection.execute(
      `SELECT story_thread_id, restricted_thread_id FROM story WHERE story_id = ?`, [state.storyId]
    );
    if (storyInfo[0]) {
      const activeThreadId = (isRestricted(state.rating) && storyInfo[0].restricted_thread_id)
        ? storyInfo[0].restricted_thread_id : storyInfo[0].story_thread_id;
      if (activeThreadId) {
        const storyThread = await interaction.guild.channels.fetch(activeThreadId).catch(() => null);
        if (storyThread) {
          const [txtPaused, titleTemplate] = await Promise.all([
            getConfigValue(connection, 'txtPaused', state.guildId),
            getConfigValue(connection, 'txtStoryThreadTitle', state.guildId)
          ]);
          await storyThread.setName(
            titleTemplate.replace('[story_id]', state.guildStoryId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtPaused)
          );
        }
      }
    }
  } catch (err) {
    log(`Could not update story thread title on pause (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

export async function applyResumeActions(connection, interaction, state) {
  const [activeTurnRows] = await connection.execute(
    `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.discord_display_name, sw.notification_prefs,
            s.story_thread_id, s.restricted_thread_id, s.rating, s.title
     FROM turn t
     JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
     JOIN story s ON s.story_id = sw.story_id
     WHERE sw.story_id = ? AND t.turn_status = 1`,
    [state.storyId]
  );

  try {
    const [storyInfo] = await connection.execute(
      `SELECT story_thread_id, restricted_thread_id FROM story WHERE story_id = ?`, [state.storyId]
    );
    if (storyInfo[0]) {
      const activeThreadId = (isRestricted(state.rating) && storyInfo[0].restricted_thread_id)
        ? storyInfo[0].restricted_thread_id : storyInfo[0].story_thread_id;
      if (activeThreadId) {
        const storyThread = await interaction.guild.channels.fetch(activeThreadId).catch(() => null);
        if (storyThread) {
          const [txtActive, titleTemplate] = await Promise.all([
            getConfigValue(connection, 'txtActive', state.guildId),
            getConfigValue(connection, 'txtStoryThreadTitle', state.guildId)
          ]);
          await storyThread.setName(
            titleTemplate.replace('[story_id]', state.guildStoryId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtActive)
          );
        }
      }
    }
  } catch (err) {
    log(`Could not update story thread title on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }

  if (activeTurnRows.length === 0) {
    const nextWriterId = await PickNextWriter(connection, state.storyId);
    if (nextWriterId) {
      const turnResult = await NextTurn(connection, interaction, nextWriterId);
      if (!turnResult.success) {
        log(`applyResumeActions: NextTurn failed for story ${state.storyId} — story has no active turn: ${turnResult.error}`, { show: true, guildName: interaction?.guild?.name, hub: true });
      }
    } else {
      log(`applyResumeActions: no eligible next writer for story ${state.storyId} on resume — story has no active turn`, { show: true, guildName: interaction?.guild?.name, hub: true });
    }
    return;
  }

  const activeTurn = activeTurnRows[0];
  const isSlowMode = state.storyMode === 2;

  await connection.execute(
    `UPDATE job SET job_status = 3 WHERE turn_id = ? AND job_status = 0`,
    [activeTurn.turn_id]
  );

  let newTurnEndsAt = null;
  let newEndTimestamp = null;

  if (!isSlowMode) {
    newTurnEndsAt = new Date(Date.now() + (state.turnLength * 60 * 60 * 1000));
    await connection.execute(
      `UPDATE turn SET turn_ends_at = ? WHERE turn_id = ?`,
      [newTurnEndsAt, activeTurn.turn_id]
    );
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
      ['turnTimeout', JSON.stringify({ turnId: activeTurn.turn_id, storyId: state.storyId, guildId: state.guildId }), newTurnEndsAt, activeTurn.turn_id]
    );
    if (state.timeoutReminder > 0) {
      const reminderMs = state.turnLength * (state.timeoutReminder / 100) * 60 * 60 * 1000;
      const reminderTime = new Date(Date.now() + reminderMs);
      await connection.execute(
        `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
        ['turnReminder', JSON.stringify({ turnId: activeTurn.turn_id, storyId: state.storyId, guildId: state.guildId, writerUserId: activeTurn.discord_user_id }), reminderTime, activeTurn.turn_id]
      );
    }
    newEndTimestamp = `<t:${Math.floor(newTurnEndsAt.getTime() / 1000)}:F>`;
  } else if (state.timeoutReminder > 0) {
    const reminderTime = new Date(Date.now() + (state.timeoutReminder * 60 * 60 * 1000));
    await connection.execute(
      `INSERT INTO job (job_type, payload, run_at, job_status, turn_id) VALUES (?, ?, ?, 0, ?)`,
      ['turnSlowReminder', JSON.stringify({ turnId: activeTurn.turn_id, storyId: state.storyId, guildId: state.guildId, writerUserId: activeTurn.discord_user_id, reminderHours: state.timeoutReminder }), reminderTime, activeTurn.turn_id]
    );
  }

  if (activeTurn.thread_id) {
    try {
      const thread = await interaction.guild.channels.fetch(activeTurn.thread_id);
      if (thread) {
        const turnNumber = await getTurnNumber(connection, state.storyId);
        const threadTitleTemplate = await getConfigValue(connection, 'txtTurnThreadTitle', state.guildId);
        const newTitle = threadTitleTemplate
          .replace('[story_id]', state.guildStoryId)
          .replace('[storyTurnNumber]', turnNumber)
          .replace('[user display name]', activeTurn.discord_display_name);
        await thread.setName(newTitle);
        await thread.setLocked(false);
        const txtTurnThreadResumed = await getConfigValue(connection, 'txtTurnThreadResumed', state.guildId);
        await thread.send(replaceTemplateVariables(txtTurnThreadResumed, { turn_end_time: newEndTimestamp ?? '—' }));
      }
    } catch (err) {
      log(`Could not unlock turn thread on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
    }
  }

  try {
    const linkThreadId = activeTurn.thread_id || getActiveThreadId(activeTurn);
    const threadUrl = `https://discord.com/channels/${state.guildId}/${linkThreadId}`;
    const resumeText = (await getConfigValue(connection, 'txtTurnResumed', state.guildId))
      .replace(/\[story_title\]/g, activeTurn.title)
      .replace(/\[turn_end_time\]/g, newEndTimestamp ?? '—')
      .replace(/\[turn_thread_link\]/g, threadUrl);
    if (activeTurn.notification_prefs === 'mention') {
      const feedChannelId = await resolveFeedChannelId(connection, state.guildId, state.rating);
      const channel = await interaction.guild.channels.fetch(feedChannelId);
      await channel.send(`<@${activeTurn.discord_user_id}> ${resumeText}`);
    } else {
      try {
        const user = await interaction.client.users.fetch(activeTurn.discord_user_id);
        await user.send(resumeText);
      } catch {
        const feedChannelId = await resolveFeedChannelId(connection, state.guildId, state.rating);
        const channel = await interaction.guild.channels.fetch(feedChannelId);
        await channel.send(`<@${activeTurn.discord_user_id}> ${resumeText}`);
      }
    }
  } catch (err) {
    log(`Could not notify writer on resume (story ${state.storyId}): ${err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

export async function handleReopenStory(connection, interaction, state) {
  log(`handleReopenStory entry storyId=${state.storyId} user=${interaction.user.username}`, { show: true, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const guildId = state.guildId;

  try {
    await connection.execute(
      `UPDATE story SET story_status = 1 WHERE story_id = ?`,
      [state.storyId]
    );

    try {
      const [storyInfo] = await connection.execute(
        `SELECT story_thread_id, restricted_thread_id, rating FROM story WHERE story_id = ?`, [state.storyId]
      );
      const activeThreadId = storyInfo.length ? getActiveThreadId(storyInfo[0]) : null;
      if (activeThreadId) {
        const storyThread = await interaction.guild.channels.fetch(activeThreadId).catch(() => null);
        if (storyThread) {
          const [txtActive, titleTemplate] = await Promise.all([
            getConfigValue(connection, 'txtActive', guildId),
            getConfigValue(connection, 'txtStoryThreadTitle', guildId)
          ]);
          await storyThread.setName(
            titleTemplate.replace('[story_id]', state.guildStoryId).replace('[inputStoryTitle]', state.title).replace('[story_status]', txtActive)
          );
        }
      }
    } catch (err) {
      log(`handleReopenStory: could not update story thread title for story ${state.storyId}: ${err}`, { show: true, guildName: interaction?.guild?.name });
    }

    const nextWriterId = await PickNextWriter(connection, state.storyId);
    if (nextWriterId) {
      const turnResult = await NextTurn(connection, interaction, nextWriterId);
      if (!turnResult.success) {
        log(`handleReopenStory: NextTurn failed for story ${state.storyId} — story has no active turn: ${turnResult.error}`, { show: true, guildName: interaction?.guild?.name, hub: true });
      }
    } else {
      log(`handleReopenStory: no eligible next writer for story ${state.storyId} on reopen — story has no active turn`, { show: true, guildName: interaction?.guild?.name, hub: true });
    }

    updateStoryStatusMessage(connection, interaction.guild, state.storyId).catch(() => {});

    const joinStatus = state.allowJoins
      ? (state.cfg.txtOpen ?? 'open')
      : (state.cfg.txtClosed ?? 'closed');
    const reopenMsg = replaceTemplateVariables(
      await getConfigValue(connection, 'txtReopenSuccess', guildId),
      { story_title: state.title, join_status: joinStatus }
    );

    state.originalStatus = 1;
    state.targetStatus = 1;

    log(`handleReopenStory: story ${state.storyId} reopened successfully`, { show: true, guildName: interaction?.guild?.name });
    return { reopenMsg };
  } catch (err) {
    log(`handleReopenStory failed for story ${state.storyId}: ${err}`, { show: true, guildName: interaction?.guild?.name });
    throw err;
  }
}
