---
layout: home

hero:
  name: NexGraph
  text: Headless Code Intelligence Engine
  tagline: Build Knowledge Graphs from Source Code — Let AI Agents Understand Your Entire Codebase
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: MCP Tools
      link: /mcp/tools
    - theme: alt
      text: API Reference
      link: /api/

features:
  - title: Multi-Language Parsing
    details: Parses TypeScript, JavaScript, Python, Go, Java, and Rust via tree-sitter AST analysis. Extracts functions, classes, methods, interfaces, imports, exports, and call relationships.
  - title: Code Knowledge Graph
    details: Stores code as a property graph in Apache AGE (PostgreSQL) with Cypher queries. Nodes represent symbols, edges represent CALLS, IMPORTS, EXTENDS, IMPLEMENTS relationships.
  - title: MCP Integration (24 Tools)
    details: Exposes the full code graph to AI agents via Model Context Protocol. Tools for symbol search, impact analysis, execution tracing, community detection, architecture checks, and more.
  - title: Semantic & Keyword Search
    details: Full-text keyword search (BM25/tsvector), semantic vector search (pgvector embeddings), and hybrid mode. Regex grep across all indexed files.
  - title: Community Detection
    details: Auto-detects functional clusters using the Leiden algorithm (Traag et al. 2019) on call edges. Reveals the domain-driven module structure without documentation.
  - title: Cross-Repo Analysis
    details: Links multiple repositories via API call matching and shared types. Trace execution flows across frontend/backend boundaries.
---

<div class="vp-doc" style="max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem;">

## Built for Organizations with Multiple Repositories

Most codebases span multiple repositories — a frontend, a backend API, shared libraries, microservices. Understanding how they connect is critical for code reviews, refactoring, and onboarding.

NexGraph indexes each repository into its own code knowledge graph, then **connects them together** using cross-repo resolution. This lets AI agents trace execution flows across repository boundaries — for example, from a frontend HTTP call all the way to the backend handler and its database queries.

<img src="/example.png" alt="NexGraph cross-repo visualization showing two connected repositories with communities and cross-repo call edges" style="border-radius: 8px; margin: 1.5rem 0; width: 100%;" />

### How It Works

1. **Create a project** — group related repositories (frontend, backend, shared libs)
2. **Index each repo** — NexGraph parses source code into a knowledge graph (functions, classes, imports, calls, inheritance)
3. **Connect repos** — define cross-repo rules (API URL matching, shared types) to link frontend calls to backend handlers
4. **Query via MCP** — AI agents use 24 tools to search, trace, and analyze the full codebase — across all repos

### Key Capabilities

- **Cross-repo tracing** — trace a button click in the frontend through the API call to the backend handler and its database query
- **Impact analysis** — change a backend function, see every frontend caller that is affected
- **Community detection** — auto-discover functional clusters (auth, payments, users) using the Leiden algorithm
- **Architecture checks** — define layer rules, find violations across the entire codebase
- **Multi-language support** — TypeScript, JavaScript, Python, Java, Go, Rust — with full call graph extraction for all six

</div>
