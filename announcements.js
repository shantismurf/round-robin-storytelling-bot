import { getConfigValue, formattedDate, replaceTemplateVariables } from './utilities.js';
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
      const feedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guildId);
      if (!feedChannelId) {
        console.log(`${formattedDate()}: Story feed channel not configured - skipping join announcement`);
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
      
      let currentWriter = 'Unknown';
      let turnEndDate = 'Unknown';
      
      if (turnInfo.length > 0) {
        const turn = turnInfo[0];
        currentWriter = turn.discord_display_name;
        const endTime = new Date(turn.started_at.getTime() + (turn.turn_length_hours * 60 * 60 * 1000));
        turnEndDate = `<t:${Math.floor(endTime.getTime() / 1000)}:f>`;
      }
      
      const txtStoryFeedJoinAnnouncement = await getConfigValue(connection,'txtStoryFeedJoinAnnouncement', guildId);
      const joinerName = interaction.member.displayName || interaction.user.displayName || interaction.user.username;
      
      const announcement = replaceTemplateVariables(txtStoryFeedJoinAnnouncement, {
        joiner_name: joinerName,
        story_title: storyTitle,
        current_writer: currentWriter,
        turn_end_date: turnEndDate
      });
      
      const feedChannel = await interaction.guild.channels.fetch(feedChannelId);
      if (feedChannel) {
        await feedChannel.send(announcement);
      }
      console.log(`${formattedDate()}: Story feed join announcement sent for story ${storyId}`);
  } catch (error) {
    console.error(`${formattedDate()}: Error in postStoryFeedJoinAnnouncement:`, error);
  }
}

/**
 * function postStoryFeedCreationAnnouncement
 * Post announcement to story feed channel when a story is created
 */
export async function postStoryFeedCreationAnnouncement(connection, storyId, interaction, storyTitle, storyStatus, delayHours, delayWriters) {
    const guildId = interaction.guild.id;
    try {
      const feedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guildId);
      if (!feedChannelId) {
        console.log(`${formattedDate()}: Story feed channel not configured - skipping creation announcement`);
        return;
      }
      
      const creatorName = interaction.member.displayName || interaction.user.displayName || interaction.user.username;
      let announcement;
      
      if (storyStatus === 1) {
        // Story is immediately active
        const [writerCount] = await connection.execute(`
          SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1
        `, [storyId]);
        
        const txtStoryFeedCreatedActive = await getConfigValue(connection,'txtStoryFeedCreatedActive', guildId);
        announcement = replaceTemplateVariables(txtStoryFeedCreatedActive, {
          story_title: storyTitle,
          creator_name: creatorName,
          writer_count: writerCount[0].count
        });
      } else if (delayHours) {
        // Story delayed by time
        const startTime = new Date(Date.now() + (delayHours * 60 * 60 * 1000));
        const txtStoryFeedCreatedDelayed = await getConfigValue(connection,'txtStoryFeedCreatedDelayed', guildId);
        announcement = replaceTemplateVariables(txtStoryFeedCreatedDelayed, {
          story_title: storyTitle,
          creator_name: creatorName,
          start_time: `<t:${Math.floor(startTime.getTime() / 1000)}:f>`
        });
      } else if (delayWriters) {
        // Story delayed by writer count
        const txtStoryFeedCreatedPending = await getConfigValue(connection,'txtStoryFeedCreatedPending', guildId);
        announcement = replaceTemplateVariables(txtStoryFeedCreatedPending, {
          story_title: storyTitle,
          creator_name: creatorName,
          writers_needed: delayWriters - 1 // -1 because creator is already added
        });
      }
      
      if (announcement) {
        const feedChannel = await interaction.guild.channels.fetch(feedChannelId);
        if (feedChannel) {
          await feedChannel.send(announcement);
        }
      }
      
      console.log(`${formattedDate()}: Story feed creation announcement sent for story ${storyId}`);
  } catch (error) {
    console.error(`${formattedDate()}: Error in postStoryFeedCreationAnnouncement:`, error);
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
      console.log(`${formattedDate()}: Story feed channel not configured - skipping closed announcement`);
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
    console.log(`${formattedDate()}: Story feed closed announcement sent`);
  } catch (error) {
    console.error(`${formattedDate()}: Error in postStoryFeedClosedAnnouncement:`, error);
  }
}

/**
 * function postStoryFeedActivationAnnouncement
 * Post announcement to story feed channel when a story becomes active
 */
export async function postStoryFeedActivationAnnouncement(connection, storyId, interaction, storyTitle) {
    const guildId = interaction.guild.id;
    try {
      const feedChannelId = await getConfigValue(connection,'cfgStoryFeedChannelId', guildId);
      if (!feedChannelId) {
        console.log(`${formattedDate()}: Story feed channel not configured - skipping activation announcement`);
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
      console.log(`${formattedDate()}: Story feed activation announcement sent for story ${storyId}`);
  } catch (error) {
    console.error(`${formattedDate()}: Error in postStoryFeedActivationAnnouncement:`, error);
  }
}