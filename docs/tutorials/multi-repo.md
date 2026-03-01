# Cross-Repo Connections Tutorial

This step-by-step tutorial walks through setting up cross-repository connections in NexGraph, linking a frontend and backend repo so you can trace API calls, shared types, and dependencies across repo boundaries.

## Prerequisites

- NexGraph running locally (see [Installation](/guide/installation))
- Database migrations applied
- A project with an API key (see [Index Your First Repo](/tutorials/index))

## Overview

When your codebase spans multiple repositories — for example a React frontend and an Express backend — NexGraph can detect and trace relationships between them. This tutorial covers:

1. Adding two repositories to a project
2. Creating connection rules between them
3. Resolving connections via URL path matching
4. Running cross-repo trace and impact analysis
5. Creating manual edges for edge cases

## Step 1: Create a Project and API Key

```bash
export API_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "fullstack-app"}')

echo $API_RESPONSE | jq .

export PROJECT_ID=$(echo $API_RESPONSE | jq -r '.project.id')
export API_KEY=$(echo $API_RESPONSE | jq -r '.api_key.key')
```

## Step 2: Add Two Repositories

Add the backend repository:

```bash
export BACKEND=$(curl -s -X POST http://localhost:3000/api/v1/repositories \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://github.com/your-org/backend-api.git",
    "source_type": "git_url",
    "name": "backend"
  }')

export BACKEND_ID=$(echo $BACKEND | jq -r '.id')
echo "Backend repo ID: $BACKEND_ID"
```

Add the frontend repository:

```bash
export FRONTEND=$(curl -s -X POST http://localhost:3000/api/v1/repositories \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://github.com/your-org/frontend-app.git",
    "source_type": "git_url",
    "name": "frontend"
  }')

export FRONTEND_ID=$(echo $FRONTEND | jq -r '.id')
echo "Frontend repo ID: $FRONTEND_ID"
```

## Step 3: Index Both Repositories

Trigger indexing for both repos. NexGraph runs the 8-phase ingestion pipeline (extract, structure, parse, imports, callgraph, community detection, process detection, embeddings) for each:

```bash
# Index backend
curl -s -X POST http://localhost:3000/api/v1/repositories/$BACKEND_ID/index \
  -H "Authorization: Bearer $API_KEY" | jq .

# Index frontend
curl -s -X POST http://localhost:3000/api/v1/repositories/$FRONTEND_ID/index \
  -H "Authorization: Bearer $API_KEY" | jq .
```

Monitor progress until both jobs complete:

```bash
# Check indexing jobs for the project
curl -s http://localhost:3000/api/v1/indexing/jobs \
  -H "Authorization: Bearer $API_KEY" | jq '.jobs[] | {repo_id, status, phase, progress}'
```

Wait until both show `"status": "completed"` before continuing.

## Step 4: Create Connection Rules

Connection rules tell NexGraph how to link symbols between repos. There are four connection types:

| Type | Strategy | Use Case |
|------|----------|----------|
| `CROSS_REPO_CALLS` | URL path matching | Frontend HTTP calls to backend API routes |
| `CROSS_REPO_MIRRORS` | Type matching | Shared DTOs/interfaces across repos |
| `CROSS_REPO_DEPENDS` | Package dependency matching | npm/pip/go module imports |
| `CROSS_REPO_IMPORTS` | Direct import resolution | Monorepo-style cross-package imports |

### 4a: Create a URL Path Matching Connection (Frontend → Backend)

This connects frontend HTTP client calls (e.g., `fetch("/api/users")`) to backend route handlers (e.g., `app.get("/api/users", handler)`):

```bash
export CONN_CALLS=$(curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"source_repo_id\": \"$FRONTEND_ID\",
    \"target_repo_id\": \"$BACKEND_ID\",
    \"connection_type\": \"CROSS_REPO_CALLS\",
    \"match_rules\": {
      \"strip_base_url\": true,
      \"ignore_query_params\": true
    }
  }")

export CONN_CALLS_ID=$(echo $CONN_CALLS | jq -r '.id')
echo "Connection rule created: $CONN_CALLS_ID"
echo $CONN_CALLS | jq .
```

### 4b: Create a Type Matching Connection

This connects type definitions that share the same name across repos (e.g., `UserDTO` in both frontend and backend):

```bash
export CONN_TYPES=$(curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"source_repo_id\": \"$FRONTEND_ID\",
    \"target_repo_id\": \"$BACKEND_ID\",
    \"connection_type\": \"CROSS_REPO_MIRRORS\",
    \"match_rules\": {}
  }")

export CONN_TYPES_ID=$(echo $CONN_TYPES | jq -r '.id')
echo "Type matching connection created: $CONN_TYPES_ID"
```

