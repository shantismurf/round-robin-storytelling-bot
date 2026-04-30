-- Add thread_message_id to story_tag_submission for reaction vote tracking
ALTER TABLE story_tag_submission
  ADD COLUMN thread_message_id VARCHAR(20) NULL AFTER submission_status;
