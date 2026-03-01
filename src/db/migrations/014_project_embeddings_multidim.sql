-- Project-level embedding configuration and secret storage

CREATE TABLE IF NOT EXISTS project_embedding_config (
  project_id       UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  dimensions       INTEGER NOT NULL CHECK (dimensions IN (384, 768, 1024, 1536, 3072, 4096)),
  distance_metric  TEXT NOT NULL DEFAULT 'cosine' CHECK (distance_metric IN ('cosine')),
  provider_options JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_secrets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, provider, secret_name)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project
  ON project_secrets(project_id);

-- Async embedding re-indexing jobs
CREATE TABLE IF NOT EXISTS embedding_reindex_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  phase         TEXT,
  progress      REAL NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_message TEXT,
  boss_job_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embedding_reindex_jobs_project
  ON embedding_reindex_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_embedding_reindex_jobs_status
  ON embedding_reindex_jobs(status);

-- Backfill default embedding configuration for existing projects.
-- This preserves current behavior (local HuggingFace model, 384 dimensions).
INSERT INTO project_embedding_config (project_id, provider, model, dimensions, distance_metric)
SELECT id, 'local_hf', 'Snowflake/snowflake-arctic-embed-xs', 384, 'cosine'
FROM projects
ON CONFLICT (project_id) DO NOTHING;

-- Per-dimension embedding tables (symbols + document chunks)
DO $$
DECLARE
  dim INTEGER;
  dims INTEGER[] := ARRAY[384, 768, 1024, 1536, 3072, 4096];
BEGIN
  FOREACH dim IN ARRAY dims LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS symbol_embeddings_%1$s (
         id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
         node_age_id  BIGINT NOT NULL,
         symbol_name  TEXT NOT NULL,
         file_path    TEXT NOT NULL,
         label        TEXT NOT NULL,
         text_content TEXT NOT NULL,
         provider     TEXT NOT NULL,
         model        TEXT NOT NULL,
         embedding    vector(%1$s) NOT NULL,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (repository_id, node_age_id, model)
       )',
      dim
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_symbol_embeddings_%1$s_project_repo
         ON symbol_embeddings_%1$s (project_id, repository_id)',
      dim
    );

    -- pgvector hnsw indexes currently support vectors up to 2000 dimensions.
    -- Keep ANN indexes for supported dimensions and skip higher ones.
    IF dim <= 2000 THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS idx_symbol_embeddings_%1$s_hnsw
           ON symbol_embeddings_%1$s
           USING hnsw (embedding vector_cosine_ops)
           WITH (m = 16, ef_construction = 64)',
        dim
      );
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS chunk_embeddings_%1$s (
         id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         chunk_id    UUID NOT NULL,
         document_id UUID NOT NULL,
         provider    TEXT NOT NULL,
         model       TEXT NOT NULL,
         embedding   vector(%1$s) NOT NULL,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (chunk_id, model)
       )',
      dim
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_%1$s_project_doc
         ON chunk_embeddings_%1$s (project_id, document_id)',
      dim
    );

    IF dim <= 2000 THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_%1$s_hnsw
           ON chunk_embeddings_%1$s
           USING hnsw (embedding vector_cosine_ops)
           WITH (m = 16, ef_construction = 64)',
        dim
      );
    END IF;
  END LOOP;
END $$;

-- Backfill existing single-table symbol embeddings into the 384 table.
-- Older deployments used `symbol_embeddings` without project/provider/model metadata.
INSERT INTO symbol_embeddings_384
  (project_id, repository_id, node_age_id, symbol_name, file_path, label, text_content, provider, model, embedding)
SELECT
  r.project_id,
  se.repository_id,
  se.node_age_id,
  se.symbol_name,
  se.file_path,
  se.label,
  se.text_content,
  'local_hf',
  'Snowflake/snowflake-arctic-embed-xs',
  se.embedding
