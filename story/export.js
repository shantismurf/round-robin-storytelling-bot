import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log } from '../utilities.js';
import { marked } from 'marked';

// Convert Discord markdown to HTML for export
// guild is optional — pass the Discord guild object to resolve mentions, channels, and roles
export async function discordMarkdownToHtml(text, guild = null) {
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
      processed.push(`<p class="subtext">${line.slice(3)}</p>`);
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
export async function generateStoryExport(connection, storyId, guildId, guild = null) {
  const [storyRows] = await connection.execute(
    `SELECT story_id, guild_story_id, title, created_at, story_status, quick_mode, closed_at, show_authors, summary, tags FROM story WHERE story_id = ? AND guild_id = ?`,
    [storyId, guildId]
  );
  if (storyRows.length === 0) return null;
  const story = storyRows[0];

  const [writers] = await connection.execute(
    `SELECT discord_display_name, AO3_name FROM story_writer WHERE story_id = ? AND sw_status = 1 ORDER BY joined_at ASC`,
    [storyId]
  );

  const [entries] = await connection.execute(
    `SELECT se.content, se.created_at, sw.discord_display_name,
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

  const fmt = d => new Date(d).toISOString().slice(0, 10);
  const publishedDate = fmt(story.created_at);
  const isClosed = story.story_status === 3;
  const secondDateLabel = isClosed ? 'Completed' : 'Updated';
  const secondDate = isClosed && story.closed_at ? fmt(story.closed_at) : fmt(entries[entries.length - 1].created_at);
  const exportDate = fmt(new Date());

  const writersList = writers.map(w => `${w.AO3_name || w.discord_display_name} (${w.discord_display_name})`).join(', ');
  const modeLabel = story.quick_mode ? 'Quick Mode' : 'Normal Mode';

  let entriesHtml = '';
  let currentTurn = null;
  for (const entry of entries) {
    if (entry.turn_number !== currentTurn) {
      if (currentTurn !== null) entriesHtml += `</div>`;
      currentTurn = entry.turn_number;
      const turnHeader = story.show_authors
        ? `<h2>Turn ${entry.turn_number} — ${entry.discord_display_name}</h2>`
        : '';
      entriesHtml += `<div class="turn">${turnHeader}`;
    }
    entriesHtml += await discordMarkdownToHtml(entry.content, guild);
  }
  if (currentTurn !== null) entriesHtml += `</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${story.title}</title>
  <link rel="stylesheet" href="https://cdn.simplecss.org/simple.min.css">
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.7; }
    h1 { font-size: 2em; margin-bottom: 8px; }
    .meta { font-size: 0.9em; margin-bottom: 8px; }
    .meta-block { border-bottom: 1px solid; padding-bottom: 24px; margin-bottom: 40px; }
    .turn { margin-bottom: 40px; border-top: 1px solid; padding-top: 20px; }
    p { margin: 0 0 1em; }
    .spoiler { background: #222; color: #222; border-radius: 3px; padding: 0 2px; cursor: pointer; }
    .spoiler:hover { color: #fff; }
    .subtext { font-size: 0.75em; color: #888; margin: 0 0 0.5em; }
    .summary { font-style: italic; margin-bottom: 40px; border-top: 1px solid; padding-top: 20px; }
    .export-note { font-size: 0.8em; color: #999; border-top: 1px solid #eee; margin-top: 60px; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="meta-block">
    <h1>${story.title}</h1>
    <div class="meta">Started: ${publishedDate} &nbsp; ${secondDateLabel}: ${secondDate}</div>
    <div class="meta">Story #${story.guild_story_id} &nbsp;·&nbsp; ${modeLabel} &nbsp;·&nbsp; ${turnCount} turn(s) &nbsp;·&nbsp; ~${wordCount.toLocaleString()} words</div>
    <div class="meta">Writers: ${writersList}</div>${story.tags ? `\n    <div class="meta">Tags: ${story.tags}</div>` : ''}
    <div class="meta">Exported: ${exportDate}</div>
  </div>${story.summary ? `\n  <div class="summary"><p>${story.summary}</p></div>` : ''}
  ${entriesHtml}
  <div class="export-note">
    <p><strong>Export note:</strong> This file was generated by Round Robin StoryBot.
    Timestamps from Discord (e.g. turn deadlines in entries) are not included.
    Story images are hosted on Discord's CDN — if you need them to persist long-term,
    download and re-upload them to a permanent image host and update the links in this file.</p>
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
  const guildId = interaction.guild.id;

  const [storyRows] = await connection.execute(
    `SELECT story_thread_id FROM story WHERE story_id = ? AND guild_id = ?`,
    [storyId, guildId]
  );
  if (!storyRows.length || !storyRows[0].story_thread_id) {
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  const result = await generateStoryExport(connection, storyId, guildId, interaction.guild);
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
