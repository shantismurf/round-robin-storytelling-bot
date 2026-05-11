-- Migration 016: add job_log table for permanent record of completed scheduled jobs
-- Used for idempotency checks (e.g. weeklyRoundup dedup) independent of job table state
CREATE TABLE job_log (
  job_log_id INT AUTO_INCREMENT PRIMARY KEY,
  job_type VARCHAR(50) NOT NULL,
  guild_id BIGINT NOT NULL,
  window_key VARCHAR(100) NOT NULL,
  scheduled_at DATETIME NOT NULL,
  posted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_window (job_type, guild_id, window_key)
)
