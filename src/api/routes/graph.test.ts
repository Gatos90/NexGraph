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

const mockAnalyzeChanges = vi.hoisted(() => vi.fn());
vi.mock("../../ingestion/diff-impact.js", () => ({
  analyzeChanges: mockAnalyzeChanges,
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

import { graphRoutes } from "./graph.js";

const REPO_ID = "11111111-2222-3333-4444-555555555555";
const GRAPH_NAME = "proj_aaa_repo_111";

const repoRow = {
  id: REPO_ID,
  project_id: PROJECT_ID,
  graph_name: GRAPH_NAME,
};

const repoRowNoGraph = {
  id: REPO_ID,
  project_id: PROJECT_ID,
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

// ---- Cypher endpoint ----

describe("POST /api/v1/repositories/:repoId/graph/cypher", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should execute a Cypher query and return results", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([{ result: makeVertex(1, "Function") }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/cypher`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "MATCH (n) RETURN n LIMIT 1",
          columns: [{ name: "result" }],
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.rows).toHaveLength(1);
    expect(body.columns).toEqual(["result"]);
    expect(body.row_count).toBe(1);
  });

  it("should return 404 when repo not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/cypher`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "MATCH (n) RETURN n" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("should return 404 when repo has no graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/cypher`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "MATCH (n) RETURN n" }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("no graph");
  });

  it("should return 400 when Cypher query fails", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockRejectedValueOnce(new Error("syntax error in Cypher"));

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/cypher`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "INVALID CYPHER" }),
      },
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain("syntax error");
  });

  it("should use default column name when columns not provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/cypher`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "MATCH (n) RETURN n" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.columns).toEqual(["result"]);
    // Verify cypher was called with default columns
    expect(mockCypher).toHaveBeenCalledWith(
      GRAPH_NAME,
      "MATCH (n) RETURN n",
      undefined,
      [{ name: "result" }],
    );
  });
});

// ---- Impact analysis ----

describe("POST /api/v1/repositories/:repoId/graph/impact", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should return impact analysis results", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const rootVertex = makeVertex(100, "Function", {
      name: "handleRequest",
      file_path: "src/handler.ts",
    });

    // First cypher call: find root symbol
    mockCypher.mockResolvedValueOnce([{ n: rootVertex }]);

    // Impact traversal: 3 edge types × 2 directions = 6 queries
    const callerVertex = makeVertex(200, "Function", {
      name: "main",
      file_path: "src/index.ts",
    });
    // CALLS callers
    mockCypher.mockResolvedValueOnce([{ n: callerVertex }]);
    // CALLS callees
    mockCypher.mockResolvedValueOnce([]);
    // EXTENDS callers
    mockCypher.mockResolvedValueOnce([]);
    // EXTENDS callees
    mockCypher.mockResolvedValueOnce([]);
    // IMPLEMENTS callers
    mockCypher.mockResolvedValueOnce([]);
    // IMPLEMENTS callees
    mockCypher.mockResolvedValueOnce([]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: "handleRequest",
          direction: "both",
          depth: 3,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.root.id).toBe(100);
    expect(body.affected).toHaveLength(1);
    expect(body.affected[0].name).toBe("main");
    expect(body.affected[0].relationship_type).toBe("CALLS");
    expect(body.summary.total_affected).toBe(1);
    expect(body.summary.by_relationship_type.CALLS).toBe(1);
  });

  it("should return 404 when symbol not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]); // symbol lookup returns nothing

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "nonexistent" }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("nonexistent");
  });

  it("should return 404 when repo has no graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "foo" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("should deduplicate affected nodes across edge types", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const rootVertex = makeVertex(100, "Function", { name: "root" });
    const sharedVertex = makeVertex(200, "Class", { name: "Shared" });

    // Root lookup
    mockCypher.mockResolvedValueOnce([{ n: rootVertex }]);
    // CALLS callers - returns sharedVertex
    mockCypher.mockResolvedValueOnce([{ n: sharedVertex }]);
    // CALLS callees
    mockCypher.mockResolvedValueOnce([]);
    // EXTENDS callers - returns same sharedVertex again
    mockCypher.mockResolvedValueOnce([{ n: sharedVertex }]);
    // EXTENDS callees
    mockCypher.mockResolvedValueOnce([]);
    // IMPLEMENTS callers
    mockCypher.mockResolvedValueOnce([]);
    // IMPLEMENTS callees
    mockCypher.mockResolvedValueOnce([]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "root", direction: "both", depth: 3 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    // Should appear only once (deduplication by node ID)
    expect(body.affected).toHaveLength(1);
  });

  it("should only traverse callers when direction is callers", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const rootVertex = makeVertex(100, "Function", { name: "root" });
    mockCypher.mockResolvedValueOnce([{ n: rootVertex }]);

    // CALLS callers only (backward)
    mockCypher.mockResolvedValueOnce([]);
    // EXTENDS callers only (backward)
    mockCypher.mockResolvedValueOnce([]);
    // IMPLEMENTS callers only (backward)
    mockCypher.mockResolvedValueOnce([]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: "root",
          direction: "callers",
          depth: 2,
        }),
      },
    );

    expect(res.status).toBe(200);
    // Only 3 edge types × 1 direction = 3 cypher calls after root lookup
    // (plus 1 for root = 4 total)
    expect(mockCypher).toHaveBeenCalledTimes(4);
  });
});

