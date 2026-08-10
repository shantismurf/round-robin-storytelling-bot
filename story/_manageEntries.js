// Admin "Manage Entries" panel (/story manage → Manage Entries). A thin picker over the shared
// entry-list engine (story/_manageEntriesList.js) that hands off directly into the Story Edit
// session engine (story/edit.js) once an entry is picked — all viewing/paging/history/delete/
// restore logic lives there so it isn't duplicated here. See docs/plans/PLAN-manage-entries-consolidation.md.

import { log } from '../utilities.js';
import { buildEntryPickerMessage } from './_manageEntriesList.js';
import { openEditSession } from './edit.js';

// customId scheme: story_manage_entries_open (button, unchanged from before) opens the list;
// story_manage_entries_list_select_<storyId> (select menu) pages through it or picks an entry.
// storyId travels in the select's customId rather than a session map — stateless, matching the
// pattern already used elsewhere in this codebase for IDs threaded through interactions.

export async function handleManageEntriesButton(connection, interaction, manageState) {
  const storyId = manageState.storyId;
  log(`handleManageEntriesButton entry storyId=${storyId} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  const msg = await buildEntryPickerMessage(connection, interaction.guild.id, storyId, 0, 'admin');
  await interaction.reply(msg);
}

export async function handleManageEntriesSelectMenu(connection, interaction) {
  const storyId = parseInt(interaction.customId.replace('story_manage_entries_list_select_', ''), 10);
  const guildId = interaction.guild.id;
  const selected = interaction.values[0];
  log(`handleManageEntriesSelectMenu entry storyId=${storyId} selected=${selected} user=${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });

  if (selected.startsWith('__entrypage__')) {
    const newOffset = parseInt(selected.replace('__entrypage__', ''), 10);
    const msg = await buildEntryPickerMessage(connection, guildId, storyId, newOffset, 'admin');
    await interaction.update(msg);
    return;
  }

  const entryId = parseInt(selected, 10);
  log(`handleManageEntriesSelectMenu: entry ${entryId} selected by ${interaction.user.username}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferUpdate();
  await openEditSession(connection, interaction, guildId, storyId, null, entryId, {
    allowDeleted: true,
    manageMode: true,
    pickerContext: { role: 'admin', listOffset: 0, storyId },
  });
}
