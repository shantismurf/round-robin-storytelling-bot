# FAQ Page 1 — Round Robin StoryBot Overview
# Forum post title: "Round Robin StoryBot Overview" (emojis do not render in forum post titles)
# Config thread key: cfgFaqThreadOverview
# Post Order: Last — this should be oldest and sort to top of forum channel.
# ---
# NOTE: This page updates config keys with with the "Help1" prefix.
# help1 added keys
# - lblHelp1FindJoin, lblHelp1JoiningOptions, lblHelp1TurnThreadPrivacy, txtHelp1TurnThreadPrivacy, lblHelp1Notifications, txtHelp1Notifications, lblHelp1PenName, txtHelp1PenName, lblHelp1WritingYourTurn, lblHelp1WriteSlow, txtHelp1WriteSlow
# help1 removed keys
# - txtHelp1JoiningOptions, txtHelp1WriteNormalNoMedia
# help1 page keys not used for faq post
# - txtHelp1Footer, btnHelp1ToPage2
# ---
> Note: section headers below map to embed field names in the /story help command. 
> For all FAQ posts, sections are rendered sequentially as one message with headers (field names) preceeded by h2 markdown ('## ') followed by field values.
# ---
## ASSEMBLED FAQ POST CONTENT (as it will appear in Discord)
**📚 Find & Join a Story**
Use `/story list` to browse all stories, past or present. Dedicated story threads can be found by clicking the 🧵 icon in the Round Robin feed channel.

When you're ready, you can join a story in several ways:
- Use the quick join menu on `/story list`
- Type `/story join [id]`
- Pinned in each story thread is an info post with a "✍️ Join This Story" button.

**⚙️ Joining Options**
**🔒 Turn Thread Privacy** *(Normal Mode only)*
- **Public** — Threads for your turns will be visible to all.
- **Private** — Turn threads will only be visible to you and admins.

**💬 Notifications**
- **DM** — StoryBot sends DMs for turn start, reminders, and turn timeout or skip.
- **Mention in channel** — The bot will tag you about your turn in messages on the story thread.

**✒️ Pen Name** *(optional)*
- Your name as it appears on the story. If the story is configured to display names, it will show on entries and in the exported story. Defaults to your Discord display name.

**📅 Your Dashboard**
- `/mystory list` — See all your stories — active, paused, delayed, and closed.
- `/mystory catchup [id]` — Read your last entry and any written since your last turn.

**🤝 Managing Your Participation**
Use `/mystory manage` to take action on a specific story:
- Pass your current turn
- Pause or resume your participation
- Leave the story

**✍️ Writing Your Turn**
**📜 Normal Mode**
When it's your turn, you'll be notified with a link to your turn thread. Make as many posts as you like, add images in their own posts with display (alt) text (if images are enabled), and format your posts using Discord markdown for bold, italics, etc. 

Your entry won't be saved until you click Finalize. If your turn times out, all posts will be lost. Anything you post in the turn thread will be compiled for your entry. Posts from the bot or other users will not be included. If you need more time, click the button at the top of the thread to request an extension from the story creator.

**⚡ Quick Mode**
If a story is in Quick Mode, you won't get a thread for your turn. Post an entry by typing `/story write`. Entries are limited to 4,000 characters, and images are not supported. Your entry is posted immediately when you submit — there's no draft or finalize step.

**🐢 Slow Mode**
Slow Mode is just like Normal mode, with individual turn threads and the ability to upload images, if enabled. The difference is, there is no timer. Turns only end when skipped or finalized, so you can take your time and write as you are able without feeling pressured. Reminders can be configured to send every X hours, so you don't forget about the story entirely!
--- 
## Updated keys and values
('txtHelp1Title', '📖 Round Robin StoryBot Overview', 'en', 1),
('lblHelp1FindJoin', '📚 Find & Join a Story', 'en', 1),
('txtHelp1FindJoin', 'Use `/story list` to browse all stories, past or present. Dedicated story threads can be found by clicking the 🧵 icon in the Round Robin feed channel.\n\nWhen you're ready, you can join a story in several ways:\n- Use the quick join menu on `/story list`\n- Type `/story join [id]`\n- Pinned in each story thread is an info post with a "✍️ Join This Story" button.', 'en', 1),
('lblHelp1JoiningOptions', '⚙️ Joining Options', 'en', 1),
('lblHelp1TurnThreadPrivacy', '**🔒 Turn Thread Privacy** *(Normal Mode only)*', 'en', 1),
('txtHelp1TurnThreadPrivacy', '- **Public** — Threads for your turns will be visible to all.\n- **Private** — Turn threads will only be visible to you and admins.', 'en', 1),
('lblHelp1Notifications', '**💬 Notifications**', 'en', 1),
('txtHelp1Notifications', '- **DM** — StoryBot sends DMs for turn start, reminders, and turn timeout or skip.\n- **Mention in channel** — The bot will tag you about your turn in messages on the story thread.', 'en', 1),
('lblHelp1PenName', '**✒️ Pen Name** *(optional)*', 'en', 1),
('txtHelp1PenName', '- Your name as it appears on the story. If the story is configured to display names, it will show on entries and in the exported story. Defaults to your Discord display name.', 'en', 1),
('lblHelp1Dashboard', '**📅 Your Dashboard**', 'en', 1),
('txtHelp1Dashboard', '- `/mystory list` — See all your stories — active, paused, delayed, and closed.\n- `/mystory catchup [id]` — Read your last entry and any written since your last turn.', 'en', 1),
('lblHelp1ManageParticipation', '**🤝 Managing Your Participation**', 'en', 1),
('txtHelp1ManageParticipation', 'Use `/mystory manage` to take action on a specific story:\n- Pass your current turn\n- Pause or resume your participation\n- Leave the story', 'en', 1),
('lblHelp1WritingYourTurn', '**✍️ Writing Your Turn**', 'en', 1),
('lblHelp1WriteNormal', '📜 Normal Mode', 'en', 1),
('txtHelp1WriteNormal', 'When it's your turn, you'll be notified with a link to your turn thread. Make as many posts as you like, add images in their own posts with display (alt) text (if images are enabled), and format your posts using Discord markdown for bold, italics, etc. \n\nYour entry won't be saved until you click Finalize. If your turn times out, all posts will be lost. Anything you post in the turn thread will be compiled for your entry. Posts from the bot or other users will not be included. If you need more time, click the button at the top of the thread to request an extension from the story creator.', 'en', 1),
('lblHelp1WriteQuick', '⚡ Quick Mode', 'en', 1),
('txtHelp1WriteQuick', 'If a story is in Quick Mode, you won't get a thread for your turn. Post an entry by typing `/story write`. Entries are limited to 4,000 characters, and images are not supported. Your entry is posted immediately when you submit — there's no draft or finalize step.', 'en', 1),
('lblHelp1WriteSlow', '**🐢 Slow Mode**', 'en', 1),
('txtHelp1WriteSlow', 'Slow Mode is just like Normal mode, with individual turn threads and the ability to upload images, if enabled. The difference is, there is no timer. Turns only end when skipped or finalized, so you can take your time and write as you are able without feeling pressured. Reminders can be configured to send every X hours, so you don't forget about the story entirely!', 'en', 1),

> remove txtHelp1WriteNormalNoMedia logic from the help page code, it can be covered in one statement