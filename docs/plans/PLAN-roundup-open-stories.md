# Plan: Open Stories Section in the Weekly Roundup

Status: Designed 2026-09-23, not built
Created: 2026-09-23
Last Updated: 2026-09-23

Designed with LeeAnn in conversation on 2026-09-23. Belongs to the Funnel B ("activation") side
of [PLAN-sequencing-and-priorities.md](PLAN-sequencing-and-priorities.md), alongside
[PLAN-first-run-experience.md](PLAN-first-run-experience.md).

---

## The problem this solves

Joins cluster at the start of a story. LeeAnn's observation: it works fine mechanically for
someone to join midstream, but people are *very hesitant* to do so. Once the creation
announcement scrolls out of the feed, an open story has nothing resurfacing it — and a DELAYED
story waiting on writers is invisible to exactly the people who would unblock it.

The weekly roundup is already a recurring feed post that lists active stories. It is the natural
place to resurface stories that are open for joining.

**Discovery is not the whole problem.** Someone reading "Story #4 is open" forty turns in still
does not know what they would be walking into. See Open questions.

## Design

A new field in the roundup embed, listing stories open for joining, with up to **five Join
buttons** on the message and a line pointing at `/story list` for anything beyond that.

### What counts as open

`/story list` already has a `joinable` filter with exactly the right predicate
(`story/list.js:212-217`):

- `story_status IN (ACTIVE, PAUSED, DELAYED)`
- `allow_joins = 1`
- `max_writers IS NULL OR (active writer count) < max_writers`
- excludes stories the user is already an active writer on

**Reuse that predicate rather than rewriting it**, so the roundup and `/story list` cannot drift
apart on what "open" means. Extracting it to a shared helper is the cleanest form.

### The one asymmetry

The `joinable` filter's last clause is per-user. The roundup is a single broadcast message, so
it cannot personalise — the five buttons will sometimes show a story the reader already writes
in.

That is acceptable as-is: both join entry points already check for an existing writer before
doing anything (`storybot.js:179-185`, `story/join.js:57-63`), so the click is handled rather
than erroring. Worth confirming the message that comes back reads sensibly in this context.

### The button already exists

`story_join_<storyId>` is on the pinned in-thread status embed (`story/_storyStatus.js:264`) and
routes at `commands/story.js:261`. Putting the same customId on the roundup message reaches the
same handler with **no new routing**.

### Shape constraints

- The roundup is an embed (`story/roundup.js:268`). Buttons cannot live inside embed field text;
  they are message-level, five per ActionRow, five rows maximum.
- Five is LeeAnn's chosen cap, with `/story list` as the overflow path. The existing
  active-stories field already caps at ten with an overflow line (`roundup.js:142-148`), so
  capping has precedent in this embed.
- All new strings go through `getConfigValue()` per the config rules — a field label, a per-story
  line template, a button label, and the overflow line pointing at `/story list`.

### Reach

The roundup is a per-server config (`cfgWeeklyRoundupEnabled`, channel, day, hour). This section
only reaches servers that have it turned on, so it is a good surface but not a universal one.

## Open questions

1. **Ordering.** "Last five" by what — most recent activity, or most recently created? Most
   recent activity is the likelier intent, and `storyLastActivitySQL()` already exists for it.
2. **What each line says.** This is the part that addresses hesitancy rather than discovery. The
   `summary` column exists on `story` and is settable from the manage panel, so a line could
   carry what the story is *about now* rather than just its title, plus turn length and writer
   count — which is the question a hesitant reader is actually asking, how often this becomes
   their problem. Not yet decided.
3. **PAUSED stories.** The existing `joinable` filter includes them. Reasonable for `/story
   list`, but a paused story in an "open for joining" section may read oddly. Decide whether to
   narrow to ACTIVE and DELAYED here.

## Sequencing

Independent of the `guild_event` table, but it touches `story/roundup.js` and `story/list.js`,
neither of which the instrumentation work needs. No conflict.
