-- Add last_resolved_at timestamp to repo_connections for tracking auto-re-resolution
ALTER TABLE repo_connections
  ADD COLUMN IF NOT EXISTS last_resolved_at TIMESTAMPTZ;
