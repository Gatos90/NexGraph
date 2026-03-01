# MCP Tools Reference

NexGraph exposes 24 tools to MCP clients. All tools return JSON in `content[0].text`.

## Multi-Repo Behavior

When a project has a single indexed repository, the `repo` parameter is optional on all tools. When multiple repos exist:
- **Aggregation tools** (`query`, `search`, `grep`, `read_file`, `routes`, `graph_stats`) search all repos automatically when `repo` is omitted
- **Specific-repo tools** (`cypher`, `dependencies`, `impact`, `architecture_check`, `rename`, `detect_changes`, `communities`, `processes`, `orphans`, `edges`, `path`, `nodes`, `file_tree`, `git_history`, `git_timeline`) require the `repo` parameter and return an error listing available repos if omitted
- **Cross-repo tools** (`trace`, `cross_repo_connections`) work across repo boundaries

---

## query

Search symbols by keyword using substring matching against symbol names.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | yes | — | Keyword to search for in symbol names |
| `repo` | string | no | — | Repository name |
| `label` | string | no | — | Filter by node label (`File`, `Folder`, `Function`, `Class`, `Interface`, `Method`, `CodeElement`, `RouteHandler`, `Struct`, `Enum`, `Trait`, `TypeAlias`, `Namespace`, `Community`, `Process`) |
| `limit` | integer | no | `20` | Max results (1–100) |

**Example call:**

```json
{
  "name": "query",
  "arguments": {
    "query": "handleRequest",
    "label": "Function",
    "limit": 5
  }
}
```

**Example response:**

```json
{
  "symbols": [
    {
      "name": "handleRequest",
      "label": "Function",
      "file_path": "src/server.ts",
      "exported": true,
      "line": 42,
      "repo": "my-api",
      "properties": {
        "name": "handleRequest",
        "file_path": "src/server.ts",
        "exported": true,
        "line": 42,
        "is_async": true
      }
    },
    {
      "name": "handleRequestError",
      "label": "Function",
      "file_path": "src/errors.ts",
      "exported": true,
      "line": 15,
      "repo": "my-api",
      "properties": {
        "name": "handleRequestError",
        "file_path": "src/errors.ts",
        "exported": true,
        "line": 15,
        "is_async": false
      }
    }
  ],
  "count": 2,
  "repo": "my-api"
}
```

---

## context

Get 360-degree context for a symbol — callers, callees, imports, exports, inheritance, and cross-repo links.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `symbol` | string | yes | The symbol name to get context for |
| `repo` | string | no | Repository name |

**Example call:**

```json
{
  "name": "context",
  "arguments": {
    "symbol": "UserService"
  }
}
```

**Example response:**

```json
{
  "symbol": {
    "name": "UserService",
    "label": "Class",
    "file_path": "src/services/user.ts",
    "exported": true,
    "line": 10,
    "repo": "my-api"
  },
  "callers": [
    { "name": "createUser", "label": "Function", "file_path": "src/routes/users.ts" }
  ],
  "callees": [
    { "name": "hashPassword", "label": "Function", "file_path": "src/utils/crypto.ts" }
  ],
  "imports": [
    { "name": "Database", "label": "Class", "file_path": "src/db/connection.ts" }
  ],
  "imported_by": [
    { "name": "AuthController", "label": "Class", "file_path": "src/controllers/auth.ts" }
  ],
  "extends": [],
  "extended_by": [
    { "name": "AdminUserService", "label": "Class", "file_path": "src/services/admin.ts" }
  ],
  "implements": [],
  "implemented_by": [],
  "other_outgoing": [],
  "other_incoming": [
    { "type": "DEFINES", "source": { "name": "src/services/user.ts", "label": "File" } }
  ],
  "cross_repo_links": [],
  "summary": {
    "total_callers": 1,
    "total_callees": 1,
    "total_imports": 1,
    "total_imported_by": 1,
    "total_cross_repo": 0
  }
}
```

---

## impact

