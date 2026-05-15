# FAQ Page 3 — Managing a Story
# Forum post title: "Managing a Story"
# Config thread key: cfgFaqThreadManaging
# Post Order: 3rd.
# ---
# NOTE: This page updates config keys with with the "Help3" prefix.
# ---
## ASSEMBLED FAQ POST CONTENT (as it will appear in Discord)
**Who can use /story manage?**
The story creator (the first writer to join) and server admins.

**What settings can be edited?**
- **Story Title** 
- **Writer Order** — Choose between Random, Round Robin, and Fixed (Join) Order.
- **Join Status** — You can close or open a story to new writers joining.
- **Max Writers** — Cap on total writers. Leave blank for no limit.
- **Turn Length** — hours per turn
- **Reminder Timing** — a percentage of the total turn time when reminders will be sent, or 0% to disable. (Example: 50% of a 24hr turn means the reminder is sent after 12hrs.)
- **Show Author Names** — Writer names appear on entries and in the story export if enabled.
- **Turn Privacy** — Turn threads are only visible to the current writer (and server admins). Public turns are visible to all.
- **Story Status** — Toggles the story status from Paused to Resumed, or Reopens a closed story. When paused, the current turn is frozen until the story status is resumed, then the turn restarts with a refreshed deadline.

**📋 Metadata Panel**
- 📊 **Dynamic** — General, F/F, F/M, M/M, Polyamory, or Other
- 🛡️ **Rating** — Global, Teen, Mature, Explicit, or Not Rated. M and E works may be posted to an age-restricted feed channel.
- ⚠️ **Warnings** — Select all that apply: All Clear: No Content Warnings, Extreme or Visceral Violence, Main Character Fatality, Other: See Tags, Rape/Lack of Sexual Consent, Sex Involving a Minor, Unspecified: Warnings May Apply
- 💞 **Main Relationship** — Primary pairing (e.g. Bilbo Baggins/Thorin Oakenshield).
- 🫂 **Other Relationships** — Additional pairings or relationships
- 🧑 **Characters** — Characters featured in the story.
- 🏷️ **Tags** — Freeform tags, or tags submitted by story authors (e.g. slow burn, hurt/comfort, modern AU).
- 📝 **Summary** — A brief teaser for your story.

**Closing a Story**
- Use `/story close [id]` to permanently close a story. This posts a completion message with the full story export and ends the current turn, but leaves the story thread open for discussion. This cannot be undone.

**Admin Controls**
**Manage Turns** (via the Manage Turns button in `/story manage`):
- Skip the current turn
- Extend the current turn deadline
- Designate the next writer
- Reassign the turn to the previous writer (e.g. if they missed their turn and still want to write) and set the current writer to go after them

**Manage Users** (via `/storyadmin user [id] [user]`):
- Pause or unpause a writer
- Remove a writer from a story
- Update a writer's pen name

**Other admin actions** (via `/storyadmin`):
- Permanently delete a story: `/storyadmin delete`

---