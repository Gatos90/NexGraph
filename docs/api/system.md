---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# System

## Endpoints

- [`GET /health`](#get-health) — Health check

---

## `GET /health` {#get-health}

**Health check**

::: tip No Authentication
This endpoint does not require an API key.
:::

### Response (200)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | Yes | — |
| `uptime` | number | Yes | — |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/health"
```

**Response:**

```json
{
  "status": "string",
  "uptime": 1
}
```

---