Analyze the blast radius of changing a symbol. Traverses `CALLS`, `EXTENDS`, and `IMPLEMENTS` edges using BFS.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `symbol` | string | yes | — | Symbol name to analyze |
| `direction` | `"callers"` \| `"callees"` \| `"both"` | no | `"both"` | Traversal direction |
| `depth` | integer | no | `3` | Max traversal depth (1–10) |
| `repo` | string | no | — | Repository name (required with multiple repos) |
| `include_cross_repo` | boolean | no | `false` | Follow cross-repo edges |

**Example call:**

```json
{
  "name": "impact",
  "arguments": {
    "symbol": "authenticate",
    "direction": "callers",
    "depth": 2
  }
}
```

**Example response:**

```json
{
  "root": {
    "name": "authenticate",
    "label": "Function",
    "file_path": "src/middleware/auth.ts",
    "repo": "my-api"
  },
  "affected": [
    {
      "name": "protectedRoute",
      "label": "Function",
      "file_path": "src/routes/protected.ts",
      "repo": "my-api",
      "is_cross_repo": false,
      "relationship_type": "CALLS"
    },
    {
      "name": "AdminGuard",
      "label": "Class",
      "file_path": "src/guards/admin.ts",
      "repo": "my-api",
      "is_cross_repo": false,
      "relationship_type": "CALLS"
    }
  ],
  "summary": {
    "total_affected": 2,
    "local_affected": 2,
    "cross_repo_affected": 0,
    "by_relationship_type": { "CALLS": 2 },
    "by_repo": { "my-api": 2 }
  }
}
```

---

## trace

Trace end-to-end call flows within and across repositories using BFS traversal.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `start_symbol` | string | yes | — | Starting symbol name |
| `start_repo` | string | no | — | Repo containing the starting symbol |
| `direction` | `"forward"` \| `"backward"` \| `"both"` | no | `"forward"` | Trace direction |
| `max_depth` | integer | no | `3` | Max depth (1–10) |
| `include_cross_repo` | boolean | no | `true` | Follow cross-repo edges |

**Example call:**

```json
{
  "name": "trace",
  "arguments": {
    "start_symbol": "handleLogin",
    "direction": "forward",
    "max_depth": 3
  }
}
```

**Example response:**

```json
{
  "start": {
    "repo": "my-api",
    "symbol_name": "handleLogin",
    "label": "Function",
    "file_path": "src/routes/auth.ts"
  },
  "nodes": [
    { "repo": "my-api", "symbol_name": "handleLogin", "label": "Function", "file_path": "src/routes/auth.ts" },
    { "repo": "my-api", "symbol_name": "validateCredentials", "label": "Function", "file_path": "src/services/auth.ts" },
    { "repo": "my-api", "symbol_name": "generateToken", "label": "Function", "file_path": "src/utils/jwt.ts" }
  ],
  "edges": [
    {
      "from_repo": "my-api", "from_symbol": "handleLogin",
      "to_repo": "my-api", "to_symbol": "validateCredentials",
      "edge_type": "CALLS", "cross_repo": false
    },
    {
      "from_repo": "my-api", "from_symbol": "validateCredentials",
      "to_repo": "my-api", "to_symbol": "generateToken",
      "edge_type": "CALLS", "cross_repo": false
    }
  ],
  "depth_reached": 2,
  "repos_traversed": ["my-api"],
  "summary": {
    "total_nodes": 3,
    "total_edges": 2,
    "total_repos": 1,
    "cross_repo_edges": 0
  }
}
```

---

## cypher

Execute a raw Cypher query against a repository's Apache AGE graph.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | yes | — | Cypher query (1–10000 chars, must not contain `$$`) |
| `repo` | string | no | — | Repository name (required with multiple repos) |
| `params` | object | no | — | Parameter map, referenced as `$key` in Cypher |
| `columns` | array | no | `[{"name":"result"}]` | Column definitions (1–50 items) |

**Example call:**

```json
{
  "name": "cypher",
  "arguments": {
    "query": "MATCH (f:Function) WHERE f.exported = true RETURN f.name, f.file_path LIMIT 5",
    "columns": [{ "name": "f.name" }, { "name": "f.file_path" }]
  }
}
```

