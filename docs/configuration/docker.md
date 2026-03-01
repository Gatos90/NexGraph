# Docker Compose

NexGraph ships with a `docker-compose.yml` for quick deployment. It defines two services: the NexGraph API server and a PostgreSQL database with Apache AGE (graph), pg_trgm (trigram similarity), and pgvector (vector similarity) extensions.

## Services

### `app` — NexGraph API

| Setting | Value | Description |
|---------|-------|-------------|
| **Build** | `Dockerfile` (local) | Multi-stage build: compiles TypeScript, installs production deps |
| **Port** | `3000:3000` | HTTP API exposed on host port 3000 |
| **Restart** | `unless-stopped` | Automatically restarts on crash |
| **Depends on** | `db` (healthy) | Waits for PostgreSQL health check before starting |

**Environment variables passed:**

```yaml
NODE_ENV: production
PORT: 3000
HOST: 0.0.0.0
DATABASE_URL: postgresql://postgres:postgres@db:5432/nexgraph
DB_POOL_MIN: 2
DB_POOL_MAX: 10
LOG_LEVEL: info
API_PREFIX: /api/v1
```

**Volumes:**

| Mount | Container path | Purpose |
|-------|---------------|---------|
| `nexgraph-repos` | `/tmp/nexgraph` | Persistent storage for cloned repositories |

### `db` — PostgreSQL + Apache AGE + pgvector

| Setting | Value | Description |
|---------|-------|-------------|
| **Build** | `Dockerfile.db` (local) | Extends `apache/age:latest` (PostgreSQL 18) with pgvector extension |
| **Port** | `5432:5432` | PostgreSQL exposed on host port 5432 |
| **Health check** | `pg_isready -U postgres` | 5s interval, 5s timeout, 5 retries |

**Environment variables:**

| Variable | Value | Description |
|----------|-------|-------------|
| `POSTGRES_USER` | `postgres` | Database superuser name |
| `POSTGRES_PASSWORD` | `postgres` | Database superuser password |
| `POSTGRES_DB` | `nexgraph` | Database name created on first start |

::: warning Production Credentials
The default `postgres:postgres` credentials are for development only. For production, use strong passwords and consider using Docker secrets or an external secret manager.
:::

**Volumes:**

| Mount | Container path | Purpose |
|-------|---------------|---------|
| `nexgraph-data` | `/var/lib/postgresql` | Persistent database storage |
| `./scripts/init-db.sh` | `/docker-entrypoint-initdb.d/init-db.sh` (read-only) | Initialization script that creates AGE, pg_trgm, and pgvector extensions |

## Named Volumes

| Volume | Purpose |
|--------|---------|
| `nexgraph-data` | PostgreSQL data directory — persists database across container restarts |
| `nexgraph-repos` | Cloned repository storage — persists indexed repositories |

## Startup Sequence

1. Docker Compose starts the `db` service
2. On first run, `init-db.sh` creates the AGE, pg_trgm, and pgvector extensions
3. Health check confirms PostgreSQL is accepting connections
4. The `app` service starts, running `docker-entrypoint.sh`:
   - Runs database migrations (`node dist/db/migrate.js`)
   - Starts the NexGraph server (`node dist/index.js`)

## Dockerfile

The multi-stage `Dockerfile` produces a minimal production image:

### Build stage (`node:20-slim`)

- Installs build tools: `python3`, `make`, `g++`, `git` (for native tree-sitter addon compilation)
- Runs `npm ci` to install all dependencies
- Compiles TypeScript to `dist/`

### Production stage (`node:20-slim`)

- Installs only `git` (needed at runtime for `simple-git` operations)
- Runs `npm ci --omit=dev` for production-only dependencies
- Copies compiled output and migration SQL files from build stage
- Defaults: `NODE_ENV=production`, `PORT=3000`, `HOST=0.0.0.0`
- Exposes port `3000`

## Dockerfile.db

The database service uses a custom `Dockerfile.db` that extends the Apache AGE image with pgvector:

```dockerfile
FROM apache/age:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-18-pgvector \
  && rm -rf /var/lib/apt/lists/*
```

This is required because the base `apache/age:latest` image does not include pgvector, which NexGraph uses for semantic and hybrid search (vector similarity).

## Customizing the Deployment

### Override environment variables

Create a `docker-compose.override.yml` or use `--env-file`:

```yaml
# docker-compose.override.yml
services:
  app:
    environment:
      LOG_LEVEL: debug
      DB_POOL_MAX: 20
      WORKER_POOL_SIZE: 4
      MAX_FILE_SIZE: 5242880  # 5 MB
      EMBEDDING_ENABLED: "true"
      EMBEDDING_MODEL: Snowflake/snowflake-arctic-embed-xs
      EMBEDDING_BATCH_SIZE: 32
```

### Use an external database

Remove the `db` service and point `DATABASE_URL` to your PostgreSQL instance:

```yaml
services:
  app:
    environment:
      DATABASE_URL: postgresql://user:pass@your-db-host:5432/nexgraph
    depends_on: []
```

The external database must have the Apache AGE, pg_trgm, and pgvector extensions installed. See the [Installation guide](/guide/installation) for details.

### Expose MCP stdio

To run the MCP stdio transport instead of the HTTP API:

```yaml
services:
  app:
    command: ["node", "dist/mcp/stdio.js"]
    stdin_open: true
```
