-- Track the last successfully indexed git commit SHA for incremental indexing
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS last_indexed_commit TEXT;

-- Track the number of changed files in incremental indexing jobs
ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS changed_files_count INTEGER;
