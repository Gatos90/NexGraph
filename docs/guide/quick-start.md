# Quick Start

This guide walks you through creating a project, indexing a repository, and querying the code graph — all with `curl`.

::: tip Prerequisites
Make sure you've completed the [Installation](/guide/installation) steps: database running, migrations applied, server started.
:::

## Step 1: Create a Project

A project is the top-level container that groups repositories and API keys.

```bash
curl -s -X POST http://localhost:3000/api/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "my-first-project", "description": "Testing NexGraph"}' \
  | jq .
```

**Response:**

```json
{
  "project": {
    "id": "a1b2c3d4-...",
    "name": "my-first-project",
    "description": "Testing NexGraph",
    "created_at": "2026-01-15T10:30:00.000Z",
    "updated_at": "2026-01-15T10:30:00.000Z"
  },
  "api_key": {
    "id": "e5f6g7h8-...",
    "key": "nxg_abc123...",
    "key_prefix": "nxg_abc1",
    "permissions": ["read", "write"],
    "expires_at": null,
    "created_at": "2026-01-15T10:30:00.000Z"
  }
}
```

::: warning Save your API key!
The full API key (`nxg_...`) is shown **only once**. Copy it now — you'll need it for all subsequent requests.
:::

Store it in a variable for convenience:

```bash
export NEXGRAPH_KEY="nxg_your_key_here"
export PROJECT_ID="your-project-id-here"
```

## Step 2: Add a Repository

Add a repository to your project. NexGraph supports three source types:

- `git_url` — Clone from a remote Git URL
- `local_path` — Index a directory already on the server's filesystem
- `zip_upload` — Extract from a ZIP archive

Here's how to add a public Git repository:

```bash
curl -s -X POST http://localhost:3000/api/v1/repositories \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "express-example",
    "url": "https://github.com/expressjs/express.git",
    "source_type": "git_url",
    "default_branch": "master"
  }' \
  | jq .
```

**Response:**

```json
{
  "id": "r1s2t3u4-...",
  "project_id": "a1b2c3d4-...",
  "name": "express-example",
  "source_type": "git_url",
  "url": "https://github.com/expressjs/express.git",
  "default_branch": "master",
  "graph_name": null,
  "last_indexed_at": null,
  "created_at": "2026-01-15T10:31:00.000Z",
  "updated_at": "2026-01-15T10:31:00.000Z"
}
```

Save the repository ID:

```bash
export REPO_ID="your-repo-id-here"
```

## Step 3: Trigger Indexing

Start the 8-phase indexing pipeline:

```bash
curl -s -X POST http://localhost:3000/api/v1/repositories/$REPO_ID/index \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

The pipeline runs these phases:

| Phase | Progress | What it does |
|-------|----------|-------------|
| Extract | 0–15% | Clones the repo / unpacks source files |
| Structure | 15–25% | Builds the directory tree in the graph |
| Parse | 25–55% | Extracts symbols (functions, classes, interfaces, structs, enums, etc.) via tree-sitter |
| Imports | 55–70% | Resolves import/export relationships between files |
| Call Graph | 70–85% | Builds function call edges with confidence scoring |
| Community | 85–92% | Detects functional clusters via Leiden algorithm |
| Process | 92–97% | Identifies execution flows via BFS from entry points |
| Embeddings | 97–100% | Generates vector embeddings for semantic search |

### Check Indexing Status

Poll the indexing status to track progress:

```bash
curl -s http://localhost:3000/api/v1/repositories/$REPO_ID/index/status \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

**Response (in progress):**

```json
{
  "status": "running",
  "phase": "parse",
  "progress": 45,
  "files_total": 120,
  "files_done": 54,
  "started_at": "2026-01-15T10:32:00.000Z",
  "completed_at": null,
  "error_message": null
}
```

Wait for `"status": "completed"` before querying.

## Step 4: Query the Graph

### Search for symbols

Find functions, classes, or interfaces by name:

```bash
curl -s "http://localhost:3000/api/v1/repositories/$REPO_ID/search?query=createServer&limit=5" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

### Search with grep (regex)

Search file contents using regular expressions:

```bash
curl -s "http://localhost:3000/api/v1/repositories/$REPO_ID/search/grep?query=app\.listen&limit=5" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

### Get graph statistics

See an overview of what was indexed:

```bash
curl -s http://localhost:3000/api/v1/repositories/$REPO_ID/graph/stats \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

### List detected routes

View HTTP route handlers found in the codebase:

```bash
curl -s http://localhost:3000/api/v1/repositories/$REPO_ID/graph/routes \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

### Run a Cypher query

Query the graph directly with Apache AGE Cypher:

```bash
curl -s -X POST http://localhost:3000/api/v1/repositories/$REPO_ID/graph/cypher \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "MATCH (f:Function) RETURN f.name, f.file_path LIMIT 10"
  }' \
  | jq .
```

### Trace dependencies

Find what a symbol depends on:

```bash
curl -s "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/dependencies?name=createServer&depth=2" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

### Analyze impact

Find what would be affected if a symbol changes:

```bash
curl -s "http://localhost:3000/api/v1/repositories/$REPO_ID/graph/impact?name=createServer&depth=2" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  | jq .
```

## Step 5: Connect an AI Agent (Optional)

NexGraph exposes an MCP server so AI agents can query the code graph directly.

### Stdio transport (for Cursor, Claude Code)

```bash
npm run mcp
```

Configure your AI editor to use NexGraph as an MCP tool server. See the [MCP Guide](/mcp/) for details.

### HTTP transport

The MCP HTTP endpoint is available at `http://localhost:3000/mcp` when the server is running. See [MCP HTTP Transport](/mcp/http) for integration details.

## Next Steps

- [API Reference](/api/) — Full endpoint documentation with request/response schemas
- [MCP Tools](/mcp/tools) — Available tools for AI agents
- [Tutorials](/tutorials/) — Multi-repo setup, advanced graph queries
- [Configuration](/configuration/) — Environment variables and project settings
