---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# API Reference

> Headless Code Intelligence Engine — Build Knowledge Graphs, Let AI Agents Consume Them

## Base URL

```
http://localhost:3000/api/v1
```

## OpenAPI Spec

The live OpenAPI 3.1 specification is available at runtime:

```
GET /api/v1/openapi.json
```

You can import this into tools like Postman, Insomnia, or any OpenAPI-compatible client.

## Authentication

Most endpoints require a Bearer token (API key). See [Authentication](./authentication) for full details.

```http
Authorization: Bearer nxg_<your-key>
```

## Endpoints

| Section | Endpoints | Description |
|---------|-----------|-------------|
| [System](./system) | 1 | Health check and system info |
| [Projects](./projects) | 5 | Project CRUD — top-level organizational unit |
| [API Keys](./api-keys) | 3 | API key creation, listing, and revocation |
| [Repositories](./repositories) | 5 | Repository management and source configuration |
| [Indexing](./indexing) | 3 | Trigger, monitor, and cancel indexing jobs |
| [Graph](./graph) | 16 | Graph queries, node/edge browsing, Cypher, impact analysis, dependencies, architecture check, communities, processes, diff-impact |
| [Search](./search) | 3 | Multi-mode search (BM25 keyword, semantic, hybrid), regex grep, cross-repo search |
| [Files](./files) | 2 | File tree browsing and file content retrieval |
| [Export](./export) | 4 | Export graph data as JSON, CSV, Cypher, or full project bundle |
| [Connections](./connections) | 9 | Cross-repo connection rules and resolution |
| [Cross-Repo Graph](./cross-repo-graph) | 3 | Cross-repo tracing, impact analysis, statistics |

## Error Format

All error responses return JSON with a consistent shape:

```json
{
  "error": "Human-readable error message"
}
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| `400` | Invalid request body or parameters |
| `401` | Missing or invalid API key |
| `403` | Insufficient permissions or wrong project |
| `404` | Resource not found |
| `409` | Conflict (duplicate resource) |
| `500` | Internal server error |
