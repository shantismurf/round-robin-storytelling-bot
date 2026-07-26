# Autocomplete & Story List — Filter and Sort Reference

All story sort expressions use `storyLastActivitySQL()` from `utilities.js`, which returns:

```sql
COALESCE(
  (SELECT MAX(t.ended_at)
   FROM turn t
   JOIN story_writer sw ON t.story_writer_id = sw.story_writer_id
   WHERE sw.story_id = s.story_id),
  s.created_at
)
```

"Last activity" = most recent completed turn's end time, falling back to story creation date for stories with no completed turns.

---

## /story autocomplete (`commands/story.js`)

| Subcommand | Filter (what stories appear) | Sort |
|---|---|---|
| `write` | Stories where it is currently the calling user's active turn (`sw.sw_status = 1, t.turn_status = 1`) | `lastActivity DESC` |
| `join` | Active (`story_status = 1`), joins open (`allow_joins = 1`), user is not already a member | `lastActivity DESC` |
| `read` | Stories with at least one confirmed entry (any status) | `lastActivity DESC` |
| `timeleft` | Active stories (`story_status = 1`) | `is_member DESC, lastActivity DESC` |
| `close` (admin) | All non-closed stories | `is_creator DESC, lastActivity DESC` |
| `close` (non-admin) | Non-closed stories the user created (first `story_writer_id`) | `lastActivity DESC` |
| `manage` (admin) | All guild stories (including closed) | `is_creator DESC, (status=3) ASC, lastActivity DESC` |
| `manage` (non-admin) | Stories the user created (including closed) | `(status=3) ASC, lastActivity DESC` |
| `ping` | Stories the user is a member of (`sw_status IN (1,2)`, any story status) | `story_status ASC, lastActivity DESC` |
| `edit` | Stories where the user has at least one confirmed entry | `lastActivity DESC` |
| `tag` | Active stories (`story_status = 1`) where the user is an active member (`sw_status = 1`) | `lastActivity DESC` |

---

## /mystory autocomplete (`commands/mystory.js`)

| Subcommand | Filter | Sort |
|---|---|---|
| `catchup` | Stories user is a member of (`sw_status IN (1,2)`), not closed, with at least one confirmed entry | `lastActivity DESC` |
| `status` / all others | Stories user is a member of (`sw_status IN (1,2)`), not closed | `lastActivity DESC` |

---

## /storyadmin autocomplete (`commands/storyadmin.js`)

| Subcommand | Filter | Sort |
|---|---|---|
| `story_id` | All non-closed guild stories | `is_creator DESC, lastActivity DESC` |

---

## Story list pages

| Location | View | Sort |
|---|---|---|
| `story/list.js` | All stories (paginated, filterable) | `lastActivity DESC` |
| `commands/_myStoryList.js` | Active | `lastActivity DESC` |
| `commands/_myStoryList.js` | Paused | `CASE status (paused=0, waiting=1, other=2) ASC, lastActivity DESC` |
| `commands/_myStoryList.js` | Closed / archived | `lastActivity DESC` |
| `story/roundup.js` | Active stories for weekly roundup | `lastActivity DESC` |

---

## Sort strategy key

| Strategy | Pattern | When used |
|---|---|---|
| Pure recency | `lastActivity DESC` | Simple lists, no role-based priority |
| Member-first | `is_member DESC, lastActivity DESC` | User cares if they're in the story |
| Creator-first | `is_creator DESC, lastActivity DESC` | Admin/management contexts |
| Status-grouped | `(status=3) ASC, lastActivity DESC` | Active before closed within a set |
| Status-numeric | `story_status ASC, lastActivity DESC` | Raw status number (1=active sorts first) |
| Status-case | `CASE status... ASC, lastActivity DESC` | Custom status priority ordering |
