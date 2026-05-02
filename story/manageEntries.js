import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, replaceTemplateVariables } from '../utilities.js';

// Keyed by userId — holds state for the in-progress entry browse session
const pendingEntryData = new Map();

const WRITER_PAGE_SIZE = 25;
const ENTRY_PAGE_SIZE = 25;

async function getEntryCfg(connection, guildId) {
  return await getConfigValue(connection, [
    'txtManageEntriesSelectWriter', 'txtManageEntriesFilterModal', 'lblManageEntriesFilterField',
    'txtManageEntriesFilterPlaceholder', 'txtManageEntriesNoWriters', 'txtManageEntriesNoMatch',
    'txtManageEntriesSelectEntry', 'txtManageEntriesNoEntries',
    'txtManageEntriesPreviewTitle', 'txtManageEntriesPreviewFooter',
    'btnManageEntriesDelete', 'btnManageEntriesRestore', 'btnManageEntriesBack', 'btnCancel',
    'txtManageEntryDeleteSuccess', 'txtManageEntryRestoreSuccess',
    'txtManageEntryAlreadyDeleted', 'txtManageEntryAlreadyConfirmed',
    'txtActionSessionExpired', 'errProcessingRequest', 'txtUnknownWriter',
  ], guildId);
}

async function fetchContributingWriters(connection, storyId, nameFragment = null, offset = 0) {
  let sql = `
    SELECT DISTINCT sw.story_writer_id, sw.discord_display_name
    FROM story_writer sw
    JOIN turn t ON t.story_writer_id = sw.story_writer_id
    JOIN story_entry se ON se.turn_id = t.turn_id
    WHERE sw.story_id = ? AND se.entry_status IN ('confirmed', 'deleted')
  `;
  const params = [storyId];
  if (nameFragment) {
    sql += ` AND sw.discord_display_name LIKE ?`;
    params.push(`%${nameFragment}%`);
  }
  sql += ` ORDER BY sw.discord_display_name ASC LIMIT ? OFFSET ?`;
  params.push(WRITER_PAGE_SIZE + 1, offset); // fetch one extra to detect more pages
  const [rows] = await connection.execute(sql, params);
  return rows;
}

async function fetchWriterEntries(connection, storyId, storyWriterId, offset = 0) {
  const [rows] = await connection.execute(`
    SELECT
      se.story_entry_id,
      se.entry_status,
      LEFT(se.content, 50) AS preview,
      LENGTH(se.content) - LENGTH(REPLACE(se.content, ' ', '')) + 1 AS word_count,
      (
        SELECT COUNT(DISTINCT t2.turn_id)
        FROM turn t2
        JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
        JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status IN ('confirmed', 'deleted')
        WHERE sw2.story_id = ? AND t2.started_at <= t.started_at
      ) AS turn_number
    FROM story_entry se
    JOIN turn t ON se.turn_id = t.turn_id
    WHERE t.story_writer_id = ? AND se.entry_status IN ('confirmed', 'deleted')
    ORDER BY t.started_at ASC
    LIMIT ? OFFSET ?
  `, [storyId, storyWriterId, ENTRY_PAGE_SIZE + 1, offset]);
  return rows;
}

