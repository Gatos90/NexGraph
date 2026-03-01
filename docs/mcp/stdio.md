# Stdio Transport

::: tip Prefer HTTP Transport
The recommended way to connect is via [HTTP transport](/mcp/http), which connects directly to the running NexGraph server with no extra process. Use stdio only if your MCP client doesn't support HTTP transport.

See the [MCP Guide](/mcp/) for HTTP setup instructions.
:::

The stdio transport spawns a lightweight bridge process that forwards MCP requests to the NexGraph HTTP API. It is an alternative for MCP clients that only support stdin/stdout communication.

## How It Works

The MCP client (Cursor, Claude Code, etc.) spawns a NexGraph bridge process that communicates over stdin/stdout using JSON-RPC. The bridge process calls the NexGraph HTTP API internally and returns results over stdio. All application logs are redirected to stderr to avoid corrupting the protocol stream.

## Running as Stdio Server

```bash
# Via npm script (development)
npm run mcp

# Via npx (no global install needed)
npx nexgraph

# Via global install
npm install -g nexgraph
nexgraph
```

## Configuration

All configuration is via environment variables. Pass them in the MCP client config's `env` block, or set them before launching:

```bash
NEXGRAPH_API_KEY=nxg_your_key_here NEXGRAPH_API_URL=http://localhost:3000 npm run mcp
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXGRAPH_API_KEY` | **Yes** | — | API key that scopes the MCP server to a project. Create one via `POST /api/v1/projects/{id}/api-keys`. |
| `NEXGRAPH_API_URL` | **Yes** | — | Base URL of the NexGraph API server (e.g., `http://localhost:3000`). |
| `LOG_LEVEL` | No | `info` | Log verbosity (`fatal`/`error`/`warn`/`info`/`debug`/`trace`) |

::: warning Required Environment Variables
The stdio transport requires both `NEXGRAPH_API_KEY` and `NEXGRAPH_API_URL` to be set. Without them, the server exits immediately with an error. The API key determines which project the MCP server has access to — all tool calls are scoped to that project. The API URL points to the running NexGraph server.
:::

## Cursor Setup

Create or edit `.cursor/mcp.json` in your project root:

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

You can also configure this through Cursor's Settings UI under **Features > MCP Servers**.

After saving, Cursor will automatically start the NexGraph server. The 24 code intelligence tools will appear in Cursor's tool list.

## Claude Code Setup

Use the CLI to add the server:

```bash
claude mcp add nexgraph -- npx nexgraph
```

Or create `.mcp.json` in your project root:

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

## Claude Desktop Setup

Edit the config file at:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

## Troubleshooting

**Server exits immediately:**
- Check that `NEXGRAPH_API_KEY` is set and points to a valid, non-revoked API key
- Check that `NEXGRAPH_API_URL` is set and points to a running NexGraph server
- The API key must belong to an existing project — create one via `POST /api/v1/projects/{id}/api-keys`

**Server won't start:**
- Verify the NexGraph API server is running and accessible at your `NEXGRAPH_API_URL`
- Run `npx nexgraph` manually in your terminal to see stderr output

**No tools visible:**
- Ensure at least one repository has been indexed via the REST API
- Check the MCP client's log output for connection errors

**Debug logging:**
Add `"LOG_LEVEL": "debug"` to the `env` block to see detailed server logs on stderr.
