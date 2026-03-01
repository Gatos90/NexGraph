-- Per-file git commit history for visualization overlays (freshness, hotspots, authors)

CREATE TABLE IF NOT EXISTS git_file_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  commit_sha      TEXT NOT NULL,
  author_name     TEXT NOT NULL,
  author_email    TEXT NOT NULL,
  commit_date     TIMESTAMPTZ NOT NULL,
  commit_message  TEXT,
  change_type     CHAR(1),  -- A=Added, M=Modified, D=Deleted, R=Renamed
  UNIQUE (repository_id, file_path, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_git_file_history_repo
  ON git_file_history(repository_id);

CREATE INDEX IF NOT EXISTS idx_git_file_history_path
  ON git_file_history(repository_id, file_path);

CREATE INDEX IF NOT EXISTS idx_git_file_history_author
  ON git_file_history(repository_id, author_email);

CREATE INDEX IF NOT EXISTS idx_git_file_history_date
  ON git_file_history(repository_id, commit_date DESC);

-- Track when git history was last extracted for a repository
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS git_history_extracted_at TIMESTAMPTZ;
