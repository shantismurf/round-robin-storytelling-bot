# Reactions Kudos

Status: Idea — flagged 2026-09-22 as worth revisiting; still needs a resolved design
Created: 2026-07-01
Last Updated: 2026-09-22

Extracted verbatim from TODO.md's "Future features" stub — brainstorm-level, not yet a resolved design.

---

- I also want to make a reaction system where people can leave one of five or six reactions on any of the bot's posts, and after a minute (so people can add or take away as needed) it will repost them as a post in the story feed, so when a user posts an entry and someone reacts with "😍 ", after a minute it will make a post that says "[user] sent 😍 on [post title, linked]"
- I'm thinking 👍😍 🤣 😭 🫣 🔥
- any other reactions on those posts won't be reposted, in cases of potential abuse on user installs
- I'm not sure if its best just to have the posts load with the reactions so people can add to them, or have a small line of instructions
- preloading is likely to get more engagement, but might look odd?
- commenting on story activity seems like it's already a natural part of the process

---

## Could this carry reporting? — raised 2026-09-22

LeeAnn asked whether the reaction system could double as a low-key way for a writer to flag a
problem, a thumbs-down being the obvious candidate. She named her own hesitation in the same
breath: negative reactions have gone badly on social platforms generally, and she does not want
that dynamic here.

**Her hesitation is the right instinct, and the design above is why.** Reactions in this plan
are *reposted to the story feed* — "[user] sent 😍 on [post title]". A thumbs-down would inherit
that: a public, attributed, counted negative signal broadcast to everyone reading the feed. It
would also be unreadable. There is no way to tell "this broke a ground rule" from "I didn't
care for this scene," so an admin could not act on it and the writer who received it would only
know that somebody, publicly, disliked their work.

The reaction set she chose — 👍😍🤣😭🫣🔥 — is entirely positive. That is a coherent design
decision, not an oversight, and it should stay that way.

**Reporting wants the opposite properties: private, directed, and specific.** Sketch, not a
resolved design:

- A message context-menu command (Apps → Report to StoryBot) on an entry. No visible UI on the
  post, so nothing signals to a reader that reporting exists until they go looking, and nothing
  accumulates a public count.
- It opens an ephemeral modal: which ground rule, optional note.
- It delivers to the story admin — and, where the guild has one configured, the log channel —
  never to the feed and never to the reported writer.

This is a separate feature from kudos and should not be folded into it. It belongs with the
block/ban work in `TODO.md`, since a report with no available response is worse than no report
at all.
