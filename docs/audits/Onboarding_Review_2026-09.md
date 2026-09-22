# New Admin Onboarding Review — 2026-09-22

Status: Findings only, nothing implemented
Created: 2026-09-22
Last Updated: 2026-09-22

Scope: the path a first-time server admin walks, from clicking "Add to Server" through to a
story running with more than one writer. Triggered by the observation that writing and
fanfiction servers — the best-fit audience — install and uninstall almost immediately.

**There is no analytics or funnel instrumentation in this codebase.** Everything below marked
*Code* is read directly from source. Everything marked *Inferred* is reasoning about what a
user would experience, and is not backed by data. LeeAnn's own account of the observed
sequence is recorded below and treated as the strongest available evidence.

## Observed sequence (LeeAnn, 2026-09-22)

> most people install, try to start a story or maybe look at help, then run storyadmin setup,
> they might start a story, and then uninstall.

That sequence is the spine of this review. It says the setup wall is the *first* thing they
meet, that setup itself is survivable (they complete it), and that the drop-off happens at or
immediately after creating a first story.

---

## 1. The story gets created into an empty room — no way for anyone else to find it

**This is the one I would fix first.** It lands exactly where the observed sequence says people
quit, and it is the difference between "a bot that writes stories with my server" and "a bot
that gave me a private notepad."

*Code:*

- `announcements.js:128` — the story-creation announcement posted to the feed channel is a
  plain text line: `# 📚 New Story Created by <name>: "<title>" <rating>` plus a metadata
  subline. No button, no mention, no ping, no role tag.
- `story/_storyStatus.js:263` — the **Join This Story** button exists, but it is attached to
  the pinned status embed *inside the story thread*. A member has to already be in the thread
  to see the affordance that gets them into the thread.
- Grepped the whole repo for any invite/recruit/share affordance aimed at bringing other
  writers to a new story: there is none. Not in `story/add.js`, not in the creation
  announcement, not in the creator tip (`txtStoryThreadCreatorTip`, `config_turn.sql:50`),
  which only says "use `/story manage` to add a summary, tags, and adjust settings."

*Inferred:* the admin has almost certainly just created a brand-new `#stories` channel for the
bot during setup. Nobody in the server is watching it. The story exists, the admin is the only
writer, and nothing in the product ever suggests that inviting people is the next step.

**What I would change**

- Put the Join button on the feed-channel creation announcement, not only on the in-thread
  status embed. It is the same `story_join_<id>` custom ID that already works from a button.
- After a story is created, show the creator a short "invite writers" step: a copyable link to
  the story thread, and an optional role/`@here` ping into the feed channel that the admin
  chooses to send (do not send it automatically — an unsolicited `@here` on day one is its own
  uninstall reason).
- Consider a first-story-only nudge in the feed channel explaining what the channel is for, so
  members who wander in have context.

## 2. Nothing at all happens when the bot joins the server

*Code:* `index.js:165` — `GuildCreate` logs the join and calls `scheduleOnboardingReminders`.
That is the entire handler. No message is posted anywhere in the new server.

*Code:* `index.js:212-222` — every command is then blocked until `cfgStoryFeedChannelId` is
set, except `/storyadmin setup` and any `help` subcommand. The block message is
`txtSetupRequiredAdmin` (`config_storyadmin.sql:8`):

> ⚠️ **Round Robin StoryBot has not been configured for this server.** Please run
> `/storyadmin setup` to set the story feed channel and admin role before using any other
> commands.

So the admin's genuine first interaction with the product is a warning triangle telling them
they did it wrong. The observed sequence confirms this is where they land.

*Code:* `utilities.js:298` — "configured" means one thing only: a feed channel ID exists.

**What I would change**

- On `GuildCreate`, post a short welcome into the best channel the bot can write to (system
  channel, else first writable text channel), naming what the bot does in one line and what
  the single next step is. This is the cheapest high-value change in this document.
- Soften `txtSetupRequiredAdmin`. It is currently phrased as an error about a mistake. It
  should read as a first step, not a violation — and it should say the setup takes one
  required field.

