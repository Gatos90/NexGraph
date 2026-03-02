import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createChildLogger } from "../logger.js";
import { NexGraphApiClient, ApiError } from "./api-client.js";
import type { RepoInfo } from "./api-client.js";

const log = createChildLogger("mcp-tools");

// ---- Helpers ----

type McpContent = { content: Array<{ type: "text"; text: string }> };

function jsonResponse(data: unknown): McpContent {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResponse(message: string): McpContent {
  return jsonResponse({ error: message });
}

function noRepoError(): McpContent {
  return errorResponse("No indexed repositories found");
}

function repoRequiredError(repos: RepoInfo[]): McpContent {
  return jsonResponse({
    error:
      "Multiple repositories found. Please specify a 'repo' parameter.",
    available_repos: repos.map((r) => r.name),
  });
}

function noGraphError(repoName: string): McpContent {
  return errorResponse(
    `Repository '${repoName}' has no graph — index it first`,
  );
}

/** Resolve repo context. Returns { repo, allRepos, isMultiRepo } or null if no repos. */
async function resolveRepoContext(
  client: NexGraphApiClient,
  repoName?: string,
): Promise<{
  repo: RepoInfo | null;
  allRepos: RepoInfo[];
  isMultiRepo: boolean;
} | null> {
  const allRepos = await client.getAllRepos();
  const indexed = allRepos.filter((r) => r.graph_name);

  if (repoName) {
    const repo = allRepos.find((r) => r.name === repoName) ?? null;
    if (!repo) return null;
    return { repo, allRepos: indexed, isMultiRepo: indexed.length > 1 };
  }

  if (indexed.length === 0) return null;
  if (indexed.length === 1) {
    return { repo: indexed[0], allRepos: indexed, isMultiRepo: false };
  }
  return { repo: null, allRepos: indexed, isMultiRepo: true };
}

/** Wrap an async API call, returning an MCP error response on ApiError */
async function withErrorHandling(
  fn: () => Promise<McpContent>,
  toolName: string,
  meta?: Record<string, unknown>,
): Promise<McpContent> {
  try {
    return await fn();
  } catch (err: unknown) {
    const message =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : `${toolName} failed`;
    log.warn({ ...meta, err }, `MCP ${toolName} tool failed`);
    return errorResponse(message);
  }
}

// ---- Tool Registration ----

export function registerTools(
  server: McpServer,
  projectId: string,
  client: NexGraphApiClient,
): void {
  log.info({ projectId }, "Registering MCP tools");

  // ─── query ──────────────────────────────────────────────────
  server.tool(
    "query",
    'Search symbols (functions, classes, methods, interfaces) by name across the code graph. Use this as your first step when you know a symbol name (or part of it) and need to find where it\'s defined, what type it is, and which file it lives in. Returns matching symbols with labels, file paths, and properties. Supports substring matching — e.g., \'login\' finds \'postLogin\', \'loginHandler\', etc.\n\nExample: {"keyword": "login"}',
    {
      keyword: z.string().describe("Keyword to search for in symbol names"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; omit to search all repos.",
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Filter by node label (e.g., Function, Class, Interface, Method)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of results to return"),
    },
    async ({ keyword, repo, label, limit }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();

          const reposToSearch = ctx.repo
            ? [ctx.repo]
            : ctx.allRepos.filter((r) => r.graph_name);

          const allNodes: unknown[] = [];

          for (const repoRow of reposToSearch) {
            const perRepoLimit = ctx.isMultiRepo
              ? Math.ceil(limit / reposToSearch.length)
              : limit;
            try {
              const result = await client.listNodes(repoRow.id, {
                name: keyword,
                label,
                limit: perRepoLimit,
              });
              for (const node of result.nodes) {
                allNodes.push(
                  ctx.isMultiRepo
                    ? { ...(node as Record<string, unknown>), repo: repoRow.name }
                    : node,
                );
              }
            } catch (err) {
              log.warn(
                { repo: repoRow.name, keyword, err },
                "MCP query tool failed for repo",
              );
            }
          }

          const symbols = allNodes.slice(0, limit);

          return jsonResponse({
            symbols,
            count: symbols.length,
            ...(ctx.isMultiRepo
              ? { repos_searched: reposToSearch.map((r) => r.name) }
              : { repo: reposToSearch[0]?.name }),
          });
        },
        "query",
        { keyword, repo },
      );
    },
  );

  // ─── context ────────────────────────────────────────────────
  server.tool(
    "context",
    'Get the full relationship map for a symbol — who calls it, what it calls, what it imports/exports, what it extends/implements, and any cross-repo links. Use this when you need to understand a function\'s role in the codebase before modifying it. Essential for answering \'what does this function interact with?\' without reading every file.\n\nExample: {"symbol": "handleRequest"}',
    {
      symbol: z.string().describe("The symbol name to get context for"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; omit to auto-detect.",
        ),
    },
    async ({ symbol, repo }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();

          // Resolve the repo containing this symbol
          let repoRow: RepoInfo;
          if (ctx.repo) {
            repoRow = ctx.repo;
            if (!repoRow.graph_name) return noGraphError(repoRow.name);
          } else {
            // Multi-repo: search all repos for the symbol
            const matches: Array<{
              repo: RepoInfo;
              nodes: unknown[];
            }> = [];
            for (const r of ctx.allRepos) {
              if (!r.graph_name) continue;
              try {
                const result = await client.listNodes(r.id, {
                  name: symbol,
                  limit: 1,
                });
                if (result.nodes.length > 0) {
                  matches.push({ repo: r, nodes: result.nodes });
                }
              } catch {
                // skip repos that fail
              }
            }
            if (matches.length === 0) {
              return jsonResponse({
                error: `Symbol '${symbol}' not found in any repository`,
                repos_searched: ctx.allRepos.map((r) => r.name),
              });
            }
            if (matches.length > 1) {
              return jsonResponse({
                error: `Symbol '${symbol}' found in multiple repositories. Please specify a 'repo' parameter.`,
                found_in: matches.map((m) => m.repo.name),
              });
            }
            repoRow = matches[0].repo;
          }

          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          // Find the node via listNodes, then get detail
          const searchResult = await client.listNodes(repoRow.id, {
            name: symbol,
            limit: 1,
          });
          if (searchResult.nodes.length === 0) {
            return errorResponse(`Symbol '${symbol}' not found in graph`);
          }

          const node = searchResult.nodes[0] as Record<string, unknown>;
          const nodeId = String(node.id ?? node.node_id ?? "");
          if (!nodeId) {
            return errorResponse(
              `Symbol '${symbol}' found but has no ID for detail lookup`,
            );
          }

          const detail = await client.getNodeDetail(repoRow.id, nodeId);
          return jsonResponse({
            symbol: { ...(detail.node as Record<string, unknown>), repo: repoRow.name },
            ...detail.relationships,
          });
        },
        "context",
        { symbol, repo },
      );
    },
  );

  // ─── impact ─────────────────────────────────────────────────
  server.tool(
    "impact",
    'Analyze the blast radius of changing a symbol — find every function, class, or method that would be affected. Use BEFORE refactoring or modifying a function to know exactly which call sites, subclasses, and implementations need updating. Direction \'callers\' = who depends on this (upstream), \'callees\' = what this depends on (downstream). Traverses CALLS, EXTENDS, and IMPLEMENTS edges.\n\nExample: {"symbol": "UserService"}',
    {
      symbol: z.string().describe("The symbol name to analyze impact for"),
      direction: z
        .enum(["callers", "callees", "both"])
        .default("both")
        .describe(
          "Direction of traversal: 'callers' (who depends on this), 'callees' (what this depends on), or 'both'",
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("Maximum traversal depth"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; required when multiple repos exist.",
        ),
      include_cross_repo: z
        .boolean()
        .default(false)
        .describe(
          "When true, automatically follows cross-repo edges to trace impact across repository boundaries",
        ),
      include_members: z
        .boolean()
        .default(true)
        .describe(
          "When root is a Class or Interface, include its member methods as traversal starting points",
        ),
    },
    async ({
      symbol,
      direction,
      depth,
      repo,
      include_cross_repo,
      // include_members is accepted for schema compat but handled server-side
    }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          const result = await client.analyzeImpact(repoRow.id, {
            symbol,
            direction,
            depth,
            include_cross_repo,
          });

          return jsonResponse(result);
        },
        "impact",
        { symbol, repo },
      );
    },
  );

  // ─── trace ──────────────────────────────────────────────────
  server.tool(
    "trace",
    'Trace an execution flow end-to-end starting from any function. Use this to understand the full call chain — e.g., starting from an API handler, trace forward to see every function it calls (DB queries, services, helpers). Direction \'forward\' = downstream callees, \'backward\' = upstream callers. Automatically follows cross-repo edges (e.g., frontend → backend API calls).\n\nExample: {"start_symbol": "loginHandler"}',
    {
      start_symbol: z
        .string()
        .describe("The starting symbol name for the trace"),
      start_repo: z
        .string()
        .optional()
        .describe(
          "Repository name containing the starting symbol. Optional when project has one repo.",
        ),
      direction: z
        .enum(["forward", "backward", "both"])
        .default("forward")
        .describe(
          "Trace direction: 'forward' (callees/downstream), 'backward' (callers/upstream), or 'both'",
        ),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("Maximum traversal depth"),
      include_cross_repo: z
        .boolean()
        .default(true)
        .describe(
          "When true, automatically follows cross-repo edges to trace flows across repository boundaries",
        ),
    },
    async ({
      start_symbol,
      start_repo,
      direction,
      max_depth,
      // include_cross_repo is accepted for schema compat; the API always traces cross-repo
    }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, start_repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const startRepoRow = ctx.repo;
          if (!startRepoRow.graph_name)
            return noGraphError(startRepoRow.name);

          const result = await client.crossRepoTrace({
            start_repo_id: startRepoRow.id,
            start_symbol,
            direction,
            max_depth,
          });

          return jsonResponse(result);
        },
        "trace",
        { start_symbol, start_repo },
      );
    },
  );

  // ─── cypher ────────────────────────────────────────────────
  server.tool(
    "cypher",
    'Execute a raw Cypher query against the code graph for advanced analysis not covered by other tools. The graph uses Apache AGE (PostgreSQL). Node labels: Function, Class, Method, Interface, Variable, TypeAlias, File, RouteHandler. Edge types: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, EXPORTS.\n\nExample: {"cypher": "MATCH (n:Function) RETURN n.name LIMIT 5"}',
    {
      cypher: z
        .string()
        .min(1)
        .max(10000)
        .describe("Cypher query to execute (must not contain $$)"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; required when multiple repos exist.",
        ),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Optional parameter map. Reference in Cypher as $key."),
      columns: z
        .array(z.object({ name: z.string().min(1).max(128) }))
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Column definitions for the result set. Defaults to a single 'result' column.",
        ),
    },
    async ({ cypher: cypherQuery, repo, params: cypherParams, columns }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          const result = await client.executeCypher(repoRow.id, {
            query: cypherQuery,
            params:
              cypherParams && Object.keys(cypherParams).length > 0
                ? cypherParams
                : undefined,
            columns: columns ?? [{ name: "result" }],
          });

          return jsonResponse(result);
        },
        "cypher",
        { repo, cypher: cypherQuery },
      );
    },
  );

  // ─── routes ───────────────────────────────────────────────
  server.tool(
    "routes",
    'List all HTTP API endpoints (Express/Fastify/Hono route handlers) detected in the codebase. Use this to discover the API surface — what endpoints exist, their HTTP methods, and URL patterns. Filter by method (GET, POST) or URL substring (/users, /auth). Essential when adding new endpoints, understanding API structure, or finding where a request is handled.\n\nExample: {} or {"method": "POST", "url_pattern": "/users"}',
    {
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; omit to search all repos.",
        ),
      method: z
        .string()
        .optional()
        .describe("Filter by HTTP method (e.g., GET, POST, PUT, DELETE)"),
      url_pattern: z
        .string()
        .optional()
        .describe(
          "Filter by URL pattern substring (e.g., /users, /api)",
        ),
    },
    async ({ repo, method, url_pattern }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();

          const reposToSearch = ctx.repo
            ? [ctx.repo]
            : ctx.allRepos.filter((r) => r.graph_name);

          let allRoutes: Array<Record<string, unknown>> = [];

          for (const repoRow of reposToSearch) {
            try {
              const result = await client.getRoutes(repoRow.id);
              for (const route of result.routes) {
                allRoutes.push(
                  ctx.isMultiRepo
                    ? {
                        ...(route as Record<string, unknown>),
                        repo: repoRow.name,
                      }
                    : (route as Record<string, unknown>),
                );
              }
            } catch (err) {
              log.warn(
                { repo: repoRow.name, err },
                "MCP routes tool failed for repo",
              );
            }
          }

          // Apply client-side filters
          if (method) {
            const normalizedMethod = method.trim().toUpperCase();
            allRoutes = allRoutes.filter(
              (r) =>
                String(r.http_method ?? "")
                  .trim()
                  .toUpperCase() === normalizedMethod,
            );
          }
          if (url_pattern) {
            const needle = url_pattern.trim().toLowerCase();
            allRoutes = allRoutes.filter((r) =>
              String(r.url_pattern ?? "")
                .toLowerCase()
                .includes(needle),
            );
          }

          // Sort by URL pattern then method
          allRoutes.sort(
            (a, b) =>
              String(a.url_pattern ?? "").localeCompare(
                String(b.url_pattern ?? ""),
              ) ||
              String(a.http_method ?? "").localeCompare(
                String(b.http_method ?? ""),
              ),
          );

          return jsonResponse({
            routes: allRoutes,
            count: allRoutes.length,
            ...(ctx.isMultiRepo
              ? { repos_searched: reposToSearch.map((r) => r.name) }
              : { repo: reposToSearch[0]?.name }),
          });
        },
        "routes",
        { repo },
      );
    },
  );

  // ─── dependencies ─────────────────────────────────────────
  server.tool(
    "dependencies",
    'Get the full import/dependency tree for a file — what it imports and what imports it. Use this before modifying a file to understand its dependency context: which modules provide its database layer, utilities, types, etc., and which files would be affected if you change its exports. Set depth > 1 to see transitive dependencies.\n\nExample: {"file_path": "src/auth/login.ts"}',
    {
      file_path: z
        .string()
        .describe(
          "The file path (relative to repository root) to analyze",
        ),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; required when multiple repos exist.",
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(1)
        .describe("Maximum traversal depth for dependencies"),
    },
    async ({ file_path, repo, depth }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          const result = await client.getDependencies(repoRow.id, {
            file_path,
            depth,
          });

          return jsonResponse(result);
        },
        "dependencies",
        { file_path, repo },
      );
    },
  );

  // ─── search ───────────────────────────────────────────────
  server.tool(
    "search",
    'Search across all indexed file contents by keyword, semantic meaning, or both. Mode \'keyword\' = fast BM25 full-text search (best for exact terms like function names, error messages). Mode \'semantic\' = vector similarity search (best for conceptual queries like \'authentication logic\' or \'database connection handling\'). Mode \'hybrid\' = combines both for best results. Searches all repos when repo is omitted.\n\nExample: {"keyword": "authentication"}',
    {
      keyword: z
        .string()
        .min(1)
        .max(1000)
        .describe("Keyword(s) to search for"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional; omit to search all repositories.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of results to return"),
      mode: z
        .enum(["keyword", "semantic", "hybrid"])
        .default("keyword")
        .describe(
          "Search mode: 'keyword' (BM25 tsvector), 'semantic' (vector cosine similarity), or 'hybrid' (RRF fusion of both)",
        ),
    },
    async ({ keyword, repo, limit, mode }) => {
      return withErrorHandling(
        async () => {
          if (repo) {
            // Search within a specific repo
            const repoInfo = await client.resolveRepo(repo);
            if (!repoInfo)
              return errorResponse("Repository not found");

            const result = await client.search(repoInfo.id, {
              query: keyword,
              limit,
              mode,
            });
            return jsonResponse(result);
          }

          // Multi-repo: use project-level search
          const result = await client.projectSearch({
            query: keyword,
            limit,
            mode,
          });
          return jsonResponse(result);
        },
        "search",
        { keyword, repo, mode },
      );
    },
  );

  // ─── grep ────────────────────────────────────────────────
  server.tool(
    "grep",
    'Regex pattern search across all indexed file contents. Returns matching lines with surrounding context, line numbers, and file paths — like ripgrep but over the indexed codebase. Use for precise pattern matching (e.g., \'TODO|FIXME\', \'import.*from.*auth\', \'console\\\\.log\'). Use file_glob to narrow to specific file types (e.g., \'*.ts\', \'src/controllers/**\').\n\nExample: {"pattern": "TODO|FIXME"}',
    {
      pattern: z
        .string()
        .min(1)
        .max(1000)
        .describe("Regular expression pattern to search for"),
      file_glob: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Optional file glob pattern to filter files (e.g., '*.ts', 'src/**/*.js'). Uses SQL LIKE with * \u2192 % and ? \u2192 _ conversion.",
        ),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional; omit to search all repositories.",
        ),
      case_sensitive: z
        .boolean()
        .default(true)
        .describe("Whether the search is case-sensitive"),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(2)
        .describe(
          "Number of context lines before/after each match",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of match results to return"),
    },
    async ({
      pattern,
      file_glob,
      repo,
      case_sensitive,
      context_lines,
      limit,
    }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();

          const reposToSearch = ctx.repo ? [ctx.repo] : ctx.allRepos;
          const allResults: unknown[] = [];

          for (const repoRow of reposToSearch) {
            try {
              const result = await client.grep(repoRow.id, {
                pattern,
                case_sensitive,
                context_lines,
                limit: limit - allResults.length,
                file_pattern: file_glob,
              });

              // The API returns results — merge them, tagging with repo if multi-repo
              const repoResult = result as Record<string, unknown>;
              if (Array.isArray(repoResult.matches)) {
                for (const match of repoResult.matches) {
                  if (allResults.length >= limit) break;
                  allResults.push(
                    ctx.isMultiRepo
                      ? {
                          ...(match as Record<string, unknown>),
                          repo: repoRow.name,
                        }
                      : match,
                  );
                }
              }
            } catch (err) {
              log.warn(
                { repo: repoRow.name, pattern, err },
                "MCP grep tool failed for repo",
              );
            }
            if (allResults.length >= limit) break;
          }

          return jsonResponse({
            matches: allResults,
            total_matches: allResults.length,
            ...(ctx.isMultiRepo
              ? { repos_searched: reposToSearch.map((r) => r.name) }
              : { repo: reposToSearch[0]?.name }),
          });
        },
        "grep",
        { pattern, repo },
      );
    },
  );

  // ─── read_file ─────────────────────────────────────────
  server.tool(
    "read_file",
    'Read source code from an indexed file. Returns the file content, detected language, line count, and all symbols (functions, classes, methods) defined in that file with their line positions. Use start_line/end_line to read a specific range for large files. Unlike a raw file read, this also gives you the graph symbols defined in the file so you know what\'s available to analyze further.\n\nExample: {"path": "src/index.ts"}',
    {
      path: z
        .string()
        .min(1)
        .describe("File path relative to repository root"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; omit to auto-detect which repo contains the file.",
        ),
      start_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Start line number (1-based, inclusive). Omit to start from the beginning.",
        ),
      end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "End line number (1-based, inclusive). Omit to read to the end.",
        ),
    },
    async ({ path: filePath, repo, start_line, end_line }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();

          let repoRow: RepoInfo;
          if (ctx.repo) {
            repoRow = ctx.repo;
          } else {
            // Multi-repo: search all repos for this file path
            const matches: RepoInfo[] = [];
            for (const r of ctx.allRepos) {
              try {
                await client.readFile(r.id, filePath);
                matches.push(r);
              } catch {
                // File not found in this repo
              }
            }
            if (matches.length === 0) {
              return jsonResponse({
                error: `File '${filePath}' not found in any repository`,
                repos_searched: ctx.allRepos.map((r) => r.name),
              });
            }
            if (matches.length > 1) {
              return jsonResponse({
                error: `File '${filePath}' found in multiple repositories. Please specify a 'repo' parameter.`,
                found_in: matches.map((r) => r.name),
              });
            }
            repoRow = matches[0];
          }

          const result = await client.readFile(repoRow.id, filePath, {
            start_line,
            end_line,
          });

          return jsonResponse(result);
        },
        "read_file",
        { path: filePath, repo },
      );
    },
  );

  // ─── graph_stats ───────────────────────────────────────
  server.tool(
    "graph_stats",
    'Get a high-level overview of the codebase: total files, node/edge counts by type (functions, classes, methods, CALLS, IMPORTS), detected languages, and indexing status. Use this as your FIRST call to understand the scale and tech stack of a project before diving in. Returns stats per repo when repo is omitted.\n\nExample: {}',
    {
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional; omit to get stats for all repos.",
        ),
    },
    async ({ repo }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();

          const reposToQuery = ctx.repo ? [ctx.repo] : ctx.allRepos;
          const repoStatsList: unknown[] = [];

          for (const repoRow of reposToQuery) {
            try {
              const stats = await client.getGraphStats(repoRow.id, true);
              repoStatsList.push(stats);
            } catch (err) {
              log.warn(
                { repo: repoRow.name, err },
                "MCP graph_stats tool failed for repo",
              );
            }
          }

          // Single repo: return flat; multi-repo: return array with aggregate
          if (!ctx.isMultiRepo || repoStatsList.length === 1) {
            return jsonResponse(repoStatsList[0]);
          }

          return jsonResponse({
            repos: repoStatsList,
            aggregate: {
              total_repos: repoStatsList.length,
            },
          });
        },
        "graph_stats",
        { repo },
      );
    },
  );

  // ─── cross_repo_connections ────────────────────────────
  server.tool(
    "cross_repo_connections",
    'Show how repositories in a project are linked together — e.g., frontend calling backend API endpoints, shared type definitions between repos. Returns connection rules and resolved edge counts (CROSS_REPO_CALLS, CROSS_REPO_MIRRORS). Use this to understand cross-repo dependencies before making changes that might break consumers in other repos.\n\nExample: {}',
    {
      repo: z
        .string()
        .optional()
        .describe(
          "Any repository name in the project. Optional when project has one repo.",
        ),
    },
    async ({ repo }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();

          const [connections, crossRepoStats] = await Promise.all([
            client.listConnections(),
            client.getCrossRepoStats(),
          ]);

          return jsonResponse({
            connections,
            cross_repo_stats: crossRepoStats,
          });
        },
        "cross_repo_connections",
        { repo },
      );
    },
  );

  // ─── architecture_check ──────────────────────────────────────
  server.tool(
    "architecture_check",
    'Check for architectural layer violations — find places where code breaks intended dependency rules (e.g., \'domain layer must not import from infrastructure\'). Define layers by file glob patterns and forbidden dependency rules. Returns specific violations with file paths and function names. Use during code review or before adding new imports to ensure clean architecture.\n\nExample: {}',
    {
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Required when multiple repos exist.",
        ),
      layers: z
        .record(z.string())
        .optional()
        .describe(
          'Layer definitions mapping layer name to glob pattern. Example: { "controllers": "src/controllers/**", "services": "src/services/**" }',
        ),
      rules: z
        .array(
          z.object({
            from: z.string().describe("Source layer name"),
            deny: z
              .array(z.string())
              .describe(
                "Layer names that the source layer must not depend on",
              ),
          }),
        )
        .optional()
        .describe(
          'Deny rules. Example: [{ "from": "domain", "deny": ["infrastructure"] }]',
        ),
      edge_types: z
        .array(z.enum(["IMPORTS", "CALLS"]))
        .default(["IMPORTS", "CALLS"])
        .describe("Which edge types to check for violations"),
    },
    async ({ repo, layers, rules, edge_types }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          const result = await client.checkArchitecture(repoRow.id, {
            layers,
            rules,
            edge_types,
          });

          return jsonResponse(result);
        },
        "architecture_check",
        { repo },
      );
    },
  );

  // ─── communities ──────────────────────────────────────────────
  server.tool(
    "communities",
    'Discover the domain-driven module structure of the codebase. Communities are auto-detected clusters of related symbols (grouped by call patterns using the Louvain algorithm). Each community has a heuristic label, keywords, cohesion score, and member count. Use this to understand which parts of the codebase belong together — e.g., \'authentication\', \'delivery-notes\', \'user-management\'. Fetch a specific community_id to see all its member symbols.\n\nExample: {}',
    {
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; required when multiple repos exist.",
        ),
      community_id: z
        .string()
        .optional()
        .describe(
          "Specific community_id to fetch (returns full member list). Omit to list all communities.",
        ),
      include_members: z
        .boolean()
        .default(false)
        .describe(
          "Include member symbols in the response (default false)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of communities to return"),
    },
    async ({ repo, community_id, limit }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          if (community_id) {
            const result = await client.getCommunityDetail(
              repoRow.id,
              community_id,
            );
            return jsonResponse(result);
          }

          const result = await client.listCommunities(repoRow.id, {
            limit,
          });
          return jsonResponse(result);
        },
        "communities",
        { repo, community_id },
      );
    },
  );

  // ─── processes ──────────────────────────────────────────────────
  server.tool(
    "processes",
    'List the critical execution paths detected in the codebase — multi-step flows from entry points to terminal functions. Each process shows the entry function, terminal function, step count, and whether it stays within one community or crosses boundaries. Use this to understand the most important execution flows (e.g., \'login request → auth check → DB query → response\'). Fetch a specific process_id to see the full ordered step sequence.\n\nExample: {}',
    {
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; required when multiple repos exist.",
        ),
      process_id: z
        .string()
        .optional()
        .describe(
          "Specific process_id to fetch (returns full step sequence). Omit to list all processes.",
        ),
      process_type: z
        .enum(["intra_community", "cross_community"])
        .optional()
        .describe("Filter by process type"),
      include_steps: z
        .boolean()
        .default(false)
        .describe(
          "Include ordered symbol sequence in results (default false)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of processes to return"),
    },
    async ({ repo, process_id, process_type, limit }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          if (process_id) {
            const result = await client.getProcessDetail(
              repoRow.id,
              process_id,
            );
            return jsonResponse(result);
          }

          const result = await client.listProcesses(repoRow.id, {
            limit,
            type: process_type,
          });
          return jsonResponse(result);
        },
        "processes",
        { repo, process_id },
      );
    },
  );

  // ─── rename ──────────────────────────────────────────────────
  server.tool(
    "rename",
    'Safely rename a symbol across all files — finds every reference via the code graph (definitions, call sites, imports, type references, overrides) with confidence scores per edit. Always use dry_run=true first to preview changes before applying. Much more reliable than regex find-replace because it uses graph edges to find actual references, not just string matches.\n\nExample: {"symbol": "oldName", "new_name": "newName", "dry_run": true}',
    {
      symbol: z.string().min(1).describe("The symbol name to rename"),
      new_name: z
        .string()
        .min(1)
        .describe("The new name for the symbol"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; required when multiple repos exist.",
        ),
      file_path: z
        .string()
        .optional()
        .describe(
          "Filter to a specific file path to disambiguate when multiple symbols share the same name.",
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Filter by node label (e.g., Function, Class, Method) to disambiguate.",
        ),
      dry_run: z
        .boolean()
        .default(true)
        .describe(
          "If true (default), returns edits without modifying any files. Set to false to apply edits.",
        ),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .default(0.8)
        .describe(
          "Minimum confidence threshold for edits (0-1). Edits below this are skipped with a warning.",
        ),
    },
    async ({
      symbol,
      new_name,
      repo,
      file_path,
      label,
      dry_run,
      min_confidence,
    }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          const result = await client.renameSymbol(repoRow.id, {
            symbol,
            new_name,
            file_path,
            label,
            dry_run,
            min_confidence,
          });

          return jsonResponse(result);
        },
        "rename",
        { symbol, new_name, repo },
      );
    },
  );

  // ─── detect_changes ─────────────────────────────────────────
  server.tool(
    "detect_changes",
    'Analyze uncommitted git changes: maps modified lines to affected symbols, traces their impact through the call graph, and assesses risk level. Use this for pre-commit review or PR analysis — it tells you not just what changed, but what else in the codebase is affected by those changes. Scope: \'all\' (working tree vs HEAD), \'staged\', \'unstaged\', or \'compare\' (against a specific ref like \'main\').\n\nExample: {"repo": "my-app"}',
    {
      repo: z
        .string()
        .describe(
          "Repository name (required). The repository must be a local_path type.",
        ),
      scope: z
        .enum(["unstaged", "staged", "all", "compare"])
        .default("all")
        .describe(
          "Diff scope: 'unstaged' (working tree vs index), 'staged' (index vs HEAD), 'all' (working tree vs HEAD), 'compare' (compare_ref..HEAD)",
        ),
      compare_ref: z
        .string()
        .optional()
        .describe(
          "Git ref to compare against HEAD (required when scope is 'compare'). Example: 'main', 'v1.0', 'abc123'.",
        ),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe(
          "Maximum depth for indirect impact tracing through CALLS edges (default 3).",
        ),
    },
    async ({ repo, scope, compare_ref, max_depth }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          const result = await client.diffImpact(repoRow.id, {
            scope,
            compare_ref,
            max_depth,
          });

          return jsonResponse(result);
        },
        "detect_changes",
        { repo, scope },
      );
    },
  );

  // ═══════════════════════════════════════════════════════════
  // New Tools
  // ═══════════════════════════════════════════════════════════

  // ─── orphans ──────────────────────────────────────────────
  server.tool(
    "orphans",
    'Find dead code — symbols (functions, classes, methods) that have no incoming edges, meaning nothing in the codebase calls or references them. Use this for code cleanup: identify unused functions that can be safely removed, unexported classes that are never instantiated, or leftover code from deleted features.\n\nExample: {}',
    {
      repo: z
        .string()
        .optional()
        .describe(
          "Repository name. Optional when project has one repo; required when multiple repos exist.",
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Filter by node label (e.g., Function, Class, Interface, Method)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of results to return"),
    },
    async ({ repo, label, limit }) => {
      return withErrorHandling(
        async () => {
          const ctx = await resolveRepoContext(client, repo);
          if (!ctx) return noRepoError();
          if (!ctx.repo) return repoRequiredError(ctx.allRepos);
          const repoRow = ctx.repo;
          if (!repoRow.graph_name) return noGraphError(repoRow.name);

          const result = await client.getOrphans(repoRow.id, {
            label,
            limit,
          });

          return jsonResponse(result);
        },
        "orphans",
        { repo, label },
      );
    },
  );

  // ─── edges ────────────────────────────────────────────────
  server.tool(
    "edges",
    'List relationships between symbols in the code graph, filtered by type and source. Edge types: CALLS (function invocations), IMPORTS (file-level imports), EXTENDS (class inheritance), IMPLEMENTS (interface implementations), DEFINES (file → symbol), EXPORTS (module exports). Use for coupling analysis — e.g., list all CALLS from Function nodes to see the busiest callers.\n\nExample: {"repo": "my-app", "edge_type": "CALLS"}',
    {
      repo: z
        .string()
        .describe("Repository name."),
      edge_type: z
        .string()
        .optional()
        .describe(
          "Filter by edge type (e.g., CALLS, IMPORTS, EXTENDS, IMPLEMENTS)",
        ),
      source_label: z
        .string()
        .optional()
        .describe(
          "Filter by source node label (e.g., Function, Class, Method)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of results to return"),
    },
    async ({ repo, edge_type, source_label, limit }) => {
      return withErrorHandling(
        async () => {
          const repoInfo = await client.resolveRepo(repo);
          if (!repoInfo) return errorResponse("Repository not found");
          if (!repoInfo.graph_name) return noGraphError(repoInfo.name);

          const result = await client.listEdges(repoInfo.id, {
            type: edge_type,
            source_label,
            limit,
          });

          return jsonResponse(result);
        },
        "edges",
        { repo, edge_type },
      );
    },
  );

  // ─── path ─────────────────────────────────────────────────
  server.tool(
    "path",
    'Find the shortest connection path between two symbols in the code graph. Use this to understand how two seemingly unrelated functions are connected — e.g., how does \'loginHandler\' eventually reach \'sendEmail\'? Returns the chain of intermediate symbols and edges. Useful for understanding coupling and for planning refactoring boundaries.\n\nExample: {"repo": "my-app", "from_symbol": "login", "to_symbol": "sendEmail"}',
    {
      repo: z.string().describe("Repository name."),
      from_symbol: z
        .string()
        .describe("Starting symbol name"),
      to_symbol: z
        .string()
        .describe("Target symbol name"),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum traversal depth"),
      from_file_path: z
        .string()
        .optional()
        .describe(
          "File path to disambiguate the starting symbol",
        ),
      to_file_path: z
        .string()
        .optional()
        .describe(
          "File path to disambiguate the target symbol",
        ),
    },
    async ({
      repo,
      from_symbol,
      to_symbol,
      max_depth,
      from_file_path,
      to_file_path,
    }) => {
      return withErrorHandling(
        async () => {
          const repoInfo = await client.resolveRepo(repo);
          if (!repoInfo) return errorResponse("Repository not found");
          if (!repoInfo.graph_name) return noGraphError(repoInfo.name);

          const result = await client.findPath(repoInfo.id, {
            from: from_symbol,
            to: to_symbol,
            max_depth,
            from_file_path,
            to_file_path,
          });

          return jsonResponse(result);
        },
        "path",
        { repo, from_symbol, to_symbol },
      );
    },
  );

  // ─── git_history ──────────────────────────────────────────
  server.tool(
    "git_history",
    'Get git history stats per file: authors, commit counts, and last modification dates. Use this to find code hotspots (frequently changed files = higher risk), identify domain experts (who authored/modified a file most), and assess code freshness (stale files may need updating). Filter by file_path for a specific file\'s history.\n\nExample: {"repo": "my-app"}',
    {
      repo: z.string().describe("Repository name."),
      file_path: z
        .string()
        .optional()
        .describe(
          "Filter by file path to get history for a specific file",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of results to return"),
    },
    async ({ repo, file_path, limit }) => {
      return withErrorHandling(
        async () => {
          const repoInfo = await client.resolveRepo(repo);
          if (!repoInfo) return errorResponse("Repository not found");

          const result = await client.getGitHistory(repoInfo.id, {
            file_path,
            limit,
          });

          return jsonResponse(result);
        },
        "git_history",
        { repo, file_path },
      );
    },
  );

  // ─── git_timeline ─────────────────────────────────────────
  server.tool(
    "git_timeline",
    'Get the chronological commit timeline showing which files changed together in each commit. Use this to understand co-change patterns — files that frequently change together are likely coupled, even if they don\'t directly import each other. Filter by date range with \'since\' and \'until\' parameters.\n\nExample: {"repo": "my-app"}',
    {
      repo: z.string().describe("Repository name."),
      since: z
        .string()
        .optional()
        .describe(
          "Start date filter (ISO format, e.g., '2024-01-01')",
        ),
      until: z
        .string()
        .optional()
        .describe(
          "End date filter (ISO format, e.g., '2024-12-31')",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of results to return"),
    },
    async ({ repo, since, until, limit }) => {
      return withErrorHandling(
        async () => {
          const repoInfo = await client.resolveRepo(repo);
          if (!repoInfo) return errorResponse("Repository not found");

          const result = await client.getGitTimeline(repoInfo.id, {
            since,
            until,
            limit,
          });

          return jsonResponse(result);
        },
        "git_timeline",
        { repo },
      );
    },
  );

  // ─── nodes ────────────────────────────────────────────────
  server.tool(
    "nodes",
    'List all symbols in the code graph with powerful filtering. Filter by label (Function, Class, Method, Interface, TypeAlias, Variable), file_path, or exported status. Use this to explore a file\'s symbols, find all exported functions, or paginate through all classes in the codebase. Returns symbol metadata including name, file path, line numbers, and properties.\n\nExample: {"repo": "my-app", "label": "Function"}',
    {
      repo: z.string().describe("Repository name."),
      label: z
        .string()
        .optional()
        .describe(
          "Filter by node label (e.g., Function, Class, Interface, Method)",
        ),
      file_path: z
        .string()
        .optional()
        .describe("Filter by file path"),
      exported: z
        .boolean()
        .optional()
        .describe("Filter by exported status"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of results to return"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Offset for pagination"),
    },
    async ({ repo, label, file_path, exported, limit, offset }) => {
      return withErrorHandling(
        async () => {
          const repoInfo = await client.resolveRepo(repo);
          if (!repoInfo) return errorResponse("Repository not found");
          if (!repoInfo.graph_name) return noGraphError(repoInfo.name);

          const result = await client.listNodes(repoInfo.id, {
            label,
            file_path,
            exported: exported !== undefined ? String(exported) : undefined,
            limit,
            offset,
          });

          return jsonResponse(result);
        },
        "nodes",
        { repo, label },
      );
    },
  );

  // ─── file_tree ────────────────────────────────────────────
  server.tool(
    "file_tree",
    'Browse the directory structure of a repository without reading file contents. Returns a hierarchical tree or flat file list with detected languages. Use this to understand project layout, discover where code lives (e.g., \'show me all TypeScript files under src/controllers\'), or navigate an unfamiliar codebase. Filter by path (subdirectory) and language.\n\nExample: {"repo": "my-app"}',
    {
      repo: z.string().describe("Repository name."),
      path: z
        .string()
        .optional()
        .describe(
          "Subdirectory path to start from (relative to repo root)",
        ),
      language: z
        .string()
        .optional()
        .describe("Filter by programming language"),
      flat: z
        .boolean()
        .optional()
        .describe(
          "If true, returns a flat list of files instead of a tree",
        ),
    },
    async ({ repo, path, language, flat }) => {
      return withErrorHandling(
        async () => {
          const repoInfo = await client.resolveRepo(repo);
          if (!repoInfo) return errorResponse("Repository not found");

          const result = await client.getFileTree(repoInfo.id, {
            path,
            language,
            flat: flat !== undefined ? String(flat) : undefined,
          });

          return jsonResponse(result);
        },
        "file_tree",
        { repo, path },
      );
    },
  );

  log.info(
    "MCP tools registered: query, context, impact, trace, cypher, routes, dependencies, search, grep, read_file, graph_stats, cross_repo_connections, architecture_check, communities, processes, rename, detect_changes, orphans, edges, path, git_history, git_timeline, nodes, file_tree",
  );
}
