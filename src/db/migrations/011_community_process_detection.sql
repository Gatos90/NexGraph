-- Add community and process detection tracking columns to repositories table
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS community_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS community_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS process_count INTEGER DEFAULT 0;
