# Marketing & Listing Plan

Status: Draft — not approved, nothing implemented
Created: 2026-09-22
Last Updated: 2026-09-22

Companion to [../audits/Onboarding_Review_2026-09.md](../audits/Onboarding_Review_2026-09.md).
That review covers the funnel from install to a running story. This one covers everything
before the install, plus how to tell whether any of it worked.

**No analytics exist yet.** Every number claimed here is either LeeAnn's direct observation or
marked as an inference. The measurement section is a prerequisite for the rest, not an
afterthought.

## The two funnels

Treat these separately and never credit a fix in one to the other.

| Funnel | Span | Known state |
|---|---|---|
| A — Acquisition | Someone hears about the bot → the bot is in their server | top.gg staff pick last quarter produced **zero real installs** (LeeAnn, 2026-09-22). The one install it did produce was top.gg's own staff adding the bot to the top.gg server; they never configured it, and uninstalled when asked to. |
| B — Activation | Bot installed → a story running with more than one writer | Admins reach `/storyadmin setup` and often create a story, then uninstall. Almost nobody reaches a multi-writer story. |

Funnel A is currently the binding constraint. Funnel B fixes are still worth doing — they are
cheap and several are one-line copy changes — but they act on very little traffic until A
improves.

**The strongest single data point available:** a top.gg staff pick, the best placement that
site offers, produced no genuine installs at all. Its only measurable effects were a
misleading server count and a Discord privileged-intents application LeeAnn then had to
complete. That is not a listing that underperformed; that is a channel that did not contain
the audience. Part 2 is therefore the priority, not Part 1.

## Part 1 — The top.gg listing

