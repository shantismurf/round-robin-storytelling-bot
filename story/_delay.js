import { getConfigValue, log } from '../utilities.js';
import { STORY_STATUS, WRITER_STATUS } from '../constants.js';

/**
 * Checks whether a delayed story's activation conditions are met and activates it.
 * Called from StoryJoin (on writer join) and job-runner (on hour-delay expiry).
 */
export async function checkStoryDelay(connection, storyId) {
  log(`checkStoryDelay: entry storyId=${storyId}`, { show: false });
  try {
    const [storyRows] = await connection.execute(
      `SELECT story_status, story_delay_hours, story_delay_users, created_at, turn_length_hours, guild_id
       FROM story WHERE story_id = ?`,
      [storyId]
    );

    if (storyRows.length === 0) {
      return { madeActive: false };
    }

    const story = storyRows[0];
    let shouldActivate = false;
    let writerDelayMessage = '';
    let hourDelayMessage = '';

    // Check writer count delay
    if (story.story_delay_users && story.story_status !== STORY_STATUS.ACTIVE) {
      const [writerCount] = await connection.execute(
        `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = ?`,
        [storyId, WRITER_STATUS.ACTIVE]
      );

      const currentWriters = writerCount[0].count;

      if (currentWriters >= story.story_delay_users) {
        shouldActivate = true;
      } else {
        const needed = story.story_delay_users - currentWriters;
        const txtMoreWritersDelay = await getConfigValue(connection, 'txtMoreWritersDelay', story.guild_id);
        writerDelayMessage = txtMoreWritersDelay.replace('X', needed);
      }
    }

    // Check hour delay
    if (story.story_delay_hours && story.story_status !== STORY_STATUS.ACTIVE) {
      const delayEndTime = new Date(story.created_at.getTime() + (story.story_delay_hours * 60 * 60 * 1000));

      if (Date.now() >= delayEndTime.getTime()) {
        shouldActivate = true;
      } else {
        const hoursLeft = Math.ceil((delayEndTime.getTime() - Date.now()) / (1000 * 60 * 60));
        const txtHoursDelay = await getConfigValue(connection, 'txtHoursDelay', story.guild_id);
        hourDelayMessage = txtHoursDelay.replace('X', hoursLeft);
      }
    }

    // Activate story if conditions met
    if (shouldActivate && story.story_status === STORY_STATUS.DELAYED) {
      await connection.execute(
        `UPDATE story SET story_status = ? WHERE story_id = ?`,
        [STORY_STATUS.ACTIVE, storyId]
      );
      return { madeActive: true };
    }

    return {
      madeActive: false,
      writerDelayMessage,
      hourDelayMessage
    };

  } catch (error) {
    log(`checkStoryDelay failed for story ${storyId}: ${error}`, { show: true });
    return { madeActive: false };
  }
}
