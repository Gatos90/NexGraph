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

import { crossRepoRoutes } from "./crossRepo.js";

const REPO_A_ID = "11111111-2222-3333-4444-555555555555";
const REPO_B_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const GRAPH_A = "proj_aaa_repo_a";
const GRAPH_B = "proj_aaa_repo_b";

beforeEach(() => {
  mockQuery.mockReset();
  mockCypher.mockReset();
});

// ─── Helper: make a request to the Hono app ──────────────────

function makeRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Request {
  const opts: RequestInit = { method, headers: {} };
  if (body) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, opts);
}

// ─── Trace Route Tests ───────────────────────────────────────

describe("POST /api/v1/projects/:projectId/graph/cross-repo/trace", () => {
  const tracePath = `/api/v1/projects/${PROJECT_ID}/graph/cross-repo/trace`;

  function setupRepoMap(repos: Array<{ id: string; graph_name: string | null }>) {
    mockQuery.mockImplementation(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM repositories WHERE project_id")) {
        return { rows: repos.map((r) => ({ ...r, project_id: PROJECT_ID })) };
      }
      // cross_repo_edges query
      if (sql.includes("FROM cross_repo_edges")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  }

  it("returns 404 when start repo not found", async () => {
    setupRepoMap([]);

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "UserService",
      }),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("Start repository not found");
  });

  it("returns 404 when start repo has no graph", async () => {
    setupRepoMap([{ id: REPO_A_ID, graph_name: null }]);

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "UserService",
      }),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("no graph");
  });

  it("returns 404 when symbol not found in graph", async () => {
    setupRepoMap([{ id: REPO_A_ID, graph_name: GRAPH_A }]);

    // Symbol lookup returns nothing
    mockCypher.mockResolvedValue([]);

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "NonExistent",
      }),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("not found in repository graph");
  });

  it("returns trace result with start node and empty graph when no connections", async () => {
    setupRepoMap([{ id: REPO_A_ID, graph_name: GRAPH_A }]);

    // Symbol lookup: found
    mockCypher.mockImplementation(async (_graph: string, query: string) => {
      if (query.includes("WHERE n.name = $symbol")) {
        return [
          {
            n: {
              id: 1,
              label: "Function",
              properties: { name: "UserService", file_path: "src/service.ts" },
            },
          },
        ];
      }
      // Local connected symbols: none
      return [];
    });

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "UserService",
        max_depth: 1,
      }),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.start).toMatchObject({
      repo_id: REPO_A_ID,
      symbol_name: "UserService",
      label: "Function",
    });
    expect(body.nodes).toHaveLength(0);
    expect(body.edges).toHaveLength(0);
    expect(body.repos_traversed).toContain(REPO_A_ID);
  });

  it("traces local connections within a repo", async () => {
    setupRepoMap([{ id: REPO_A_ID, graph_name: GRAPH_A }]);

    const cypherCalls: string[] = [];
    mockCypher.mockImplementation(async (_graph: string, query: string) => {
      cypherCalls.push(query);

      // Find start symbol
      if (query.includes("WHERE n.name = $symbol") && query.includes("LIMIT 1")) {
        return [
          {
            n: {
              id: 1,
              label: "Function",
              properties: { name: "UserService", file_path: "src/service.ts" },
            },
          },
        ];
      }

      // Forward CALLS edge: UserService → getUserById
      if (query.includes("(source)-[:CALLS]->(n)")) {
        return [
          {
            n: {
              id: 2,
              label: "Function",
              properties: { name: "getUserById", file_path: "src/repo.ts" },
            },
          },
        ];
      }

      return [];
    });

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "UserService",
        direction: "forward",
        max_depth: 1,
      }),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodes.length).toBeGreaterThanOrEqual(1);

    const localNode = body.nodes.find(
      (n: { symbol_name: string }) => n.symbol_name === "getUserById",
    );
    expect(localNode).toBeDefined();
    expect(localNode.repo_id).toBe(REPO_A_ID);

    // Should have a LOCAL edge
    const localEdge = body.edges.find(
      (e: { to_symbol: string }) => e.to_symbol === "getUserById",
    );
    expect(localEdge).toBeDefined();
    expect(localEdge.cross_repo).toBe(false);
    expect(localEdge.edge_type).toBe("LOCAL");
  });

  it("traces cross-repo edges from the relational table", async () => {
    // Setup: two repos, both indexed
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM repositories WHERE project_id")) {
        return {
          rows: [
            { id: REPO_A_ID, project_id: PROJECT_ID, graph_name: GRAPH_A },
            { id: REPO_B_ID, project_id: PROJECT_ID, graph_name: GRAPH_B },
          ],
        };
      }
      if (sql.includes("FROM cross_repo_edges")) {
        return {
          rows: [
            {
              id: "edge-1",
              project_id: PROJECT_ID,
              source_repo_id: REPO_A_ID,
              target_repo_id: REPO_B_ID,
              source_node: "UserService",
              target_node: "RouteHandler:GET:/api/users",
              edge_type: "CROSS_REPO_CALLS",
              metadata: { confidence: 0.95 },
              created_at: "2026-01-01",
            },
          ],
        };
      }
      return { rows: [] };
    });

    mockCypher.mockImplementation(async (graph: string, query: string) => {
      // Find start symbol in repo A
      if (graph === GRAPH_A && query.includes("LIMIT 1")) {
        return [
          {
            n: {
              id: 1,
              label: "Function",
              properties: { name: "UserService", file_path: "src/service.ts" },
            },
          },
        ];
      }

      // Find target symbol in repo B
      if (graph === GRAPH_B && query.includes("LIMIT 1")) {
        return [
          {
            n: {
              id: 100,
              label: "RouteHandler",
              properties: { name: "RouteHandler:GET:/api/users", file_path: "routes/users.ts" },
            },
          },
        ];
      }

      // No local connections
      return [];
    });

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "UserService",
        direction: "forward",
        max_depth: 2,
      }),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);

    // Should traverse to repo B
    expect(body.repos_traversed).toContain(REPO_A_ID);
    expect(body.repos_traversed).toContain(REPO_B_ID);

    // Should have a cross-repo edge
    const crossEdge = body.edges.find(
      (e: { cross_repo: boolean }) => e.cross_repo === true,
    );
    expect(crossEdge).toBeDefined();
    expect(crossEdge.edge_type).toBe("CROSS_REPO_CALLS");
    expect(crossEdge.from_repo_id).toBe(REPO_A_ID);
    expect(crossEdge.to_repo_id).toBe(REPO_B_ID);
  });

  it("respects max_depth and stops BFS", async () => {
    setupRepoMap([{ id: REPO_A_ID, graph_name: GRAPH_A }]);

    let callCount = 0;
    mockCypher.mockImplementation(async (_graph: string, query: string) => {
      callCount++;
      if (query.includes("LIMIT 1")) {
        return [
          {
            n: {
              id: callCount,
              label: "Function",
              properties: { name: callCount === 1 ? "start" : `func_${callCount}` },
            },
          },
        ];
      }
      return [];
    });

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "start",
        max_depth: 1,
      }),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.depth_reached).toBeLessThanOrEqual(1);
  });

  it("avoids cycles via visited set", async () => {
    setupRepoMap([{ id: REPO_A_ID, graph_name: GRAPH_A }]);

    mockCypher.mockImplementation(async (_graph: string, query: string) => {
      if (query.includes("LIMIT 1")) {
        return [
          {
            n: {
              id: 1,
              label: "Function",
              properties: { name: "funcA" },
            },
          },
        ];
      }
      // Forward CALLS: funcA → funcB (always)
      if (query.includes("(source)-[:CALLS]->(n)")) {
        return [
          {
            n: {
              id: 2,
              label: "Function",
              properties: { name: "funcB" },
            },
          },
        ];
      }
      return [];
    });

    const res = await crossRepoRoutes.request(
      makeRequest("POST", tracePath, {
        start_repo_id: REPO_A_ID,
        start_symbol: "funcA",
        direction: "forward",
        max_depth: 5,
      }),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    // funcB should appear only once despite being returned every iteration
    const funcBNodes = body.nodes.filter(
      (n: { symbol_name: string }) => n.symbol_name === "funcB",
    );
    expect(funcBNodes).toHaveLength(1);
  });
});

