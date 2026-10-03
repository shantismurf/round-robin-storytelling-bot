-- Context: config_help
INSERT INTO config (config_key, config_value, language_code, guild_id) VALUES

-- ---------------------------------------------------------------------------
-- /story help — Table of Contents
-- ---------------------------------------------------------------------------
('txtHelpTocTitle', '📖 Round Robin StoryBot Help', 'en', 1),
('txtHelpTocIntro', 'Welcome to Round Robin Storybot, a collaborative storywriting system. If you ever have any questions these help files don''t cover, you can ask them in the [Storybot Hub Server]([hubInviteUrl]).', 'en', 1),
('txtHelpPageGone', 'That help topic has moved. Use `/story help` to open the menu again.', 'en', 1),
('txtHelpTocFooter', 'Select a topic from the menu below.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Overview page body, plus the two page titles added when Find & Join and
-- Writing Your Entry became pages of their own. A key's Help<N> prefix is the
-- page it was created for, not the page it renders on, so keys added from here
-- on are named for their page instead. PAGE_DEFS in faq.js owns the order.
-- ---------------------------------------------------------------------------
('txtHelpOverviewHowItWorks', 'Any user can create a new story, and any user can join, depending on the story settings. Stories can be customized with turn and reminder length, privacy options, restrictions on when the story starts or how many can join, and a number of metadata fields, including story ground rules to guide writer conduct. Users take turns submitting entries via a text input popup (modal) or a thread created for their turn.', 'en', 1),
('txtHelpOverviewWriting', 'All entries support Discord markdown for formatting, and storybot-specific commands for inserting a custom scene break divider or adding a translation to text in other languages. If images are supported in your server, they can be added to Normal or Slow mode turn threads. Writers can collaborate on suggesting freeform tags for a story, and submitted entries can be edited by their writer or by story admins.', 'en', 1),
('txtHelpOverviewReading', 'At any point, stories can be read in a paged Discord interface, or exported as an html file that''s ready for pasting into sites like AO3, along with information on creating an AO3 work skin to support the inline formatting. Stories have no max length, and you can run as many stories as you like at the same time. You''re only limited by your imagination!', 'en', 1),
('txtHelpFindJoinTitle', '📚 Find & Join a Story', 'en', 1),
('txtHelpWritingTitle', '✍️ Writing Your Entry', 'en', 1),
('txtHelpOverviewFaqIntro', 'Welcome to Round Robin Storybot, a collaborative storywriting system. If you ever have any questions these help files don''t cover, you can ask them in the <#[hubSupportChannelId]> channel.', 'en', 1),
('lblHelpWritingThreadFeatures', '💡 Turn Thread Features for All Modes', 'en', 1),
('txtHelpWritingThreadFeatures', '🔡 **Double-Space Paragraphs:** The bot will not recognize paragraphs separated by only one line. You must have one blank line between each paragraph.\n\n📏 **Markdown Formatting:** The bot will preserve all markdown formatting, even spoiler, quotes, and headers (-#, #, ##, etc.).\n\n🈯️ **Translation Tooltips:** If you add text in another language, you can provide the translation in a special tag: `[[text|translation]]`. In Discord, the text will appear as: "text (*translation*)", but in the html export they will render as linked text that displays the translation in a hover tooltip on click.\n\n⁘ **Scene Break Divider:** Story creators can define a custom scene break divider—a series of characters that display on their own line to indicate scene change. Use `[[break]]` in your entry to insert it automatically. The story''s divider will be inserted whenever the text is displayed, and in the html export, the text will be centered.\n\nIt will always show the current version of the divider, so you''ll never have to worry about it being consistent throughout your story! Only one divider can be defined at this time, but if you would like to use more than one, join the [Round Robin Storybot Hub Server]([hubInviteUrl]) and post the suggestion!', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help1 keys: the Overview page title, and the Find & Join page
-- ---------------------------------------------------------------------------
('txtHelp1Title', '📖 Round Robin StoryBot Overview', 'en', 1),
('txtHelp1FindJoin', 'Use `/story list` to browse all stories, past or present. Dedicated story threads can be found by clicking the 🧵 icon in the Round Robin feed channel. To check who has the current turn and how much time is left, use `/story timeleft [id]`.\n\nWhen you''re ready, you can join a story in several ways:\n- Use the quick join menu on `/story list`\n- Type `/story join [id]`\n- Pinned in each story thread is an info post with a "✍️ Join This Story" button.', 'en', 1),
('lblHelp1JoiningOptions', '⚙️ Joining Options', 'en', 1),
('lblHelp1TurnThreadPrivacy', '🔒 Turn Thread Privacy', 'en', 1),
('txtHelp1TurnThreadPrivacy', '- **Public** — Threads for your turns will be visible to all.\n- **Private** — Turn threads will only be visible to you and admins.\n- Threads are only created for turns in Normal or Slow Mode stories.', 'en', 1),
('lblHelp1Notifications', '💬 Notifications', 'en', 1),
('txtHelp1Notifications', '- **DM** — StoryBot sends DMs for turn start, reminders, and turn timeout or skip.\n- **Mention in channel** — The bot will tag you in a message on the story thread with information about your turn.\n- Underage users may need to add the bot as a friend so reminders aren''t deferred to Message Requests.', 'en', 1),
('lblHelp1PenName', '✒️ Pen Name *(optional)*', 'en', 1),
('txtHelp1PenName', 'If the story is configured to display names, your pen name will show on entries and in the exported story. Defaults to your Discord display name.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help2 keys: the Your Stories page, and the three writing modes. Inline Translations and
-- Section Break used to live here too, condensed into txtHelpWritingThreadFeatures above
-- ---------------------------------------------------------------------------
('txtHelp2Title', '🗂️ Your Stories', 'en', 1),
('lblHelp2Dashboard', '📅 Your Dashboard', 'en', 1),
('txtHelp2Dashboard', '- `/mystory list` — See all your stories — active, paused, delayed, and closed.\n- `/mystory catchup [id]` — Read your last entry and any written since your last turn.', 'en', 1),
('lblHelp2ManageParticipation', '🤝 Managing Your Participation', 'en', 1),
('txtHelp2ManageParticipation', 'Use `/mystory manage` to take action on a specific story. Edit your pen name, notification selection, and turn thread privacy settings.\n\nYou can also:\n- Pass your current turn\n- Pause or resume your participation\n- Leave the story', 'en', 1),
('lblHelp2WriteNormal', '📜 Normal Mode', 'en', 1),
('txtHelp2WriteNormal', 'When it''s your turn, you''ll be notified with a link to your turn thread. You can make as many posts as you like, but all of your posts will go towards your entry. Posts from the bot, or other users, are excluded.\n\nYour entry won''t be saved to the story until you click Finalize. If your turn times out, any posts will be saved for 24 hours, so you can save your work and talk to the story creator about reassigning your lost turn. If you need more time before your turn ends, click the button at the top of the thread to send a message requesting an extension from the story creator.\n\nIf enabled on your server, images may be added to your entry, each in their own post, in the order you want them to appear in your text. Any text with the attached image will be used as the display (alt) text. If you want images to appear on a site like AO3, you''ll need to upload them to an image host like squidge.org and embed the image in the work as usual.', 'en', 1),
('lblHelp2WriteQuick', '⚡ Quick Mode', 'en', 1),
('txtHelp2WriteQuick', 'If a story is in Quick Mode, you won''t get a thread for your turn. Post an entry by typing `/story write`. Entries are limited to 4,000 characters, and images are not supported. Your entry is posted immediately when you submit — there''s no draft or finalize step.', 'en', 1),
('lblHelp2WriteSlow', '🐢 Slow Mode', 'en', 1),
('txtHelp2WriteSlow', 'Slow Mode is just like Normal mode, with individual turn threads and the ability to upload images, if enabled. The difference is, there is no timer. Turns only end when passed or finalized, so you can take your time and write as you are able without feeling pressured. Reminders can be configured to send every X hours, so you don''t forget about the story entirely!', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help3 keys: Creating a Story — general options
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
('lblHelp3TurnPrivacy', '🔑 Turn Thread Privacy', 'en', 1),
('txtHelp3TurnPrivacy', '- **Public** — Threads for all turns will be visible to all members of your server.\n- **Private** — Turn threads will only be visible to the writer and server admins.', 'en', 1),
('lblHelp3ShowAuthors', '📑 Show Author Names', 'en', 1),
('txtHelp3ShowAuthors', '- **Yes** — Writer names appear on entries in Discord and in the export file.\n- **No** — Entries are posted and exported anonymously. Writer names still appear in story messages.', 'en', 1),
('lblHelp3MaxWriters', '#️⃣ Max Writers', 'en', 1),
('txtHelp3MaxWriters', '- *Optional.* A cap on total writers. Leave blank for no limit.', 'en', 1),
('lblHelp3DelayStart', '🫸 Delay Start By', 'en', 1),
('txtHelp3DelayStart', '- *Optional.* Leave blank to start immediately. Set a number of hours, a minimum writer count, or both — the story activates when all conditions are met.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help4 keys: Creating a Story — join options and metadata
-- ---------------------------------------------------------------------------
('txtHelp4Title', '📝 Create a New Story — Join Options & Metadata', 'en', 1),
('lblHelp4CreatorOptions', 'Story Creator''s Join Options', 'en', 1),
('lblHelp4PenName', '✒️ Your Pen Name', 'en', 1),
('txtHelp4PenName', 'The story creator''s name as it will appear on the story. Defaults to your Discord display name if left blank.', 'en', 1),
('lblHelp4HideMyThreads', '🔒 Hide My Threads', 'en', 1),
('txtHelp4HideMyThreads', '- **On** — Creator''s turn threads will be private to them and server admins, regardless of the story''s thread setting.\n- **Off** — Thread visibility follows the story''s Hide Threads setting.', 'en', 1),
('lblHelp4Notifications', '💬 Notifications', 'en', 1),
('txtHelp4Notifications', '- **DM** — StoryBot will send a DM with reminders and notifications for this story.\n- **Mention** — Posts with the user mentioned will show in the story thread instead.', 'en', 1),
('lblHelp4GroundRules', '📜 Ground Rules', 'en', 1),
('txtHelp4GroundRules', 'Choose tone and conduct rules for your story from the list your server admin set up. They appear on the pinned story status post and on the join panel, so people can see what they''re agreeing to before they join.\n\nStory creators can choose or remove rules later from `/story manage` and it will post an update for everyone in the thread. Speak to the server admin about changing or adding rules, max 10 per server.', 'en', 1),
('lblHelp4Metadata', '📋 Story Metadata', 'en', 1),
('txtHelp4Metadata', 'Optional story info set via the **Metadata** sub-panel.\n- 🛡️ **Rating** — Global, Teen, Mature, Explicit, or Not Rated. M and E works may be posted to an age-restricted feed channel, or those ratings may be disabled for your server.\n- ⚠️ **Warnings** — Select all that apply: All Clear: No Content Warnings, Extreme or Visceral Violence, Main Character Fatality, Other: See Tags, Rape/Lack of Sexual Consent, Sex Involving a Minor, Unspecified: Warnings May Apply\n- 📊 **Dynamic** — General, F/F, F/M, M/M, Polyamory, or Other\n- 💞 **Main Relationship** — Primary pairing (e.g. Bilbo Baggins/Thorin Oakenshield).\n- 🫂 **Other Relationships** — Additional pairings or relationships\n- 🧑 **Characters** — Characters featured in the story.\n- 🏷️ **Tags** — Freeform tags, or tags submitted by story authors (e.g. slow burn, hurt/comfort, modern AU).\n- 📝 **Summary** — A brief teaser for your story.\n- ⁘ **Scene Break Divider**: A custom line of text (like `⁘ ⁘ ⁘` or `* * *`) used for scene breaks. Type `[[break]]` on its own line anywhere in your entry, and it''ll be replaced with this divider wherever your story is shown. If it''s not set yet, `[[break]]` will display as a reminder to set it up. It will be replaced or updated automatically when the change is saved.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help5 keys: Managing a Story
-- ---------------------------------------------------------------------------
('txtHelp5Title', '⚙️ Managing a Story', 'en', 1),
('lblHelp5WhoCanUse', '👤 Who can use `/story manage`?', 'en', 1),
('txtHelp5WhoCanUse', 'The story creator (the first writer to join), server admins, and members of the story admin role.', 'en', 1),
('lblHelp5WhatEdit', '❓ What settings can be edited?', 'en', 1),
('txtHelp5WhatEdit', '- **Story Title** — Cannot be blank.\n- **Story Mode** — Normal, Quick, or Slow.\n- **Writer Order** — Choose between Random, Round Robin, and Fixed (Join) Order.\n- **Join Status** — Close or open a story to new writers joining.\n- **Max Writers** — Cap on total writers. Leave blank for no limit.\n- **Turn Length** — Hours per turn.\n- **Reminder Timing** — Reminder interval as a percentage of total turn length. Default: 50%. Set to 0% to disable.\n- **Show Author Names** — Writer names appear on entries and in the story export if enabled.\n- **Turn Privacy** — Turn threads are only visible to the current writer (and server admins). Public turns are visible to all.\n- **Story Status** — Toggles the story status from Paused to Resumed, or Reopens a closed story. When paused, the current turn is frozen until the story status is resumed, then the turn restarts with a refreshed deadline.', 'en', 1),
('lblHelp5Closing', '🏁 Closing a Story', 'en', 1),
('txtHelp5Closing', '- Use `/story close [id]` to close a story. This posts a completion message with the full story export, ends the current turn, and closes the story to new joins, but leaves the story thread open for discussion. You can always reopen a story from the management panel.', 'en', 1),
('lblHelp5AdminControls', '🛡️ Admin Controls', 'en', 1),
('txtHelp5AdminControls', '**Manage Turns** (via the Manage Turns button in `/story manage`):\n- Skip the current turn\n- Extend the current turn deadline\n- Designate the next writer\n- Reassign the turn to the previous writer (e.g. if they missed their turn and still want to write) and set the current writer to go after them\n\n**Manage Users** (via `/storyadmin user [id] [user]`):\n- Pause or unpause a writer\n- Remove a writer from a story\n- Update a writer''s pen name\n\n**Other admin actions** (via `/storyadmin`):\n- Permanently delete a story: `/storyadmin delete`', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help6 keys: Reading and Editing
-- ---------------------------------------------------------------------------
('txtHelp6Title', '📖 Reading & Editing', 'en', 1),
('lblHelp6Read', '📖 Reading a Story', 'en', 1),
('txtHelp6Read', '`/story read [id]` — Displays the story in Discord, with longer entries broken into pages 4,000 characters or less. Each entry shows the writer''s name (if enabled on the story) and the text they submitted. Images are shown as placeholders with their alternate text. The interface will remember the last entry you read, and reopen to that page if the session times out.', 'en', 1),
('lblHelp6Edit', '✏️ Editing an Entry', 'en', 1),
('txtHelp6Edit', 'You can edit a finalized entry two ways:\n- `/story edit [id] (turn)` — If you know the turn number, it opens that entry directly. Leave it off to see a list of your entries in that story.\n- Click the **Edit** button in `/story read` that appears on the first page of each entry.\n\nWriters can edit their own entries. Admins can edit or delete any entry and restore previous versions.', 'en', 1),
('lblHelp6EditPages', '📄 Entries Split Across Pages', 'en', 1),
('txtHelp6EditPages', 'Entries longer than 3,800 characters are split into pages. Each page is edited separately — changes on one page do not affect the others. You can add up to 200 characters to a page before saving; if you need more space, save and close the edit tool, then reopen. The pages will load with the updated content.', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help7 keys: the Writer Command Reference
-- ---------------------------------------------------------------------------
('txtHelp7Title', '📋 Writer Command Reference', 'en', 1),
('txtHelp7Footer', 'Use `/story help` for detailed explanations of story modes, writer order, metadata, and more.', 'en', 1),
('lblHelp7StoryCommands', '📖 Story Commands', 'en', 1),
('txtHelp7StoryCommands', '- `/story add` — Create a new story\n- `/story edit [id] (turn)` — Edit a finalized entry; give the turn number to open that entry, or leave it off to see all your entries\n- `/story help` — Detailed guide with all writer options\n- `/story join [id]` — Join a story\n- `/story list` — Browse all stories on the server; filter by status or rating\n- `/story ping [id]` — Ping all writers in a story\n- `/story read [id]` — Read the story in Discord\n- `/story tag [id]` — Submit a suggested freeform tag to add to a story, for the story creator or admins to review\n- `/story timeleft [id]` — See how much time is left in the current turn\n- `/story write [id]` — Submit your entry *(Quick Mode only)*', 'en', 1),
('lblHelp7Dashboard', '🗂️ Your Dashboard', 'en', 1),
('txtHelp7Dashboard', '- `/mystory list` — See all your stories — active, paused, delayed, and closed\n- `/mystory catchup [id]` — Read entries written since your last turn\n- `/mystory manage [id]` — Update your settings, pass your turn, pause, or leave a story\n- `/mystory help` — This quick reference for all writer commands', 'en', 1),
('lblHelp7CreatorCommands', '⚙️ Story Creator Commands', 'en', 1),
('txtHelp7CreatorCommands', '- `/story manage [id]` — Edit story settings and metadata, manage turns and entries, pause or close', 'en', 1),

-- ---------------------------------------------------------------------------
-- Help8 keys: the three admin pages. Split out of a single page that had reached
-- 4095 of the 4096-character embed cap. Section keys keep their original Help8 names.
-- ---------------------------------------------------------------------------
('txtHelp8Title', '🔧 Server Admin Options', 'en', 1),
('txtHelp8Footer', '*All admin commands require the Manage Server permission, or the Story Admin role configured in `/storyadmin setup`*', 'en', 1),
('lblHelp8Setup', '🛠️ Setup', 'en', 1),
('txtHelp8Setup', '`/storyadmin setup` configures the Storybot system. Users with server administrator rights will see both Server Admin and Story Admin options, but users with the story admin role defined in setup will only see Story Admin options.\n\nThe setup panel has two tabs, depending on permission level:\n- **Server Admin** — Story and media channels and the Story Admin Role. Only members with Manage Server will see this tab.\n- **Story Admin** — For members of the Server Admin defined role. Sets the weekly roundup location and time, enables bot system announcements, sets server Ground Rules, and can hide mature or explicit ratings. Also displayed to Server Admins.', 'en', 1),
('lblHelp8SetupChannels', '📡 Configure Story Channels', 'en', 1),
('txtHelp8SetupChannels', '- **Story Feed Channel** — Where all story threads and activity are posted.\n\n- **Story Media Channel** — Images posted to turn threads are forwarded here for storage. Recommended to be a private channel with the Round Robin Storybot role added to Advanced Permissions. If no media channel is defined, images will not be handled in story entries.\n\n- **Restricted Story Feed and Media Channels** — Discord requires that channels containing NSFW content be age-restricted. If your server is not 18+, any story with an M or E rating will be created in or moved to these restricted channels automatically. The media channel should be private as well as restricted, with the bot''s role added in permissions. If it isn''t defined, all images will be stored in the Story Media Channel.', 'en', 1),
('lblHelp8SetupPermissions', '🔑 Story Admin Role', 'en', 1),
('txtHelp8SetupPermissions', '- Users with this role can manage stories and writers, and access the Story Admin tab of the system setup. Leave this blank, and only members with Manage Server can use admin commands.', 'en', 1),
('txtHelp9Title', '🎛️ Story Admin Options', 'en', 1),
('lblHelp8GroundRules', '📜 Ground Rules', 'en', 1),
('txtHelp8GroundRules', 'A list of options for tone and conduct rules that story creators can add to a story. Admins define the list that applies to their server, and story creators choose what rules apply to their stories. Six examples are supplied, they can be edited or removed, and up to ten can be defined. Write a short label (max 40 characters) on one line and a one-line description (max 100 characters) under it, then put a space before the next rule. Your changes will be confirmed before they are committed.', 'en', 1),
('lblHelp8TeenOrLower', '🚦 Teen or Lower Only', 'en', 1),
('txtHelp8TeenOrLower', 'Removes "Mature" and "Explicit" from the rating options everywhere stories are created or edited. Stories already rated M or E keep that rating until the metadata is edited, then it defaults to "Not Rated". A confirmation will inform you that the change will move the story''s thread out of your restricted feed and back into the main one, if applicable.', 'en', 1),
('lblHelp8SetupRoundup', '📆 Weekly Roundup', 'en', 1),
('txtHelp8SetupRoundup', 'A summary of story activity on your server can be posted each week, listing active stories and writers with a count of stories created or completed, turns submitted or missed, and words written.\n- **Roundup Channel** — Where the roundup will be posted. Leave this blank to disable.\n- **Roundup Timing** — Choose the day and hour for the summary to post: day (0 = Sunday, 6 = Saturday), hour UTC (0–23).', 'en', 1),
('lblHelp8HubAnnouncements', '📣 Storybot Hub Announcements', 'en', 1),
('txtHelp8HubAnnouncements', 'Updates and announcements from the Round Robin StoryBot Hub Server can be posted to your Story Feed Channel, so your users will hear about new features without joining the Hub server. On by default — posts are never more than monthly and more often quarterly, at most.', 'en', 1),
('txtHelp10Title', '⚙️ Other Admin Commands', 'en', 1),
('lblHelp8ManageStory', '⚙️ Story Management Panel', 'en', 1),
('txtHelp8ManageStory', '-# (All Admins and Story Creator)\n`/story manage [id]` — See "Managing a Story" (`/story help`) for more information on the Story Management Panel.', 'en', 1),
('lblHelp8ManageUser', '👤 User Management Panel', 'en', 1),
('txtHelp8ManageUser', '-# (Story Admins and Server Admins)\n`/storyadmin user [story_id] [writer]` — Manage a writer''s participation in a story: pause, remove, change their notification or privacy settings, or update their pen name.', 'en', 1),
('lblHelp8Delete', '🗑️ Delete a Story', 'en', 1),
('txtHelp8Delete', '-# (Story Admins and Server Admins)\n`/storyadmin delete [id]` — Permanently delete a story and all its data (requires confirmation)', 'en', 1),
('lblHelp8Sweep', '🧹 Sweep a Departed Writer', 'en', 1),
('txtHelp8Sweep', '-# (Story Admins and Server Admins)\n`/storyadmin sweep [user]` — Remove a user who has left the server from every active or paused story they''re in. The bot will check daily and post a reminder in the story feed channel if it finds an active writer who is no longer in the server.', 'en', 1),

-- ---------------------------------------------------------------------------
-- FAQ sync status messages
-- ---------------------------------------------------------------------------
('txtHelpFaqSyncSuccess', '✅ FAQ posts updated successfully.', 'en', 1),
('txtHelpFaqSyncNoThreads', '⚠️ No FAQ post IDs are configured. Run deploy to create them.', 'en', 1),
('txtHelpFaqSyncPartial', '⚠️ FAQ sync complete with [error_count] error(s). Check logs for details.', 'en', 1);
