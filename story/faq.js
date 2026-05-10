import { getConfigValue, log } from '../utilities.js';

function section(label, value) {
  return `## ${label}\n${value}`;
}

export async function buildFaqPage1(connection, guildId) {
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

export async function buildFaqPage2(connection, guildId) {
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

export async function buildFaqPage3(connection, guildId) {
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

export async function buildFaqPage4(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'lblMyHelpTurn', 'txtMyHelpTurn',
    'lblMyHelpDashboard', 'txtMyHelpDashboard',
    'lblMyHelpPause', 'txtMyHelpPause',
  ], guildId);

  // Page 4 has a fixed section for story creator commands not in mystory config
  const creatorSection = section('⚙️ Story Creator Commands', '- `/story manage [id]` — Edit story settings, manage turns and entries, pause or close\n\n*Use `/story help` for detailed explanations of story modes, writer order, metadata, and more.*');

  return [
    section('📖 Story Commands', cfg.txtMyHelpTurn),
    section(cfg.lblMyHelpDashboard, cfg.txtMyHelpDashboard),
    creatorSection,
  ].join('\n\n');
}

export async function buildFaqPage5(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtSetupPanelTitle',
    'txtSetupEmbedDescFeed', 'txtSetupEmbedDescMedia',
    'txtSetupEmbedDescAdminRole',
    'txtSetupEmbedDescRestrictedFeed', 'txtSetupEmbedDescRestrictedMedia',
    'txtSetupEmbedDescRoundupChannel',
    'lblAdminFaqSetup', 'txtAdminFaqSetup',
    'lblAdminFaqUserPanel', 'txtAdminFaqUserPanel',
    'lblAdminFaqDelete', 'txtAdminFaqDelete',
    'txtAdminFaqFooter',
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
    section(cfg.lblAdminFaqSetup, cfg.txtAdminFaqSetup),
    section(cfg.lblAdminFaqUserPanel, cfg.txtAdminFaqUserPanel),
    section(cfg.lblAdminFaqDelete, `${cfg.txtAdminFaqDelete} *(requires confirmation)*`),
    cfg.txtAdminFaqFooter,
  ].join('\n\n');
}

export const FAQ_PAGES = [
  { threadKey: 'cfgFaqThreadOverview',      build: buildFaqPage1, label: 'Overview' },
  { threadKey: 'cfgFaqThreadStoryCreation', build: buildFaqPage2, label: 'Story Creation' },
  { threadKey: 'cfgFaqThreadManaging',      build: buildFaqPage3, label: 'Managing a Story' },
  { threadKey: 'cfgFaqThreadWriterCmds',    build: buildFaqPage4, label: 'Writer Commands' },
  { threadKey: 'cfgFaqThreadAdminCmds',     build: buildFaqPage5, label: 'Admin Commands' },
];

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

      const content = await page.build(connection, guildId);

      // Find the bot's first message in the thread, or post a new one
      const messages = await thread.messages.fetch({ limit: 100 });
      const botMsg = messages.filter(m => m.author.id === client.user.id).last();

      if (botMsg) {
        await botMsg.edit(content);
        log(`syncFaqPosts: edited post in ${page.label} (thread ${threadId})`, { show: true });
      } else {
        await thread.send(content);
        log(`syncFaqPosts: posted new message in ${page.label} (thread ${threadId})`, { show: true });
      }
    } catch (err) {
      log(`syncFaqPosts: failed for ${page.label}: ${err?.stack ?? err}`, { show: true });
      errors++;
    }
  }

  log(`syncFaqPosts: complete for guild=${guildId} errors=${errors}`, { show: true });
  return { errors };
}
