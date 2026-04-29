-- Add AO3 metadata columns to story table

ALTER TABLE story
  ADD COLUMN IF NOT EXISTS rating ENUM('NR','G','T','M','E') NOT NULL DEFAULT 'NR' AFTER tags,
  ADD COLUMN IF NOT EXISTS warnings TEXT NULL AFTER rating,
  ADD COLUMN IF NOT EXISTS fandom VARCHAR(100) NULL AFTER warnings,
  ADD COLUMN IF NOT EXISTS main_pairing VARCHAR(200) NULL AFTER fandom,
  ADD COLUMN IF NOT EXISTS other_relationships TEXT NULL AFTER main_pairing,
  ADD COLUMN IF NOT EXISTS characters TEXT NULL AFTER other_relationships,
  ADD COLUMN IF NOT EXISTS category VARCHAR(50) NULL AFTER characters,
  ADD COLUMN IF NOT EXISTS additional_tags TEXT NULL AFTER category,
  ADD COLUMN IF NOT EXISTS restricted_thread_id VARCHAR(20) NULL AFTER additional_tags;
