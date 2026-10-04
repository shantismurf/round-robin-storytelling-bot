import { EmbedBuilder } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables } from './utilities.js';

export const EMBED_COLOR = 0x5865f2;

// ---------------------------------------------------------------------------
// Page definitions
// Each page is a tree of { lbl, txt?, children? } entries.
// - lbl only (no txt, has children): group header, children rendered below
// - lbl + txt (no children): standard section
// - lbl + txt + children: section with value, then children blockquoted below
// ---------------------------------------------------------------------------

export const PAGE_DEFS = [
  {
    id: 'overview',
    titleKey: 'txtHelp1Title',
    // Prepended to this page in the Hub FAQ forum only. It points a reader at the Hub's own
    // #storybot-support channel, which is meaningless inside any other server -- a channel
    // mention only resolves in the guild that owns the channel, so in /story help it would
    // render as a dead #unknown. The contents menu carries the other welcome, with the invite
    // link, which is the one that does work anywhere (LeeAnn, 2026-10-02).
    faqIntroKey: 'txtHelpOverviewFaqIntro',
    entries: [
      // No headings here on purpose: the overview is a conversational introduction, not the
      // topical reference the other pages are. Three label-less paragraphs, in order.
      { txt: 'txtHelpOverviewHowItWorks' },
      { txt: 'txtHelpOverviewWriting' },
      { txt: 'txtHelpOverviewReading' },
    ],
  },
  {
    id: 'create-general',
    titleKey: 'txtHelp3Title',
    entries: [
      { lbl: 'lblHelp3StoryTitle',      txt: 'txtHelp3StoryTitle' },
      { lbl: 'lblHelp3StoryMode',       txt: 'txtHelp3StoryMode' },
      { lbl: 'lblHelp3WriterOrder',     txt: 'txtHelp3WriterOrder' },
      { lbl: 'lblHelp3TurnLength',      txt: 'txtHelp3TurnLength' },
      { lbl: 'lblHelp3TimeoutReminder', txt: 'txtHelp3TimeoutReminder' },
      { lbl: 'lblHelp3TurnPrivacy',     txt: 'txtHelp3TurnPrivacy' },
      { lbl: 'lblHelp3ShowAuthors',     txt: 'txtHelp3ShowAuthors' },
      { lbl: 'lblHelp3MaxWriters',      txt: 'txtHelp3MaxWriters' },
      { lbl: 'lblHelp3DelayStart',      txt: 'txtHelp3DelayStart' },
    ],
  },
  {
    id: 'create-join-metadata',
    titleKey: 'txtHelp4Title',
    entries: [
      { lbl: 'lblHelp4CreatorOptions', children: [
        { lbl: 'lblHelp4PenName',       txt: 'txtHelp4PenName' },
        { lbl: 'lblHelp4HideMyThreads', txt: 'txtHelp4HideMyThreads' },
        { lbl: 'lblHelp4Notifications', txt: 'txtHelp4Notifications' },
      ]},
      { lbl: 'lblHelp4Metadata', txt: 'txtHelp4Metadata' },
      { lbl: 'lblHelp4GroundRules', txt: 'txtHelp4GroundRules' },
    ],
  },
  {
    id: 'find-join',
    titleKey: 'txtHelpFindJoinTitle',
    // Lead paragraph, no heading of its own: the page title already says "Find & Join a Story",
    // so a first section repeating it read as a duplicate.
    entries: [
      { txt: 'txtHelp1FindJoin' },
      { lbl: 'lblHelp1JoiningOptions', children: [
        { lbl: 'lblHelp1TurnThreadPrivacy', txt: 'txtHelp1TurnThreadPrivacy' },
        { lbl: 'lblHelp1Notifications',     txt: 'txtHelp1Notifications' },
        { lbl: 'lblHelp1PenName',           txt: 'txtHelp1PenName' },
      ]},
    ],
  },
  {
    id: 'writing-your-entry',
    titleKey: 'txtHelpWritingTitle',
    entries: [
      // Thread Features leads the page: it is the part that is true whatever mode you are
      // writing in, so a reader meets it before the three sections that explain the differences.
      // It replaced lblHelp2WriteTranslations and lblHelp2SectionBreak, which LeeAnn condensed
      // into one section on 2026-10-02 and which also picked up double-spaced paragraphs and
      // markdown preservation -- the latter moved out of Normal Mode, where it only ever
      // described a behaviour common to all three modes.
      { lbl: 'lblHelpWritingThreadFeatures', txt: 'txtHelpWritingThreadFeatures' },
      { lbl: 'lblHelp2WriteNormal',          txt: 'txtHelp2WriteNormal' },
      { lbl: 'lblHelp2WriteQuick',           txt: 'txtHelp2WriteQuick' },
      { lbl: 'lblHelp2WriteSlow',            txt: 'txtHelp2WriteSlow' },
    ],
  },
  {
    id: 'reading-editing',
    titleKey: 'txtHelp6Title',
    entries: [
      { lbl: 'lblHelp6Read',      txt: 'txtHelp6Read' },
      { lbl: 'lblHelp6Edit',      txt: 'txtHelp6Edit' },
      { lbl: 'lblHelp6EditPages', txt: 'txtHelp6EditPages' },
    ],
  },
  {
    id: 'your-stories',
    titleKey: 'txtHelp2Title',
    entries: [
      { lbl: 'lblHelp2Dashboard',           txt: 'txtHelp2Dashboard' },
      { lbl: 'lblHelp2ManageParticipation', txt: 'txtHelp2ManageParticipation' },
    ],
  },
  {
    id: 'managing-a-story',
    titleKey: 'txtHelp5Title',
    entries: [
      { lbl: 'lblHelp5WhoCanUse', txt: 'txtHelp5WhoCanUse' },
      { lbl: 'lblHelp5WhatEdit',  txt: 'txtHelp5WhatEdit' },
      { lbl: 'lblHelp5Closing',   txt: 'txtHelp5Closing' },
      { lbl: 'lblHelp5AdminControls', txt: 'txtHelp5AdminControls' },
    ],
  },
  {
    id: 'writer-commands',
    titleKey: 'txtHelp7Title',
    footerKey: 'txtHelp7Footer',
    entries: [
      { lbl: 'lblHelp7StoryCommands',   txt: 'txtHelp7StoryCommands' },
      { lbl: 'lblHelp7Dashboard',       txt: 'txtHelp7Dashboard' },
      { lbl: 'lblHelp7CreatorCommands', txt: 'txtHelp7CreatorCommands' },
    ],
  },
  {
    id: 'admin-server-setup',
    titleKey: 'txtHelp8Title',
    footerKey: 'txtHelp8Footer',
    entries: [
      { lbl: 'lblHelp8Setup', txt: 'txtHelp8Setup', children: [
        { lbl: 'lblHelp8SetupChannels',    txt: 'txtHelp8SetupChannels' },
        { lbl: 'lblHelp8SetupPermissions', txt: 'txtHelp8SetupPermissions' },
      ]},
    ],
  },
  {
    id: 'admin-story-setup',
    titleKey: 'txtHelp9Title',
    footerKey: 'txtHelp8Footer',
    entries: [
      { lbl: 'lblHelp8GroundRules',      txt: 'txtHelp8GroundRules' },
      { lbl: 'lblHelp8RatingsFilter',      txt: 'txtHelp8RatingsFilter' },
      { lbl: 'lblHelp8SetupRoundup',     txt: 'txtHelp8SetupRoundup' },
      { lbl: 'lblHelp8HubAnnouncements', txt: 'txtHelp8HubAnnouncements' },
    ],
  },
  {
    id: 'admin-commands',
    titleKey: 'txtHelp10Title',
    footerKey: 'txtHelp8Footer',
    entries: [
      { lbl: 'lblHelp8ManageStory', txt: 'txtHelp8ManageStory' },
      { lbl: 'lblHelp8ManageUser',  txt: 'txtHelp8ManageUser' },
      { lbl: 'lblHelp8Delete',      txt: 'txtHelp8Delete' },
      { lbl: 'lblHelp8Sweep',       txt: 'txtHelp8Sweep' },
    ],
  },
];

