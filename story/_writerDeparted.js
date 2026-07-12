import { log } from '../utilities.js';
import { PickNextWriter, NextTurn, deleteThreadAndAnnouncement, endTurnGuarded, buildSyntheticContext } from './_turn.js';

/**
 * Sweeps a user who left or was banned from a guild out of every story they're
 * actively (or paused-ly) writing in that guild. Mirrors handlePanelLeaveConfirm's
 * voluntary-leave protocol exactly (same queries, same silence — no activity-log
 * post) rather than the admin-kick path, just triggered by a Discord event instead
 * of a button and swept across every story the user was in for the guild.
 *
 * Safe to call twice for the same user/guild (Discord fires both GuildBanAdd and
 * GuildMemberRemove for a ban) — the second call's SELECT finds nothing once
 * sw_status has already been flipped to 0 by the first.
 */
export async function handleWriterDeparted(connection, client, guildId, userId) {
  log(`handleWriterDeparted: entry guildId=${guildId} userId=${userId}`, { show: false });

  const [writerRows] = await connection.execute(
    `SELECT sw.story_writer_id, sw.story_id
     FROM story_writer sw
     JOIN story s ON sw.story_id = s.story_id
     WHERE sw.discord_user_id = ? AND s.guild_id = ? AND sw.sw_status IN (1, 2) AND s.story_status IN (1, 2, 4)`,
    [userId, guildId]
  );
  if (writerRows.length === 0) return;

  let ctx;
  try {
    ctx = await buildSyntheticContext(client, guildId);
  } catch (err) {
    log(`handleWriterDeparted: could not fetch guild ${guildId}: ${err}`, { show: true });
    return;
  }

  for (const { story_writer_id: writerId, story_id: storyId } of writerRows) {
    try {
      const [activeTurnRows] = await connection.execute(
        `SELECT turn_id, thread_id FROM turn WHERE story_writer_id = ? AND turn_status = 1`,
        [writerId]
      );
      const [remainingRows] = await connection.execute(
        `SELECT COUNT(*) as count FROM story_writer WHERE story_id = ? AND sw_status = 1 AND story_writer_id != ?`,
        [storyId, writerId]
      );
      const isLastWriter = remainingRows[0].count === 0;

      let turnEnded = false;
      if (activeTurnRows.length > 0) {
        const { turn_id: turnId, thread_id: threadId } = activeTurnRows[0];
        turnEnded = await endTurnGuarded(connection, turnId);
        if (turnEnded && threadId) {
          try {
            const thread = await ctx.guild.channels.fetch(threadId);
            if (thread) await deleteThreadAndAnnouncement(thread);
          } catch (err) {
            log(`handleWriterDeparted: failed to delete thread for story ${storyId}: ${err}`, { show: true, guildName: ctx.guild?.name });
          }
        }
      }

      await connection.execute(`UPDATE story_writer SET sw_status = 0, left_at = NOW() WHERE story_writer_id = ?`, [writerId]);

      if (isLastWriter) {
        await connection.execute(`UPDATE story SET story_status = 3, closed_at = NOW() WHERE story_id = ?`, [storyId]);
        log(`handleWriterDeparted: story ${storyId} auto-closed — writer ${userId} left/banned from guild ${guildId}`, { show: true, guildName: ctx.guild?.name, hub: true });
      } else if (turnEnded) {
        const nextWriterId = await PickNextWriter(connection, storyId);
        if (nextWriterId) await NextTurn(connection, ctx, nextWriterId);
      }

      log(`handleWriterDeparted: removed writer ${userId} from story ${storyId} (guild ${guildId})`, { show: true, guildName: ctx.guild?.name });
    } catch (err) {
      log(`handleWriterDeparted failed for story ${storyId} writer ${writerId}: ${err?.stack ?? err}`, { show: true, guildName: ctx.guild?.name });
    }
  }
}
