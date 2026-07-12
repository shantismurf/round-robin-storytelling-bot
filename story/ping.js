import { MessageFlags } from 'discord.js';
import { getConfigValue, log, resolveStoryId, checkIsAdmin, checkIsCreator, replaceTemplateVariables } from '../utilities.js';
import { getActiveThreadId } from '../storybot.js';
import { WRITER_STATUS } from '../constants.js';

export async function handlePing(connection, interaction) {
  log(`handlePing entry user=${interaction.user.username} story=${interaction.options.getString('story_id')}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getString('story_id'));

  if (!storyId) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  const [isCreator, isAdmin] = await Promise.all([
    checkIsCreator(connection, storyId, interaction.user.id),
    checkIsAdmin(connection, interaction, guildId),
  ]);

  if (!isCreator && !isAdmin) {
    log(`handlePing: unauthorized user=${interaction.user.username} story=${storyId}`, { show: false, guildName: interaction?.guild?.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'txtManageNotAuthorized', guildId) });
  }

  const [storyRows] = await connection.execute(
    `SELECT title, story_thread_id, restricted_thread_id, rating FROM story WHERE story_id = ?`, [storyId]
  );
  const activeThreadId = storyRows.length ? getActiveThreadId(storyRows[0]) : null;
  if (!activeThreadId) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtThreadCreationFailed', guildId) });
  }

  const { title } = storyRows[0];

  const includePaused = interaction.options.getBoolean('include_paused') ?? false;
  const [writerRows] = await connection.execute(
    `SELECT discord_user_id FROM story_writer WHERE story_id = ? AND sw_status ${includePaused ? 'IN (?, ?)' : '= ?'}`,
    includePaused ? [storyId, WRITER_STATUS.ACTIVE, WRITER_STATUS.PAUSED] : [storyId, WRITER_STATUS.ACTIVE]
  );

  const mentions = writerRows.map(w => `<@${w.discord_user_id}>`).join(' ');
  const message = interaction.options.getString('message') ?? '';

  let thread;
  try {
    thread = await interaction.guild.channels.fetch(activeThreadId.toString());
  } catch (err) {
    log(`handlePing: could not fetch story thread: ${err}`, { show: true, guildName: interaction.guild.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  try {
    if (message) {
      const template = await getConfigValue(connection, 'txtPingWriters', guildId);
      await thread.send(replaceTemplateVariables(template, { story_title: title, mentions, message }));
    } else {
      await thread.send(mentions);
    }
  } catch (err) {
    log(`handlePing: could not post to story thread: ${err}`, { show: true, guildName: interaction.guild.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  await interaction.editReply({ content: await getConfigValue(connection, 'txtPingWritersSent', guildId) });
}
