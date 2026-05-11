-- Context: config_help
INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES

-- ---------------------------------------------------------------------------
-- /story help — Page 1: Overview
-- ---------------------------------------------------------------------------
('txtHelp1Title', '📖 Round Robin StoryBot Overview', 'en', 1),
('txtHelp1Footer', 'Page 1 of 3 · Story IDs appear in /story list and in story thread titles.', 'en', 1),
('btnHelp1ToPage2', '📝 Story Creation Guide →', 'en', 1),
('lblHelp1FindJoin', '📚 Find & Join a Story', 'en', 1),
('txtHelp1FindJoin', 'Use `/story list` to browse all of the stories on the server, past or present. Stories have dedicated threads for all of their activity, and those can be found by clicking the 🧵 icon in the Round Robin feed channel.\n\nTo find out who has the current turn in a story and when it will end, use `/story timeleft`\nWhen you''re ready, you can join a story in several ways:\n- Use the quick join menu on `/story list`\n- Type `/story join [id]`\n- Navigate to the story thread and click the "✍️ Join This Story" button on the pinned story info post at the top of the thread.', 'en', 1),
('lblHelp1JoiningOptions', '⚙️ Joining Options', 'en', 1),
('lblHelp1TurnThreadPrivacy', '**🔒 Turn Thread Privacy** *(Normal Mode only)*', 'en', 1),
('txtHelp1TurnThreadPrivacy', '- **Public** — Threads for your turns will be visible to all.\n- **Private** — Turn threads will only be visible to you and admins.', 'en', 1),
('lblHelp1Notifications', '**💬 Notifications**', 'en', 1),
('txtHelp1Notifications', '- **DM** — StoryBot sends DMs for turn start, reminders, and turn timeout or skip.\n- **Mention in channel** — The bot will tag you about your turn in messages on the story thread.', 'en', 1),
('lblHelp1PenName', '**✒️ Pen Name** *(optional)*', 'en', 1),
('txtHelp1PenName', '- Your name as it appears on the story. If the story is configured to display names, it will show on entries and in the exported story. Defaults to your Discord display name.', 'en', 1),
('lblHelp1Dashboard', '🗂️ Your Dashboard', 'en', 1),
('txtHelp1Dashboard', 'Use `/mystory list` to see all the stories you''ve joined — active, paused, delayed, and closed.', 'en', 1),
('lblHelp1ManageParticipation', '🤝 Managing Your Participation', 'en', 1),
('txtHelp1ManageParticipation', 'Use `/mystory manage` to take action on a specific story:\n- Pass your current turn\n- Pause or resume your participation\n- Leave the story', 'en', 1),
('lblHelp1WritingYourTurn', '**✍️ Writing Your Turn**', 'en', 1),
('lblHelp1WriteNormal', '📝 Normal Mode', 'en', 1),
('txtHelp1WriteNormal', 'When it''s your turn, you''ll be notified with a link to your turn thread. Type as many posts as you like, add images in their own posts with display (alt) text (if images are enabled on your server), and format your posts using Discord markdown for bold, italics, etc. If you want to review the entries in the story since you last wrote, use `/mystory catchup` to see your last entry and the entries since.\n\nYour entry won''t be posted until you click Finalize — you can revise as much as you like first. *All* of your posts in the turn thread will be compiled for your entry, so make sure you delete any of your own chatter before finalizing. Posts from the bot or other users will not be included. If you need more time, you can click a button on the first post in the thread to request an extension from the story creator.', 'en', 1),
('lblHelp1WriteQuick', '⚡ Quick Mode', 'en', 1),
('txtHelp1WriteQuick', 'If a story is in Quick Mode, you won''t get a thread for your turn. You can post an entry by typing `/story write`. Entries are limited to 4,000 characters, and images are not supported. Your entry is posted immediately when you submit — there''s no draft or finalize step.', 'en', 1),
('lblHelp1WriteSlow', '**🐢 Slow Mode**', 'en', 1),
('txtHelp1WriteSlow', 'Slow Mode is just like Normal mode, with individual turn threads and the ability to upload images, if enabled. The difference is, there is no timer. Turns only end when skipped or finalized, so you can take your time and write as you are able without feeling pressured. Reminders can be configured to send every X hours, so you don''t forget about the story entirely!', 'en', 1),

