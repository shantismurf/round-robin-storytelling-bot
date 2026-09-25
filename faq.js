import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, getSetupRequiredMessage, log } from './utilities.js';

const EMBED_COLOR = 0x5865f2;

// ---------------------------------------------------------------------------
// Page definitions
// Each page is a tree of { lbl, txt?, children? } entries.
// - lbl only (no txt, has children): group header, children rendered below
// - lbl + txt (no children): standard section
// - lbl + txt + children: section with value, then children blockquoted below
// ---------------------------------------------------------------------------

export const PAGE_DEFS = [
  {
    titleKey: 'txtHelp1Title',
    entries: [
      { lbl: 'lblHelp1FindJoin', txt: 'txtHelp1FindJoin' },
      { lbl: 'lblHelp1JoiningOptions', children: [
        { lbl: 'lblHelp1TurnThreadPrivacy', txt: 'txtHelp1TurnThreadPrivacy' },
        { lbl: 'lblHelp1Notifications',     txt: 'txtHelp1Notifications' },
        { lbl: 'lblHelp1PenName',           txt: 'txtHelp1PenName' },
      ]},
    ],
  },
  {
    titleKey: 'txtHelp2Title',
    entries: [
      { lbl: 'lblHelp2Dashboard',           txt: 'txtHelp2Dashboard' },
      { lbl: 'lblHelp2ManageParticipation', txt: 'txtHelp2ManageParticipation' },
      { lbl: 'lblHelp2WritingYourTurn', children: [
        { lbl: 'lblHelp2WriteNormal', txt: 'txtHelp2WriteNormal' },
        { lbl: 'lblHelp2WriteQuick',  txt: 'txtHelp2WriteQuick' },
        { lbl: 'lblHelp2WriteSlow',   txt: 'txtHelp2WriteSlow' },
        { lbl: 'lblHelp2WriteTranslations', txt: 'txtHelp2WriteTranslations' },
      ]},
    ],
  },
  {
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
    titleKey: 'txtHelp5Title',
    entries: [
      { lbl: 'lblHelp5WhoCanUse', txt: 'txtHelp5WhoCanUse' },
      { lbl: 'lblHelp5WhatEdit',  txt: 'txtHelp5WhatEdit' },
      { lbl: 'lblHelp5Closing',   txt: 'txtHelp5Closing' },
      { lbl: 'lblHelp5AdminControls', txt: 'txtHelp5AdminControls' },
    ],
  },
  {
    titleKey: 'txtHelp6Title',
    entries: [
      { lbl: 'lblHelp6Read',      txt: 'txtHelp6Read' },
      { lbl: 'lblHelp6Edit',      txt: 'txtHelp6Edit' },
      { lbl: 'lblHelp6EditPages', txt: 'txtHelp6EditPages' },
    ],
  },
  {
    titleKey: 'txtHelp7Title',
    footerKey: 'txtHelp7Footer',
    entries: [
      { lbl: 'lblHelp7StoryCommands',   txt: 'txtHelp7StoryCommands' },
      { lbl: 'lblHelp7Dashboard',       txt: 'txtHelp7Dashboard' },
      { lbl: 'lblHelp7CreatorCommands', txt: 'txtHelp7CreatorCommands' },
    ],
  },
  {
    titleKey: 'txtHelp8Title',
    footerKey: 'txtHelp8Footer',
    entries: [
      { lbl: 'lblHelp8Setup', txt: 'txtHelp8Setup', children: [
        { lbl: 'lblHelp8SetupChannels',    txt: 'txtHelp8SetupChannels' },
        { lbl: 'lblHelp8SetupPermissions', txt: 'txtHelp8SetupPermissions' },
        { lbl: 'lblHelp8GroundRules',      txt: 'txtHelp8GroundRules' },
        { lbl: 'lblHelp8TeenOrLower',      txt: 'txtHelp8TeenOrLower' },
        { lbl: 'lblHelp8SetupRoundup',     txt: 'txtHelp8SetupRoundup' },
        { lbl: 'lblHelp8HubAnnouncements', txt: 'txtHelp8HubAnnouncements' },
      ]},
      { lbl: 'lblHelp8ManageStory', txt: 'txtHelp8ManageStory' },
      { lbl: 'lblHelp8ManageUser',  txt: 'txtHelp8ManageUser' },
      { lbl: 'lblHelp8Delete',      txt: 'txtHelp8Delete' },
      { lbl: 'lblHelp8Sweep',       txt: 'txtHelp8Sweep' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function collectKeys(entries) {
  const keys = [];
  for (const entry of entries) {
    keys.push(entry.lbl);
    if (entry.txt) keys.push(entry.txt);
    if (entry.children) keys.push(...collectKeys(entry.children));
  }
  return keys;
}

export function renderEntries(entries, cfg, depth = 0) {
  return entries.map(entry => {
    const label = cfg[entry.lbl];
    const value = entry.txt ? cfg[entry.txt] : null;
    const heading = depth === 0 ? '##' : '###';

    const childBlock = entry.children ? renderEntries(entry.children, cfg, depth + 1) : null;
    const parts = [`${heading} ${label}`];
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

async function buildPage(connection, guildId, pageDef) {
  const keys = [pageDef.titleKey, ...collectKeys(pageDef.entries)];
  if (pageDef.footerKey) keys.push(pageDef.footerKey);
  const cfg = await getConfigValue(connection, keys, guildId);
  return { content: renderEntries(pageDef.entries, cfg), cfg };
}

// ---------------------------------------------------------------------------
// /story help — ToC embed with select menu
// ---------------------------------------------------------------------------

async function buildTocEmbed(connection, guildId) {
  const titleKeys = PAGE_DEFS.map(p => p.titleKey);
  const cfg = await getConfigValue(connection, ['txtHelpTocTitle', 'txtHelpTocFooter', ...titleKeys], guildId);

  const select = new StringSelectMenuBuilder()
    .setCustomId('story_help_toc')
    .setPlaceholder(cfg.txtHelpTocFooter)
    .addOptions(PAGE_DEFS.map((p, i) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(cfg[p.titleKey].replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{So}️\s]+/gu, '').trim())
        .setValue(String(i))
    ));

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelpTocTitle)
    .setColor(EMBED_COLOR);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}

export async function handleHelp(connection, interaction) {
  log(`handleHelp entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  try {
    // `help` is exempt from the setup gate in index.js, so an unconfigured server needs the
    // "set me up first" message carried here instead — otherwise the reader gets documentation
    // for commands that will not run, with nothing saying why. Not repeated on page selection,
    // which would put it above every page the reader opens.
    const setupMessage = await getSetupRequiredMessage(connection, interaction);
    await interaction.reply({
      ...(setupMessage ? { content: setupMessage } : {}),
      ...await buildTocEmbed(connection, interaction.guild.id),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log(`handleHelp failed for user=${interaction.user.username}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

export async function handleHelpSelect(connection, interaction) {
  log(`handleHelpSelect entry user=${interaction.user.username} value=${interaction.values[0]}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const idx = parseInt(interaction.values[0]);
    const pageDef = PAGE_DEFS[idx];
    const guildId = interaction.guild.id;
    const { content, cfg } = await buildPage(connection, guildId, pageDef);

    await interaction.editReply({ embeds: [buildPageEmbed(pageDef, cfg, content)] });
  } catch (err) {
    log(`handleHelpSelect failed for user=${interaction.user.username}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

// ---------------------------------------------------------------------------
// /mystory help — page 6
// ---------------------------------------------------------------------------

export async function handleWriterHelp(connection, interaction) {
  log(`handleWriterHelp entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const pageDef = PAGE_DEFS[6]; // page 7: MyStory Commands
    const { content, cfg } = await buildPage(connection, interaction.guild.id, pageDef);
    const setupMessage = await getSetupRequiredMessage(connection, interaction);
    await interaction.editReply({
      ...(setupMessage ? { content: setupMessage } : {}),
      embeds: [buildPageEmbed(pageDef, cfg, content)],
    });
  } catch (err) {
    log(`handleWriterHelp failed for user=${interaction.user.username}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin help — page 7
// ---------------------------------------------------------------------------

export async function handleAdminHelp(connection, interaction, guildId) {
  log(`handleAdminHelp entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  try {
    const pageDef = PAGE_DEFS[7]; // page 8: StoryAdmin Commands
    const { content, cfg } = await buildPage(connection, guildId, pageDef);
    const setupMessage = await getSetupRequiredMessage(connection, interaction);
    await interaction.reply({
      ...(setupMessage ? { content: setupMessage } : {}),
      embeds: [buildPageEmbed(pageDef, cfg, content)],
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log(`handleAdminHelp failed for user=${interaction.user.username}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

// ---------------------------------------------------------------------------
// FAQ sync — deletes and reposts all pages to hub FAQ forum
// ---------------------------------------------------------------------------

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

  // Load existing post (thread) IDs — stored as pipe-delimited string, one per page
  const storedIds = await getConfigValue(connection, 'cfgFaqPostIds', guildId).catch(() => null);
  const isSnowflake = id => /^\d{17,20}$/.test(id);
  const existingIds = (storedIds && isSnowflake(storedIds.split('|')[0]))
    ? storedIds.split('|')
    : [];

  const newIds = new Array(PAGE_DEFS.length).fill('');
  let errors = 0;
  // Counted separately from `errors`, which means "this page failed to post". An orphan is the
  // opposite problem: the new page posted fine but the old one is still sitting in the forum.
  let orphaned = 0;

  // Post in reverse order so page 1 (Overview) sorts to top of forum
  for (let i = PAGE_DEFS.length - 1; i >= 0; i--) {
    const pageDef = PAGE_DEFS[i];
    try {
      // Delete the existing forum post if we have a valid ID for it. Every branch here logs:
      // both the fetch and the delete used to end in `.catch(() => null)`, so a thread that had
      // vanished, or a delete the bot lacked permission for, produced a duplicate post and no
      // trace of why.
      const existingId = existingIds[i];
      if (!existingId || !isSnowflake(existingId)) {
        log(`syncFaqPosts: page ${i + 1} has no tracked thread id — posting a new thread without replacing anything`, { show: false });
      } else {
        const existingThread = await faqChannel.threads.fetch(existingId).catch(() => null);
        if (!existingThread) {
          log(`syncFaqPosts: page ${i + 1} tracked thread ${existingId} not found in the FAQ channel — it was either already removed by hand, or the old post is still in the forum untracked and needs deleting`, { show: true });
          orphaned++;
        } else {
          try {
            await existingThread.delete();
          } catch (err) {
            log(`syncFaqPosts: page ${i + 1} failed to delete old thread ${existingId}: ${err?.stack ?? err}`, { show: true });
            orphaned++;
          }
        }
      }

      const { content, cfg } = await buildPage(connection, guildId, pageDef);
      const title = cfg[pageDef.titleKey].replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{So}️\s]+/gu, '').trim();
      const thread = await faqChannel.threads.create({
        name: title,
        message: { embeds: [buildPageEmbed(pageDef, cfg, content)] },
      });
      newIds[i] = thread.id;
      log(`syncFaqPosts: posted page ${i + 1} "${title}" (thread ${thread.id})`, { show: true });
    } catch (err) {
      log(`syncFaqPosts: failed for page ${i + 1}: ${err?.stack ?? err}`, { show: true });
      errors++;
    }
  }

  // Save new thread IDs back — use INSERT ... ON DUPLICATE KEY to handle missing key gracefully
  await connection.execute(
    `INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES ('cfgFaqPostIds', ?, 'en', ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [newIds.join('|'), guildId]
  );

  if (orphaned > 0) {
    log(`syncFaqPosts: ${orphaned} of ${PAGE_DEFS.length} old FAQ posts could not be deleted — check the forum for leftovers and remove any by hand. The ids just recorded are correct, so later syncs will replace cleanly`, { show: true, hub: true });
  }
  log(`syncFaqPosts: complete for guild=${guildId} errors=${errors} orphaned=${orphaned}`, { show: true });
  return { errors, orphaned, total: PAGE_DEFS.length };
}
