# Database Layer

NexGraph uses PostgreSQL with three extensions: Apache AGE (property graphs), pg_trgm (trigram similarity), and pgvector (vector similarity for semantic search).

## Relational Tables

### `projects`
Top-level organizational unit.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `name` | TEXT | Project name |
| `settings` | JSONB | Project-level settings (include/exclude globs, architecture layers) |
| `created_at` | TIMESTAMP | Creation time |
| `updated_at` | TIMESTAMP | Last update time |

### `api_keys`
Project-scoped authentication keys.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK to projects |
| `key_hash` | TEXT | SHA-256 hash of the full key (UNIQUE) |
| `key_prefix` | TEXT | First 8 characters for identification |
| `permissions` | JSONB | Array of permission strings |
| `revoked` | BOOLEAN | Soft-delete flag |
| `expires_at` | TIMESTAMP | Optional expiry |

### `repositories`
Source code targets for indexing.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK to projects |
| `name` | TEXT | Repository display name |
| `url` | TEXT | Source URL or path |
| `source_type` | TEXT | `git_url`, `zip_upload`, or `local_path` |
| `default_branch` | TEXT | Default git branch |
| `graph_name` | TEXT | AGE graph name (UNIQUE) |
| `last_indexed_commit` | TEXT | SHA for incremental indexing |
| `community_detected_at` | TIMESTAMP | When community detection last ran |
| `community_count` | INTEGER | Number of detected communities |
| `process_count` | INTEGER | Number of detected processes |
| `embeddings_generated_at` | TIMESTAMP | When embedding generation last ran |
| `embedding_count` | INTEGER | Number of generated symbol embeddings |

### `indexed_files`
Tracked files for change detection.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `repository_id` | UUID | FK to repositories |
| `file_path` | TEXT | Relative path |
| `language` | TEXT | Detected programming language |
| `content_hash` | TEXT | SHA-256 hash of file content |

### `indexing_jobs`
Job queue tracking.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `repository_id` | UUID | FK to repositories |
| `status` | TEXT | `queued`, `running`, `completed`, `failed`, `cancelled` |
| `mode` | TEXT | `full` or `incremental` |
| `phase` | TEXT | Current pipeline phase |
| `progress` | REAL | 0.0–1.0 progress value |
| `last_completed_phase` | INTEGER | For resume support |
| `files_total` | INTEGER | Total files to process |
| `files_done` | INTEGER | Files processed so far |
| `error_message` | TEXT | Error details if failed |
| `boss_job_id` | TEXT | pg-boss job ID for cancellation |

### `file_contents`
Stored file content for full-text search (BM25) and regex grep.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `repository_id` | UUID | FK to repositories |
| `file_path` | TEXT | Relative path |
| `content` | TEXT | Raw file content |
| `search_vector` | TSVECTOR | PostgreSQL FTS index |

### `symbol_embeddings`
Vector embeddings for semantic and hybrid search (requires pgvector extension).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `repository_id` | UUID | FK to repositories |
| `node_age_id` | BIGINT | AGE graph node identifier |
| `symbol_name` | TEXT | Symbol name |
| `file_path` | TEXT | File containing the symbol |
| `label` | TEXT | Node label (Function, Class, etc.) |
| `text_content` | TEXT | Text used to generate the embedding |
| `embedding` | vector(384) | 384-dimensional embedding vector |

Indexed with HNSW for fast approximate nearest-neighbor search:
```sql
CREATE INDEX idx_symbol_embeddings_hnsw ON symbol_embeddings
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### `repo_connections`
Cross-repo connection rules that define which repositories should be linked and how.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK to projects |
| `source_repo_id` | UUID | FK to repositories |
| `target_repo_id` | UUID | FK to repositories |
| `connection_type` | TEXT | `CROSS_REPO_CALLS`, `CROSS_REPO_IMPORTS`, `CROSS_REPO_DEPENDS`, or `CROSS_REPO_MIRRORS` |
| `match_rules` | JSONB | Additional resolver configuration |
| `last_resolved_at` | TIMESTAMP | When resolution last ran |
| `created_at` | TIMESTAMP | Creation time |
| `updated_at` | TIMESTAMP | Last update time |

Unique constraint on `(source_repo_id, target_repo_id, connection_type)`.

### `cross_repo_edges`
Resolved edges discovered across repository boundaries. See [Cross-Repo Resolution](/architecture/cross-repo) for details.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK to projects |
| `source_repo_id` | UUID | FK to repositories |
| `target_repo_id` | UUID | FK to repositories |
| `source_node` | TEXT | Source symbol identifier |
| `target_node` | TEXT | Target symbol identifier |
| `edge_type` | TEXT | Matches the connection_type that produced it |
| `metadata` | JSONB | Resolution details (confidence, method, etc.) |
| `manual` | BOOLEAN | `true` for user-created edges, `false` for auto-resolved |
| `created_at` | TIMESTAMP | Creation time |

## Apache AGE Graphs

Each repository gets its own named graph: `proj_<uuid>_repo_<uuid>` (hyphens replaced with underscores).

AGE is initialized on every connection:

```sql
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
```

## Migrations

SQL migration files in `src/db/migrations/` are run in sorted order. Each migration executes in a transaction and is tracked in the `schema_migrations` table to prevent re-running.

```bash
npm run db:migrate
```

Current migrations:
1. Initial schema (projects, api_keys, repositories, indexed_files, indexing_jobs)
2. API key auth fields (key_hash UNIQUE)
3. Repository source_type and name
4. Indexing phase tracking
5. Indexing queue fields (boss_job_id, mode, cancelled status)
6. Connection match_rules
7. Incremental indexing (last_indexed_commit, changed_files_count)
8. File contents search (tsvector + GIN index)
9. Cross-repo edges manual flag
10. Connections last_resolved_at
11. Community & process detection (community_detected_at, community_count, process_count)
12. Vector search (pgvector extension, symbol_embeddings table, HNSW index)
