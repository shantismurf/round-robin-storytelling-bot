/**
 * The in-Discord help reader: `/story help`, `/mystory help`, `/storyadmin help` and the controls
 * under a page.
 *
 * Split out of faq.js 2026-10-04, when adding page navigation pushed that file to 580 lines
 * against the repo's 500-line standard. The division is by consumer, not by size: faq.js owns the
 * help *content* -- the page definitions, the renderer and the Hub FAQ forum sync -- and this file
 * owns the one consumer that is interactive. The forum sync posts a static thread per page and
 * must never acquire these controls, which is the clearest sign the two belong apart.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { getConfigValue, getSetupRequiredMessage, log, replaceTemplateVariables } from './utilities.js';
import { EMBED_COLOR, PAGE_DEFS, buildPage, buildPageEmbed, pageById, stripLeadingEmoji } from './faq.js';

// Everything the controls under a page need, folded into the page's own config fetch rather than
// read separately -- getConfigValue is one query per call with no cache, so a second round trip per
// page view would buy nothing. btnPrev/btnNext are the same labels the story list paginates with.
const NAV_KEYS = Object.freeze(['txtHelpTocFooter', 'btnPrev', 'btnNext', ...PAGE_DEFS.map(p => p.titleKey)]);

/**
 * The control rows that sit under the help content: the contents menu, then Prev/Next.
 *
 * `currentId` is the page being shown, or null on the contents page itself -- which is how the
 * contents page ends up with the menu alone. The buttons only mean something once you are on a
 * page, and "Next" from a table of contents has no obvious destination.
 *
 * Rebuilt on every view rather than patched, because an edit replaces a message's component rows
 * wholesale. The current page is marked selected so the menu doubles as a position indicator --
 * with Prev/Next driving the embed, it is otherwise the only thing that says where you are.
 */
export function buildHelpControls(cfg, currentId = null) {
  const rows = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('story_help_toc')
      .setPlaceholder(cfg.txtHelpTocFooter)
      .addOptions(PAGE_DEFS.map(p =>
        new StringSelectMenuOptionBuilder()
          .setLabel(stripLeadingEmoji(cfg[p.titleKey]))
          .setValue(p.id)
          .setDefault(p.id === currentId)
      ))
  )];

  const at = PAGE_DEFS.findIndex(p => p.id === currentId);
  if (at === -1) return rows;

  // A disabled button still needs a valid customId, so the ends point at the current page; they
  // cannot be clicked, and if a client ever let one through it would simply redraw the same page.
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`story_help_page_${PAGE_DEFS[at - 1]?.id ?? currentId}`)
      .setLabel(cfg.btnPrev)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(at === 0),
    new ButtonBuilder()
      .setCustomId(`story_help_page_${PAGE_DEFS[at + 1]?.id ?? currentId}`)
      .setLabel(cfg.btnNext)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(at === PAGE_DEFS.length - 1)
  ));
  return rows;
}

// One page plus its controls. Every interactive path renders a page through here, so a page opened
// from the contents menu, from Prev/Next, or straight from /mystory help carries the same controls
// -- the two jump commands used to land on a page with none at all, a dead end.
export async function buildPageView(connection, guildId, pageDef) {
  const { content, cfg } = await buildPage(connection, guildId, pageDef, { extraKeys: NAV_KEYS });
  return {
    embeds: [buildPageEmbed(pageDef, cfg, content)],
    components: buildHelpControls(cfg, pageDef.id),
  };
}

async function buildTocEmbed(connection, guildId) {
  const cfg = await getConfigValue(
    connection,
    ['txtHelpTocTitle', 'txtHelpTocIntro', 'txtHelpTocFooter', 'cfgHubInviteUrl', ...PAGE_DEFS.map(p => p.titleKey)],
    guildId
  );

  const embed = new EmbedBuilder()
    .setTitle(cfg.txtHelpTocTitle)
    .setDescription(replaceTemplateVariables(cfg.txtHelpTocIntro, { hubInviteUrl: cfg.cfgHubInviteUrl }))
    .setColor(EMBED_COLOR);

  return { embeds: [embed], components: buildHelpControls(cfg) };
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

/**
 * Swap the help message to `pageId` in place. deferUpdate, not deferReply: selecting a page used to
 * post a *new* ephemeral message, which is why the reader ended up with a stack of them and why a
 * page never carried controls -- it was never the message the menu lived on. Editing the one
 * message is what makes the content appear to reload in the same embed.
 */
async function showHelpPage(connection, interaction, pageId) {
  await interaction.deferUpdate();
  const guildId = interaction.guild.id;
  try {
    // An unknown id means the controls were built by an older deploy and the reader is asking for
    // a page that no longer exists -- say so rather than throwing. The controls are left alone so
    // they can pick something else; only the page body goes.
    const pageDef = PAGE_DEFS.find(p => p.id === pageId);
    if (!pageDef) {
      log(`showHelpPage: no page with id "${pageId}" -- stale controls`, { show: true, guildName: interaction?.guild?.name });
      return await interaction.editReply({ content: await getConfigValue(connection, 'txtHelpPageGone', guildId), embeds: [] });
    }
    // Cleared because the first view may carry the "set me up first" notice as content, and
    // in-place editing would otherwise pin it above every page the reader opens.
    await interaction.editReply({ content: '', ...await buildPageView(connection, guildId, pageDef) });
  } catch (err) {
    log(`showHelpPage failed for user=${interaction.user.username} page=${pageId}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

export async function handleHelpSelect(connection, interaction) {
  log(`handleHelpSelect entry user=${interaction.user.username} value=${interaction.values[0]}`, { show: false, guildName: interaction?.guild?.name });
  await showHelpPage(connection, interaction, interaction.values[0]);
}

// story_help_page_<id> -- the id is the page the button lands on, resolved when the row was built,
// so the handler needs no notion of direction or position.
export async function handleHelpNav(connection, interaction) {
  const pageId = interaction.customId.replace('story_help_page_', '');
  log(`handleHelpNav entry user=${interaction.user.username} page=${pageId}`, { show: false, guildName: interaction?.guild?.name });
  await showHelpPage(connection, interaction, pageId);
}

// ---------------------------------------------------------------------------
// /mystory help — jumps to the writer command reference
// ---------------------------------------------------------------------------

export async function handleWriterHelp(connection, interaction) {
  log(`handleWriterHelp entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const pageDef = pageById('writer-commands');
    const setupMessage = await getSetupRequiredMessage(connection, interaction);
    await interaction.editReply({
      ...(setupMessage ? { content: setupMessage } : {}),
      ...await buildPageView(connection, interaction.guild.id, pageDef),
    });
  } catch (err) {
    log(`handleWriterHelp failed for user=${interaction.user.username}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}

// ---------------------------------------------------------------------------
// /storyadmin help — jumps to the first admin page
// ---------------------------------------------------------------------------

export async function handleAdminHelp(connection, interaction, guildId) {
  log(`handleAdminHelp entry user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  try {
    const pageDef = pageById('admin-server-setup');
    const setupMessage = await getSetupRequiredMessage(connection, interaction);
    await interaction.reply({
      ...(setupMessage ? { content: setupMessage } : {}),
      ...await buildPageView(connection, guildId, pageDef),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log(`handleAdminHelp failed for user=${interaction.user.username}: ${err?.stack ?? err}`, { show: true, guildName: interaction?.guild?.name });
  }
}
