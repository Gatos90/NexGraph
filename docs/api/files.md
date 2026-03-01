---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Files

## Endpoints

- [`GET /api/v1/repositories/{repoId}/files`](#get-api-v1-repositories-repoid-files) — Browse the file tree of a repository

- [`GET /api/v1/repositories/{repoId}/files/{filePath}`](#get-api-v1-repositories-repoid-files-filepath) — Get file content and associated graph symbols

---

## `GET /api/v1/repositories/{repoId}/files` {#get-api-v1-repositories-repoid-files}

**Browse the file tree of a repository**

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
| `path` | string | No | — | — |
| `language` | string | No | — | — |
| `flat` | `"true"` \| `"false"` | No | `"false"` | — |

### Response (200)

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
  "http://localhost:3000/api/v1/repositories/$REPO_ID/files?path=value&language=value" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "files": [
    {
      "path": "string",
      "name": "my-project",
      "language": null,
      "type": "file"
    }
  ],
  "total": 1
}
```

---

## `GET /api/v1/repositories/{repoId}/files/{filePath}` {#get-api-v1-repositories-repoid-files-filepath}

**Get file content and associated graph symbols**

This endpoint uses a wildcard path parameter and is not part of the OpenAPI spec. It retrieves the raw source code of a file along with all symbols (functions, classes, etc.) defined in it.

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repoId` | string (UUID) | Repository ID |
| `filePath` | string | Full file path within the repository (e.g., `src/index.ts`) |

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | File path |
| `language` | string \| null | Detected language |
| `content` | string | Raw file content |
| `line_count` | number | Number of lines |
| `symbols` | array | Graph symbols defined in this file |
| `symbols[].id` | number \| string | Graph node ID |
| `symbols[].label` | string | Node label (Function, Class, Interface, etc.) |
| `symbols[].properties` | object | Node properties (name, signature, exported, etc.) |

### Error Responses

| Status | Description |
|--------|-------------|
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | File or repository not found |

### Example

**Request:**

```bash
curl -s \
  "http://localhost:3000/api/v1/repositories/$REPO_ID/files/src/index.ts" \
  -H "Authorization: Bearer $NEXGRAPH_KEY"
```

**Response:**

```json
{
  "path": "src/index.ts",
  "language": "typescript",
  "content": "import { serve } from \"@hono/node-server\";\n...",
  "line_count": 42,
  "symbols": [
    {
      "id": 12345,
      "label": "Function",
      "properties": {
        "name": "startServer",
        "signature": "function startServer(): void",
        "exported": true,
        "async": true,
        "file_path": "src/index.ts",
        "start_line": 10,
        "end_line": 25
      }
    }
  ]
}
```

---
