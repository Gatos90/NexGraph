# Query the Graph

This tutorial shows how to query the NexGraph knowledge graph using Cypher.

## Prerequisites

- A repository already indexed (see [Index Your First Repo](/tutorials/))

## Finding Functions

```cypher
MATCH (f:Function)
WHERE f.exported = true
RETURN f.name, f.file_path, f.line
ORDER BY f.name
LIMIT 20
```

## Tracing Call Chains

Find what a function calls:

```cypher
MATCH (caller:Function {name: 'handleRequest'})-[:CALLS]->(callee)
RETURN caller.name, callee.name, callee.file_path
```

Find who calls a function:

```cypher
MATCH (caller)-[:CALLS]->(target:Function {name: 'validateInput'})
RETURN caller.name, caller.file_path
```

## Class Hierarchies

```cypher
MATCH (child:Class)-[:EXTENDS]->(parent:Class)
RETURN child.name, parent.name
```

## Import Graphs

Find all files imported by a specific file:

```cypher
MATCH (source:File {path: 'src/index.ts'})-[:IMPORTS]->(target:File)
RETURN target.path
```

## File Symbols

List all symbols defined in a file:

```cypher
MATCH (f:File {path: 'src/app.ts'})-[:DEFINES]->(s)
RETURN labels(s)[0] AS kind, s.name, s.line
ORDER BY s.line
```

## Running Queries via API

```bash
curl -X POST http://localhost:3000/api/v1/repositories/$REPO_ID/graph/cypher \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "MATCH (f:Function) WHERE f.exported = true RETURN f.name LIMIT 10",
    "columns": [{"name": "result"}]
  }'
```

## Running Queries via MCP

If you're using NexGraph with an AI assistant, the `cypher` tool lets you run queries conversationally:

> "Show me all exported functions in the express repository"

The AI assistant will translate this to a Cypher query and return the results.
