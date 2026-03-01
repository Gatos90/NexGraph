---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Connections

## Endpoints

- [`POST /api/v1/projects/{projectId}/connections`](#post-api-v1-projects-projectid-connections) — Create a cross-repo connection rule
- [`GET /api/v1/projects/{projectId}/connections`](#get-api-v1-projects-projectid-connections) — List cross-repo connection rules
- [`GET /api/v1/projects/{projectId}/connections/{connId}`](#get-api-v1-projects-projectid-connections-connid) — Get connection rule details with resolved edge count
- [`PATCH /api/v1/projects/{projectId}/connections/{connId}`](#patch-api-v1-projects-projectid-connections-connid) — Update a connection rule
- [`DELETE /api/v1/projects/{projectId}/connections/{connId}`](#delete-api-v1-projects-projectid-connections-connid) — Delete a connection rule and its resolved edges
- [`POST /api/v1/projects/{projectId}/connections/{connId}/resolve`](#post-api-v1-projects-projectid-connections-connid-resolve) — Trigger resolution for a connection (URL matching, type matching, etc.)
- [`GET /api/v1/projects/{projectId}/connections/{connId}/edges`](#get-api-v1-projects-projectid-connections-connid-edges) — List resolved cross-repo edges for a connection
- [`POST /api/v1/projects/{projectId}/connections/manual-edge`](#post-api-v1-projects-projectid-connections-manual-edge) — Create a manual cross-repo edge
- [`DELETE /api/v1/projects/{projectId}/connections/manual-edge/{id}`](#delete-api-v1-projects-projectid-connections-manual-edge-id) — Delete a manual cross-repo edge

---

## Match Rules Reference

The `match_rules` object controls how connections are resolved. Different connection types accept different fields:

### CROSS_REPO_CALLS (URL Path Matching)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strip_base_url` | boolean | `false` | Remove base URL from client calls before matching |
| `ignore_query_params` | boolean | `false` | Ignore query parameters when matching paths |
| `path_prefix` | string | — | Only match routes starting with this prefix (e.g., `/api/v2`) |

### CROSS_REPO_MIRRORS (Type Matching)

No additional fields. Uses exact name matching on exported Class, Interface, and type-alias symbols.

### CROSS_REPO_DEPENDS (Package Dependency Matching)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `package_name` | string | — | Override the package name to match against (otherwise read from manifest) |

### CROSS_REPO_IMPORTS (Direct Import Resolution)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path_mapping` | object | — | Map import paths to target repo paths (e.g., `{"@shared/": "src/"}`) |

---

## `POST /api/v1/projects/{projectId}/connections` {#post-api-v1-projects-projectid-connections}

**Create a cross-repo connection rule**

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
| `source_repo_id` | string | Yes | Format: uuid |
| `target_repo_id` | string | Yes | Format: uuid |
| `connection_type` | `"CROSS_REPO_CALLS"` \| `"CROSS_REPO_IMPORTS"` \| `"CROSS_REPO_DEPENDS"` \| `"CROSS_REPO_MIRRORS"` | Yes | — |
| `match_rules` | object | No | Default: `{}` |

### Response (201)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `project_id` | string | Yes | Format: uuid |
| `source_repo_id` | string | Yes | Format: uuid |
| `target_repo_id` | string | Yes | Format: uuid |
| `connection_type` | string | Yes | — |
| `match_rules` | object | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |
| `last_resolved_at` | string,null | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository not found |
| `409` | Connection rule already exists |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "connection_type": "CROSS_REPO_CALLS",
  "match_rules": {}
}'
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "connection_type": "string",
  "match_rules": {},
  "created_at": "string",
  "updated_at": "string",
  "last_resolved_at": null
}
```

---

## `GET /api/v1/projects/{projectId}/connections` {#get-api-v1-projects-projectid-connections}

**List cross-repo connection rules**

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
| `connections` | object[] | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "connections": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "project_id": "550e8400-e29b-41d4-a716-446655440000",
      "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "connection_type": "string",
      "match_rules": {},
      "created_at": "string",
      "updated_at": "string",
      "last_resolved_at": null
    }
  ]
}
```

---

## `GET /api/v1/projects/{projectId}/connections/{connId}` {#get-api-v1-projects-projectid-connections-connid}

**Get connection rule details with resolved edge count**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |
| `connId` | string | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `project_id` | string | Yes | Format: uuid |
| `source_repo_id` | string | Yes | Format: uuid |
| `target_repo_id` | string | Yes | Format: uuid |
| `connection_type` | string | Yes | — |
| `match_rules` | object | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |
| `last_resolved_at` | string,null | Yes | — |
| `edge_count` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Connection rule not found |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "connection_type": "string",
  "match_rules": {},
  "created_at": "string",
  "updated_at": "string",
  "last_resolved_at": null,
  "edge_count": 1
}
```

---

## `PATCH /api/v1/projects/{projectId}/connections/{connId}` {#patch-api-v1-projects-projectid-connections-connid}

**Update a connection rule**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |
| `connId` | string | — |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection_type` | `"CROSS_REPO_CALLS"` \| `"CROSS_REPO_IMPORTS"` \| `"CROSS_REPO_DEPENDS"` \| `"CROSS_REPO_MIRRORS"` | No | — |
| `match_rules` | object | No | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `project_id` | string | Yes | Format: uuid |
| `source_repo_id` | string | Yes | Format: uuid |
| `target_repo_id` | string | Yes | Format: uuid |
| `connection_type` | string | Yes | — |
| `match_rules` | object | Yes | — |
| `created_at` | string | Yes | — |
| `updated_at` | string | Yes | — |
| `last_resolved_at` | string,null | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Connection rule not found |

### Example

**Request:**

```bash
curl -s \
  -X PATCH \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "connection_type": "CROSS_REPO_CALLS",
  "match_rules": {}
}'
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "connection_type": "string",
  "match_rules": {},
  "created_at": "string",
  "updated_at": "string",
  "last_resolved_at": null
}
```

---

## `DELETE /api/v1/projects/{projectId}/connections/{connId}` {#delete-api-v1-projects-projectid-connections-connid}

**Delete a connection rule and its resolved edges**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |
| `connId` | string | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Connection rule not found |

### Example

**Request:**

```bash
curl -s \
  -X DELETE \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

---

## `POST /api/v1/projects/{projectId}/connections/{connId}/resolve` {#post-api-v1-projects-projectid-connections-connid-resolve}

**Trigger resolution for a connection (URL matching, type matching, etc.)**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |
| `connId` | string | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection_id` | string | Yes | Format: uuid |
| `edges_created` | number | Yes | — |
| `strategy` | string | Yes | — |
| `details` | object | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Connection rule not found |
| `422` | Resolution failed (repos not indexed) |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_ID/resolve" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "connection_id": "550e8400-e29b-41d4-a716-446655440000",
  "edges_created": 1,
  "strategy": "string",
  "details": {}
}
```

---

## `GET /api/v1/projects/{projectId}/connections/{connId}/edges` {#get-api-v1-projects-projectid-connections-connid-edges}

**List resolved cross-repo edges for a connection**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |
| `connId` | string | — |

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | integer | No | `50` | — |
| `offset` | integer,null | No | `0` | — |

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `edges` | object[] | Yes | — |
| `total` | number | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Connection rule not found |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/$CONN_ID/edges?limit=50&offset=0" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "edges": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "project_id": "550e8400-e29b-41d4-a716-446655440000",
      "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
      "source_node": "UserService.getUser",
      "target_node": "UserAPI.fetchUser",
      "edge_type": "CROSS_REPO_CALLS",
      "metadata": null,
      "created_at": "string"
    }
  ],
  "total": 1
}
```

---

## `POST /api/v1/projects/{projectId}/connections/manual-edge` {#post-api-v1-projects-projectid-connections-manual-edge}

**Create a manual cross-repo edge**

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
| `source_repo_id` | string | Yes | Format: uuid |
| `target_repo_id` | string | Yes | Format: uuid |
| `source_node` | string | Yes | Min length: 1. Max length: 500 |
| `target_node` | string | Yes | Min length: 1. Max length: 500 |
| `edge_type` | string | Yes | Min length: 1. Max length: 100 |
| `metadata` | object,null | No | Default: `null` |

### Response (201)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `project_id` | string | Yes | Format: uuid |
| `source_repo_id` | string | Yes | Format: uuid |
| `target_repo_id` | string | Yes | Format: uuid |
| `source_node` | string | Yes | — |
| `target_node` | string | Yes | — |
| `edge_type` | string | Yes | — |
| `metadata` | object,null | Yes | — |
| `created_at` | string | Yes | — |
| `manual` | boolean | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Repository not found in project |

### Example

**Request:**

```bash
curl -s \
  -X POST \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/manual-edge" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_node": "UserService.getUser",
  "target_node": "UserAPI.fetchUser",
  "edge_type": "CROSS_REPO_CALLS",
  "metadata": null
}'
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_repo_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_node": "UserService.getUser",
  "target_node": "UserAPI.fetchUser",
  "edge_type": "CROSS_REPO_CALLS",
  "metadata": null,
  "created_at": "string",
  "manual": true
}
```

---

## `DELETE /api/v1/projects/{projectId}/connections/manual-edge/{id}` {#delete-api-v1-projects-projectid-connections-manual-edge-id}

**Delete a manual cross-repo edge**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |
| `id` | string | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Manual edge not found |

### Example

**Request:**

```bash
curl -s \
  -X DELETE \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/connections/manual-edge/<id>" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

---
