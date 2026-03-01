# MCP Guide

NexGraph implements the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), allowing AI agents and coding assistants to query your code knowledge graph directly.

## What is MCP?

MCP is an open protocol that standardizes how AI applications interact with external tools and data sources. NexGraph acts as an MCP server, exposing 24 code intelligence tools that any MCP-compatible client can use.

## Transports

NexGraph supports two MCP transport modes:

| Transport | Use Case | Connection |
|-----------|----------|------------|
| [HTTP](/mcp/http) **(Recommended)** | All MCP clients — no extra process needed | Direct HTTP to running NexGraph server |
| [Stdio](/mcp/stdio) | Fallback for clients without HTTP support | Spawns a separate bridge process |

## Authentication

- **HTTP transport:** Pass `Authorization: Bearer <API_KEY>` header (configured in your MCP client)
- **Stdio transport:** Set `NEXGRAPH_API_KEY` and `NEXGRAPH_API_URL` environment variables

Create an API key via `POST /api/v1/projects/{projectId}/api-keys`. See [API Keys](/api/api-keys) for details.

## Quick Setup

The MCP endpoint is automatically available at `/mcp` on your running NexGraph server. No extra setup needed — just point your AI assistant at it.

### Claude Code

```bash
claude mcp add --transport http nexgraph http://localhost:3000/mcp \
  --header "Authorization: Bearer nxg_your_key_here"
```

For a full project bundle (`.mcp.json` + hooks + skills), see [Claude Plugin Bundle](/mcp/claude-plugin).

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "nexgraph": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${NEXGRAPH_API_KEY}"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "nexgraph": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer nxg_your_key_here"
      }
    }
  }
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "nexgraph": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer nxg_your_key_here"
      }
    }
  }
}
```

### Custom Agents (TypeScript / Python)

See the [Integration Guide](/mcp/integration-guide) for SDK client examples and the complete session protocol flow.

::: tip Why HTTP?
The MCP endpoint runs as part of the NexGraph server — no separate process to manage. Your AI assistant connects directly to the same server that hosts the API and graph database. This is simpler, faster, and has no extra dependencies.
:::

::: details Alternative: Stdio Transport
If your MCP client only supports stdio transport, see the [Stdio Transport](/mcp/stdio) guide. The stdio transport runs a lightweight bridge process that forwards requests to the NexGraph HTTP API.
:::

## Available Tools

NexGraph exposes 24 tools organized into seven categories:

**Code Intelligence:** `query`, `context`, `read_file`, `nodes`, `file_tree`

**Graph Analysis:** `cypher`, `dependencies`, `impact`, `trace`, `routes`, `communities`, `processes`, `edges`, `path`

**Search:** `search`, `grep`

**Refactoring:** `rename`

**Change Analysis:** `detect_changes`, `architecture_check`, `orphans`

**Git Intelligence:** `git_history`, `git_timeline`

**Project Overview:** `graph_stats`, `cross_repo_connections`

See the full [Tools Reference](/mcp/tools) for parameters, descriptions, and example calls with expected responses.

## MCP Resources

NexGraph also exposes 5 MCP resources for project metadata:

| Resource | URI | Description |
|----------|-----|-------------|
| Project Info | `nexgraph://project/info` | Project name, settings, repositories |
| Repositories | `nexgraph://repos` | All repos with indexing status |
| Repo Tree | `nexgraph://repos/{repo}/tree` | File tree of a repository |
| Repo Stats | `nexgraph://repos/{repo}/stats` | Graph statistics per repo |
| Connections | `nexgraph://connections` | Cross-repo connection rules |