// ─── Impact Route Tests ──────────────────────────────────────

describe("POST /api/v1/projects/:projectId/graph/cross-repo/impact", () => {
  const impactPath = `/api/v1/projects/${PROJECT_ID}/graph/cross-repo/impact`;

  it("returns 404 when repo not found", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await crossRepoRoutes.request(
      makeRequest("POST", impactPath, {
        repo_id: REPO_A_ID,
        symbol: "UserService",
      }),
    );

    expect(res.status).toBe(404);
  });

  it("returns impact result with affected nodes and summary", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM repositories WHERE project_id")) {
        return {
          rows: [
            { id: REPO_A_ID, project_id: PROJECT_ID, graph_name: GRAPH_A },
          ],
        };
      }
      if (sql.includes("FROM cross_repo_edges")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    mockCypher.mockImplementation(async (_graph: string, query: string) => {
      if (query.includes("LIMIT 1")) {
        return [
          {
            n: {
              id: 1,
              label: "Function",
              properties: { name: "UserService", file_path: "src/service.ts" },
            },
          },
        ];
      }
      // Backward callers
      if (query.includes("(n)-[:CALLS]->(target)")) {
        return [
          {
            n: {
              id: 10,
              label: "Function",
              properties: { name: "handleRequest", file_path: "src/handler.ts" },
            },
          },
        ];
      }
      return [];
    });

    const res = await crossRepoRoutes.request(
      makeRequest("POST", impactPath, {
        repo_id: REPO_A_ID,
        symbol: "UserService",
        depth: 1,
      }),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.root.symbol_name).toBe("UserService");
    expect(body.affected.length).toBeGreaterThanOrEqual(1);
    expect(body.summary.total_affected).toBeGreaterThanOrEqual(1);
  });
});

