# MCP Integration Guide

This guide covers integrating NexGraph's MCP server with AI coding assistants (Cursor, Claude Code, Claude Desktop) and building custom agent integrations.

## Prerequisites

Before connecting any MCP client, ensure NexGraph is running and has at least one indexed repository:

1. NexGraph server is running (via Docker or local development)
2. At least one project and repository have been created and indexed via the REST API
3. An API key for the target project (create via `POST /api/v1/projects/{id}/api-keys`)

The MCP endpoint is automatically available at `/mcp` on the running server — no extra setup needed.

## Claude Code Setup (Recommended: HTTP)

Claude Code connects directly to the running NexGraph server via HTTP transport.

### Step 1: Add via CLI

```bash
claude mcp add --transport http nexgraph http://localhost:3000/mcp \
  --header "Authorization: Bearer nxg_your_key_here"
```

### Step 2: Verify

The 24 NexGraph tools will appear as available MCP tools. Verify by asking:

> "Use the graph_stats tool to show me the indexed repositories"

### Alternative: Config File

Add to `.mcp.json` in your project root (shared with team via git):

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

Or add to `~/.claude.json` (user-level, applies to all projects):

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

### Troubleshooting

- **Connection failed:** Ensure the NexGraph server is running at the configured URL
- **401 Unauthorized:** Check your API key is valid and not revoked
- **No tools visible:** Ensure at least one repository has been indexed

## Cursor Setup (Recommended: HTTP)

### Step 1: Configure Cursor

Create or edit `.cursor/mcp.json` in your project root:

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

You can also configure this through Cursor's Settings UI under **Features > MCP Servers**.

### Step 2: Verify

After saving, Cursor will connect to the NexGraph MCP endpoint. The 24 code intelligence tools will appear in Cursor's tool list. Try asking:

> "Use the graph_stats tool to show me the indexed repositories"

## Claude Desktop Setup (Recommended: HTTP)

Edit the config file at:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

::: details Alternative: Stdio Transport
If your MCP client only supports stdio transport, you can use the bridge process instead. This spawns a local Node.js process that forwards requests to the NexGraph HTTP API:

```json
{
  "mcpServers": {
    "nexgraph": {
      "command": "npx",
      "args": ["nexgraph"],
      "env": {
        "NEXGRAPH_API_KEY": "nxg_your_key_here",
        "NEXGRAPH_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

See the [Stdio Transport](/mcp/stdio) guide for details.
:::

## Custom Agent Integration (HTTP)

For custom AI agents, web applications, or remote clients, connect to the MCP HTTP endpoint directly.

### Protocol Flow

The HTTP transport implements the [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) specification:

```
Client                          Server (NexGraph)
  │                                  │
  │── POST /mcp (initialize) ──────>│
  │   (Authorization: Bearer <key>)  │
  │<── 200 + mcp-session-id ────────│
  │                                  │
  │── POST /mcp (tools/list) ──────>│
  │   (mcp-session-id header)        │
  │<── 200 [{tools}] ──────────────│
  │                                  │
  │── POST /mcp (tools/call) ──────>│
  │   (mcp-session-id header)        │
  │<── 200 [{result}] ─────────────│
  │                                  │
  │── GET /mcp ────────────────────>│
  │   (mcp-session-id header)        │
  │<── SSE stream (notifications) ──│
  │                                  │
  │── DELETE /mcp ─────────────────>│
  │   (mcp-session-id header)        │
  │<── 200 (session closed) ────────│
```

### Step 1: Initialize a Session

The initialize request requires a Bearer token (API key) to authenticate and determine the project scope:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEXGRAPH_KEY" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "my-agent",
        "version": "1.0.0"
      }
    }
  }'
```

Save the `mcp-session-id` response header for all subsequent requests.

### Step 2: Send Initialized Notification

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -d '{
    "jsonrpc": "2.0",
    "method": "notifications/initialized"
  }'
```

### Step 3: List Available Tools

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'
```

### Step 4: Call a Tool

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "graph_stats",
      "arguments": {}
    }
  }'
```

### Step 5: Close the Session

```bash
curl -X DELETE http://localhost:3000/mcp \
  -H "mcp-session-id: <session-id>"
```

### TypeScript Client Example

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3000/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.NEXGRAPH_API_KEY}` } } }
);

const client = new Client({
  name: "my-agent",
  version: "1.0.0",
});

await client.connect(transport);

// List tools
const { tools } = await client.listTools();
console.log("Available tools:", tools.map(t => t.name));

// Call a tool
const result = await client.callTool({
  name: "query",
  arguments: { query: "handleRequest", limit: 5 },
});
console.log("Result:", result.content);

// Clean up
await client.close();
```

### Python Client Example

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(
        "http://localhost:3000/mcp",
        headers={"Authorization": f"Bearer {os.environ['NEXGRAPH_API_KEY']}"}
    ) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()

        # List tools
        tools = await session.list_tools()
        print([t.name for t in tools.tools])

        # Call a tool
        result = await session.call_tool("query", {"query": "handleRequest"})
        print(result.content)
```

## Environment Variables

| Variable | Context | Default | Description |
|----------|---------|---------|-------------|
| `PORT` | Server | `3000` | HTTP server port (MCP endpoint lives at `/mcp` on this port) |
| `HOST` | Server | `0.0.0.0` | HTTP server bind address |
| `NEXGRAPH_API_KEY` | Stdio only | — | API key for the stdio bridge process |
| `NEXGRAPH_API_URL` | Stdio only | — | NexGraph server URL for the stdio bridge process |
| `LOG_LEVEL` | Both | `info` | Log verbosity (`fatal`/`error`/`warn`/`info`/`debug`/`trace`) |

::: tip HTTP transport needs no server-side env vars for MCP
When using HTTP transport, authentication is handled by the `Authorization` header sent by the MCP client. No MCP-specific environment variables are needed on the server.
:::
