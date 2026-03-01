import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

const mockQuery = vi.hoisted(() => vi.fn());
const mockCreateApiKey = vi.hoisted(() => vi.fn());

// Mock config before any imports that use it
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

// Mock db pool
vi.mock("../../db/index.js", () => ({
  pool: { query: mockQuery },
}));

// Mock API key creation
vi.mock("../keys.js", () => ({
  createApiKey: mockCreateApiKey,
  validateApiKey: vi.fn(),
}));

// Mock auth middleware to bypass auth for CRUD tests
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
  requirePermission: () => {
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  },
}));

// Import after mocks
import { projectRoutes } from "./projects.js";

describe("POST /api/v1/projects", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateApiKey.mockReset();
  });

  it("should create a project and return it with an API key", async () => {
    const projectRow = {
      id: PROJECT_ID,
      name: "My Project",
      description: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [projectRow] });
    mockCreateApiKey.mockResolvedValueOnce({
      id: "key-1",
      rawKey: "nxg_" + "a".repeat(64),
      keyPrefix: "nxg_aaaa",
      label: null,
      permissions: ["read", "write"],
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await projectRoutes.request("/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Project" }),
    });

    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.project.name).toBe("My Project");
    expect(body.project.id).toBe(PROJECT_ID);
    expect(body.api_key.key).toMatch(/^nxg_/);
    expect(body.api_key.permissions).toEqual(["read", "write"]);
  });

  it("should create a project with description", async () => {
    const projectRow = {
      id: PROJECT_ID,
      name: "Described Project",
      description: "A test project",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [projectRow] });
    mockCreateApiKey.mockResolvedValueOnce({
      id: "key-1",
      rawKey: "nxg_" + "b".repeat(64),
      keyPrefix: "nxg_bbbb",
      label: null,
      permissions: ["read", "write"],
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await projectRoutes.request("/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Described Project",
        description: "A test project",
      }),
    });

    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.project.description).toBe("A test project");
  });
});

describe("GET /api/v1/projects", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should list projects for the authenticated project", async () => {
    const projectRow = {
      id: PROJECT_ID,
      name: "My Project",
      description: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [projectRow] });

    const res = await projectRoutes.request("/api/v1/projects", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].id).toBe(PROJECT_ID);
  });

  it("should return empty array when no projects", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await projectRoutes.request("/api/v1/projects", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.projects).toEqual([]);
  });
});

describe("GET /api/v1/projects/:projectId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should return project details", async () => {
    const projectRow = {
      id: PROJECT_ID,
      name: "My Project",
      description: "desc",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [projectRow] });

    const res = await projectRoutes.request(
      `/api/v1/projects/${PROJECT_ID}`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.id).toBe(PROJECT_ID);
    expect(body.name).toBe("My Project");
  });

  it("should return 403 when projectId does not match auth context", async () => {
    const differentId = "11111111-2222-3333-4444-555555555555";
    const res = await projectRoutes.request(
      `/api/v1/projects/${differentId}`,
      { method: "GET" },
    );

    expect(res.status).toBe(403);
  });

  it("should return 404 when project not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await projectRoutes.request(
      `/api/v1/projects/${PROJECT_ID}`,
      { method: "GET" },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toBe("Project not found");
  });
});

describe("PATCH /api/v1/projects/:projectId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should update project name", async () => {
    const updatedRow = {
      id: PROJECT_ID,
      name: "Updated Name",
      description: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [updatedRow] });

    const res = await projectRoutes.request(
      `/api/v1/projects/${PROJECT_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.name).toBe("Updated Name");
  });

  it("should return current project if no fields provided", async () => {
    const projectRow = {
      id: PROJECT_ID,
      name: "My Project",
      description: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [projectRow] });

    const res = await projectRoutes.request(
      `/api/v1/projects/${PROJECT_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(200);
  });

  it("should return 403 when projectId doesn't match", async () => {
    const differentId = "11111111-2222-3333-4444-555555555555";
    const res = await projectRoutes.request(
      `/api/v1/projects/${differentId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "hack" }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("should return 404 when project not found during update", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await projectRoutes.request(
      `/api/v1/projects/${PROJECT_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      },
    );

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/projects/:projectId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should delete a project and return 204", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: PROJECT_ID }] });

    const res = await projectRoutes.request(
      `/api/v1/projects/${PROJECT_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(204);
  });

  it("should return 403 when projectId doesn't match", async () => {
    const differentId = "11111111-2222-3333-4444-555555555555";
    const res = await projectRoutes.request(
      `/api/v1/projects/${differentId}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(403);
  });

  it("should return 404 when project not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await projectRoutes.request(
      `/api/v1/projects/${PROJECT_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
  });
});