// A config key's numeric prefix is the page it was created for, not the page it renders on. After
// the admin split and this reorder most of them no longer agree: Help1 content sits on pages 1 and
// 4, Help2 on pages 5 and 6, Help8 on pages 10, 11 and 12. The prefix is part of the key's
// identity -- renaming them would orphan any guild's overriding row for no gain -- so keys added
// from here on are named for their page instead (txtHelpOverview*, txtHelpFindJoinTitle).

// Pages are addressed by id, never by position. /mystory help and /storyadmin help jump straight
// to one, the contents menu carries one as each option's value, and the Hub FAQ sync keys each
// forum thread on one. All three used to use the array index, so reordering or splitting a page
// silently repointed every one of them at different content -- and in the sync's case that meant
// overwriting the wrong forum thread with no error.
export function pageById(id) {
  const page = PAGE_DEFS.find(p => p.id === id);
  if (!page) throw new Error(`pageById: no help page with id "${id}"`);
  return page;
}

// A select option label and a forum thread name both want the title without its leading emoji:
// the option already renders its own bullet, and a forum thread name sorts by its first character.
export function stripLeadingEmoji(title) {
  return title.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{So}\u{FE0F}\s]+/gu, '').trim();
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function collectKeys(entries) {
  const keys = [];
  for (const entry of entries) {
    if (entry.lbl) keys.push(entry.lbl);
    if (entry.txt) keys.push(entry.txt);
    if (entry.children) keys.push(...collectKeys(entry.children));
  }
  return keys;
}

