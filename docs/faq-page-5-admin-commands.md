# FAQ Page 5 — StoryAdmin Commands
# Forum post title: "⚙️ StoryAdmin Commands"
# Config thread key: cfgFaqThreadAdminCmds
# Post 1st (posted first so it sorts below the others in the forum channel).
# ---
# NOTE: This page updates config keys with with the "AdminHelp" prefix.
# ---

## ASSEMBLED FAQ POST CONTENT (as it will appear in Discord)

**🛠️ Setup**
- `/storyadmin setup` — This command must be run before the bot can function, but it's also used to update system settings.
> **📡 Configure Story Channels**
> - **Story Feed Channel** — Central hub where all story threads and activity are posted.
> - **Media Channel** — Images posted to Normal or Slow Mode stories are forwarded here for long-term storage. Leave blank to disable images for your server. *Recommended admin-only.*
> - **Restricted Feed Channel** — Age-restricted channel for stories rated Mature or Explicit in non-18+ servers.
> - **Restricted Media Channel** — Private, age-restricted storage for mature story images. *Recommended admin-only.*
> 
> **🔑 Permissions**
> - **Admin Role** — This is the role that can manage stories and writers in the bot. Leave this blank to limit access to server Admins.
> 
> **📆 Weekly Roundup**
> The weekly roundup is a summary of the story activity on your server. It lists active stories and writers, and gives a count of stories created or completed, turns submitted or missed, and words written. 
> - **Roundup Channel** — Set the channel where the roundup will be posted, or leave this field blank to disable the weekly post.
> - **Roundup Timing** — Choose the day and hour you'd like the summary to post: day (0 = Sunday, 6 = Saturday), hour UTC (0–23).

**⚙️ Story Management Panel** *(admin or story creator)*
- `/story manage [id]` — See "Managing a Story" (`/story help`) for more information on the Story Management Panel.

**👤 User Management Panel** *(admin only)*
- `/storyadmin user [story_id] [writer]` — Manage a writer's participation in a story: pause, remove, change their notification or privacy settings, or update their pen name.

**🗑️ Delete a Story** *(requires confirmation)*
- `/storyadmin delete [id]` — Permanently delete a story and all its data

*All admin commands require the Discord Administrator permission, or the Round Robin admin role configured in `/storyadmin setup`*

---
