-- Context: config_help
INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES

-- ---------------------------------------------------------------------------
-- /story help — Table of Contents
-- ---------------------------------------------------------------------------
('txtHelpTocTitle', '📖 Round Robin StoryBot Help', 'en', 1),
('txtHelpTocFooter', 'Select a topic from the menu below.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 1: Round Robin StoryBot Overview
-- ---------------------------------------------------------------------------
('txtHelp1Title', '📖 Round Robin StoryBot Overview', 'en', 1),
('lblHelp1FindJoin', '📚 Find & Join a Story', 'en', 1),
('txtHelp1FindJoin', 'Use `/story list` to browse all stories, past or present. Dedicated story threads can be found by clicking the 🧵 icon in the Round Robin feed channel. To check who has the current turn and how much time is left, use `/story timeleft [id]`.\n\nWhen you''re ready, you can join a story in several ways:\n- Use the quick join menu on `/story list`\n- Type `/story join [id]`\n- Pinned in each story thread is an info post with a "✍️ Join This Story" button.', 'en', 1),
('lblHelp1JoiningOptions', '⚙️ Joining Options', 'en', 1),
('lblHelp1TurnThreadPrivacy', '🔒 Turn Thread Privacy *(Normal Mode only)*', 'en', 1),
('txtHelp1TurnThreadPrivacy', '- **Public** — Threads for your turns will be visible to all.\n- **Private** — Turn threads will only be visible to you and admins.', 'en', 1),
('lblHelp1Notifications', '💬 Notifications', 'en', 1),
('txtHelp1Notifications', '- **DM** — StoryBot sends DMs for turn start, reminders, and turn timeout or skip.\n- **Mention in channel** — The bot will tag you about your turn in messages on the story thread.', 'en', 1),
('lblHelp1PenName', '✒️ Pen Name *(optional)*', 'en', 1),
('txtHelp1PenName', '- Your name as it appears on the story. If the story is configured to display names, it will show on entries and in the exported story. Defaults to your Discord display name.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 2: Your Stories & Turns
-- ---------------------------------------------------------------------------
('txtHelp2Title', '🗂️ Your Stories & Turns', 'en', 1),
('lblHelp2Dashboard', '📅 Your Dashboard', 'en', 1),
('txtHelp2Dashboard', '- `/mystory list` — See all your stories — active, paused, delayed, and closed.\n- `/mystory catchup [id]` — Read your last entry and any written since your last turn.', 'en', 1),
('lblHelp2ManageParticipation', '🤝 Managing Your Participation', 'en', 1),
('txtHelp2ManageParticipation', 'Use `/mystory manage` to take action on a specific story:\n- Pass your current turn\n- Pause or resume your participation\n- Leave the story', 'en', 1),
('lblHelp2WritingYourTurn', '✍️ Writing Your Turn', 'en', 1),
('lblHelp2WriteNormal', '📜 Normal Mode', 'en', 1),
('txtHelp2WriteNormal', 'When it''s your turn, you''ll be notified with a link to your turn thread. Make as many posts as you like, add images in their own posts with display (alt) text (if images are enabled), and format your posts using Discord markdown for bold, italics, etc.\n\nYour entry won''t be saved until you click Finalize. If your turn times out, all posts will be lost. Anything you post in the turn thread will be compiled for your entry. Posts from the bot or other users will not be included. If you need more time, click the button at the top of the thread to request an extension from the story creator.', 'en', 1),
('lblHelp2WriteQuick', '⚡ Quick Mode', 'en', 1),
('txtHelp2WriteQuick', 'If a story is in Quick Mode, you won''t get a thread for your turn. Post an entry by typing `/story write`. Entries are limited to 4,000 characters, and images are not supported. Your entry is posted immediately when you submit — there''s no draft or finalize step.', 'en', 1),
('lblHelp2WriteSlow', '🐢 Slow Mode', 'en', 1),
('txtHelp2WriteSlow', 'Slow Mode is just like Normal mode, with individual turn threads and the ability to upload images, if enabled. The difference is, there is no timer. Turns only end when skipped or finalized, so you can take your time and write as you are able without feeling pressured. Reminders can be configured to send every X hours, so you don''t forget about the story entirely!', 'en', 1),
('lblHelp2WriteTranslations', '🌐 Inline Translations', 'en', 1),
('txtHelp2WriteTranslations', '**Inline Translations**: Type `[[original text|translation]]` to add a hover tooltip. In Discord, it shows as `original text *(translation)*`. When exported, it becomes a hover-over tooltip.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 3: Create a New Story — General Options
-- ---------------------------------------------------------------------------
('txtHelp3Title', '📝 Create a New Story — General Options', 'en', 1),
('lblHelp3StoryTitle', '⚠️ Story Title', 'en', 1),
('txtHelp3StoryTitle', '- *Required.*', 'en', 1),
('lblHelp3StoryMode', '🚦 Story Mode', 'en', 1),
('txtHelp3StoryMode', '- **Normal** — Writers get a private or public thread for each turn.\n- **Quick** — Writers submit entries via `/story write`.\n- **Slow** — Like Normal mode, but there is no turn timer.', 'en', 1),
('lblHelp3WriterOrder', '🎲 Writer Order', 'en', 1),
('txtHelp3WriterOrder', '- **Random** — Next writer chosen at random each turn.\n- **Round Robin** — Rotates randomly, but no repeats until everyone has had a turn.\n- **Fixed Order** — Writers take turns in join order.', 'en', 1),
('lblHelp3TurnLength', '⌛ Turn Length', 'en', 1),
('txtHelp3TurnLength', '- How many hours each writer has per turn. Default: 24h.', 'en', 1),
('lblHelp3TimeoutReminder', '⏰ Reminder Timing', 'en', 1),
('txtHelp3TimeoutReminder', '- Send a reminder to the current writer after X% of their turn has elapsed. Default: 50%. Set to 0% to disable. (Example: 50% of a 24hr turn means the reminder is sent after 12hrs.)', 'en', 1),
('lblHelp3HideThreads', '🔑 Turn Thread Privacy', 'en', 1),
('txtHelp3HideThreads', '- **Public** — Threads for all turns will be visible to all members of your server.\n- **Private** — Turn threads will only be visible to the writer and server admins.', 'en', 1),
('lblHelp3ShowAuthors', '📑 Show Author Names', 'en', 1),
('txtHelp3ShowAuthors', '- **Yes** — Writer names appear on entries in Discord and in the export file.\n- **No** — Entries are posted and exported anonymously. Writer names still appear in story messages.', 'en', 1),
('lblHelp3MaxWriters', '#️⃣ Max Writers', 'en', 1),
('txtHelp3MaxWriters', '- *Optional.* A cap on total writers. Leave blank for no limit.', 'en', 1),
('lblHelp3DelayStart', '🫸 Delay Start By', 'en', 1),
('txtHelp3DelayStart', '- *Optional.* Leave blank to start immediately. Set a number of hours, a minimum writer count, or both — the story activates when all conditions are met.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 4: Create a New Story — Join Options & Metadata
-- ---------------------------------------------------------------------------
('txtHelp4Title', '📝 Create a New Story — Join Options & Metadata', 'en', 1),
('lblHelp4CreatorOptions', 'Story Creator''s Join Options', 'en', 1),
('lblHelp4PenName', '✒️ Your Pen Name', 'en', 1),
('txtHelp4PenName', '- Your name as it will appear on the story. Used in story exports. Defaults to your Discord display name if left blank.', 'en', 1),
('lblHelp4HideMyThreads', '🔒 Hide My Threads', 'en', 1),
('txtHelp4HideMyThreads', '- **On** — Your turn threads will be private to you and admins, regardless of the story''s thread setting.\n- **Off** — Your thread visibility follows the story''s Hide Threads setting.', 'en', 1),
('lblHelp4Notifications', '💬 Notifications', 'en', 1),
('txtHelp4Notifications', '- **DM** — StoryBot will send you a DM when your turn starts.\n- **Mention** — You''ll be mentioned in the story thread instead.', 'en', 1),
('lblHelp4Metadata', '📋 Story Metadata', 'en', 1),
('txtHelp4Metadata', 'Optional story info set via the **Metadata** sub-panel.\n- 🛡️ **Rating** — Global, Teen, Mature, Explicit, or Not Rated. M and E works may be posted to an age-restricted feed channel.\n- ⚠️ **Warnings** — Select all that apply: All Clear: No Content Warnings, Extreme or Visceral Violence, Main Character Fatality, Other: See Tags, Rape/Lack of Sexual Consent, Sex Involving a Minor, Unspecified: Warnings May Apply\n- 📊 **Dynamic** — General, F/F, F/M, M/M, Polyamory, or Other\n- 💞 **Main Relationship** — Primary pairing (e.g. Bilbo Baggins/Thorin Oakenshield).\n- 🫂 **Other Relationships** — Additional pairings or relationships\n- 🧑 **Characters** — Characters featured in the story.\n- 🏷️ **Tags** — Freeform tags, or tags submitted by story authors (e.g. slow burn, hurt/comfort, modern AU).\n- 📝 **Summary** — A brief teaser for your story.\n- ⁘ **Scene Break Divider**: A custom line of text (like `⁘ ⁘ ⁘` or `* * *`) used for scene breaks. Type `[[break]]` on its own line anywhere in your entry, and it''ll be replaced with this divider wherever your story is shown. If you haven''t set one yet, `[[break]]` stays as a reminder to set it up.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 5: Managing a Story 
-- ---------------------------------------------------------------------------
('txtHelp5Title', '⚙️ Managing a Story', 'en', 1),
('lblHelp5WhoCanUse', '👤 Who can use `/story manage`?', 'en', 1),
('txtHelp5WhoCanUse', 'The story creator (the first writer to join) and server admins.', 'en', 1),
('lblHelp5WhatEdit', '❓ What settings can be edited?', 'en', 1),
('txtHelp5WhatEdit', '- **Story Title** — Cannot be blank.\n- **Story Mode**\n- **Writer Order** — Choose between Random, Round Robin, and Fixed (Join) Order.\n- **Join Status** — You can close or open a story to new writers joining.\n- **Max Writers** — Cap on total writers. Leave blank for no limit.\n- **Turn Length** — hours per turn\n- **Reminder Timing** — a percentage of the total turn time when reminders will be sent, or 0% to disable. (Example: 50% of a 24hr turn means the reminder is sent after 12hrs.)\n- **Show Author Names** — Writer names appear on entries and in the story export if enabled.\n- **Turn Privacy** — Turn threads are only visible to the current writer (and server admins). Public turns are visible to all.\n- **Story Status** — Toggles the story status from Paused to Resumed, or Reopens a closed story. When paused, the current turn is frozen until the story status is resumed, then the turn restarts with a refreshed deadline.', 'en', 1),
('lblHelp5Closing', '🏁 Closing a Story', 'en', 1),
('txtHelp5Closing', '- Use `/story close [id]` to close a story. This posts a completion message with the full story export, ends the current turn, and closes the story to new joins, but leaves the story thread open for discussion. You can always reopen a story from the management panel.', 'en', 1),
('lblHelp5AdminControls', '🛡️ Admin Controls', 'en', 1),
('txtHelp5AdminControls', '**Manage Turns** (via the Manage Turns button in `/story manage`):\n- Skip the current turn\n- Extend the current turn deadline\n- Designate the next writer\n- Reassign the turn to the previous writer (e.g. if they missed their turn and still want to write) and set the current writer to go after them\n\n**Manage Users** (via `/storyadmin user [id] [user]`):\n- Pause or unpause a writer\n- Remove a writer from a story\n- Update a writer''s pen name\n\n**Other admin actions** (via `/storyadmin`):\n- Permanently delete a story: `/storyadmin delete`', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 6: Reading & Editing
-- ---------------------------------------------------------------------------
('txtHelp6Title', '📖 Reading & Editing', 'en', 1),
('lblHelp6Read', '📖 Reading a Story', 'en', 1),
('txtHelp6Read', '`/story read [id]` — Displays the story in Discord, paginated by entry. Longer entries are broken into additional pages. Each entry shows the writer''s name (if enabled) and the text they submitted. Images are shown as placeholders with their alternate text.', 'en', 1),
('lblHelp6Edit', '✏️ Editing an Entry', 'en', 1),
('txtHelp6Edit', 'You can edit a finalized entry two ways:\n- `/story edit [id] [turn]` — Opens the edit interface directly.\n- Click the **Edit** button in `/story read` — appears on the first page of each entry.\n\nWriters can edit their own entries. Admins can edit or delete any entry and restore previous versions.', 'en', 1),
('lblHelp6EditPages', '📄 Entries Split Across Pages', 'en', 1),
('txtHelp6EditPages', 'Entries longer than 3,800 characters are split into pages. Each page is edited separately — changes on one page do not affect the others. You can add up to 200 characters to a page before saving; if you need more space, save and the pages will reload with the updated content.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 7: MyStory Commands
-- ---------------------------------------------------------------------------
('txtHelp7Title', '📋 Writer Command Reference', 'en', 1),
('txtHelp7Footer', 'Use /story help for detailed explanations of story modes, writer order, metadata, and more.', 'en', 1),
('lblHelp7StoryCommands', '📖 Story Commands', 'en', 1),
('txtHelp7StoryCommands', '- `/story list` — Browse all stories on the server; filter by status or rating\n- `/story join [id]` — Join a story\n- `/story write [id]` — Submit your entry *(Quick Mode only)*\n- `/story read [id]` — Read the story in Discord\n- `/story edit [id] [turn]` — Edit one of your finalized entries\n- `/story timeleft [id]` — See how much time is left in the current turn\n- `/story ping [id]` — Ping all writers in a story\n- `/story help` — Detailed guide with all writer options', 'en', 1),
('lblHelp7Dashboard', '🗂️ Your Dashboard', 'en', 1),
('txtHelp7Dashboard', '- `/mystory list` — See all your stories — active, paused, delayed, and closed\n- `/mystory catchup [id]` — Read entries written since your last turn\n- `/mystory manage [id]` — Update your settings, pass your turn, pause, or leave a story', 'en', 1),
('lblHelp7CreatorCommands', '⚙️ Story Creator Commands', 'en', 1),
('txtHelp7CreatorCommands', '- `/story manage [id]` — Edit story settings, manage turns and entries, pause or close', 'en', 1),

-- ---------------------------------------------------------------------------
-- Page 8: StoryAdmin Commands
-- ---------------------------------------------------------------------------
('txtHelp8Title', '⚙️ Admin Command Reference', 'en', 1),
('txtHelp8Footer', '*All admin commands require the Discord Administrator permission, or the Round Robin admin role configured in `/storyadmin setup`*', 'en', 1),
('lblHelp8Setup', '🛠️ Setup', 'en', 1),
('txtHelp8Setup', '- `/storyadmin setup` — This command must be run before the bot can function, but it''s also used to update system settings.', 'en', 1),
('lblHelp8SetupChannels', '📡 Configure Story Channels', 'en', 1),
('txtHelp8SetupChannels', '- **Story Feed Channel** — Central hub where all story threads and activity are posted.\n- **Media Channel** — Images posted to Normal or Slow Mode stories are forwarded here for long-term storage. Leave blank to disable images for your server. *Recommended admin-only.*\n- **Restricted Feed Channel** — Age-restricted channel for stories rated Mature or Explicit in non-18+ servers.\n- **Restricted Media Channel** — Private, age-restricted storage for mature story images. *Recommended admin-only.*', 'en', 1),
('lblHelp8SetupPermissions', '🔑 Permissions', 'en', 1),
('txtHelp8SetupPermissions', '- **Admin Role** — This is the role that can manage stories and writers in the bot. Leave this blank to limit access to server Admins.', 'en', 1),
('lblHelp8SetupRoundup', '📆 Weekly Roundup', 'en', 1),
('txtHelp8SetupRoundup', 'The weekly roundup is a summary of the story activity on your server. It lists active stories and writers, and gives a count of stories created or completed, turns submitted or missed, and words written.\n- **Roundup Channel** — Set the channel where the roundup will be posted, or leave this field blank to disable the weekly post.\n- **Roundup Timing** — Choose the day and hour you''d like the summary to post: day (0 = Sunday, 6 = Saturday), hour UTC (0–23).', 'en', 1),
('lblHelp8ManageStory', '⚙️ Story Management Panel', 'en', 1),
('txtHelp8ManageStory', '*(admin or story creator)*\n- `/story manage [id]` — See "Managing a Story" (`/story help`) for more information on the Story Management Panel.', 'en', 1),
('lblHelp8ManageUser', '👤 User Management Panel', 'en', 1),
('txtHelp8ManageUser', '*(admin only)*\n- `/storyadmin user [story_id] [writer]` — Manage a writer''s participation in a story: pause, remove, change their notification or privacy settings, or update their pen name.', 'en', 1),
('lblHelp8Delete', '🗑️ Delete a Story', 'en', 1),
('txtHelp8Delete', '*(requires confirmation)*\n- `/storyadmin delete [id]` — Permanently delete a story and all its data', 'en', 1),

-- ---------------------------------------------------------------------------
-- FAQ sync status messages
-- ---------------------------------------------------------------------------
('txtHelpFaqSyncSuccess', '✅ FAQ posts updated successfully.', 'en', 1),
('txtHelpFaqSyncNoThreads', '⚠️ No FAQ post IDs are configured. Run deploy to create them.', 'en', 1),
('txtHelpFaqSyncPartial', '⚠️ FAQ sync complete with [error_count] error(s). Check logs for details.', 'en', 1);
