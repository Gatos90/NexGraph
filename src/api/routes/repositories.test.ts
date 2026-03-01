import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

const mockQuery = vi.hoisted(() => vi.fn());
const mockEnsureGraph = vi.hoisted(() => vi.fn());
const mockDropGraph = vi.hoisted(() => vi.fn());
const mockGraphExists = vi.hoisted(() => vi.fn());

// Mock config
vi.mock("../../config.js", () => ({
  config: {
    API_PREFIX: "/api/v1",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
}));

// Mock logger
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock db
vi.mock("../../db/index.js", () => ({
  pool: { query: mockQuery },
  ensureGraph: mockEnsureGraph,
  dropGraph: mockDropGraph,
  graphExists: mockGraphExists,
}));

// Mock auth - auto-authenticate with write permissions
const PROJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("projectId", PROJECT_ID);
      c.set("apiKeyId", "key-1");
      c.set("keyPermissions", ["read", "write"]);
      await next();
    };
  },
}));

import { repositoryRoutes } from "./repositories.js";

const REPO_ID = "11111111-2222-3333-4444-555555555555";

const baseRepoRow = {
  id: REPO_ID,
  project_id: PROJECT_ID,
  name: "my-repo",
  source_type: "git_url",
  url: "https://github.com/example/repo.git",
  default_branch: "main",
  graph_name: null,
  last_indexed_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("POST /api/v1/repositories", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockEnsureGraph.mockReset();
    mockDropGraph.mockReset();
    mockGraphExists.mockReset();
    mockEnsureGraph.mockResolvedValue(undefined);
  });

  it("should create a repository with AGE graph", async () => {
    // INSERT returns the new row
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseRepoRow }] });
    // UPDATE to set graph_name returns updated row
    const withGraph = {
      ...baseRepoRow,
      graph_name: `proj_${PROJECT_ID.replace(/-/g, "_")}_repo_${REPO_ID.replace(/-/g, "_")}`,
    };
    mockQuery.mockResolvedValueOnce({ rows: [withGraph] });

    const res = await repositoryRoutes.request("/api/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "git_url",
        url: "https://github.com/example/repo.git",
      }),
    });

    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.project_id).toBe(PROJECT_ID);
    expect(body.graph_name).toBeTruthy();
    expect(mockEnsureGraph).toHaveBeenCalledOnce();
  });

  it("should return 409 on duplicate repository URL", async () => {
    mockQuery.mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint"),
    );

    const res = await repositoryRoutes.request("/api/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "git_url",
        url: "https://github.com/example/repo.git",
      }),
    });

    expect(res.status).toBe(409);
    const body = await jsonBody(res);
    expect(body.error).toContain("already exists");
  });
});

describe("GET /api/v1/repositories", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should list repositories for the project", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseRepoRow] });

    const res = await repositoryRoutes.request("/api/v1/repositories", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0].id).toBe(REPO_ID);
  });

  it("should return empty array when no repositories", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await repositoryRoutes.request("/api/v1/repositories", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.repositories).toEqual([]);
  });
});

describe("GET /api/v1/repositories/:repoId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should return repository with indexing status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseRepoRow] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          status: "completed",
          started_at: "2026-01-01T00:00:00Z",
          completed_at: "2026-01-01T01:00:00Z",
          files_total: 50,
          files_done: 50,
          error_message: null,
        },
      ],
    });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.id).toBe(REPO_ID);
    expect(body.indexing_status.status).toBe("completed");
    expect(body.indexing_status.files_total).toBe(50);
  });

  it("should return null indexing_status when no jobs exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseRepoRow] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.indexing_status).toBeNull();
  });

  it("should return 404 when repository not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
  });

  it("should return 403 when repo belongs to different project", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { ...baseRepoRow, project_id: "different-project-id" },
      ],
    });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "GET" },
    );

    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/repositories/:repoId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should update repository name", async () => {
    // Ownership check
    mockQuery.mockResolvedValueOnce({
      rows: [{ project_id: PROJECT_ID }],
    });
    // UPDATE query
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...baseRepoRow, name: "new-name" }],
    });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-name" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.name).toBe("new-name");
  });

  it("should return 404 when repo not found for update", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-name" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("should return 403 when repo belongs to different project", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ project_id: "other-project" }],
    });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-name" }),
      },
    );

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/repositories/:repoId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGraphExists.mockReset();
    mockDropGraph.mockReset();
  });

  it("should delete repository and drop AGE graph", async () => {
    const graphName = "proj_aaa_repo_111";
    // Fetch repo
    mockQuery.mockResolvedValueOnce({
      rows: [{ project_id: PROJECT_ID, graph_name: graphName }],
    });
    // Drop graph
    mockGraphExists.mockResolvedValueOnce(true);
    mockDropGraph.mockResolvedValueOnce(undefined);
    // Delete repo
    mockQuery.mockResolvedValueOnce({ rows: [{ id: REPO_ID }] });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(204);
    expect(mockGraphExists).toHaveBeenCalledWith(graphName);
    expect(mockDropGraph).toHaveBeenCalledWith(graphName);
  });

  it("should delete repository without dropping graph when no graph_name", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ project_id: PROJECT_ID, graph_name: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: REPO_ID }] });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(204);
    expect(mockGraphExists).not.toHaveBeenCalled();
    expect(mockDropGraph).not.toHaveBeenCalled();
  });

  it("should return 404 when repo not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
  });

  it("should return 403 when repo belongs to different project", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ project_id: "other-project", graph_name: null }],
    });

    const res = await repositoryRoutes.request(
      `/api/v1/repositories/${REPO_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(403);
  });
});
