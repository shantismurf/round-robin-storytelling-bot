import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables } from '../utilities.js';
import { CreateStory } from '../storybot.js';
import { RATING_LABELS } from './metadata.js';
import { buildMetadataPanel, handleMetadataButton, handleMetadataModal, handleMetadataSelectMenu } from './addMetadata.js';

// Temporary storage for story add session state
export const pendingStoryData = new Map();

async function getPreviousAO3Name(connection, userId) {
  try {
    const [rows] = await connection.execute(
      `SELECT AO3_name FROM story_writer WHERE discord_user_id = ? AND AO3_name IS NOT NULL AND AO3_name != '' ORDER BY joined_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0]?.AO3_name ?? null;
  } catch { return null; }
}

export async function handleAddStory(connection, interaction) {
  log('handleAddStory() - initializing ephemeral story form', { show: false, guildName: interaction?.guild?.name });

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cfg = await getConfigValue(connection, [
      'txtCreateStoryTitle', 'txtStoryAddIntro', 'txtStoryTitlePrompt',
      'txtNormalModeDesc', 'txtQuickModeDesc',
      'txtHideThreadsOffDesc', 'txtHideThreadsOnDesc',
      'btnSetTitle', 'btnSetTurnLength', 'btnSetTimeout',
      'btnSetAO3Name', 'btnSetDelayHours', 'btnSetDelayWriters', 'btnCreateStory',
      'lblModeToggle', 'lblHideToggle', 'btnAddHideToggle', 'lblPrivateToggle', 'txtPrivateOffDesc', 'txtPrivateOnDesc',
      'lblStoryTitle', 'lblTurnLength', 'lblTimeoutReminder',
      'lblDelayStart', 'txtDelayHint', 'lblYourAO3Name',
      'lblNoHours', 'lblNoWriters',
      'lblWriterOrder', 'txtOrderRandom', 'txtOrderRoundRobin', 'txtOrderFixed',
      'txtOrderRandomDesc', 'txtOrderRoundRobinDesc', 'txtOrderFixedDesc',
      'lblShowAuthors', 'txtShowAuthorsOnDesc', 'txtShowAuthorsOffDesc',
      'lblMaxWriters', 'btnSetMaxWriters',
      'txtSectionBreakLine', 'txtStoryAddSectionBreakSettings', 'txtStoryAddSectionBreakMeta', 'txtStoryAddSectionBreakJoin',
      'btnSetMetadata', 'lblMyNotifications',
      'lblMetaRating', 'lblMetaWarnings', 'lblMetaFandom', 'lblMetaCategory',
    ], interaction.guild.id);

    const state = {
      cfg,
      storyTitle: null,
      quickMode: 0,
      hideThreads: 0,
      turnLength: 24,
      timeoutReminder: 50,
      ao3Name: (await getPreviousAO3Name(connection, interaction.user.id)) || interaction.member?.displayName || interaction.user.displayName,
      keepPrivate: 0,
      notifications: 1,
      delayHours: null,
      delayWriters: null,
      orderType: 1,
      showAuthors: 1,
      maxWriters: null,
      rating: 'NR',
      warnings: [],
      fandom: '',
      mainPairing: '',
      otherRelationships: '',
      characters: '',
      category: '',
      additionalTags: ''
    };

    pendingStoryData.set(interaction.user.id, {
      ...state,
      originalInteraction: interaction
    });

    await interaction.editReply(buildStoryAddMessage(cfg, state));

    log('handleAddStory() - ephemeral form sent', { show: false, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in handleAddStory: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: await getConfigValue(connection, 'txtFormOpenError', interaction.guild.id),
        flags: MessageFlags.Ephemeral
      });
    }
  }
}

export function buildStoryAddMessage(cfg, state) {
  const modeEmoji = state.quickMode ? '🟣' : '🟢';
  const modeLabel = state.quickMode ? 'Quick' : 'Normal';
  const modeDesc = state.quickMode ? cfg.txtQuickModeDesc : cfg.txtNormalModeDesc;
  const hideDesc = state.hideThreads ? cfg.txtHideThreadsOnDesc : cfg.txtHideThreadsOffDesc;
  const privateDesc = state.keepPrivate ? cfg.txtPrivateOnDesc : cfg.txtPrivateOffDesc;
  const privateLabel = state.keepPrivate ? 'Yes' : 'No';
  const showAuthorsDesc = state.showAuthors ? cfg.txtShowAuthorsOnDesc : cfg.txtShowAuthorsOffDesc;
  const timeoutDisplay = state.timeoutReminder === 0 ? 'None (0%)' : `${state.timeoutReminder}%`;
  const delayHours = state.delayHours ?? 0;
  const delayWriters = state.delayWriters ?? 0;
  const maxWritersDisplay = state.maxWriters ? String(state.maxWriters) : '∞';
  const titleDisplay = state.storyTitle || cfg.txtStoryTitlePrompt;
  const orderEmojis = { 1: '\u{1F3B2}', 2: '\u{1F504}', 3: '\u{1F4CB}' };
  const orderLabels = { 1: cfg.txtOrderRandom, 2: cfg.txtOrderRoundRobin, 3: cfg.txtOrderFixed };
  const orderDescs = { 1: cfg.txtOrderRandomDesc, 2: cfg.txtOrderRoundRobinDesc, 3: cfg.txtOrderFixedDesc };
  const orderEmoji = orderEmojis[state.orderType];
  const orderLabel = orderLabels[state.orderType];
  const orderDesc = orderDescs[state.orderType];

  const ratingLabel = RATING_LABELS[state.rating] ?? '[NR] Not Rated';
  const warningsDisplay = state.warnings?.length ? state.warnings.join(', ') : 'None set';
  const metadataSummaryLines = [
    `**${cfg.lblMetaRating ?? 'Rating'}:** ${ratingLabel}`,
    `**${cfg.lblMetaWarnings ?? 'Warnings'}:** ${warningsDisplay}`,
    state.fandom ? `**${cfg.lblMetaFandom ?? 'Fandom'}:** ${state.fandom}` : null,
    state.category ? `**${cfg.lblMetaCategory ?? 'Category'}:** ${state.category}` : null,
  ].filter(Boolean).join('\n');

  const sectionLine = cfg.txtSectionBreakLine ?? '═══════════';

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtCreateStoryTitle)
    .setDescription(cfg.txtStoryAddIntro)
    .addFields(
      { name: sectionLine, value: cfg.txtStoryAddSectionBreakSettings ?? '**⚙️ Story Settings**', inline: false },
      { name: cfg.lblStoryTitle, value: titleDisplay, inline: false },
      { name: `${modeEmoji} ${cfg.lblModeToggle}`, value: `${modeLabel} — ${modeDesc}`, inline: true },
      { name: `${orderEmoji} ${cfg.lblWriterOrder}`, value: `${orderLabel} — ${orderDesc}`, inline: true },
      { name: cfg.lblTurnLength, value: `${state.turnLength} hours`, inline: true },
      { name: cfg.lblTimeoutReminder, value: timeoutDisplay, inline: true },
      { name: cfg.lblHideToggle, value: hideDesc, inline: true },
      { name: cfg.lblShowAuthors, value: `${state.showAuthors ? 'Yes' : 'No'} — ${showAuthorsDesc}`, inline: true },
      { name: cfg.lblMaxWriters, value: maxWritersDisplay, inline: true },
      { name: cfg.lblDelayStart, value: `*${cfg.txtDelayHint}*\n${delayHours} hours / ${delayWriters} writers`, inline: true },
      { name: sectionLine, value: cfg.txtStoryAddSectionBreakMeta ?? '**Story Metadata**', inline: false },
      { name: cfg.btnSetMetadata ?? 'Story Metadata', value: metadataSummaryLines, inline: false },
      { name: sectionLine, value: cfg.txtStoryAddSectionBreakJoin ?? '**My Join Settings**', inline: false },
      { name: cfg.lblYourAO3Name, value: state.ao3Name || '*Not set*', inline: true },
      { name: cfg.lblPrivateToggle, value: `${privateLabel} — ${privateDesc}`, inline: true },
      { name: cfg.lblMyNotifications ?? 'Notifications', value: state.notifications ? 'On' : 'Off'
