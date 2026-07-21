# Round Robin StoryBot — UX Roadmap

Reference document for interaction flows, known gaps, and per-silo UX progress.
For system architecture and routing, see `system_roadmap.md`.

---

## Interaction Flow Overview

### `/story` Command Flows

```
/story add
  → StoryAddPanel embed (toggle buttons: mode, order, show names, hide threads)
  → story_add_open_titlesummary → modal: title + summary
  → story_add_open_settings → modal: turn length, reminder, delay hours, delay writers, max writers
  → story_add_open_metadata → modal: dynamic, rating, warnings (select menus)
  → story_add_open_tags → modal: main pairing, other rels, characters, tags, scene break
  → story_add_open_mysettings → modal: pen name, privacy select, notifications select
  → story_add_create → CreateStory()

/story join [story_id]
  → JoinPanel embed
  → story_join_penname_* (pen name modal if needed)
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
  → ManagePanel embed (shared embed builder, toggle buttons: mode, order, joins, show names, privacy)
  → story_manage_open_titlesummary → modal: title + summary
  → story_manage_open_settings → modal: turn length, reminder, max writers
  → story_manage_open_metadata → modal: dynamic, rating, warnings (select menus)
  → story_manage_open_tags → modal: main pairing, other rels, characters, tags, scene break
  → story_manage_toggle_pauseresume → toggles pause/resume state (staged until save)
  → story_manage_save → writes all staged fields + barrier check + pause/resume actions
  → story_manage_entries_open → Manage Entries panel
  → story_manage_turns_open → Manage Turns panel
  → story_manage_review_tags (when pending tags > 0) → Manage Tags panel (approve/reject queue)
  → story_manage_close_open → reuses /story close confirm/cancel flow (story_close_confirm_*/story_close_cancel_*)
  → story_manage_reopen (when closed) → immediate reopen, no confirmation

Tag Submission Thread Post (in story thread)
  → Delete button → ephemeral confirm embed → story_tag_delete_confirm_* → removes record + thread post
  → View Proposed Tags → handleViewProposedTags → all-tags embed with linked tag text and reaction counts
  → Manage Tags → handleTagManageButton (creator/admin auth check) → Manage Tags panel

/story read [story_id] tag buttons
  → Submit Tag (active writers) → story_submit_tag_* → modal → story_tag_submit_modal_*
  → View Proposed Tags (all) → story_tag_view_proposed_* → all-tags embed
  → Manage Tags (creator/admin) → story_manage_review_tags_read_* → Manage Tags panel

/story list
  → story_list_* (pagination, filter select menus)
    → filters: All Stories, Joinable Stories, My Stories, Active Stories, Paused Stories

/story edit [story_id]
  → chunkEntryContent → paginated edit modals
  → story_edit_prev / story_edit_next / story_edit_jump (page-select menu, same pattern as story_read_jump) → jump to any page directly
  → story_edit_modal_* → entry updated

/story tag [story_id]
  → Active writers only; opens tag submission modal
  → story_tag_submit_modal_<storyId> → handleTagSubmitModalSubmit
    → Posts voting message to story thread with 👍/👎 auto-reactions
    → Thread post buttons: Delete (submitter/creator/admin), View Proposed Tags (all), Manage Tags (creator/admin)

/story ping / timeleft / help
  → Ephemeral replies only; no follow-up interactions
```

### `/storyadmin` Command Flows

```
/storyadmin setup
  → storyadmin_setup_* modal → guild config saved

/storyadmin user [story_id] [user]
  → ManageUser panel (pause, remove, pen name, notif prefs, turn privacy)
  → storyadmin_mu_* buttons → confirm embed → storyadmin_mu_confirm_* / storyadmin_mu_cancel_*

/storyadmin faqsync
  → syncFaqPosts: fetches each cfgFaqThread* thread, edits bot's first post or posts new one

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

turnReminder job (normal/quick mode only)
  → fires once at reminder_timing% of turn length
  → checks writer notification_prefs: 'mention' or DM
  → DM attempt → fallback to channel mention on failure (logged)

turnSlowReminder job (slow mode only)
  → fires every reminder_timing hours (self-rescheduling)
  → verifies turn still active (turn_status = 1); cancels if not
  → DM (txtDMTurnReminderSlow) or mention (txtMentionTurnReminderSlow)
  → inserts new turnSlowReminder job for reminder_timing hours later
  → cancelled on turn end (finalize/skip/timeout) or story pause
```

---

## Known Flow Gaps & Issues

### Critical
*(none — metadata panel replaced with inline modals in v3.0.0)*

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
| 4 — User Experience | /mystory flows, config_mystory.sql | Dashboard accuracy, help files | ✅ Complete (Tier B status icons deferred) |
| 5 — The Engine | storybot.js, config_turn.sql | Performance, documentation | ✅ Complete |
