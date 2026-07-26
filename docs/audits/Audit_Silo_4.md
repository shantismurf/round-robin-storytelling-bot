# Silo-Sprint Plan: Silo 4 — User Experience (/mystory)

## Context
Audit of `commands/mystory.js` and `config_mystory.sql`. Focus on bugs, hardcoded strings,
logging gaps, and removal of all `?? fallback` guards. Several config keys added in Silos 2
and 3 can be reused here with no new SQL required.

---

## Bug Findings (fix before anything else)

### BUG 1 — mystory.js:176 — `buildListEmbed` has hardcoded status text
`statusText()` returns `'Active'`, `'Paused'`, `'Delayed'`, `'Closed'` — raw strings embedded
in embed field names visible to users. `statusIcon()` returns emoji (Tier B, deferred).

**Fix:** Extend `buildListEmbed` to receive a `statusLabels` object and pass the existing
config keys `txtActive`, `txtPaused`, `txtDelayed`, `txtClosed` through from `handleList`
and `handleListNavigation`.

### BUG 2 — mystory.js:187–192 — `buildListEmbed` has hardcoded stat strings
Lines 187–192 build embed field values like `"Your turns: N · ~X words"`, `"No turns yet"`,
`"Story total: N turn(s)"`, `"Story total: 0 turns"`, `"Joined [date]"`,
`"⏸ You are paused"` — all hardcoded user-facing strings.

**Fix:** Add config keys for each and pass via `buildListEmbed` parameters.

### BUG 3 — mystory.js:322–323 — catchup intro strings are hardcoded
`"📖 **${storyTitle}** — ${totalPages} turn(s) since your last turn."` and the
`"you haven't had a turn yet"` variant. Also the nav label
`"📖 **${storyTitle}** — (Page ${n}/${total})"` at line 358.

**Fix:** Add config keys `txtCatchupIntro`, `txtCatchupIntroNoTurns`, `txtCatchupNavHeader`.

### BUG 4 — mystory.js:310 — catchup embed author is hardcoded
`.setAuthor({ name: \`Turn ${n} — ${name}\` })` — hardcoded turn header visible in embed.

**Fix:** Add config key `txtCatchupTurnHeader` (template: `[turn_number]`, `[writer_name]`).

---

## Hardcoded Strings Inventory

### Tier A — User-visible (must fix)

| File | Lines | String | Proposed Key |
|------|-------|--------|--------------|
| mystory.js | 176 | `'Active'`, `'Paused'`, `'Delayed'`, `'Closed'` (status text) | Reuse `txtActive`, `txtPaused`, `txtDelayed`, `txtClosed` (config_system.sql) |
| mystory.js | 185 | `'Joined [date]'` | `txtMyListJoined` (template: `[date]`) |
| mystory.js | 187 | `'Your turns: N · ~X words'` | `txtMyListMyStats` (template: `[turn_count]`, `[word_count]`) |
| mystory.js | 188 | `'No turns yet'` | `txtMyListNoTurns` |
| mystory.js | 190 | `'Story total: N turn(s)'` | `txtMyListStoryTotal` (template: `[turn_count]`) |
| mystory.js | 191 | `'Story total: 0 turns'` | Covered by `txtMyListStoryTotal` with count=0 |
| mystory.js | 192 | `'⏸ You are paused'` suffix | `txtMyListPausedSuffix` |
| mystory.js | 207–208 | `'◀️ Prev'` / `'Next ▶️'` list nav buttons | Reuse `btnPrev` / `btnNext` (config_system.sql) |
| mystory.js | 310 | `'Turn N — Writer Name'` catchup embed author | `txtCatchupTurnHeader` (template: `[turn_number]`, `[writer_name]`) |
| mystory.js | 322–323 | Catchup intro strings (with/without prior turns) | `txtCatchupIntro` / `txtCatchupIntroNoTurns` (template: `[story_title]`, `[turn_count]`) |
| mystory.js | 333 | `'(Page 1/N)'` in single-page catchup reply | Covered by `txtCatchupIntro` template |
| mystory.js | 358 | `'📖 **title** — (Page N/T)'` nav header | `txtCatchupNavHeader` (template: `[story_title]`, `[page]`, `[total]`) |
| mystory.js | 364–375 | `'◀️ Prev'` / `'Next ▶️'` catchup nav buttons | Reuse `btnPrev` / `btnNext` |
| mystory.js | 385–386 | `?? 'Active'` / `?? 'Paused'` status fallbacks | Remove (keys confirmed present) |
| mystory.js | 392–395 | `?? 'Status'` field name fallbacks + `'DM'`/`'Mention'`/`'Private'`/`'Public'` values | Reuse `txtNotifDM`, `txtNotifMention`, `txtPrivate`, `txtPublic` (added Silo 3); remove `??` guards |
| mystory.js | 397 | `'-# Notifications and Privacy are staged...'` embed description | `txtMyStoryManagePanelDesc` |
| mystory.js | 399 | `'Switch to: Mention'` / `'Switch to: DM'` button labels | Reuse `btnManageUserSwitchMention` / `btnManageUserSwitchDM` (added Silo 3) |
| mystory.js | 400 | `'Make Public'` / `'Make Private'` | Reuse `btnManageUserMakePublic` / `btnManageUserMakePrivate` (added Silo 3) |
| mystory.js | 403 | `?? 'Update Name'` AO3 name button fallback | Remove (key confirmed present) |
| mystory.js | 408–409 | `?? '✅ Save Changes'` / `?? 'Cancel'` / `?? '⏸️ Pause'` etc. fallbacks | Remove all (confirmed present) |
| mystory.js | 527–528 | `'Set AO3 Name'` modal title / `'AO3 Name'` label / `'Leave blank to clear'` placeholder | Reuse `lblJoinSetAO3ModalTitle`, `lblMyStoryManageAO3`, `txtAdminMUAO3Placeholder` |
| mystory.js | 564 | `?? '⏭️ **Pass your turn...**'` fallback | Remove (key confirmed present) |
| mystory.js | 566–567 | `?? 'Yes, Pass My Turn'` / `?? 'Cancel'` | Remove |
| mystory.js | 574–577 | `?? '⏸️ **Pause...**'` / `?? 'Yes, Pause'` / `?? 'Cancel'` | Remove |
| mystory.js | 591 | `?? '▶️ You have rejoined...'` resume success | Remove |

