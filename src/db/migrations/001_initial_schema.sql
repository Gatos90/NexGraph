-- Projects
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API keys scoped to a project
CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL UNIQUE,
  label         TEXT,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_project ON api_keys(project_id);

-- Repositories tracked within a project
CREATE TABLE repositories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  last_indexed_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, url)
);

CREATE INDEX idx_repositories_project ON repositories(project_id);

-- Files that have been indexed
CREATE TABLE indexed_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  language      TEXT,
  content_hash  TEXT NOT NULL,
  indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repository_id, file_path)
);

CREATE INDEX idx_indexed_files_repo ON indexed_files(repository_id);
CREATE INDEX idx_indexed_files_path_trgm ON indexed_files USING gin (file_path gin_trgm_ops);

-- Indexing jobs (background processing)
CREATE TABLE indexing_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_message TEXT,
  files_total   INTEGER NOT NULL DEFAULT 0,
  files_done    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_indexing_jobs_repo ON indexing_jobs(repository_id);
CREATE INDEX idx_indexing_jobs_status ON indexing_jobs(status);

-- Connections between repositories for cross-repo analysis
CREATE TABLE repo_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_repo_id    UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  target_repo_id    UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  connection_type   TEXT NOT NULL DEFAULT 'dependency',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_repo_id, target_repo_id, connection_type)
);

CREATE INDEX idx_repo_connections_project ON repo_connections(project_id);

-- Edges discovered across repositories
CREATE TABLE cross_repo_edges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_repo_id    UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  target_repo_id    UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_node       TEXT NOT NULL,
  target_node       TEXT NOT NULL,
  edge_type         TEXT NOT NULL,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cross_repo_edges_project ON cross_repo_edges(project_id);
CREATE INDEX idx_cross_repo_edges_source ON cross_repo_edges(source_repo_id);
CREATE INDEX idx_cross_repo_edges_target ON cross_repo_edges(target_repo_id);
