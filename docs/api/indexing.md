---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Indexing

## Endpoints

- [`POST /api/v1/repositories/{repoId}/index`](#post-api-v1-repositories-repoid-index) — Trigger indexing for a repository
- [`DELETE /api/v1/repositories/{repoId}/index`](#delete-api-v1-repositories-repoid-index) — Cancel a running indexing job
- [`GET /api/v1/repositories/{repoId}/index/status`](#get-api-v1-repositories-repoid-index-status) — Get indexing progress for a repository

---

## `POST /api/v1/repositories/{repoId}/index` {#post-api-v1-repositories-repoid-index}

**Trigger indexing for a repository**

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
| `mode` | `"full"` \| `"incremental"` | No | Default: `"full"` |

### Response (202)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `job_id` | string | Yes | Format: uuid |
| `message` | string | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository not found |
| `409` | Indexing already in progress |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/index" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "mode": "full"
}'
```

**Response:**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "string"
}
```

---

## `DELETE /api/v1/repositories/{repoId}/index` {#delete-api-v1-repositories-repoid-index}

**Cancel a running indexing job**

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
| `message` | string | Yes | — |
| `job_id` | string | Yes | Format: uuid |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | No active indexing job found |

### Example

**Request:**

```bash
curl -s \
  -X DELETE \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/index" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "message": "string",
  "job_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## `GET /api/v1/repositories/{repoId}/index/status` {#get-api-v1-repositories-repoid-index-status}

**Get indexing progress for a repository**

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
| `current` | object,null | Yes | — |
| `history` | object[] | Yes | — |

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
  "http://localhost:3000/api/v1/repositories/$REPO_ID/index/status" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "current": null,
  "history": [
    {
      "job_id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "string",
      "mode": "string",
      "phase": null,
      "progress": 1,
      "last_completed_phase": null,
      "started_at": null,
      "completed_at": null,
      "error_message": null,
      "files_total": 1,
      "files_done": 1,
      "created_at": "string"
    }
  ]
}
```

---
