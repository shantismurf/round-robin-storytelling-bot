-- Drop tables in reverse order (to handle foreign key dependencies)
DROP TABLE IF EXISTS job;
DROP TABLE IF EXISTS turn;
DROP TABLE IF EXISTS story_entry;  
DROP TABLE IF EXISTS story_writer;
DROP TABLE IF EXISTS story;
DROP TABLE IF EXISTS config;

-- initial schema (story, story_writer, turn, job)
CREATE TABLE IF NOT EXISTS story (
  story_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_story_id INT UNSIGNED NOT NULL DEFAULT 0,
  guild_id BIGINT DEFAULT NULL,
  title TEXT NOT NULL,
  ao3_URL VARCHAR(255),
  story_status TINYINT(1) DEFAULT 1,
  closed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  quick_mode TINYINT(1) DEFAULT 0,
  turn_length_hours INT DEFAULT 24,
  timeout_reminder_percent INT DEFAULT 50,
  next_writer_id BIGINT NULL,
  story_thread_id BIGINT,
  story_turn_privacy TINYINT(1) DEFAULT 0,
  show_authors TINYINT(1) DEFAULT 1,
  story_delay_hours INT DEFAULT 0,
  story_delay_users INT DEFAULT NULL,
  story_order_type TINYINT(1) DEFAULT 1, -- 1=random, 2=round-robin, 3=fixed
  max_writers INT DEFAULT NULL,
  min_entry_length INT DEFAULT 0,
  max_entry_length INT DEFAULT 5000,
  allow_joins TINYINT(1) DEFAULT 1,
  summary TEXT NULL,
  tags TEXT NULL,
  status_message_id VARCHAR(20) NULL,
  UNIQUE KEY uq_guild_story (guild_id, guild_story_id)
);

CREATE TABLE IF NOT EXISTS story_writer (
  story_writer_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  story_id BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (story_id) REFERENCES story(story_id) ON DELETE CASCADE,
  discord_user_id BIGINT NOT NULL,
  discord_display_name VARCHAR(255),
  AO3_name VARCHAR(255),
  turn_privacy TINYINT(1) DEFAULT 0,
  sw_status TINYINT(1) DEFAULT 1,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMP NULL,
  writer_order INT DEFAULT NULL,
  notification_prefs VARCHAR(50) DEFAULT 'dm',
  UNIQUE KEY (story_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS turn (
  turn_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  story_writer_id BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (story_writer_id) REFERENCES story_writer(story_writer_id) ON DELETE CASCADE,
  started_at TIMESTAMP NULL,
  turn_ends_at TIMESTAMP NULL,
  ended_at TIMESTAMP NULL,
  thread_id VARCHAR(255),
  turn_status TINYINT(1) DEFAULT 0,
  more_time_requested TINYINT(1) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS story_entry (
  story_entry_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  turn_id BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  entry_status ENUM('pending', 'confirmed', 'discarded', 'deleted') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS story_entry_edit (
  edit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  entry_id BIGINT UNSIGNED NOT NULL,
  content TEXT NOT NULL,
  edited_by VARCHAR(30) NOT NULL,
  edited_by_name VARCHAR(100) NOT NULL,
  edited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entry_id) REFERENCES story_entry(story_entry_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job (
  job_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  job_type VARCHAR(50) NOT NULL,
  payload JSON,
  run_at TIMESTAMP,
  attempts INT DEFAULT 0,
  job_status TINYINT(1) DEFAULT 0,
  turn_id BIGINT NULL
);

CREATE TABLE IF NOT EXISTS config (
  config_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  config_key VARCHAR(255) NOT NULL,
  config_value TEXT NOT NULL,
  language_code VARCHAR(10) DEFAULT 'en',
  guild_id BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_config_key_guild (config_key, guild_id)
);

CREATE TABLE admin_action_log (
  log_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  admin_user_id BIGINT NOT NULL,
  action_type VARCHAR(50) NOT NULL, -- 'kick', 'extend', 'delete', etc.
  target_story_id BIGINT,
  target_user_id BIGINT,
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);