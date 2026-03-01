# Installation

## Install NexGraph

### Option A: npm

```bash
git clone https://github.com/nexgraph/nexgraph.git
cd nexgraph
npm install
```

### Option B: From source (development)

```bash
git clone https://github.com/nexgraph/nexgraph.git
cd nexgraph
npm install
npm run build
```

## Database Setup

NexGraph requires **PostgreSQL 18** with three extensions: [Apache AGE](https://age.apache.org/) (property graphs), pg_trgm (trigram similarity), and [pgvector](https://github.com/pgvector/pgvector) (vector similarity search). Earlier PostgreSQL versions are not supported due to AGE extension compatibility.

### Option 1: Docker Compose (Recommended)

The repository includes a `docker-compose.yml` that builds a custom PostgreSQL 18 image with AGE, pg_trgm, and pgvector pre-installed:

```bash
docker compose up -d
```

This starts PostgreSQL on port 5432 with:
- User: `postgres`
- Password: `postgres`
- Database: `nexgraph`
- Persistent volume: `nexgraph-data`

Verify the database is running:

```bash
docker compose ps
```

### Option 2: Docker (standalone)

Build the custom database image first (includes pgvector alongside AGE):

```bash
docker build -f Dockerfile.db -t nexgraph-db .
docker run -d \
  --name nexgraph-db \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=nexgraph \
  -p 5432:5432 \
  nexgraph-db
```

Then create the extensions:

```bash
docker exec -i nexgraph-db psql -U postgres -d nexgraph -c \
  "CREATE EXTENSION IF NOT EXISTS age; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;"
```

### Option 3: Manual Installation

1. Install PostgreSQL 18
2. Install extensions: [Apache AGE](https://age.apache.org/age-manual/master/intro/setup.html), [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) (usually bundled with PostgreSQL), and [pgvector](https://github.com/pgvector/pgvector)
3. Create the database:

```sql
CREATE DATABASE nexgraph;
```

4. Enable all required extensions:

```sql
\c nexgraph
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
SELECT * FROM ag_catalog.create_graph('test_graph');
SELECT * FROM ag_catalog.drop_graph('test_graph', true);
```

## Environment Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

The defaults work out of the box with the Docker Compose setup. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/nexgraph` | PostgreSQL connection string |
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `API_PREFIX` | `/api/v1` | API route prefix |
| `MAX_FILE_SIZE` | `1048576` | Max file size for indexing (bytes, default 1 MB) |
| `WORKER_POOL_SIZE` | `0` | Worker threads for AST parsing (0 = auto: CPU cores - 1) |

See [Configuration](/configuration/) for the full list.

## Run Migrations

Create the database tables and set up AGE extensions:

```bash
npm run db:migrate
```

## Start the Server

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

The API is available at `http://localhost:3000/api/v1`. Verify it's running:

```bash
curl http://localhost:3000/api/v1/openapi.json | head -c 200
```

## Next Steps

- [Quick Start](/guide/quick-start) — Create a project and index your first repo
- [Architecture](/architecture/) — Understand the internals
