# Plan: First-Run Experience

Status: Partially Implemented — copy changes shipped 2026-09-22; the rest designed, not built
Created: 2026-09-22
Last Updated: 2026-09-22

Stage 2 of [PLAN-sequencing-and-priorities.md](PLAN-sequencing-and-priorities.md), and the
build side of [../audits/Onboarding_Review_2026-09.md](../audits/Onboarding_Review_2026-09.md).
Designed with LeeAnn in conversation on 2026-09-22; her reasoning is recorded inline, because
the *why* is what gets lost.

**Immediate context:** an install on the Dwarrow Scholar community server (~700 members) is
agreed in principle. LeeAnn's sequencing decision is that Ground Rules, the help revamp and the
`guild_event` table all land before it goes live — plus item 1 below, which is the one first-run
fix that matters when the admin is LeeAnn herself.

---

## 1. Join button on the story creation announcement — highest priority

**Ship before the Dwarrow Scholar install.**

`announcements.js:128` posts the creation announcement to the feed channel as a plain line of
text. The Join button exists only on the pinned status embed *inside* the story thread
(`story/_storyStatus.js:263`), so a member has to already be in the thread to find the control
that gets them into the thread.

The custom ID `story_join_<storyId>` already works from a button; this is attaching an existing
handler to a second surface.

Why it outranks everything else here: every other item on this page reduces *admin* friction,
and the Dwarrow install has no admin friction because LeeAnn is the admin. The feed
announcement is what 700 members see. Without this, the experiment tests whether people will
guess a slash command rather than whether they want to write together.

## 2. Welcome post on first successful setup

**Not on `GuildCreate`.** That was proposed and rejected: most bots do not announce themselves
on join, and an admin quietly evaluating the bot does not want it broadcasting to their server.
Do not re-propose it.

LeeAnn's design instead: post to the **story feed channel, on the first successful
`/storyadmin setup` only**. That channel is the admin's own choice, so it stays private if they
made it private; the post is after they have committed rather than before; and it sits there
afterwards for members who arrive later.

The hook already exists — `handleSetupSave` computes `isFirstSetup` and already runs a
first-time-only block (where `cfgGuildRegisteredAt` is written). No new state is needed.

**It must show a story, not describe one.** LeeAnn's observation, and the most useful single
piece of evidence gathered on 2026-09-22:

> admins always create a dummy story and often delete not long after

That is not curiosity, it is a workaround for having no other way to see what the bot does. So
the post should render what a feed announcement, a turn notification and a finished entry
actually look like. If it does that well, the dummy story stops being necessary.

This is also the cheap version of item 5 — one post, no state machine. **Worth shipping first
and seeing whether it is sufficient before building the full tutorial.**

Copy not yet drafted; it needs its shape agreed first.

## 3. Story start button

Currently `CreateStory` starts the first turn unconditionally when no delay is set
(`storybot.js:113-131`), so a solo creator gets an immediate turn and a running clock for a
story nobody else can see.

LeeAnn's design: a **Start Story** button, shown *only* when no deferral criteria have been
set. If the creator has set a writer count or a time delay, those criteria already govern and a
button would be redundant.

Most of the machinery exists: `STORY_STATUS.DELAYED`, `story_delay_users`, and
`postStoryFeedActivationAnnouncement` for when a delayed story wakes up.

Add a **24-hour nudge** for a story still unstarted, so one created and forgotten does not sit
DELAYED forever. The job runner can carry it. Nothing beyond that 24-hour nudge is wanted.

## 4. Invite affordances — split in two

- **Copy-link, now.** The story thread already has a URL. A copy-link affordance on the
  creation confirmation needs no design work.
- **Community invitation, later.** LeeAnn's sketch: post an invitation to the story feed with a
  Join button, which admins can forward to interested members. Related: she runs a role on her
  own server for people who want to hear about story activity, and suggests a **Story Writer
  role** field in `/storyadmin setup` for this. Open questions she has named and not yet
  answered: who may send an invitation, how often, and whether it is opt-in per server.

**Shelved with this item, 2026-09-22.** LeeAnn's decision: the Story Writer role field stays
part of item 4 rather than being built ahead of it, since its only purpose is to give the
community invitation somebody to notify. It is not built and nothing else depends on it. The
`txtSetupRequiredAdmin` bullet advertising it comes back out of the copy — see Open
Dependencies below.

## 5. Guided tutorial

LeeAnn's idea: a `/story tutorial` of ephemeral embeds with buttons, where the admin can enter
and exit and their place is saved. Her concern was that it would have to create a real story
each time.

**It does not need to create anything.** Every panel is built from config strings, so the
tutorial can render the same components with dummy data and non-functional buttons — the same
view, no database writes, no cleanup, and it works for writers as well as admins. Saving a
reader's place is the `pendingSetupData` / `pendingStoryData` Map pattern already used
throughout.

Supersedes the two weaker variants floated in the `TODO.md` entry of 2026-08-22. Needs its own
plan file if picked up. **Build item 2 first** and find out whether this is still needed.

## 7. Setup-required message reaches every entry point — shipped 2026-09-22

The gate in `index.js` exempts `/storyadmin setup` and every `help` subcommand, so an admin who
installs the bot and goes straight to either one never saw the welcome at all — and going
straight to setup is the tidiest path through the product. LeeAnn spotted this while working out
which message was which.

`getSetupRequiredMessage(connection, interaction)` in `utilities.js` now owns the whole
decision: configured check, Manage Server split, guild-1 read, `[hubInviteUrl]` substitution.
Returns the string or null; callers prepend it to whatever they were already sending. Wired into
the `index.js` gate, `handleHelp`, `handleWriterHelp`, `handleAdminHelp` and `handleSetup`.

Deliberately **not** wired into `handleHelpSelect`, which would put the message above every help
page the reader opens.

Removed alongside: `commands/story.js` had its own unconfigured check replying with
`txtNotConfigured`. It was unreachable (the gate catches every `/story` subcommand except
`help`, and the check exempted `help` too) and the key it read was deleted by migration 010.

## 6. Copy fixes — shipped 2026-09-22

Three strings rewritten and approved. The setup-required strings now lead with what the bot is,
since the reader may not know, and none of them open on a warning triangle.

- `txtSetupRequiredAdmin` — rewritten as a welcome with the one requirement and a prerequisites
  list. LeeAnn's wording; the prerequisites are listed **because the admin has to leave the
  panel to create a channel or a role**, which the panel's own field descriptions cannot help
  with.
- `txtSetupRequiredUser` — states what the bot is and that an admin needs to finish setup,
  rather than reading as an error the member caused.
- `txtStoryAddIntro` — says only a title is required.

`index.js` was changed alongside: the setup-required call site replied with the raw config
string and never called `replaceTemplateVariables`, so the new `[hubInviteUrl]` token would
have rendered literally.

---

## Open dependencies

**`txtSetupRequiredAdmin` names a "Story Writer role" that does not exist. — Closed
2026-09-22; bullet removed.** It is item 4's notify-role field, designed on 2026-09-22 and
not built. LeeAnn's decision is to shelve the field with item 4 and take the bullet out of the
copy, leaving the Media/Image channel and Story Admin role as the two prerequisites. The copy is
committed on the working branch, which is not deployed, so nothing was ever live. She approved
the reworded paragraph and the bullet is gone.

## Sequencing

1. Item 1 (Join button) and the `guild_event` table — before the Dwarrow Scholar install.
2. Ground Rules and the help revamp — LeeAnn's condition for going live.
3. Item 2 (welcome post), then reassess whether item 5 is still wanted.
4. Items 3 and 4 as capacity allows.
