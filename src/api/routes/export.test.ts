import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

const mockQuery = vi.hoisted(() => vi.fn());
const mockCypher = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  config: {
    API_PREFIX: "/api/v1",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
}));

vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../db/index.js", () => ({
  pool: { query: mockQuery },
}));

vi.mock("../../db/age.js", () => ({
  cypher: mockCypher,
}));

const PROJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("projectId", PROJECT_ID);
      c.set("apiKeyId", "key-1");
      c.set("keyPermissions", ["read", "write"]);
      await next();
    };
  },
}));

import { exportRoutes } from "./export.js";

const REPO_ID = "11111111-2222-3333-4444-555555555555";
const GRAPH_NAME = "proj_aaa_repo_111";

const repoRow = {
  id: REPO_ID,
  project_id: PROJECT_ID,
  name: "my-repo",
  graph_name: GRAPH_NAME,
};

const repoRowNoGraph = {
  id: REPO_ID,
  project_id: PROJECT_ID,
  name: "my-repo",
  graph_name: null,
};

function makeVertex(
  id: number,
  label: string,
  props: Record<string, unknown> = {},
) {
  return { id, label, properties: { name: `node_${id}`, ...props } };
}

function makeEdge(
  id: number,
  label: string,
  startId: number,
  endId: number,
  props: Record<string, unknown> = {},
) {
  return { id, label, start_id: startId, end_id: endId, properties: props };
}

// ---- JSON export ----

describe("GET /api/v1/repositories/:repoId/export/json", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should export graph as JSON with nodes and edges", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const v1 = makeVertex(1, "Function", { name: "foo", file_path: "a.ts" });
    const v2 = makeVertex(2, "Class", { name: "Bar", file_path: "b.ts" });
    const e1 = makeEdge(10, "CALLS", 1, 2);

    // fetchAllNodes
    mockCypher.mockResolvedValueOnce([{ n: v1 }, { n: v2 }]);
    // fetchAllEdges
    mockCypher.mockResolvedValueOnce([{ a: v1, e: e1, b: v2 }]);

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/json`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].label).toBe("CALLS");
    expect(body.metadata.repo_id).toBe(REPO_ID);
    expect(body.metadata.node_count).toBe(2);
    expect(body.metadata.edge_count).toBe(1);
    expect(body.metadata.exported_at).toBeDefined();
  });

  it("should return 404 when repo not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/json`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("not found");
  });

  it("should return 404 when repo has no graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/json`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("no graph");
  });

  it("should return empty arrays for empty graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]); // no nodes
    mockCypher.mockResolvedValueOnce([]); // no edges

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/json`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.metadata.node_count).toBe(0);
    expect(body.metadata.edge_count).toBe(0);
  });
});

// ---- CSV export ----

describe("GET /api/v1/repositories/:repoId/export/csv", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should export graph as CSV strings", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const v1 = makeVertex(1, "Function", {
      name: "foo",
      file_path: "a.ts",
      exported: true,
      kind: "function",
    });
    const v2 = makeVertex(2, "Class", {
      name: "Bar",
      file_path: "b.ts",
      exported: false,
      kind: "class",
    });
    const e1 = makeEdge(10, "CALLS", 1, 2, { confidence: 0.9 });

    mockCypher.mockResolvedValueOnce([{ n: v1 }, { n: v2 }]);
    mockCypher.mockResolvedValueOnce([{ a: v1, e: e1, b: v2 }]);

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/csv`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);

    // Verify CSV structure
    const nodeLines = body.nodes_csv.split("\n");
    expect(nodeLines[0]).toBe(
      "id,label,name,file_path,exported,kind,properties",
    );
    expect(nodeLines).toHaveLength(3); // header + 2 rows

    const edgeLines = body.edges_csv.split("\n");
    expect(edgeLines[0]).toBe(
      "id,label,start_id,end_id,source_name,target_name,properties",
    );
    expect(edgeLines).toHaveLength(2); // header + 1 row

    expect(body.metadata.node_count).toBe(2);
    expect(body.metadata.edge_count).toBe(1);
  });

  it("should properly escape CSV values with commas and quotes", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const v1 = makeVertex(1, "Function", {
      name: 'has, "special" chars',
      file_path: "a.ts",
    });

    mockCypher.mockResolvedValueOnce([{ n: v1 }]);
    mockCypher.mockResolvedValueOnce([]);

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/csv`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    // Values with commas/quotes should be escaped
    expect(body.nodes_csv).toContain('""');
  });

  it("should return 404 when repo has no graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/csv`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
  });
});

// ---- Cypher export ----