Current state as of 2026-09-22 (https://top.gg/bot/1305619403290841229):

- Tagline: "A robust collaborative writing bot and story relay game."
- Long description opens: "Round Robin StoryBot runs collaborative relay-style stories where
  writers take turns contributing entries."
- **Text-only. No screenshots, no GIF, no banner.**
- Tags are well targeted: fanfiction, creative writing, Fandom, relay, writing community.
- Displayed server count (2) is not meaningful — it reflects top.gg's own staff install, since
  removed, and has not updated.

**Scope note:** the evidence above says top.gg is the wrong room, not that the listing is badly
written. Do the cheap items here because they are reusable elsewhere (the screenshots and the
rewritten copy both feed Part 3's install doc and any other channel), not in the expectation
that a better top.gg page produces installs.

### 1a. Add screenshots — highest value, lowest effort

*Inferred, but with high confidence:* on a bot listing, images convert and prose does not, and
this bot is unusually hard to picture from a description. "Writers take turns contributing
entries" fits a dozen different products.

Minimum set, in order:

1. A story thread with three or four entries in it, showing the formatting and author
   attribution — this is the product.
2. The turn notification a writer receives.
3. The pinned story status embed, showing the writer list and the Join button.
4. Optionally the `/story add` panel, to signal depth — but only after the panel-simplification
   work, or it reads as complexity rather than power.

An animated GIF of one turn changing hands would outperform all four, if it is cheap to make.

### 1b. Rewrite the tagline and opening line

*"Robust"* is a word developers use about their own work. It occupies the highest-value
position on the page and tells a writing-server admin nothing. The opening line has the same
problem: it describes the mechanism, not what the server gets.

Both need to lead with the outcome — a story your server writes together, one turn at a time —
rather than the machinery. **Exact copy to be written and approved by LeeAnn** (project standard:
no user-facing text ships without her sign-off).

### 1c. Explain the permissions on the listing

The invite requests twelve permissions:

```
https://discord.com/oauth2/authorize?client_id=1305619403290841229
  &permissions=2252195219237888&integration_type=0&scope=applications.commands+bot
```

Decoded: View Channel, Send Messages, Send Messages in Threads, Manage Messages, Embed Links,
Attach Files, Read Message History, Manage Roles, Manage Threads, Create Public Threads,
Create Private Threads, Pin Messages.

Two observations:

- **The scoping is correct.** It grants exactly the ten permissions `handleSetupSave` checks on
  the feed channel, plus Manage Roles (needed for the setup self-heal) and Send Messages in
  Threads. An admin who accepts the defaults should see a clean setup result.
- **Manage Roles and Manage Messages are what a cautious admin reads first.** *Inferred:*
  fanfiction and writing servers skew privacy- and moderation-conscious, and a writing bot
  asking to manage roles and delete messages, with no explanation on the consent screen, is a
  plausible bounce before install ever happens. These admins would never appear in any
  install-side metric.

Add a short "why each permission" note to the listing description and to whatever admin-facing
install doc comes out of Part 3. Manage Roles in particular deserves one line: it is used once,
during `/storyadmin setup`, to grant the bot access to the story channel, and nothing else.

Worth deciding separately: whether to drop Manage Roles from the default invite and let setup
fall back to asking the admin to set channel permissions by hand. `txtSetupBotPermsFix` already
tells them how. That trades a scarier consent screen for a longer setup.

## Part 2 — Where the audience actually is

*Partly evidenced, partly inference. The top.gg result is real evidence. Which channel to use
instead is inference and should be tested one at a time.*

The tags on the listing are already pointed at the right people, and it still produced nothing.
The likeliest explanation is not bad copy but audience: bot directories are browsed by admins
shopping for moderation, music, economy and leveling bots. A collaborative writing bot is a
product whose buyers are not browsing bot directories at all — they are in writing communities,
and they do not yet know a tool like this exists. This needs a push channel, not a pull one.

Candidate channels, cheapest first:

- **Existing collaborative-writing and roleplay Discord servers.** The bot's own Hub server is
  the template. These communities already run relay stories by hand, in plain channels, with a
  human tracking whose turn it is. That is the pitch: you are already doing this, badly.
- **Fanfiction communities off Discord** — r/FanFiction, tumblr writing circles, AO3-adjacent
  spaces. The AO3 vocabulary in the metadata panel (ratings, warnings, relationships,
  characters, tags) is a genuine differentiator here and is currently invisible to anyone who
  has not installed the bot. It is the strongest thing the product has for this audience.
- **Writing events** — NaNoWriMo-adjacent communities, Camp NaNo, writing sprints servers.
  Seasonal, so timing matters.
- **Other bot listing sites** — discord.bots.gg, discordbotlist.com. Low effort, low expected
  return, but the listing content from Part 1 is reusable verbatim.

The honest framing: one story, publicly visible, written by a real server, is worth more than
any listing copy. An exported HTML story from an active server would be the single best
marketing asset this project could have — and the export feature already exists.

## Part 3 — An admin-facing install doc

`INSTALL.md` is written entirely for self-hosters (Node, MariaDB, bot token, `config.json`).
There is no document for someone adding the hosted bot to their server. *Inferred:* an admin
who goes looking for documentation finds instructions for a completely different task and
concludes the bot is not for them.

Needs a short page — Hub FAQ, listing description, or repo — covering: what the bot does, the
permissions and why, the one required setup field, and how to get a second writer into a story.
That last point is the one the current docs never address at all.

## Part 4 — Measurement (do this first)

Nothing above is testable without it. Per the onboarding review's finding 7: a `guild_event`
table plus roughly seven insert calls at points that already exist in code — `guild_joined`,
`setup_opened`, `setup_saved`, `story_created`, `writer_joined`, `turn_finalized`,
`guild_left`.

For funnel A specifically, that is not enough on its own, because a bounce at the OAuth consent
screen leaves no trace anywhere. The proxy available: watch the ratio of listing views (top.gg
reports these) to `guild_joined` events. A large gap points at the listing or the consent
screen; a small gap with heavy churn points at Funnel B.

## Suggested order

1. Part 4 — instrumentation. Everything else is unfalsifiable without it.
2. Part 2 — pick exactly one community where writers already are, try it, measure it before
   adding a second. This is where the evidence points and it is the only item that can change
   Funnel A's shape.
3. Part 1a — screenshots. Cheap, and needed by every other channel and by Part 3, so worth
   doing regardless of what top.gg itself returns.
4. Part 1b/1c — tagline, opening line, permissions explanation. Copy only, needs approval.
5. Part 3 — admin-facing install doc, reusing the Part 1 copy.

Explicitly **not** recommended: further investment in top.gg placement or ranking. The staff
pick was the ceiling of what that channel offers and it returned nothing.
