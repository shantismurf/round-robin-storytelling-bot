// Flat, paginated entry-picker engine shared by two callers:
//   - story/_manageEntries.js (admin "Manage Entries" panel — all writers, includes deleted)
//   - story/edit.js (author picker on /story edit when no turn number is given — own entries only)
//
// Kept in its own module (not inside _manageEntries.js or edit.js) so edit.js's "Back to list"
// button can call renderEntryListPage() directly for either role without a circular import
// between edit.js and _manageEntries.js.

import { StringSelectMenuBuilder, ActionRowBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, replaceTemplateVariables } from '../utilities.js';
import { ENTRY_STATUS } from '../constants.js';

export const ENTRY_PAGE_SIZE = 25;

// Superset of config keys needed by renderEntryListPage() for either role — fetched together
// so callers only need one getConfigValue() round trip regardless of which role they're building for.
const PICKER_CFG_KEYS = [
  'lblManageEntriesEntryOption', 'lblEditMyEntryOption',
  'txtManageEntriesSelectEntry', 'txtEditMyEntriesSelect',
  'txtManageEntriesNoEntries', 'txtEditMyEntriesNone',
  'txtManageEntriesEntryPlaceholder', 'txtManageEntriesMoreEntries', 'txtManageEntriesDeletedFlag',
];

/**
 * Fetch one page of a story's entries, flat across all writers — no writer-first filter.
 *
 * @param {object} [opts]
 * @param {string|null} opts.authorUserId — when set, restricts to entries written by this user
 *   (the author picker's use case). Omit for the admin list (all writers).
 * @param {boolean} opts.includeDeleted — when true, includes DELETED entries (admin list) and
 *   counts them in turn numbering to match. When false (author list — only CONFIRMED entries
 *   are editable), turn numbering matches /story read's numbering exactly (CONFIRMED-only).
 */
export async function fetchStoryEntries(connection, storyId, offset, limit, { authorUserId = null, includeDeleted = false } = {}) {
  const statuses = includeDeleted ? [ENTRY_STATUS.CONFIRMED, ENTRY_STATUS.DELETED] : [ENTRY_STATUS.CONFIRMED];
  const statusPlaceholders = statuses.map(() => '?').join(', ');

  let sql = `
    SELECT
      se.story_entry_id,
      se.entry_status,
      LEFT(se.content, 50) AS preview,
      LENGTH(se.content) - LENGTH(REPLACE(se.content, ' ', '')) + 1 AS word_count,
      sw.discord_display_name AS writer_name,
      (
        SELECT COUNT(DISTINCT t2.turn_id)
        FROM turn t2
        JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
        JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status IN (${statusPlaceholders})
        WHERE sw2.story_id = sw.story_id AND t2.started_at <= t.started_at
      ) AS turn_number
    FROM story_entry se
    JOIN turn t ON se.turn_id = t.turn_id
    JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
    WHERE sw.story_id = ? AND se.entry_status IN (${statusPlaceholders})
  `;
  const params = [...statuses, storyId, ...statuses];

  if (authorUserId) {
    sql += ` AND sw.discord_user_id = ?`;
    params.push(authorUserId);
  }

  sql += ` ORDER BY t.started_at ASC LIMIT ? OFFSET ?`;
  params.push(limit + 1, offset); // fetch one extra to detect more pages

  const [rows] = await connection.execute(sql, params);
  return rows;
}

/**
 * Build the picker select-menu message for one page of entries.
 *
 * @param {object} cfg — config values (getEntryPickerCfg() shape, see callers)
 * @param {Array} entries — from fetchStoryEntries(), may include one extra "more" sentinel row
 * @param {boolean} hasMore
 * @param {number} offset
 * @param {'admin'|'author'} role — selects customId, label template, and prompt text
 * @param {number|string} storyId — appended to the select's customId (stateless; both handlers
 *   parse it back out rather than tracking a browse-session map — see story/_manageEntries.js
 *   and handleMyPickSelect() in story/edit.js).
 */
export function renderEntryListPage(cfg, entries, hasMore, offset, role, storyId) {
  const isAdmin = role === 'admin';
  // Discord caps a select menu at 25 options total — when there's a "more" sentinel to add,
  // real entries must leave room for it (25 entries + 1 sentinel would exceed the cap).
  const maxRealOptions = hasMore ? ENTRY_PAGE_SIZE - 1 : ENTRY_PAGE_SIZE;
  const pageEntries = entries.slice(0, maxRealOptions);
  const labelTemplate = isAdmin ? cfg.lblManageEntriesEntryOption : cfg.lblEditMyEntryOption;

  const options = pageEntries.map(e => {
    const preview = e.preview ? e.preview.replace(/\n/g, ' ') : '';
    const label = replaceTemplateVariables(labelTemplate, {
      turn_number: String(e.turn_number),
      writer_name: e.writer_name ?? '',
      word_count: String(e.word_count),
      preview,
    });
    const statusFlag = e.entry_status === ENTRY_STATUS.DELETED ? ` ${cfg.txtManageEntriesDeletedFlag}` : '';
    return {
      label: (label + statusFlag).slice(0, 100),
      value: String(e.story_entry_id)
    };
  });

  if (hasMore) {
    options.push({
      label: replaceTemplateVariables(cfg.txtManageEntriesMoreEntries, { offset: String(offset + maxRealOptions + 1) }),
      value: `__entrypage__${offset + maxRealOptions}`
    });
  }

  const customIdPrefix = isAdmin ? 'story_manage_entries_list_select_' : 'story_edit_mypick_select_';
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${customIdPrefix}${storyId}`)
    .setPlaceholder(cfg.txtManageEntriesEntryPlaceholder)
    .addOptions(options);

  return {
    content: isAdmin ? cfg.txtManageEntriesSelectEntry : cfg.txtEditMyEntriesSelect,
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral
  };
}

/**
 * Fetch + render one page of the entry picker in a single call — the combined helper both
 * callers (story/_manageEntries.js for admins, story/edit.js for authors) use for the initial
 * open, pagination, and the "Back to entries list" button, so neither has to duplicate the
 * fetch/config/render sequence or import from the other.
 *
 * @param {'admin'|'author'} role — admin sees all writers + deleted entries; author sees only
 *   their own CONFIRMED (editable) entries.
 * @param {string|null} authorUserId — required when role === 'author'.
 */
export async function buildEntryPickerMessage(connection, guildId, storyId, offset, role, authorUserId = null) {
  const isAdmin = role === 'admin';
  const [entries, cfg] = await Promise.all([
    fetchStoryEntries(connection, storyId, offset, ENTRY_PAGE_SIZE, {
      authorUserId: isAdmin ? null : authorUserId,
      includeDeleted: isAdmin,
    }),
    getConfigValue(connection, PICKER_CFG_KEYS, guildId),
  ]);

  if (entries.length === 0) {
    return { content: isAdmin ? cfg.txtManageEntriesNoEntries : cfg.txtEditMyEntriesNone, embeds: [], components: [] };
  }

  const hasMore = entries.length > ENTRY_PAGE_SIZE;
  return renderEntryListPage(cfg, entries, hasMore, offset, role, storyId);
}
