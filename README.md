<div align="center">

<img src="docs/public/example.png" alt="NexGraph — Cross-repo code knowledge graph visualization" width="700">

# NexGraph

### Your codebase. One knowledge graph. AI-powered.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com)
[![Angular](https://img.shields.io/badge/Angular-DD0031?logo=angular&logoColor=white)](https://angular.dev)
[![MCP](https://img.shields.io/badge/MCP-24_Tools-8B5CF6)](https://modelcontextprotocol.io)

**A headless code intelligence engine that builds knowledge graphs from source code.**
Parse. Index. Let AI agents understand your entire codebase.

[Get Started](#quick-setup) · [Features](#features) · [MCP Tools](#mcp-tools) · [Architecture](#architecture) · [Docs](https://nexgraph.dev)

</div>

---

## What is NexGraph?

NexGraph parses your source code into a **property graph** — functions, classes, imports, call chains, and cross-repo dependencies — stored in PostgreSQL with Apache AGE. It then exposes **24 MCP tools** that let AI agents (Claude Code, Cursor, custom agents) query, trace, and analyze your codebase as a connected graph rather than flat files.

```
Source Code → Tree-sitter AST → Knowledge Graph → AI Agents (via MCP)
```

Most codebases span multiple repositories. NexGraph indexes each repo into its own graph, then **connects them together** — so an AI agent can trace a frontend button click through the API call to the backend handler and its database query.

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-Language Parsing** | TypeScript, JavaScript, Python, Go, Java, Rust, C, C++, C#, Ruby via tree-sitter AST analysis |
| **Code Knowledge Graph** | Symbols, imports, call chains, and inheritance stored as a property graph in Apache AGE |
| **24 MCP Tools** | Full code intelligence exposed to AI agents via Model Context Protocol (HTTP + stdio) |
| **Cross-Repo Tracing** | Link multiple repositories — trace execution flows across frontend/backend boundaries |
| **Semantic Search** | BM25 keyword search, pgvector embeddings, and hybrid mode across all indexed files |
| **Community Detection** | Auto-discover functional clusters (auth, payments, users) using the Leiden algorithm |
| **Process Detection** | BFS tracing from entry points to map execution flows end-to-end |
| **Impact Analysis** | Change a function, see every caller affected — at depth 1, 2, and 3 |
| **Architecture Checks** | Define layer rules, detect violations across the entire codebase |
| **Route Detection** | Auto-detect HTTP route handlers (Express, Hono, Flask, FastAPI, Gin, Spring, Actix, Axum) |
| **Git Intelligence** | Per-file commit history, author attribution, hotspot analysis, change timelines |
| **Incremental Indexing** | Update existing graphs via git diff — no full re-index needed |
| **Claude Plugin** | Pre-built plugin with 6 skills, hooks, and installer for Claude Code integration |
| **Web Frontend** | Angular + D3.js/PixiJS graph visualization with SVG and WebGL renderers |

---

## MCP Tools

NexGraph exposes 24 tools organized into seven categories that any MCP-compatible AI client can use:

| Category | Tools | What They Do |
|----------|-------|--------------|
| **Code Intelligence** | `query`, `context`, `read_file`, `nodes`, `file_tree` | Find symbols, get 360-degree context, browse code |
| **Graph Analysis** | `cypher`, `dependencies`, `impact`, `trace`, `routes`, `communities`, `processes`, `edges`, `path` | Traverse the graph, trace flows, detect clusters |
| **Search** | `search`, `grep` | Full-text keyword, semantic, hybrid search, and regex grep |
| **Refactoring** | `rename` | Multi-file coordinated rename with confidence scoring |
| **Change Analysis** | `detect_changes`, `architecture_check`, `orphans` | Git-diff impact, layer violations, dead code |
| **Git Intelligence** | `git_history`, `git_timeline` | Commit stats, author attribution, co-change patterns |
| **Project Overview** | `graph_stats`, `cross_repo_connections` | Node/edge counts, cross-repo link rules |

### MCP Resources

| Resource | Description |
|----------|-------------|
| `nexgraph://project/info` | Project metadata, settings, and repository list |
| `nexgraph://repos` | All repos with indexing status and file counts |
| `nexgraph://repos/{repo}/tree` | File tree of a repository |
| `nexgraph://repos/{repo}/stats` | Graph statistics (node/edge counts by label) |
| `nexgraph://connections` | Cross-repo connection rules with edge counts |

---

## How It Works

1. **Create a project** — group related repositories (frontend, backend, shared libs)
2. **Index each repo** — NexGraph parses source code into a knowledge graph via an 8-phase pipeline
3. **Connect repos** — define cross-repo rules (API URL matching, shared types) to link repos together
4. **Query via MCP** — AI agents use 24 tools to search, trace, and analyze the full codebase
5. **Visualize** — explore the graph in the Angular web frontend with D3.js/PixiJS renderers

### Ingestion Pipeline

```
Extract → Parse (AST) → Imports → Call Graph → Routes → Communities → Processes → Embeddings
```

| Phase | What Happens |
|-------|-------------|
| **Extract** | Clone git repos, extract ZIPs, validate file sizes, apply include/exclude globs |
| **Parse** | Tree-sitter AST analysis — extract functions, classes, methods, interfaces, enums, traits |
| **Imports** | Resolve module dependencies and IMPORTS edges with path resolution |
| **Call Graph** | Extract CALLS edges between symbols across 10 languages |
| **Routes** | Detect HTTP route handlers (Express, Hono, Flask, FastAPI, Gin, Spring, Actix, Axum) |
| **Communities** | Leiden algorithm on call edges to discover functional clusters |
| **Processes** | BFS tracing from entry points to detect execution flows |
| **Embeddings** | Generate semantic vectors (HuggingFace, OpenAI, Google, Mistral, Cohere, Bedrock) |

---

## Supported Languages

| Language | Symbols | Imports | Call Graph | Route Detection |
|----------|:-------:|:-------:|:----------:|:---------------:|
| TypeScript | ✓ | ✓ | ✓ | Express, Hono, NestJS |
| JavaScript | ✓ | ✓ | ✓ | Express, Hono |
| Python | ✓ | ✓ | ✓ | Flask, FastAPI |
| Go | ✓ | ✓ | ✓ | net/http, Gin |
| Java | ✓ | ✓ | ✓ | Spring |
| Rust | ✓ | ✓ | ✓ | Actix, Axum |
| C | ✓ | ✓ | ✓ | — |
| C++ | ✓ | ✓ | ✓ | — |
| C# | ✓ | ✓ | ✓ | — |
| Ruby | ✓ | ✓ | ✓ | — |

---

## Quick Setup

### Docker Compose (Recommended)

```bash
# 1. Clone and install
git clone https://github.com/nexgraph/nexgraph.git
cd nexgraph
npm install

# 2. Start PostgreSQL with AGE + pgvector
docker compose up -d

# 3. Configure environment
cp .env.example .env

# 4. Run database migrations
npm run db:migrate

# 5. Start the server
npm run dev
```

The API is now available at `http://localhost:3000/api/v1`.

### Connect Your AI Assistant

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add --transport http nexgraph http://localhost:3000/mcp \
  --header "Authorization: Bearer nxg_your_key_here"
```

Or install the full plugin bundle (hooks + skills):

```bash
npm run plugin:install -- --target /path/to/your/project \
  --api-url http://localhost:3000 --api-key nxg_your_key_here
```

</details>

<details>
<summary><b>Cursor</b></summary>

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

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

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

</details>

<details>
<summary><b>Custom Agents (TypeScript / Python)</b></summary>

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3000/mcp"),
  { requestInit: { headers: { Authorization: "Bearer nxg_your_key" } } }
);

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

const result = await client.callTool({
  name: "query",
  arguments: { query: "authentication" }
});
```

</details>

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Clients                       │
│  REST API  │  MCP (HTTP/SSE)  │  Web Frontend   │
└──────┬─────┴────────┬─────────┴────────┬────────┘
       │              │                  │
┌──────▼──────────────▼──────────────────▼────────┐
│               Hono HTTP Server                   │
│  OpenAPI Routes │ Auth Middleware │ MCP Hub      │
└──────┬──────────────┬───────────────────────────┘
       │              │
┌──────▼──────┐ ┌─────▼─────────────────────┐
│  pg-boss    │ │  Query Layer              │
│  Job Queue  │ │  Cypher│SQL│FTS│pgvector  │
└──────┬──────┘ └─────┬─────────────────────┘
       │              │
┌──────▼──────────────▼───────────────────┐
│  PostgreSQL + AGE + pg_trgm + pgvector  │
│  Relational │ Property Graph │ Vectors  │
└─────────────────────────────────────────┘
```

---

## Tech Stack

<table>
<tr>
<td width="50%">

**Backend**
- Node.js 20+ / Hono
- TypeScript 5.7
- Tree-sitter (10 language grammars)
- pg-boss (job queue)
- Pino (structured logging)

</td>
<td width="50%">

**Database**
- PostgreSQL 18
- Apache AGE (property graphs / Cypher)
- pgvector (semantic embeddings)
- pg_trgm (trigram similarity)

</td>
</tr>
<tr>
<td width="50%">

**Frontend**
- Angular 21
- D3.js 7 (SVG renderer)
- PixiJS 8 (WebGL renderer)
- Dagre (graph layout)
- RxJS (reactive state)

</td>
<td width="50%">

**AI / MCP**
- Model Context Protocol SDK
- Vercel AI SDK (multi-provider)
- HuggingFace Transformers
- OpenAI, Google, Mistral, Cohere, Bedrock
- Graphology + Leiden algorithm

</td>
</tr>
</table>

---

## Claude Plugin

NexGraph ships with a pre-built Claude Code plugin that enhances your AI assistant with code graph intelligence:

| Component | Description |
|-----------|-------------|
| **6 Skills** | Exploring, debugging, impact analysis, refactoring, CLI setup, and tool guide |
| **PreToolUse Hook** | Intercepts Grep/Glob/Bash calls to inject graph context before tool execution |
| **MCP Config** | Auto-configured `.mcp.json` with HTTP transport and Bearer auth |
| **One-Command Install** | `npm run plugin:install -- --target /your/project --api-key nxg_...` |

### Plugin Skills

| Skill | When to Use |
|-------|-------------|
| `nexgraph-exploring` | "How does authentication work?" — trace architecture and execution flows |
| `nexgraph-debugging` | "Why is this endpoint failing?" — trace errors through the call graph |
| `nexgraph-impact-analysis` | "What breaks if I change this?" — blast radius and risk assessment |
| `nexgraph-refactoring` | "Rename this function safely" — coordinated multi-file refactoring |
| `nexgraph-cli` | "Set up NexGraph" — server setup, plugin install, troubleshooting |
| `nexgraph-guide` | "What tools are available?" — full reference for all 24 tools |

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/nexgraph` | PostgreSQL connection string |
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Logging verbosity (debug, info, warn, error) |
| `WORKER_POOL_SIZE` | `0` (auto: CPU cores - 1) | Tree-sitter parsing threads |
| `EMBEDDING_ENABLED` | `true` | Enable semantic vector embeddings |
| `EMBEDDING_MODEL` | `Snowflake/snowflake-arctic-embed-xs` | HuggingFace embedding model |
| `MAX_FILE_SIZE` | `1048576` | Max file size to index (bytes) |

See `.env.example` for the full list including optional AI provider API keys (OpenAI, Google, Mistral, Cohere, AWS Bedrock).

### Embedding Providers

| Provider | Setup |
|----------|-------|
| **HuggingFace** (default) | No API key needed — runs locally |
| **OpenAI** | Set `OPENAI_API_KEY` |
| **Google** | Set `GOOGLE_GENERATIVE_AI_API_KEY` |
| **Mistral** | Set `MISTRAL_API_KEY` |
| **Cohere** | Set `COHERE_API_KEY` |
| **AWS Bedrock** | Set `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION` |

---

## Development

```bash
# Run with hot reload
npm run dev

# Type checking
npm run typecheck

# Lint
npm run lint

# Run tests (845 tests)
npm test

# Run database migrations
npm run db:migrate

# Generate API docs
npm run docs:generate

# Start frontend dev server
cd frontend && npm start
```

---

## Troubleshooting

<details>
<summary><b>Database connection fails</b></summary>

Ensure PostgreSQL is running with the required extensions:

```bash
docker compose up -d db
docker compose logs db
```

Verify the connection:

```bash
psql postgresql://postgres:postgres@localhost:5432/nexgraph -c "SELECT 1"
```

</details>

<details>
<summary><b>Tree-sitter build errors</b></summary>

Tree-sitter grammars require native compilation. Ensure you have build tools installed:

```bash
# macOS
xcode-select --install

# Ubuntu/Debian
sudo apt install python3 make g++

# Windows
# Install "Desktop development with C++" from Visual Studio
```

</details>

<details>
<summary><b>MCP connection not working</b></summary>

1. Verify the server is running: `curl http://localhost:3000/api/v1/health`
2. Check your API key is valid
3. For Claude Code: run `claude mcp list` to verify the server is registered
4. Check server logs: `LOG_LEVEL=debug npm run dev`

</details>

<details>
<summary><b>Indexing is slow</b></summary>

1. Increase worker threads: `WORKER_POOL_SIZE=8`
2. Increase database pool: `DB_POOL_MAX=20`
3. For large repos, use include/exclude globs to skip `node_modules`, `vendor`, etc.
4. Disable embeddings if not needed: `EMBEDDING_ENABLED=false`

</details>

---

## License

This project is licensed under the **MIT License**.

---

<div align="center">

**Built with TypeScript, PostgreSQL, and a love for code intelligence.**

</div>
