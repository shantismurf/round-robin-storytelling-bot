# Plan: /story list Overhaul

## Status: Pending — layout decisions established, implementation not started

---

## Context

The `/story list` command (`story/list.js`) has interface problems noted during the `/mystory list` overhaul:
- Open and closed stories appear mixed with no discernible order
- No clear visual hierarchy between stories
- Sorting is not intuitive (currently `ORDER BY lastActivity DESC` with no status grouping)

---

## Established Layout Decisions

These were finalized during the `/mystory list` overhaul and should carry over directly.

### Embed Field Format

One field per story. Field **name** is auto-bolded by Discord.

```
[mode_icon] Story Title (#12) · Mode · Status [rating_badge]
　　[turn line]
　　[secondary info line]
```

- **Mode icons** (hardcoded UI chrome, not config strings): 🟣 Quick · 🟢 Normal · 🔵 Slow
- **Indent**: unicode full-width space `　` (two characters) on value lines
- **No emojis** on turn or info lines — plain text only
- **No emojis in buttons** — button labels are plain text only

### Turn Line (always shown)

- It's the viewing user's turn: `It's your turn — ends in [relative] ([date])`
- Someone else's turn: `[writer_name]'s turn — ends in [relative]`
- No active turn: `There is no active turn.`

Uses Discord timestamps: `<t:${unix}:R>` (relative) and `<t:${unix}:D>` (long date).

### Button Colors (semantic)

- `ButtonStyle.Success` (green) — Active / positive state
- `ButtonStyle.Secondary` (gray) — Neutral / paused state
- `ButtonStyle.Danger` (red) — Closed / ended state
- `ButtonStyle.Primary` (blurple) — Call to action / joinable
- Disabled state always renders gray regardless of assigned style

---

## Proposed Sorting Fix

Stories should be grouped by status before sorting by last activity:

```sql
ORDER BY
  CASE s.story_status WHEN 1 THEN 0 WHEN 2 THEN 1 WHEN 4 THEN 2 WHEN 0 THEN 3 ELSE 4 END ASC,
  storyLastActivitySQL() DESC
```

Active first, then paused, then waiting/delayed, then closed. `storyLastActivitySQL()` is exported from `utilities.js` and returns the most recent `turn.ended_at` for the story, falling back to `story.created_at`.

---

## Key Reference

The `/mystory list` implementation in `commands/_myStoryList.js` is the pattern to follow:
- `buildListEmbed()` — field format with mode icon, indented value lines
- `buildViewToggleRow()` — button row with semantic colors and disabled current view
- `fetchActiveTurnsForStories()` — batch turn fetch pattern
- `renderJoinableView()` — joinable stories with quick-join select menu

The `/story list` already has filter infrastructure (`getStoriesPaginated`, `handleFilterButton`, join status logic) — the overhaul is primarily a **display and sorting** fix, not a logic rewrite.

---

## Scope

- Adopt the field format above (mode icon, indented lines, no tree symbols)
- Fix sort order (status-grouped, then by date)
- Apply button label/color standards (no emojis, semantic colors)
- Review filter options for UX consistency with `/mystory list` views
- Update affected config keys in `config_story.sql` and `config_roadmap.md`