## Step 5: Resolve Connections

Creating a connection rule only defines *how* repos should be linked. You must **resolve** the connection to actually detect matching symbols and create cross-repo edges.

### 5a: Resolve URL Path Matching

```bash
curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_CALLS_ID/resolve \
  -H "Authorization: Bearer $API_KEY" | jq .
```

Example response:

```json
{
  "connection_id": "...",
  "edges_created": 12,
  "strategy": "url_path_matching",
  "details": {
    "calls_detected": 18,
    "routes_loaded": 25
  }
}
```

The resolver works by:
1. Scanning the **source repo** (frontend) for HTTP call sites — `fetch()`, `axios.get()`, `http.request()`, etc.
2. Scanning the **target repo** (backend) for route handler definitions — Express `app.get()`, FastAPI `@app.route()`, Spring `@GetMapping`, etc.
3. Matching URL paths from calls to route patterns (handling path parameters like `/users/:id` ↔ `/users/123`)
4. Creating `CROSS_REPO_CALLS` edges in the `cross_repo_edges` table

### 5b: Resolve Type Matching

```bash
curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_TYPES_ID/resolve \
  -H "Authorization: Bearer $API_KEY" | jq .
```

Example response:

```json
{
  "connection_id": "...",
  "edges_created": 5,
  "strategy": "type_matching",
  "details": {
    "source_types_loaded": 42,
    "target_types_loaded": 38,
    "matches_found": 5
  }
}
```

### 5c: Inspect Resolved Edges

After resolving, list the edges that were created:

```bash
curl -s "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_CALLS_ID/edges?limit=10" \
  -H "Authorization: Bearer $API_KEY" | jq '.edges[] | {source_node, target_node, edge_type}'
```

Example output:

```json
{"source_node": "fetchUsers", "target_node": "getUsersHandler", "edge_type": "CROSS_REPO_CALLS"}
{"source_node": "createOrder", "target_node": "postOrderHandler", "edge_type": "CROSS_REPO_CALLS"}
```

## Step 6: Cross-Repo Trace

Trace follows a symbol through local and cross-repo edges to show end-to-end flows. For example, tracing forward from a backend handler to see what calls it in the frontend:

```bash
curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/graph/cross-repo/trace \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"start_repo_id\": \"$BACKEND_ID\",
    \"start_symbol\": \"getUsersHandler\",
    \"direction\": \"backward\",
    \"max_depth\": 3
  }" | jq .
```

Example response:

```json
{
  "start": {
    "repo_id": "<backend-id>",
    "symbol_name": "getUsersHandler",
    "label": "Function",
    "file_path": "src/routes/users.ts"
  },
  "nodes": [
    {
      "repo_id": "<frontend-id>",
      "symbol_name": "fetchUsers",
      "label": "Function",
      "file_path": "src/api/users.ts"
    },
    {
      "repo_id": "<frontend-id>",
      "symbol_name": "UserList",
      "label": "Function",
      "file_path": "src/components/UserList.tsx"
    }
  ],
  "edges": [
    {
      "from_repo_id": "<frontend-id>",
      "from_symbol": "fetchUsers",
      "to_repo_id": "<backend-id>",
      "to_symbol": "getUsersHandler",
      "edge_type": "CROSS_REPO_CALLS",
      "cross_repo": true
    },
    {
      "from_repo_id": "<frontend-id>",
      "from_symbol": "UserList",
      "to_repo_id": "<frontend-id>",
      "to_symbol": "fetchUsers",
      "edge_type": "LOCAL",
      "cross_repo": false
    }
  ],
  "depth_reached": 2,
  "repos_traversed": ["<backend-id>", "<frontend-id>"]
}
```

Trace direction options:
- `"forward"` — follow calls/dependencies downstream (what does this symbol use?)
- `"backward"` — follow callers/dependents upstream (what uses this symbol?)
- `"both"` — traverse in both directions

## Step 7: Cross-Repo Impact Analysis

Impact analysis shows the blast radius of changing a symbol. Unlike trace, impact always analyzes backward (who depends on this?) and provides a summary:

```bash
curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/graph/cross-repo/impact \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"repo_id\": \"$BACKEND_ID\",
    \"symbol\": \"UserDTO\",
    \"depth\": 3
  }" | jq .
```

Example response:

