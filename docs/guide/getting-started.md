# Getting Started

NexGraph is a headless code intelligence engine that builds knowledge graphs from source code and exposes them to AI agents via REST API and MCP (Model Context Protocol).

## What NexGraph Does

1. **Indexes** source code repositories (git URL, ZIP upload, or local path)
2. **Parses** code using tree-sitter to extract symbols, imports, and call graphs
3. **Stores** relationships in an Apache AGE property graph on PostgreSQL
4. **Exposes** the graph via REST API and MCP server for AI agent consumption

## Supported Languages

| Language | Symbols | Imports | Call Graph | Route Detection |
|----------|---------|---------|------------|-----------------|
| TypeScript | Yes | Yes | Yes | Express, Hono, NestJS |
| JavaScript | Yes | Yes | Yes | Express, Hono |
| Python | Yes | Yes | Yes | Flask, FastAPI |
| Go | Yes | Yes | Yes | net/http, Gin |
| Java | Yes | Yes | Yes | Spring |
| Rust | Yes | Yes | Yes | Actix, Axum |

## Prerequisites

- **Node.js** >= 20
- **PostgreSQL 18** with [Apache AGE](https://age.apache.org/), pg_trgm, and [pgvector](https://github.com/pgvector/pgvector) extensions (or use the provided Docker Compose)
- **Git** (for cloning repositories to index)

## Quick Setup

```bash
# 1. Clone and install
git clone https://github.com/nexgraph/nexgraph.git
cd nexgraph
npm install

# 2. Start PostgreSQL with AGE (Docker Compose)
docker compose up -d

# 3. Configure environment
cp .env.example .env

# 4. Run database migrations
npm run db:migrate

# 5. Start the server
npm run dev
```

The API is now available at `http://localhost:3000/api/v1`.

## What's Next

| Guide | Description |
|-------|-------------|
| [Installation](/guide/installation) | Detailed setup options (npm, Docker Compose, manual PostgreSQL) |
| [Quick Start](/guide/quick-start) | Create a project, index a repo, and query the graph in 5 minutes |
| [API Reference](/api/) | Full REST API documentation |
| [MCP Guide](/mcp/) | Connect AI agents (Cursor, Claude Code) to your code graph |
| [Architecture](/architecture/) | Understand the ingestion pipeline and graph model |