// An entry with `txt` and no `lbl` renders as a lead paragraph above the page's first heading.
// Find & Join needs one: its opening text used to carry a heading identical to the page title.
export function renderEntries(entries, cfg, depth = 0) {
  return entries.map(entry => {
    const label = entry.lbl ? cfg[entry.lbl] : null;
    const value = entry.txt ? cfg[entry.txt] : null;
    const heading = depth === 0 ? '##' : '###';

    const childBlock = entry.children ? renderEntries(entry.children, cfg, depth + 1) : null;
    const parts = [];
    if (label) parts.push(`${heading} ${label}`);
    if (value) parts.push(value);
    if (childBlock) parts.push(childBlock);
    return parts.join('\n');
  }).join('\n\n');
}

// One page, one embed. Used by all three interactive help paths and by the Hub FAQ sync, so
// the forum copy and the in-Discord copy cannot drift apart.
export function buildPageEmbed(pageDef, cfg, content) {
  const embed = new EmbedBuilder()
    .setTitle(cfg[pageDef.titleKey])
    .setColor(EMBED_COLOR)
    .setDescription(content);
  if (pageDef.footerKey) embed.setFooter({ text: cfg[pageDef.footerKey] });
  return embed;
}

// Every path that shows a help page goes through here -- the three interactive commands and the
// Hub FAQ forum sync -- which is why the [hubInviteUrl] substitution lives at this level rather
// than at each caller. It used to run on the contents page's intro only, so a page body that
// wanted to point a reader at the Hub had nowhere to put the link.
export async function buildPage(connection, guildId, pageDef, { forFaq = false, extraKeys = [] } = {}) {
  const bodyKeys = collectKeys(pageDef.entries);
  // faqIntroKey is fetched only when it will be rendered, so /story help never pays for it.
  if (forFaq && pageDef.faqIntroKey) bodyKeys.unshift(pageDef.faqIntroKey);
  const keys = [pageDef.titleKey, ...bodyKeys, 'cfgHubInviteUrl', 'cfgHubSupportChannelId'];
  if (pageDef.footerKey) keys.push(pageDef.footerKey);
  // Appended rather than merged into bodyKeys, deliberately: only body copy gets token
  // substitution, and a caller's extra keys are labels. Duplicates in the IN(...) list are
  // harmless, so neither side has to de-dupe against the other.
  keys.push(...extraKeys);
  const cfg = await getConfigValue(connection, keys, guildId);

  // Substituted into the fetched copy, not at render time, so renderEntries stays a pure
  // cfg-in/markdown-out function and the tests can call it with a plain object. Only body keys
  // are touched: a title is a label, and replaceTemplateVariables also strips {?...?} blocks,
  // which has no business running over text that was never written with a token in it.
  const tokens = {
    hubInviteUrl: cfg.cfgHubInviteUrl,
    hubSupportChannelId: cfg.cfgHubSupportChannelId,
  };
  for (const key of bodyKeys) {
    if (typeof cfg[key] === 'string') cfg[key] = replaceTemplateVariables(cfg[key], tokens);
  }

  const body = renderEntries(pageDef.entries, cfg);
  const intro = forFaq && pageDef.faqIntroKey ? cfg[pageDef.faqIntroKey] : null;
  return { content: intro ? `${intro}\n\n${body}` : body, cfg };
}

