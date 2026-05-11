import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log } from './utilities.js';

const EMBED_COLOR = 0x5865f2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function section(label, value) {
  return `## ${label}\n${value}`;
}

function chunkContent(content, maxLen = 2000) {
  if (content.length <= maxLen) return [content];
  const chunks = [];
  const parts = content.split('\n\n');
  let current = '';
  for (const part of parts) {
    const next = current ? current + '\n\n' + part : part;
    if (next.length > maxLen) {
      if (current) chunks.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Page content builders
// Canonical source for all help embeds and FAQ sync posts.
// Each returns { content } — a markdown string used by both Discord embeds
// and Hub FAQ thread posts.
// ---------------------------------------------------------------------------

async function buildPage1(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'lblHelp1FindJoin', 'txtHelp1FindJoin',
    'lblHelp1JoiningOptions',
    'lblHelp1TurnThreadPrivacy', 'txtHelp1TurnThreadPrivacy',
    'lblHelp1Notifications', 'txtHelp1Notifications',
    'lblHelp1PenName', 'txtHelp1PenName',
    'lblHelp1Dashboard', 'txtHelp1Dashboard',
    'lblHelp1ManageParticipation', 'txtHelp1ManageParticipation',
    'lblHelp1WritingYourTurn',
    'lblHelp1WriteNormal', 'txtHelp1WriteNormal',
    'lblHelp1WriteQuick', 'txtHelp1WriteQuick',
    'lblHelp1WriteSlow', 'txtHelp1WriteSlow',
  ], guildId);

  return [
    section(cfg.lblHelp1FindJoin, cfg.txtHelp1FindJoin),
    section(cfg.lblHelp1JoiningOptions, [
      section(cfg.lblHelp1TurnThreadPrivacy, cfg.txtHelp1TurnThreadPrivacy),
      section(cfg.lblHelp1Notifications, cfg.txtHelp1Notifications),
      section(cfg.lblHelp1PenName, cfg.txtHelp1PenName),
    ].join('\n\n')),
    section(cfg.lblHelp1Dashboard, cfg.txtHelp1Dashboard),
    section(cfg.lblHelp1ManageParticipation, cfg.txtHelp1ManageParticipation),
    section(cfg.lblHelp1WritingYourTurn, [
      section(cfg.lblHelp1WriteNormal, cfg.txtHelp1WriteNormal),
      section(cfg.lblHelp1WriteQuick, cfg.txtHelp1WriteQuick),
      section(cfg.lblHelp1WriteSlow, cfg.txtHelp1WriteSlow),
    ].join('\n\n')),
  ].join('\n\n');
}

async function buildPage2(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'lblHelp2StoryTitle', 'txtHelp2StoryTitle',
    'lblHelp2StoryMode', 'txtHelp2StoryMode',
    'lblHelp2WriterOrder', 'txtHelp2WriterOrder',
    'lblHelp2TurnLength', 'txtHelp2TurnLength',
    'lblHelp2TimeoutReminder', 'txtHelp2TimeoutReminder',
    'lblHelp2HideThreads', 'txtHelp2HideThreads',
    'lblHelp2ShowAuthors', 'txtHelp2ShowAuthors',
    'lblHelp2MaxWriters', 'txtHelp2MaxWriters',
    'lblHelp2DelayStart', 'txtHelp2DelayStart',
    'lblHelp2CreatorOptions', 'txtHelp2CreatorOptions',
    'lblHelp2Metadata', 'txtHelp2Metadata',
  ], guildId);

  return [
    section(cfg.lblHelp2StoryTitle, cfg.txtHelp2StoryTitle),
    section(cfg.lblHelp2StoryMode, cfg.txtHelp2StoryMode),
    section(cfg.lblHelp2WriterOrder, cfg.txtHelp2WriterOrder),
    section(cfg.lblHelp2TurnLength, cfg.txtHelp2TurnLength),
    section(cfg.lblHelp2TimeoutReminder, cfg.txtHelp2TimeoutReminder),
    section(cfg.lblHelp2HideThreads, cfg.txtHelp2HideThreads),
    section(cfg.lblHelp2ShowAuthors, cfg.txtHelp2ShowAuthors),
    section(cfg.lblHelp2MaxWriters, cfg.txtHelp2MaxWriters),
    section(cfg.lblHelp2DelayStart, cfg.txtHelp2DelayStart),
    section(cfg.lblHelp2CreatorOptions, cfg.txtHelp2CreatorOptions),
    section(cfg.lblHelp2Metadata, cfg.txtHelp2Metadata),
    '*After story creation, these settings can be edited by admins or the story creator via `/story manage`.*',
  ].join('\n\n');
}

