# Architecture Overview

NexGraph is structured as a layered system built on PostgreSQL with Apache AGE.

## System Diagram

```
┌─────────────────────────────────────────────────┐
│                    Clients                       │
│  REST API  │  MCP (HTTP/SSE)  │  Web Frontend   │
└──────┬─────┴────────┬─────────┴────────┬────────┘
       │              │                  │
┌──────▼──────────────▼──────────────────▼────────┐
│               Hono HTTP Server                   │
│  OpenAPI Routes │ Auth Middleware │ MCP Hub      │
└──────┬──────────────┬───────────────────────────┘
       │              │             ▲
┌──────▼──────┐ ┌─────▼─────────────────────┐  │
│  pg-boss    │ │  Query Layer              │  │
│  Job Queue  │ │  Cypher│SQL│FTS│pgvector  │  │
└──────┬──────┘ └─────┬─────────────────────┘  │
       │              │                        │
┌──────▼──────────────▼───────────────────┐    │
│  PostgreSQL + AGE + pg_trgm + pgvector  │    │
│  Relational │ Property Graph │ Vectors  │    │
└─────────────────────────────────────────┘    │
                                               │
┌──────────────────────────────────────────────┤
│         MCP Stdio Transport                  │
│  (Local AI assistants: Cursor, Claude Code)  │
│  Connects via HTTP API ──────────────────────┘
└──────────────────────────────────────────────┘
```

## Key Components

### HTTP Layer
- **Hono** with `@hono/zod-openapi` for typed routes and auto-generated OpenAPI specs
- Bearer token auth with project-scoped API keys
- MCP transports (stdio and HTTP/SSE) for AI agent integration — 24 tools for code intelligence, graph analysis, search, refactoring, change analysis, and git intelligence

### Ingestion Pipeline
- 8-phase pipeline: Extract → Structure → Parse → Imports → Call Graph → Community Detection → Process Detection → Embeddings
- Managed by **pg-boss** job queue with progress tracking
- Supports incremental indexing via git diff detection
- Worker thread isolation for CPU-intensive parsing

### Database Layer
- **PostgreSQL** for relational data (projects, repos, jobs, API keys)
- **Apache AGE** for the code knowledge graph (symbols, files, edges)
- **pg_trgm** for trigram similarity search
- **pgvector** for 384-dimensional embeddings powering semantic and hybrid search
- File content stored with tsvector for BM25 full-text search

### Graph Model
- Nodes: `File`, `Folder`, `Function`, `Class`, `Interface`, `Method`, `CodeElement`, `RouteHandler`, `Struct`, `Enum`, `Trait`, `TypeAlias`, `Namespace`, `Community`, `Process`
- Edges: `CONTAINS`, `DEFINES`, `EXPOSES`, `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, `OVERRIDES`, `HANDLES`, `MEMBER_OF`, `STEP_IN_PROCESS`
- See [Graph Model](/architecture/graph-model) for details

### Cross-Repository Resolution
- Connection rules link pairs of repositories with a resolution strategy
- Three strategies: URL path matching, type matching, package dependency matching
- Resolved edges stored in relational `cross_repo_edges` table (not in AGE graphs)
- BFS traversal combines intra-repo graph queries with cross-repo relational lookups
- See [Cross-Repo Resolution](/architecture/cross-repo) for details