**Example response:**

```json
{
  "rows": [
    { "f.name": "createApp", "f.file_path": "src/app.ts" },
    { "f.name": "handleRequest", "f.file_path": "src/server.ts" }
  ],
  "columns": ["f.name", "f.file_path"],
  "row_count": 2,
  "repo": "my-api"
}
```

---

## routes

List HTTP route handlers detected in the codebase from `RouteHandler` graph nodes.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repo` | string | no | Repository name |
| `method` | string | no | Filter by HTTP method (`GET`, `POST`, `PUT`, `DELETE`) |
| `url_pattern` | string | no | Filter by URL pattern substring |

**Example call:**

```json
{
  "name": "routes",
  "arguments": {
    "method": "GET",
    "url_pattern": "/api/users"
  }
}
```

**Example response:**

```json
{
  "routes": [
    {
      "http_method": "GET",
      "url_pattern": "/api/users",
      "framework": "express",
      "handler_name": "listUsers",
      "start_line": 24,
      "file_path": "src/routes/users.ts",
      "repo": "my-api"
    },
    {
      "http_method": "GET",
      "url_pattern": "/api/users/:id",
      "framework": "express",
      "handler_name": "getUser",
      "start_line": 45,
      "file_path": "src/routes/users.ts",
      "repo": "my-api"
    }
  ],
  "count": 2,
  "repo": "my-api"
}
```

---

## dependencies

Get the file dependency tree for a given file. Traverses `IMPORTS` edges via the graph path `File → DEFINES → Symbol → IMPORTS → Symbol ← DEFINES ← File`.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `file_path` | string | yes | — | File path relative to repository root |
| `repo` | string | no | — | Repository name (required with multiple repos) |
| `depth` | integer | no | `1` | Max traversal depth (1–10) |
| `direction` | `"imports"` \| `"imported_by"` \| `"both"` | no | `"imports"` | Direction |

**Example call:**

```json
{
  "name": "dependencies",
  "arguments": {
    "file_path": "src/routes/users.ts",
    "depth": 2,
    "direction": "imports"
  }
}
```

**Example response:**

```json
{
  "file": "src/routes/users.ts",
  "dependencies": [
    { "file_path": "src/services/user.ts", "depth": 1, "direction": "imports" },
    { "file_path": "src/middleware/auth.ts", "depth": 1, "direction": "imports" },
    { "file_path": "src/db/connection.ts", "depth": 2, "direction": "imports" },
    { "file_path": "src/utils/crypto.ts", "depth": 2, "direction": "imports" }
  ],
  "count": 4,
  "max_depth": 2,
  "repo": "my-api"
}
```

---

## search

Multi-mode search across repository contents. Supports keyword (BM25 via tsvector), semantic (vector cosine similarity via pgvector), and hybrid (Reciprocal Rank Fusion of both) modes.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | yes | — | Keywords to search for (1–1000 chars) |
| `repo` | string | no | — | Repository name |
| `limit` | integer | no | `20` | Max results (1–100) |
| `mode` | `"keyword"` \| `"semantic"` \| `"hybrid"` | no | `"keyword"` | Search mode: `keyword` (BM25 tsvector), `semantic` (vector cosine similarity), or `hybrid` (RRF fusion of both) |

**Response fields vary by mode:**

- **keyword**: `file_path`, `rank`, `highlights`, `language`, `repo`
- **semantic**: `symbol_name`, `file_path`, `label`, `similarity`, `repo`
- **hybrid**: `file_path`, `rrf_rank`, `rrf_score`, `keyword_rank`, `semantic_rank`, `repo`

**Example call:**

```json
{
  "name": "search",
  "arguments": {
    "query": "authentication token validation",
    "limit": 3
  }
}
```

**Example response:**

```json
{
  "results": [
    {
      "file_path": "src/middleware/auth.ts",
      "rank": 0.0759,
      "highlights": "...validates the **authentication** **token** before...",
      "language": "typescript",
      "repo": "my-api"
    },
    {
      "file_path": "src/utils/jwt.ts",
      "rank": 0.0612,
      "highlights": "...**token** **validation** logic for JWT...",
      "language": "typescript",
      "repo": "my-api"
    }
  ],
  "total": 8,
  "repo": "my-api"
}
```

---

## grep

Regex search across file contents stored in the database. Returns matching lines with context.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `pattern` | string | yes | — | Regular expression pattern (1–1000 chars) |
| `file_glob` | string | no | — | File glob filter (`*.ts`, `src/**/*.js`) |
| `repo` | string | no | — | Repository name |
| `case_sensitive` | boolean | no | `true` | Case-sensitive matching |
| `context_lines` | integer | no | `2` | Context lines before/after (0–10) |
| `limit` | integer | no | `100` | Max match results (1–500) |

**Example call:**

```json
{
  "name": "grep",
  "arguments": {
    "pattern": "TODO|FIXME|HACK",
    "file_glob": "*.ts",
    "case_sensitive": false,
    "context_lines": 1,
    "limit": 10
  }
}
```

**Example response:**

```json
{
  "matches": [
    {
      "file_path": "src/services/user.ts",
      "line_number": 87,
      "line": "    // TODO: add rate limiting",
      "context_before": ["    const user = await db.findUser(id);"],
      "context_after": ["    return user;"],
      "repo": "my-api"
    },
    {
      "file_path": "src/utils/cache.ts",
      "line_number": 12,
      "line": "  // FIXME: cache invalidation is broken for nested keys",
      "context_before": ["export function invalidateCache(key: string) {"],
      "context_after": ["  delete cache[key];"],
      "repo": "my-api"
    }
  ],
  "total_matches": 2,
  "files_searched": 45,
  "files_matched": 2,
  "repo": "my-api"
}
```

---

## read_file

Read source code from a file in the repository index. Returns content, language, line count, and symbols defined in the file.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | File path relative to repository root |
| `repo` | string | no | Repository name |
| `start_line` | integer | no | Start line (1-based, inclusive) |
| `end_line` | integer | no | End line (1-based, inclusive) |

**Example call:**

```json
{
  "name": "read_file",
  "arguments": {
    "path": "src/config.ts",
    "start_line": 1,
    "end_line": 20
  }
}
```

**Example response:**

```json
{
  "path": "src/config.ts",
  "language": "typescript",
  "content": "import { z } from \"zod\";\nimport dotenv from \"dotenv\";\n\ndotenv.config();\n\nconst envSchema = z.object({\n  PORT: z.coerce.number().default(3000),\n  HOST: z.string().default(\"0.0.0.0\"),\n  DATABASE_URL: z.string(),\n  LOG_LEVEL: z.enum([\"fatal\",\"error\",\"warn\",\"info\",\"debug\",\"trace\"]).default(\"info\"),\n});\n\nconst parsed = envSchema.safeParse(process.env);\nif (!parsed.success) {\n  console.error(parsed.error.format());\n  process.exit(1);\n}\n\nexport const config = parsed.data;\nexport type Config = typeof config;",
  "total_lines": 20,
  "range": { "start": 1, "end": 20 },
  "symbols": [
    { "name": "config", "label": "CodeElement", "line": 19, "exported": true },
    { "name": "Config", "label": "Interface", "line": 20, "exported": true }
  ],
  "repo": "my-api"
}
```

---

## graph_stats

Get graph statistics including node/edge counts, detected languages, and indexing status.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repo` | string | no | Repository name (omit for all repos) |

