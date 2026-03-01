-- Add authentication fields to api_keys table for US-004
ALTER TABLE api_keys
  ADD COLUMN key_prefix   TEXT NOT NULL DEFAULT '',
  ADD COLUMN permissions  JSONB NOT NULL DEFAULT '["read", "write"]',
  ADD COLUMN expires_at   TIMESTAMPTZ;

-- Index for fast lookup by key_hash (already UNIQUE, so indexed)
-- Index for finding expired keys
CREATE INDEX idx_api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
