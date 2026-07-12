import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log } from '../utilities.js';
import { PickNextWriter, NextTurn, postStoryThreadActivity, endTurnThread, endTurnGuarded, deleteThreadAndAnnouncement } from './_turn.js';
import { postThreadEntry } from './_entryRenderer.js';

export async function handleViewLastEntry(connection, interaction) {
  log(`handleViewLastEntry entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  const storyId = parseInt(interaction.customId.split('_')[3]);
  const guildId = interaction.guild.id;

  try {
    const [writerCheck] = await connection.execute(
      `SELECT sw.discord_user_id FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    if (!writerCheck.length || String(writerCheck[0].discord_user_id) !== interaction.user.id) {
      return await interaction.followUp({
        content: await getConfigValue(connection, 'txtRequestMoreTimeNotYourTurn', guildId),
        flags: MessageFlags.Ephemeral
      });
    }

    const [rows] = await connection.execute(
      `SELECT se.content, sw.discord_display_name, s.show_authors, s.scene_break_divider,
              (SELECT COUNT(DISTINCT t2.turn_id)
               FROM turn t2
               JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
               JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status = 'confirmed'
               WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at) as turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       JOIN story s ON sw.story_id = s.story_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed'
       ORDER BY t.started_at DESC LIMIT 1`,
      [storyId]
    );

    if (rows.length === 0) return;

    const { content, discord_display_name, show_authors, scene_break_divider, turn_number } = rows[0];
    const authorLine = show_authors ? `Turn ${turn_number} — ${discord_display_name}` : null;
    await postThreadEntry(interaction.channel, content, authorLine, scene_break_divider);

  } catch (error) {
    log(`Error in handleViewLastEntry: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}

export async function handleSkipTurn(connection, interaction) {
  log(`handleSkipTurn entry user=${interaction.user.username} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  const storyId = interaction.customId.split('_')[2];
  const guildId = interaction.guild.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId) });
      return;
    }

    const turn = turnInfo[0];

    let hasContent = false;
    if (turn.thread_id) {
      try {
        const thread = await interaction.guild.channels.fetch(turn.thread_id);
        if (thread) {
          const messages = await thread.messages.fetch({ limit: 50 });
          hasContent = messages.some(m => !m.author.bot && m.author.id === interaction.user.id);
        }
      } catch {}
    }

    if (hasContent) {
      const [txtConfirm, btnDelete, btnKeep, btnCancel] = await Promise.all([
        getConfigValue(connection, 'txtSkipConfirmHasContentKeep', guildId),
        getConfigValue(connection, 'btnSkipDelete', guildId),
        getConfigValue(connection, 'btnSkipKeep', guildId),
        getConfigValue(connection, 'btnSkipCancel', guildId)
      ]);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`story_skip_confirm_delete_${storyId}`)
          .setLabel(btnDelete)
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`story_skip_confirm_keep_${storyId}`)
          .setLabel(btnKeep)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`story_skip_cancel_${storyId}`)
          .setLabel(btnCancel)
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({ content: txtConfirm, components: [row] });
    } else {
      const [txtConfirm, btnConfirm, btnCancel] = await Promise.all([
        getConfigValue(connection, 'txtSkipConfirmNoContent', guildId),
        getConfigValue(connection, 'btnSkipConfirm', guildId),
        getConfigValue(connection, 'btnSkipCancel', guildId)
      ]);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`story_skip_confirm_${storyId}`)
          .setLabel(btnConfirm)
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`story_skip_cancel_${storyId}`)
          .setLabel(btnCancel)
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({ content: txtConfirm, components: [row] });
    }

  } catch (error) {
    log(`Skip turn confirmation failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }
}

export async function handleSkipConfirm(connection, interaction) {
  const parts = interaction.customId.split('_');
  const variant = parts[3];
  const storyId = (variant === 'delete' || variant === 'keep') ? parts[4] : variant;
  log(`handleSkipConfirm entry user=${interaction.user.username} story=${storyId}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;

  await interaction.deferUpdate();

  try {
    const [turnInfo] = await connection.execute(
      `SELECT t.turn_id, t.thread_id, sw.discord_user_id, sw.story_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1 AND sw.discord_user_id = ?`,
      [storyId, interaction.user.id]
    );

    if (turnInfo.length === 0) {
      await interaction.editReply({ content: await getConfigValue(connection, 'txtNoActiveTurn', guildId), components: [] });
      return;
    }

    const turn = turnInfo[0];

    const ended = await endTurnGuarded(connection, turn.turn_id);
    if (!ended) {
      log(`handleSkipConfirm: turn ${turn.turn_id} already ended (race), no-op`, { show: true, guildName: interaction?.guild?.name });
      await interaction.editReply({ content: await getConfigValue(connection, 'txtWriteTurnEnded', guildId), components: [] });
      return;
    }

    const nextWriterId = await PickNextWriter(connection, storyId);
    if (nextWriterId) {
      const turnResult = await NextTurn(connection, interaction, nextWriterId);
      if (!turnResult.success) {
        log(`handleSkipConfirm: NextTurn failed for story ${storyId} — story has no active turn: ${turnResult.error}`, { show: true, guildName: interaction?.guild?.name, hub: true });
      }
    } else {
      log(`handleSkipConfirm: no eligible next writer for story ${storyId} — story has no active turn`, { show: true, guildName: interaction?.guild?.name, hub: true });
    }

    getConfigValue(connection, 'txtStoryThreadTurnSkip', guildId).then(template =>
      postStoryThreadActivity(connection, interaction.guild, parseInt(storyId), template.replace('[writer_name]', turn.discord_display_name))
    ).catch(() => {});

    await interaction.editReply({ content: await getConfigValue(connection, 'txtSkipSuccess', guildId), components: [] });

    await endTurnThread(connection, interaction.guild, turn.thread_id, turn.discord_user_id, guildId, { forceDelete: variant === 'delete' });

  } catch (error) {
    log(`Skip turn failed: ${error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId), components: [] });
  }
}

export async function handleThreadDeleteNow(connection, interaction) {
  const threadId = interaction.customId.replace('story_thread_delete_now_', '');
  log(`handleThreadDeleteNow entry threadId=${threadId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  try {
    await connection.execute(
      `UPDATE job SET job_status = 3 WHERE job_type = 'threadDelete' AND job_status = 0
       AND CAST(JSON_EXTRACT(payload, '$.threadId') AS CHAR) = ?`,
      [String(threadId)]
    );
    const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
    if (thread) {
      await deleteThreadAndAnnouncement(thread);
      log(`handleThreadDeleteNow: deleted thread ${threadId}`, { show: true, guildName: interaction?.guild?.name });
    }
  } catch (err) {
    log(`handleThreadDeleteNow failed for thread ${threadId}: ${err}`, { show: true, guildName: interaction?.guild?.name });
  }
}
