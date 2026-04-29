-- Create story_tag_submission table for collaborative tagging

CREATE TABLE IF NOT EXISTS story_tag_submission (
  submission_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  story_id BIGINT NOT NULL,
  submitter_user_id VARCHAR(30) NOT NULL,
  submitter_display_name VARCHAR(255) NOT NULL,
  tag_text VARCHAR(200) NOT NULL,
  submission_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP NULL,
  CONSTRAINT fk_tag_sub_story FOREIGN KEY (story_id) REFERENCES story(story_id) ON DELETE CASCADE
) ENGINE=InnoDB;
