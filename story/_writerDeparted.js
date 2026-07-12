import { log } from '../utilities.js';
import { departWriter, buildSyntheticContext } from './_turn.js';

/**
 * Sweeps a user who left or was banned from a guild out of every story they're
 * actively (or paused-ly) writing in that guild, via the same departWriter core
 * used by the admin-remove and panel-leave paths — just triggered by a Discord
 * event instead of a button, and swept across every story the user was in.
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
      const { isLastWriter } = await departWriter(connection, ctx, storyId, writerId, userId);
      if (isLastWriter) {
        log(`handleWriterDeparted: story ${storyId} auto-closed — writer ${userId} left/banned from guild ${guildId}`, { show: true, guildName: ctx.guild?.name, hub: true });
      }
      log(`handleWriterDeparted: removed writer ${userId} from story ${storyId} (guild ${guildId})`, { show: true, guildName: ctx.guild?.name });
    } catch (err) {
      log(`handleWriterDeparted failed for story ${storyId} writer ${writerId}: ${err?.stack ?? err}`, { show: true, guildName: ctx.guild?.name });
    }
  }
}
