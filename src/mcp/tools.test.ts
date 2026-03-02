/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NexGraphApiClient, RepoInfo } from "./api-client.js";

vi.mock("../config.js", () => ({
  config: {
    API_PREFIX: "/api/v1",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { registerTools } from "./tools.js";

// ---- Test helpers ----

type ToolHandler = (args: Record<string, any>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

interface MockMcpServer {
  tools: Map<string, { handler: ToolHandler }>;
  tool: ReturnType<typeof vi.fn>;
}

function createMockServer(): MockMcpServer {
  const tools = new Map<string, { handler: ToolHandler }>();
  return {
    tools,
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: ToolHandler,
      ) => {
        tools.set(name, { handler });
      },
    ),
  };
}

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
}) {
  return JSON.parse(result.content[0].text);
}

// ---- Mock client factory ----

function createMockClient() {
  return {
    getAllRepos: vi.fn(),
    resolveRepo: vi.fn(),
    invalidateRepoCache: vi.fn(),
    getGraphStats: vi.fn(),
    getOrphans: vi.fn(),
    getRoutes: vi.fn(),
    executeCypher: vi.fn(),
    listNodes: vi.fn(),
    getNodeDetail: vi.fn(),
    listEdges: vi.fn(),
    analyzeImpact: vi.fn(),
    getDependencies: vi.fn(),
    findPath: vi.fn(),
    checkArchitecture: vi.fn(),
    listCommunities: vi.fn(),
    getCommunityDetail: vi.fn(),
    listProcesses: vi.fn(),
    getProcessDetail: vi.fn(),
    diffImpact: vi.fn(),
    renameSymbol: vi.fn(),
    getGitHistory: vi.fn(),
    getGitTimeline: vi.fn(),
    search: vi.fn(),
    grep: vi.fn(),
    projectSearch: vi.fn(),
    getFileTree: vi.fn(),
    readFile: vi.fn(),
    crossRepoTrace: vi.fn(),
    crossRepoImpact: vi.fn(),
    getCrossRepoStats: vi.fn(),
    listConnections: vi.fn(),
  } as unknown as NexGraphApiClient;
}

type MockClient = ReturnType<typeof createMockClient>;

/** Cast mock client to get access to vi.fn() methods */
function m(client: MockClient) {
  return client as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

// ---- Fixtures ----

const REPO_ROW: RepoInfo = {
  id: "repo-1",
  name: "my-repo",
  project_id: "proj-1",
  graph_name: "repo_graph_1",
};

const REPO_ROW_2: RepoInfo = {
  id: "repo-2",
  name: "other-repo",
  project_id: "proj-1",
  graph_name: "repo_graph_2",
};

const REPO_NO_GRAPH: RepoInfo = {
  id: "repo-3",
  name: "no-graph-repo",
  project_id: "proj-1",
  graph_name: null,
};

function makeNode(
  id: number,
  label: string,
  props: Record<string, unknown> = {},
) {
  return {
    id,
    label,
    properties: {
      name: `symbol_${id}`,
      file_path: "src/index.ts",
      exported: true,
      line: 10,
      ...props,
    },
    // flatten for convenience in assertions
    name: props.name ?? `symbol_${id}`,
    file_path: props.file_path ?? "src/index.ts",
  };
}

// ---- Tests ----

describe("MCP Tools", () => {
  let server: MockMcpServer;
  let tools: Map<string, { handler: ToolHandler }>;
  let mockClient: MockClient;

  beforeEach(() => {
    server = createMockServer();
    mockClient = createMockClient();
    registerTools(server as any, "test-project-id", mockClient as any);
    tools = server.tools;
  });

  it("should register all 24 tools", () => {
    expect(tools.size).toBe(24);
    expect([...tools.keys()]).toEqual([
      "query",
      "context",
      "impact",
      "trace",
      "cypher",
      "routes",
      "dependencies",
      "search",
      "grep",
      "read_file",
      "graph_stats",
      "cross_repo_connections",
      "architecture_check",
      "communities",
      "processes",
      "rename",
      "detect_changes",
      "orphans",
      "edges",
      "path",
      "git_history",
      "git_timeline",
      "nodes",
      "file_tree",
    ]);
  });

  // ─── query ──────────────────────────────────────────────

  describe("query tool", () => {
    it("should search symbols by keyword in single repo", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [
          makeNode(1, "Function", { name: "handleRequest" }),
          makeNode(2, "Function", { name: "sendRequest" }),
        ],
        count: 2,
      });

      const handler = tools.get("query")!.handler;
      const result = await handler({ keyword: "Request", limit: 20 });
      const body = parseToolResult(result);

      expect(body.symbols).toHaveLength(2);
      expect(body.count).toBe(2);
      expect(body.repo).toBe("my-repo");
    });

    it("should return no repos error when no indexed repos", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([]);

      const handler = tools.get("query")!.handler;
      const result = await handler({ keyword: "test", limit: 20 });
      const body = parseToolResult(result);

      expect(body.error).toContain("No indexed repositories found");
    });

    it("should filter by label", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [makeNode(1, "Class", { name: "MyClass" })],
        count: 1,
      });

      const handler = tools.get("query")!.handler;
      const result = await handler({
        keyword: "My",
        label: "Class",
        limit: 20,
      });
      const body = parseToolResult(result);

      expect(body.symbols).toHaveLength(1);
    });

    it("should search across multiple repos when no repo specified", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);
      // listNodes for repo-1
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [makeNode(1, "Function", { name: "handleFoo" })],
        count: 1,
      });
      // listNodes for repo-2
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [makeNode(2, "Function", { name: "handleBar" })],
        count: 1,
      });

      const handler = tools.get("query")!.handler;
      const result = await handler({ keyword: "handle", limit: 20 });
      const body = parseToolResult(result);

      expect(body.symbols).toHaveLength(2);
      expect(body.repos_searched).toEqual(["my-repo", "other-repo"]);
    });
  });

  // ─── context ──────────────────────────────────────────

  describe("context tool", () => {
    it("should return 360-degree symbol context", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);

      // Find symbol via listNodes
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [makeNode(100, "Function", { name: "myFunc" })],
        count: 1,
      });

      // getNodeDetail returns full context
      m(mockClient).getNodeDetail.mockResolvedValueOnce({
        node: {
          id: 100,
          label: "Function",
          name: "myFunc",
          file_path: "src/index.ts",
        },
        relationships: {
          outgoing: [
            {
              edge_type: "CALLS",
              target: { id: 200, label: "Function", name: "callee1" },
            },
            {
              edge_type: "IMPORTS",
              target: { id: 300, label: "Function", name: "imported1" },
            },
          ],
          incoming: [
            {
              edge_type: "CALLS",
              source: { id: 400, label: "Function", name: "caller1" },
            },
          ],
        },
      });

      const handler = tools.get("context")!.handler;
      const result = await handler({ symbol: "myFunc", repo: "my-repo" });
      const body = parseToolResult(result);

      expect(body.symbol.name).toBe("myFunc");
      expect(body.outgoing).toHaveLength(2);
      expect(body.incoming).toHaveLength(1);
    });

    it("should return error when symbol not found", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [],
        count: 0,
      });

      const handler = tools.get("context")!.handler;
      const result = await handler({
        symbol: "nonexistent",
        repo: "my-repo",
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("not found");
    });

    it("should auto-detect repo in multi-repo mode", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      // Multi-repo search: found only in repo-1
      m(mockClient).listNodes
        .mockResolvedValueOnce({
          nodes: [makeNode(100, "Function", { name: "myFunc" })],
          count: 1,
        })
        .mockResolvedValueOnce({ nodes: [], count: 0 })
        // Main context lookup after resolution
        .mockResolvedValueOnce({
          nodes: [makeNode(100, "Function", { name: "myFunc" })],
          count: 1,
        });

      m(mockClient).getNodeDetail.mockResolvedValueOnce({
        node: {
          id: 100,
          label: "Function",
          name: "myFunc",
          file_path: "src/index.ts",
        },
        relationships: { outgoing: [], incoming: [] },
      });

      const handler = tools.get("context")!.handler;
      const result = await handler({ symbol: "myFunc" });
      const body = parseToolResult(result);

      expect(body.symbol.name).toBe("myFunc");
    });

    it("should return error when symbol found in multiple repos", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      // Found in both repos
      m(mockClient).listNodes
        .mockResolvedValueOnce({
          nodes: [makeNode(100, "Function", { name: "myFunc" })],
          count: 1,
        })
        .mockResolvedValueOnce({
          nodes: [makeNode(200, "Function", { name: "myFunc" })],
          count: 1,
        });

      const handler = tools.get("context")!.handler;
      const result = await handler({ symbol: "myFunc" });
      const body = parseToolResult(result);

      expect(body.error).toContain("found in multiple repositories");
      expect(body.found_in).toEqual(["my-repo", "other-repo"]);
    });
  });

  // ─── impact ──────────────────────────────────────────

  describe("impact tool", () => {
    it("should analyze blast radius of a symbol", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).analyzeImpact.mockResolvedValueOnce({
        root: { name: "myFunc", label: "Function" },
        affected: [
          { name: "caller1", label: "Function", depth: 1 },
          { name: "callee1", label: "Function", depth: 1 },
        ],
        summary: {
          total_affected: 2,
          local_affected: 2,
          cross_repo_affected: 0,
        },
      });

      const handler = tools.get("impact")!.handler;
      const result = await handler({
        symbol: "myFunc",
        direction: "both",
        depth: 3,
        repo: "my-repo",
        include_cross_repo: false,
      });
      const body = parseToolResult(result);

      expect(body.root.name).toBe("myFunc");
      expect(body.affected).toHaveLength(2);
      expect(body.summary.total_affected).toBe(2);
      expect(body.summary.local_affected).toBe(2);
      expect(body.summary.cross_repo_affected).toBe(0);
    });

    it("should require repo when multiple repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      const handler = tools.get("impact")!.handler;
      const result = await handler({
        symbol: "myFunc",
        direction: "both",
        depth: 3,
        include_cross_repo: false,
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("Multiple repositories found");
      expect(body.available_repos).toEqual(["my-repo", "other-repo"]);
    });

    it("should pass include_cross_repo to API", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).analyzeImpact.mockResolvedValueOnce({
        root: { name: "myFunc" },
        affected: [],
        summary: {
          total_affected: 0,
          local_affected: 0,
          cross_repo_affected: 0,
        },
      });

      const handler = tools.get("impact")!.handler;
      await handler({
        symbol: "myFunc",
        direction: "both",
        depth: 3,
        repo: "my-repo",
        include_cross_repo: true,
      });

      expect(m(mockClient).analyzeImpact).toHaveBeenCalledWith("repo-1", {
        symbol: "myFunc",
        direction: "both",
        depth: 3,
        include_cross_repo: true,
      });
    });
  });

  // ─── trace ──────────────────────────────────────────

  describe("trace tool", () => {
    it("should trace forward flows from a symbol", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).crossRepoTrace.mockResolvedValueOnce({
        start: { symbol_name: "startFunc", repo: "my-repo" },
        nodes: [{ name: "nextFunc", label: "Function", repo: "my-repo" }],
        edges: [
          {
            from: "startFunc",
            to: "nextFunc",
            type: "CALLS",
          },
        ],
        summary: { total_nodes: 1 },
      });

      const handler = tools.get("trace")!.handler;
      const result = await handler({
        start_symbol: "startFunc",
        start_repo: "my-repo",
        direction: "forward",
        max_depth: 3,
        include_cross_repo: false,
      });
      const body = parseToolResult(result);

      expect(body.start.symbol_name).toBe("startFunc");
      expect(body.nodes).toHaveLength(1);
      expect(body.edges).toHaveLength(1);
      expect(body.summary.total_nodes).toBe(1);
    });

    it("should require repo when multiple repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      const handler = tools.get("trace")!.handler;
      const result = await handler({
        start_symbol: "myFunc",
        direction: "forward",
        max_depth: 3,
        include_cross_repo: false,
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("Multiple repositories found");
    });

    it("should handle API errors gracefully", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).crossRepoTrace.mockRejectedValueOnce(
        new Error("Symbol not found"),
      );

      const handler = tools.get("trace")!.handler;
      const result = await handler({
        start_symbol: "missing",
        start_repo: "my-repo",
        direction: "forward",
        max_depth: 3,
        include_cross_repo: false,
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("not found");
    });
  });

  // ─── cypher ──────────────────────────────────────────

  describe("cypher tool", () => {
    it("should execute raw Cypher query", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).executeCypher.mockResolvedValueOnce({
        rows: [
          { result: { id: 1, label: "Function", properties: { name: "foo" } } },
        ],
        row_count: 1,
        columns: ["result"],
        repo: "my-repo",
      });

      const handler = tools.get("cypher")!.handler;
      const result = await handler({
        cypher: "MATCH (n) RETURN n LIMIT 1",
        repo: "my-repo",
      });
      const body = parseToolResult(result);

      expect(body.rows).toHaveLength(1);
      expect(body.row_count).toBe(1);
      expect(body.columns).toEqual(["result"]);
      expect(body.repo).toBe("my-repo");
    });

    it("should require repo when multiple repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      const handler = tools.get("cypher")!.handler;
      const result = await handler({
        cypher: "MATCH (n) RETURN n",
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("Multiple repositories found");
    });

    it("should return error on Cypher failure", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).executeCypher.mockRejectedValueOnce(
        new Error("Syntax error in Cypher"),
      );

      const handler = tools.get("cypher")!.handler;
      const result = await handler({
        cypher: "INVALID CYPHER",
        repo: "my-repo",
      });
      const body = parseToolResult(result);

      expect(body.error).toBe("Syntax error in Cypher");
    });

    it("should pass custom columns to API", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).executeCypher.mockResolvedValueOnce({
        rows: [{ name: "foo", count: 5 }],
        row_count: 1,
        columns: ["name", "count"],
      });

      const handler = tools.get("cypher")!.handler;
      await handler({
        cypher: "MATCH (n) RETURN n.name AS name, count(n) AS count",
        repo: "my-repo",
        columns: [{ name: "name" }, { name: "count" }],
      });

      expect(m(mockClient).executeCypher).toHaveBeenCalledWith("repo-1", {
        query:
          "MATCH (n) RETURN n.name AS name, count(n) AS count",
        params: undefined,
        columns: [{ name: "name" }, { name: "count" }],
      });
    });
  });

  // ─── routes ──────────────────────────────────────────

  describe("routes tool", () => {
    it("should list route handlers", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getRoutes.mockResolvedValueOnce({
        routes: [
          {
            http_method: "GET",
            url_pattern: "/api/users",
            file_path: "src/routes.ts",
            handler_name: "getUsers",
            framework: "express",
          },
        ],
        count: 1,
      });

      const handler = tools.get("routes")!.handler;
      const result = await handler({});
      const body = parseToolResult(result);

      expect(body.routes).toHaveLength(1);
      expect(body.routes[0].http_method).toBe("GET");
      expect(body.routes[0].url_pattern).toBe("/api/users");
      expect(body.count).toBe(1);
    });

    it("should filter by method", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getRoutes.mockResolvedValueOnce({
        routes: [
          {
            http_method: "GET",
            url_pattern: "/api/users",
          },
          {
            http_method: "POST",
            url_pattern: "/api/users",
          },
        ],
        count: 2,
      });

      const handler = tools.get("routes")!.handler;
      const result = await handler({ method: "get" });
      const body = parseToolResult(result);

      expect(body.routes).toHaveLength(1);
      expect(body.routes[0].http_method).toBe("GET");
    });

    it("should filter by url_pattern", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getRoutes.mockResolvedValueOnce({
        routes: [
          {
            http_method: "GET",
            url_pattern: "/api/users",
          },
          {
            http_method: "GET",
            url_pattern: "/api/posts",
          },
        ],
        count: 2,
      });

      const handler = tools.get("routes")!.handler;
      const result = await handler({ url_pattern: "/users" });
      const body = parseToolResult(result);

      expect(body.routes).toHaveLength(1);
      expect(body.routes[0].url_pattern).toBe("/api/users");
    });
  });

  // ─── dependencies ──────────────────────────────────────

  describe("dependencies tool", () => {
    it("should return file dependency tree", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getDependencies.mockResolvedValueOnce({
        file_path: "src/index.ts",
        imports: [{ file_path: "src/utils.ts" }, { file_path: "src/config.ts" }],
        imported_by: [],
        repo: "my-repo",
      });

      const handler = tools.get("dependencies")!.handler;
      const result = await handler({
        file_path: "src/index.ts",
        repo: "my-repo",
        depth: 1,
      });
      const body = parseToolResult(result);

      expect(body.file_path).toBe("src/index.ts");
      expect(body.imports).toHaveLength(2);
      expect(body.imported_by).toHaveLength(0);
      expect(body.repo).toBe("my-repo");
    });

    it("should require repo when multiple repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      const handler = tools.get("dependencies")!.handler;
      const result = await handler({
        file_path: "src/index.ts",
        depth: 1,
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("Multiple repositories found");
    });

    it("should handle API errors gracefully", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getDependencies.mockRejectedValueOnce(
        new Error("File not found in graph"),
      );

      const handler = tools.get("dependencies")!.handler;
      const result = await handler({
        file_path: "nonexistent.ts",
        repo: "my-repo",
        depth: 1,
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("not found in graph");
    });
  });

  // ─── search ──────────────────────────────────────────

  describe("search tool", () => {
    it("should perform keyword search within a specific repo", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).search.mockResolvedValueOnce({
        mode: "keyword",
        total: 2,
        results: [
          {
            file_path: "src/auth.ts",
            rank: 0.95,
            headline: "**auth** handler",
            language: "typescript",
          },
          {
            file_path: "src/login.ts",
            rank: 0.8,
            headline: "**auth** login",
            language: "typescript",
          },
        ],
        repo: "my-repo",
      });

      const handler = tools.get("search")!.handler;
      const result = await handler({
        keyword: "auth",
        repo: "my-repo",
        limit: 20,
        mode: "keyword",
      });
      const body = parseToolResult(result);

      expect(body.mode).toBe("keyword");
      expect(body.total).toBe(2);
      expect(body.results).toHaveLength(2);
      expect(body.results[0].file_path).toBe("src/auth.ts");
      expect(body.repo).toBe("my-repo");
    });

    it("should search across all repos when repo is omitted", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);
      m(mockClient).projectSearch.mockResolvedValueOnce({
        mode: "keyword",
        total: 2,
        results: [
          {
            file_path: "src/auth.ts",
            rank: 0.95,
            repo_name: "my-repo",
          },
          {
            file_path: "src/auth.ts",
            rank: 0.8,
            repo_name: "other-repo",
          },
        ],
      });

      const handler = tools.get("search")!.handler;
      const result = await handler({
        keyword: "auth",
        limit: 20,
        mode: "keyword",
      });
      const body = parseToolResult(result);

      expect(body.mode).toBe("keyword");
      expect(body.total).toBe(2);
      expect(body.results).toHaveLength(2);
    });

    it("should return error when specified repo not found", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);

      const handler = tools.get("search")!.handler;
      const result = await handler({
        keyword: "test",
        repo: "nonexistent",
        limit: 20,
        mode: "keyword",
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("Repository not found");
    });

    it("should handle search errors gracefully", async () => {
      m(mockClient).resolveRepo.mockRejectedValueOnce(
        new Error("DB connection lost"),
      );

      const handler = tools.get("search")!.handler;
      const result = await handler({
        keyword: "test",
        repo: "my-repo",
        limit: 20,
        mode: "keyword",
      });
      const body = parseToolResult(result);

      expect(body.error).toBe("DB connection lost");
    });
  });

  // ─── grep ──────────────────────────────────────────

  describe("grep tool", () => {
    it("should perform regex search across file contents", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).grep.mockResolvedValueOnce({
        matches: [
          {
            file_path: "src/auth.ts",
            line_number: 2,
            line: "const auth = true;",
            context_before: ["line1"],
            context_after: ["line3"],
          },
        ],
        total_matches: 1,
        files_matched: 1,
      });

      const handler = tools.get("grep")!.handler;
      const result = await handler({
        pattern: "auth",
        case_sensitive: true,
        context_lines: 1,
        limit: 100,
      });
      const body = parseToolResult(result);

      expect(body.matches).toHaveLength(1);
      expect(body.matches[0].file_path).toBe("src/auth.ts");
      expect(body.matches[0].line_number).toBe(2);
      expect(body.matches[0].line).toContain("auth");
    });

    it("should search across multiple repos when no repo specified", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      m(mockClient).grep
        .mockResolvedValueOnce({
          matches: [
            { file_path: "src/a.ts", line_number: 1, line: "match here" },
          ],
          total_matches: 1,
        })
        .mockResolvedValueOnce({
          matches: [
            { file_path: "src/b.ts", line_number: 1, line: "match there" },
          ],
          total_matches: 1,
        });

      const handler = tools.get("grep")!.handler;
      const result = await handler({
        pattern: "match",
        case_sensitive: true,
        context_lines: 0,
        limit: 100,
      });
      const body = parseToolResult(result);

      expect(body.matches).toHaveLength(2);
      expect(body.repos_searched).toEqual(["my-repo", "other-repo"]);
    });

    it("should handle no repos error", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([]);

      const handler = tools.get("grep")!.handler;
      const result = await handler({
        pattern: "test",
        case_sensitive: true,
        context_lines: 0,
        limit: 100,
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("No indexed repositories found");
    });
  });

  // ─── read_file ──────────────────────────────────────

  describe("read_file tool", () => {
    it("should read a file from the index", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).readFile.mockResolvedValueOnce({
        path: "src/index.ts",
        language: "typescript",
        content: "line1\nline2\nline3",
        total_lines: 3,
        symbols: [
          { name: "main", label: "Function", line: 1, exported: true },
        ],
        repo: "my-repo",
      });

      const handler = tools.get("read_file")!.handler;
      const result = await handler({ path: "src/index.ts" });
      const body = parseToolResult(result);

      expect(body.path).toBe("src/index.ts");
      expect(body.language).toBe("typescript");
      expect(body.content).toBe("line1\nline2\nline3");
      expect(body.total_lines).toBe(3);
      expect(body.symbols).toHaveLength(1);
      expect(body.repo).toBe("my-repo");
    });

    it("should support line range", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).readFile.mockResolvedValueOnce({
        path: "src/index.ts",
        content: "line2\nline3\nline4",
        range: { start: 2, end: 4 },
        total_lines: 5,
      });

      const handler = tools.get("read_file")!.handler;
      const result = await handler({
        path: "src/index.ts",
        start_line: 2,
        end_line: 4,
      });
      const body = parseToolResult(result);

      expect(body.content).toBe("line2\nline3\nline4");
      expect(body.range).toEqual({ start: 2, end: 4 });
    });

    it("should return error when file not found", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).readFile.mockRejectedValueOnce(
        new Error("File 'nonexistent.ts' not found"),
      );

      const handler = tools.get("read_file")!.handler;
      const result = await handler({ path: "nonexistent.ts" });
      const body = parseToolResult(result);

      expect(body.error).toContain("not found");
    });

    it("should auto-detect repo in multi-repo mode", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      // readFile: found in repo-1, throws for repo-2
      m(mockClient).readFile
        .mockResolvedValueOnce({ path: "src/file.ts" }) // probe repo-1: success
        .mockRejectedValueOnce(new Error("Not found")) // probe repo-2: fail
        .mockResolvedValueOnce({
          // actual read from repo-1
          path: "src/file.ts",
          content: "content",
          language: "typescript",
          repo: "my-repo",
        });

      const handler = tools.get("read_file")!.handler;
      const result = await handler({ path: "src/file.ts" });
      const body = parseToolResult(result);

      expect(body.path).toBe("src/file.ts");
    });

    it("should return error when file found in multiple repos", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      // readFile: found in both repos
      m(mockClient).readFile
        .mockResolvedValueOnce({ path: "src/file.ts" })
        .mockResolvedValueOnce({ path: "src/file.ts" });

      const handler = tools.get("read_file")!.handler;
      const result = await handler({ path: "src/file.ts" });
      const body = parseToolResult(result);

      expect(body.error).toContain("found in multiple repositories");
    });
  });

  // ─── graph_stats ──────────────────────────────────────

  describe("graph_stats tool", () => {
    it("should return graph statistics for a single repo", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getGraphStats.mockResolvedValueOnce({
        repo: "my-repo",
        has_graph: true,
        total_nodes: 30,
        total_edges: 40,
        total_files: 60,
        nodes: { Function: 25, Class: 5 },
        edges: { CALLS: 30, IMPORTS: 10 },
        languages: { typescript: 50, javascript: 10 },
        indexing: {
          status: "completed",
          phase: "callgraph",
          progress: 100,
        },
      });

      const handler = tools.get("graph_stats")!.handler;
      const result = await handler({});
      const body = parseToolResult(result);

      expect(body.repo).toBe("my-repo");
      expect(body.has_graph).toBe(true);
      expect(body.total_nodes).toBe(30);
      expect(body.total_edges).toBe(40);
      expect(body.total_files).toBe(60);
      expect(body.nodes.Function).toBe(25);
      expect(body.nodes.Class).toBe(5);
      expect(body.edges.CALLS).toBe(30);
      expect(body.languages.typescript).toBe(50);
      expect(body.indexing.status).toBe("completed");
    });

    it("should return aggregate stats for multiple repos", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);
      m(mockClient).getGraphStats
        .mockResolvedValueOnce({
          repo: "my-repo",
          total_files: 10,
          total_nodes: 5,
          total_edges: 3,
        })
        .mockResolvedValueOnce({
          repo: "other-repo",
          total_files: 20,
          total_nodes: 10,
          total_edges: 7,
        });

      const handler = tools.get("graph_stats")!.handler;
      const result = await handler({});
      const body = parseToolResult(result);

      expect(body.repos).toHaveLength(2);
      expect(body.aggregate.total_repos).toBe(2);
    });
  });

  // ─── cross_repo_connections ──────────────────────────

  describe("cross_repo_connections tool", () => {
    it("should list cross-repo connection rules", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).listConnections.mockResolvedValueOnce({
        connections: [
          {
            id: "conn-1",
            source_repo: "my-repo",
            target_repo: "other-repo",
            connection_type: "package_dependency",
            edge_count: 15,
          },
        ],
      });
      m(mockClient).getCrossRepoStats.mockResolvedValueOnce({
        total_connections: 1,
        total_edges: 15,
      });

      const handler = tools.get("cross_repo_connections")!.handler;
      const result = await handler({});
      const body = parseToolResult(result);

      expect(body.connections.connections).toHaveLength(1);
      expect(body.cross_repo_stats.total_connections).toBe(1);
    });

    it("should return no repo error when no repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([]);

      const handler = tools.get("cross_repo_connections")!.handler;
      const result = await handler({});
      const body = parseToolResult(result);

      expect(body.error).toContain("No indexed repositories found");
    });
  });

  // ─── architecture_check ──────────────────────────────

  describe("architecture_check tool", () => {
    it("should detect architectural violations", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).checkArchitecture.mockResolvedValueOnce({
        violations: [
          {
            from_layer: "domain",
            to_layer: "infrastructure",
            from_file: "src/domain/user.ts",
            to_file: "src/infrastructure/db.ts",
            edge_type: "IMPORTS",
          },
        ],
        total_violations: 1,
      });

      const handler = tools.get("architecture_check")!.handler;
      const result = await handler({
        repo: "my-repo",
        layers: {
          domain: "src/domain/**",
          infrastructure: "src/infrastructure/**",
        },
        rules: [{ from: "domain", deny: ["infrastructure"] }],
        edge_types: ["IMPORTS", "CALLS"],
      });
      const body = parseToolResult(result);

      expect(body.violations).toHaveLength(1);
      expect(body.total_violations).toBe(1);
    });

    it("should require repo when multiple repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      const handler = tools.get("architecture_check")!.handler;
      const result = await handler({
        edge_types: ["IMPORTS", "CALLS"],
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("Multiple repositories found");
    });
  });

  // ─── communities ──────────────────────────────────────

  describe("communities tool", () => {
    it("should list communities", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).listCommunities.mockResolvedValueOnce({
        communities: [
          {
            id: "comm-1",
            label: "Auth Module",
            member_count: 10,
            cohesion: 0.85,
          },
        ],
        count: 1,
      });

      const handler = tools.get("communities")!.handler;
      const result = await handler({
        repo: "my-repo",
        limit: 20,
        include_members: false,
      });
      const body = parseToolResult(result);

      expect(body.communities).toHaveLength(1);
      expect(body.communities[0].label).toBe("Auth Module");
    });

    it("should fetch specific community detail", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getCommunityDetail.mockResolvedValueOnce({
        id: "comm-1",
        label: "Auth Module",
        members: [
          { name: "login", label: "Function" },
          { name: "logout", label: "Function" },
        ],
      });

      const handler = tools.get("communities")!.handler;
      const result = await handler({
        repo: "my-repo",
        community_id: "comm-1",
        limit: 20,
        include_members: false,
      });
      const body = parseToolResult(result);

      expect(body.id).toBe("comm-1");
      expect(body.members).toHaveLength(2);
    });
  });

  // ─── processes ──────────────────────────────────────

  describe("processes tool", () => {
    it("should list processes", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).listProcesses.mockResolvedValueOnce({
        processes: [
          {
            id: "proc-1",
            label: "Request Handler",
            process_type: "intra_community",
            step_count: 5,
          },
        ],
        count: 1,
      });

      const handler = tools.get("processes")!.handler;
      const result = await handler({
        repo: "my-repo",
        limit: 20,
        include_steps: false,
      });
      const body = parseToolResult(result);

      expect(body.processes).toHaveLength(1);
      expect(body.processes[0].label).toBe("Request Handler");
    });

    it("should fetch specific process detail", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getProcessDetail.mockResolvedValueOnce({
        id: "proc-1",
        label: "Request Handler",
        steps: [
          { name: "handleRequest", label: "Function", order: 0 },
          { name: "processData", label: "Function", order: 1 },
        ],
      });

      const handler = tools.get("processes")!.handler;
      const result = await handler({
        repo: "my-repo",
        process_id: "proc-1",
        limit: 20,
        include_steps: false,
      });
      const body = parseToolResult(result);

      expect(body.id).toBe("proc-1");
      expect(body.steps).toHaveLength(2);
    });
  });

  // ─── rename ──────────────────────────────────────────

  describe("rename tool", () => {
    it("should perform dry-run rename and return edits", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).renameSymbol.mockResolvedValueOnce({
        symbol: "oldName",
        edits: [
          {
            file_path: "src/index.ts",
            line: 10,
            column_start: 17,
            column_end: 24,
            old_text: "oldName",
            new_text: "newName",
            confidence: 1.0,
            reason: "definition",
          },
          {
            file_path: "src/utils.ts",
            line: 5,
            column_start: 10,
            column_end: 17,
            old_text: "oldName",
            new_text: "newName",
            confidence: 0.9,
            reason: "call_site",
          },
        ],
        affected_files: ["src/index.ts", "src/utils.ts"],
        total_edits: 2,
        applied: false,
        warnings: [],
      });

      const handler = tools.get("rename")!.handler;
      const result = await handler({
        symbol: "oldName",
        new_name: "newName",
        dry_run: true,
        min_confidence: 0.8,
      });
      const body = parseToolResult(result);

      expect(body.symbol).toBe("oldName");
      expect(body.edits).toHaveLength(2);
      expect(body.affected_files).toEqual(["src/index.ts", "src/utils.ts"]);
      expect(body.total_edits).toBe(2);
      expect(body.applied).toBe(false);
      expect(body.warnings).toEqual([]);

      expect(m(mockClient).renameSymbol).toHaveBeenCalledWith("repo-1", {
        symbol: "oldName",
        new_name: "newName",
        file_path: undefined,
        label: undefined,
        dry_run: true,
        min_confidence: 0.8,
      });
    });

    it("should return error when no repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([]);

      const handler = tools.get("rename")!.handler;
      const result = await handler({
        symbol: "foo",
        new_name: "bar",
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("No indexed repositories found");
    });

    it("should return error when rename fails", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).renameSymbol.mockRejectedValueOnce(
        new Error("Graph query failed"),
      );

      const handler = tools.get("rename")!.handler;
      const result = await handler({
        symbol: "foo",
        new_name: "bar",
      });
      const body = parseToolResult(result);

      expect(body.error).toBe("Graph query failed");
    });
  });

  // ─── detect_changes ──────────────────────────────────

  describe("detect_changes tool", () => {
    it("should return diff impact analysis results", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).diffImpact.mockResolvedValueOnce({
        repo: "my-repo",
        changed_files: [
          {
            filePath: "src/index.ts",
            additions: 2,
            deletions: 1,
          },
        ],
        direct_symbols: [
          {
            name: "handleRequest",
            label: "Function",
            filePath: "src/index.ts",
          },
        ],
        impacted_symbols: [
          {
            name: "processData",
            label: "Function",
            filePath: "src/utils.ts",
            depth: 1,
          },
        ],
        affected_processes: [
          {
            processId: 100,
            label: "Request Handler",
            processType: "intra_community",
            stepCount: 5,
          },
        ],
        risk: "MEDIUM",
        summary:
          "1 file(s) changed, 1 direct symbol(s), 1 indirectly impacted, 1 process(es) affected \u2014 Risk: MEDIUM",
      });

      const handler = tools.get("detect_changes")!.handler;
      const result = await handler({
        repo: "my-repo",
        scope: "all",
        max_depth: 3,
      });
      const body = parseToolResult(result);

      expect(body.repo).toBe("my-repo");
      expect(body.risk).toBe("MEDIUM");
      expect(body.direct_symbols).toHaveLength(1);
      expect(body.impacted_symbols).toHaveLength(1);
      expect(body.affected_processes).toHaveLength(1);

      expect(m(mockClient).diffImpact).toHaveBeenCalledWith("repo-1", {
        scope: "all",
        compare_ref: undefined,
        max_depth: 3,
      });
    });

    it("should return error when no repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([]);

      const handler = tools.get("detect_changes")!.handler;
      const result = await handler({
        repo: "my-repo",
        scope: "all",
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("No indexed repositories found");
    });

    it("should return error when analysis fails", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).diffImpact.mockRejectedValueOnce(
        new Error("Not a git repository"),
      );

      const handler = tools.get("detect_changes")!.handler;
      const result = await handler({
        repo: "my-repo",
        scope: "all",
      });
      const body = parseToolResult(result);

      expect(body.error).toBe("Not a git repository");
    });
  });

  // ═══════════════════════════════════════════════════════
  // New tools (7)
  // ═══════════════════════════════════════════════════════

  // ─── orphans ──────────────────────────────────────────

  describe("orphans tool", () => {
    it("should find unreferenced symbols", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getOrphans.mockResolvedValueOnce({
        orphans: [
          { name: "deadFunc", label: "Function", file_path: "src/old.ts" },
          { name: "UnusedClass", label: "Class", file_path: "src/unused.ts" },
        ],
        count: 2,
      });

      const handler = tools.get("orphans")!.handler;
      const result = await handler({ repo: "my-repo", limit: 20 });
      const body = parseToolResult(result);

      expect(body.orphans).toHaveLength(2);
      expect(body.count).toBe(2);
    });

    it("should filter orphans by label", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_ROW]);
      m(mockClient).getOrphans.mockResolvedValueOnce({
        orphans: [
          { name: "UnusedClass", label: "Class", file_path: "src/unused.ts" },
        ],
        count: 1,
      });

      const handler = tools.get("orphans")!.handler;
      const result = await handler({
        repo: "my-repo",
        label: "Class",
        limit: 20,
      });
      const body = parseToolResult(result);

      expect(body.orphans).toHaveLength(1);
      expect(m(mockClient).getOrphans).toHaveBeenCalledWith("repo-1", {
        label: "Class",
        limit: 20,
      });
    });

    it("should require repo when multiple repos exist", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([
        REPO_ROW,
        REPO_ROW_2,
      ]);

      const handler = tools.get("orphans")!.handler;
      const result = await handler({ limit: 20 });
      const body = parseToolResult(result);

      expect(body.error).toContain("Multiple repositories found");
    });

    it("should return error for repo with no graph", async () => {
      m(mockClient).getAllRepos.mockResolvedValueOnce([REPO_NO_GRAPH]);

      const handler = tools.get("orphans")!.handler;
      const result = await handler({ repo: "no-graph-repo", limit: 20 });
      const body = parseToolResult(result);

      expect(body.error).toContain("has no graph");
    });
  });

  // ─── edges ──────────────────────────────────────────

  describe("edges tool", () => {
    it("should list graph edges", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).listEdges.mockResolvedValueOnce({
        edges: [
          {
            id: 1,
            type: "CALLS",
            source: { name: "funcA", label: "Function" },
            target: { name: "funcB", label: "Function" },
          },
        ],
        count: 1,
      });

      const handler = tools.get("edges")!.handler;
      const result = await handler({ repo: "my-repo", limit: 20 });
      const body = parseToolResult(result);

      expect(body.edges).toHaveLength(1);
      expect(body.edges[0].type).toBe("CALLS");
    });

    it("should filter by edge type and source label", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).listEdges.mockResolvedValueOnce({
        edges: [],
        count: 0,
      });

      const handler = tools.get("edges")!.handler;
      await handler({
        repo: "my-repo",
        edge_type: "EXTENDS",
        source_label: "Class",
        limit: 10,
      });

      expect(m(mockClient).listEdges).toHaveBeenCalledWith("repo-1", {
        type: "EXTENDS",
        source_label: "Class",
        limit: 10,
      });
    });

    it("should return error when repo not found", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);

      const handler = tools.get("edges")!.handler;
      const result = await handler({ repo: "nonexistent", limit: 20 });
      const body = parseToolResult(result);

      expect(body.error).toContain("Repository not found");
    });
  });

  // ─── path ──────────────────────────────────────────

  describe("path tool", () => {
    it("should find shortest path between symbols", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).findPath.mockResolvedValueOnce({
        path: [
          { name: "funcA", label: "Function" },
          { name: "funcB", label: "Function" },
          { name: "funcC", label: "Function" },
        ],
        edges: [
          { from: "funcA", to: "funcB", type: "CALLS" },
          { from: "funcB", to: "funcC", type: "CALLS" },
        ],
        length: 2,
      });

      const handler = tools.get("path")!.handler;
      const result = await handler({
        repo: "my-repo",
        from_symbol: "funcA",
        to_symbol: "funcC",
        max_depth: 5,
      });
      const body = parseToolResult(result);

      expect(body.path).toHaveLength(3);
      expect(body.edges).toHaveLength(2);
      expect(body.length).toBe(2);
    });

    it("should return error when repo not found", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);

      const handler = tools.get("path")!.handler;
      const result = await handler({
        repo: "nonexistent",
        from_symbol: "a",
        to_symbol: "b",
        max_depth: 5,
      });
      const body = parseToolResult(result);

      expect(body.error).toContain("Repository not found");
    });

    it("should pass file_path disambiguators to API", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).findPath.mockResolvedValueOnce({
        path: [],
        edges: [],
        length: 0,
      });

      const handler = tools.get("path")!.handler;
      await handler({
        repo: "my-repo",
        from_symbol: "funcA",
        to_symbol: "funcC",
        max_depth: 5,
        from_file_path: "src/a.ts",
        to_file_path: "src/c.ts",
      });

      expect(m(mockClient).findPath).toHaveBeenCalledWith("repo-1", {
        from: "funcA",
        to: "funcC",
        max_depth: 5,
        from_file_path: "src/a.ts",
        to_file_path: "src/c.ts",
      });
    });
  });

  // ─── git_history ──────────────────────────────────────

  describe("git_history tool", () => {
    it("should return per-file git history stats", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).getGitHistory.mockResolvedValueOnce({
        files: [
          {
            file_path: "src/index.ts",
            authors: ["alice", "bob"],
            commit_count: 15,
            last_modified: "2026-02-15",
          },
        ],
        count: 1,
      });

      const handler = tools.get("git_history")!.handler;
      const result = await handler({ repo: "my-repo", limit: 20 });
      const body = parseToolResult(result);

      expect(body.files).toHaveLength(1);
      expect(body.files[0].commit_count).toBe(15);
      expect(body.files[0].authors).toEqual(["alice", "bob"]);
    });

    it("should filter by file_path", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).getGitHistory.mockResolvedValueOnce({
        files: [
          {
            file_path: "src/auth.ts",
            commit_count: 5,
          },
        ],
        count: 1,
      });

      const handler = tools.get("git_history")!.handler;
      await handler({
        repo: "my-repo",
        file_path: "src/auth.ts",
        limit: 20,
      });

      expect(m(mockClient).getGitHistory).toHaveBeenCalledWith("repo-1", {
        file_path: "src/auth.ts",
        limit: 20,
      });
    });

    it("should return error when repo not found", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);

      const handler = tools.get("git_history")!.handler;
      const result = await handler({ repo: "nonexistent", limit: 20 });
      const body = parseToolResult(result);

      expect(body.error).toContain("Repository not found");
    });
  });

  // ─── git_timeline ──────────────────────────────────────

  describe("git_timeline tool", () => {
    it("should return chronological commit timeline", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).getGitTimeline.mockResolvedValueOnce({
        commits: [
          {
            hash: "abc123",
            message: "feat: add auth",
            author: "alice",
            date: "2026-02-01",
            files: ["src/auth.ts"],
          },
        ],
        count: 1,
      });

      const handler = tools.get("git_timeline")!.handler;
      const result = await handler({ repo: "my-repo", limit: 20 });
      const body = parseToolResult(result);

      expect(body.commits).toHaveLength(1);
      expect(body.commits[0].author).toBe("alice");
    });

    it("should pass date filters to API", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).getGitTimeline.mockResolvedValueOnce({
        commits: [],
        count: 0,
      });

      const handler = tools.get("git_timeline")!.handler;
      await handler({
        repo: "my-repo",
        since: "2026-01-01",
        until: "2026-02-01",
        limit: 10,
      });

      expect(m(mockClient).getGitTimeline).toHaveBeenCalledWith("repo-1", {
        since: "2026-01-01",
        until: "2026-02-01",
        limit: 10,
      });
    });

    it("should return error when repo not found", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);

      const handler = tools.get("git_timeline")!.handler;
      const result = await handler({ repo: "nonexistent", limit: 20 });
      const body = parseToolResult(result);

      expect(body.error).toContain("Repository not found");
    });
  });

  // ─── nodes ──────────────────────────────────────────

  describe("nodes tool", () => {
    it("should list and filter graph nodes", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [
          { id: 1, label: "Function", name: "funcA", file_path: "src/a.ts" },
          { id: 2, label: "Function", name: "funcB", file_path: "src/b.ts" },
        ],
        count: 2,
      });

      const handler = tools.get("nodes")!.handler;
      const result = await handler({
        repo: "my-repo",
        label: "Function",
        limit: 20,
        offset: 0,
      });
      const body = parseToolResult(result);

      expect(body.nodes).toHaveLength(2);
      expect(body.count).toBe(2);
    });

    it("should pass all filters to API", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).listNodes.mockResolvedValueOnce({
        nodes: [],
        count: 0,
      });

      const handler = tools.get("nodes")!.handler;
      await handler({
        repo: "my-repo",
        label: "Class",
        file_path: "src/models/",
        exported: true,
        limit: 10,
        offset: 5,
      });

      expect(m(mockClient).listNodes).toHaveBeenCalledWith("repo-1", {
        label: "Class",
        file_path: "src/models/",
        exported: "true",
        limit: 10,
        offset: 5,
      });
    });

    it("should return error when repo not found", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);

      const handler = tools.get("nodes")!.handler;
      const result = await handler({ repo: "nonexistent", limit: 20, offset: 0 });
      const body = parseToolResult(result);

      expect(body.error).toContain("Repository not found");
    });

    it("should return error for repo with no graph", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_NO_GRAPH);

      const handler = tools.get("nodes")!.handler;
      const result = await handler({ repo: "no-graph-repo", limit: 20, offset: 0 });
      const body = parseToolResult(result);

      expect(body.error).toContain("has no graph");
    });
  });

  // ─── file_tree ──────────────────────────────────────

  describe("file_tree tool", () => {
    it("should return directory structure", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).getFileTree.mockResolvedValueOnce({
        tree: [
          {
            name: "src",
            type: "directory",
            children: [
              { name: "index.ts", type: "file", language: "typescript" },
              { name: "utils.ts", type: "file", language: "typescript" },
            ],
          },
        ],
      });

      const handler = tools.get("file_tree")!.handler;
      const result = await handler({ repo: "my-repo" });
      const body = parseToolResult(result);

      expect(body.tree).toHaveLength(1);
      expect(body.tree[0].name).toBe("src");
      expect(body.tree[0].children).toHaveLength(2);
    });

    it("should pass filters to API", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(REPO_ROW);
      m(mockClient).getFileTree.mockResolvedValueOnce({
        files: [],
      });

      const handler = tools.get("file_tree")!.handler;
      await handler({
        repo: "my-repo",
        path: "src/",
        language: "typescript",
        flat: true,
      });

      expect(m(mockClient).getFileTree).toHaveBeenCalledWith("repo-1", {
        path: "src/",
        language: "typescript",
        flat: "true",
      });
    });

    it("should return error when repo not found", async () => {
      m(mockClient).resolveRepo.mockResolvedValueOnce(null);

      const handler = tools.get("file_tree")!.handler;
      const result = await handler({ repo: "nonexistent" });
      const body = parseToolResult(result);

      expect(body.error).toContain("Repository not found");
    });
  });
});
