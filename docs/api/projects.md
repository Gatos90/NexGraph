---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Projects

## Endpoints

- [`POST /api/v1/projects`](#post-api-v1-projects) — Create a new project with an initial API key
- [`GET /api/v1/projects`](#get-api-v1-projects) — List projects accessible to the authenticated API key
- [`GET /api/v1/projects/{projectId}`](#get-api-v1-projects-projectid) — Get project details
- [`PATCH /api/v1/projects/{projectId}`](#patch-api-v1-projects-projectid) — Update a project
- [`DELETE /api/v1/projects/{projectId}`](#delete-api-v1-projects-projectid) — Delete a project and all associated data

---

## `POST /api/v1/projects` {#post-api-v1-projects}

**Create a new project with an initial API key**

::: tip No Authentication
This endpoint does not require an API key.
:::

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Min length: 1. Max length: 255 |
| `description` | string | No | Max length: 1000 |

### Response (201)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | object | Yes | — |
| `api_key` | object | Yes | — |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/projects" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "my-project",
  "description": "A code intelligence project"
}'
```

**Response:**

```json
{
  "project": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "my-project",
    "description": null,
    "created_at": "string",
    "updated_at": "string"
  },
  "api_key": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "key": "string",
    "key_prefix": "string",
    "permissions": [
      "read"
    ],
    "expires_at": null,
    "created_at": "string"
  }
}
```

---

## `GET /api/v1/projects` {#get-api-v1-projects}

**List projects accessible to the authenticated API key**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projects` | object[] | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/projects" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "projects": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "my-project",
      "description": null,
      "created_at": "string",
      "updated_at": "string"
    }
  ]
}
```

---

## `GET /api/v1/projects/{projectId}` {#get-api-v1-projects-projectid}

**Get project details**

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
| `id` | string | Yes | Format: uuid |
| `name` | string | Yes | — |
| `description` | string,null | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Project not found |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "my-project",
  "description": null,
  "created_at": "string",
  "updated_at": "string"
}
```

---

## `PATCH /api/v1/projects/{projectId}` {#patch-api-v1-projects-projectid}

**Update a project**

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
| `name` | string | No | Min length: 1. Max length: 255 |
| `description` | string,null | No | Max length: 1000 |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `name` | string | Yes | — |
| `description` | string,null | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Project not found |

### Example

**Request:**

```bash
curl -s \
  -X PATCH \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "my-project",
  "description": null
}'
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "my-project",
  "description": null,
  "created_at": "string",
  "updated_at": "string"
}
```

---

## `DELETE /api/v1/projects/{projectId}` {#delete-api-v1-projects-projectid}

**Delete a project and all associated data**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Project not found |

### Example

**Request:**

```bash
curl -s \
  -X DELETE \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

---
