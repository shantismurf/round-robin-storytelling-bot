import { getConfigValue, log, replaceTemplateVariables } from './utilities.js';
import { resolveFeedChannelId, RATING_BADGE } from './story/metadata.js';
/**
 * All announcements sent to story feed channel are handled here
 * Join is called from commands/story.js
 * Create and Activate are called from storybot.js
 * 
 * function postStoryFeedJoinAnnouncement
 * Post announcement to story feed channel when someone joins
 */
export async function postStoryFeedJoinAnnouncement(connection, storyId, interaction, storyTitle) {
    const guildId = interaction.guild.id;
    try {
      const [ratingRows] = await connection.execute(`SELECT rating FROM story WHERE story_id = ?`, [storyId]);
      const storyRating = ratingRows[0]?.rating ?? 'NR';
      const feedChannelId = await resolveFeedChannelId(connection, guildId, storyRating);
      if (!feedChannelId) {
        log('Story feed channel not configured - skipping join announcement', { show: true, guildName: interaction?.guild?.name });
        return;
      }
      
      const [turnInfo] = await connection.execute(`
        SELECT sw.discord_display_name, t.started_at, s.turn_length_hours
        FROM turn t
        JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
        JOIN story s ON sw.story_id = s.story_id
        WHERE sw.story_id = ? AND t.turn_status = 1
        ORDER BY t.started_at DESC LIMIT 1
      `, [storyId]);
      
      const joinerName = interaction.member.displayName || interaction.user.displayName || interaction.user.username;
      let announcement;

      if (turnInfo.length > 0) {
        const turn = turnInfo[0];
        const endTime = new Date(turn.started_at.getTime() + (turn.turn_length_hours * 60 * 60 * 1000));
        const txtStoryFeedJoinAnnouncement = await getConfigValue(connection, 'txtStoryFeedJoinAnnouncement', guildId);
        announcement = replaceTemplateVariables(txtStoryFeedJoinAnnouncement, {
          joiner_name: joinerName,
          story_title: storyTitle,
          current_writer: turn.discord_display_name,
          turn_end_date: `<t:${Math.floor(endTime.getTime() / 1000)}:f>`
        });
      } else {
        const txtStoryFeedJoinAnnouncementNoTurn = await getConfigValue(connection, 'txtStoryFeedJoinAnnouncementNoTurn', guildId);
        announcement = replaceTemplateVariables(txtStoryFeedJoinAnnouncementNoTurn, {
          joiner_name: joinerName,
          story_title: storyTitle
        });
      }
      
      const feedChannel = await interaction.guild.channels.fetch(feedChannelId);
      if (feedChannel) {
        await feedChannel.send(announcement);
      }
      log(`Story feed join announcement sent for story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in postStoryFeedJoinAnnouncement: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}

/**
 * function postStoryFeedCreationAnnouncement
 * Post announcement to story feed channel when a story is created
 */
export async function postStoryFeedCreationAnnouncement(connection, storyId, interaction) {
  const guildId = interaction.guild.id;
  try {
    const feedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
    if (!feedChannelId) {
      log('Story feed channel not configured - skipping creation announcement', { show: true, guildName: interaction?.guild?.name });
      return;
    }

    const [storyRows] = await connection.execute(
      `SELECT s.title, s.quick_mode, s.story_order_type, s.turn_length_hours,
              s.max_writers, s.allow_joins, s.story_delay_hours, s.story_delay_users,
              s.created_at, s.rating, COUNT(sw.story_writer_id) as writer_count
       FROM story s
       LEFT JOIN story_writer sw ON sw.story_id = s.story_id AND sw.sw_status = 1
       WHERE s.story_id = ?
       GROUP BY s.story_id`,
      [storyId]
    );
    if (storyRows.length === 0) return;
    const story = storyRows[0];

    const creatorName = interaction.member.displayName || interaction.user.displayName || interaction.user.username;

    const modeText = story.quick_mode ? 'Quick' : 'Normal';
    const orderMap = { 1: 'Random', 2: 'Round-Robin', 3: 'Fixed' };
    const orderText = orderMap[story.story_order_type] ?? 'Random';
    const writersText = `${story.writer_count}/${story.max_writers || '∞'} Writers`;
    const openText = story.allow_joins ? 'Open' : 'Closed';

    const delayParts = [];
    if (story.story_delay_hours > 0) {
      const startTime = new Date(new Date(story.created_at).getTime() + story.story_delay_hours * 60 * 60 * 1000);
      delayParts.push(`Starts <t:${Math.floor(startTime.getTime() / 1000)}:f>`);
    }
    if (story.story_delay_users > 0) {
      const needed = story.story_delay_users - story.writer_count;
      delayParts.push(`Pending until ${needed} more writer${needed === 1 ? '' : 's'} join`);
    }

    const metaParts = [
      `${modeText} Mode`,
      `${orderText} Order`,
      `${story.turn_length_hours}h Turns`,
      writersText,
      openText,
      ...delayParts
    ];

    const ratingBadge = RATING_BADGE[story.rating] ?? '[NR]';
    const message = `# 📚 New Story Created by ${creatorName}: "${story.title}" ${ratingBadge}\n-# ${metaParts.join(' · ')}`;

    const targetChannelId = await resolveFeedChannelId(connection, guildId, story.rating ?? 'NR');
    const feedChannel = await interaction.guild.channels.fetch(targetChannelId);
    if (feedChannel) await feedChannel.send(message);

    log(`Story feed creation announcement sent for story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in postStoryFeedCreationAnnouncement: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}

/**
 * function postStoryFeedClosedAnnouncement
 * Post congratulatory announcement when a story is closed
 */
export async function postStoryFeedClosedAnnouncement(connection, interaction, storyTitle, turnCount, wordCount, writerCount, exportResult = null) {
  const guildId = interaction.guild.id;
  try {
    const feedChannelId = await getConfigValue(connection, 'cfgStoryFeedChannelId', guildId);
    if (!feedChannelId) {
      log('Story feed channel not configured - skipping closed announcement', { show: true, guildName: interaction?.guild?.name });
      return;
    }
    const txtStoryFeedClosed = await getConfigValue(connection, 'txtStoryFeedClosed', guildId);
    const announcement = replaceTemplateVariables(txtStoryFeedClosed, {
      story_title: storyTitle,
      turn_count: turnCount,
      word_count: wordCount.toLocaleString(),
      writer_count: writerCount
    });
    const feedChannel = await interaction.guild.channels.fetch(feedChannelId);
    if (feedChannel) {
      const messageOptions = { content: announcement };
      if (exportResult?.hasEntries) messageOptions.files = [{ attachment: exportResult.buffer, name: exportResult.filename }];
      await feedChannel.send(messageOptions);
    }
    log('Story feed closed announcement sent', { show: true, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in postStoryFeedClosedAnnouncement: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}

/**
 * function postStoryFeedActivationAnnouncement
 * Post announcement to story feed channel when a story becomes active
 */
export async function postStoryFeedActivationAnnouncement(connection, storyId, interaction, storyTitle) {
    const guildId = interaction.guild.id;
    try {
      const [ratingRows] = await connection.execute(`SELECT rating FROM story WHERE story_id = ?`, [storyId]);
      const storyRating = ratingRows[0]?.rating ?? 'NR';
      const feedChannelId = await resolveFeedChannelId(connection, guildId, storyRating);
      if (!feedChannelId) {
        log('Story feed channel not configured - skipping activation announcement', { show: true, guildName: interaction?.guild?.name });
        return;
      }
      
      // Get active writer and turn end time
      const [turnInfo] = await connection.execute(`
        SELECT sw.discord_display_name, t.started_at, s.turn_length_hours
        FROM turn t
        JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
        JOIN story s ON sw.story_id = s.story_id
        WHERE sw.story_id = ? AND t.turn_status = 1
        ORDER BY t.started_at DESC LIMIT 1
      `, [storyId]);
      
      if (turnInfo.length > 0) {
        const turn = turnInfo[0];
        const endTime = new Date(turn.started_at.getTime() + (turn.turn_length_hours * 60 * 60 * 1000));
        
        const txtStoryFeedNowActive = await getConfigValue(connection,'txtStoryFeedNowActive', guildId);
        const announcement = replaceTemplateVariables(txtStoryFeedNowActive, {
          story_title: storyTitle,
          first_writer: turn.discord_display_name,
          turn_end_date: `<t:${Math.floor(endTime.getTime() / 1000)}:f>`
        });
        
        const feedChannel = await interaction.guild.channels.fetch(feedChannelId);
        if (feedChannel) {
          await feedChannel.send(announcement);
        }
      }
      log(`Story feed activation announcement sent for story ${storyId}`, { show: true, guildName: interaction?.guild?.name });
  } catch (error) {
    log(`Error in postStoryFeedActivationAnnouncement: ${error}`, { show: true, guildName: interaction?.guild?.name });
  }
}