**Example call:**

```json
{
  "name": "graph_stats",
  "arguments": {}
}
```

**Example response (single repo):**

```json
{
  "repo": "my-api",
  "has_graph": true,
  "nodes": {
    "File": 85,
    "Function": 230,
    "Class": 18,
    "Interface": 12,
    "Method": 95,
    "CodeElement": 45,
    "RouteHandler": 14
  },
  "edges": {
    "DEFINES": 414,
    "CONTAINS": 85,
    "CALLS": 520,
    "IMPORTS": 180,
    "EXTENDS": 8,
    "IMPLEMENTS": 5,
    "EXPOSES": 14
  },
  "total_nodes": 499,
  "total_edges": 1226,
  "total_files": 85,
  "languages": {
    "typescript": 78,
    "javascript": 7
  },
  "indexing": {
    "status": "completed",
    "phase": null,
    "progress": 100,
    "last_completed_phase": "graph",
    "mode": "full",
    "created_at": "2026-02-27T00:00:00.000Z",
    "updated_at": "2026-02-27T00:05:23.000Z"
  }
}
```

**Example response (multi-repo):**

```json
{
  "repos": [
    { "repo": "frontend", "has_graph": true, "nodes": { "File": 120 }, "..." : "..." },
    { "repo": "backend", "has_graph": true, "nodes": { "File": 85 }, "..." : "..." }
  ],
  "aggregate": {
    "total_repos": 2,
    "total_nodes": 980,
    "total_edges": 2400,
    "total_files": 205
  }
}
```