// ---------------------------------------------------------------------------
// FAQ sync — deletes and reposts all pages to hub FAQ forum
// ---------------------------------------------------------------------------

// The ids the old positional cfgFaqPostIds format referred to, in the order it stored them.
// A value written before pages carried ids is a bare pipe-delimited list of thread ids, and the
// only way to know which page each slot meant is the page order at the time it was written.
// Keep this frozen: it describes history, not the current page list.
const LEGACY_FAQ_PAGE_ORDER = Object.freeze([
  'find-join', 'your-stories', 'create-general', 'create-join-metadata',
  'managing-a-story', 'reading-editing', 'writer-commands', 'admin-server-setup',
]);

/**
 * Read cfgFaqPostIds into a Map of pageId -> threadId, accepting both the current
 * `pageId:threadId|...` form and the legacy bare `threadId|...` form, which is migrated through
 * LEGACY_FAQ_PAGE_ORDER so an existing forum's threads are still recognised and replaced rather
 * than abandoned. Entries that are not usable thread ids are dropped.
 */
export function parseFaqPostIds(stored, isSnowflake) {
  const map = new Map();
  if (!stored) return map;
  const parts = String(stored).split('|').filter(Boolean);
  const legacy = parts.length > 0 && !parts[0].includes(':');
  parts.forEach((part, i) => {
    const [pageId, threadId] = legacy ? [LEGACY_FAQ_PAGE_ORDER[i], part] : splitFirst(part);
    if (pageId && threadId && isSnowflake(threadId)) map.set(pageId, threadId);
  });
  return map;
}

function splitFirst(part) {
  const at = part.indexOf(':');
  return at === -1 ? [null, null] : [part.slice(0, at), part.slice(at + 1)];
}

export function serializeFaqPostIds(map) {
  return [...map].map(([pageId, threadId]) => `${pageId}:${threadId}`).join('|');
}

/**
 * Delete one tracked forum thread. Returns 1 if it could not be removed and is now an orphan
 * sitting in the forum, 0 if it is gone. Every branch logs: both the fetch and the delete used
 * to end in `.catch(() => null)`, so a thread that had vanished, or one the bot lacked
 * permission to delete, produced a duplicate post and no trace of why.
 */
async function deleteTrackedThread(faqChannel, threadId, pageRef) {
  const thread = await faqChannel.threads.fetch(threadId).catch(() => null);
  if (!thread) {
    log(`syncFaqPosts: ${pageRef} tracked thread ${threadId} not found in the FAQ channel — it was either already removed by hand, or the old post is still in the forum untracked and needs deleting`, { show: true });
    return 1;
  }
  try {
    await thread.delete();
    return 0;
  } catch (err) {
    log(`syncFaqPosts: ${pageRef} failed to delete old thread ${threadId}: ${err?.stack ?? err}`, { show: true });
    return 1;
  }
}