-- ---------------------------------------------------------------------------
-- /story help — Page 2: Story Creation
-- ---------------------------------------------------------------------------
('txtHelp2Title', '📝 Create New Story — Option Reference', 'en', 1),
('txtHelp2Footer', 'Page 2 of 3 · After story creation, these settings can be edited by admins or the story creator via `/story manage.`', 'en', 1),
('btnHelp2ToPage1', '← Back to Overview', 'en', 1),
('btnHelp2ToPage3', '⚙️ Story Manage Guide →', 'en', 1),
('lblHelp2StoryTitle', 'Story Title', 'en', 1),
('txtHelp2StoryTitle', '- ⚠️ *Required.*', 'en', 1),
('lblHelp2MaxWriters', 'Max Writers', 'en', 1),
('txtHelp2MaxWriters', '- #️⃣ Optional. Leave blank for no limit.', 'en', 1),
('lblHelp2TurnLength', 'Turn Length', 'en', 1),
('txtHelp2TurnLength', '- ⌛ How many hours each writer has per turn. Default: 24h.', 'en', 1),
('lblHelp2StoryMode', 'Story Mode', 'en', 1),
('txtHelp2StoryMode', '- 🟢 **Normal** — Writers get a private or public thread for each turn.\n- 🟣 **Quick** — Writers submit entries via `/story write`.', 'en', 1),
('lblHelp2WriterOrder', 'Writer Order', 'en', 1),
('txtHelp2WriterOrder', '- 🎲 **Random** — Next writer chosen completely at random each turn.\n- 🔄 **Round Robin** — Rotates randomly, but no one repeats until everyone has had a turn.\n- 📋 **Fixed Order** — Writers take turns in a fixed sequence based on join order.', 'en', 1),
('lblHelp2HideThreads', 'Hide Threads', 'en', 1),
('txtHelp2HideThreads', '- 🥷 **On** — Turn threads are private to the current writer and admins only.\n- 🤡 **Off** — Turn threads are visible to all server members.', 'en', 1),
('lblHelp2ShowAuthors', 'Show Author Names', 'en', 1),
('txtHelp2ShowAuthors', '- 📑 **Yes** — Writer names appear on entries in Discord and in the export file.\n- 📄 **No** — Entries are posted and exported anonymously.', 'en', 1),
('lblHelp2TimeoutReminder', 'Timeout Reminder', 'en', 1),
('txtHelp2TimeoutReminder', '- ⏰ Send a reminder to the current writer after X% of their turn has elapsed. Default: 50%. Set to 0% to disable.', 'en', 1),
('lblHelp2DelayStart', 'Delay Start By', 'en', 1),
('txtHelp2DelayStart', '- 🫸 Leave blank to start immediately. Set a number of hours, a minimum writer count, or both — the story activates when all conditions are met.', 'en', 1),
('lblHelp2CreatorOptions', 'Story Creator''s Join Options', 'en', 1),
('txtHelp2CreatorOptions', '**Your Pen Name**\n- ✍️ Your name as it will appear on the story. Used in story exports. Defaults to your Discord display name if left blank.\n\n**Keep My Turns Private**\n- 🔒 **Yes** — Your turn threads will only be visible to you and admins.\n- 🔓 **No** — Your turn threads will be visible to other writers.', 'en', 1),
('lblHelp2Metadata', '📋 Story Metadata', 'en', 1),
('txtHelp2Metadata', 'Optional metadata set via the **Metadata** button in the story create form:\n- 🔞 **Rating** — G, T, M, E, or Not Rated. Affects which feed channel the story posts to.\n- ⚠️ **Warnings** — Select all that apply.\n- 📊 **Dynamic** — General, F/F, F/M, M/M, Polyamory, or Other.\n- 💞 **Main Relationship** — Primary ship or pairing (e.g. Bilbo Baggins/Thorin Oakenshield).\n- 🫂 **Other Relationships** — Additional pairings or relationships.\n- 🧑 **Characters** — Characters featured in the story.\n- 🏷️ **Tags** — Freeform tags (e.g. slow burn, hurt/comfort, AU).', 'en', 1),