---

## cross_repo_connections

List cross-repo connection rules and their resolved edge counts for a project.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repo` | string | no | Any repository name in the project |

**Example call:**

```json
{
  "name": "cross_repo_connections",
  "arguments": {}
}
```

**Example response:**

```json
{
  "project_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "connections": [
    {
      "id": "conn-uuid-1",
      "source_repo": "frontend",
      "target_repo": "backend",
      "connection_type": "api_call",
      "match_rules": {
        "source_pattern": "fetch\\('/api",
        "target_pattern": "router\\.(get|post|put|delete)"
      },
      "edge_count": 42,
      "created_at": "2026-02-26T10:00:00.000Z"
    }
  ],
  "summary": {
    "total_connections": 1,
    "total_resolved_edges": 42,
    "repos_in_project": 2
  }
}
```

---

## architecture_check

Check for architectural layer violations by defining layers (file path globs) and deny rules, then querying the graph for `CALLS` and `IMPORTS` edges that cross forbidden boundaries.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | no | — | Repository name (required with multiple repos) |
| `layers` | object | yes | — | Map of layer name to file glob pattern |
| `rules` | object[] | yes | — | Array of deny rules (`{ from, deny[] }`) |
| `edge_types` | string[] | no | `["IMPORTS", "CALLS"]` | Edge types to check |

**Example call:**

```json
{
  "name": "architecture_check",
  "arguments": {
    "layers": {
      "controllers": "src/controllers/**",
      "services": "src/services/**",
      "domain": "src/domain/**",
      "infrastructure": "src/infrastructure/**"
    },
    "rules": [
      { "from": "domain", "deny": ["infrastructure", "controllers"] },
      { "from": "controllers", "deny": ["infrastructure"] }
    ]
  }
}
```

**Example response:**

```json
{
  "violations": [
    {
      "rule": "domain → infrastructure (denied)",
      "source_file": "src/domain/User.ts",
      "source_symbol": "UserService",
      "target_file": "src/infrastructure/db.ts",
      "target_symbol": "query",
      "edge_type": "CALLS",
      "line": 15
    }
  ],
  "summary": {
    "total_violations": 1,
    "rules_checked": 2,
    "layers_found": 4,
    "files_classified": {
      "controllers": 5,
      "services": 3,
      "domain": 4,
      "infrastructure": 2
    }
  }
}
```

---

## communities

List detected communities (functional clusters) in the code graph. Communities group related symbols detected via CALLS edges using the Leiden algorithm.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | no | — | Repository name |
| `community_id` | string | no | — | Specific community ID to fetch (returns full member list). Omit to list all. |
| `include_members` | boolean | no | `false` | Include member symbols in the response |
| `limit` | integer | no | `20` | Max communities to return (1–100) |

**Example call:**

```json
{
  "name": "communities",
  "arguments": {
    "include_members": true,
    "limit": 5
  }
}
```

**Example response:**

```json
{
  "repo": "my-api",
  "communities": [
    {
      "community_id": "c_0",
      "label": "Authentication",
      "heuristic_label": "auth",
      "cohesion": 0.85,
      "symbol_count": 12,
      "keywords": "authenticate,validateToken,hashPassword",
      "members": [
        { "name": "authenticate", "label": "Function", "file_path": "src/middleware/auth.ts" },
        { "name": "validateToken", "label": "Function", "file_path": "src/utils/jwt.ts" }
      ]
    }
  ],
  "count": 1
}
```

---

## processes

List detected execution flow processes (traces from entry points through CALLS edges). Returns process metadata including type, step count, entry/terminal names.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | no | — | Repository name |
| `process_id` | string | no | — | Specific process ID to fetch (returns full step sequence). Omit to list all. |
| `process_type` | `"intra_community"` \| `"cross_community"` | no | — | Filter by process type |
| `include_steps` | boolean | no | `false` | Include ordered symbol sequence in results |
| `limit` | integer | no | `20` | Max processes to return (1–100) |

**Example call:**

```json
{
  "name": "processes",
  "arguments": {
    "process_type": "cross_community",
    "include_steps": true,
    "limit": 3
  }
}
```

**Example response:**

```json
{
  "repo": "my-api",
  "processes": [
    {
      "process_id": "p_0",
      "label": "Login Flow",
      "heuristic_label": "handleLogin → generateToken",
      "process_type": "cross_community",
      "step_count": 4,
      "entry_point_name": "handleLogin",
      "terminal_name": "generateToken",
      "steps": [
        { "step": 0, "name": "handleLogin", "label": "Function", "file_path": "src/routes/auth.ts" },
        { "step": 1, "name": "validateCredentials", "label": "Function", "file_path": "src/services/auth.ts" },
        { "step": 2, "name": "findUser", "label": "Function", "file_path": "src/db/users.ts" },
        { "step": 3, "name": "generateToken", "label": "Function", "file_path": "src/utils/jwt.ts" }
      ]
    }
  ],
  "count": 1
}
```

---

## rename

Graph-aware multi-file symbol rename with confidence scoring per edit and dry-run preview mode. Finds all references via graph edges: definitions, call sites, imports, type references, and overrides.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `symbol` | string | yes | — | The symbol name to rename |
| `new_name` | string | yes | — | The new name for the symbol |
| `repo` | string | no | — | Repository name (required with multiple repos) |
| `file_path` | string | no | — | Filter to a specific file to disambiguate |
| `label` | string | no | — | Filter by node label (e.g., `Function`, `Class`) to disambiguate |
| `dry_run` | boolean | no | `true` | If true, returns edits without modifying files. Set to false to apply. |
| `min_confidence` | number | no | `0.8` | Minimum confidence threshold (0–1). Edits below this are skipped. |

**Example call:**

```json
{
  "name": "rename",
  "arguments": {
    "symbol": "handleRequest",
    "new_name": "processRequest",
    "dry_run": true
  }
}
```

**Example response:**

```json
{
  "repo": "my-api",
  "dry_run": true,
  "symbol": "handleRequest",
  "new_name": "processRequest",
  "edits": [
    {
      "file_path": "src/server.ts",
      "line": 42,
      "type": "definition",
      "confidence": 1.0
    },
    {
      "file_path": "src/routes/index.ts",
      "line": 15,
      "type": "call_site",
      "confidence": 0.95
    }
  ],
  "total_edits": 2,
  "skipped": 0
}
```

---

## detect_changes

Map git diff to affected symbols, trace impact through the call graph and processes, and assess risk level. Requires a `local_path` repository.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | yes | — | Repository name (must be a `local_path` type) |
| `scope` | `"unstaged"` \| `"staged"` \| `"all"` \| `"compare"` | no | `"all"` | Diff scope: working tree vs index, index vs HEAD, working tree vs HEAD, or compare_ref..HEAD |
| `compare_ref` | string | no | — | Git ref to compare against HEAD (required when scope is `"compare"`) |
| `max_depth` | integer | no | `3` | Max depth for indirect impact tracing through CALLS edges (1–10) |

**Example call:**

```json
{
  "name": "detect_changes",
  "arguments": {
    "repo": "my-api",
    "scope": "staged",
    "max_depth": 2
  }
}
```

**Example response:**

```json
{
  "repo": "my-api",
  "scope": "staged",
  "changed_files": [
    { "path": "src/services/user.ts", "status": "modified" }
  ],
  "direct_symbols": [
    { "name": "createUser", "label": "Function", "file_path": "src/services/user.ts", "line": 10 }
  ],
  "impacted_symbols": [
    { "name": "registerHandler", "label": "Function", "file_path": "src/routes/auth.ts", "line": 5, "depth": 1 }
  ],
  "affected_processes": [
    { "process_id": "p_3", "label": "Registration Flow", "step_count": 5 }
  ],
  "risk": "MEDIUM",
  "summary": {
    "changed_files": 1,
    "direct_symbols": 1,
    "impacted_symbols": 1,
    "affected_processes": 1
  }
}
```

---

## orphans

Find dead code — symbols with no incoming edges (nothing calls or references them).

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | no | — | Repository name (required with multiple repos) |
| `label` | string | no | — | Filter by node label (`Function`, `Class`, `Method`, etc.) |
| `limit` | integer | no | `20` | Max results (1–100) |

**Example call:**

```json
{
  "name": "orphans",
  "arguments": {
    "label": "Function",
    "limit": 5
  }
}
```

**Example response:**

```json
{
  "orphans": [
    {
      "name": "legacyParser",
      "label": "Function",
      "file_path": "src/utils/legacy.ts",
      "line": 12,
      "exported": false
    },
    {
      "name": "unusedHelper",
      "label": "Function",
      "file_path": "src/helpers/old.ts",
      "line": 5,
      "exported": false
    }
  ],
  "count": 2,
  "repo": "my-api"
}
```

---

## edges

List graph edges (relationships) filtered by type and source node label.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | yes | — | Repository name |
| `edge_type` | string | no | — | Filter by edge type (`CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `DEFINES`, `EXPORTS`) |
| `source_label` | string | no | — | Filter by source node label (`Function`, `Class`, `Method`) |
| `limit` | integer | no | `20` | Max results (1–100) |

