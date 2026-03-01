# Ingestion Pipeline

The ingestion pipeline transforms source code into a queryable knowledge graph through 8 sequential phases.

## Phase 1: Extract (0–15%)

**Module:** `src/ingestion/extract.ts`

Retrieves source files from the configured source:

- **git_url** — Shallow clone with `simple-git`
- **zip_upload** — Extract with `adm-zip`
- **local_path** — Validate and traverse local directory

Applies filters:
- `.gitignore` rules via the `ignore` library
- Include/exclude globs from project settings via `picomatch`
- Max file size limit (default 1 MB)

## Phase 2: Structure (15–30%)

**Module:** `src/ingestion/structure.ts`

Builds the directory tree in the graph:
- Creates `Folder` nodes for each directory
- Creates `File` nodes for each source file
- Creates `CONTAINS` edges for parent-child relationships

Stores file contents in the `file_contents` table for full-text search.

## Phase 3: Parse (30–70%)

**Module:** `src/ingestion/parse.ts` (main thread) / `src/ingestion/parse-core.ts` (worker)

Extracts symbols from each file using tree-sitter AST analysis:
- Functions, classes, interfaces, methods, structs, enums, traits, type aliases, namespaces, constants
- Decorators, modifiers, visibility
- Route handler detection (Express, NestJS, Flask, FastAPI, Spring, Go net/http, Actix, Axum, Rails, Sinatra, ASP.NET) via `src/ingestion/routes.ts`
- Creates `DEFINES` edges from File to Symbol
- Creates `EXPOSES` edges for exported symbols
- Creates `RouteHandler` nodes with `http_method` + `url_pattern`

CPU-intensive parsing runs in worker threads. Pure extraction logic in `parse-core.ts` is isolated from DB/logger imports.

## Phase 4: Imports (70–85%)

**Module:** `src/ingestion/imports.ts`

Resolves import/export relationships:
- Language-specific import extractors (regex/line-based)
- Resolvers for TypeScript paths, Go modules, Java source roots
- Creates `IMPORTS` edges between files
- Edge deduplication via `Set<string>`

## Phase 5: Call Graph (85–92%)

**Module:** `src/ingestion/callgraph.ts`

Builds function call edges for TypeScript, JavaScript, Python, Java, Go, and Rust with three-tier confidence scoring:

| Tier | Strategy | Confidence |
|------|----------|-----------|
| 1 | Exact match against imported symbols | 0.90–0.95 |
| 2 | Fuzzy match (Levenshtein ≥ 0.70) | 0.60–0.80 |
| 3 | Global heuristic match | 0.40–0.60 |

Also detects:
- `EXTENDS` edges (class inheritance)
- `IMPLEMENTS` edges (interface implementation)
- `OVERRIDES` edges (method overrides in class hierarchies)

## Phase 6: Community Detection (92–97%)

**Module:** `src/ingestion/community.ts`

Groups related symbols into functional clusters using the Leiden community detection algorithm (Traag et al. 2019):
- Builds an in-memory graph from `CALLS` edges using the `graphology` library
- Filters degree-0 and degree-1 nodes for graphs with >10K symbols to reduce noise
- Runs vendored Leiden algorithm (graphology) for community assignment
- Creates `Community` nodes with heuristic labels (folder names, longest common prefix, or fallback "Cluster_N")
- Creates `MEMBER_OF` edges linking symbols to their community
- Computes cohesion scores (internal edges / total edges per community)
- Extracts keywords from member symbol names

## Phase 7: Process Detection (97–99%)

**Module:** `src/ingestion/process-detection.ts` + `src/ingestion/entry-point-scoring.ts`

Detects execution flow processes by tracing from entry points:
- **Entry point scoring**: RouteHandlers, exported functions, event handlers, main/init patterns
- **BFS traversal** from scored entry points through `CALLS` edges
- Creates `Process` nodes (type: `intra_community` or `cross_community`)
- Creates `STEP_IN_PROCESS` edges with step ordering
- Deduplicates paths, keeps longest per entry-terminal pair
- Limits: max_depth=10, max_branching=4, max_processes=75, min_steps=3

## Phase 8: Embeddings (99–100%)

**Module:** `src/ingestion/embeddings.ts`

Generates vector embeddings for semantic search:
- Uses `@huggingface/transformers` with model `Snowflake/snowflake-arctic-embed-xs`
- Produces 384-dimensional vectors for each symbol
- Stores in `symbol_embeddings` table with HNSW index (pgvector)
- Batched processing (configurable batch size, default 32)
- Deletes stale embeddings for removed symbols
- Controlled by `EMBEDDING_ENABLED` env var (default: `true`)
- Enables three search modes: keyword (BM25), semantic (cosine similarity), hybrid (RRF fusion)

## Incremental Indexing

After the initial full index, `src/ingestion/incremental.ts` uses `git diff` to detect changes and only re-processes affected files. It also identifies "reverse importers" (files that imported changed modules) for re-resolution.

All 8 phases re-run during incremental indexing, but phases 1–5 are scoped to changed files only. Phases 6–8 (community, process, embeddings) re-run on the full graph to ensure consistency.
