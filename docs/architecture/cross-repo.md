# Cross-Repository Resolution

NexGraph's key differentiator is its ability to trace relationships across repository boundaries within a project. This page explains the architecture behind cross-repo connection detection, resolution strategies, and traversal.

## Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                         Project                                   │
│                                                                   │
│  ┌──────────────┐    Connection Rules     ┌──────────────┐       │
│  │   Repo A     │   (repo_connections)    │   Repo B     │       │
│  │              │◄───────────────────────► │              │       │
│  │  AGE Graph   │                         │  AGE Graph   │       │
│  │  (symbols,   │    cross_repo_edges     │  (symbols,   │       │
│  │   edges)     │◄───────────────────────►│   edges)     │       │
│  └──────────────┘                         └──────────────┘       │
│                                                                   │
│  Resolution Strategies:                                           │
│    ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐        │
│    │  URL Path    │ │    Type      │ │    Package       │        │
│    │  Matching    │ │  Matching    │ │  Dependency      │        │
│    │  (urlmatch)  │ │ (typematch)  │ │  (pkgmatch)      │        │
│    └──────────────┘ └──────────────┘ └──────────────────┘        │
└───────────────────────────────────────────────────────────────────┘
```

## Data Model

Cross-repo relationships are stored in two relational tables (not in AGE graphs), because they span multiple per-repository graphs.

### Connection Rules (`repo_connections`)

A connection rule declares a relationship between two repositories that should be resolved. Each rule specifies a source repo, target repo, and a connection type that determines which resolution strategy to use.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK to projects |
| `source_repo_id` | UUID | FK to repositories (e.g., frontend) |
| `target_repo_id` | UUID | FK to repositories (e.g., backend) |
| `connection_type` | TEXT | Strategy selector (see below) |
| `match_rules` | JSONB | Additional configuration for the resolver |
| `last_resolved_at` | TIMESTAMP | When resolution last ran |
| `created_at` | TIMESTAMP | Creation time |
| `updated_at` | TIMESTAMP | Last update time |

**Connection types** (constrained by CHECK):

| Type | Resolution Strategy | Typical Use Case |
|------|-------------------|-----------------|
| `CROSS_REPO_CALLS` | URL path matching | Frontend HTTP calls to backend API routes |
| `CROSS_REPO_DEPENDS` | Package dependency matching | Repo A depends on Repo B as a package |
| `CROSS_REPO_MIRRORS` | Type matching | Shared type definitions across repos |
| `CROSS_REPO_IMPORTS` | (Reserved) | Direct import references |

### Resolved Edges (`cross_repo_edges`)

When a connection rule is resolved, the matched pairs are stored as cross-repo edges. These are separate from in-graph edges (CALLS, IMPORTS, etc.) because they link nodes across different AGE graphs.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK to projects |
| `source_repo_id` | UUID | FK to repositories |
| `target_repo_id` | UUID | FK to repositories |
| `source_node` | TEXT | Identifier of the source symbol/location |
| `target_node` | TEXT | Identifier of the target symbol/location |
| `edge_type` | TEXT | Matches the connection_type that produced it |
| `metadata` | JSONB | Resolution details (confidence, method, etc.) |
| `manual` | BOOLEAN | `true` for manually created edges, `false` for auto-resolved |
| `created_at` | TIMESTAMP | Creation time |

## Resolution Strategies

Resolution is triggered via `POST /api/v1/projects/{projectId}/connections/{connId}/resolve`. The connection type determines which strategy runs.

### 1. URL Path Matching (`CROSS_REPO_CALLS`)

**Module:** `src/ingestion/urlmatch.ts`

Connects frontend HTTP client calls to backend API route handlers. This is the primary strategy for frontend-backend repository pairs.

```
Frontend Repo                          Backend Repo
┌─────────────────────┐                ┌─────────────────────┐
│ fetch('/api/users')  │───matches──►  │ GET /api/users      │
│ axios.post('/api/    │───matches──►  │ POST /api/orders    │
│   orders', data)     │               │                     │
└─────────────────────┘                └─────────────────────┘
```

**How it works:**

1. **Load route handlers** from the target (backend) repo's AGE graph. Queries `RouteHandler` nodes created during ingestion Phase 3 (parse).
2. **Extract HTTP calls** from the source (frontend) repo's source files using regex patterns for:
   - `fetch()` calls (plain strings and template literals)
   - `axios.get/post/put/delete()` calls
   - Angular `httpClient` calls
   - Python `requests` and `httpx` calls
3. **Match calls to routes** using URL path comparison with confidence scoring:

| Match Type | Confidence | Example |
|------------|-----------|---------|
| Exact path + method | 0.95 | `GET /api/users` matches `GET /api/users` |
| Exact path, any method | 0.90 | `fetch('/api/users')` matches `GET /api/users` |
| Parameterized match + method | 0.90 | `GET /api/users/123` matches `GET /api/users/:id` |
| Template literal match | 0.80-0.85 | `` fetch(`/api/users/${id}`) `` matches `GET /api/users/:id` |
| Prefix match | 0.55-0.65 | `/api/users` matches `/api/users/:id` |

4. **Store edges** in `cross_repo_edges` with `edge_type = 'CROSS_REPO_CALLS'` and metadata containing HTTP method, source URL, target pattern, and confidence.

### 2. Type Matching (`CROSS_REPO_MIRRORS`)

**Module:** `src/ingestion/typematch.ts`

Detects shared type definitions across repositories. For example, a `UserProfile` interface in a frontend repo that mirrors a `UserProfile` class in a backend repo.

**How it works:**

1. **Load type definitions** from both repo graphs. Queries `Class`, `Interface`, and `CodeElement` nodes (filtered to type-bearing subtypes: struct, dataclass, enum, type_alias, record, trait).
2. **Load members** for structural comparison. Retrieves `Method` nodes linked by `class_name` property, and extracts field names from signatures.
3. **Score matches** using a multi-tier approach:

| Tier | Strategy | Confidence | Criteria |
|------|----------|-----------|---------|
| 1 | Exact name (normalized) | 0.80-0.95 | Names match after stripping `I-` prefix and `-Impl` suffix |
| 2 | Token-based name similarity | 0.50-0.75 | Jaccard similarity of camelCase/snake_case tokens >= 0.6 |
| 3 | Structural + name | 0.50-0.85 | Jaccard similarity of member names >= 0.5, combined with name similarity |

Name normalization handles cross-language conventions:
- `IUserProfile` (C#/TS interface) -> `UserProfile`
- `UserServiceImpl` (Java) -> `UserService`

4. **One-to-one matching**: Each target type can only be matched once. Sources are sorted by specificity (exported first, longer names first) to prioritize the best matches.
5. **Store edges** with `edge_type = 'CROSS_REPO_MIRRORS'`.

### 3. Package Dependency Matching (`CROSS_REPO_DEPENDS`)

**Module:** `src/ingestion/pkgmatch.ts`

Detects when one repository declares the other as a package dependency in its manifest files.

**Supported manifests:**

| File | Ecosystem | Sections Scanned |
|------|-----------|-----------------|
| `package.json` | npm | dependencies, devDependencies, peerDependencies, optionalDependencies |
| `Cargo.toml` | cargo | dependencies, dev-dependencies, build-dependencies |
| `go.mod` | go | require blocks |

**How it works:**

1. **Read target repo's package name** from its own manifest files (`package.json` name field, `Cargo.toml` [package] name, `go.mod` module path). Also derives names from the repo URL.
2. **Extract dependencies** from all manifest files in the source repo.
3. **Match dependencies to target repo** using ecosystem-specific strategies:

| Strategy | Confidence | Example |
|----------|-----------|---------|
| Exact name match | 0.95 | dep `my-lib` matches repo named `my-lib` |
| Scoped npm match | 0.85 | dep `@org/my-lib` matches repo `my-lib` |
| Go path contains | 0.90 | dep `github.com/org/mylib` matches repo URL |
| Cargo normalized | 0.90 | dep `my_lib` matches repo `my-lib` (hyphen/underscore equivalence) |
| Suffix match | 0.70 | dep `org-mylib` matches repo `mylib` |
| Path/git version | 0.85-0.90 | dep version `file:../my-lib` matches repo path |

4. **Store edges** with `edge_type = 'CROSS_REPO_DEPENDS'` and metadata including ecosystem, version constraint, and whether it's a dev dependency.

## Manual Edges

In addition to auto-resolved edges, users can create manual cross-repo edges via the API:

- `POST /api/v1/projects/{projectId}/connections/manual-edge` - Create a manual edge
- `DELETE /api/v1/projects/{projectId}/connections/manual-edge/{id}` - Delete a manual edge

Manual edges have `manual = TRUE` in `cross_repo_edges` and are preserved when auto-resolution re-runs (which only deletes non-manual edges for the connection type).

## Cross-Repo Traversal

Once cross-repo edges exist, two API endpoints perform multi-repo graph traversal:

### Trace (`/graph/cross-repo/trace`)

**Module:** `src/api/routes/crossRepo.ts`

BFS traversal that follows both intra-repo graph edges and cross-repo relational edges.

```
BFS Algorithm:
1. Start from a symbol in a specific repo's AGE graph
2. For each frontier node:
   a. Query the repo's AGE graph for local connections
      (CALLS, EXTENDS, IMPLEMENTS edges)
   b. Query cross_repo_edges for cross-repo connections
      matching the current repo and symbol name
3. When a cross-repo edge is found:
   - Jump to the target repo's AGE graph
   - Look up the target symbol
   - Continue BFS from there
4. Track visited (repo_id, symbol_name) to prevent cycles
5. Stop at max_depth
```

Supports `direction`: `forward` (callees/targets), `backward` (callers/dependents), or `both`.

### Impact Analysis (`/graph/cross-repo/impact`)

Same BFS approach as trace but specifically tuned for blast radius analysis:
- Always uses `backward` direction for local edges (finds callers/dependents)
- Traverses `both` directions for cross-repo edges
- Returns a summary with `total_affected`, `repos_affected`, `by_repo`, and `by_edge_type` breakdowns

## Resolution Lifecycle

```
1. User creates connection rule
   POST /connections
   ┌────────────────────┐
   │ source_repo: A     │
   │ target_repo: B     │
   │ type: CROSS_REPO_  │
   │       CALLS        │
   └────────┬───────────┘
            │
2. User triggers resolution
   POST /connections/{id}/resolve
            │
   ┌────────▼───────────┐
   │ urlmatch.ts runs:  │
   │  - Load routes B   │
   │  - Extract calls A │
   │  - Match & score   │
   │  - Delete old edges│
   │  - Insert new edges│
   └────────┬───────────┘
            │
3. Edges available for queries
   ┌────────▼───────────┐
   │ cross_repo_edges   │
   │ used by:           │
   │  - /trace          │
   │  - /impact         │
   │  - /stats          │
   │  - MCP tools       │
   └────────────────────┘
            │
4. Re-index or update → re-resolve
   (Resolution is idempotent: deletes
    old edges before inserting new ones)
```

## Design Decisions

**Why relational tables instead of AGE edges?**
Each repository has its own isolated AGE graph (`proj_<uuid>_repo_<uuid>`). AGE graphs are independent — there's no built-in way to create edges between nodes in different graphs. Using relational `cross_repo_edges` with repo IDs as foreign keys allows cross-graph relationships while keeping per-repo graphs self-contained.

**Why on-demand resolution instead of automatic?**
Resolution requires reading source files (for HTTP call extraction and manifest parsing), which can be expensive. Making it explicit via `POST .../resolve` gives users control over when resolution runs and avoids re-running on every index.

**Why confidence scores?**
Different matching strategies have different reliability. Exact name matches are near-certain; fuzzy/structural matches may be false positives. Consumers can filter by confidence threshold to tune precision vs. recall.
