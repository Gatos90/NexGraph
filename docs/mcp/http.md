# HTTP Transport (Recommended)

The HTTP transport is the recommended way to connect MCP clients to NexGraph. The MCP endpoint runs as part of the NexGraph server — no extra processes, no extra configuration. AI assistants (Claude Code, Cursor, Claude Desktop) and custom agents connect directly.

## Endpoint

```
http://localhost:3000/mcp
```

The MCP HTTP endpoint is mounted at `/mcp` on the main NexGraph server. Start the server with:

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

## AI Assistant Quick Setup

For Claude Code, Cursor, or Claude Desktop, just add this to your MCP config:

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

See the [Integration Guide](/mcp/integration-guide) for per-client setup details.

## HTTP Methods

| Method | Purpose |
|--------|---------|
| `POST` | Send JSON-RPC requests (initialize, tools/list, tools/call) |
| `GET` | Open SSE stream for server notifications |
| `DELETE` | Close a session |

## Session Management

Sessions are tracked via the `mcp-session-id` header. Each new `initialize` request creates a session. Use the returned session ID for all subsequent requests.

### 1. Initialize a Session

The first request requires an `Authorization: Bearer <API_KEY>` header. After initialization, subsequent requests use the `mcp-session-id` header instead.

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEXGRAPH_API_KEY" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "my-agent", "version": "1.0" }
    }
  }'
```

The response includes a `mcp-session-id` header. Save it for subsequent requests.

### 2. Send Initialized Notification

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}'
```

### 3. List Tools

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}'
```

### 4. Call a Tool

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "query",
      "arguments": { "query": "handleRequest", "limit": 5 }
    }
  }'
```

### 5. Close the Session

```bash
curl -X DELETE http://localhost:3000/mcp \
  -H "mcp-session-id: <session-id>"
```

## SSE Streaming

Open an SSE stream to receive server-initiated notifications:

```bash
curl -N http://localhost:3000/mcp \
  -H "Accept: text/event-stream" \
  -H "mcp-session-id: <session-id>"
```

## SDK Client Examples

### TypeScript

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3000/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.NEXGRAPH_API_KEY}` } } }
);
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const result = await client.callTool({
  name: "graph_stats",
  arguments: {},
});

console.log(result.content);
await client.close();
```

### Python

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(
        "http://localhost:3000/mcp",
        headers={"Authorization": f"Bearer {os.environ['NEXGRAPH_API_KEY']}"}
    ) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        result = await session.call_tool("graph_stats", {})
        print(result.content)
```