**Example call:**

```json
{
  "name": "edges",
  "arguments": {
    "repo": "my-api",
    "edge_type": "CALLS",
    "source_label": "Function",
    "limit": 5
  }
}
```

**Example response:**

```json
{
  "edges": [
    {
      "source": { "name": "handleLogin", "label": "Function", "file_path": "src/routes/auth.ts" },
      "target": { "name": "validateCredentials", "label": "Function", "file_path": "src/services/auth.ts" },
      "type": "CALLS"
    }
  ],
  "count": 1,
  "repo": "my-api"
}
```

---

## path

Find the shortest path between two symbols in the code graph.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | yes | — | Repository name |
| `from_symbol` | string | yes | — | Starting symbol name |
| `to_symbol` | string | yes | — | Target symbol name |
| `max_depth` | integer | no | `5` | Max traversal depth (1–10) |
| `from_file_path` | string | no | — | File path to disambiguate the starting symbol |
| `to_file_path` | string | no | — | File path to disambiguate the target symbol |

**Example call:**

```json
{
  "name": "path",
  "arguments": {
    "repo": "my-api",
    "from_symbol": "handleLogin",
    "to_symbol": "sendEmail",
    "max_depth": 5
  }
}
```

**Example response:**

```json
{
  "path": [
    { "name": "handleLogin", "label": "Function", "file_path": "src/routes/auth.ts" },
    { "name": "createSession", "label": "Function", "file_path": "src/services/session.ts" },
    { "name": "notifyUser", "label": "Function", "file_path": "src/services/notifications.ts" },
    { "name": "sendEmail", "label": "Function", "file_path": "src/utils/email.ts" }
  ],
  "edges": [
    { "from": "handleLogin", "to": "createSession", "type": "CALLS" },
    { "from": "createSession", "to": "notifyUser", "type": "CALLS" },
    { "from": "notifyUser", "to": "sendEmail", "type": "CALLS" }
  ],
  "length": 3,
  "repo": "my-api"
}
```

