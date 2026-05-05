# Round Robin StoryBot — UX Roadmap

Reference document for interaction flows, known gaps, and per-silo UX progress.
For system architecture and routing, see `system_roadmap.md`.

---

## Interaction Flow Overview

### `/story` Command Flows

```
/story add
  → StoryAddPanel embed (select menus: mode, order, rating, privacy)
  → story_add_meta_* buttons (AO3 metadata, tags)
  → story_add_meta_save button → story.handleButtonInteraction
    ⚠ Known bug: pendingStoryData null check fires before save (see TODO.md)
  → Confirm/Cancel → CreateStory()

/story join [story_id]
  → JoinPanel embed
  → story_join_ao3_* (AO3 name modal if needed)
  → story_join_confirm_* → StoryJoin()
  → story_join_cancel_*

/story write [story_id]
  → Quick mode: direct modal
  → Normal mode: turn thread created → write modal in thread
  → confirm_entry_* / discard_entry_* / finalize_entry_*
  → story_finalize_confirm_* → entry committed

/story read [story_id]
  → Paginated embed (splitAtParagraphs)
  → story_read_post_public_* → posts to feed
  → story_repost_entry_*

/story manage [story_id]
  → ManagePanel embed
  → story_manage_* (edit, skip, close, tags)
  → story_skip_confirm_* / story_close_confirm_*
  → skip_turn_* → PickNextWriter → NextTurn

/story list
  → story_list_* (pagination, filter select menus)

/story edit [story_id]
  → chunkEntryContent → paginated edit modals
  → story_edit_modal_* → entry updated

/story ping / timeleft / help
  → Ephemeral replies only; no follow-up interactions
```

### `/storyadmin` Command Flows

```
/storyadmin setup
  → storyadmin_setup_* modal → guild config saved

/storyadmin manage [story_id]
  → AdminManagePanel embed
  → storyadmin_mu_* (manage user panel: skip, remove, role change)
  → storyadmin_delete_confirm_* / storyadmin_delete_cancel_*
  ⚠ Staged edits vs. immediate actions: see Silo 3 audit

/storyadmin skip / close / pause
  → Immediate actions; no confirm panel
```

### `/mystory` Command Flows

```
/mystory
  → Dashboard embed (active stories, turn status)
  → mystory_list_prev_* / mystory_list_next_* (pagination)
  → mystory_manage_* (manage panel for writer's own story)
    → mystory_manage_leave_confirm_* / leave_cancel_*
    → mystory_manage_pass_confirm_* / pass_cancel_*
    → mystory_manage_pause_confirm_* / pause_cancel_*
  → catchup_prev_* / catchup_next_* (entry catchup reader)
```

### Background Job Flows

```
checkStoryDelay job
  → fires after join-window expires
  → checks writer count condition
  → if met: activates story → postStoryFeedActivationAnnouncement → PickNextWriter → NextTurn

turnTimeout job
  → fires when turn deadline passes
  → ends turn, cancels pending jobs
  → deletes turn thread if exists
  → PickNextWriter → NextTurn
  → posts timeout activity to story thread

turnReminder job
  → fires partway through a turn
  → checks writer notification_prefs: 'mention' or DM
  → DM attempt → fallback to channel mention on failure (logged)
```

---

## Known Flow Gaps & Issues

### Critical
- **metadata save bug** (`story_add_meta_save`): pendingStoryData null check fires before save completes. Story metadata is not saved. Tracked in TODO.md.

### Unimplemented / Deferred
- **Request More Time** (`story_request_more_time_*`): button exists but scheduling extension is not implemented. Requires job scheduler update.
- **DM Support**: Full DM-based story participation planned but not implemented. Implementation order documented in TODO.md.
- **Help pages**: /story help needs page 4 (AO3/tagging); /mystory help and /storyadmin help need overhaul.

### Hardcoded Text (to be resolved in per-silo audits)
- `ratingBadgeKey`, `modeText`, `orderText` — referenced in TODO.md as hardcoded; not yet migrated to config keys.
- Additional items to be identified in Silos 3–5.

### Deferred Tier B — Story Management (Silo 2)
- **list.js status icons** (lines 311–318): `🟢`, `⏸️`, `🏁`, `⏳` hardcoded in `getStatusIcon()`. Low priority; visible only as embed decoration.
- **read.js embed title emoji prefixes**: emoji used as status indicators. Low priority; no functional impact.

### Autocomplete
- Performance optimization deferred. Autocomplete queries are functional but not optimized for large story lists.

---

## Silo UX Progress

| Silo | Scope | UX Items | Status |
|------|-------|----------|--------|
| 1 — Gateway & Utilities | index.js, utilities.js, deploy.js, job-runner.js | Routing verified, logging added, bug fixed | ✅ Complete |
| 2 — Story Management | /story flows, config_story.sql, config_metadata.sql | Hardcoded text, logging gaps | ✅ Complete (Tier B status icons deferred) |
| 3 — Admin & Overrides | /storyadmin flows, config_storyadmin.sql | Staged vs. immediate action clarity, unwired modals | ✅ Complete |
| 4 — User Experience | /mystory flows, config_mystory.sql | Dashboard accuracy, help files | ⬜ Pending |
| 5 — The Engine | storybot.js, config_turn.sql | Performance, documentation | ⬜ Pending |
