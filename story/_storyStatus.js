import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, trimTrailingEmoji } from '../utilities.js';
import { ratingCodes, ratingBadgeKey, warningOptions, dynamicOptions, formatWarnings, isStoryJoinable } from './_metadata.js';
import { resolveGroundRules, parseGroundRulesText, effectiveGroundRulesText, buildGroundRulesEmbed } from './_groundRules.js';
import { getActiveThreadId } from '../storybot.js';
import { STORY_STATUS, TURN_STATUS, WRITER_STATUS, STORY_MODE, ENTRY_STATUS } from '../constants.js';

/**
 * Truncates free-text metadata to a render cap, with an ellipsis when it had to cut. Several of
 * these fields accept more characters in their modal than the status post can afford to spend on
 * them, and a value over an embed's own limit makes EmbedBuilder throw — which takes the whole
 * status post down, not just the one field.
 */
function clampText(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Joins `lines` under a character budget, always keeping `tail`, and marks whatever was cut by
 * appending "…and N more" to the last line it kept. Written for the writer list, which had no cap
 * at all: around thirty writers would push the field past an embed field's 1024 and EmbedBuilder
 * would throw, so a busy story simply stopped updating its status post.
 *
 * The suffix rides the last name rather than taking a line of its own (LeeAnn, 2026-10-03) — a
 * line of its own would read as another writer, and `-#` subtext doesn't render in a field value.
 */
function capLines(lines, tail, limit, moreTemplate) {
  const tailText = tail.length ? `\n${tail.join('\n')}` : '';
  const budget = limit - tailText.length;
  const full = lines.join('\n');
  if (full.length <= budget) return (full + tailText) || '—';

  // Reserved against the widest count the suffix could carry, so the digits it ends up printing
  // can never push the finished value back over budget.
  const suffixReserve = 1 + replaceTemplateVariables(moreTemplate, { count: String(lines.length) }).length;
  const kept = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = (kept.length ? 1 : 0) + lines[i].length;
    if (used + cost + suffixReserve > budget) break;
    kept.push(lines[i]);
    used += cost;
  }
  const moreText = replaceTemplateVariables(moreTemplate, { count: String(lines.length - kept.length) });
  if (!kept.length) return `${moreText}${tailText}`;
  kept[kept.length - 1] = `${kept[kept.length - 1]} ${moreText}`;
  return `${kept.join('\n')}${tailText}`;
}

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
  const statusLabel = { [STORY_STATUS.ACTIVE]: txtActive, [STORY_STATUS.PAUSED]: txtPaused, [STORY_STATUS.CLOSED]: txtClosed, [STORY_STATUS.DELAYED]: txtDelayed }[story.story_status] ?? txtActive;
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
              other_relationships, characters, dynamic, ground_rules
       FROM story WHERE story_id = ?`,
      [storyId]
    );
    if (storyRows.length === 0 || !getActiveThreadId(storyRows[0])) return;
    const story = storyRows[0];

    const [writers] = await connection.execute(
      `SELECT story_writer_id, discord_display_name, pen_name, sw_status, writer_order
       FROM story_writer WHERE story_id = ? ORDER BY joined_at ASC`,
      [storyId]
    );

    const [activeTurnRows] = await connection.execute(
      `SELECT t.turn_ends_at, t.story_writer_id, sw.discord_display_name
       FROM turn t
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND t.turn_status = ?`,
      [storyId, TURN_STATUS.ACTIVE]
    );
    const activeTurn = activeTurnRows[0] ?? null;

    // Entry stats — count confirmed entries, words, and inline images
    const [confirmedEntries] = await connection.execute(
      `SELECT se.content, t.story_writer_id FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
       WHERE sw.story_id = ? AND se.entry_status = ?`,
      [storyId, ENTRY_STATUS.CONFIRMED]
    );
    const entryCount = confirmedEntries.length;
    const contributingWriterIds = new Set(confirmedEntries.map(e => e.story_writer_id));
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

    const ratingBadgeCfgKey = ratingBadgeKey(story.rating ?? 'NR');
    const cfg = await getConfigValue(connection, [
      'txtActive', 'txtPaused', 'txtClosed', 'txtDelayed',
      'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'txtModeQuick', 'txtModeNormal', 'txtModeSlow',
      'txtStatusSlowModeNoTimer', 'txtStatusReminderSuffixSlow',
      'txtYes', 'txtNo', 'txtOpen', 'txtNA',
      'txtStatusLegendCreator', 'txtStatusLegendCurrentTurn', 'txtStatusLegendNextUp', 'txtStatusLegendPaused',
      'txtStatusNoActiveTurn',
      'txtStatusNextManual', 'txtStatusNextFixed', 'txtStatusNextRoundRobin', 'txtStatusNextRandom',
      'txtStatusReminderSuffix', 'txtStatusNoEntries', 'txtStatusEntryStats',
      'lblStatusStatus', 'lblStatusMode', 'lblStatusWriterOrder',
      'lblStatusTurnLength', 'lblStatusWriters', 'lblStatusShowAuthors',
      'lblStatusCurrentTurn', 'lblStatusNextWriter', 'lblStatusEntries', 'lblStatusWriterList', 'lblStatusInactiveHeading', 'lblStatusClosed',
      'lblMetaRating', 'lblMetaMainRelationship', 'lblMetaOtherRelationships', 'lblMetaWarnings', 'lblMetaCharacters', 'lblMetaTags',
      'lblMetaDynamic', 'lblMetaGroundRules', 'txtGroundRulesDesc', 'cfgGroundRules', 'txtGroundRulesDefaultVocabulary',
      'txtStatusWriterListMore',
      ratingBadgeCfgKey,
      ...warningOptions,
      ...dynamicOptions,
    ], story.guild_id);
    const groundRules = resolveGroundRules(story.ground_rules, parseGroundRulesText(effectiveGroundRulesText(cfg.cfgGroundRules, cfg.txtGroundRulesDefaultVocabulary)));
    const txtActive = cfg.txtActive;
    const txtPaused = cfg.txtPaused;
    const txtClosed = cfg.txtClosed;
    const txtDelayed = cfg.txtDelayed;
    const txtOrderRandom = cfg.txtOrderRandom;
    const txtOrderRoundRobin = cfg.txtOrderRoundRobin;
    const txtOrderFixed = cfg.txtOrderFixed;
    const ratingBadgeDisplay = cfg[ratingBadgeCfgKey];

    const statusMap = { [STORY_STATUS.ACTIVE]: `▶️ ${txtActive}`, [STORY_STATUS.PAUSED]: `⏸️ ${txtPaused}`, [STORY_STATUS.CLOSED]: `🔒 ${txtClosed}`, [STORY_STATUS.DELAYED]: `⏳ ${txtDelayed}` };
    const orderMap = { 1: `🎲 ${txtOrderRandom}`, 2: `🔄 ${txtOrderRoundRobin}`, 3: `📋 ${txtOrderFixed}` };
    const colorMap = { 1: 0x57f287, 2: 0xfee75c, 3: 0xed4245 };

    const activeWriters = writers.filter(w => w.sw_status === WRITER_STATUS.ACTIVE);
    const pausedWriters = writers.filter(w => w.sw_status === WRITER_STATUS.PAUSED);
    // Departed writers who never contributed a confirmed entry are dropped from the roster
    // entirely rather than archived — nothing to preserve a record of.
    const leftWriters   = writers.filter(w => w.sw_status === WRITER_STATUS.LEFT && contributingWriterIds.has(w.story_writer_id));

    // Creator = first writer to join (first in joined_at ASC order among active writers)
    const creatorId = activeWriters[0]?.story_writer_id ?? null;

    const legendParts = [cfg.txtStatusLegendCreator, cfg.txtStatusLegendCurrentTurn, cfg.txtStatusLegendNextUp];
    if (pausedWriters.length > 0) legendParts.push(cfg.txtStatusLegendPaused);

    const inactiveLines = [
      ...pausedWriters.map(w => {
        const penName = w.pen_name && w.pen_name !== w.discord_display_name ? ` (${w.pen_name})` : '';
        return `⏸️ ${w.discord_display_name}${penName}`;
      }),
      ...leftWriters.map(w => `*${w.discord_display_name}*`),
    ];

    const activeWriterLines = [
      ...activeWriters.map(w => {
        const isCurrent = activeTurn?.story_writer_id === w.story_writer_id;
        const isCreator = w.story_writer_id === creatorId;
        const isPinnedNext = story.next_writer_id && w.story_writer_id === story.next_writer_id;
        const penName = w.pen_name && w.pen_name !== w.discord_display_name ? ` (${w.pen_name})` : '';
        const emojis = [isCreator ? '⭐' : '', isCurrent ? '✍️' : '', isPinnedNext ? '📌' : ''].filter(Boolean).join('');
        const prefix = emojis ? `${emojis} ` : '';
        return `${prefix}**${w.discord_display_name}**${penName}`;
      }),
    ];

    // The inactive roster and the legend are the part of this field a reader needs whatever the
    // writer count is, so the 512 cap is spent on names and these are reserved out of it first.
    const writerListTail = [
      ...(inactiveLines.length > 0 ? ['', `**${cfg.lblStatusInactiveHeading}**`, ...inactiveLines] : []),
      '',
      `*${legendParts.join('  ·  ')}*`
    ];
    const writerListValue = capLines(activeWriterLines, writerListTail, 512, cfg.txtStatusWriterListMore);

    let turnValue;
    if (activeTurn) {
      if (activeTurn.turn_ends_at) {
        const endTimestamp = `<t:${Math.floor(new Date(activeTurn.turn_ends_at).getTime() / 1000)}:R>`;
        turnValue = `**${activeTurn.discord_display_name}** — ends ${endTimestamp}`;
      } else {
        turnValue = `**${activeTurn.discord_display_name}** — ${cfg.txtStatusSlowModeNoTimer}`;
      }
    } else {
      turnValue = story.story_status === STORY_STATUS.ACTIVE ? cfg.txtStatusNoActiveTurn : '—';
    }

    // Next writer — only deterministic for Fixed order; Random and Round Robin are selected at turn change
    let nextWriterValue = '—';
    if (story.story_status === STORY_STATUS.ACTIVE) {
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
      reminderText = story.mode === STORY_MODE.SLOW
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
      metadataFields.push({ name: trimTrailingEmoji(cfg.lblMetaRating), value: `${ratingBadgeDisplay} ${story.rating}`, inline: true });
    }
    if (story.dynamic)            metadataFields.push({ name: trimTrailingEmoji(cfg.lblMetaDynamic), value: cfg[story.dynamic] ?? story.dynamic, inline: true });
    if (story.main_pairing)       metadataFields.push({ name: trimTrailingEmoji(cfg.lblMetaMainRelationship), value: story.main_pairing, inline: true });
    // Capped at 512 on render (LeeAnn, 2026-10-03): the modal input accepts 1000, comfortably
    // past half of an embed field's own 1024, and two maxed free-text fields plus a maxed
    // writer list is what pushes a status post toward Discord's 6,000-per-message ceiling.
    if (story.other_relationships) metadataFields.push({ name: trimTrailingEmoji(cfg.lblMetaOtherRelationships), value: clampText(story.other_relationships, 512), inline: true });
    if (warningsDisplay)          metadataFields.push({ name: trimTrailingEmoji(cfg.lblMetaWarnings), value: warningsDisplay, inline: false });
    // Ground Rules deliberately absent from metadataFields — they render as their own embed
    // below, where the description an admin wrote has room to show (see buildGroundRulesEmbed).
    if (story.characters)    metadataFields.push({ name: trimTrailingEmoji(cfg.lblMetaCharacters), value: story.characters.length > 200 ? story.characters.slice(0, 197) + '...' : story.characters, inline: false });
    if (story.tags) metadataFields.push({ name: trimTrailingEmoji(cfg.lblMetaTags), value: story.tags.length > 500 ? story.tags.slice(0, 497) + '...' : story.tags, inline: false });

    const joinStatus = story.allow_joins && !(story.max_writers && activeWriters.length >= story.max_writers) ? cfg.txtOpen : cfg.txtClosed;

    // An embed title over 256 makes EmbedBuilder throw and the status post stops updating
    // altogether. The story title input accepts 500, so clamp the title itself to whatever the
    // id and rating badge around it leave free rather than clamping the finished string, which
    // would cut the badge off instead.
    const titleSuffix = ` (#${story.guild_story_id}) ${ratingBadgeDisplay}`;
    const embedTitle = `📚 ${clampText(story.title, 256 - titleSuffix.length - 3)}${titleSuffix}`;

    const embed = new EmbedBuilder()
      .setTitle(embedTitle)
      .setColor(colorMap[story.story_status] ?? 0x5865f2)
      .addFields(
        { name: cfg.lblStatusStatus,      value: statusMap[story.story_status] ?? '—',                                         inline: true },
        { name: cfg.lblStatusMode,        value: story.mode === STORY_MODE.QUICK ? cfg.txtModeQuick : story.mode === STORY_MODE.SLOW ? cfg.txtModeSlow : cfg.txtModeNormal, inline: true },
        { name: cfg.lblStatusWriterOrder, value: orderMap[story.story_order_type] ?? '—',                                                        inline: true },
        { name: cfg.lblStatusTurnLength,  value: story.mode === STORY_MODE.SLOW ? cfg.txtNA : `${story.turn_length_hours}h${reminderText}`,                    inline: true },
        { name: cfg.lblStatusWriters,     value: `${activeWriters.length}/${story.max_writers || '∞'} · ${joinStatus}`,        inline: true },
        { name: cfg.lblStatusShowAuthors, value: story.show_authors ? cfg.txtYes : cfg.txtNo,                                  inline: true },
        { name: cfg.lblStatusCurrentTurn, value: turnValue,                                                                    inline: true },
        { name: cfg.lblStatusNextWriter,  value: nextWriterValue,                                                              inline: true },
        { name: cfg.lblStatusEntries,     value: statsValue,                                                                   inline: true },
        ...metadataFields,
        { name: cfg.lblStatusWriterList,  value: writerListValue,                                                             inline: false }
      )
      .setTimestamp();

    if (story.summary) embed.setDescription(story.summary);

    // Ground Rules get an embed of their own so each rule's description has room — in a metadata
    // field they were a quoted comma list of labels and the descriptions were never shown at all.
    const embeds = [embed];
    if (groundRules.length) embeds.push(buildGroundRulesEmbed(cfg, groundRules));
    if (story.story_status === STORY_STATUS.CLOSED && story.closed_at) {
      const closedTimestamp = `<t:${Math.floor(new Date(story.closed_at).getTime() / 1000)}:D>`;
      embed.addFields({ name: cfg.lblStatusClosed, value: closedTimestamp, inline: true });
    }

    const activeThreadId = getActiveThreadId(story);
    const storyThread = await guild.channels.fetch(activeThreadId).catch(() => null);
    if (!storyThread) return;

    // Story is still active/paused per the DB, so an archived/locked thread here means
    // Discord (or a user) archived it out from under the engine — reopen it to post.
    if (storyThread.locked) await storyThread.setLocked(false).catch(() => {});
    if (storyThread.archived) await storyThread.setArchived(false).catch(() => {});

    // Keep story thread title in sync with current status
    try {
      const expectedTitle = await buildThreadTitle(connection, story);
      if (storyThread.name !== expectedTitle) {
        await storyThread.setName(expectedTitle).catch(() => {});
      }
    } catch {}

    // Add Join button if story is open for new writers. Shared with the feed creation
    // announcement so the two cannot drift on what "open" means.
    const isJoinable = isStoryJoinable(story, activeWriters.length);

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
    if (story.story_status === STORY_STATUS.ACTIVE) {
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
      await message.edit({ embeds, components });
    } else {
      const newMsg = await storyThread.send({ embeds, components });
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