## 3. Creating a story immediately starts a turn on the creator, alone, with a clock

*Code:* `storybot.js:113-131` — `CreateStory` adds the creator as first writer, then, if the
story is not delayed, calls `PickNextWriter` and `NextTurn` unconditionally. With one writer,
that writer is the creator.

*Code:* `story/add.js:55` — default `turnLength` is 24 hours. `story/_turn.js:263` posts a
welcome into a new private turn thread; `handleWriterNotification` DMs them.

*Inferred:* an admin who was kicking the tires now has a live deadline, a per-turn thread, and
a DM, for a story nobody else can see, in which they are both writers. If they do write an
entry, the round-robin hands the next turn straight back to them. There is nothing in the
product that says "you probably want other people before you start."

**What I would change**

- When a story is created with one writer, do not silently start the clock. Either hold it in
  the existing `DELAYED` state (`story_delay_users` already implements "wait for N writers" —
  `storybot.js:38`, `story/_delay.js`) and say so, or start it but lead the confirmation with
  the invite step from finding 1.
- The **Delay Start** setting already does exactly the right thing and is buried in the
  settings modal as `0 hours / 0 writers`. Defaulting a first story to "wait for 1 more writer"
  would change the shape of the first experience with almost no new code.

## 4. The create panel asks for roughly fifteen decisions before the Create button

*Code:* `story/_metadataModals.js:117-240`, `story/add.js:47-76`. The Settings tab shows Title,
Summary, Mode, Writer Order, Show Authors, Turn Privacy, Scene Break Divider, Rating, Turn
Length, Timeout Reminder, Delay Start, Max Writers, Pen Name, Join Privacy, Notifications. The
Metadata tab adds Dynamic, Warnings, Main Relationship, Other Relationships, Characters, Tags.

Only Title is actually required (`story/add.js:133` validates it; everything else has a
default in the state object). But nothing tells the admin that. `txtStoryAddIntro`
(`config_story.sql:55`) says "Configure your story settings with the buttons below, then click
Create Story when ready," which reads as an instruction to fill it all in.

*Inferred:* for a fanfiction admin this panel is legible — the AO3 vocabulary is deliberate and
it is a real strength of the product. For a general writing server it is a wall. Either way,
the cost is paid before any value has been seen.

**What I would change**

- Change the intro copy to say plainly that only a title is required and everything else has a
  sensible default that can be changed later with `/story manage`. One config string.
- The existing TODO item "Guided first-run onboarding" (`docs/TODO.md:116`) covers the larger
  version of this. The copy change is the cheap half and does not depend on it.

## 5. Finishing setup can end on a wall of permission warnings

*Code:* `commands/_storyadminSetup.js:526-557` — after save, the bot checks ten permissions on
the feed channel (View Channel, Send Messages, Embed Links, Attach Files, Read Message History,
Manage Messages, Pin Messages, Create Public Threads, Create Private Threads, Manage Threads)
and four on the media channel, and lists every missing one in a single ⚠️ block.

Two problems:

- It is all-or-nothing. Missing **Manage Messages** or **Pin Messages** degrades a cosmetic
  detail; missing **Create Public Threads** means no story can ever exist. The admin cannot
  tell those apart from the message.
- The self-heal at `_storyadminSetup.js:478` writes channel overwrites for the bot's managed
  role, which only works if the bot already has **Manage Roles** (`INSTALL.md` Step 2). An
  admin who stripped permissions at invite time gets warnings as their reward for completing
  setup.

*Inferred:* this is a plausible second uninstall trigger for the subset who strip permissions
on install, which security-conscious writing-server admins routinely do.

**What I would change**

- Split the warning into "the bot cannot run stories without these" and "these are optional and
  here is what you lose." Only the first should look alarming.
- When Manage Roles is missing, say that specifically, since it is the reason the automatic fix
  did not work.

## 6. The day-1 nudge is a DM, to the guild owner, not the installer

*Code:* `job-runner.js:533-548` — `handleOnboardingReminder` fetches `guild.fetchOwner()` and
DMs them at day 1, 7 and 14. `job-runner.js:550-566` DMs at day 30 and then calls
`guild.leave()`.

