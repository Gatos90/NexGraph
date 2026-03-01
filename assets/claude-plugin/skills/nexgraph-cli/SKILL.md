---
name: nexgraph-cli
description: "Use when the user needs to set up NexGraph, manage repositories, check server status, or install the plugin. Examples: \"Set up NexGraph\", \"Add a repo\", \"Check index status\", \"Install the plugin\""
---

# NexGraph Setup & Management

## NexGraph Architecture

NexGraph is a **server-based** code intelligence platform, not a local CLI tool. It runs as a Docker service (API + PostgreSQL with Apache AGE) and exposes an MCP server for Claude Code integration.

Key difference from local-index tools: repositories are indexed on the server side via the API. No local `.nexgraph/` directory is created.

## Quick Setup

```bash
# 1. Start the NexGraph server
docker compose up -d

# 2. Create a project and API key via the API or UI

# 3. Install the Claude Code plugin into your project
node install.cjs --target /path/to/project --api-url http://localhost:3000 --api-key <key>
```

## Checking Index Status

Use the `graph_stats` tool or read the repos resource:

```
READ nexgraph://repos
-> repositories: [{name: "my-app", file_count: 385, latest_job_status: "completed"}]

graph_stats()
-> total_nodes: 2847, total_edges: 9123
-> nodes_by_label: {Function: 1200, Class: 150, File: 385, ...}
```

## Plugin Installation

```bash
node install.cjs --target /path/to/project [options]
```

| Flag | Default | Effect |
| ---- | ------- | ------ |
| `--target <path>` | (required) | Target project directory |
| `--api-url <url>` | `http://localhost:3000` | NexGraph API base URL |
| `--api-key <key>` | `${NEXGRAPH_API_KEY}` | API key for auth |
| `--server-name <name>` | `nexgraph` | MCP server name in `.mcp.json` |
| `--transport <mode>` | `http` | `http` or `stdio` |
| `--force` | off | Overwrite existing files |

The installer merges `.mcp.json` and `hooks/hooks.json` non-destructively -- existing servers and hooks are preserved.

## MCP Transport Modes

**HTTP (default)** -- connects to a running NexGraph server:
```json
{
  "mcpServers": {
    "nexgraph": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${NEXGRAPH_API_KEY}" }
    }
  }
}
```

**STDIO** -- launches a local MCP bridge process:
```json
{
  "mcpServers": {
    "nexgraph": {
      "command": "npx",
      "args": ["-y", "nexgraph-mcp@latest"],
      "env": { "NEXGRAPH_API_URL": "http://localhost:3000", "NEXGRAPH_API_KEY": "<key>" }
    }
  }
}
```

## After Setup

1. **Read `nexgraph://repos`** to verify repos are indexed
2. Use the other NexGraph skills for your task:

| Task | Skill |
| ---- | ----- |
| Understand architecture | `nexgraph-exploring` |
| Blast radius analysis | `nexgraph-impact-analysis` |
| Trace bugs | `nexgraph-debugging` |
| Rename / extract / refactor | `nexgraph-refactoring` |
| Tools & schema reference | `nexgraph-guide` |

## Troubleshooting

| Problem | Solution |
| ------- | -------- |
| "Connection refused" | Start NexGraph server: `docker compose up -d` |
| "Unauthorized" / 401 | Check `NEXGRAPH_API_KEY` env var or `.mcp.json` Bearer token |
| No repos in `graph_stats` | Add and index a repository via the NexGraph API |
| Stale graph / missing symbols | Re-index the repository via the NexGraph API |
| Hook not enriching searches | Verify `.mcp.json` exists in project root with `nexgraph` server |
