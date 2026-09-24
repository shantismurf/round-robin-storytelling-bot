-- Migration 023: add guild_event table for funnel instrumentation
-- Tracks per-guild funnel events (install through activation) so drop-off points can be
-- measured instead of guessed. No user_id column by design: every question here is a
-- per-guild count over time, and story_writer already records per-writer identity for any
-- story-scoped question. See PLAN-sequencing-and-priorities.md Stage 1 and privacy-policy.js
-- (product analytics is not one of the enumerated data categories, and it should stay that way)
CREATE TABLE guild_event (
  guild_event_id INT AUTO_INCREMENT PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  detail JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_guild_event_type (guild_id, event_type, created_at)
)