Two gaps, both *Inferred*: the guild owner is frequently not the person who installed the bot,
and bot DMs are blocked by default in many servers' privacy settings. `owner.send(...)` has no
catch around it at the call site (the caller in `index.js:167` catches, but a failed DM is
indistinguishable from a delivered one in the logs).

*Code, worth knowing:* the day-30 job makes the bot **leave** any guild still unconfigured.
Some fraction of what looks like "they uninstalled" may be the bot removing itself.

**What I would change**

- Send the day-1 nudge into the server (the same channel the welcome from finding 2 would use)
  as well as, or instead of, the owner DM, and log the DM outcome explicitly.

## 7. Instrumentation — there is no funnel, and it is cheap to add

LeeAnn raised this herself. Confirming what exists: `log()` already fires at every relevant
step, and `show: true` entries are duplicated to the hub `#logs` channel, but they are prose in
a console stream — not queryable, and not retained across restarts.

`admin_action_log` (`db/init.sql:106`) exists but has no `guild_id` column and is scoped to
admin actions on stories, so it is the wrong table to overload.

**What I would change**

- Add a small `guild_event` table (`guild_id`, `event_type`, `user_id`, `created_at`, optional
  JSON detail) and write one row at each funnel step that already exists in code:
  `guild_joined` (`index.js:165`), `setup_opened` (`handleSetup`), `setup_saved`
  (`handleSetupSave`, which already computes `isFirstSetup`), `story_created` (`CreateStory`),
  `turn_finalized` (`_writeFinalize.js`), `writer_joined` (`StoryJoin`), `guild_left`
  (`GuildDelete`). Roughly seven insert calls and one migration.
- That turns "writing servers bounce" from an impression into a measurable drop-off point, and
  every recommendation in this document becomes testable rather than argued.

## 8. Smaller things found along the way

- `INSTALL.md` is written entirely for self-hosters (Node, MariaDB, bot token, `config.json`).
  There is no document aimed at an admin adding the hosted bot to their server. The Hub FAQ
  covers usage, not install. *Inferred:* an admin who goes looking for docs finds instructions
  for a completely different task.
- `INSTALL.md` Step 2 says Create Private Threads "requires server boost level 2+". Discord
  removed that requirement in 2022. *Inferred* from the date, not verified against current
  Discord docs — worth a check before relying on it.
- Hardcoded English in two user-facing places, against the project's zero-hardcoding standard:
  the setup save confirmation (`_storyadminSetup.js:569-580`, "✅ Story feed channel:",
  "⚠️ Bot is missing permissions on...") and the creation announcement
  (`announcements.js:101-128`, "Quick"/"Normal"/"Slow", "Random"/"Round-Robin"/"Fixed",
  "Open"/"Closed", "Writers", "New Story Created by").
- Setup's save confirmation ends with "Need help? Join our support server" and no next step.
  There is no "now create your first story with `/story add`" anywhere in it.
- `commands/story.js:165-171` re-checks `isGuildConfigured` and replies with `txtNotConfigured`,
  but `index.js:212` already gates every non-help subcommand first, so that branch and that
  config key appear to be unreachable for `/story`. Harmless, but it means there are two
  different strings for the same wall and only one of them is ever seen.
- `cfgAdminRoleName` is free text matched by exact string. A typo silently grants nothing; the
  code already notes this at `_storyadminSetup.js:513` and logs it rather than telling the
  admin.

## Suggested order of work

1. Join button on the feed announcement + an invite step after story creation (finding 1).
2. Welcome message on `GuildCreate` (finding 2).
3. `guild_event` funnel table (finding 7) — do this early, so 1 and 2 can be measured.
4. Do not start a solo story's clock silently (finding 3).
5. Copy fixes: setup-required wording, "only a title is required", a next step on the setup
   confirmation (findings 2, 4).
6. Split the permission warnings into fatal and optional (finding 5).
7. Day-1 nudge into the server rather than only an owner DM (finding 6).
