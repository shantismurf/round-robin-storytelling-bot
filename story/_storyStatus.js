import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from '../utilities.js';
import { ratingBadge, warningOptions, formatWarnings } from './_metadata.js';
import { getActiveThreadId } from '../storybot.js';

/**
 * Build thread title string from config templates.
 * Exported so CreateStory and migrateStoryThread can reuse it.
 */
export async function buildThreadTitle(connection, story) {
  const [txtActive, txtPaused, txtClosed, txtDelayed, titleTemplate] = await Promise.all([
    getConfigValue(connection, 'txtActive', story.guild_id),
    getConfigValue(connection, 'txtPaused', story.guild_id),
    getConfigValue(connection, 'txtClosed', story.guild_id),
    getConfigValue(connection, 'txtDelayed', story.guild_id),
    getConfigValue(connection, 'txtStoryThreadTitle', story.guild_id),
  ]);
  const statusLabel = { 1: txtActive, 2: txtPaused, 3: txtClosed, 4: txtDelayed }[story.story_status] ?? txtActive;
  return titleTemplate
    .replace('[story_id]', story.guild_story_id)
    .replace('[inputStoryTitle]', story.title)
    .replace('[story_status]', statusLabel);
}

/**
 * Build and post (or update) the persistent status embed in the story's active thread.
 * Stores the message ID in story.status_message_id so it can be edited in place.
 * If the message has been deleted, a new one is posted automatically.
 */