// ---- Dependency tree ----

describe("POST /api/v1/repositories/:repoId/graph/dependencies", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should return file-level dependency tree", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const rootFile = makeVertex(10, "File", { path: "src/index.ts" });
    const importedFile = makeVertex(20, "File", { path: "src/utils.ts" });
    const importerFile = makeVertex(30, "File", { path: "src/main.ts" });

    // Find root file
    mockCypher.mockResolvedValueOnce([{ n: rootFile }]);
    // Outgoing imports
    mockCypher.mockResolvedValueOnce([{ m: importedFile }]);
    // Incoming imports
    mockCypher.mockResolvedValueOnce([{ m: importerFile }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/dependencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: "src/index.ts", depth: 1 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.type).toBe("file");
    expect(body.root.id).toBe(10);
    expect(body.imports).toHaveLength(1);
    expect(body.imported_by).toHaveLength(1);
  });

  it("should return symbol-level dependency tree", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const rootSymbol = makeVertex(10, "Function", {
      name: "doWork",
      file_path: "src/worker.ts",
    });
    const calledSymbol = makeVertex(20, "Function", {
      name: "helper",
      file_path: "src/helpers.ts",
    });
    const callerSymbol = makeVertex(30, "Function", {
      name: "main",
      file_path: "src/index.ts",
    });

    // Find root symbol
    mockCypher.mockResolvedValueOnce([{ n: rootSymbol }]);
    // Outgoing calls
    mockCypher.mockResolvedValueOnce([{ m: calledSymbol }]);
    // Incoming calls
    mockCypher.mockResolvedValueOnce([{ m: callerSymbol }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/dependencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "doWork", depth: 1 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.type).toBe("symbol");
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].name).toBe("helper");
    expect(body.called_by).toHaveLength(1);
    expect(body.called_by[0].name).toBe("main");
  });

  it("should return 400 when neither file_path nor symbol provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/dependencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depth: 1 }),
      },
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain("file_path or symbol");
  });

  it("should return 404 when file not found in graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]); // file not found

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/dependencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: "nonexistent.ts" }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("nonexistent.ts");
  });

  it("should return 404 when symbol not found in graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]); // symbol not found

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/dependencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "nonexistentFn" }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("nonexistentFn");
  });
});

// ---- Path finding ----

describe("POST /api/v1/repositories/:repoId/graph/path", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should find a path between two symbols", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const fromNode = makeVertex(1, "Function", { name: "start" });
    const toNode = makeVertex(3, "Function", { name: "end" });
    const middleNode = makeVertex(2, "Function", { name: "middle" });
    const edge1 = makeEdge(10, "CALLS", 1, 2);
    const edge2 = makeEdge(11, "CALLS", 2, 3);

    // Resolve "from" node
    mockCypher.mockResolvedValueOnce([{ n: fromNode }]);
    // Resolve "to" node
    mockCypher.mockResolvedValueOnce([{ n: toNode }]);
    // Depth 1 - no path
    mockCypher.mockResolvedValueOnce([]);
    // Depth 2 - found path
    mockCypher.mockResolvedValueOnce([
      { p: [fromNode, edge1, middleNode, edge2, toNode] },
    ]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/path`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "start", to: "end", max_depth: 5 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toHaveLength(2);
    expect(body.length).toBe(2);
  });

  it("should return same node with no edges when from === to", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const node = makeVertex(1, "Function", { name: "sameFn" });
    // Resolve "from" and "to" both returning the same node
    mockCypher.mockResolvedValueOnce([{ n: node }]);
    mockCypher.mockResolvedValueOnce([{ n: node }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/path`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "sameFn", to: "sameFn" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodes).toHaveLength(1);
    expect(body.edges).toHaveLength(0);
    expect(body.length).toBe(0);
  });

  it("should return 404 when from symbol not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]); // from not found

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/path`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "missing", to: "something" }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("missing");
  });

  it("should return 404 when to symbol not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    const fromNode = makeVertex(1, "Function", { name: "start" });
    mockCypher.mockResolvedValueOnce([{ n: fromNode }]);
    mockCypher.mockResolvedValueOnce([]); // to not found

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/path`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "start", to: "missing" }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("missing");
  });

  it("should return 404 when no path found within max_depth", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const fromNode = makeVertex(1, "Function", { name: "a" });
    const toNode = makeVertex(2, "Function", { name: "b" });

    mockCypher.mockResolvedValueOnce([{ n: fromNode }]);
    mockCypher.mockResolvedValueOnce([{ n: toNode }]);
    // All depths return empty
    mockCypher.mockResolvedValue([]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/path`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "a", to: "b", max_depth: 2 }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("No path found");
  });
});

// ---- List nodes ----

describe("GET /api/v1/repositories/:repoId/graph/nodes", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should list all nodes", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([
      { n: makeVertex(1, "Function") },
      { n: makeVertex(2, "Class") },
    ]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/nodes`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodes).toHaveLength(2);
    expect(body.count).toBe(2);
  });

  it("should filter nodes by label", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([{ n: makeVertex(1, "Function") }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/nodes?label=Function`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    // Verify Cypher query includes the label filter
    expect(mockCypher).toHaveBeenCalledWith(
      GRAPH_NAME,
      expect.stringContaining(":Function"),
      undefined,
      [{ name: "n" }],
    );
  });

  it("should return 400 for invalid label identifier", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/nodes?label=invalid-label!`,
      { method: "GET" },
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain("Invalid label");
  });

  it("should return 404 for repo without graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/nodes`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
  });
});

