-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Symbol embeddings table for semantic search
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  node_age_id BIGINT NOT NULL,
  symbol_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  label TEXT NOT NULL,
  text_content TEXT NOT NULL,
  embedding vector(384) NOT NULL,
  UNIQUE(repository_id, node_age_id)
);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
  ON symbol_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index for filtering by repository
CREATE INDEX IF NOT EXISTS idx_embeddings_repo
  ON symbol_embeddings (repository_id);

-- Add embedding tracking columns to repositories table
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS embeddings_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS embedding_count INTEGER DEFAULT 0;