export async function updateStoryStatusMessage(connection, guild, storyId) {
  log(`updateStoryStatusMessage: entry storyId=${storyId}`, { show: false, guildName: guild?.name });
  try {
    const [storyRows] = await connection.execute(
      `SELECT story_id, guild_story_id, title, story_status, mode, turn_length_hours,
              reminder_timing, max_writers, allow_joins, show_authors,
              story_order_type, summary, tags, story_thread_id, restricted_thread_id, status_message_id, guild_id,
              next_writer_id, closed_at, rating, warnings, main_pairing,
              other_relationships, characters, dynamic
       FROM story WHERE story_id = ?`,
      [storyId]
    );
    if (storyRows.length === 0 || !getActiveThreadId(storyRows[0])) return;
    const story = storyRows[0];

    const [writers] = await connection.execute(
      `SELECT story_writer_id, discord_display_name, AO3_name, sw_status, writer_order
       FROM story_writer WHERE story_id = ? ORDER BY joined_at ASC`,
      [storyId]
    );

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_ends_at, t.story_writer_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = 1`,
      [storyId]
    );
    const activeTurn = activeTurnRows[0] ?? null;

    // Entry stats — count confirmed entries, words, and inline images
    const [confirmedEntries] = await connection.execute(
      `SELECT se.content FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND se.entry_status = 'confirmed'`,
      [storyId]
    );
    const entryCount = confirmedEntries.length;
    const cdnImageRegex = /https:\/\/cdn\.discordapp\.com\/attachments\/[^\s<"]+/g;
    let wordCount = 0;
    let imageCount = 0;
    for (const e of confirmedEntries) {
      const images = e.content.match(cdnImageRegex) ?? [];
      imageCount += images.length;
      // Strip image URLs before counting words so they don't inflate the count
      const textOnly = e.content.replace(cdnImageRegex, '').trim();
      wordCount += textOnly.split(/\s+/).filter(w => w.length > 0).length;
    }

    const ratingBadgeCfgKey = ratingBadge[story.rating] ?? 'txtRatingBadgeNR';
    const cfg = await getConfigValue(connection, [
      'txtActive', 'txtPaused', 'txtClosed', 'txtDelayed',
      'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'txtModeQuick', 'txtModeNormal', 'txtModeSlow',
      'txtStatusSlowModeNoTimer', 'txtStatusReminderSuffixSlow',
      'txtYes', 'txtNo', 'txtOpen',
      'txtStatusLegendCreator', 'txtStatusLegendCurrentTurn', 'txtStatusLegendNextUp', 'txtStatusLegendPaused',
      'txtStatusNoActiveTurn',
      'txtStatusNextManual', 'txtStatusNextFixed', 'txtStatusNextRoundRobin', 'txtStatusNextRandom',
      'txtStatusReminderSuffix', 'txtStatusNoEntries', 'txtStatusEntryStats',
      'lblStatusTags', 'lblStatusStatus', 'lblStatusMode', 'lblStatusWriterOrder',
      'lblStatusTurnLength', 'lblStatusWriters', 'lblStatusShowAuthors',
      'lblStatusCurrentTurn', 'lblStatusNextWriter', 'lblStatusEntries', 'lblStatusWriterList', 'lblStatusClosed',
      'lblMetaRating', 'lblMetaMainRelationship', 'lblMetaWarnings', 'lblMetaCharacters', 'lblMetaTags',
      ratingBadgeCfgKey,
      ...warningOptions,
    ], story.guild_id);
    const txtActive = cfg.txtActive;
    const txtPaused = cfg.txtPaused;
    const txtClosed = cfg.txtClosed;
    const txtDelayed = cfg.txtDelayed;
    const txtOrderRandom = cfg.txtOrderRandom;
    const txtOrderRoundRobin = cfg.txtOrderRoundRobin;
    const txtOrderFixed = cfg.txtOrderFixed;
    const ratingBadgeDisplay = cfg[ratingBadgeCfgKey];

    const statusMap = { 1: `▶️ ${txtActive}`, 2: `⏸️ ${txtPaused}`, 3: `🔒 ${txtClosed}`, 4: `⏳ ${txtDelayed}` };
    const orderMap = { 1: `🎲 ${txtOrderRandom}`, 2: `🔄 ${txtOrderRoundRobin}`, 3: `📋 ${txtOrderFixed}` };
    const colorMap = { 1: 0x57f287, 2: 0xfee75c, 3: 0xed4245 };

    const activeWriters = writers.filter(w => w.sw_status === 1);
    const pausedWriters = writers.filter(w => w.sw_status === 2);
    const leftWriters   = writers.filter(w => w.sw_status === 0);

    // Creator = first writer to join (first in joined_at ASC order among active writers)
    const creatorId = activeWriters[0]?.story_writer_id ?? null;

    const legendParts = [cfg.txtStatusLegendCreator, cfg.txtStatusLegendCurrentTurn, cfg.txtStatusLegendNextUp];
    if (pausedWriters.length > 0) legendParts.push(cfg.txtStatusLegendPaused);

    const writerLines = [
      ...activeWriters.map(w => {
        const isCurrent = activeTurn?.story_writer_id === w.story_writer_id;
        const isCreator = w.story_writer_id === creatorId;
        const isPinnedNext = story.next_writer_id && w.story_writer_id === story.next_writer_id;
        const ao3 = w.AO3_name && w.AO3_name !== w.discord_display_name ? ` (${w.AO3_name})` : '';
        const emojis = [isCreator ? '⭐' : '', isCurrent ? '✍️' : '', isPinnedNext ? '📌' : ''].filter(Boolean).join('');
        const prefix = emojis ? `${emojis} ` : '';
        return `${prefix}**${w.discord_display_name}**${ao3}`;
      }),
      ...pausedWriters.map(w => {
        const ao3 = w.AO3_name && w.AO3_name !== w.discord_display_name ? ` (${w.AO3_name})` : '';
        return `⏸️ ${w.discord_display_name}${ao3}`;
      }),
      ...leftWriters.map(w => `*${w.discord_display_name}*`),
      '',
      `*${legendParts.join('  ·  ')}*`
    ];

    let turnValue;
    if (activeTurn) {
      if (activeTurn.turn_ends_at) {
        const endTimestamp = `<t:${Math.floor(new Date(activeTurn.turn_ends_at).getTime() / 1000)}:R>`;
        turnValue = `**${activeTurn.discord_display_name}** — ends ${endTimestamp}`;
      } else {
        turnValue = `**${activeTurn.discord_display_name}** — ${cfg.txtStatusSlowModeNoTimer}`;
      }
    } else {
      turnValue = story.story_status === 1 ? cfg.txtStatusNoActiveTurn : '—';
    }

    // Next writer — only deterministic for Fixed order; Random and Round Robin are selected at turn change
    let nextWriterValue = '—';
    if (story.story_status === 1) {
      if (story.next_writer_id) {
        const nw = writers.find(w => w.story_writer_id === story.next_writer_id);
        nextWriterValue = nw ? `📌 **${nw.discord_display_name}** ${cfg.txtStatusNextManual}` : `📌 ${cfg.txtStatusNextManual}`;
      } else if (story.story_order_type === 3 && activeTurn) {
        const sorted = [...activeWriters].sort((a, b) => (a.writer_order ?? 999) - (b.writer_order ?? 999));
        const currentIdx = sorted.findIndex(w => w.story_writer_id === activeTurn.story_writer_id);
        if (currentIdx >= 0) {
          const nextWriter = sorted[(currentIdx + 1) % sorted.length];
          nextWriterValue = `**${nextWriter.discord_display_name}** ${cfg.txtStatusNextFixed}`;
        }
      } else if (story.story_order_type === 2) {
        nextWriterValue = cfg.txtStatusNextRoundRobin;
      } else {
        nextWriterValue = cfg.txtStatusNextRandom;
      }
    }

    let reminderText = '';
    if (story.reminder_timing > 0) {
      reminderText = story.mode === 2
        ? replaceTemplateVariables(cfg.txtStatusReminderSuffixSlow, { hours: story.reminder_timing })
        : replaceTemplateVariables(cfg.txtStatusReminderSuffix, { percent: story.reminder_timing });
    }

    const imagePart = imageCount > 0 ? ` · ${imageCount} images` : '';
    const statsValue = entryCount > 0
      ? replaceTemplateVariables(cfg.txtStatusEntryStats, { entry_count: entryCount, word_count: wordCount.toLocaleString(), image_part: imagePart })
      : cfg.txtStatusNoEntries;

    const warningLabels = Object.fromEntries(warningOptions.map(k => [k, cfg[k] ?? k]));
    const warningsDisplay = story.warnings ? formatWarnings(story.warnings, warningLabels) : null;

    const metadataFields = [];
    if (story.rating && story.rating !== 'NR') {
      metadataFields.push({ name: cfg.lblMetaRating, value: `${ratingBadgeDisplay} ${story.rating}`, inline: true });
    }
    if (story.main_pairing)  metadataFields.push({ name: cfg.lblMetaMainRelationship, value: story.main_pairing, inline: true });
    if (warningsDisplay)     metadataFields.push({ name: cfg.lblMetaWarnings, value: warningsDisplay, inline: false });
    if (story.characters)    metadataFields.push({ name: cfg.lblMetaCharacters, value: story.characters.length > 200 ? story.characters.slice(0, 197) + '...' : story.characters, inline: false });
    if (story.tags) metadataFields.push({ name: cfg.lblMetaTags, value: story.tags.length > 500 ? story.tags.slice(0, 497) + '...' : story.tags, inline: false });

    const joinStatus = story.allow_joins && !(story.max_writers && activeWriters.length >= story.max_writers) ? cfg.txtOpen : cfg.txtClosed;

    const embed = new EmbedBuilder()
      .setTitle(`📚 ${story.title} (#${story.guild_story_id}) ${ratingBadgeDisplay}`)
      .setColor(colorMap[story.story_status] ?? 0x5865f2)
      .addFields(
        ...(story.tags ? [{ name: cfg.lblStatusTags, value: story.tags, inline: false }] : []),
        { name: cfg.lblStatusStatus,      value: statusMap[story.story_status] ?? '—',                                         inline: true },
        { name: cfg.lblStatusMode,        value: story.mode === 1 ? cfg.txtModeQuick : story.mode === 2 ? cfg.txtModeSlow : cfg.txtModeNormal, inline: true },
        { name: cfg.lblStatusWriterOrder, value: orderMap[story.story_order_type] ?? '—',                                                        inline: true },
        { name: cfg.lblStatusTurnLength,  value: story.mode === 2 ? cfg.txtNA : `${story.turn_length_hours}h${reminderText}`,                    inline: true },
        { name: cfg.lblStatusWriters,     value: `${activeWriters.length}/${story.max_writers || '∞'} · ${joinStatus}`,        inline: true },
        { name: cfg.lblStatusShowAuthors, value: story.show_authors ? cfg.txtYes : cfg.txtNo,                                  inline: true },
        { name: cfg.lblStatusCurrentTurn, value: turnValue,                                                                    inline: true },
        { name: cfg.lblStatusNextWriter,  value: nextWriterValue,                                                              inline: true },
        { name: cfg.lblStatusEntries,     value: statsValue,                                                                   inline: true },
        ...metadataFields,
        { name: cfg.lblStatusWriterList,  value: writerLines.join('\n') || '—',                                                inline: false }
      )
      .setTimestamp();

    if (story.summary) embed.setDescription(story.summary);
    if (story.story_status === 3 && story.closed_at) {
      const closedTimestamp = `<t:${Math.floor(new Date(story.closed_at).getTime() / 1000)}:D>`;
      embed.addFields({ name: cfg.lblStatusClosed, value: closedTimestamp, inline: true });
    }

    const activeThreadId = getActiveThreadId(story);
    const storyThread = await guild.channels.fetch(activeThreadId).catch(() => null);
    if (!storyThread) return;

    // Keep story thread title in sync with current status
    try {
      const expectedTitle = await buildThreadTitle(connection, story);
      if (storyThread.name !== expectedTitle) {
        await storyThread.setName(expectedTitle).catch(() => {});
      }
    } catch {}

    // Add Join button if story is open for new writers
    const isJoinable = story.story_status !== 3
      && story.allow_joins
      && (!story.max_writers || activeWriters.length < story.max_writers);

    const components = [];
    const actionRow = new ActionRowBuilder();
    let hasActionButtons = false;

    if (isJoinable) {
      const btnJoinStory = await getConfigValue(connection, 'btnJoinStory', story.guild_id);
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`story_join_${storyId}`)
          .setLabel(btnJoinStory)
          .setStyle(ButtonStyle.Primary)
      );
      hasActionButtons = true;
    }

    // Add "Suggest a Tag" button for active stories
    if (story.story_status === 1) {
      const btnSubmitTag = await getConfigValue(connection, 'btnSubmitTag', story.guild_id);
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`story_submit_tag_${storyId}`)
          .setLabel(btnSubmitTag)
          .setStyle(ButtonStyle.Secondary)
      );
      hasActionButtons = true;
    }

    if (hasActionButtons) components.push(actionRow);

    let message = null;
    if (story.status_message_id) {
      message = await storyThread.messages.fetch(story.status_message_id).catch(() => null);
    }

    if (message) {
      await message.edit({ embeds: [embed], components });
    } else {
      const newMsg = await storyThread.send({ embeds: [embed], components });
      await newMsg.pin().catch(err => log(`Failed to pin status message in story thread ${storyId}: ${err.message}`, { show: true, guildName: guild?.name }));
      await connection.execute(
        `UPDATE story SET status_message_id = ? WHERE story_id = ?`,
        [newMsg.id, storyId]
      );
      // Post creator tip immediately after the first status embed so it's always message #2
      const creatorTip = await getConfigValue(connection, 'txtStoryThreadCreatorTip', story.guild_id).catch(() => null);
      if (creatorTip) {
        const tipMsg = replaceTemplateVariables(creatorTip, { story_id: story.guild_story_id });
        await storyThread.send(tipMsg).catch(err => log(`updateStoryStatusMessage: creator tip post failed for story ${storyId}: ${err?.stack ?? err}`, { show: true, guildName: guild?.name }));
      }
    }
  } catch (err) {
    log(`updateStoryStatusMessage failed for story ${storyId}: ${err?.stack ?? err}`, { show: true, guildName: guild?.name });
  }
}