-- ---------------------------------------------------------------------------
-- /story help — Page 3: Managing a Story
-- ---------------------------------------------------------------------------
('txtHelp3Title', '⚙️ Managing a Story — /story manage', 'en', 1),
('txtHelp3Footer', 'Page 3 of 3', 'en', 1),
('btnHelp3ToPage2', '← Story Creation Guide', 'en', 1),
('lblHelp3WhoCanUse', 'Who can use `/story manage`?', 'en', 1),
('txtHelp3WhoCanUse', 'The story creator (the first writer to join) and server admins.', 'en', 1),
('lblHelp3WhatEdit', 'What can be edited?', 'en', 1),
('txtHelp3WhatEdit', '**Story settings** (via `/story manage`):\n- **Turn Length** — How many hours each writer has per turn.\n- **Timeout Reminder** — What % into a turn to send the writer a reminder. Set to 0% to disable.\n- **Max Writers** — Cap on total writers. Leave blank for no limit.\n- **Open to New Writers** — Allows new writers to join.\n- **Show Author Names** — Writer names appear on entries and in the story export if enabled.\n- **Writer Order** — Choose between Random, Round Robin, and Fixed (Join) Order.\n- **Turn Privacy** — Private turns are only visible to the current writer (and admins via channel permissions). Public turns are visible to all.\n- **Summary** — A freeform description used in story exports.\n- **Tags** — Comma-separated tag list used in story exports.\n\n**Entry content** — Use `/story edit [id]` to edit the text of a finalized entry. Writers can edit their own entries; admins can edit any.', 'en', 1),
('lblHelp3PauseResume', 'Pausing and Resuming', 'en', 1),
('txtHelp3PauseResume', '- Sets the story status to paused (freezing the current turn) or resumes a paused story. Resuming starts the next turn automatically if no turn is currently active.\n- Use the button in `/story manage` to pause or resume.', 'en', 1),
('lblHelp3Closing', 'Closing a Story', 'en', 1),
('txtHelp3Closing', '- Use `/story close [id]` to permanently close a story. This posts a completion message with the full story export and ends the current turn, but leaves the story thread open for discussion. This cannot be undone.', 'en', 1),
('lblHelp3AdminControls', 'Admin Controls', 'en', 1),
('txtHelp3AdminControls', '- Skip the current turn\n- Extend the current turn\n- Set the writer who will be selected when the next turn starts\n- Remove a writer from a story\n- Delete a story', 'en', 1),

-- ---------------------------------------------------------------------------
-- /mystory help — Page 4: Writer Commands
-- ---------------------------------------------------------------------------
('txtHelp4Title', '📋 Writer Command Reference', 'en', 1),
('txtHelp4Footer', 'For story creation, modes, and settings — use /story help', 'en', 1),
('lblHelp4Dashboard', '📊 Your Dashboard', 'en', 1),
('txtHelp4Dashboard', '- `/mystory list` — See all your stories — active, paused, delayed, and closed\n- `/mystory catchup [id]` — Read entries written since your last turn', 'en', 1),
('lblHelp4Turn', '✍️ Your Turn', 'en', 1),
('txtHelp4Turn', '- `/story write [id]` — Submit your entry *(quick mode)*\n- `/story read [id]` — Read the story in Discord\n- `/story edit [id]` — Edit one of your finalized entries\n- `/mystory manage [id]` — Pass your turn, pause, or leave a story', 'en', 1),
('lblHelp4Pause', '⏸️ Pausing', 'en', 1),
('txtHelp4Pause', '- Use the **Pause** button in `/mystory manage [id]` to step out of the turn rotation temporarily. If it''s your turn when you pause, it will be passed automatically.\n- Use **Resume** to rejoin the rotation. You''ll re-enter the order of writers as before, depending on story settings.', 'en', 1),

