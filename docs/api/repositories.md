---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Repositories

## Endpoints

- [`POST /api/v1/repositories`](#post-api-v1-repositories) — Add a repository to the project
- [`GET /api/v1/repositories`](#get-api-v1-repositories) — List repositories in the authenticated project
- [`GET /api/v1/repositories/{repoId}`](#get-api-v1-repositories-repoid) — Get repository details including indexing status
- [`PATCH /api/v1/repositories/{repoId}`](#patch-api-v1-repositories-repoid) — Update repository settings
- [`DELETE /api/v1/repositories/{repoId}`](#delete-api-v1-repositories-repoid) — Delete a repository and its AGE graph

---

## `POST /api/v1/repositories` {#post-api-v1-repositories}

**Add a repository to the project**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Min length: 1. Max length: 255 |
| `source_type` | `"git_url"` \| `"zip_upload"` \| `"local_path"` | Yes | — |
| `url` | string | Yes | Min length: 1. Max length: 2048 |
| `default_branch` | string | No | Default: `"main"`. Min length: 1. Max length: 255 |

### Response (201)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `project_id` | string | Yes | Format: uuid |
| `name` | string,null | Yes | — |
| `source_type` | `"git_url"` \| `"zip_upload"` \| `"local_path"` | Yes | — |
| `url` | string | Yes | — |
| `default_branch` | string | Yes | — |
| `graph_name` | string,null | Yes | — |
| `last_indexed_at` | string,null | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `409` | Repository already exists in this project |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/repositories" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "my-project",
  "source_type": "git_url",
  "url": "https://github.com/expressjs/express.git",
  "default_branch": "main"
}'
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": null,
  "source_type": "git_url",
  "url": "https://github.com/expressjs/express.git",
  "default_branch": "main",
  "graph_name": null,
  "last_indexed_at": null,
  "created_at": "string",
  "updated_at": "string"
}
```

---

## `GET /api/v1/repositories` {#get-api-v1-repositories}

**List repositories in the authenticated project**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repositories` | object[] | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "repositories": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "project_id": "550e8400-e29b-41d4-a716-446655440000",
      "name": null,
      "source_type": "git_url",
      "url": "https://github.com/expressjs/express.git",
      "default_branch": "main",
      "graph_name": null,
      "last_indexed_at": null,
      "created_at": "string",
      "updated_at": "string"
    }
  ]
}
```

---

## `GET /api/v1/repositories/{repoId}` {#get-api-v1-repositories-repoid}

**Get repository details including indexing status**

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
| `id` | string | Yes | Format: uuid |
| `project_id` | string | Yes | Format: uuid |
| `name` | string,null | Yes | — |
| `source_type` | `"git_url"` \| `"zip_upload"` \| `"local_path"` | Yes | — |
| `url` | string | Yes | — |
| `default_branch` | string | Yes | — |
| `graph_name` | string,null | Yes | — |
| `last_indexed_at` | string,null | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |
| `indexing_status` | object,null | Yes | — |

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
  "http://localhost:3000/api/v1/repositories/$REPO_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": null,
  "source_type": "git_url",
  "url": "https://github.com/expressjs/express.git",
  "default_branch": "main",
  "graph_name": null,
  "last_indexed_at": null,
  "created_at": "string",
  "updated_at": "string",
  "indexing_status": null
}
```

---

## `PATCH /api/v1/repositories/{repoId}` {#patch-api-v1-repositories-repoid}

**Update repository settings**

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
| `name` | string,null | No | Min length: 1. Max length: 255 |
| `default_branch` | string | No | Min length: 1. Max length: 255 |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `project_id` | string | Yes | Format: uuid |
| `name` | string,null | Yes | — |
| `source_type` | `"git_url"` \| `"zip_upload"` \| `"local_path"` | Yes | — |
| `url` | string | Yes | — |
| `default_branch` | string | Yes | — |
| `graph_name` | string,null | Yes | — |
| `last_indexed_at` | string,null | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |

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
  -X PATCH \
  "http://localhost:3000/api/v1/repositories/$REPO_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": null,
  "default_branch": "main"
}'
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": null,
  "source_type": "git_url",
  "url": "https://github.com/expressjs/express.git",
  "default_branch": "main",
  "graph_name": null,
  "last_indexed_at": null,
  "created_at": "string",
  "updated_at": "string"
}
```

---

## `DELETE /api/v1/repositories/{repoId}` {#delete-api-v1-repositories-repoid}

**Delete a repository and its AGE graph**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string | — |

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
  -X DELETE \
  "http://localhost:3000/api/v1/repositories/$REPO_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

---
