import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mocks ----

const mockQuery = vi.hoisted(() => vi.fn());
const mockCypher = vi.hoisted(() => vi.fn());

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

vi.mock("../db/index.js", () => ({
  pool: { query: mockQuery },
}));

vi.mock("../db/age.js", () => ({
  cypher: mockCypher,
}));

// Mock ResourceTemplate since we just need to capture handlers
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  ResourceTemplate: class MockResourceTemplate {
    pattern: string;
    options: unknown;
    constructor(pattern: string, options: unknown) {
      this.pattern = pattern;
      this.options = options;
    }
  },
}));

import { registerResources } from "./resources.js";

// ---- Test helpers ----

type ResourceHandler = (
  uri: unknown,
  variables?: Record<string, string>,
) => Promise<{
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}>;

interface ResourceRegistration {
  name: string;
  uriOrTemplate: unknown;
  metadata: { description: string; mimeType: string };
  handler: ResourceHandler;
}

interface MockMcpServer {
  resources: ResourceRegistration[];
  registerResource: ReturnType<typeof vi.fn>;
}

function createMockServer(): MockMcpServer {
  const resources: ResourceRegistration[] = [];
  const server: MockMcpServer = {
    resources,
    registerResource: vi.fn(
      (
        name: string,
        uriOrTemplate: unknown,
        metadata: { description: string; mimeType: string },
        handler: ResourceHandler,
      ) => {
        resources.push({ name, uriOrTemplate, metadata, handler });
      },
    ),
  };
  return server;
}

function parseResourceResult(result: { contents: Array<{ text: string }> }) {
  return JSON.parse(result.contents[0].text);
}

function getResource(server: MockMcpServer, name: string): ResourceRegistration {
  const resource = server.resources.find((r) => r.name === name);
  if (!resource) throw new Error(`Resource '${name}' not found`);
  return resource;
}

// ---- Tests ----

