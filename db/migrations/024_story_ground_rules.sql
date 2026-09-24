-- Ground Rules per-story selection (docs/plans/PLAN-panel-rework-and-ground-rules.md Part 2)
-- Comma-delimited stable slugs, same shape/pattern as the existing tags column

ALTER TABLE story
  ADD COLUMN IF NOT EXISTS ground_rules TEXT NULL AFTER warnings;
