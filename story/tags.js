import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { getConfigValue, log, sanitizeModalInput, checkIsAdmin } from '../utilities.js';

/**
 * Button: "Suggest a Tag" — opens a modal for active writers to submit a tag.
 * customId: story_submit_tag (must carry story ID in a separate location —
 * stored in the button's customId as story_submit_tag_<storyId>).
 */
export async function handleTagSubmit(connection, interaction) {
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;

  // Only active writers in this story can submit
  const [writerRows] = await connection.execute(
    `SELECT story_writer_id FROM story_writer WHERE story_id = ? AND discord_user_id = ? AND sw_status = 1`,
    [storyId, userId]
  );
  if (writerRows.length === 0) {
    await interaction.reply({ content: await getConfigValue(connection, 'txtTagSubmitNotWriter', guildId), flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`story_tag_submit_modal_${storyId}`)
    .setTitle(await getConfigValue(connection, 'txtTagSubmitModalTitle', guildId));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('tag_text')
        .setLabel(await getConfigValue(connection, 'lblTagSubmitText', guildId))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200)
        .setPlaceholder(await getConfigValue(connection, 'txtTagSubmitPlaceholder', guildId))
    )
  );

  await interaction.showModal(modal);
}

export async function handleTagSubmitModalSubmit(connection, interaction) {
  // customId: story_tag_submit_modal_<storyId>
  const storyId = interaction.customId.split('_').at(-1);
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;
  const displayName = interaction.member?.displayName ?? interaction.user.username;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tagText = sanitizeModalInput(interaction.fields.getTextInputValue('tag_text'), 200);
  if (!tagText) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagSubmitPlaceholder', guildId) });
    return;
  }

  // Check for duplicate pending submission
  const [existing] = await connection.execute(
    `SELECT submission_id FROM story_tag_submission
     WHERE story_id = ? AND tag_text = ? AND submission_status = 'pending'`,
    [storyId, tagText]
  );
  if (existing.length > 0) {
    await interaction.editReply({ content: await getConfigValue(connection, 'txtTagSubmitDuplicate', guildId) });
    return;
  }

  await connection.execute(
    `INSERT INTO story_tag_submission (story_id, submitter_user_id, submitter_display_name, tag_text)
     VALUES (?, ?, ?, ?)`,
    [storyId, userId, displayName, tagText]
  );

  log(`Tag "${tagText}" submitted for story ${storyId} by ${displayName}`, { show: false });
  await interaction.editReply({ content: await getConfigValue(connection, 'txtTagSubmitSuccess', guildId) });
}