describe("GET /api/v1/repositories/:repoId/export/cypher", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should export graph as Cypher CREATE statements", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const v1 = makeVertex(1, "Function", {
      name: "foo",
      file_path: "a.ts",
    });
    const v2 = makeVertex(2, "Class", {
      name: "Bar",
      file_path: "b.ts",
    });
    const e1 = makeEdge(10, "CALLS", 1, 2, { confidence: 0.9 });

    mockCypher.mockResolvedValueOnce([{ n: v1 }, { n: v2 }]);
    mockCypher.mockResolvedValueOnce([{ a: v1, e: e1, b: v2 }]);

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/cypher`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);

    // Should contain node CREATE and edge CREATE statements
    expect(body.cypher).toContain("// Nodes");
    expect(body.cypher).toContain("CREATE (:Function");
    expect(body.cypher).toContain("CREATE (:Class");
    expect(body.cypher).toContain("// Edges");
    expect(body.cypher).toContain("CREATE (a)-[:CALLS");
    expect(body.metadata.node_count).toBe(2);
    expect(body.metadata.edge_count).toBe(1);
  });

  it("should properly escape single quotes in Cypher string values", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const v1 = makeVertex(1, "Function", {
      name: "it's",
      file_path: "a.ts",
    });

    mockCypher.mockResolvedValueOnce([{ n: v1 }]);
    mockCypher.mockResolvedValueOnce([]);

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/cypher`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    // Should escape single quotes
    expect(body.cypher).toContain("\\'");
  });

  it("should return 404 for repo without graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await exportRoutes.request(
      `/api/v1/repositories/${REPO_ID}/export/cypher`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
  });
});

// ---- Full project export ----

describe("GET /api/v1/projects/:projectId/export/full", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should export all repos and cross-repo edges", async () => {
    const repo2Id = "22222222-3333-4444-5555-666666666666";
    const graph2Name = "proj_aaa_repo_222";

    // Fetch repos
    mockQuery.mockResolvedValueOnce({
      rows: [
        repoRow,
        {
          id: repo2Id,
          project_id: PROJECT_ID,
          name: "repo-2",
          graph_name: graph2Name,
        },
      ],
    });

    // Repo 1 nodes and edges
    const v1 = makeVertex(1, "Function");
    mockCypher.mockResolvedValueOnce([{ n: v1 }]); // repo1 nodes
    const e1 = makeEdge(10, "CALLS", 1, 1);
    mockCypher.mockResolvedValueOnce([{ a: v1, e: e1, b: v1 }]); // repo1 edges

    // Repo 2 nodes and edges
    const v2 = makeVertex(2, "Class");
    mockCypher.mockResolvedValueOnce([{ n: v2 }]); // repo2 nodes
    mockCypher.mockResolvedValueOnce([]); // repo2 edges

    // Cross-repo edges
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "cross-1",
          source_repo_id: REPO_ID,
          target_repo_id: repo2Id,
          source_node: "foo",
          target_node: "Bar",
          edge_type: "CALLS",
          metadata: { confidence: 0.8 },
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await exportRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/export/full`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.repositories).toHaveLength(2);
    expect(body.repositories[0].nodes).toHaveLength(1);
    expect(body.repositories[1].nodes).toHaveLength(1);
    expect(body.cross_repo_edges).toHaveLength(1);
    expect(body.cross_repo_edges[0].edge_type).toBe("CALLS");
    expect(body.metadata.repo_count).toBe(2);
    expect(body.metadata.total_nodes).toBe(2);
    expect(body.metadata.cross_repo_edge_count).toBe(1);
  });

  it("should handle repos without graphs in full export", async () => {
    // Fetch repos - one with no graph
    mockQuery.mockResolvedValueOnce({
      rows: [repoRowNoGraph],
    });

    // Cross-repo edges
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await exportRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/export/full`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0].nodes).toEqual([]);
    expect(body.repositories[0].edges).toEqual([]);
    // No cypher calls should have been made for the repo without a graph
    expect(mockCypher).not.toHaveBeenCalled();
  });

  it("should return 403 when projectId does not match auth", async () => {
    const otherProjectId = "99999999-8888-7777-6666-555555555555";

    const res = await exportRoutes.request(
      `/api/v1/projects/${otherProjectId}/export/full`,
      { method: "GET" },
    );

    expect(res.status).toBe(403);
  });

  it("should handle empty project with no repos", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no repos
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no cross-repo edges

    const res = await exportRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/export/full`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.repositories).toEqual([]);
    expect(body.cross_repo_edges).toEqual([]);
    expect(body.metadata.repo_count).toBe(0);
    expect(body.metadata.total_nodes).toBe(0);
    expect(body.metadata.total_edges).toBe(0);
  });
});
