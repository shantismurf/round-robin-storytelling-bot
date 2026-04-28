/**
 * entryRenderer.js — single source of truth for displaying story entry content.
 *
 * Interactive display (paginated, session-backed):
 *   buildEntryPages()  — splits one entry into page objects
 *   buildEntryEmbed()  — renders one page into { embeds, components }
 *
 * Non-interactive display (permanent thread/channel posts):
 *   buildThreadEmbeds() — returns an array of EmbedBuilders to stack in one channel.send()
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { splitAtParagraphs } from '../utilities.js';

const IMAGES_PER_PAGE = 4;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractImageUrls(content) {
  const urls = [];
  const mdRe = /\[[^\]]*\]\((https:\/\/cdn\.discordapp\.com\/attachments\/[^\s)]+)\)/g;
  let m;
  while ((m = mdRe.exec(content)) !== null) urls.push(m[1]);
  const bareRe = /(?<!\()(https:\/\/cdn\.discordapp\.com\/attachments\/[^\s<"]+)/g;
  while ((m = bareRe.exec(content)) !== null) urls.push(m[1]);
  return urls;
}

// ---------------------------------------------------------------------------
// Interactive: build pages for a single entry
// ---------------------------------------------------------------------------

/**
 * Split one entry's content into page objects compatible with buildEntryEmbed.
 *
 * @param {string} content
 * @param {{ turnNumber, writerName, showAuthors, storyEntryId, editInfo }} meta
 * @returns {Array} pages
 */
export function buildEntryPages(content, { turnNumber, writerName, showAuthors, storyEntryId, editInfo = null } = {}) {
  const imageUrls = extractImageUrls(content);
  const chunks = splitAtParagraphs(content);
  return chunks.map((chunk, i) => ({
    turnNumber,
    writerName: showAuthors ? writerName : null,
    content: chunk,
    partIndex: chunks.length > 1 ? i + 1 : null,
    partCount: chunks.length > 1 ? chunks.length : null,
    storyEntryId,
    isFirstChunk: i === 0,
    editInfo: i === 0 ? editInfo : null,
    imageUrls: i === 0 ? imageUrls : [],
  }));
}

/**
 * Render a page and navigation buttons into { embeds, components }.
 *
 * @param {object} page        — one element from buildEntryPages()
 * @param {object} session     — { title, pageIndex, totalPages, imagePageIndex, guildId, storyThreadId, context, extraButtons }
 *   context: 'read' | 'preview' | 'view'  — selects which customId prefix to use for nav buttons
 *   extraButtons: ActionRowBuilder[]       — injected rows appended after the nav row (e.g. Confirm/Cancel)
 */
export function buildEntryEmbed(page, session) {
  const { title, pageIndex, totalPages, context = 'read', extraButtons = [], storyThreadId, guildId } = session;

  let turnLabel = `Turn ${page.turnNumber}`;
  if (page.writerName) turnLabel += ` — ${page.writerName}`;
  if (page.partIndex)  turnLabel += ` (part ${page.partIndex}/${page.partCount})`;

  let description = page.content;
  if (page.editInfo) {
    description += `\n\n*edited by ${page.editInfo.editedByName} · ${page.editInfo.editedAt}*`;
  }

  const imageUrls = page.imageUrls ?? [];
  const imagePageIndex = session.imagePageIndex ?? 0;
  const totalImagePages = imageUrls.length > 0 ? Math.ceil(imageUrls.length / IMAGES_PER_PAGE) : 0;
  const imageSlice = imageUrls.slice(imagePageIndex * IMAGES_PER_PAGE, (imagePageIndex + 1) * IMAGES_PER_PAGE);
  const groupUrl = storyThreadId
    ? `https://discord.com/channels/${guildId}/${storyThreadId}`
    : 'https://discord.com';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: `${turnLabel} · Page ${pageIndex + 1} of ${totalPages}` });

  if (imageSlice.length > 0) embed.setURL(groupUrl);

  const embeds = [embed];
  for (const url of imageSlice) {
    embeds.push(new EmbedBuilder().setURL(groupUrl).setImage(url));
  }

  const prefix = NAV_PREFIX[context] ?? NAV_PREFIX.read;

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}_back10`)
      .setLabel('«')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}_prev`)
      .setLabel('← Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}_next`)
      .setLabel('Next →')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}_fwd10`)
      .setLabel('»')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex >= totalPages - 1),
  );

  const components = [navRow, ...extraButtons];

  if (totalImagePages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}_img_prev`)
        .setLabel('◀ Images')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(imagePageIndex === 0),
      new ButtonBuilder()
        .setCustomId(`${prefix}_img_next`)
        .setLabel('Images ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(imagePageIndex >= totalImagePages - 1)
    ));
  }

  return { embeds, components };
}

// Button customId prefixes per context — distinct to avoid session collisions.
export const NAV_PREFIX = {
  read:    'story_read',
  preview: 'story_preview',
  view:    'story_view',
};

// ---------------------------------------------------------------------------
// Non-interactive: stacked embeds for permanent thread posts
// ---------------------------------------------------------------------------

/**
 * Build an array of EmbedBuilders for a permanent thread post.
 * Caller does: await channel.send({ embeds: buildThreadEmbeds(content, authorLine) })
 *
 * @param {string}      content    — full entry content
 * @param {string|null} authorLine — e.g. "Turn 3 — Dragonborn"; null if show_authors is false
 * @returns {EmbedBuilder[]}
 */
export function buildThreadEmbeds(content, authorLine = null) {
  const chunks = splitAtParagraphs(content, 3800);
  return chunks.map((chunk, i) => {
    const embed = new EmbedBuilder().setDescription(chunk);
    if (i === 0 && authorLine) embed.setAuthor({ name: authorLine });
    return embed;
  });
}
