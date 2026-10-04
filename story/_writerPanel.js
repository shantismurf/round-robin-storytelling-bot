/**
 * The writer-settings panel, shared by `/mystory manage` (a writer editing their own settings)
 * and `/storyadmin user` (an admin editing someone else's).
 *
 * LeeAnn, 2026-10-04: "storyadmin user needs to be brought in line with the rest of the app."
 * Both panels stage the same three settings behind the same Save — pen name, notification mode,
 * turn thread privacy — but the admin one was still a four-field embed with its buttons in three
 * rows below, which is the exact layout the writer's panel moved away from: `inline: true` is a
 * hint the client may ignore, and on a narrow screen the fields stack into eight lines of label
 * over value with nothing tying a button to the field it edits.
 *
 * What differs between the two is only the labels, the customId prefix and the row of actions at
 * the bottom, so those live in MODES below and everything else is built once. The two panels
 * deliberately keep their own customIds, so index.js's routing is untouched.
 */
import { ContainerBuilder, TextDisplayBuilder, SectionBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { replaceTemplateVariables } from '../utilities.js';
import { WRITER_STATUS } from '../constants.js';

const MODES = {
  self: {
    titleKey: 'txtMyStoryManageTitle',
    noteKey: 'txtMyStoryManagePanelDesc',
    statusLabelKey: 'lblMyStoryManageStatus',
    penNameLabelKey: 'lblMyStoryManagePenName',
    notifLabelKey: 'lblMyStoryManageNotif',
    privacyLabelKey: 'lblMyStoryManagePrivacy',
    saveLabelKey: 'btnMyStoryManageSave',
    ids: {
      penName: 'mystory_manage_penname',
      notif: 'mystory_manage_notif',
      privacy: 'mystory_manage_privacy',
      save: 'mystory_manage_save',
    },
  },
  admin: {
    titleKey: 'txtManageUserPanelTitle',
    noteKey: 'txtManageUserPanelSaveNote',
    statusLabelKey: 'lblManageUserStatus',
    penNameLabelKey: 'lblManageUserPenName',
    notifLabelKey: 'lblAdminMUNotif',
    privacyLabelKey: 'lblAdminMUPrivacy',
    saveLabelKey: 'btnAdminMUSave',
    ids: {
      penName: 'storyadmin_mu_penname',
      notif: 'storyadmin_mu_toggle_notif',
      privacy: 'storyadmin_mu_toggle_privacy',
      save: 'storyadmin_mu_save',
    },
  },
};

/**
 * The row under Save. Separated from the staged-settings cluster above because Save commits the
 * three fields while these act immediately.
 *
 * Danger is reserved for what cannot be taken back — passing spends the turn without submitting,
 * leaving is final, removing a writer is final. Pause/Resume is Secondary in both modes: it is
 * reversible in both directions and shares one button slot, so colouring it would make Resume
 * read as destructive too (LeeAnn set this rule on the writer's panel 2026-10-02, and confirmed
 * it for the admin panel 2026-10-04, where Pause was Danger and Unpause Success).
 */
function buildActionRow(state, cfg, mode) {
  const isActive = state.writerStatus === WRITER_STATUS.ACTIVE;

  if (mode === 'admin') {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(isActive ? 'storyadmin_mu_pause' : 'storyadmin_mu_unpause')
        .setLabel(isActive ? cfg.btnAdminMUPause : cfg.btnAdminMUUnpause)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('storyadmin_mu_remove')
        .setLabel(cfg.btnAdminMURemove)
        .setStyle(ButtonStyle.Danger)
    );
  }

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mystory_manage_pass')
      .setLabel(cfg.btnMyStoryManagePass)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!state.hasActiveTurn),
    new ButtonBuilder()
      .setCustomId(isActive ? 'mystory_manage_pause' : 'mystory_manage_resume')
      .setLabel(isActive ? cfg.btnMyStoryManagePause : cfg.btnMyStoryManageResume)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mystory_manage_leave')
      .setLabel(cfg.btnMyStoryManageLeave)
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * @param {object} state  panel session state — writerStatus, penName, notificationPrefs,
 *   writerTurnPrivacy, storyTitle, and (admin mode) writerName, (self mode) hasActiveTurn.
 * @param {object} cfg    must carry every key named in MODES for the mode requested, plus the
 *   shared status/value/toggle-label keys.
 * @param {'self'|'admin'} mode
 */
