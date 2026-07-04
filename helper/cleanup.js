/**
 * cleanup.js
 * Deletes config keys from the DB that no longer exist in any config_files SQL file.
 * Safe to run multiple times — only deletes keys explicitly listed below.
 *
 * Usage: from project root, run: node helper/cleanup.js
 */

import { DB, loadConfig, formattedDate } from '../utilities.js';

const ORPHAN_KEYS = [
'txtDMTurnStart',
'txtMentionTurnStart',
'btnSetTurnLength',
'btnSetTimeout',
'btnSetPenName',
'btnSetDelayHours',
'btnSetDelayWriters',
'btnSetMaxWriters',
'txtDMTurnReminder',
'txtMentionTurnReminder',
'cfgWeeklyRoundupThumbnail',
'btnSetMetadata',
'btnSetupFeed',
'btnSetupMedia',
'btnSetupRestrictedFeed',
'btnSetupRestrictedMedia',
'btnSetupRoundupChannel',
'btnSetupRoundupDay',
'btnSetupRoundupHour',
'txtMyListJoined',
'txtMyListMyStats',
'txtMyListNoTurns',
'txtMyListStoryTotal'
];

async function main() {
  const config = loadConfig();
  const db = new DB(config.db);
  const connection = await db.connect();

  try {
    const placeholders = ORPHAN_KEYS.map(() => '?').join(',');
    const [existing] = await connection.execute(
      `SELECT config_key, guild_id FROM config WHERE config_key IN (${placeholders})`,
      ORPHAN_KEYS
    );

    if (existing.length === 0) {
      console.log(`${formattedDate()}: No orphan keys found in DB — nothing to delete.`);
      return;
    }

    console.log(`${formattedDate()}: Found ${existing.length} orphan key(s) to delete:`);
    for (const row of existing) {
      console.log(`  - ${row.config_key} (guild ${row.guild_id})`);
    }

    const [result] = await connection.execute(
      `DELETE FROM config WHERE config_key IN (${placeholders})`,
      ORPHAN_KEYS
    );
    console.log(`${formattedDate()}: Deleted ${result.affectedRows} row(s).`);
  } finally {
    await db.disconnect();
  }
}

main().catch(err => {
  console.error(`${formattedDate()}: Cleanup failed:`, err);
  process.exit(1);
});