-- ---------------------------------------------------------------------------
-- /storyadmin help — Page 5: Admin Commands
-- ---------------------------------------------------------------------------
('txtHelp5Title', '⚙️ StoryAdmin Commands', 'en', 1),
('txtHelp5Footer', 'Story settings (pause, resume, turn length, writer order) are managed via /story manage. All commands require the round robin admin role specified at server setup or the Discord Administrator role.', 'en', 1),
('lblHelp5Skip', '/storyadmin skip [story_id]', 'en', 1),
('txtHelp5Skip', 'Force-ends the active turn and advances to the next writer. If it is a normal mode story it will delete the active thread.', 'en', 1),
('lblHelp5Extend', '/storyadmin extend [story_id] [hours]', 'en', 1),
('txtHelp5Extend', 'Adds hours to the current turn deadline.', 'en', 1),
('lblHelp5ManageUser', '/storyadmin user [story_id] [user]', 'en', 1),
('txtHelp5ManageUser', 'Opens a writer management panel — pause, unpause, remove, or update their pen name using buttons.', 'en', 1),
('lblHelp5Next', '/storyadmin next [story_id] [user]', 'en', 1),
('txtHelp5Next', 'Designates who will receive the next turn. If no turn is currently active, starts their turn immediately. Otherwise, the override takes effect when the current turn ends.', 'en', 1),
('lblHelp5Reassign', '/storyadmin reassign [story_id]', 'en', 1),
('txtHelp5Reassign', 'Reassigns the active turn to the previous writer (for example, they missed their turn and still want to write), then queues the current writer who was skipped so that they get the next turn and the order proceeds as normal.', 'en', 1),
('lblHelp5Delete', '/storyadmin delete [story_id]', 'en', 1),
('txtHelp5Delete', 'Permanently deletes a story and all its turns, entries, and writer data. Requires confirmation.', 'en', 1),
('lblHelp5Setup', '/storyadmin setup', 'en', 1),
('txtHelp5Setup', 'Configure Round Robin StoryBot for this server — set the story feed channel, media channel, admin role, and weekly roundup settings.', 'en', 1),
('lblHelp5Remove', '/storyadmin remove [story_id] [user]', 'en', 1),
('txtHelp5Remove', 'Removes a writer from a story. If it''s their turn, advances to the next writer. If they''re the last writer, the story is closed automatically.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 5 FAQ content (used by faqsync only — not in the /storyadmin help embed)
-- ---------------------------------------------------------------------------
('lblHelp5FaqSetup', '⚙️ Story Management Panel', 'en', 1),
('txtHelp5FaqSetup', '- `/story manage [id]` — See "Managing a Story" (`/story help`) for more information on the Story Management Panel.', 'en', 1),
('lblHelp5FaqUserPanel', '👤 User Management Panel', 'en', 1),
('txtHelp5FaqUserPanel', '- `/storyadmin user [story_id] [writer]` — Manage a writer''s participation in a story: pause, remove, change their notification or privacy settings, or update their pen name.', 'en', 1),
('lblHelp5FaqDelete', '🗑️ Delete a Story', 'en', 1),
('txtHelp5FaqDelete', '- `/storyadmin delete [id]` — Permanently delete a story and all its data', 'en', 1),
('txtHelp5FaqFooter', '*All admin commands require the Discord Administrator permission, or the Round Robin admin role configured in `/storyadmin setup`*', 'en', 1),

-- ---------------------------------------------------------------------------
-- FAQ sync status messages
-- ---------------------------------------------------------------------------
('txtHelpFaqSyncSuccess', '✅ FAQ posts updated successfully.', 'en', 1),
('txtHelpFaqSyncNoThreads', '⚠️ No FAQ thread IDs are configured. Set them via `/storyadmin setup`.', 'en', 1),
('txtHelpFaqSyncPartial', '⚠️ FAQ sync complete with [error_count] error(s). Check logs for details.', 'en', 1);
