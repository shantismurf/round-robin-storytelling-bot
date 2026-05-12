/**
 * cleanup.js
 * Deletes config keys from the DB that no longer exist in any config_files SQL file.
 * Safe to run multiple times — only deletes keys explicitly listed below.
 *
 * Usage: node cleanup.js
 */

import { DB, loadConfig, formattedDate } from './utilities.js';

const ORPHAN_KEYS = [
  'txtHelp1Footer',
  'btnHelp1ToPage2',
  'lblHelp1Dashboard',
  'txtHelp1Dashboard',
  'lblHelp1WriteNormal',
  'txtHelp1WriteNormal',
  'lblHelp1WriteQuick',
  'txtHelp1WriteQuick',
  'lblHelp1ManageParticipation',
  'txtHelp1ManageParticipation',
  'txtHelp2Footer',
  'btnHelp2ToPage1',
  'btnHelp2ToPage3',
  'lblHelp2StoryTitle',
  'txtHelp2StoryTitle',
  'lblHelp2MaxWriters',
  'txtHelp2MaxWriters',
  'lblHelp2TurnLength',
  'txtHelp2TurnLength',
  'lblHelp2StoryMode',
  'txtHelp2StoryMode',
  'lblHelp2WriterOrder',
  'txtHelp2WriterOrder',
  'lblHelp2HideThreads',
  'txtHelp2HideThreads',
  'lblHelp2ShowAuthors',
  'txtHelp2ShowAuthors',
  'lblHelp2TimeoutReminder',
  'txtHelp2TimeoutReminder',
  'lblHelp2DelayStart',
  'txtHelp2DelayStart',
  'lblHelp2CreatorOptions',
  'txtHelp2CreatorOptions',
  'txtHelp3Footer',
  'btnHelp3ToPage2',
  'lblHelp3WhoCanUse',
  'txtHelp3WhoCanUse',
  'lblHelp3WhatEdit',
  'txtHelp3WhatEdit',
  'lblHelp3PauseResume',
  'txtHelp3PauseResume',
  'lblHelp3Closing',
  'txtHelp3Closing',
  'lblHelp3AdminControls',
  'txtHelp3AdminControls',
  'cfgFaqThreadOverview',
  'cfgFaqThreadWriterCmds',
  'cfgFaqThreadStoryCreation',
  'cfgFaqThreadManaging',
  'cfgFaqThreadAdminCmds',
  'lblHelp2Metadata',
  'txtHelp2Metadata',
  'lblHelp1WritingYourTurn',
  'lblHelp1WriteSlow',
  'txtHelp1WriteSlow',
  'txtHelp4Footer',
  'lblHelp4Dashboard',
  'txtHelp4Dashboard',
  'lblHelp4Turn',
  'txtHelp4Turn',
  'lblHelp4Pause',
  'txtHelp4Pause',
  'txtHelp5Footer',
  'lblHelp5Skip',
  'txtHelp5Skip',
  'lblHelp5Extend',
  'txtHelp5Extend',
  'lblHelp5ManageUser',
  'txtHelp5ManageUser',
  'lblHelp5Next',
  'txtHelp5Next',
  'lblHelp5Reassign',
  'txtHelp5Reassign',
  'lblHelp5Delete',
  'txtHelp5Delete',
  'lblHelp5Setup',
  'txtHelp5Setup',
  'lblHelp5Remove',
  'txtHelp5Remove',
  'lblHelp5FaqSetup',
  'txtHelp5FaqSetup',
  'lblHelp5FaqUserPanel',
  'txtHelp5FaqUserPanel',
  'lblHelp5FaqDelete',
  'txtHelp5FaqDelete',
  'txtHelp5FaqFooter'
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