async function buildPage3(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'lblHelp3WhoCanUse', 'txtHelp3WhoCanUse',
    'lblHelp3WhatEdit', 'txtHelp3WhatEdit',
    'lblHelp3PauseResume', 'txtHelp3PauseResume',
    'lblHelp3Closing', 'txtHelp3Closing',
    'lblHelp3AdminControls', 'txtHelp3AdminControls',
  ], guildId);

  return [
    section(cfg.lblHelp3WhoCanUse, cfg.txtHelp3WhoCanUse),
    section(cfg.lblHelp3WhatEdit, cfg.txtHelp3WhatEdit),
    section(cfg.lblHelp3PauseResume, cfg.txtHelp3PauseResume),
    section(cfg.lblHelp3Closing, cfg.txtHelp3Closing),
    section(cfg.lblHelp3AdminControls, cfg.txtHelp3AdminControls),
  ].join('\n\n');
}

async function buildPage4(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'lblHelp4Turn', 'txtHelp4Turn',
    'lblHelp4Dashboard', 'txtHelp4Dashboard',
    'lblHelp4Pause', 'txtHelp4Pause',
  ], guildId);

  return [
    section(cfg.lblHelp4Turn, cfg.txtHelp4Turn),
    section(cfg.lblHelp4Dashboard, cfg.txtHelp4Dashboard),
    section(cfg.lblHelp4Pause, cfg.txtHelp4Pause),
  ].join('\n\n');
}

async function buildPage5Content(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'lblHelp5Skip', 'txtHelp5Skip',
    'lblHelp5Extend', 'txtHelp5Extend',
    'lblHelp5ManageUser', 'txtHelp5ManageUser',
    'lblHelp5Next', 'txtHelp5Next',
    'lblHelp5Reassign', 'txtHelp5Reassign',
    'lblHelp5Delete', 'txtHelp5Delete',
    'lblHelp5Setup', 'txtHelp5Setup',
    'lblHelp5Remove', 'txtHelp5Remove',
  ], guildId);

  return { cfg, content: [
    section(cfg.lblHelp5Skip, cfg.txtHelp5Skip),
    section(cfg.lblHelp5Extend, cfg.txtHelp5Extend),
    section(cfg.lblHelp5ManageUser, cfg.txtHelp5ManageUser),
    section(cfg.lblHelp5Next, cfg.txtHelp5Next),
    section(cfg.lblHelp5Reassign, cfg.txtHelp5Reassign),
    section(cfg.lblHelp5Delete, cfg.txtHelp5Delete),
    section(cfg.lblHelp5Setup, cfg.txtHelp5Setup),
    section(cfg.lblHelp5Remove, cfg.txtHelp5Remove),
  ].join('\n\n') };
}