FROM symbol_embeddings se
JOIN repositories r ON r.id = se.repository_id
ON CONFLICT (repository_id, node_age_id, model) DO UPDATE SET
  symbol_name = EXCLUDED.symbol_name,
  file_path = EXCLUDED.file_path,
  label = EXCLUDED.label,
  text_content = EXCLUDED.text_content,
  provider = EXCLUDED.provider,
  embedding = EXCLUDED.embedding,
  updated_at = NOW();

-- Strict project isolation + config-matching checks
CREATE OR REPLACE FUNCTION validate_symbol_embedding_row()
RETURNS TRIGGER AS $$
DECLARE
  repo_project_id UUID;
  cfg RECORD;
  dim INTEGER;
BEGIN
  SELECT project_id INTO repo_project_id
  FROM repositories
  WHERE id = NEW.repository_id;

  IF repo_project_id IS NULL THEN
    RAISE EXCEPTION 'Repository % not found', NEW.repository_id;
  END IF;

  IF repo_project_id <> NEW.project_id THEN
    RAISE EXCEPTION
      'Repository % belongs to project %, but row project_id is %',
      NEW.repository_id, repo_project_id, NEW.project_id;
  END IF;

  SELECT provider, model, dimensions
  INTO cfg
  FROM project_embedding_config
  WHERE project_id = NEW.project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Missing project_embedding_config for project %', NEW.project_id;
  END IF;

  dim := substring(TG_TABLE_NAME FROM '_(\d+)$')::INTEGER;

  IF cfg.dimensions <> dim THEN
    RAISE EXCEPTION
      'Embedding dimension mismatch for project %: config=% table=%',
      NEW.project_id, cfg.dimensions, dim;
  END IF;

  IF cfg.provider <> NEW.provider OR cfg.model <> NEW.model THEN
    RAISE EXCEPTION
      'Embedding provider/model mismatch for project %: config=%/% row=%/%',
      NEW.project_id, cfg.provider, cfg.model, NEW.provider, NEW.model;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_chunk_embedding_row()
RETURNS TRIGGER AS $$
DECLARE
  cfg RECORD;
  dim INTEGER;
BEGIN
  SELECT provider, model, dimensions
  INTO cfg
  FROM project_embedding_config
  WHERE project_id = NEW.project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Missing project_embedding_config for project %', NEW.project_id;
  END IF;

  dim := substring(TG_TABLE_NAME FROM '_(\d+)$')::INTEGER;

  IF cfg.dimensions <> dim THEN
    RAISE EXCEPTION
      'Embedding dimension mismatch for project %: config=% table=%',
      NEW.project_id, cfg.dimensions, dim;
  END IF;

  IF cfg.provider <> NEW.provider OR cfg.model <> NEW.model THEN
    RAISE EXCEPTION
      'Embedding provider/model mismatch for project %: config=%/% row=%/%',
      NEW.project_id, cfg.provider, cfg.model, NEW.provider, NEW.model;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  dim INTEGER;
  dims INTEGER[] := ARRAY[384, 768, 1024, 1536, 3072, 4096];
BEGIN
  FOREACH dim IN ARRAY dims LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_validate_symbol_embedding_%1$s ON symbol_embeddings_%1$s',
      dim
    );
    EXECUTE format(
      'CREATE TRIGGER trg_validate_symbol_embedding_%1$s
         BEFORE INSERT OR UPDATE ON symbol_embeddings_%1$s
         FOR EACH ROW EXECUTE FUNCTION validate_symbol_embedding_row()',
      dim
    );

    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_validate_chunk_embedding_%1$s ON chunk_embeddings_%1$s',
      dim
    );
    EXECUTE format(
      'CREATE TRIGGER trg_validate_chunk_embedding_%1$s
         BEFORE INSERT OR UPDATE ON chunk_embeddings_%1$s
         FOR EACH ROW EXECUTE FUNCTION validate_chunk_embedding_row()',
      dim
    );
  END LOOP;
END $$;