// ---- List edges ----

describe("GET /api/v1/repositories/:repoId/graph/edges", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should list all edges", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const v1 = makeVertex(1, "Function");
    const v2 = makeVertex(2, "Function");
    const e = makeEdge(10, "CALLS", 1, 2);

    mockCypher.mockResolvedValueOnce([{ a: v1, e, b: v2 }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/edges`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].edge.label).toBe("CALLS");
    expect(body.count).toBe(1);
  });

  it("should filter edges by type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/edges?type=IMPORTS`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    expect(mockCypher).toHaveBeenCalledWith(
      GRAPH_NAME,
      expect.stringContaining(":IMPORTS"),
      undefined,
      expect.any(Array),
    );
  });

  it("should return 400 for invalid edge type identifier", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/edges?type=bad-type!`,
      { method: "GET" },
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain("Invalid edge type");
  });
});

// ---- Node detail ----

describe("GET /api/v1/repositories/:repoId/graph/nodes/:nodeId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should return node with relationships", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const node = makeVertex(42, "Function", { name: "myFunc" });
    const targetNode = makeVertex(43, "Function", { name: "calledFunc" });
    const sourceNode = makeVertex(44, "Class", { name: "MyClass" });
    const outEdge = makeEdge(100, "CALLS", 42, 43);
    const inEdge = makeEdge(101, "DEFINES", 44, 42);

    // Fetch node
    mockCypher.mockResolvedValueOnce([{ n: node }]);
    // Outgoing
    mockCypher.mockResolvedValueOnce([{ e: outEdge, m: targetNode }]);
    // Incoming
    mockCypher.mockResolvedValueOnce([{ m: sourceNode, e: inEdge }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/nodes/42`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.node.id).toBe(42);
    expect(body.relationships.outgoing).toHaveLength(1);
    expect(body.relationships.incoming).toHaveLength(1);
  });

  it("should return 404 when node not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]); // node not found

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/nodes/999`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("Node not found");
  });

  it("should return 400 for non-numeric nodeId", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/nodes/abc`,
      { method: "GET" },
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain("numeric");
  });
});

// ---- Graph stats ----

describe("GET /api/v1/repositories/:repoId/graph/stats", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should return node and edge counts by type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    // 15 node labels + 11 edge labels = 26 cypher calls
    // File=5, Folder=0, Function=10, Class=3, Interface=0, Method=8, CodeElement=0, RouteHandler=2, Struct=0, Enum=0, Trait=0, TypeAlias=0, Namespace=0, Community=0, Process=0
    const nodeCounts = [5, 0, 10, 3, 0, 8, 0, 2, 0, 0, 0, 0, 0, 0, 0];
    // DEFINES=10, CONTAINS=5, EXPOSES=2, CALLS=15, IMPORTS=7, EXTENDS=1, IMPLEMENTS=0, OVERRIDES=0, HANDLES=0, MEMBER_OF=0, STEP_IN_PROCESS=0
    const edgeCounts = [10, 5, 2, 15, 7, 1, 0, 0, 0, 0, 0];

    for (const cnt of nodeCounts) {
      mockCypher.mockResolvedValueOnce([{ cnt }]);
    }
    for (const cnt of edgeCounts) {
      mockCypher.mockResolvedValueOnce([{ cnt }]);
    }

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/stats`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodes.File).toBe(5);
    expect(body.nodes.Function).toBe(10);
    expect(body.nodes.Folder).toBeUndefined(); // 0 count nodes are omitted
    expect(body.edges.CALLS).toBe(15);
    expect(body.total_nodes).toBe(28);
    expect(body.total_edges).toBe(40);
  });

  it("should return 404 when repo has no graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/stats`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
  });
});