export function buildWriterPanel(state, cfg, mode = 'self') {
  const m = MODES[mode];
  if (!m) throw new Error(`buildWriterPanel: unknown mode "${mode}"`);

  const statusLabel = state.writerStatus === WRITER_STATUS.ACTIVE
    ? cfg.txtMyStoryManageActiveStatus
    : cfg.txtMyStoryManagePausedStatus;
  const notifToggleLabel   = state.notificationPrefs === 'dm' ? cfg.btnManageUserSwitchMention : cfg.btnManageUserSwitchDM;
  const privacyToggleLabel = state.writerTurnPrivacy ? cfg.btnManageUserMakePublic : cfg.btnManageUserMakePrivate;

  const container = new ContainerBuilder().setAccentColor(0x5865F2);

  // The admin template carries [writer_name] as well as [story_title]; the writer's carries only
  // the latter, and an unused map entry is simply ignored.
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `# ${replaceTemplateVariables(cfg[m.titleKey], { story_title: state.storyTitle, writer_name: state.writerName })}`
  ));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cfg[m.noteKey]));
  container.addSeparatorComponents(new SeparatorBuilder());

  // Status is a plain line, not a section: the three below each sit beside the button that edits
  // them, and Pause/Resume does not belong in that group — it acts immediately, while these three
  // are staged until Save.
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `**${cfg[m.statusLabelKey]}:** ${statusLabel}`
  ));

  // Section = text on the left, the button that edits it on the right. Primary on all three
  // because they DO something — open the pen-name modal, flip the notification mode, flip turn
  // privacy. Save stays Success and the irreversible actions stay Danger, so blue here reads
  // unambiguously as "change this setting".
  for (const [label, value, customId, buttonLabel] of [
    [cfg[m.penNameLabelKey],  state.penName || cfg.txtNotSet,                                                 m.ids.penName, cfg.btnAdminMUPenName],
    [cfg[m.notifLabelKey],    state.notificationPrefs === 'dm' ? cfg.txtNotifDM : cfg.txtNotifMention,         m.ids.notif,   notifToggleLabel],
    [cfg[m.privacyLabelKey],  state.writerTurnPrivacy ? cfg.txtPrivate : cfg.txtPublic,                       m.ids.privacy, privacyToggleLabel],
  ]) {
    container.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${label}:** ${value}`))
      .setButtonAccessory(new ButtonBuilder().setCustomId(customId).setLabel(buttonLabel).setStyle(ButtonStyle.Primary))
    );
  }

  // No panel-level Close or Cancel in either mode (LeeAnn, 2026-10-02 for the writer's panel and
  // 2026-10-04 for the admin's): both panels are ephemeral, so Discord's own "Dismiss message"
  // already does it with less to read. Staged edits live in the pending-session map and are
  // simply never committed; the next invocation overwrites that entry. Cancel still earns its
  // place on the confirm prompts, where it means "go back to the panel" rather than "close".
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(m.ids.save).setLabel(cfg[m.saveLabelKey]).setStyle(ButtonStyle.Success)
  ));

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addActionRowComponents(buildActionRow(state, cfg, mode));

  // At most 22 nodes counting every nested child (container, 3 top-level text displays, 3
  // separators, 3 sections each holding a text display and a button accessory, 2 action rows, up
  // to 4 buttons) against Discord's documented 40 ceiling. See the component-budget note in
  // docs/reference/discordjs_reference.md for why this is counted the conservative way.
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