---

## git_history

Get per-file git history stats including authors, commit counts, and last modification dates.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | yes | — | Repository name |
| `file_path` | string | no | — | Filter to a specific file |
| `limit` | integer | no | `20` | Max results (1–100) |

**Example call:**

```json
{
  "name": "git_history",
  "arguments": {
    "repo": "my-api",
    "limit": 5
  }
}
```

**Example response:**

```json
{
  "files": [
    {
      "file_path": "src/routes/auth.ts",
      "commit_count": 47,
      "authors": ["alice@example.com", "bob@example.com"],
      "last_modified": "2026-02-15T10:30:00.000Z"
    },
    {
      "file_path": "src/services/user.ts",
      "commit_count": 32,
      "authors": ["alice@example.com"],
      "last_modified": "2026-02-10T08:15:00.000Z"
    }
  ],
  "count": 2,
  "repo": "my-api"
}
```

---

## git_timeline

Get chronological commit timeline showing what files changed together.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | yes | — | Repository name |
| `since` | string | no | — | Start date (ISO format, e.g., `2024-01-01`) |
| `until` | string | no | — | End date (ISO format, e.g., `2024-12-31`) |
| `limit` | integer | no | `20` | Max results (1–100) |

**Example call:**

```json
{
  "name": "git_timeline",
  "arguments": {
    "repo": "my-api",
    "since": "2026-02-01",
    "limit": 3
  }
}
```