describe("MCP Resources", () => {
  let server: MockMcpServer;

  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
    server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerResources(server as any, "test-project-id");
  });

  it("should register all 5 resources", () => {
    expect(server.resources).toHaveLength(5);
    const names = server.resources.map((r) => r.name);
    expect(names).toEqual([
      "project-info",
      "repos",
      "repo-tree",
      "repo-stats",
      "connections",
    ]);
  });

  // ─── project-info ─────────────────────────────────────

  describe("project-info resource", () => {
    it("should return project info with repositories", async () => {
      // getFirstProject
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "proj-1",
          name: "My Project",
          description: "A code analyzer project",
          settings: { indexing_phase: "all" },
          created_at: "2026-01-01T00:00:00Z",
        }],
      });

      // repos query
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: "repo-1", name: "my-repo", url: "https://github.com/test/repo", source_type: "git_url" },
        ],
      });

      const resource = getResource(server, "project-info");
      const result = await resource.handler("nexgraph://project/info");
      const body = parseResourceResult(result);

      expect(body.id).toBe("proj-1");
      expect(body.name).toBe("My Project");
      expect(body.description).toBe("A code analyzer project");
      expect(body.repositories).toHaveLength(1);
      expect(body.repositories[0].name).toBe("my-repo");
    });

    it("should return error when no project exists", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const resource = getResource(server, "project-info");
      const result = await resource.handler("nexgraph://project/info");
      const body = parseResourceResult(result);

      expect(body.error).toBe("No project found");
    });
  });

  // ─── repos ─────────────────────────────────────────────

  describe("repos resource", () => {
    it("should return all repos with stats", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "repo-1",
            name: "my-repo",
            url: "https://github.com/test/repo",
            source_type: "git_url",
            default_branch: "main",
            graph_name: "repo_graph_1",
            project_id: "proj-1",
            last_indexed_at: "2026-01-01T00:00:00Z",
            created_at: "2025-12-01T00:00:00Z",
            file_count: "42",
            latest_job_status: "completed",
          },
        ],
      });

      const resource = getResource(server, "repos");
      const result = await resource.handler("nexgraph://repos");
      const body = parseResourceResult(result);

      expect(body.repositories).toHaveLength(1);
      expect(body.repositories[0].name).toBe("my-repo");
      expect(body.repositories[0].file_count).toBe(42);
      expect(body.repositories[0].latest_job_status).toBe("completed");
      expect(body.repositories[0].graph_name).toBe("repo_graph_1");
    });

    it("should return empty list when no repos", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const resource = getResource(server, "repos");
      const result = await resource.handler("nexgraph://repos");
      const body = parseResourceResult(result);

      expect(body.repositories).toEqual([]);
    });
  });

  // ─── repo-tree ─────────────────────────────────────────

  describe("repo-tree resource", () => {
    it("should return file tree for a repository", async () => {
      // resolveRepoByName
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "repo-1",
          name: "my-repo",
          url: "https://github.com/test/repo",
          source_type: "git_url",
          default_branch: "main",
          graph_name: "repo_graph_1",
          project_id: "proj-1",
          last_indexed_at: null,
          created_at: "2025-12-01T00:00:00Z",
        }],
      });

      // indexed_files query
      mockQuery.mockResolvedValueOnce({
        rows: [
          { file_path: "src/index.ts", language: "typescript" },
          { file_path: "src/utils.ts", language: "typescript" },
          { file_path: "package.json", language: "json" },
        ],
      });

      const resource = getResource(server, "repo-tree");
      const result = await resource.handler("nexgraph://repos/my-repo/tree", { repo: "my-repo" });
      const body = parseResourceResult(result);

      expect(body.repo).toBe("my-repo");
      expect(body.total_files).toBe(3);
      expect(body.tree).toBeDefined();
      // Should have src directory and package.json at root
      expect(body.tree.length).toBe(2); // src/ dir and package.json
    });

    it("should return error when repo not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const resource = getResource(server, "repo-tree");
      const result = await resource.handler("nexgraph://repos/missing/tree", { repo: "missing" });
      const body = parseResourceResult(result);

      expect(body.error).toContain("not found");
    });
  });

  // ─── repo-stats ─────────────────────────────────────────

  describe("repo-stats resource", () => {
    it("should return graph stats for a repository", async () => {
      // resolveRepoByName
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "repo-1",
          name: "my-repo",
          url: "https://github.com/test/repo",
          source_type: "git_url",
          default_branch: "main",
          graph_name: "repo_graph_1",
          project_id: "proj-1",
          last_indexed_at: null,
          created_at: "2025-12-01T00:00:00Z",
        }],
      });

      // node counts
      mockCypher.mockResolvedValueOnce([
        { label: "Function", count: 25 },
        { label: "Class", count: 5 },
      ]);

      // edge counts
      mockCypher.mockResolvedValueOnce([
        { label: "CALLS", count: 30 },
        { label: "IMPORTS", count: 10 },
      ]);

      // file count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "60" }] });

      const resource = getResource(server, "repo-stats");
      const result = await resource.handler("nexgraph://repos/my-repo/stats", { repo: "my-repo" });
      const body = parseResourceResult(result);

      expect(body.repo).toBe("my-repo");
      expect(body.graph_name).toBe("repo_graph_1");
      expect(body.file_count).toBe(60);
      expect(body.total_nodes).toBe(30);
      expect(body.total_edges).toBe(40);
      expect(body.nodes_by_label.Function).toBe(25);
      expect(body.edges_by_label.CALLS).toBe(30);
    });

    it("should return error when repo not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const resource = getResource(server, "repo-stats");
      const result = await resource.handler("nexgraph://repos/missing/stats", { repo: "missing" });
      const body = parseResourceResult(result);

      expect(body.error).toContain("not found");
    });

    it("should return error when repo has no graph", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "repo-1",
          name: "my-repo",
          url: "https://github.com/test/repo",
          source_type: "git_url",
          default_branch: "main",
          graph_name: null,
          project_id: "proj-1",
          last_indexed_at: null,
          created_at: "2025-12-01T00:00:00Z",
        }],
      });

      const resource = getResource(server, "repo-stats");
      const result = await resource.handler("nexgraph://repos/my-repo/stats", { repo: "my-repo" });
      const body = parseResourceResult(result);

      expect(body.error).toContain("has no graph");
    });

    it("should handle cypher errors gracefully", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "repo-1",
          name: "my-repo",
          url: "https://github.com/test/repo",
          source_type: "git_url",
          default_branch: "main",
          graph_name: "repo_graph_1",
          project_id: "proj-1",
          last_indexed_at: null,
          created_at: "2025-12-01T00:00:00Z",
        }],
      });

      // node counts - fail
      mockCypher.mockRejectedValueOnce(new Error("Graph error"));

      // edge counts - fail
      mockCypher.mockRejectedValueOnce(new Error("Graph error"));

      // file count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "10" }] });

      const resource = getResource(server, "repo-stats");
      const result = await resource.handler("nexgraph://repos/my-repo/stats", { repo: "my-repo" });
      const body = parseResourceResult(result);

      // Should still return data with zero counts
      expect(body.total_nodes).toBe(0);
      expect(body.total_edges).toBe(0);
      expect(body.file_count).toBe(10);
    });
  });

  // ─── connections ─────────────────────────────────────────

  describe("connections resource", () => {
    it("should return cross-repo connection rules", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "conn-1",
            source_repo_id: "repo-1",
            target_repo_id: "repo-2",
            connection_type: "package_dependency",
            match_rules: { pattern: "^@shared/" },
            last_resolved_at: "2026-01-01T00:00:00Z",
            source_repo_name: "my-repo",
            target_repo_name: "other-repo",
            edge_count: "15",
          },
        ],
      });

      const resource = getResource(server, "connections");
      const result = await resource.handler("nexgraph://connections");
      const body = parseResourceResult(result);

      expect(body.connections).toHaveLength(1);
      expect(body.connections[0].source_repo).toBe("my-repo");
      expect(body.connections[0].target_repo).toBe("other-repo");
      expect(body.connections[0].connection_type).toBe("package_dependency");
      expect(body.connections[0].edge_count).toBe(15);
    });

    it("should return empty connections when none exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const resource = getResource(server, "connections");
      const result = await resource.handler("nexgraph://connections");
      const body = parseResourceResult(result);

      expect(body.connections).toEqual([]);
    });
  });
});
