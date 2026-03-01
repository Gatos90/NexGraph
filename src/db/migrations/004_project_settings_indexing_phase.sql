-- Add JSONB settings column to projects for include/exclude globs, etc.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';

-- Add phase and progress columns to indexing_jobs for ingestion pipeline tracking
ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS phase TEXT;
ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS progress REAL NOT NULL DEFAULT 0;