```json
{
  "root": {
    "repo_id": "<backend-id>",
    "symbol_name": "UserDTO",
    "label": "Interface",
    "file_path": "src/types/user.ts",
    "is_cross_repo": false
  },
  "affected": [
    {
      "repo_id": "<backend-id>",
      "symbol_name": "getUsersHandler",
      "is_cross_repo": false
    },
    {
      "repo_id": "<frontend-id>",
      "symbol_name": "UserDTO",
      "is_cross_repo": true
    },
    {
      "repo_id": "<frontend-id>",
      "symbol_name": "UserList",
      "is_cross_repo": true
    }
  ],
  "summary": {
    "total_affected": 3,
    "repos_affected": 2,
    "by_repo": {
      "<backend-id>": 1,
      "<frontend-id>": 2
    },
    "by_edge_type": {
      "LOCAL": 1,
      "CROSS_REPO_MIRRORS": 2
    }
  }
}
```

This tells you: changing `UserDTO` in the backend affects 3 symbols across 2 repos — invaluable for planning safe refactors.

## Step 8: Manual Edges for Edge Cases

Automated resolution handles most connections, but some relationships can't be auto-detected. For these cases, create manual cross-repo edges:

### When to Use Manual Edges

- **Event-driven communication** — A backend emits events that a frontend WebSocket handler consumes (no HTTP URL to match)
- **Shared config/feature flags** — A config key defined in one repo is read by another
- **gRPC or non-HTTP protocols** — Protocol buffer services that don't use URL path matching
- **Dynamic dispatch** — Runtime-resolved dependencies that static analysis misses

### Creating a Manual Edge

```bash
curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/manual-edge \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"source_repo_id\": \"$BACKEND_ID\",
    \"target_repo_id\": \"$FRONTEND_ID\",
    \"source_node\": \"emitOrderUpdate\",
    \"target_node\": \"onOrderUpdate\",
    \"edge_type\": \"CROSS_REPO_CALLS\",
    \"metadata\": {
      \"protocol\": \"websocket\",
      \"event\": \"order.updated\",
      \"notes\": \"Backend emits via Socket.IO, frontend listens\"
    }
  }" | jq .
```

The manual edge now participates in trace and impact analysis just like auto-resolved edges.

### Deleting a Manual Edge

If a manual edge is no longer valid:

```bash
# Get the edge ID from the creation response, then:
export EDGE_ID="<edge-uuid>"

curl -s -X DELETE \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/manual-edge/$EDGE_ID \
  -H "Authorization: Bearer $API_KEY"
```

Only edges created with `manual: true` can be deleted this way. Auto-resolved edges are managed by their connection rule.

## Step 9: View Cross-Repo Statistics

Get an overview of all cross-repo relationships in your project:

```bash
curl -s http://localhost:3000/api/v1/projects/$PROJECT_ID/graph/cross-repo/stats \
  -H "Authorization: Bearer $API_KEY" | jq .
```

Example response:

```json
{
  "total_edges": 17,
  "total_connections": 2,
  "by_edge_type": {
    "CROSS_REPO_CALLS": 12,
    "CROSS_REPO_MIRRORS": 5
  },
  "by_repo_pair": [
    {
      "source_repo_id": "<frontend-id>",
      "target_repo_id": "<backend-id>",
      "edge_count": 17
    }
  ],
  "repos_involved": 2
}
```

## Updating Connection Rules

To change match rules on an existing connection without deleting it:

```bash
curl -s -X PATCH \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_CALLS_ID \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "match_rules": {
      "strip_base_url": true,
      "ignore_query_params": true,
      "path_prefix": "/api/v2"
    }
  }' | jq .
```

After updating rules, re-resolve the connection to pick up changes:

```bash
curl -s -X POST \
  http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_CALLS_ID/resolve \
  -H "Authorization: Bearer $API_KEY" | jq .
```

## Connection Types Reference

### CROSS_REPO_CALLS (URL Path Matching)

Best for: frontend/backend pairs where the frontend makes HTTP calls to the backend.

The resolver scans for:
- **Client calls**: `fetch()`, `axios.*()`, `http.request()`, `$.ajax()`, etc.
- **Route handlers**: Express (`app.get`), Hono (`app.route`), FastAPI (`@app.get`), Spring (`@GetMapping`), etc.

Matching handles path parameters (`/users/:id` matches `/users/123`) and strips common base URLs.

### CROSS_REPO_MIRRORS (Type Matching)

Best for: repos that share type/interface definitions (e.g., DTOs, API contracts).

The resolver compares exported Class, Interface, and type-alias symbols by name. Exact name matches produce `CROSS_REPO_MIRRORS` edges.

### CROSS_REPO_DEPENDS (Package Dependency Matching)

Best for: repos where one publishes a package that another consumes (e.g., shared libraries).

The resolver reads `package.json`, `go.mod`, `requirements.txt`, etc. to find dependency relationships.

## Next Steps

- [Query the Graph](/tutorials/query-graph) — Run Cypher queries against individual repo graphs
- [Architecture: Graph Model](/architecture/graph-model) — Understand the node/edge schema
- [Architecture: Ingestion Pipeline](/architecture/ingestion) — How indexing works
