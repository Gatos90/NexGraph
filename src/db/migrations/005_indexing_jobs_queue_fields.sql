-- Add mode and last_completed_phase columns for pg-boss job management
ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'full';
ALTER TABLE indexing_jobs ADD CONSTRAINT indexing_jobs_mode_check
  CHECK (mode IN ('full', 'incremental'));

-- Track the last phase that completed successfully for recoverability
ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS last_completed_phase TEXT;

-- Store the pg-boss job ID for cancellation
ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS boss_job_id TEXT;

-- Add updated_at column for progress tracking
ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add cancelled status
ALTER TABLE indexing_jobs DROP CONSTRAINT IF EXISTS indexing_jobs_status_check;
ALTER TABLE indexing_jobs ADD CONSTRAINT indexing_jobs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'));