// FAQ sync builds a richer page 5 that includes setup channel descriptions and FAQ-specific sections
async function buildPage5Faq(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtSetupEmbedDescFeed', 'txtSetupEmbedDescMedia',
    'txtSetupEmbedDescAdminRole',
    'txtSetupEmbedDescRestrictedFeed', 'txtSetupEmbedDescRestrictedMedia',
    'txtSetupEmbedDescRoundupChannel',
    'lblHelp5FaqSetup', 'txtHelp5FaqSetup',
    'lblHelp5FaqUserPanel', 'txtHelp5FaqUserPanel',
    'lblHelp5FaqDelete', 'txtHelp5FaqDelete',
    'txtHelp5FaqFooter',
  ], guildId);

  const setupContent = [
    '**📡 Configure Story Channels**',
    `- **Story Feed Channel** — ${cfg.txtSetupEmbedDescFeed}`,
    `- **Media Channel** — ${cfg.txtSetupEmbedDescMedia}`,
    `- **Restricted Feed Channel** — ${cfg.txtSetupEmbedDescRestrictedFeed}`,
    `- **Restricted Media Channel** — ${cfg.txtSetupEmbedDescRestrictedMedia}`,
    '',
    '**🔑 Permissions**',
    `- **Admin Role** — ${cfg.txtSetupEmbedDescAdminRole}`,
    '',
    '**📆 Weekly Roundup**',
    'The weekly roundup is a summary of the story activity on your server. It lists active stories and writers, and gives a count of stories created or completed, turns submitted or missed, and words written.',
    `- **Roundup Channel** — ${cfg.txtSetupEmbedDescRoundupChannel}`,
    '- **Roundup Timing** — Choose the day and hour you\'d like the summary to post: day (0 = Sunday, 6 = Saturday), hour UTC (0–23).',
  ].join('\n');

  return [
    section('🛠️ Setup', `- \`/storyadmin setup\` — This command must be run before the bot can function, but it's also used to update system settings.\n${setupContent}`),
    section(cfg.lblHelp5FaqSetup, cfg.txtHelp5FaqSetup),
    section(cfg.lblHelp5FaqUserPanel, cfg.txtHelp5FaqUserPanel),
    section(cfg.lblHelp5FaqDelete, `${cfg.txtHelp5FaqDelete} *(requires confirmation)*`),
    cfg.txtHelp5FaqFooter,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// FAQ page registry — used by syncFaqPosts and /storyadmin faqsync
// ---------------------------------------------------------------------------

export const FAQ_PAGES = [
  { threadKey: 'cfgFaqThreadOverview',      build: (c, g) => buildPage1(c, g).then(content => ({ content })),      label: 'Overview' },
  { threadKey: 'cfgFaqThreadStoryCreation', build: (c, g) => buildPage2(c, g).then(content => ({ content })),      label: 'Story Creation' },
  { threadKey: 'cfgFaqThreadManaging',      build: (c, g) => buildPage3(c, g).then(content => ({ content })),      label: 'Managing a Story' },
  { threadKey: 'cfgFaqThreadWriterCmds',    build: (c, g) => buildPage4(c, g).then(content => ({ content })),      label: 'Writer Commands' },
  { threadKey: 'cfgFaqThreadAdminCmds',     build: (c, g) => buildPage5Faq(c, g).then(content => ({ content })),   label: 'Admin Commands' },
];

// ---------------------------------------------------------------------------
// /story help — paged embed (pages 1–3), with nav buttons
// ---------------------------------------------------------------------------

async function buildStoryHelpEmbed(connection, guildId, pageNumber) {
  const builders = [buildPage1, buildPage2, buildPage3];
  const titleKeys = ['txtHelp1Title', 'txtHelp2Title', 'txtHelp3Title'];
  const footerKeys = ['txtHelp1Footer', 'txtHelp2Footer', 'txtHelp3Footer'];
  const navKeys = [
    { next: 'btnHelp1ToPage2' },
    { prev: 'btnHelp2ToPage1', next: 'btnHelp2ToPage3' },
    { prev: 'btnHelp3ToPage2' },
  ];

  const idx = pageNumber - 1;
  const nav = navKeys[idx];
  const metaKeys = [titleKeys[idx], footerKeys[idx], ...Object.values(nav)];
  const [content, metaCfg] = await Promise.all([
    builders[idx](connection, guildId),
    getConfigValue(connection, metaKeys, guildId),
  ]);

  const embed = new EmbedBuilder()
    .setTitle(metaCfg[titleKeys[idx]])
    .setColor(EMBED_COLOR)
    .setDescription(content)
    .setFooter({ text: metaCfg[footerKeys[idx]] });

  const buttons = [];
  if (nav.prev) buttons.push(
    new ButtonBuilder().setCustomId(`story_help_page_${pageNumber - 1}`).setLabel(metaCfg[nav.prev]).setStyle(ButtonStyle.Secondary)
  );
  if (nav.next) buttons.push(
    new ButtonBuilder().setCustomId(`story_help_page_${pageNumber + 1}`).setLabel(metaCfg[nav.next]).setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: buttons.length > 0 ? [new ActionRowBuilder().addComponents(...buttons)] : [],
  };
}

export async function handleHelp(connection, interaction) {
  log(`handleHelp entry user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  try {
    await interaction.reply({ ...await buildStoryHelpEmbed(connection, interaction.guild.id, 1), flags: MessageFlags.Ephemeral });
  } catch (err) {
    log(`handleHelp failed for user=${interaction.user.id}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

export async function handleHelpNavigation(connection, interaction) {
  log(`handleHelpNavigation entry user=${interaction.user.id} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  try {
    const match = interaction.customId.match(/^story_help_page_(\d+)$/);
    const pageNumber = Math.min(3, Math.max(1, match ? parseInt(match[1]) : 1));
    await interaction.editReply(await buildStoryHelpEmbed(connection, interaction.guild.id, pageNumber));
  } catch (err) {
    log(`handleHelpNavigation failed for user=${interaction.user.id}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

// ---------------------------------------------------------------------------
// /mystory help — single embed, page 4 content
// ---------------------------------------------------------------------------

export async function handleWriterHelp(connection, interaction) {
  log(`handleWriterHelp entry user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guild.id;
    const cfg = await getConfigValue(connection, [
      'txtHelp4Title', 'txtHelp4Footer',
      'lblHelp4Dashboard', 'txtHelp4Dashboard',
      'lblHelp4Turn', 'txtHelp4Turn',
      'lblHelp4Pause', 'txtHelp4Pause',
    ], guildId);

    const embed = new EmbedBuilder()
      .setTitle(cfg.txtHelp4Title)
      .setColor(EMBED_COLOR)
      .addFields(
        { name: cfg.lblHelp4Turn,      value: cfg.txtHelp4Turn,      inline: false },
        { name: cfg.lblHelp4Dashboard, value: cfg.txtHelp4Dashboard, inline: false },
        { name: cfg.lblHelp4Pause,     value: cfg.txtHelp4Pause,     inline: false },
      )
      .setFooter({ text: cfg.txtHelp4Footer });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    log(`handleWriterHelp failed for user=${interaction.user.id}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin help — single embed, page 5 content
// ---------------------------------------------------------------------------

export async function handleAdminHelp(connection, interaction, guildId) {
  log(`handleAdminHelp entry user=${interaction.user.id}`, { show: false, guildName: interaction?.guild?.name });
  try {
    const cfg = await getConfigValue(connection, [
      'txtHelp5Title', 'txtHelp5Footer',
      'lblHelp5Skip', 'txtHelp5Skip',
      'lblHelp5Extend', 'txtHelp5Extend',
      'lblHelp5ManageUser', 'txtHelp5ManageUser',
      'lblHelp5Next', 'txtHelp5Next',
      'lblHelp5Reassign', 'txtHelp5Reassign',
      'lblHelp5Delete', 'txtHelp5Delete',
      'lblHelp5Setup', 'txtHelp5Setup',
      'lblHelp5Remove', 'txtHelp5Remove',
    ], guildId);

    const embed = new EmbedBuilder()
      .setTitle(cfg.txtHelp5Title)
      .setColor(EMBED_COLOR)
      .addFields(
        { name: cfg.lblHelp5Skip,       value: cfg.txtHelp5Skip,       inline: false },
        { name: cfg.lblHelp5Extend,     value: cfg.txtHelp5Extend,     inline: false },
        { name: cfg.lblHelp5ManageUser, value: cfg.txtHelp5ManageUser, inline: false },
        { name: cfg.lblHelp5Next,       value: cfg.txtHelp5Next,       inline: false },
        { name: cfg.lblHelp5Reassign,   value: cfg.txtHelp5Reassign,   inline: false },
        { name: cfg.lblHelp5Delete,     value: cfg.txtHelp5Delete,     inline: false },
        { name: cfg.lblHelp5Setup,      value: cfg.txtHelp5Setup,      inline: false },
        { name: cfg.lblHelp5Remove,     value: cfg.txtHelp5Remove,     inline: false },
      )
      .setFooter({ text: cfg.txtHelp5Footer });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (err) {
    log(`handleAdminHelp failed for user=${interaction.user.id}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

// ---------------------------------------------------------------------------
// FAQ sync — posts/updates Hub server FAQ threads
// ---------------------------------------------------------------------------

export async function syncFaqPosts(client, connection, guildId) {
  log(`syncFaqPosts: starting sync for guild=${guildId}`, { show: true });

  const hubServerId  = await getConfigValue(connection, 'cfgHubServerId', guildId);
  const faqChannelId = await getConfigValue(connection, 'cfgHubFaqChannelId', guildId);

  if (!hubServerId || !faqChannelId) {
    log(`syncFaqPosts: cfgHubServerId or cfgHubFaqChannelId not set for guild=${guildId}`, { show: true });
    return { errors: FAQ_PAGES.length };
  }

  const hubGuild = await client.guilds.fetch(hubServerId).catch(() => null);
  if (!hubGuild) {
    log(`syncFaqPosts: could not fetch hub guild ${hubServerId}`, { show: true });
    return { errors: FAQ_PAGES.length };
  }

  const faqChannel = await hubGuild.channels.fetch(faqChannelId).catch(() => null);
  if (!faqChannel) {
    log(`syncFaqPosts: could not fetch FAQ channel ${faqChannelId}`, { show: true });
    return { errors: FAQ_PAGES.length };
  }

  let errors = 0;

  for (const page of FAQ_PAGES) {
    try {
      const threadId = await getConfigValue(connection, page.threadKey, guildId);
      if (!threadId) {
        log(`syncFaqPosts: ${page.threadKey} not set — skipping ${page.label}`, { show: true });
        errors++;
        continue;
      }

      const thread = await faqChannel.threads.fetch(threadId).catch(() => null);
      if (!thread) {
        log(`syncFaqPosts: thread ${threadId} not found for ${page.label}`, { show: true });
        errors++;
        continue;
      }

      const { content } = await page.build(connection, guildId);
      const chunks = chunkContent(content);

      const messages = await thread.messages.fetch({ limit: 100 });
      const botMsgs = messages.filter(m => m.author.id === client.user.id)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(m => m);

      for (let i = 0; i < chunks.length; i++) {
        if (i < botMsgs.length) {
          await botMsgs[i].edit(chunks[i]);
        } else {
          await thread.send(chunks[i]);
        }
      }
      log(`syncFaqPosts: synced ${chunks.length} message(s) in ${page.label} (thread ${threadId})`, { show: true });
    } catch (err) {
      log(`syncFaqPosts: failed for ${page.label}: ${err?.stack ?? err}`, { show: true });
      errors++;
    }
  }

  log(`syncFaqPosts: complete for guild=${guildId} errors=${errors}`, { show: true });
  return { errors };
}
