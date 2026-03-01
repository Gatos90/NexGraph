import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

const mockQuery = vi.hoisted(() => vi.fn());
const mockResolveUrlPathMatching = vi.hoisted(() => vi.fn());
const mockResolveTypeMatching = vi.hoisted(() => vi.fn());
const mockResolvePackageDependencies = vi.hoisted(() => vi.fn());

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

vi.mock("../../ingestion/urlmatch.js", () => ({
  resolveUrlPathMatching: mockResolveUrlPathMatching,
}));

vi.mock("../../ingestion/typematch.js", () => ({
  resolveTypeMatching: mockResolveTypeMatching,
}));

vi.mock("../../ingestion/pkgmatch.js", () => ({
  resolvePackageDependencies: mockResolvePackageDependencies,
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

import { connectionRoutes } from "./connections.js";

const CONN_ID = "cccccccc-dddd-eeee-ffff-111111111111";
const REPO_A_ID = "11111111-2222-3333-4444-555555555555";
const REPO_B_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";

beforeEach(() => {
  mockQuery.mockReset();
  mockResolveUrlPathMatching.mockReset();
  mockResolveTypeMatching.mockReset();
  mockResolvePackageDependencies.mockReset();
});

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

function mockConnectionQuery(
  connType: string,
  exists: boolean = true,
) {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    // Load connection rule (SELECT ... FROM repo_connections WHERE id = $1)
    if (sql.includes("FROM repo_connections") && sql.includes("WHERE id")) {
      if (!exists) return { rows: [] };
      return {
        rows: [
          {
            id: CONN_ID,
            project_id: PROJECT_ID,
            source_repo_id: REPO_A_ID,
            target_repo_id: REPO_B_ID,
            connection_type: connType,
          },
        ],
      };
    }
    // UPDATE last_resolved_at
    if (sql.includes("UPDATE repo_connections SET last_resolved_at")) {
      return { rowCount: 1 };
    }
    // Verify repo in project
    if (sql.includes("FROM repositories WHERE id")) {
      return { rows: [{ id: params?.[0] }] };
    }
    return { rows: [] };
  });
}

// ─── Auto-re-resolution Trigger Tests ────────────────────────

describe("POST /api/v1/projects/:projectId/connections/:connId/resolve", () => {
  const resolvePath = `/api/v1/projects/${PROJECT_ID}/connections/${CONN_ID}/resolve`;

  it("returns 404 when connection not found", async () => {
    mockConnectionQuery("CROSS_REPO_CALLS", false);

    const res = await connectionRoutes.request(
      makeRequest("POST", resolvePath),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("not found");
  });

  it("dispatches to resolveUrlPathMatching for CROSS_REPO_CALLS", async () => {
    mockConnectionQuery("CROSS_REPO_CALLS");
    mockResolveUrlPathMatching.mockResolvedValue({
      edgesCreated: 5,
      callsDetected: 20,
      routesLoaded: 10,
    });

    const res = await connectionRoutes.request(
      makeRequest("POST", resolvePath),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);

    expect(mockResolveUrlPathMatching).toHaveBeenCalledWith(
      CONN_ID,
      REPO_A_ID,
      REPO_B_ID,
      PROJECT_ID,
    );
    expect(body.connection_id).toBe(CONN_ID);
    expect(body.edges_created).toBe(5);
    expect(body.strategy).toBe("url_path_matching");
    expect(body.details).toEqual({
      calls_detected: 20,
      routes_loaded: 10,
    });
  });

  it("dispatches to resolveTypeMatching for CROSS_REPO_MIRRORS", async () => {
    mockConnectionQuery("CROSS_REPO_MIRRORS");
    mockResolveTypeMatching.mockResolvedValue({
      edgesCreated: 3,
      sourceTypesLoaded: 15,
      targetTypesLoaded: 12,
      matchesFound: 3,
    });

    const res = await connectionRoutes.request(
      makeRequest("POST", resolvePath),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);

    expect(mockResolveTypeMatching).toHaveBeenCalledWith(
      CONN_ID,
      REPO_A_ID,
      REPO_B_ID,
      PROJECT_ID,
    );
    expect(body.connection_id).toBe(CONN_ID);
    expect(body.edges_created).toBe(3);
    expect(body.strategy).toBe("type_matching");
    expect(body.details).toEqual({
      source_types_loaded: 15,
      target_types_loaded: 12,
      matches_found: 3,
    });
  });

  it("dispatches to resolvePackageDependencies for CROSS_REPO_DEPENDS", async () => {
    mockConnectionQuery("CROSS_REPO_DEPENDS");
    mockResolvePackageDependencies.mockResolvedValue({
      edgesCreated: 2,
      dependenciesFound: 30,
      reposScanned: 1,
      matchesFound: 2,
    });

    const res = await connectionRoutes.request(
      makeRequest("POST", resolvePath),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);

    expect(mockResolvePackageDependencies).toHaveBeenCalledWith(
      CONN_ID,
      REPO_A_ID,
      REPO_B_ID,
      PROJECT_ID,
    );
    expect(body.connection_id).toBe(CONN_ID);
    expect(body.edges_created).toBe(2);
    expect(body.strategy).toBe("package_dependency_matching");
    expect(body.details).toEqual({
      dependencies_found: 30,
      repos_scanned: 1,
      matches_found: 2,
    });
  });

  it("returns 422 for unsupported connection types (e.g., CROSS_REPO_IMPORTS)", async () => {
    mockConnectionQuery("CROSS_REPO_IMPORTS");

    const res = await connectionRoutes.request(
      makeRequest("POST", resolvePath),
    );

    expect(res.status).toBe(422);
    const body = await jsonBody(res);
    expect(body.error).toContain("No resolution strategy");
  });

  it("updates last_resolved_at on successful resolution", async () => {
    mockConnectionQuery("CROSS_REPO_CALLS");
    mockResolveUrlPathMatching.mockResolvedValue({
      edgesCreated: 1,
      callsDetected: 5,
      routesLoaded: 3,
    });

    await connectionRoutes.request(
      makeRequest("POST", resolvePath),
    );

    // Verify UPDATE query was called with last_resolved_at = NOW()
    const updateCalls = mockQuery.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("last_resolved_at"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 422 when resolution strategy throws", async () => {
    mockConnectionQuery("CROSS_REPO_CALLS");
    mockResolveUrlPathMatching.mockRejectedValue(
      new Error("Source or target repository has not been indexed (no graph)"),
    );

    const res = await connectionRoutes.request(
      makeRequest("POST", resolvePath),
    );

    expect(res.status).toBe(422);
    const body = await jsonBody(res);
    expect(body.error).toContain("not been indexed");
  });

  it("returns 403 when project ID does not match auth context", async () => {
    const wrongProjectId = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
    const wrongPath = `/api/v1/projects/${wrongProjectId}/connections/${CONN_ID}/resolve`;

    const res = await connectionRoutes.request(
      makeRequest("POST", wrongPath),
    );

    expect(res.status).toBe(403);
  });
});

// ─── Connection CRUD Smoke Tests ─────────────────────────────

describe("POST /api/v1/projects/:projectId/connections (create)", () => {
  const createPath = `/api/v1/projects/${PROJECT_ID}/connections`;

  it("creates a connection rule successfully", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM repositories WHERE id")) {
        return { rows: [{ id: "some-id" }] };
      }
      if (sql.includes("INSERT INTO repo_connections")) {
        return {
          rows: [
            {
              id: CONN_ID,
              project_id: PROJECT_ID,
              source_repo_id: REPO_A_ID,
              target_repo_id: REPO_B_ID,
              connection_type: "CROSS_REPO_CALLS",
              match_rules: {},
              created_at: "2026-01-01",
              updated_at: "2026-01-01",
              last_resolved_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await connectionRoutes.request(
      makeRequest("POST", createPath, {
        source_repo_id: REPO_A_ID,
        target_repo_id: REPO_B_ID,
        connection_type: "CROSS_REPO_CALLS",
        match_rules: {},
      }),
    );

    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.id).toBe(CONN_ID);
    expect(body.connection_type).toBe("CROSS_REPO_CALLS");
  });

  it("returns 404 when source repo not found", async () => {
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM repositories WHERE id")) {
        // source repo not found, target found
        if (params?.[0] === REPO_A_ID) return { rows: [] };
        return { rows: [{ id: params?.[0] }] };
      }
      return { rows: [] };
    });

    const res = await connectionRoutes.request(
      makeRequest("POST", createPath, {
        source_repo_id: REPO_A_ID,
        target_repo_id: REPO_B_ID,
        connection_type: "CROSS_REPO_CALLS",
      }),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("Source repository not found");
  });
});

// ─── Delete Connection Tests ─────────────────────────────────

describe("DELETE /api/v1/projects/:projectId/connections/:connId", () => {
  const deletePath = `/api/v1/projects/${PROJECT_ID}/connections/${CONN_ID}`;

  it("deletes the connection and its edges", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("FROM repo_connections")) {
        return {
          rows: [
            {
              id: CONN_ID,
              project_id: PROJECT_ID,
              source_repo_id: REPO_A_ID,
              target_repo_id: REPO_B_ID,
              connection_type: "CROSS_REPO_CALLS",
            },
          ],
        };
      }
      if (sql.includes("DELETE FROM cross_repo_edges")) {
        return { rowCount: 3 };
      }
      if (sql.includes("DELETE FROM repo_connections")) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    });

    const res = await connectionRoutes.request(
      makeRequest("DELETE", deletePath),
    );

    expect(res.status).toBe(204);

    // Verify cross_repo_edges were deleted
    const edgeDeleteCalls = mockQuery.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("DELETE FROM cross_repo_edges"),
    );
    expect(edgeDeleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 404 when connection not found", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM repo_connections")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await connectionRoutes.request(
      makeRequest("DELETE", deletePath),
    );

    expect(res.status).toBe(404);
  });
});
