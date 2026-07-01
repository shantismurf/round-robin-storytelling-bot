import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from '../utilities.js';
import { marked } from 'marked';
import { ratingCodes, ratingLabelKey, formatWarnings, warningOptions } from './_metadata.js';
import { applyEntryMarkup, isSceneBreakLine } from './_entryMarkup.js';

// Convert Discord markdown to HTML for export
// guild is optional — pass the Discord guild object to resolve mentions, channels, and roles
// dividerText is optional — the story's Scene Break Divider text, used to render [[break]] lines
export async function discordMarkdownToHtml(text, guild = null, dividerText = null) {
  // Custom emoji <:name:id> → Discord CDN img (static)
  text = text.replace(/<:([^:>]+):(\d+)>/g, (_, name, id) =>
    `<img src="https://cdn.discordapp.com/emojis/${id}.png" height="20" alt=":${name}:" style="vertical-align:middle">`
  );
  // Animated emoji <a:name:id> → Discord CDN img (animated gif)
  text = text.replace(/<a:([^:>]+):(\d+)>/g, (_, name, id) =>
    `<img src="https://cdn.discordapp.com/emojis/${id}.gif" height="20" alt=":${name}:" style="vertical-align:middle">`
  );

  // Discord timestamps <t:unix:format> → [timestamp]
  text = text.replace(/<t:\d+(?::[A-Za-z])?>/g, '[timestamp]');

  // Resolve mentions
  if (guild) {
    // Batch-fetch all mentioned users first (avoid duplicate requests)
    const userIds = [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map(m => m[1]))];
    const memberMap = new Map();
    for (const userId of userIds) {
      try {
        const member = await guild.members.fetch(userId);
        memberMap.set(userId, member.displayName);
      } catch {
        memberMap.set(userId, userId);
      }
    }
    text = text.replace(/<@!?(\d+)>/g, (_, id) => `@${memberMap.get(id) ?? id}`);
    text = text.replace(/<#(\d+)>/g, (_, id) => {
      const ch = guild.channels.cache.get(id);
      return ch ? `#${ch.name}` : `#${id}`;
    });
    text = text.replace(/<@&(\d+)>/g, (_, id) => {
      const role = guild.roles.cache.get(id);
      return role ? `@${role.name}` : `@${id}`;
    });
  } else {
    text = text.replace(/<@!?(\d+)>/g, '@[user]');
    text = text.replace(/<#(\d+)>/g, '#[channel]');
    text = text.replace(/<@&(\d+)>/g, '@[role]');
  }

  // Pre-process Discord blockquote syntax and -# subtext before marked sees it
  const lines = text.split('\n');
  const processed = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // -# subtext → wrapped in a styled paragraph (HTML block, marked leaves it alone)
    if (line.startsWith('-# ')) {
      processed.push(`<p class="subtext"><small>${line.slice(3)}</small></p>`);
      i++;
      continue;
    }
    // [[break]] → story's Scene Break Divider, rendered as a centered paragraph
    if (isSceneBreakLine(line, dividerText)) {
      processed.push(`<p class="scene-break">${dividerText}</p>`);
      i++;
      continue;
    }
    // Discord >>> multi-line quote: everything from here to end is one blockquote
    if (line.startsWith('>>> ') || line === '>>>') {
      const firstContent = line.startsWith('>>> ') ? line.slice(4) : '';
      if (firstContent) processed.push(`> ${firstContent}`);
      i++;
      while (i < lines.length) {
        processed.push(`> ${lines[i]}`);
        i++;
      }
      continue;
    }
    // Discord single-line > quote: only quotes that line, then closes
    if (line.startsWith('> ') || line === '>') {
      processed.push(line);
      // Insert blank line after to close blockquote if next line isn't also quoted
      if (i + 1 < lines.length && !lines[i + 1].startsWith('>')) {
        processed.push('');
      }
      i++;
      continue;
    }
    processed.push(line);
    i++;
  }
  text = processed.join('\n');

  // Discord __underline__ → <u> before marked sees it (marked treats __ as bold)
  text = text.replace(/__(.*?)__/gs, '<u>$1</u>');
  // Discord ||spoiler|| → styled span
  text = text.replace(/\|\|(.*?)\|\|/gs, '<span class="spoiler">$1</span>');
  // [[text|translation]] → hover-tooltip span
  text = applyEntryMarkup(text, { target: 'html' });
  // Strip any legacy ![]() image syntax so marked doesn't try to render it
  // (we'll handle image URLs after marked runs, to avoid marked escaping injected HTML)
  text = text.replace(/!\[\]\((https:\/\/cdn\.discordapp\.com\/attachments\/[^\s)]+)\)/g, '$1');

  // Run through marked with breaks:true so single newlines render as line breaks (matching Discord behaviour)
  let html = marked.parse(text, { breaks: true });

  // Convert Discord CDN attachment links to inline images after marked has run.
  // New format [display text](cdn_url): marked renders as <a href="url">text</a> — use text as alt.
  // Legacy format bare url: marked auto-links as <a href="url">url</a> — omit alt when text === url.
  html = html.replace(
    /<a href="(https:\/\/cdn\.discordapp\.com\/attachments\/[^\s"]+)"[^>]*>([^<]*)<\/a>/g,
    (_, url, linkText) => {
      const text = linkText.trim();
      const alt = (text && text !== url) ? ` alt="${text}"` : '';
      return `<a href="${url}"><img src="${url}"${alt} style="max-width:100%;display:block;margin:8px 0"></a>`;
    }
  );

  return html;
}

