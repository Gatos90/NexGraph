---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Cross-Repo Graph

## Endpoints

- [`POST /api/v1/projects/{projectId}/graph/cross-repo/trace`](#post-api-v1-projects-projectid-graph-cross-repo-trace) — Trace end-to-end flows across connected repositories
- [`POST /api/v1/projects/{projectId}/graph/cross-repo/impact`](#post-api-v1-projects-projectid-graph-cross-repo-impact) — Analyze blast radius across connected repositories
- [`GET /api/v1/projects/{projectId}/graph/cross-repo/stats`](#get-api-v1-projects-projectid-graph-cross-repo-stats) — Get cross-repo connection statistics

---

## `POST /api/v1/projects/{projectId}/graph/cross-repo/trace` {#post-api-v1-projects-projectid-graph-cross-repo-trace}

**Trace end-to-end flows across connected repositories**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `start_repo_id` | string | Yes | Format: uuid |
| `start_symbol` | string | Yes | Min length: 1. Max length: 500 |
| `direction` | `"forward"` \| `"backward"` \| `"both"` | No | Default: `"forward"` |
| `max_depth` | integer | No | Default: `3`. Min: 1. Max: 10 |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `start` | object | Yes | — |
| `nodes` | object[] | Yes | — |
| `edges` | object[] | Yes | — |
| `depth_reached` | number | Yes | — |
| `repos_traversed` | string[] | Yes | — |

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
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/graph/cross-repo/trace" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "start_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "start_symbol": "handleRequest",
  "direction": "forward",
  "max_depth": 3
}'
```

**Response:**

```json
{
  "start": {
    "repo_id": "550e8400-e29b-41d4-a716-446655440000",
    "symbol_name": "string",
    "label": "ci-read-only",
    "file_path": "src/index.ts",
    "properties": {}
  },
  "nodes": [
    {
      "repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "symbol_name": "string",
      "label": "ci-read-only",
      "file_path": "src/index.ts",
      "properties": {}
    }
  ],
  "edges": [
    {
      "from_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "from_symbol": "string",
      "to_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "to_symbol": "string",
      "edge_type": "CROSS_REPO_CALLS",
      "cross_repo": true,
      "metadata": null
    }
  ],
  "depth_reached": 1,
  "repos_traversed": [
    "550e8400-e29b-41d4-a716-446655440000"
  ]
}
```

---

## `POST /api/v1/projects/{projectId}/graph/cross-repo/impact` {#post-api-v1-projects-projectid-graph-cross-repo-impact}

**Analyze blast radius across connected repositories**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo_id` | string | Yes | Format: uuid |
| `symbol` | string | Yes | Min length: 1. Max length: 500 |
| `depth` | integer | No | Default: `3`. Min: 1. Max: 10 |

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
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/graph/cross-repo/impact" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "symbol": "handleRequest",
  "depth": 3
}'
```

**Response:**

```json
{
  "root": {
    "repo_id": "550e8400-e29b-41d4-a716-446655440000",
    "symbol_name": "string",
    "label": "ci-read-only",
    "file_path": "src/index.ts",
    "is_cross_repo": true,
    "properties": {}
  },
  "affected": [
    {
      "repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "symbol_name": "string",
      "label": "ci-read-only",
      "file_path": "src/index.ts",
      "is_cross_repo": true,
      "properties": {}
    }
  ],
  "summary": {
    "total_affected": 1,
    "repos_affected": 1,
    "by_repo": {},
    "by_edge_type": {}
  }
}
```

---

## `GET /api/v1/projects/{projectId}/graph/cross-repo/stats` {#get-api-v1-projects-projectid-graph-cross-repo-stats}

**Get cross-repo connection statistics**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `total_edges` | number | Yes | — |
| `total_connections` | number | Yes | — |
| `by_edge_type` | object | Yes | — |
| `by_repo_pair` | object[] | Yes | — |
| `repos_involved` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/graph/cross-repo/stats" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "total_edges": 1,
  "total_connections": 1,
  "by_edge_type": {},
  "by_repo_pair": [
    {
      "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "edge_count": 1
    }
  ],
  "repos_involved": 1
}
```

---
