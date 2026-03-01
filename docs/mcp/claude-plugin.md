# NexGraph Claude Plugin Bundle

This bundle provides a Claude plugin layout (`.mcp.json`, `hooks/`, `skills/`, `.claude-plugin/`) for the NexGraph backend.

## What It Installs

- `.mcp.json` (merged): adds/updates `mcpServers.nexgraph`
- `hooks/nexgraph-hook.js`: PreToolUse hook for `Grep|Glob|Bash`
- `hooks/hooks.json` (merged): adds NexGraph hook matcher
- `skills/nexgraph-*`: reusable skill guides for exploration, debugging, impact analysis
- `.claude-plugin/plugin.json`: plugin metadata

## One-Command Install

```bash
npm run plugin:install -- --target /absolute/path/to/your/project --api-url http://localhost:3000 --api-key nxg_your_key_here
```

## Install From Backend Server (No Repo Clone)

```bash
API_URL="http://localhost:3000"
API_KEY="nxg_your_key_here"
TMP_DIR="$(mktemp -d)"

curl -fsSL \
  -H "Authorization: Bearer ${API_KEY}" \
  "${API_URL}/api/v1/integrations/claude-plugin/archive" \
  -o "${TMP_DIR}/nexgraph-claude-plugin.zip"

unzip -oq "${TMP_DIR}/nexgraph-claude-plugin.zip" -d "${TMP_DIR}/nexgraph-claude-plugin"

node "${TMP_DIR}/nexgraph-claude-plugin/install.cjs" \
  --target "$(pwd)" \
  --api-url "${API_URL}" \
  --api-key "${API_KEY}"
```

## Installer Options

- `--target <path>`: target project directory (default: current directory)
- `--api-url <url>`: NexGraph API base URL (default: `http://localhost:3000`)
- `--api-key <key>`: API key for MCP Authorization header
- `--transport <http|stdio>`: MCP transport mode (default: `http`)
- `--server-name <name>`: mcp server key in `.mcp.json` (default: `nexgraph`)
- `--force`: overwrite plugin template files if they already exist

## How the Hook Works

`hooks/nexgraph-hook.js` intercepts `Grep`, `Glob`, and `Bash` search calls and fetches quick context from NexGraph:

1. Reads MCP connection details from `.mcp.json` (or env fallback)
2. Lists project repositories via `GET /api/v1/repositories`
3. Selects a likely repo from current working directory name
4. Runs `POST /api/v1/repositories/:repoId/search` in `hybrid` mode
5. Injects top results into `additionalContext` for Claude before tool execution

This gives Claude graph-backed hints while still letting local grep/glob run normally.