**Example response:**

```json
{
  "commits": [
    {
      "hash": "abc1234",
      "message": "refactor auth middleware",
      "author": "alice@example.com",
      "date": "2026-02-20T14:22:00.000Z",
      "files_changed": ["src/middleware/auth.ts", "src/routes/auth.ts", "src/services/auth.ts"]
    }
  ],
  "count": 1,
  "repo": "my-api"
}
```

---

## nodes

List all graph nodes with filtering and pagination.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repo` | string | yes | — | Repository name |
| `label` | string | no | — | Filter by node label (`Function`, `Class`, `Method`, `Interface`, `TypeAlias`, `Variable`) |
| `file_path` | string | no | — | Filter by file path |
| `exported` | boolean | no | — | Filter by exported status |
| `limit` | integer | no | `20` | Max results (1–100) |
| `offset` | integer | no | `0` | Offset for pagination |

**Example call:**

```json
{
  "name": "nodes",
  "arguments": {
    "repo": "my-api",
    "label": "Class",
    "exported": true,
    "limit": 5
  }
}
```

**Example response:**

```json
{
  "nodes": [
    {
      "name": "UserService",
      "label": "Class",
      "file_path": "src/services/user.ts",
      "line": 10,
      "exported": true,
      "properties": { "name": "UserService", "file_path": "src/services/user.ts", "line": 10, "exported": true }
    }
  ],
  "count": 1,
  "repo": "my-api"
}
```

---

## file_tree

Browse the directory structure of a repository.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repo` | string | yes | Repository name |
| `path` | string | no | Subdirectory path to start from (relative to repo root) |
| `language` | string | no | Filter by programming language |
| `flat` | boolean | no | If true, returns a flat file list instead of a tree |

**Example call:**

```json
{
  "name": "file_tree",
  "arguments": {
    "repo": "my-api",
    "path": "src/routes",
    "language": "typescript"
  }
}
```

**Example response (tree mode):**

```json
{
  "tree": [
    {
      "path": "src/routes",
      "name": "routes",
      "type": "directory",
      "language": null,
      "children": [
        { "path": "src/routes/auth.ts", "name": "auth.ts", "type": "file", "language": "typescript" },
        { "path": "src/routes/users.ts", "name": "users.ts", "type": "file", "language": "typescript" }
      ]
    }
  ],
  "total": 2
}
```

**Example response (flat mode, `flat: true`):**

```json
{
  "files": [
    { "path": "src/routes/auth.ts", "name": "auth.ts", "language": "typescript", "type": "file" },
    { "path": "src/routes/users.ts", "name": "users.ts", "language": "typescript", "type": "file" }
  ],
  "total": 2
}
```
