import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, resolveStoryId } from '../utilities.js';

export async function handleTimeleft(connection, interaction) {
  log(`handleTimeleft entry user=${interaction.user.id} story=${interaction.options.getString('story_id')}`, { show: false, guildName: interaction?.guild?.name });
  const guildId = interaction.guild.id;
  const storyId = await resolveStoryId(connection, guildId, parseInt(interaction.options.getString('story_id') ?? '', 10));
  if (!storyId) {
    return interaction.reply({ content: await getConfigValue(connection, 'txtStoryNotFound', guildId), flags: MessageFlags.Ephemeral });
  }

  const [rows] = await connection.execute(
    `SELECT s.title, s.guild_story_id, s.show_authors, s.story_thread_id, s.mode,
            sw.discord_display_name AS writer_name, sw.discord_user_id,
            t.turn_id, t.turn_ends_at, t.more_time_requested
     FROM story s
     JOIN story_writer sw ON sw.story_id = s.story_id
     JOIN turn t ON t.story_writer_id = sw.story_writer_id
     WHERE s.story_id = ? AND s.guild_id = ? AND t.turn_status = 1
     LIMIT 1`,
    [storyId, guildId]
  );

  if (!rows.length) {
    return interaction.reply({ content: await getConfigValue(connection, 'txtTimeleftNoActiveTurn', guildId), flags: MessageFlags.Ephemeral });
  }
  const turn = rows[0];

  // Check for admin-designated next writer
  const [nextRows] = await connection.execute(
    `SELECT sw.discord_display_name FROM story s
     JOIN story_writer sw ON sw.story_writer_id = s.next_writer_id
     WHERE s.story_id = ? AND s.next_writer_id IS NOT NULL`,
    [storyId]
  );
  const nextWriter = nextRows[0]?.discord_display_name ?? null;

  const isSlowMode = turn.mode === 2;
  const timeleftCfg = await getConfigValue(connection, [
    'lblTimeleftStory', 'lblTimeleftCurrentWriter', 'lblTimeleftTurnEnds', 'lblTimeleftUpNext',
    'txtTimeleftAuthorsHidden', 'txtTimeleftSlowMode',
  ], guildId);

  const turnEndsValue = isSlowMode
    ? timeleftCfg.txtTimeleftSlowMode
    : (() => {
        const unixTs = Math.floor(new Date(turn.turn_ends_at).getTime() / 1000);
        return `<t:${unixTs}:F> (<t:${unixTs}:R>)`;
      })();

  const embed = new EmbedBuilder()
    .setTitle(turn.title)
    .addFields(
      { name: timeleftCfg.lblTimeleftStory, value: `#${turn.guild_story_id}`, inline: true },
      { name: timeleftCfg.lblTimeleftCurrentWriter, value: turn.show_authors ? turn.writer_name : timeleftCfg.txtTimeleftAuthorsHidden, inline: true },
      { name: timeleftCfg.lblTimeleftTurnEnds, value: turnEndsValue, inline: false }
    );
  if (nextWriter) embed.addFields({ name: timeleftCfg.lblTimeleftUpNext, value: nextWriter, inline: true });

  const isCurrentWriter = interaction.user.id === String(turn.discord_user_id);
  const btnLabel = await getConfigValue(connection, 'btnRequestMoreTime', guildId);
  const requestBtn = new ButtonBuilder()
    .setCustomId(`story_request_more_time_${storyId}`)
    .setLabel(btnLabel)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!isCurrentWriter || !!turn.more_time_requested || isSlowMode);
  const row = new ActionRowBuilder().addComponents(requestBtn);

  try {
    await interaction.reply({ embeds: [embed], components: [row] });
  } catch {
    // No posting permission in this channel — fall back to ephemeral
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  }
}

export async function handleRequestMoreTime(connection, interaction) {
  log(`handleRequestMoreTime entry user=${interaction.user.id} customId=${interaction.customId}`, { show: false, guildName: interaction?.guild?.name });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const storyId = parseInt(interaction.customId.split('_').at(-1));
  const guildId = interaction.guild.id;

  const [rows] = await connection.execute(
    `SELECT sw.discord_user_id, t.turn_id, t.more_time_requested, s.title, s.story_thread_id
     FROM story s
     JOIN story_writer sw ON sw.story_id = s.story_id
     JOIN turn t ON t.story_writer_id = sw.story_writer_id
     WHERE s.story_id = ? AND s.guild_id = ? AND t.turn_status = 1
     LIMIT 1`,
    [storyId, guildId]
  );

  if (!rows.length) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtTimeleftNoActiveTurn', guildId) });
  }
  const turn = rows[0];

  if (interaction.user.id !== String(turn.discord_user_id)) {
    log(`handleRequestMoreTime: not current writer user=${interaction.user.id} story=${storyId}`, { show: false, guildName: interaction?.guild?.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'txtRequestMoreTimeNotYourTurn', guildId) });
  }
  if (turn.more_time_requested) {
    return interaction.editReply({ content: await getConfigValue(connection, 'txtRequestMoreTimeAlreadyUsed', guildId) });
  }

  // Look up admin role for the mention
  const adminRoleName = await getConfigValue(connection, 'cfgAdminRoleName', guildId);
  let adminMention = adminRoleName ? `@${adminRoleName}` : '';
  if (adminRoleName) {
    const role = interaction.guild.roles.cache.find(r => r.name === adminRoleName);
    if (role) adminMention = `<@&${role.id}>`;
  }

  const txtPost = (await getConfigValue(connection, 'txtRequestMoreTimePost', guildId))
    .replace('[writer_name]', interaction.member.displayName)
    .replace('[story_title]', turn.title)
    .replace('[admin_role]', adminMention);

  try {
    const thread = await interaction.guild.channels.fetch(String(turn.story_thread_id));
    await thread.send(txtPost);
  } catch (err) {
    log(`handleRequestMoreTime: could not post to story thread: ${err}`, { show: true, guildName: interaction.guild.name });
    return interaction.editReply({ content: await getConfigValue(connection, 'errProcessingRequest', guildId) });
  }

  await connection.execute(`UPDATE turn SET more_time_requested = 1 WHERE turn_id = ?`, [turn.turn_id]);

  // Disable the button on the original timeleft message
  try {
    const disabledBtnLabel = await getConfigValue(connection, 'btnRequestMoreTime', guildId);
    const disabledBtn = new ButtonBuilder()
      .setCustomId(`story_request_more_time_${storyId}`)
      .setLabel(disabledBtnLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    await interaction.message.edit({ components: [new ActionRowBuilder().addComponents(disabledBtn)] });
  } catch (err) {
    log(`handleRequestMoreTime: could not disable button (message likely expired): ${err}`, { show: false, guildName: interaction?.guild?.name });
  }

  await interaction.editReply({ content: await getConfigValue(connection, 'txtRequestMoreTimeUsed', guildId) });
}
