-- Store file contents for full-text search (BM25) and regex grep
CREATE TABLE file_contents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  content       TEXT NOT NULL,
  search_vector tsvector,
  UNIQUE (repository_id, file_path)
);

CREATE INDEX idx_file_contents_repo ON file_contents(repository_id);
CREATE INDEX idx_file_contents_search ON file_contents USING gin (search_vector);
CREATE INDEX idx_file_contents_path_trgm ON file_contents USING gin (file_path gin_trgm_ops);
