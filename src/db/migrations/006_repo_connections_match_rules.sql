-- Extend repo_connections with match_rules, updated_at, and constrain connection_type
ALTER TABLE repo_connections
  ADD COLUMN IF NOT EXISTS match_rules JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add CHECK constraint for supported connection types
ALTER TABLE repo_connections
  ADD CONSTRAINT chk_connection_type
  CHECK (connection_type IN (
    'CROSS_REPO_CALLS',
    'CROSS_REPO_IMPORTS',
    'CROSS_REPO_DEPENDS',
    'CROSS_REPO_MIRRORS'
  ));

-- Update the default connection_type
ALTER TABLE repo_connections
  ALTER COLUMN connection_type SET DEFAULT 'CROSS_REPO_DEPENDS';