// ─── Stats Route Tests ───────────────────────────────────────

describe("GET /api/v1/projects/:projectId/graph/cross-repo/stats", () => {
  const statsPath = `/api/v1/projects/${PROJECT_ID}/graph/cross-repo/stats`;

  it("returns statistics about cross-repo edges", async () => {
    let callIdx = 0;
    mockQuery.mockImplementation(async () => {
      callIdx++;
      switch (callIdx) {
        case 1: // total edges
          return { rows: [{ count: "5" }] };
        case 2: // total connections
          return { rows: [{ count: "2" }] };
        case 3: // by edge type
          return {
            rows: [
              { edge_type: "CROSS_REPO_CALLS", count: "3" },
              { edge_type: "CROSS_REPO_MIRRORS", count: "2" },
            ],
          };
        case 4: // by repo pair
          return {
            rows: [
              {
                source_repo_id: REPO_A_ID,
                target_repo_id: REPO_B_ID,
                count: "5",
              },
            ],
          };
        case 5: // repos involved
          return { rows: [{ count: "2" }] };
        default:
          return { rows: [] };
      }
    });

    const res = await crossRepoRoutes.request(
      new Request(`http://localhost${statsPath}`, { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.total_edges).toBe(5);
    expect(body.total_connections).toBe(2);
    expect(body.by_edge_type).toEqual({
      CROSS_REPO_CALLS: 3,
      CROSS_REPO_MIRRORS: 2,
    });
    expect(body.by_repo_pair).toHaveLength(1);
    expect(body.repos_involved).toBe(2);
  });
});
