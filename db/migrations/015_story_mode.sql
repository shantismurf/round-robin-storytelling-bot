-- Migration 015: rename quick_mode → mode (0=Normal, 1=Quick, 2=Slow)
--               and timeout_reminder_percent → reminder_timing
--               (percent in normal/quick; hours between reminders in slow; 0=disabled in all modes)
ALTER TABLE story
  CHANGE COLUMN quick_mode mode TINYINT(1) NOT NULL DEFAULT 0,
  CHANGE COLUMN timeout_reminder_percent reminder_timing INT NOT NULL DEFAULT 50;
