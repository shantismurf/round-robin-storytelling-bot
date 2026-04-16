import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue } from '../utilities.js';

export async function buildHelpPage1(connection, guildId) {
  const mediaChannelId = await getConfigValue(connection, 'cfgMediaChannelId', guildId);
  const mediaConfigured = mediaChannelId && mediaChannelId !== 'cfgMediaChannelId';
  const writeNormalKey = mediaConfigured ? 'txtHelp1WriteNormal' : 'txtHelp1WriteNormalNoMedia';

  const cfg = await getConfigValue(connection, [
    'txtHelp1Title', 'txtHelp1Footer', 'btnHelp1ToPage2',
    'lblHelp1FindJoin', 'txtHelp1FindJoin',
    'lblHelp1Dashboard', 'txtHelp1Dashboard',
    'lblHelp1WriteNormal', writeNormalKey,
    'lblHelp1WriteQuick', 'txtHelp1WriteQuick',
    'lblHelp1ManageParticipation', 'txtHelp1ManageParticipation'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelp1Title)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblHelp1FindJoin, value: cfg.txtHelp1FindJoin, inline: false },
      { name: cfg.lblHelp1Dashboard, value: cfg.txtHelp1Dashboard, inline: false },
      { name: cfg.lblHelp1WriteNormal, value: cfg[writeNormalKey], inline: false },
      { name: cfg.lblHelp1WriteQuick, value: cfg.txtHelp1WriteQuick, inline: false },
      { name: cfg.lblHelp1ManageParticipation, value: cfg.txtHelp1ManageParticipation, inline: false }
    )
    .setFooter({ text: cfg.txtHelp1Footer });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_help_page_2')
      .setLabel(cfg.btnHelp1ToPage2)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

export async function buildHelpPage2(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtHelp2Title', 'txtHelp2Footer',
    'btnHelp2ToPage1', 'btnHelp2ToPage3',
    'lblHelp2StoryTitle', 'txtHelp2StoryTitle',
    'lblHelp2MaxWriters', 'txtHelp2MaxWriters',
    'lblHelp2TurnLength', 'txtHelp2TurnLength',
    'lblHelp2StoryMode', 'txtHelp2StoryMode',
    'lblHelp2WriterOrder', 'txtHelp2WriterOrder',
    'lblHelp2HideThreads', 'txtHelp2HideThreads',
    'lblHelp2ShowAuthors', 'txtHelp2ShowAuthors',
    'lblHelp2TimeoutReminder', 'txtHelp2TimeoutReminder',
    'lblHelp2DelayStart', 'txtHelp2DelayStart',
    'lblHelp2CreatorOptions', 'txtHelp2CreatorOptions'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelp2Title)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblHelp2StoryTitle, value: cfg.txtHelp2StoryTitle, inline: false },
      { name: cfg.lblHelp2MaxWriters, value: cfg.txtHelp2MaxWriters, inline: true },
      { name: cfg.lblHelp2TurnLength, value: cfg.txtHelp2TurnLength, inline: true },
      { name: cfg.lblHelp2StoryMode, value: cfg.txtHelp2StoryMode, inline: false },
      { name: cfg.lblHelp2WriterOrder, value: cfg.txtHelp2WriterOrder, inline: false },
      { name: cfg.lblHelp2HideThreads, value: cfg.txtHelp2HideThreads, inline: false },
      { name: cfg.lblHelp2ShowAuthors, value: cfg.txtHelp2ShowAuthors, inline: false },
      { name: cfg.lblHelp2TimeoutReminder, value: cfg.txtHelp2TimeoutReminder, inline: false },
      { name: cfg.lblHelp2DelayStart, value: cfg.txtHelp2DelayStart, inline: false },
      { name: cfg.lblHelp2CreatorOptions, value: cfg.txtHelp2CreatorOptions, inline: false }
    )
    .setFooter({ text: cfg.txtHelp2Footer });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_help_page_1')
      .setLabel(cfg.btnHelp2ToPage1)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('story_help_page_3')
      .setLabel(cfg.btnHelp2ToPage3)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

export async function buildHelpPage3(connection, guildId) {
  const cfg = await getConfigValue(connection, [
    'txtHelp3Title', 'txtHelp3Footer', 'btnHelp3ToPage2',
    'lblHelp3WhoCanUse', 'txtHelp3WhoCanUse',
    'lblHelp3WhatEdit', 'txtHelp3WhatEdit',
    'lblHelp3PauseResume', 'txtHelp3PauseResume',
    'lblHelp3Closing', 'txtHelp3Closing',
    'lblHelp3AdminControls', 'txtHelp3AdminControls'
  ], guildId);

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelp3Title)
    .setColor(0x5865f2)
    .addFields(
      { name: cfg.lblHelp3WhoCanUse, value: cfg.txtHelp3WhoCanUse, inline: false },
      { name: cfg.lblHelp3WhatEdit, value: cfg.txtHelp3WhatEdit, inline: false },
      { name: cfg.lblHelp3PauseResume, value: cfg.txtHelp3PauseResume, inline: false },
      { name: cfg.lblHelp3Closing, value: cfg.txtHelp3Closing, inline: false },
      { name: cfg.lblHelp3AdminControls, value: cfg.txtHelp3AdminControls, inline: false }
    )
    .setFooter({ text: cfg.txtHelp3Footer });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('story_help_page_2')
      .setLabel(cfg.btnHelp3ToPage2)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

export async function handleHelp(connection, interaction) {
  await interaction.reply({ ...await buildHelpPage1(connection, interaction.guild.id), flags: MessageFlags.Ephemeral });
}

export async function handleHelpNavigation(connection, interaction) {
  await interaction.deferUpdate();
  if (interaction.customId === 'story_help_page_2') {
    await interaction.editReply(await buildHelpPage2(connection, interaction.guild.id));
  } else if (interaction.customId === 'story_help_page_3') {
    await interaction.editReply(await buildHelpPage3(connection, interaction.guild.id));
  } else {
    await interaction.editReply(await buildHelpPage1(connection, interaction.guild.id));
  }
}
