import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeConnection } from './_fakeConnection.js';
import { fetchStoryEntries, renderEntryListPage, buildEntryPickerMessage, ENTRY_PAGE_SIZE } from '../story/_manageEntriesList.js';
import { ENTRY_STATUS } from '../constants.js';

const CFG = {
  lblManageEntriesEntryOption: 'Turn [turn_number] — [writer_name] — [word_count] words — [preview]',
  lblEditMyEntryOption: 'Turn [turn_number] — [word_count] words — [preview]',
  txtManageEntriesSelectEntry: 'Select an entry to manage:',
  txtEditMyEntriesSelect: 'Select an entry to edit:',
  txtManageEntriesNoEntries: 'No entries found for this story.',
  txtEditMyEntriesNone: 'You have no editable entries in this story yet.',
  txtManageEntriesEntryPlaceholder: 'Select an entry...',
  txtManageEntriesMoreEntries: 'More entries ([offset]+)...',
  txtManageEntriesDeletedFlag: '[DELETED]',
};

function makeEntry(overrides = {}) {
  return {
    story_entry_id: 1,
    entry_status: ENTRY_STATUS.CONFIRMED,
    preview: 'Once upon a time',
    word_count: 42,
    writer_name: 'Alice',
    turn_number: 3,
    ...overrides,
  };
}

// Pull the serialized select-menu component out of a built message ({content, components}).
function selectJSON(msg) {
  return msg.components[0].components[0].toJSON();
}

describe('fetchStoryEntries', () => {
  test('admin call (includeDeleted, no author filter): status set appears in both subquery and outer WHERE, no author param', async () => {
    const conn = makeFakeConnection([[]]);
    await fetchStoryEntries(conn, 55, 0, ENTRY_PAGE_SIZE, { includeDeleted: true });
    assert.equal(conn.calls.length, 1);
    assert.deepEqual(conn.calls[0].params, [
      ENTRY_STATUS.CONFIRMED, ENTRY_STATUS.DELETED, // subquery placeholders
      55, // storyId
      ENTRY_STATUS.CONFIRMED, ENTRY_STATUS.DELETED, // outer WHERE
      ENTRY_PAGE_SIZE + 1, 0, // limit+1, offset
    ]);
    assert.match(conn.calls[0].sql, /LIMIT \? OFFSET \?/);
  });

  test('author call (authorUserId set, includeDeleted false): only CONFIRMED, author filter appended', async () => {
    const conn = makeFakeConnection([[]]);
    await fetchStoryEntries(conn, 55, 25, ENTRY_PAGE_SIZE, { authorUserId: 'discord123', includeDeleted: false });
    assert.deepEqual(conn.calls[0].params, [
      ENTRY_STATUS.CONFIRMED, // subquery placeholder
      55, // storyId
      ENTRY_STATUS.CONFIRMED, // outer WHERE
      'discord123', // author filter
      ENTRY_PAGE_SIZE + 1, 25, // limit+1, offset
    ]);
    assert.match(conn.calls[0].sql, /AND sw\.discord_user_id = \?/);
  });

  test('passes rows straight through unmodified', async () => {
    const rows = [makeEntry(), makeEntry({ story_entry_id: 2 })];
    const conn = makeFakeConnection([rows]);
    const result = await fetchStoryEntries(conn, 1, 0, ENTRY_PAGE_SIZE);
    assert.equal(result, rows);
  });
});

