-- Create story_entry_edit table for storing edit history

CREATE TABLE IF NOT EXISTS story_entry_edit (
  edit_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entry_id BIGINT NOT NULL,
  content TEXT NOT NULL,
  edited_by VARCHAR(30) NOT NULL,
  edited_by_name VARCHAR(100) NOT NULL,
  edited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entry_id) REFERENCES story_entry(story_entry_id) ON DELETE CASCADE
);