function buildWriterSelectMessage(cfg, writers, hasMore, prompt, filterFragment = null, writerOffset = 0) {
  const pageWriters = writers.slice(0, WRITER_PAGE_SIZE);
  const options = pageWriters.map(w => ({
    label: w.discord_display_name.slice(0, 100),
    value: String(w.story_writer_id)
  }));

  if (hasMore) {
    const nextOffset = writerOffset + WRITER_PAGE_SIZE;
    const fragment = filterFragment ? filterFragment : '';
    options.push({
      label: `More writers (${nextOffset + 1}+)...`,
      value: `__page__${nextOffset}__${fragment}`
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('story_manage_entries_writer_select')
    .setPlaceholder('Select a writer...')
    .addOptions(options);

  return {
    content: prompt ?? cfg.txtManageEntriesSelectWriter,
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral
  };
}

function buildEntrySelectMessage(cfg, entries, writerName, hasMore, entryOffset = 0) {
  const pageEntries = entries.slice(0, ENTRY_PAGE_SIZE);
  const options = pageEntries.map(e => {
    const preview = e.preview ? e.preview.replace(/\n/g, ' ') : '';
    const label = `Turn ${e.turn_number} — ${e.word_count} words — ${preview}`.slice(0, 100);
    const statusFlag = e.entry_status === 'deleted' ? ' [DELETED]' : '';
    return {
      label: (label + statusFlag).slice(0, 100),
      value: String(e.story_entry_id)
    };
  });

  if (hasMore) {
    options.push({
      label: `More entries (${entryOffset + ENTRY_PAGE_SIZE + 1}+)...`,
      value: `__entrypage__${entryOffset + ENTRY_PAGE_SIZE}`
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('story_manage_entries_entry_select')
    .setPlaceholder('Select an entry...')
    .addOptions(options);

  return {
    content: cfg.txtManageEntriesSelectEntry,
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral
  };
}

export async function handleManageEntriesButton(connection, interaction, manageState) {
  const customId = interaction.customId;
  const userId = interaction.user.id;
  const storyId = manageState.storyId;
  log(`handleManageEntriesButton: customId=${customId} storyId=${storyId} user=${userId}`, { show: false, guildName: interaction?.guild?.name });

  const cfg = await getEntryCfg(connection, interaction.guild.id);

  if (customId === 'story_manage_entries_open') {
    const writers = await fetchContributingWriters(connection, storyId);
    if (writers.length === 0) {
      log(`No writers found with entries for story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.reply({ content: cfg.txtManageEntriesNoWriters, flags: MessageFlags.Ephemeral });
      return;
    }

    pendingEntryData.set(userId, { storyId, guildId: interaction.guild.id, storyTitle: manageState.title });

    if (writers.length > WRITER_PAGE_SIZE) {
      // Show filter modal
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('story_manage_entries_filter_modal')
          .setTitle(cfg.txtManageEntriesFilterModal)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name_fragment')
              .setLabel(cfg.lblManageEntriesFilterField)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(cfg.txtManageEntriesFilterPlaceholder)
          ))
      );
    } else {
      await interaction.reply(buildWriterSelectMessage(cfg, writers, false, null));
    }

  } else if (customId === 'story_manage_entries_back') {
    const pending = pendingEntryData.get(userId);
    if (!pending) {
      log(`Session expired for user ${userId}, customId=${customId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.update({ content: cfg.txtActionSessionExpired, components: [] });
      return;
    }
    const writers = await fetchContributingWriters(connection, pending.storyId, pending.filterFragment ?? null, pending.writerOffset ?? 0);
    const hasMore = writers.length > WRITER_PAGE_SIZE;
    await interaction.update(buildWriterSelectMessage(cfg, writers, hasMore, null, pending.filterFragment, pending.writerOffset ?? 0));
  }
}

export async function handleManageEntriesModal(connection, interaction) {
  const customId = interaction.customId;
  const userId = interaction.user.id;
  log(`handleManageEntriesModal: customId=${customId} user=${userId}`, { show: false, guildName: interaction?.guild?.name });

  const pending = pendingEntryData.get(userId);
  if (!pending) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), flags: MessageFlags.Ephemeral });
    return;
  }

  const cfg = await getEntryCfg(connection, interaction.guild.id);

  if (customId === 'story_manage_entries_filter_modal') {
    const fragment = sanitizeModalInput(interaction.fields.getTextInputValue('name_fragment'), 100) || null;
    pending.filterFragment = fragment;
    pending.writerOffset = 0;

    const writers = await fetchContributingWriters(connection, pending.storyId, fragment, 0);
    if (writers.length === 0) {
      log(`No writers matched filter "${fragment}" for story ${pending.storyId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.reply({ content: cfg.txtManageEntriesNoMatch, flags: MessageFlags.Ephemeral });
      return;
    }
    const hasMore = writers.length > WRITER_PAGE_SIZE;
    await interaction.reply(buildWriterSelectMessage(cfg, writers, hasMore, null, fragment, 0));
  }
}

export async function handleManageEntriesSelectMenu(connection, interaction) {
  const customId = interaction.customId;
  const userId = interaction.user.id;
  log(`handleManageEntriesSelectMenu: customId=${customId} user=${userId}`, { show: false, guildName: interaction?.guild?.name });

  const pending = pendingEntryData.get(userId);
  if (!pending) {
    log(`Session expired for user ${userId}, customId=${customId}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.update({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), components: [] });
    return;
  }

  const cfg = await getEntryCfg(connection, interaction.guild.id);

  if (customId === 'story_manage_entries_writer_select') {
    const selected = interaction.values[0];

    // Handle pagination sentinel
    if (selected.startsWith('__page__')) {
      const parts = selected.split('__');
      const newOffset = parseInt(parts[2]);
      const fragment = parts[3] || null;
      pending.writerOffset = newOffset;
      pending.filterFragment = fragment;

      const writers = await fetchContributingWriters(connection, pending.storyId, fragment, newOffset);
      if (writers.length === 0) {
        log(`No more writers found for story ${pending.storyId} with fragment "${fragment}" at offset ${newOffset}`, { show: true, guildName: interaction?.guild?.name });
        await interaction.update({ content: cfg.txtManageEntriesNoMatch, components: [] });
        return;
      }
      const hasMore = writers.length > WRITER_PAGE_SIZE;
      await interaction.update(buildWriterSelectMessage(cfg, writers, hasMore, null, fragment, newOffset));
      return;
    }

    const storyWriterId = parseInt(selected);
    log(`Writer selected: ${storyWriterId} by user ${userId}`, { show: false, guildName: interaction?.guild?.name });
    const [[writerRow]] = await connection.execute(
      `SELECT discord_display_name FROM story_writer WHERE story_writer_id = ?`,
      [storyWriterId]
    );
    pending.selectedWriterId = storyWriterId;
    pending.selectedWriterName = writerRow?.discord_display_name ?? cfg.txtUnknownWriter;
    pending.entryOffset = 0;

    const entries = await fetchWriterEntries(connection, pending.storyId, storyWriterId, 0);
    if (entries.length === 0) {
      log(`No entries found for writer ${storyWriterId} in story ${pending.storyId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.update({ content: cfg.txtManageEntriesNoEntries, components: [] });
      return;
    }
    const hasMore = entries.length > ENTRY_PAGE_SIZE;
    await interaction.update(buildEntrySelectMessage(cfg, entries, pending.selectedWriterName, hasMore, 0));

  } else if (customId === 'story_manage_entries_entry_select') {
    const selected = interaction.values[0];

    // Handle entry pagination sentinel
    if (selected.startsWith('__entrypage__')) {
      const newOffset = parseInt(selected.replace('__entrypage__', ''));
      pending.entryOffset = newOffset;
      const entries = await fetchWriterEntries(connection, pending.storyId, pending.selectedWriterId, newOffset);
      if (entries.length === 0) {
        log(`No more entries found for writer ${pending.selectedWriterId} at offset ${newOffset}`, { show: true, guildName: interaction?.guild?.name });
        await interaction.update({ content: cfg.txtManageEntriesNoEntries, components: [] });
        return;
      }
      const hasMore = entries.length > ENTRY_PAGE_SIZE;
      await interaction.update(buildEntrySelectMessage(cfg, entries, pending.selectedWriterName, hasMore, newOffset));
      return;
    }

    const entryId = parseInt(selected);
    log(`Entry selected: ${entryId} by user ${userId}`, { show: false, guildName: interaction?.guild?.name });
    const [[entry]] = await connection.execute(
      `SELECT se.story_entry_id, se.entry_status, se.content,
              LENGTH(se.content) - LENGTH(REPLACE(se.content, ' ', '')) + 1 AS word_count,
              (
                SELECT COUNT(DISTINCT t2.turn_id)
                FROM turn t2
                JOIN story_writer sw2 ON t2.story_writer_id = sw2.story_writer_id
                JOIN story_entry se2 ON se2.turn_id = t2.turn_id AND se2.entry_status IN ('confirmed','deleted')
                WHERE sw2.story_id = ? AND t2.started_at <= t.started_at
              ) AS turn_number
       FROM story_entry se
       JOIN turn t ON se.turn_id = t.turn_id
       WHERE se.story_entry_id = ?`,
      [pending.storyId, entryId]
    );

    if (!entry) {
      log(`Entry not found: ${entryId}`, { show: true, guildName: interaction?.guild?.name });
      await interaction.update({ content: cfg.errProcessingRequest, components: [] });
      return;
    }

    pending.selectedEntryId = entryId;
    pending.selectedEntryStatus = entry.entry_status;

    const contentPreview = entry.content.length > 800
      ? entry.content.slice(0, 800) + '\n\n*...entry continues*'
      : entry.content;

    const footerText = replaceTemplateVariables(
      cfg.txtManageEntriesPreviewFooter,
      { entry_id: entryId, status: entry.entry_status, word_count: entry.word_count }
    );

    const embed = new EmbedBuilder()
      .setTitle(replaceTemplateVariables(
        cfg.txtManageEntriesPreviewTitle,
        { turn_number: entry.turn_number, writer_name: pending.selectedWriterName }
      ))
      .setDescription(contentPreview)
      .setFooter({ text: footerText })
      .setColor(entry.entry_status === 'deleted' ? 0xff6b6b : 0x57F287);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('story_manage_entries_delete')
        .setLabel(cfg.btnManageEntriesDelete)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(entry.entry_status === 'deleted'),
      new ButtonBuilder()
        .setCustomId('story_manage_entries_restore')
        .setLabel(cfg.btnManageEntriesRestore)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(entry.entry_status === 'confirmed'),
      new ButtonBuilder()
        .setCustomId('story_manage_entries_back')
        .setLabel(cfg.btnManageEntriesBack)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [row] });
  }
}

export async function handleManageEntriesActionButton(connection, interaction) {
  const customId = interaction.customId;
  const userId = interaction.user.id;
  log(`handleManageEntriesActionButton: customId=${customId} user=${userId}`, { show: false, guildName: interaction?.guild?.name });

  const pending = pendingEntryData.get(userId);
  if (!pending) {
    await interaction.update({ content: await getConfigValue(connection, 'txtActionSessionExpired', interaction.guild.id), components: [] });
    return;
  }

  const cfg = await getEntryCfg(connection, interaction.guild.id);
  const entryId = pending.selectedEntryId;

  try {
    if (customId === 'story_manage_entries_delete') {
      const [[current]] = await connection.execute(
        `SELECT entry_status FROM story_entry WHERE story_entry_id = ?`, [entryId]
      );
      if (!current || current.entry_status === 'deleted') {
        await interaction.update({ content: cfg.txtManageEntryAlreadyDeleted, embeds: [], components: [] });
        return;
      }
      await connection.execute(`UPDATE story_entry SET entry_status = 'deleted' WHERE story_entry_id = ?`, [entryId]);
      log(`Entry deleted: ${entryId}`, { show: true, guildName: interaction?.guild?.name });
      pendingEntryData.delete(userId);
      await interaction.update({
        content: replaceTemplateVariables(cfg.txtManageEntryDeleteSuccess, { entry_id: entryId }),
        embeds: [],
        components: []
      });

    } else if (customId === 'story_manage_entries_restore') {
      const [[current]] = await connection.execute(
        `SELECT entry_status FROM story_entry WHERE story_entry_id = ?`, [entryId]
      );
      if (!current || current.entry_status === 'confirmed') {
        await interaction.update({ content: cfg.txtManageEntryAlreadyConfirmed, embeds: [], components: [] });
        return;
      }
      await connection.execute(`UPDATE story_entry SET entry_status = 'confirmed' WHERE story_entry_id = ?`, [entryId]);
      log(`Entry restored: ${entryId} for writer ${pending.selectedWriterName}`, { show: true, guildName: interaction?.guild?.name });
      pendingEntryData.delete(userId);
      await interaction.update({
        content: replaceTemplateVariables(cfg.txtManageEntryRestoreSuccess, { writer_name: pending.selectedWriterName }),
        embeds: [],
        components: []
      });
    }
  } catch (error) {
    log(`handleManageEntriesActionButton failed for entry ${entryId}: ${error?.stack ?? error}`, { show: true, guildName: interaction?.guild?.name });
    await interaction.update({ content: cfg.errProcessingRequest, embeds: [], components: [] });
  }
}

export { pendingEntryData };
