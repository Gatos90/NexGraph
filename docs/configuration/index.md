# Environment Variables

NexGraph is configured via environment variables. Copy `.env.example` to `.env` and edit as needed. All variables are validated at startup using [Zod](https://zod.dev/) schemas — invalid values will produce a clear error message and prevent the server from starting.

## Server

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `NODE_ENV` | `"development"` \| `"production"` \| `"test"` | `development` | Execution environment. Controls logging format and runtime behavior. |
| `PORT` | `number` (positive integer) | `3000` | HTTP server listen port. |
| `HOST` | `string` | `0.0.0.0` | HTTP server bind address (IP or hostname). |
| `API_PREFIX` | `string` | `/api/v1` | Base path prefix for all API routes. OpenAPI spec is served at `{API_PREFIX}/openapi.json`. |
| `LOG_LEVEL` | `"fatal"` \| `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"` | `info` | [Pino](https://getpino.io/) logging level. Use `debug` or `trace` for development troubleshooting. |

## Database

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DATABASE_URL` | `string` (PostgreSQL URI) | `postgresql://postgres:postgres@localhost:5432/nexgraph` | PostgreSQL connection string. Must point to a database with [Apache AGE](https://age.apache.org/), pg_trgm, and [pgvector](https://github.com/pgvector/pgvector) extensions installed. |
| `DB_POOL_MIN` | `number` (non-negative integer) | `2` | Minimum number of connections maintained in the connection pool. |
| `DB_POOL_MAX` | `number` (positive integer) | `10` | Maximum number of connections in the pool. Also used by the pg-boss job queue. |

::: tip Connection Pool Sizing
For most deployments, the defaults work well. Increase `DB_POOL_MAX` if you see connection timeout errors under heavy indexing load. Each connection loads the AGE extension on first use.
:::

## Ingestion

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_FILE_SIZE` | `number` (positive integer, bytes) | `1048576` (1 MB) | Maximum file size for indexing. Files exceeding this limit are skipped during ingestion. |
| `INGESTION_TEMP_DIR` | `string` | `""` (OS temp dir) | Directory for temporary extraction and git clone operations. Falls back to `os.tmpdir()` when empty. |
| `WORKER_POOL_SIZE` | `number` (non-negative integer) | `0` (auto) | Number of worker threads for parallel AST parsing. Set to `0` for auto-detection: `max(1, CPU_cores - 1)`. See [Worker Pool](./worker-pool) for details. |

## MCP

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MCP_STDIO` | `string` | — | Set to `"1"` to run in MCP stdio transport mode. When enabled, all logs are redirected to stderr (stdout is reserved for JSON-RPC protocol messages). This is set automatically by the MCP stdio entry point. |
| `NEXGRAPH_API_KEY` | `string` | — | API key for MCP stdio transport authentication. **Required** when running `npx nexgraph` (stdio mode) — determines which project the MCP server is scoped to. Not used by the HTTP server (which accepts per-request Bearer tokens instead). |

## Embeddings

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `EMBEDDING_ENABLED` | `"true"` \| `"false"` | `"true"` | Enable or disable the embeddings pipeline phase. When `"false"`, Phase 8 (Embeddings) is skipped during indexing and semantic/hybrid search modes are unavailable. |
| `EMBEDDING_MODEL` | `string` | `Snowflake/snowflake-arctic-embed-xs` | HuggingFace model ID for generating embeddings. The default model produces 384-dimensional vectors using `@huggingface/transformers`. |
| `EMBEDDING_BATCH_SIZE` | `number` (positive integer) | `32` | Number of symbols to embed per batch. Lower values use less memory; higher values improve throughput. |

## Example `.env`

```bash
# Server
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Database (required — must have AGE, pg_trgm, and pgvector extensions)
DATABASE_URL=postgresql://postgres:password@localhost:5432/nexgraph
DB_POOL_MIN=2
DB_POOL_MAX=10

# API
API_PREFIX=/api/v1

# MCP
# NEXGRAPH_API_KEY=nxg_your_key_here

# Ingestion
MAX_FILE_SIZE=1048576
INGESTION_TEMP_DIR=
WORKER_POOL_SIZE=0

# Embeddings
EMBEDDING_ENABLED=true
EMBEDDING_MODEL=Snowflake/snowflake-arctic-embed-xs
EMBEDDING_BATCH_SIZE=32
```

## Validation

Environment variables are parsed and validated at startup in `src/config.ts`. If any variable fails validation, the server exits with a descriptive error:

```
Invalid environment configuration:
  PORT: Expected number, received "abc"
  LOG_LEVEL: Invalid enum value. Expected 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
```

Numeric variables use `z.coerce.number()`, so string values like `"3000"` are automatically coerced to numbers.