### Keys already in config that can be reused (no new SQL needed):
- `txtActive`, `txtPaused`, `txtDelayed`, `txtClosed` (config_system.sql)
- `btnPrev`, `btnNext` (config_system.sql)
- `txtNotifDM`, `txtNotifMention`, `txtPrivate`, `txtPublic`, `txtNotSet` (added Silo 3)
- `btnManageUserSwitchMention`, `btnManageUserSwitchDM`, `btnManageUserMakePublic`, `btnManageUserMakePrivate` (added Silo 3)
- `lblJoinSetAO3ModalTitle`, `txtAdminMUAO3Placeholder` (added Silo 2 / Silo 3)
- `lblMyStoryManageAO3` (already in config_mystory.sql)

### Tier B — Deferred
- `buildListEmbed` status icons `'🟢'`, `'⏸️'`, `'⏳'`, `'🏁'` (line 175) — embed decoration only. Track in ux_roadmap.md.

---

## Logging Gaps

| File | Function | Gap |
|------|----------|-----|
| mystory.js | `execute()` | No entry log — add `{ show: false }` with subcommand + user |
| mystory.js | `handleHelp()` | No entry log |
| mystory.js | `handleCatchUp()` | Has catch log but no entry log |
| mystory.js | `handleCatchUpNavigation()` | No entry log |
| mystory.js | `handleMyStoryManageModal()` | No entry log; catch uses `${error}` not `${error?.stack ?? error}` |
| mystory.js | `handlePanelActionCancel()` | No entry log |
| mystory.js | `handleMyStoryManage()` | ✅ Has entry log |
| mystory.js | `handleMyStoryManageButton()` | ✅ Has entry log |

---

## Config SQL Updates

New keys to add to `config_mystory.sql`:

```
txtMyListJoined           — template: [date]
txtMyListMyStats          — template: [turn_count], [word_count]
txtMyListNoTurns
txtMyListStoryTotal       — template: [turn_count]
txtMyListPausedSuffix
txtCatchupTurnHeader      — template: [turn_number], [writer_name]
txtCatchupIntro           — template: [story_title], [turn_count]
txtCatchupIntroNoTurns    — template: [story_title]
txtCatchupNavHeader       — template: [story_title], [page], [total]
txtMyStoryManagePanelDesc
```

`config_roadmap.md` manifest updated with all new keys and count.
`ux_roadmap.md` Silo 4 marked complete.

---

## Implementation Order

1. **Logging** — entry logs for `execute`, `handleHelp`, `handleCatchUp`,
   `handleCatchUpNavigation`, `handleMyStoryManageModal`, `handlePanelActionCancel`;
   fix stack trace in modal catch
2. **`buildMyStoryManagePanel`** — remove all `??` fallbacks; wire `txtNotifDM`/`txtNotifMention`/
   `txtPrivate`/`txtPublic`; wire panel desc; wire toggle button labels; wire AO3 modal strings;
   add new keys to cfg fetch
3. **`buildListEmbed`** — extend signature to receive status labels + stat strings;
   wire `btnPrev`/`btnNext` into nav row builder
4. **`handleCatchUp` / `handleCatchUpNavigation`** — wire catchup intro, nav header, turn
   header config keys
5. **Config SQL + roadmap update** — add 10 new keys to `config_mystory.sql`, update
   `config_roadmap.md`, mark `ux_roadmap.md` Silo 4 complete

---

## Files to Modify
- [commands/mystory.js](commands/mystory.js)
- [db/config_files/config_mystory.sql](db/config_files/config_mystory.sql)
- [db/config_roadmap.md](db/config_roadmap.md)
- [ux_roadmap.md](ux_roadmap.md)

## Files NOT Modified
- `story/manage.js` — Silo 2 scope; placeholder edits handled at start of Silo 4 session
- `story/manageUser.js` — Silo 3 scope; complete
- `story/manageTurnActions.js` — Silo 3 scope; complete
- `story/manageEntries.js` — Silo 3 scope; complete
