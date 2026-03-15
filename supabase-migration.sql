-- Run this in your Supabase SQL Editor
-- Adds the columns needed for the Linear webhook integration

ALTER TABLE changelog
  ADD COLUMN IF NOT EXISTS status     text DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS linear_id  text,
  ADD COLUMN IF NOT EXISTS linear_url text;

-- Make sure existing entries stay published
UPDATE changelog SET status = 'published' WHERE status IS NULL;

-- Index for fast draft lookups
CREATE INDEX IF NOT EXISTS idx_changelog_status ON changelog(status);

-- Prevent duplicate drafts from the same Linear ticket
CREATE UNIQUE INDEX IF NOT EXISTS idx_changelog_linear_id ON changelog(linear_id) WHERE linear_id IS NOT NULL;