/**
 * Shared export helper — builds the story HTML and returns stats.
 * Used by both /story read and /story close.
 * Returns null if story not found, or an object with { hasEntries, buffer, filename, title, turnCount, wordCount, writerCount }.
 */
export async function generateStoryExport(connection, storyId, guildId, guild = null, { suppressBreaks = false } = {}) {
  const [storyRows] = await connection.execute(
    `SELECT story_id, guild_story_id, title, created_at, story_status, mode, closed_at, show_authors,
            summary, tags, rating, warnings, main_pairing, other_relationships, characters, dynamic, scene_break_divider
     FROM story WHERE story_id = ? AND guild_id = ?`,
    [storyId, guildId]
  );
  if (storyRows.length === 0) return null;
  const story = storyRows[0];

  const [writers] = await connection.execute(
    `SELECT discord_display_name, AO3_name FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY joined_at ASC`,
    [storyId]
  );

  const [entries] = await connection.execute(
    `SELECT se.content, se.created_at, sw.discord_display_name, sw.AO3_name,
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

  const writerCount = writers.length;
  if (entries.length === 0) {
    return { hasEntries: false, title: story.title, turnCount: 0, wordCount: 0, writerCount, buffer: null, filename: null };
  }

  const wordCount = entries.reduce((total, e) => total + e.content.trim().split(/\s+/).length, 0);
  const turnCount = entries[entries.length - 1].turn_number;

  const cfg = await getConfigValue(connection, [
    ...ratingCodes.map(ratingLabelKey),
    ...warningOptions,
    'txtExportCompletedLabel', 'txtExportUpdatedLabel',
    'txtExportModeQuick', 'txtExportModeSlow', 'txtExportModeNormal',
    'txtExportLblDynamic', 'txtExportLblRating', 'txtExportLblWarnings',
    'txtExportLblRelationship', 'txtExportLblAdditionalRelationships',
    'txtExportLblCharacters', 'txtExportLblTags',
    'txtExportLblStarted', 'txtExportLblWriters', 'txtExportLblExported',
    'txtExportNoteBody', 'txtExportStatsLine',
  ], guildId);

  const fmt = d => new Date(d).toISOString().slice(0, 10);
  const publishedDate = fmt(story.created_at);
  const isClosed = story.story_status === 3;
  const secondDateLabel = isClosed ? cfg.txtExportCompletedLabel : cfg.txtExportUpdatedLabel;
  const secondDate = isClosed && story.closed_at ? fmt(story.closed_at) : fmt(entries[entries.length - 1].created_at);
  const exportDate = fmt(new Date());

  const writersList = writers.map(w => `${w.AO3_name || w.discord_display_name} (${w.discord_display_name})`).join(', ');
  const modeLabel = story.mode === 1 ? cfg.txtExportModeQuick : story.mode === 2 ? cfg.txtExportModeSlow : cfg.txtExportModeNormal;

  let entriesHtml = '';
  let currentTurn = null;
  for (const entry of entries) {
    if (entry.turn_number !== currentTurn) {
      if (currentTurn !== null) entriesHtml += `</div>`;
      currentTurn = entry.turn_number;
      const writerName = entry.AO3_name || entry.discord_display_name;
      const turnHeader = story.show_authors && !suppressBreaks
        ? `<div class="turn-label">Turn ${entry.turn_number} — ${writerName}</div>`
        : '';
      entriesHtml += `<div class="turn">${turnHeader}`;
    }
    entriesHtml += await discordMarkdownToHtml(entry.content, guild, story.scene_break_divider);
  }
  if (currentTurn !== null) entriesHtml += `</div>`;

  const ratingLabel = cfg[ratingLabelKey(story.rating)] ?? story.rating;
  const warningsText = story.warnings
    ? formatWarnings(story.warnings, Object.fromEntries(warningOptions.map(k => [k, cfg[k] ?? k])))
    : cfg.optWarnAllClear;
  const ao3MetaLines = [
    story.dynamic          ? `<div class="meta"><span class="meta-label">${cfg.txtExportLblDynamic}:</span> ${story.dynamic}</div>` : '',
    `<div class="meta"><span class="meta-label">${cfg.txtExportLblRating}:</span> ${ratingLabel}</div>`,
    `<div class="meta"><span class="meta-label">${cfg.txtExportLblWarnings}:</span> ${warningsText}</div>`,
    story.main_pairing     ? `<div class="meta"><span class="meta-label">${cfg.txtExportLblRelationship}:</span> ${story.main_pairing}</div>` : '',
    story.other_relationships ? `<div class="meta"><span class="meta-label">${cfg.txtExportLblAdditionalRelationships}:</span> ${story.other_relationships}</div>` : '',
    story.characters       ? `<div class="meta"><span class="meta-label">${cfg.txtExportLblCharacters}:</span> ${story.characters}</div>` : '',
    story.tags             ? `<div class="meta"><span class="meta-label">${cfg.txtExportLblTags}:</span> ${story.tags}</div>` : '',
  ].filter(Boolean).join('\n    ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${story.title}</title>
  <link rel="stylesheet" href="https://cdn.simplecss.org/simple.min.css">
  <style>
    body { font-family: Georgia, serif; max-width: 1000px; margin: 40px auto; padding: 0 20px; line-height: 1.7; }
    h1 { font-size: 2em; margin-bottom: 8px; }
    .meta { font-size: 0.9em; margin: 8px 0; }
    .meta-label { font-weight: 800; }
    .meta-stats { font-size: 0.7em; }
    .summary { font-style: italic; margin: 10px 0; border-top: 1px solid; border-bottom: 1px solid; padding-top: 10px; }
    .export-note { font-size: 0.7em; opacity: 0.7; border-top: 1px solid; margin-top: 60px; padding-top: 16px; }

    /* ---- Round Robin StoryBot Work Skin ----
       Copy everything between these markers into an AO3 Work Skin
       (Dashboard > My Work Skins > Create Work Skin) and apply it to
       your works to get matching formatting on AO3. */
	  #workskin .turn-label {
  	  font-size: 0.7em;
  	  opacity: 0.7;
  	  font-style: italic;
	}
    #workskin p {
      position: relative;
  	  margin: 0 0 1em;
  }
    #workskin .spoiler { 
  	  background: #222; 
  	  color: #222; 
  	  border-radius: 3px; 
  	  padding: 0 2px; 
  	  cursor: pointer; 
	}
    #workskin .spoiler:hover { 
	    color: #fff; 
	}
    #workskin .subtext { 
	    color: #888; 
	    margin: 0 0 0.5em; 
	}
    #workskin .scene-break { 
	    text-align: center;
      padding: 10px 0;
	}
    #workskin .tooltip {
      display: inline;
      border-bottom: 0.5px dotted;
      outline: none;
      cursor: help;
    }
    #workskin .tooltiptext {
      display: none;
      position: absolute;
      left: 8px;
      right: 8px;
      max-width: 400px;
      top: 50%;
      z-index: 99999;
      background-color: #f0f1f0;
      color: #000;
      padding: 10px;
      border-radius: 5px;
      text-align: left;
      box-shadow: 2px 2px 10px rgba(0, 0, 0, 0.1);
      white-space: normal;
      overflow-wrap: break-word;
      word-wrap: break-word;
    }
    #workskin .tooltip:hover .tooltiptext,
    #workskin .tooltip:focus .tooltiptext {
      display: block;
    }
    /* ---- End Round Robin StoryBot Work Skin ---- */
  </style>
</head>
<body>
  <div class="meta-block">
    <h1>${story.title}</h1>
    <div class="meta-stats">${cfg.txtExportLblStarted}: ${publishedDate} &nbsp; ${secondDateLabel}: ${secondDate}</div>
    <div class="meta-stats">${replaceTemplateVariables(cfg.txtExportStatsLine, { story_num: story.guild_story_id, mode: modeLabel, turn_count: turnCount, word_count: wordCount.toLocaleString() })}</div>
    <div class="meta"><span class="meta-label">${cfg.txtExportLblWriters}: ${writersList}</span></div>
    ${ao3MetaLines}
    <div class="meta"><span class="meta-label">${cfg.txtExportLblExported}: ${exportDate}</span></div>
  </div>${story.summary ? `\n  <div class="summary"><p>${story.summary}</p></div>` : ''}
  <div id="workskin">
  ${entriesHtml}
  </div>
  <div class="export-note">
    <p>${cfg.txtExportNoteBody}</p>
  </div>
</body>
</html>`;

  const buffer = Buffer.from(html, 'utf8');
  const filename = `storybot${storyId}_${story.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html`;
  return { hasEntries: true, title: story.title, turnCount, wordCount, writerCount, buffer, filename };
}

export async function handleExportPostPublic(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const suppressBreaks = interaction.customId.includes('_noturns_');
  const guildId = interaction.guild.id;

  const [storyRows] = await connection.execute(
    `SELECT story_thread_id FROM story WHERE story_id = ? AND guild_id = ?`,
    [storyId, guildId]
  );
  if (!storyRows.length || !storyRows[0].story_thread_id) {
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  const result = await generateStoryExport(connection, storyId, guildId, interaction.guild, { suppressBreaks });
  if (!result?.hasEntries) {
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  const ao3Instructions = await getConfigValue(connection, 'txtExportAO3Instructions', guildId);

  try {
    const thread = await interaction.guild.channels.fetch(String(storyRows[0].story_thread_id));
    await thread.send({ content: ao3Instructions, files: [{ attachment: result.buffer, name: result.filename }] });
  } catch (err) {
    log(`handleExportPostPublic: could not post to story thread: ${err}`, { show: true, guildName: interaction.guild.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  await interaction.editReply({ content: await getConfigValue(connection, 'txtExportPostedPublicly', guildId) });
}