// ---- Orphans ----

describe("GET /api/v1/repositories/:repoId/graph/orphans", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should return orphan nodes across default labels", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const orphan1 = makeVertex(1, "Function", {
      name: "unusedFn",
      file_path: "src/unused.ts",
    });
    // 5 default SYMBOL_LABELS queries
    mockCypher.mockResolvedValueOnce([{ n: orphan1 }]); // Function
    mockCypher.mockResolvedValueOnce([]); // Class
    mockCypher.mockResolvedValueOnce([]); // Interface
    mockCypher.mockResolvedValueOnce([]); // Method
    mockCypher.mockResolvedValueOnce([]); // CodeElement

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/orphans`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.orphans).toHaveLength(1);
    expect(body.orphans[0].name).toBe("unusedFn");
    expect(body.count).toBe(1);
  });

  it("should filter orphans by specific label", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockCypher.mockResolvedValueOnce([]); // only Class label queried

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/orphans?label=Class`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    // Only one cypher call for the specific label
    expect(mockCypher).toHaveBeenCalledTimes(1);
    expect(mockCypher).toHaveBeenCalledWith(
      GRAPH_NAME,
      expect.stringContaining(":Class"),
      undefined,
      [{ name: "n" }],
    );
  });

  it("should return 400 for invalid label", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/orphans?label=bad-label`,
      { method: "GET" },
    );

    expect(res.status).toBe(400);
  });
});

// ---- Routes (HTTP handlers) ----

describe("GET /api/v1/repositories/:repoId/graph/routes", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
  });

  it("should return HTTP route handlers", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const routeNode = makeVertex(1, "RouteHandler", {
      http_method: "GET",
      url_pattern: "/api/users",
      framework: "express",
      handler_name: "getUsers",
      start_line: 42,
    });
    const fileNode = makeVertex(2, "File", {
      path: "src/routes/users.ts",
    });

    mockCypher.mockResolvedValueOnce([{ r: routeNode, f: fileNode }]);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/routes`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0].http_method).toBe("GET");
    expect(body.routes[0].url_pattern).toBe("/api/users");
    expect(body.routes[0].framework).toBe("express");
    expect(body.routes[0].handler_name).toBe("getUsers");
    expect(body.routes[0].file_path).toBe("src/routes/users.ts");
    expect(body.routes[0].start_line).toBe(42);
    expect(body.count).toBe(1);
  });

  it("should return 404 for repo without graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/routes`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
  });
});

// ─── POST /repositories/:repoId/graph/diff-impact ───────────

describe("POST /api/v1/repositories/:repoId/graph/diff-impact", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCypher.mockReset();
    mockAnalyzeChanges.mockReset();
  });

  it("should return diff impact analysis results", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const mockResult = {
      changed_files: [
        { filePath: "src/index.ts", addedLines: [10], removedLines: [5], hunks: [], additions: 1, deletions: 1 },
      ],
      direct_symbols: [
        { id: 1, name: "handleRequest", label: "Function", filePath: "src/index.ts", line: 10 },
      ],
      impacted_symbols: [],
      affected_processes: [],
      risk: "LOW",
      summary: "1 file(s) changed — Risk: LOW",
    };
    mockAnalyzeChanges.mockResolvedValueOnce(mockResult);

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/diff-impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all", max_depth: 3 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.risk).toBe("LOW");
    expect(body.direct_symbols).toHaveLength(1);
    expect(body.summary).toContain("Risk: LOW");

    expect(mockAnalyzeChanges).toHaveBeenCalledWith(
      REPO_ID,
      GRAPH_NAME,
      { scope: "all", compareRef: undefined, maxDepth: 3 },
    );
  });

  it("should return 404 for repo without graph", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRowNoGraph] });

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/diff-impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("should return 404 when analysis fails", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockAnalyzeChanges.mockRejectedValueOnce(new Error("Not a git repository"));

    const res = await graphRoutes.request(
      `/api/v1/repositories/${REPO_ID}/graph/diff-impact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toBe("Not a git repository");
  });
});
