---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Graph

## Endpoints

- [`POST /api/v1/repositories/{repoId}/graph/cypher`](#post-api-v1-repositories-repoid-graph-cypher) — Execute a raw Cypher query against a repository's graph
- [`GET /api/v1/repositories/{repoId}/graph/nodes`](#get-api-v1-repositories-repoid-graph-nodes) — List and filter graph nodes
- [`GET /api/v1/repositories/{repoId}/graph/nodes/{nodeId}`](#get-api-v1-repositories-repoid-graph-nodes-nodeid) — Get a single node with all its relationships
- [`GET /api/v1/repositories/{repoId}/graph/edges`](#get-api-v1-repositories-repoid-graph-edges) — List and filter graph edges
- [`POST /api/v1/repositories/{repoId}/graph/impact`](#post-api-v1-repositories-repoid-graph-impact) — Analyze the blast radius of a symbol change
- [`POST /api/v1/repositories/{repoId}/graph/dependencies`](#post-api-v1-repositories-repoid-graph-dependencies) — Query file-level or symbol-level dependency trees
- [`POST /api/v1/repositories/{repoId}/graph/path`](#post-api-v1-repositories-repoid-graph-path) — Find the shortest path between two symbols
- [`GET /api/v1/repositories/{repoId}/graph/stats`](#get-api-v1-repositories-repoid-graph-stats) — Get node and edge counts by type
- [`GET /api/v1/repositories/{repoId}/graph/orphans`](#get-api-v1-repositories-repoid-graph-orphans) — Find unreferenced symbols (no incoming edges)
- [`GET /api/v1/repositories/{repoId}/graph/routes`](#get-api-v1-repositories-repoid-graph-routes) — List all HTTP route handlers in the repository
- [`POST /api/v1/repositories/{repoId}/graph/architecture`](#post-api-v1-repositories-repoid-graph-architecture) — Check for architectural layer violations
- [`GET /api/v1/repositories/{repoId}/graph/communities`](#get-api-v1-repositories-repoid-graph-communities) — List detected communities with pagination
- [`GET /api/v1/repositories/{repoId}/graph/communities/{communityId}`](#get-api-v1-repositories-repoid-graph-communities-communityid) — Get a specific community with its members
- [`GET /api/v1/repositories/{repoId}/graph/processes`](#get-api-v1-repositories-repoid-graph-processes) — List detected processes with pagination
- [`GET /api/v1/repositories/{repoId}/graph/processes/{processId}`](#get-api-v1-repositories-repoid-graph-processes-processid) — Get a specific process with its ordered steps
- [`POST /api/v1/repositories/{repoId}/graph/diff-impact`](#post-api-v1-repositories-repoid-graph-diff-impact) — Analyze git diff impact on graph symbols and processes

---

## `POST /api/v1/repositories/{repoId}/graph/cypher` {#post-api-v1-repositories-repoid-graph-cypher}

**Execute a raw Cypher query against a repository's graph**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Min length: 1. Max length: 10000 |
| `params` | object | No | — |
| `columns` | object[] | No | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `rows` | object[] | Yes | — |
| `columns` | string[] | Yes | — |
| `row_count` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid query |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository not found or has no graph |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/cypher" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "query": "MATCH (f:Function) RETURN f.name, f.file_path LIMIT 10",
  "params": {},
  "columns": [
    {
      "name": "my-project"
    }
  ]
}'
```

**Response:**

```json
{
  "rows": [
    {}
  ],
  "columns": [
    "string"
  ],
  "row_count": 1
}
```

---

## `GET /api/v1/repositories/{repoId}/graph/nodes` {#get-api-v1-repositories-repoid-graph-nodes}

**List and filter graph nodes**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `label` | string | No | — | — |
| `file_path` | string | No | — | — |
| `exported` | string | No | — | — |
| `limit` | integer | No | `50` | — |
| `offset` | integer,null | No | `0` | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nodes` | object[] | Yes | — |
| `count` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid filter parameters |
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/nodes?label=value&file_path=value" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "nodes": [
    {
      "id": 1,
      "label": "ci-read-only",
      "properties": {}
    }
  ],
  "count": 1
}
```

---

## `GET /api/v1/repositories/{repoId}/graph/nodes/{nodeId}` {#get-api-v1-repositories-repoid-graph-nodes-nodeid}

**Get a single node with all its relationships**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |
| `nodeId` | string | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `node` | object | Yes | — |
| `relationships` | object | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid node ID |
| `401` | Unauthorized |
| `404` | Repository or node not found |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/nodes/<nodeId>" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "node": {
    "id": 1,
    "label": "ci-read-only",
    "properties": {}
  },
  "relationships": {
    "outgoing": [
      {
        "edge": {
          "id": 1,
          "label": "ci-read-only",
          "start_id": 1,
          "end_id": 1,
          "properties": {}
        },
        "source": {
          "id": 1,
          "label": "ci-read-only",
          "properties": {}
        },
        "target": {
          "id": 1,
          "label": "ci-read-only",
          "properties": {}
        }
      }
    ],
    "incoming": [
      {
        "edge": {
          "id": 1,
          "label": "ci-read-only",
          "start_id": 1,
          "end_id": 1,
          "properties": {}
        },
        "source": {
          "id": 1,
          "label": "ci-read-only",
          "properties": {}
        },
        "target": {
          "id": 1,
          "label": "ci-read-only",
          "properties": {}
        }
      }
    ]
  }
}
```

---

## `GET /api/v1/repositories/{repoId}/graph/edges` {#get-api-v1-repositories-repoid-graph-edges}

**List and filter graph edges**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | — | — |
| `source_label` | string | No | — | — |
| `limit` | integer | No | `50` | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `edges` | object[] | Yes | — |
| `count` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid filter parameters |
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/edges?type=value&source_label=value" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "edges": [
    {
      "edge": {
        "id": 1,
        "label": "ci-read-only",
        "start_id": 1,
        "end_id": 1,
        "properties": {}
      },
      "source": {
        "id": 1,
        "label": "ci-read-only",
        "properties": {}
      },
      "target": {
        "id": 1,
        "label": "ci-read-only",
        "properties": {}
      }
    }
  ],
  "count": 1
}
```

---

## `POST /api/v1/repositories/{repoId}/graph/impact` {#post-api-v1-repositories-repoid-graph-impact}

**Analyze the blast radius of a symbol change**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | Min length: 1. Max length: 500 |
| `direction` | `"callers"` \| `"callees"` \| `"both"` | No | Default: `"both"` |
| `depth` | integer | No | Default: `3`. Min: 1. Max: 10 |
| `file_path` | string | No | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `root` | object | Yes | — |
| `affected` | object[] | Yes | — |
| `summary` | object | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository, graph, or symbol not found |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/impact" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "symbol": "handleRequest",
  "direction": "callers",
  "depth": 3,
  "file_path": "src/index.ts"
}'
```

**Response:**

```json
{
  "root": {
    "id": 1,
    "label": "ci-read-only",
    "properties": {}
  },
  "affected": [
    {
      "id": 1,
      "label": "ci-read-only",
      "name": "my-project",
      "file_path": "src/index.ts",
      "relationship_type": "string",
      "properties": {}
    }
  ],
  "summary": {
    "total_affected": 1,
    "by_relationship_type": {}
  }
}
```

---

## `POST /api/v1/repositories/{repoId}/graph/dependencies` {#post-api-v1-repositories-repoid-graph-dependencies}

**Query file-level or symbol-level dependency trees**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_path` | string | No | — |
| `symbol` | string | No | Min length: 1. Max length: 500 |
| `depth` | integer | No | Default: `1`. Min: 1. Max: 10 |

### Response (200)

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid request — must provide file_path or symbol |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository, graph, file, or symbol not found |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/dependencies" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "file_path": "src/index.ts",
  "symbol": "handleRequest",
  "depth": 1
}'
```

**Response:**

```json
{
  "type": "file",
  "root": {
    "id": 1,
    "label": "ci-read-only",
    "properties": {}
  },
  "imports": [
    {
      "id": 1,
      "label": "ci-read-only",
      "name": "my-project",
      "file_path": "src/index.ts",
      "properties": {}
    }
  ],
  "imported_by": [
    {
      "id": 1,
      "label": "ci-read-only",
      "name": "my-project",
      "file_path": "src/index.ts",
      "properties": {}
    }
  ]
}
```

---

## `POST /api/v1/repositories/{repoId}/graph/path` {#post-api-v1-repositories-repoid-graph-path}

**Find the shortest path between two symbols**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | Yes | Min length: 1. Max length: 500 |
| `to` | string | Yes | Min length: 1. Max length: 500 |
| `max_depth` | integer | No | Default: `5`. Min: 1. Max: 10 |
| `from_file_path` | string | No | — |
| `to_file_path` | string | No | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nodes` | object[] | Yes | — |
| `edges` | object[] | Yes | — |
| `length` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository, graph, or symbol not found |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/path" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "from": "UserService",
  "to": "DatabasePool",
  "max_depth": 5,
  "from_file_path": "src/services/user.ts",
  "to_file_path": "src/db/pool.ts"
}'
```

**Response:**

```json
{
  "nodes": [
    {
      "id": 1,
      "label": "ci-read-only",
      "properties": {}
    }
  ],
  "edges": [
    {
      "id": 1,
      "label": "ci-read-only",
      "start_id": 1,
      "end_id": 1,
      "properties": {}
    }
  ],
  "length": 1
}
```

---

## `GET /api/v1/repositories/{repoId}/graph/stats` {#get-api-v1-repositories-repoid-graph-stats}

**Get node and edge counts by type**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nodes` | object | Yes | — |
| `edges` | object | Yes | — |
| `total_nodes` | number | Yes | — |
| `total_edges` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/stats" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "nodes": {},
  "edges": {},
  "total_nodes": 1,
  "total_edges": 1
}
```

---

## `GET /api/v1/repositories/{repoId}/graph/orphans` {#get-api-v1-repositories-repoid-graph-orphans}

**Find unreferenced symbols (no incoming edges)**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `label` | string | No | — | — |
| `limit` | integer | No | `100` | — |
| `offset` | integer,null | No | `0` | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `orphans` | object[] | Yes | — |
| `count` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid filter parameters |
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/orphans?label=value&limit=100" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "orphans": [
    {
      "id": 1,
      "label": "ci-read-only",
      "name": "my-project",
      "file_path": "src/index.ts",
      "properties": {}
    }
  ],
  "count": 1
}
```

---

## `GET /api/v1/repositories/{repoId}/graph/routes` {#get-api-v1-repositories-repoid-graph-routes}

**List all HTTP route handlers in the repository**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `routes` | object[] | Yes | — |
| `count` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/routes" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "routes": [
    {
      "http_method": "string",
      "url_pattern": "string",
      "framework": "string",
      "handler_name": "string",
      "file_path": "src/index.ts",
      "start_line": 1
    }
  ],
  "count": 1
}
```

---

## `POST /api/v1/repositories/{repoId}/graph/architecture` {#post-api-v1-repositories-repoid-graph-architecture}

**Check for architectural layer violations**

Defines architectural layers by file path globs and deny rules, then queries the knowledge graph for `CALLS` and `IMPORTS` edges that cross forbidden layer boundaries.

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | Repository UUID |

### Request Body

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `layers` | object | No | — | Map of layer name to file glob pattern (e.g., `{"domain": "src/domain/**"}`) |
| `rules` | object[] | No | — | Array of deny rules (see below) |
| `save` | boolean | No | `false` | Persist layers/rules to project settings for future use |
| `edge_types` | string[] | No | `["IMPORTS", "CALLS"]` | Edge types to check (`IMPORTS`, `CALLS`, or both) |

If `layers` and `rules` are omitted, the endpoint falls back to previously saved settings in the project's `settings.architecture_layers` field.

**Deny Rule Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | Yes | Layer name that the rule applies to |
| `deny` | string[] | Yes | Layer names that `from` must not depend on |

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| `violations` | object[] | Array of detected violations |
| `summary` | object | Aggregate statistics |

**Violation object:**

| Field | Type | Description |
|-------|------|-------------|
| `rule` | string | Human-readable rule description (e.g., `"domain → infrastructure (denied)"`) |
| `source_file` | string | File path of the violating source |
| `source_symbol` | string | Symbol name in the source file |
| `target_file` | string | File path of the forbidden target |
| `target_symbol` | string | Symbol name in the target file |
| `edge_type` | string | `CALLS` or `IMPORTS` |
| `line` | number \| null | Line number of the source symbol |

**Summary object:**

| Field | Type | Description |
|-------|------|-------------|
| `total_violations` | number | Total number of violations found |
| `rules_checked` | number | Number of deny rules evaluated |
| `layers_found` | number | Number of layers with classified files |
| `files_classified` | object | Map of layer name to file count |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | No layers/rules provided and none saved in project settings |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository not found or has no graph |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/architecture" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "layers": {
    "controllers": "src/controllers/**",
    "services": "src/services/**",
    "domain": "src/domain/**",
    "infrastructure": "src/infrastructure/**"
  },
  "rules": [
    { "from": "domain", "deny": ["infrastructure", "controllers"] },
    { "from": "controllers", "deny": ["infrastructure"] }
  ],
  "save": false,
  "edge_types": ["IMPORTS", "CALLS"]
}'
```

**Response:**

```json
{
  "violations": [
    {
      "rule": "domain → infrastructure (denied)",
      "source_file": "src/domain/User.ts",
      "source_symbol": "UserService",
      "target_file": "src/infrastructure/db.ts",
      "target_symbol": "query",
      "edge_type": "CALLS",
      "line": 15
    }
  ],
  "summary": {
    "total_violations": 1,
    "rules_checked": 2,
    "layers_found": 4,
    "files_classified": {
      "controllers": 5,
      "services": 3,
      "domain": 4,
      "infrastructure": 2
    }
  }
}
```

---

## `GET /api/v1/repositories/{repoId}/graph/communities` {#get-api-v1-repositories-repoid-graph-communities}

**List detected communities with pagination**

Communities are functional clusters of symbols detected via CALLS edges using the Leiden algorithm.

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | Repository UUID |

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | integer | No | `50` | Max results |
| `offset` | integer | No | `0` | Pagination offset |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `communities` | object[] | Yes | Array of community objects |
| `count` | number | Yes | Total number of communities |

Each community object includes: `community_id`, `label`, `heuristic_label`, `cohesion`, `symbol_count`, `keywords`.

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

---

## `GET /api/v1/repositories/{repoId}/graph/communities/{communityId}` {#get-api-v1-repositories-repoid-graph-communities-communityid}

**Get a specific community with its members**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | Repository UUID |
| `communityId` | string | Community ID |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `community` | object | Yes | Community metadata |
| `members` | object[] | Yes | Array of member symbols |

Each member includes: `name`, `label`, `file_path`, `line`.

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `404` | Repository or community not found |

---

## `GET /api/v1/repositories/{repoId}/graph/processes` {#get-api-v1-repositories-repoid-graph-processes}

**List detected processes with pagination and type filter**

Processes are execution flows traced from entry points through CALLS edges via BFS.

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | Repository UUID |

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | — | Filter by `intra_community` or `cross_community` |
| `limit` | integer | No | `50` | Max results |
| `offset` | integer | No | `0` | Pagination offset |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `processes` | object[] | Yes | Array of process objects |
| `count` | number | Yes | Total number of processes |

Each process includes: `process_id`, `label`, `heuristic_label`, `process_type`, `step_count`, `entry_point_name`, `terminal_name`.

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

---

## `GET /api/v1/repositories/{repoId}/graph/processes/{processId}` {#get-api-v1-repositories-repoid-graph-processes-processid}

**Get a specific process with its ordered steps**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | Repository UUID |
| `processId` | string | Process ID |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `process` | object | Yes | Process metadata |
| `steps` | object[] | Yes | Ordered array of step symbols |

Each step includes: `step` (order), `name`, `label`, `file_path`.

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `404` | Repository or process not found |

---

## `POST /api/v1/repositories/{repoId}/graph/diff-impact` {#post-api-v1-repositories-repoid-graph-diff-impact}

**Analyze git diff impact on graph symbols and processes**

Maps changed files to affected symbols, traces impact through the call graph, and identifies affected processes with risk assessment.

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | Repository UUID |

### Request Body

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scope` | `"unstaged"` \| `"staged"` \| `"all"` \| `"compare"` | No | `"all"` | Diff scope |
| `compare_ref` | string | No | — | Git ref to compare against HEAD (required when scope is `"compare"`) |
| `max_depth` | integer | No | `3` | Max depth for indirect impact tracing (1–10) |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `changed_files` | object[] | Yes | Files detected as changed |
| `direct_symbols` | object[] | Yes | Symbols directly in changed files |
| `impacted_symbols` | object[] | Yes | Symbols affected via call graph traversal |
| `affected_processes` | object[] | Yes | Processes containing affected symbols |
| `risk` | string | Yes | Risk level: `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL` |
| `summary` | object | Yes | Aggregate counts |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid request or repository is not local_path type |
| `401` | Unauthorized |
| `404` | Repository not found or has no graph |

---
