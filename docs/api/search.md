---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Search

## Endpoints

- [`POST /api/v1/repositories/{repoId}/search`](#post-api-v1-repositories-repoid-search) — Multi-mode search (keyword/semantic/hybrid) across repository contents
- [`POST /api/v1/repositories/{repoId}/search/grep`](#post-api-v1-repositories-repoid-search-grep) — Regex search across repository file contents
- [`POST /api/v1/projects/{projectId}/search`](#post-api-v1-projects-projectid-search) — Multi-mode search across ALL repositories in a project

---

## `POST /api/v1/repositories/{repoId}/search` {#post-api-v1-repositories-repoid-search}

**Multi-mode search across repository contents (keyword/semantic/hybrid)**

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
| `query` | string | Yes | Min length: 1. Max length: 1000 |
| `limit` | integer | No | Default: `20`. Min: 1. Max: 100 |
| `offset` | integer | No | Default: `0`. Min: 0 |
| `mode` | string | No | Default: `"keyword"`. One of: `"keyword"` (BM25 tsvector), `"semantic"` (vector cosine similarity), `"hybrid"` (RRF fusion of both) |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | Yes | Search mode used (`keyword`, `semantic`, or `hybrid`) |
| `results` | object[] | Yes | Result objects (fields vary by mode — see below) |
| `total` | number | Yes | Total result count |

**Result fields by mode:**

- **keyword**: `file_path`, `rank`, `highlights`, `language`
- **semantic**: `symbol_name`, `file_path`, `label`, `similarity`
- **hybrid**: `file_path`, `rrf_rank`, `rrf_score`, `keyword_rank`, `semantic_rank`, `symbol_name`, `label`

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository not found |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/search" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "query": "authentication token validation",
  "limit": 20,
  "offset": 0
}'
```

**Response:**

```json
{
  "mode": "keyword",
  "results": [
    {
      "file_path": "src/index.ts",
      "rank": 1,
      "highlights": "string",
      "language": null
    }
  ],
  "total": 1
}
```

---

## `POST /api/v1/repositories/{repoId}/search/grep` {#post-api-v1-repositories-repoid-search-grep}

**Regex search across repository file contents**

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
| `pattern` | string | Yes | Min length: 1. Max length: 1000 |
| `case_sensitive` | boolean | No | Default: `true` |
| `context_lines` | integer | No | Default: `2`. Min: 0. Max: 10 |
| `limit` | integer | No | Default: `100`. Min: 1. Max: 500 |
| `file_pattern` | string | No | Max length: 500 |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `matches` | object[] | Yes | — |
| `total_matches` | number | Yes | — |
| `files_searched` | number | Yes | — |
| `files_matched` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `400` | Invalid regex pattern |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository not found |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/search/grep" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "pattern": "TODO|FIXME",
  "case_sensitive": true,
  "context_lines": 2,
  "limit": 100,
  "file_pattern": "*.ts"
}'
```

**Response:**

```json
{
  "matches": [
    {
      "file_path": "src/index.ts",
      "line_number": 1,
      "line": "string",
      "context_before": [
        "string"
      ],
      "context_after": [
        "string"
      ]
    }
  ],
  "total_matches": 1,
  "files_searched": 1,
  "files_matched": 1
}
```

---

## `POST /api/v1/projects/{projectId}/search` {#post-api-v1-projects-projectid-search}

**Multi-mode search across ALL repositories in a project**

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
| `query` | string | Yes | Min length: 1. Max length: 1000 |
| `limit` | integer | No | Default: `20`. Min: 1. Max: 100 |
| `offset` | integer | No | Default: `0`. Min: 0 |
| `mode` | string | No | Default: `"keyword"`. One of: `"keyword"`, `"semantic"`, `"hybrid"` |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | Yes | Search mode used |
| `results` | object[] | Yes | Each result includes `repository_id` in addition to mode-specific fields |
| `total` | number | Yes | Total result count |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/search" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "query": "authentication token validation",
  "limit": 20,
  "offset": 0
}'
```

**Response:**

```json
{
  "mode": "keyword",
  "results": [
    {
      "file_path": "src/index.ts",
      "rank": 1,
      "highlights": "string",
      "language": null,
      "repository_id": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "total": 1
}
```

---
