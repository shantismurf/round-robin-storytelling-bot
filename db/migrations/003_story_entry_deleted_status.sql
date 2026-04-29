-- Add 'deleted' to story_entry.entry_status enum
-- MariaDB ALTER COLUMN MODIFY is idempotent when the enum already contains the value

ALTER TABLE story_entry MODIFY COLUMN entry_status ENUM('pending','confirmed','discarded','deleted') DEFAULT 'pending';
