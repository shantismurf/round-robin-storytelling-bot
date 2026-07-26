# FAQ Page 2 — Create a New Story
# Forum post title: "Create a New Story" (strip emoji and everything from the emdash to end from forum post title only)
# Config thread key: cfgFaqThreadStoryCreation
# Post Order: 4th (second-to-last before Overview).
# ---
# NOTE: This page updates config keys with with the "Help2" prefix.
# ---
## ASSEMBLED FAQ POST CONTENT (as it will appear in Discord)
**Story Title**
- ⚠️ *Required.*

**Story Mode**
- 🟢 **Normal** — Writers get a private or public thread for each turn.
- 🟣 **Quick** — Writers submit entries via `/story write`.

**Writer Order**
- 🎲 **Random** — Next writer chosen at random each turn.
- 🔄 **Round Robin** — Rotates randomly, but no repeats until everyone has had a turn.
- 📋 **Fixed Order** — Writers take turns in join order.

**Turn Length**
- ⌛ How many hours each writer has per turn. Default: 24h.

**Reminder Timing**
- ⏰ Send a reminder to the current writer after X% of their turn has elapsed. Default: 50%. Set to 0% to disable. (Example: 50% of a 24hr turn means the reminder is sent after 12hrs.)

**Turn Thread Privacy** *(only applies to Normal Mode stories)*
- 👀 **Public** — Threads for all turns will be visible to all members of your server.
- 🫣 **Private** — Turn threads will only be visible to the writer and server admins.

**Show Author Names**
- 📑 **Yes** — Writer names appear on entries in Discord and in the export file.
- 📄 **No** — Entries are posted and exported anonymously. Writer names still appear in story messages.

**Max Writers**
- #️⃣ Optional. Leave blank for no limit.

**Delay Start By**
- 🫸 Leave blank to start immediately. Set a number of hours, a minimum writer count, or both — the story activates when all conditions are met.

**Story Creator's Join Options**
**Your Pen Name**
- ✍️ Your name as it will appear on the story. Used in story exports. Defaults to your Discord display name if left blank.

**Hide My Threads**
- 🔒 **On** — Your turn threads will be private to you and admins, regardless of the story's thread setting.
- 🌐 **Off** — Your thread visibility follows the story's Hide Threads setting.

**Notifications**
- 💬 **DM** — StoryBot will send you a DM when your turn starts.
- 📢 **Mention** — You'll be mentioned in the story thread instead.

**📋 Story Metadata**
Optional story info set via the **Metadata** sub-panel.
- 🛡️ **Rating** — Global, Teen, Mature, Explicit, or Not Rated. M and E works may be posted to an age-restricted feed channel.
- ⚠️ **Warnings** — Select all that apply: All Clear: No Content Warnings, Extreme or Visceral Violence, Main Character Fatality, Other: See Tags, Rape/Lack of Sexual Consent, Sex Involving a Minor, Unspecified: Warnings May Apply
- 📊 **Dynamic** — General, F/F, F/M, M/M, Polyamory, or Other
- 💞 **Main Relationship** — Primary pairing (e.g. Bilbo Baggins/Thorin Oakenshield).
- 🫂 **Other Relationships** — Additional pairings or relationships
- 🧑 **Characters** — Characters featured in the story.
- 🏷️ **Tags** — Freeform tags, or tags submitted by story authors (e.g. slow burn, hurt/comfort, modern AU).

*After story creation, these settings can be edited by admins or the story creator via `/story manage`.*