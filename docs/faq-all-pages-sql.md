# Page 1
('txtHelp1Title', '📖 Round Robin StoryBot Overview', 'en', 1),
('txtHelp1Footer', 'Page 1 of 3 · Story IDs appear in /story list and in story thread titles.', 'en', 1),
('txtHelp1FindJoin', 'Use `/story list` to browse all of the stories on the server, past or present. Stories have dedicated threads for all of their activity, and those can be found by clicking the 🧵 icon in the Round Robin feed channel.\n\nWhen you''re ready, you can join a story in several ways:\n- Use the quick join menu on `/story list`\n- Type `/story join [id]`\n- Navigate to the story thread and click the "✍️ Join This Story" button on the pinned story info post at the top of the thread.', 'en', 1),
('txtHelp1JoiningOptions', '**Turn Thread Privacy** *(only applies to Normal Mode stories)*\n- 🌐 **Public** — Threads for your turns will be visible to all members of your server.\n- 🔒 **Private** — Turn threads will be private and only visible to you and server admins.\n\n**Notifications**\n- 💬 **DM** — StoryBot will send you a DM for turn start, reminders, and turn timeout or skip.\n- 📢 **Mention in channel** — You will be tagged in messages from the bot posted in the story thread.\n\n**Pen Name** *(optional)*\n- ✍️ The name that will appear on the list of writers on the story. If the story is configured to display names, it will also show on entries and in the exported story. This field fills in your Discord display name by default.', 'en', 1),
('txtHelp1Dashboard', 'Use `/mystory list` to see all the stories you''ve joined — active, paused, delayed, and closed.', 'en', 1),
('txtHelp1ManageParticipation', 'Use `/mystory manage` to take action on a specific story:\n- Pass your current turn\n- Pause or resume your participation\n- Leave the story', 'en', 1),
('txtHelp1WriteNormal', 'When it''s your turn, you''ll be notified with a link to your turn thread. Type as many posts as you like, add images in their own posts with display (alt) text (if images are enabled on your server), and format your posts using Discord markdown for bold, italics, etc. If you want to review the entries in the story since you last wrote, use `/mystory catchup` to see your last entry and the entries since.\n\nYour entry won''t be posted until you click Finalize — you can revise as much as you like first. *All* of your posts in the turn thread will be compiled for your entry, so make sure you delete any of your own chatter before finalizing. Posts from the bot or other users will not be included. If you need more time, you can click a button on the first post in the thread to request an extension from the story creator.', 'en', 1),
('txtHelp1WriteQuick', 'If a story is in Quick Mode, you won''t get a thread for your turn. You can post an entry by typing `/story write`. Entries are limited to 4,000 characters, and images are not supported. Your entry is posted immediately when you submit — there''s no draft or finalize step.', 'en', 1),

# Page 2
('txtHelp2Title', '📝 Create New Story — Option Reference', 'en', 1),
('txtHelp2Footer', 'Page 2 of 3 · After story creation, these settings can be edited by admins or the story creator via `/story manage.`', 'en', 1),
('txtHelp2StoryTitle', '- ⚠️ *Required.*', 'en', 1),
('txtHelp2MaxWriters', '- #️⃣ Optional. Leave blank for no limit.', 'en', 1),
('txtHelp2TurnLength', '- ⌛ How many hours each writer has per turn. Default: 24h.', 'en', 1),
('txtHelp2StoryMode', '- 🟢 **Normal** — Writers get a private or public thread for each turn.\n- 🟣 **Quick** — Writers submit entries via `/story write`.', 'en', 1),
('txtHelp2WriterOrder', '- 🎲 **Random** — Next writer chosen completely at random each turn.\n- 🔄 **Round Robin** — Rotates randomly, but no one repeats until everyone has had a turn.\n- 📋 **Fixed Order** — Writers take turns in a fixed sequence based on join order.', 'en', 1),
('txtHelp2HideThreads', '- 🥷 **On** — Turn threads are private to the current writer and admins only.\n- 🤡 **Off** — Turn threads are visible to all server members.', 'en', 1),
('txtHelp2ShowAuthors', '- 📑 **Yes** — Writer names appear on entries in Discord and in the export file.\n- 📄 **No** — Entries are posted and exported anonymously.', 'en', 1),
('txtHelp2TimeoutReminder', '- ⏰ Send a reminder to the current writer after X% of their turn has elapsed. Default: 50%. Set to 0% to disable.', 'en', 1),
('txtHelp2DelayStart', '- 🫸 Leave blank to start immediately. Set a number of hours, a minimum writer count, or both — the story activates when all conditions are met.', 'en', 1),
('txtHelp2CreatorOptions', '**Your Pen Name**\n- ✍️ Your name as it will appear on the story. Used in story exports. Defaults to your Discord display name if left blank.\n\n**Keep My Turns Private**\n- 🔒 **Yes** — Your turn threads will only be visible to you and admins.\n- 🔓 **No** — Your turn threads will be visible to other writers.', 'en', 1),

# Page 3
('txtHelp3Title', '⚙️ Managing a Story — /story manage', 'en', 1),
('txtHelp3Footer', 'Page 3 of 3', 'en', 1),
('txtHelp3WhoCanUse', 'The story creator (the first writer to join) and server admins.', 'en', 1),
('txtHelp3WhatEdit', '**Story settings** (via `/story manage`):\n- **Turn Length** — How many hours each writer has per turn.\n- **Timeout Reminder** — What % into a turn to send the writer a reminder. Set to 0% to disable.\n- **Max Writers** — Cap on total writers. Leave blank for no limit.\n- **Open to New Writers** — Allows new writers to join.\n- **Show Author Names** — Writer names appear on entries and in the story export if enabled.\n- **Writer Order** — Choose between Random, Round Robin, and Fixed (Join) Order.\n- **Turn Privacy** — Private turns are only visible to the current writer (and admins via channel permissions). Public turns are visible to all.\n- **Summary** — A freeform description used in story exports.\n- **Tags** — Comma-separated tag list used in story exports.\n\n**Entry content** — Use `/story edit [id]` to edit the text of a finalized entry. Writers can edit their own entries; admins can edit any.', 'en', 1),
('txtHelp3PauseResume', '- Sets the story status to paused (freezing the current turn) or resumes a paused story. Resuming starts the next turn automatically if no turn is currently active.\n- Use the button in `/story manage` to pause or resume.', 'en', 1),
('txtHelp3Closing', '- Use `/story close [id]` to permanently close a story. This posts a completion message with the full story export and ends the current turn, but leaves the story thread open for discussion. This cannot be undone.', 'en', 1),
('txtHelp3AdminControls', '- Skip the current turn\n- Extend the current turn\n- Set the writer who will be selected when the next turn starts\n- Remove a writer from a story\n- Delete a story', 'en', 1),

# Page 


# Page 