describe('renderEntryListPage', () => {
  test('admin role: label includes writer name, customId carries storyId, prompt is the admin text', () => {
    const msg = renderEntryListPage(CFG, [makeEntry()], false, 0, 'admin', 42);
    const select = selectJSON(msg);
    assert.equal(select.custom_id, 'story_manage_entries_list_select_42');
    assert.equal(msg.content, CFG.txtManageEntriesSelectEntry);
    assert.equal(select.options[0].label, 'Turn 3 — Alice — 42 words — Once upon a time');
  });

  test('author role: label omits writer name, customId carries storyId, prompt is the author text', () => {
    const msg = renderEntryListPage(CFG, [makeEntry()], false, 0, 'author', 42);
    const select = selectJSON(msg);
    assert.equal(select.custom_id, 'story_edit_mypick_select_42');
    assert.equal(msg.content, CFG.txtEditMyEntriesSelect);
    assert.equal(select.options[0].label, 'Turn 3 — 42 words — Once upon a time');
  });

  test('appends the deleted flag suffix only for DELETED entries', () => {
    const msg = renderEntryListPage(CFG, [makeEntry({ entry_status: ENTRY_STATUS.DELETED })], false, 0, 'admin', 1);
    assert.match(selectJSON(msg).options[0].label, /\[DELETED\]$/);
  });

  test('adds a "more" pagination sentinel option only when hasMore is true', () => {
    const withMore = selectJSON(renderEntryListPage(CFG, [makeEntry()], true, 0, 'admin', 1));
    assert.equal(withMore.options.length, 2);
    assert.equal(withMore.options[1].value, `__entrypage__${ENTRY_PAGE_SIZE - 1}`);

    const withoutMore = selectJSON(renderEntryListPage(CFG, [makeEntry()], false, 0, 'admin', 1));
    assert.equal(withoutMore.options.length, 1);
  });

  test('when hasMore, caps real entries at ENTRY_PAGE_SIZE - 1 so the sentinel still fits under Discord\'s 25-option limit', () => {
    const entries = Array.from({ length: ENTRY_PAGE_SIZE + 1 }, (_, i) => makeEntry({ story_entry_id: i + 1 }));
    const msg = selectJSON(renderEntryListPage(CFG, entries, true, 0, 'admin', 1));
    assert.equal(msg.options.length, ENTRY_PAGE_SIZE); // ENTRY_PAGE_SIZE - 1 real + 1 sentinel
    assert.equal(msg.options.at(-1).value, `__entrypage__${ENTRY_PAGE_SIZE - 1}`);
  });

  test('without hasMore, shows up to the full ENTRY_PAGE_SIZE with no sentinel', () => {
    const entries = Array.from({ length: ENTRY_PAGE_SIZE }, (_, i) => makeEntry({ story_entry_id: i + 1 }));
    const msg = selectJSON(renderEntryListPage(CFG, entries, false, 0, 'admin', 1));
    assert.equal(msg.options.length, ENTRY_PAGE_SIZE);
  });
});

describe('buildEntryPickerMessage', () => {
  test('admin role: fetches with includeDeleted and no author filter, renders the admin list', async () => {
    const conn = makeFakeConnection([[makeEntry()], [
      { config_key: 'lblManageEntriesEntryOption', config_value: CFG.lblManageEntriesEntryOption, guild_id: 1 },
      { config_key: 'txtManageEntriesSelectEntry', config_value: CFG.txtManageEntriesSelectEntry, guild_id: 1 },
      { config_key: 'txtManageEntriesEntryPlaceholder', config_value: CFG.txtManageEntriesEntryPlaceholder, guild_id: 1 },
      { config_key: 'txtManageEntriesMoreEntries', config_value: CFG.txtManageEntriesMoreEntries, guild_id: 1 },
      { config_key: 'txtManageEntriesDeletedFlag', config_value: CFG.txtManageEntriesDeletedFlag, guild_id: 1 },
    ]]);
    const msg = await buildEntryPickerMessage(conn, 1, 99, 0, 'admin');
    assert.equal(conn.calls[0].params.includes(ENTRY_STATUS.DELETED), true);
    assert.equal(selectJSON(msg).custom_id, 'story_manage_entries_list_select_99');
  });

  test('empty result set returns the role-appropriate "no entries" message with no components', async () => {
    const conn = makeFakeConnection([[], [
      { config_key: 'txtEditMyEntriesNone', config_value: CFG.txtEditMyEntriesNone, guild_id: 1 },
    ]]);
    const msg = await buildEntryPickerMessage(conn, 1, 99, 0, 'author', 'discord123');
    assert.equal(msg.content, CFG.txtEditMyEntriesNone);
    assert.deepEqual(msg.components, []);
  });
});
