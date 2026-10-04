// story/manage.js's Save Settings handler, extracted to keep manage.js closer to the 500-line
// CLAUDE.md standard (already tracked as a split candidate in docs/TODO.md's file-size-split
// entry — this is the "save logic alone is substantial" piece named there). Writes every
// STAGED_FIELDS value to the DB in one UPDATE, handles the rating-barrier thread migration, and
// posts the Ground Rules change notification (docs/plans/PLAN-panel-rework-and-ground-rules.md
// Part 2) when a save actually changed the story's selection.
import { EmbedBuilder } from 'discord.js';
import { getConfigValue, log, replaceTemplateVariables, discordTimestamp } from '../utilities.js';
import { updateStoryStatusMessage } from './_storyStatus.js';
import { migrateStoryThread } from './_migration.js';
import { crossesBarrier, isRestricted, isRestrictedChannelConfigured } from './_metadata.js';
import { resolveGroundRules, buildGroundRulesEmbed } from './_groundRules.js';
import { postStoryThreadActivity } from './_turn.js';
import { finalMessage } from './_metadataModals.js';
import { pendingManageData } from './manage.js';

export async function handleManageSave(connection, interaction, state) {
  const guildId = interaction.guild.id;
  try {
    const warningsStr = Array.isArray(state.warnings) ? state.warnings.join(', ') : (state.warnings || null);
    log(`handleManageSave: storyId=${state.storyId} title=${state.title} mode=${state.storyMode} rating=${state.rating} originalRating=${state.originalRating}`, { show: false, guildName: state.guildName });

    // allow_joins is deliberately not written here — Close/Open Joins applies immediately from
    // its toggle button (story_manage_toggle_latejoins), same as Pause/Resume/Close/Reopen, not
    // staged behind this Save. See manage.js's STAGED_FIELDS comment for why.
    const groundRulesStr = Array.isArray(state.groundRules) ? state.groundRules.join(',') : (state.groundRules || null);
    await connection.execute(
      `UPDATE story SET
         title = ?, mode = ?, turn_length_hours = ?, reminder_timing = ?, max_writers = ?,
         show_authors = ?, story_order_type = ?, story_turn_privacy = ?,
         rating = ?, warnings = ?, main_pairing = ?, other_relationships = ?,
         characters = ?, dynamic = ?, tags = ?, summary = ?, scene_break_divider = ?, ground_rules = ?
       WHERE story_id = ?`,
      [
        state.title,
        state.storyMode, state.turnLength, state.timeoutReminder, state.maxWriters ?? null,
        state.showAuthors, state.orderType, state.storyTurnPrivacy,
        state.rating, warningsStr || null,
        state.mainPairing || null, state.otherRelationships || null,
        state.characters || null, state.dynamic || null, state.tags || null,
        state.summary || null, state.sceneBreakDivider || null, groundRulesStr || null,
        state.storyId
      ]
    );
    log(`handleManageSave: story fields written for storyId=${state.storyId}`, { show: true, guildName: state.guildName });

    // Ground Rules change notification — story-level only; editing the server's master
    // vocabulary in /storyadmin setup never triggers a thread post. Compares against the
    // dirty-check baseline (state.originalFields), order-independent since a re-selected set in
    // a different order isn't a real change.
    const originalGroundRules = state.originalFields?.groundRules ?? [];
    const groundRulesChanged = JSON.stringify([...(state.groundRules ?? [])].sort()) !== JSON.stringify([...originalGroundRules].sort());
    if (groundRulesChanged) {
      // Same builder as the status post and the join panel, so a reader sees the rules in the
      // one shape everywhere. The notice's own lead line goes in as the intro; when nothing is
      // selected there is no rules block to show, so that string stands alone.
      const currentRules = resolveGroundRules(groundRulesStr, state.groundRulesVocabulary ?? []);
      const noticeEmbed = currentRules.length
        ? buildGroundRulesEmbed(state.cfg, currentRules, { intro: state.cfg.txtGroundRulesChangedNotice, color: 0x57F287 })
        : new EmbedBuilder().setTitle(state.cfg.lblMetaGroundRules).setDescription(state.cfg.txtGroundRulesChangedNoticeNone).setColor(0x57F287);
      postStoryThreadActivity(connection, interaction.guild, state.storyId, { embeds: [noticeEmbed] }).catch(() => {});
    }

    // story_status is deliberately not written here — Pause/Resume applies immediately from the
    // toggle button (story_manage_toggle_pauseresume → handleTogglePauseResume), same as Close and
    // Reopen, not staged behind this Save. See manage.js's STAGED_FIELDS comment for why.

    // Skip migration only when moving INTO restricted with no restricted channel configured
    // (policy: story stays in the main feed, rating is informational-only). Moving back OUT
    // of restricted should always proceed normally — that direction can't create a redundant
    // thread since it's returning to the story's existing main-feed thread.
    const skipMigration = isRestricted(state.rating) && !(await isRestrictedChannelConfigured(connection, guildId));
    if (crossesBarrier(state.originalRating, state.rating) && !skipMigration) {
      log(`handleManageSave: rating barrier crossed ${state.originalRating}→${state.rating} for storyId=${state.storyId}`, { show: true, guildName: state.guildName });
      const migResult = await migrateStoryThread(connection, interaction.guild, state.storyId, state.rating, state.originalRating);
      if (!migResult.success) {
        log(`handleManageSave: thread migration failed for storyId=${state.storyId}: ${migResult.error}`, { show: true, guildName: state.guildName });
      } else {
        await updateStoryStatusMessage(connection, interaction.guild, state.storyId);
        const migratedThread = await interaction.guild.channels.fetch(migResult.newThreadId).catch(() => null);
        if (migratedThread) await migratedThread.send({ embeds: [migResult.migratedInEmbed] }).catch(() => {});
      }
    } else {
      if (crossesBarrier(state.originalRating, state.rating)) {
        log(`handleManageSave: rating barrier crossed ${state.originalRating}→${state.rating} for storyId=${state.storyId} but no restricted channel configured — staying in current thread per policy`, { show: false, guildName: state.guildName });
      }
      updateStoryStatusMessage(connection, interaction.guild, state.storyId).catch(() => {});
    }

    pendingManageData.delete(interaction.user.id);

    // A turn's deadline is written once, when the turn starts, so a turn-length edit lands on
    // the next turn rather than the one running. Deliberate: shortening the length would
    // otherwise end the live turn the instant Save landed. So say so and leave the live turn to
    // the creator, who can move it from Manage Turns (LeeAnn, 2026-10-04).
    const savedText = await getConfigValue(connection, 'txtAdminConfigSaved', guildId);
    const turnLengthChanged = state.originalFields?.turnLength !== state.turnLength;
    const liveTurnEndsUnix = state.activeTurn?.turn_ends_unix ?? null;
    let confirmation = savedText;
    if (turnLengthChanged && liveTurnEndsUnix) {
      log(`handleManageSave: turn length ${state.originalFields?.turnLength}h→${state.turnLength}h with turn ${state.activeTurn?.turn_id} still running — live deadline left alone`, { show: true, guildName: state.guildName });
      confirmation += `\n\n${replaceTemplateVariables(state.cfg.txtManageTurnLengthLiveTurnNote, {
        // Number only — the unit word comes from txtHrs, which already existed and was unused,
        // so "hrs" can be reworded in config rather than in a template literal here.
        turn_length: state.turnLength,
        hrs: state.cfg.txtHrs,
        turn_end: discordTimestamp(liveTurnEndsUnix * 1000, 'f'),
        // Both button names come from their own config values, so renaming a button renames it
        // here too. btnTurnExtend carries its own leading emoji, which is what the admin is
        // looking for on the panel, so it goes in as-is.
        manage_turns: state.cfg.btnManageTurns,
        extend_deadline: state.cfg.btnTurnExtend,
      })}`;
    }
    await state.originalInteraction.editReply(finalMessage(confirmation));
  } catch (error) {
    log(`handleManageSave failed for storyId=${state.storyId}: ${error?.stack ?? error}`, { show: true, guildName: state.guildName });
    await state.originalInteraction.editReply(finalMessage(await getConfigValue(connection, 'errProcessingRequest', guildId)));
  }
}
