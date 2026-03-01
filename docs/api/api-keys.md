---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# API Keys

## Endpoints

- [`POST /api/v1/projects/{projectId}/api-keys`](#post-api-v1-projects-projectid-api-keys) — Generate a new API key for a project
- [`GET /api/v1/projects/{projectId}/api-keys`](#get-api-v1-projects-projectid-api-keys) — List API keys for a project (prefix only, never full key)
- [`DELETE /api/v1/projects/{projectId}/api-keys/{keyId}`](#delete-api-v1-projects-projectid-api-keys-keyid) — Revoke an API key

---

## `POST /api/v1/projects/{projectId}/api-keys` {#post-api-v1-projects-projectid-api-keys}

**Generate a new API key for a project**

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
| `label` | string | No | — |
| `permissions` | `"read"` \| `"write"`[] | No | Default: `["read","write"]` |
| `expires_at` | string | No | ISO 8601 expiry date. Format: date-time |

### Response (201)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Format: uuid |
| `key` | string | Yes | Full API key — shown only once |
| `key_prefix` | string | Yes | — |
| `label` | string,null | Yes | — |
| `permissions` | `"read"` \| `"write"`[] | Yes | — |
| `expires_at` | string,null | Yes | — |
| `created_at` | string | Yes | — |

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
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "label": "ci-read-only",
  "permissions": [
    "read"
  ],
  "expires_at": "2026-01-15T10:30:00.000Z"
}'
```

**Response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "key": "string",
  "key_prefix": "string",
  "label": null,
  "permissions": [
    "read"
  ],
  "expires_at": null,
  "created_at": "string"
}
```

---

## `GET /api/v1/projects/{projectId}/api-keys` {#get-api-v1-projects-projectid-api-keys}

**List API keys for a project (prefix only, never full key)**

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
| `api_keys` | object[] | Yes | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "api_keys": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "key_prefix": "string",
      "label": null,
      "permissions": [
        "read"
      ],
      "revoked": true,
      "expires_at": null,
      "created_at": "string"
    }
  ]
}
```

---

## `DELETE /api/v1/projects/{projectId}/api-keys/{keyId}` {#delete-api-v1-projects-projectid-api-keys-keyid}

**Revoke an API key**

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | — |
| `keyId` | string | — |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | API key not found |

### Example

**Request:**

```bash
curl -s \
  -X DELETE \
  "http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys/$KEY_ID" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

---