export async function syncFaqPosts(client, connection, guildId) {
  log(`syncFaqPosts: starting sync for guild=${guildId}`, { show: true });

  const hubServerId  = await getConfigValue(connection, 'cfgHubServerId', guildId);
  const faqChannelId = await getConfigValue(connection, 'cfgHubFaqChannelId', guildId);

  if (!hubServerId || !faqChannelId) {
    log(`syncFaqPosts: cfgHubServerId or cfgHubFaqChannelId not set for guild=${guildId}`, { show: true });
    return { errors: PAGE_DEFS.length, orphaned: 0, total: PAGE_DEFS.length };
  }

  const hubGuild = await client.guilds.fetch(hubServerId).catch(() => null);
  if (!hubGuild) {
    log(`syncFaqPosts: could not fetch hub guild ${hubServerId}`, { show: true });
    return { errors: PAGE_DEFS.length, orphaned: 0, total: PAGE_DEFS.length };
  }

  const faqChannel = await hubGuild.channels.fetch(faqChannelId).catch(() => null);
  if (!faqChannel) {
    log(`syncFaqPosts: could not fetch FAQ channel ${faqChannelId}`, { show: true });
    return { errors: PAGE_DEFS.length, orphaned: 0, total: PAGE_DEFS.length };
  }

  // Tracked forum threads, stored as pipe-delimited `pageId:threadId` pairs. This used to be a
  // bare positional list, one slot per page, which meant that splitting or reordering a page
  // repointed every later slot at a different page and the sync then overwrote the wrong thread.
  const storedIds = await getConfigValue(connection, 'cfgFaqPostIds', guildId).catch(() => null);
  const isSnowflake = id => /^\d{17,20}$/.test(id);
  const existingIds = parseFaqPostIds(storedIds, isSnowflake);

  const newIds = new Map();
  let errors = 0;
  // Counted separately from `errors`, which means "this page failed to post". An orphan is the
  // opposite problem: the new page posted fine but the old one is still sitting in the forum.
  let orphaned = 0;

  // Post in reverse order so page 1 sorts to the top of the forum
  for (let i = PAGE_DEFS.length - 1; i >= 0; i--) {
    const pageDef = PAGE_DEFS[i];
    const pageRef = `${pageDef.id} (position ${i + 1})`;
    try {
      // Delete the existing forum post if we have a valid ID for it. Every branch here logs:
      // both the fetch and the delete used to end in `.catch(() => null)`, so a thread that had
      // vanished, or a delete the bot lacked permission for, produced a duplicate post and no
      // trace of why.
      const existingId = existingIds.get(pageDef.id);
      if (!existingId) {
        log(`syncFaqPosts: ${pageRef} has no tracked thread id — posting a new thread without replacing anything`, { show: false });
      } else {
        orphaned += await deleteTrackedThread(faqChannel, existingId, pageRef);
      }

      const { content, cfg } = await buildPage(connection, guildId, pageDef, { forFaq: true });
      const title = stripLeadingEmoji(cfg[pageDef.titleKey]);
      const thread = await faqChannel.threads.create({
        name: title,
        message: { embeds: [buildPageEmbed(pageDef, cfg, content)] },
      });
      newIds.set(pageDef.id, thread.id);
      log(`syncFaqPosts: posted ${pageRef} "${title}" (thread ${thread.id})`, { show: true });
    } catch (err) {
      log(`syncFaqPosts: failed for ${pageRef}: ${err?.stack ?? err}`, { show: true });
      errors++;
    }
  }

  // A page that no longer exists leaves its thread behind. Keying on id is what makes this
  // findable at all — under the old positional format a removed page just shifted everything.
  for (const [staleId, threadId] of existingIds) {
    if (newIds.has(staleId)) continue;
    log(`syncFaqPosts: "${staleId}" is no longer a help page — removing its leftover thread ${threadId}`, { show: true });
    orphaned += await deleteTrackedThread(faqChannel, threadId, `retired page "${staleId}"`);
  }

  // Save new thread IDs back — use INSERT ... ON DUPLICATE KEY to handle missing key gracefully
  await connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES ('cfgFaqPostIds', ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [serializeFaqPostIds(newIds), guildId]
  );

  if (orphaned > 0) {
    log(`syncFaqPosts: ${orphaned} of ${PAGE_DEFS.length} old FAQ posts could not be deleted — check the forum for leftovers and remove any by hand. The ids just recorded are correct, so later syncs will replace cleanly`, { show: true, hub: true });
  }
  log(`syncFaqPosts: complete for guild=${guildId} errors=${errors} orphaned=${orphaned}`, { show: true });
  return { errors, orphaned, total: PAGE_DEFS.length };
}
