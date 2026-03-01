# Export API

Export knowledge graph data in multiple formats for external tools, backups, or analysis.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| [`GET /repositories/{repoId}/export/json`](#get-export-json) | Export graph as JSON |
| [`GET /repositories/{repoId}/export/csv`](#get-export-csv) | Export graph as CSV |
| [`GET /repositories/{repoId}/export/cypher`](#get-export-cypher) | Export graph as Cypher CREATE statements |
| [`GET /projects/{projectId}/export/full`](#get-export-full) | Export all repos + cross-repo edges |

---

## `GET /api/v1/repositories/{repoId}/export/json` {#get-export-json}

Export the full knowledge graph for a repository as JSON.

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Response (200)

```json
{
  "nodes": [
    { "id": 1, "label": "File", "properties": { "path": "src/index.ts" } },
    { "id": 2, "label": "Function", "properties": { "name": "main", "exported": true } }
  ],
  "edges": [
    { "id": 100, "label": "DEFINES", "start_id": 1, "end_id": 2, "properties": {} }
  ],
  "metadata": {
    "repo_id": "97444924-...",
    "node_count": 193,
    "edge_count": 412,
    "exported_at": "2026-02-27T12:00:00.000Z"
  }
}
```

---

## `GET /api/v1/repositories/{repoId}/export/csv` {#get-export-csv}

Export the graph as CSV strings (nodes and edges separately).

### Response (200)

```json
{
  "nodes_csv": "id,label,name,file_path,exported,kind,properties\n1,File,...",
  "edges_csv": "id,label,start_id,end_id,source_name,target_name,properties\n100,DEFINES,...",
  "metadata": {
    "repo_id": "97444924-...",
    "node_count": 193,
    "edge_count": 412,
    "exported_at": "2026-02-27T12:00:00.000Z"
  }
}
```

---

## `GET /api/v1/repositories/{repoId}/export/cypher` {#get-export-cypher}

Export the graph as Cypher `CREATE` statements, suitable for importing into Neo4j or another Apache AGE instance.

### Response (200)

```json
{
  "cypher": "// Nodes\nCREATE (:File {path: 'src/index.ts'});\n// Edges\nMATCH (a:File ...), (b:Function ...) CREATE (a)-[:DEFINES]->(b);",
  "metadata": {
    "repo_id": "97444924-...",
    "node_count": 193,
    "edge_count": 412,
    "exported_at": "2026-02-27T12:00:00.000Z"
  }
}
```

---

## `GET /api/v1/projects/{projectId}/export/full` {#get-export-full}

Export all repositories and cross-repo edges for an entire project.

### Response (200)

```json
{
  "repositories": [
    {
      "repo_id": "97444924-...",
      "repo_name": "backend",
      "nodes": [ ... ],
      "edges": [ ... ]
    },
    {
      "repo_id": "ae70a9a6-...",
      "repo_name": "frontend",
      "nodes": [ ... ],
      "edges": [ ... ]
    }
  ],
  "cross_repo_edges": [
    {
      "id": "...",
      "source_repo_id": "ae70a9a6-...",
      "target_repo_id": "97444924-...",
      "source_node": "fetchUsers",
      "target_node": "getUsersHandler",
      "edge_type": "CROSS_REPO_CALLS",
      "metadata": { "confidence": 0.85 }
    }
  ],
  "metadata": {
    "project_id": "956fe4c9-...",
    "repo_count": 2,
    "total_nodes": 386,
    "total_edges": 824,
    "cross_repo_edge_count": 26,
    "exported_at": "2026-02-27T12:00:00.000Z"
  }
}
```
