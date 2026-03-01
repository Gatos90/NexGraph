-- Add source_type, name, and graph_name to repositories table
ALTER TABLE repositories
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'git_url'
    CHECK (source_type IN ('git_url', 'zip_upload', 'local_path')),
  ADD COLUMN name TEXT,
  ADD COLUMN graph_name TEXT UNIQUE;
