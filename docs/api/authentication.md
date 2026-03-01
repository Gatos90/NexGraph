---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Authentication

NexGraph uses project-scoped API keys for authentication. Every API key belongs to exactly one project and can only access resources within that project.

## How It Works

1. **Create a project** — the `POST /api/v1/projects` endpoint is the only unauthenticated endpoint. It returns a project and an initial API key.
2. **Use the API key** — include the key as a Bearer token in the `Authorization` header for all subsequent requests.
3. **Project isolation** — the middleware extracts the project ID from the key and ensures you can only access your own project's resources.

## Key Format

API keys follow the format:

```
nxg_<64 hex characters>
```

The full key is returned **only once** at creation time. NexGraph stores a SHA-256 hash internally — there is no way to retrieve the full key later.

## Using the Key

Include the key in every request's `Authorization` header:

```http
Authorization: Bearer nxg_a1b2c3d4e5f6...
```

**Example with curl:**

```bash
# Store the key in an environment variable
export NEXGRAPH_KEY="nxg_your_key_here"

# Use it in requests
curl -s http://localhost:3000/api/v1/repositories \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

## Permissions

Each API key has a set of permissions that control what it can do:

| Permission | Allows |
|-----------|--------|
| `read` | List/get projects, repositories, indexing status, graph queries, search, file browsing |
| `write` | Create/update/delete projects, repositories, API keys; trigger indexing; manage connections |

When creating a key, specify the permissions array:

```bash
curl -s -X POST http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "permissions": ["read"],
    "label": "ci-read-only"
  }' \
  | jq .
```

**Response:**

```json
{
  "id": "e5f6a7b8-...",
  "key": "nxg_abc123def456...",
  "key_prefix": "nxg_abc1",
  "label": "ci-read-only",
  "permissions": ["read"],
  "expires_at": null,
  "created_at": "2026-01-15T10:30:00.000Z"
}
```

::: warning
The `key` field is only included in the creation response. Save it immediately — you cannot retrieve it later.
:::

## Key Expiry

Keys can optionally have an `expires_at` timestamp (ISO 8601). Expired keys are automatically rejected by the auth middleware.

```bash
curl -s -X POST http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "permissions": ["read", "write"],
    "label": "temp-key",
    "expires_at": "2026-06-01T00:00:00.000Z"
  }' \
  | jq .
```

## Revoking Keys

Revoke a key by deleting it. Revocation is a soft-delete — the record is retained for audit purposes.

```bash
curl -s -X DELETE http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys/$KEY_ID \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

## Error Responses

| Status | Cause |
|--------|-------|
| `401 Unauthorized` | Missing `Authorization` header, invalid key format, unknown key, or expired key |
| `403 Forbidden` | Key doesn't have the required permission, or trying to access a different project's resources |

**Example 401 response:**

```json
{
  "error": "Invalid or expired API key"
}
```

**Example 403 response:**

```json
{
  "error": "Insufficient permissions: requires write"
}
```

## Security Best Practices

- **Rotate keys regularly** — create new keys and revoke old ones
- **Use least privilege** — give CI/CD keys `read` only unless they need to trigger indexing
- **Set expiry dates** — for temporary access, always set `expires_at`
- **Never commit keys** — use environment variables or secret managers
- **One key per consumer** — makes revocation targeted and auditable
