import { MessageFlags } from 'discord.js';
import { getConfigValue, log, resolveStoryId, checkIsAdmin, checkIsCreator, replaceTemplateVariables } from '../utilities.js';

export async function handlePing(connection, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, interaction.options.getInteger('story_id'));

  if (!storyId) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId) });
  }

  const [isCreator, isAdmin] = await Promise.all([
    checkIsCreator(connection, storyId, interaction.user.id),
    checkIsAdmin(connection, interaction, guildId),
  ]);

  if (!isCreator && !isAdmin) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtManageNotAuthorized', guildId) });
  }

  const [storyRows] = await connection.execute(
    `SELECT title, story_thread_id FROM story WHERE story_id = ?`, [storyId]
  );
  if (!storyRows.length || !storyRows[0].story_thread_id) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtThreadCreationFailed', guildId) });
  }

  const { title, story_thread_id } = storyRows[0];

  const [writerRows] = await connection.execute(
    `SELECT discord_user_id FROM story_writer WHERE story_id = ? AND sw_status = 1`, [storyId]
  );

  const mentions = writerRows.map(w => `<@${w.discord_user_id}>`).join(' ');
  const message = interaction.options.getString('message') ?? '';

  let thread;
  try {
    thread = await interaction.guild.channels.fetch(story_thread_id.toString());
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
