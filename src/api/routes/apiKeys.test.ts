import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

const mockQuery = vi.hoisted(() => vi.fn());
const mockCreateApiKey = vi.hoisted(() => vi.fn());

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
}));

// Mock createApiKey
vi.mock("../keys.js", () => ({
  createApiKey: mockCreateApiKey,
  validateApiKey: vi.fn(),
}));

// Auth mock - auto-authenticate with write permissions
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

import { apiKeyRoutes } from "./apiKeys.js";

const KEY_ID = "11111111-2222-3333-4444-555555555555";

describe("POST /api/v1/projects/:projectId/api-keys", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateApiKey.mockReset();
  });

  it("should generate a new API key", async () => {
    mockCreateApiKey.mockResolvedValueOnce({
      id: KEY_ID,
      rawKey: "nxg_" + "a".repeat(64),
      keyPrefix: "nxg_aaaa",
      label: "test-key",
      permissions: ["read", "write"],
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/api-keys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "test-key",
          permissions: ["read", "write"],
        }),
      },
    );

    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.id).toBe(KEY_ID);
    expect(body.key).toMatch(/^nxg_/);
    expect(body.label).toBe("test-key");
    expect(body.permissions).toEqual(["read", "write"]);
  });

  it("should create a read-only API key", async () => {
    mockCreateApiKey.mockResolvedValueOnce({
      id: KEY_ID,
      rawKey: "nxg_" + "b".repeat(64),
      keyPrefix: "nxg_bbbb",
      label: "readonly",
      permissions: ["read"],
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/api-keys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "readonly",
          permissions: ["read"],
        }),
      },
    );

    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.permissions).toEqual(["read"]);

    // Verify createApiKey was called with correct args
    expect(mockCreateApiKey).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      label: "readonly",
      permissions: ["read"],
      expiresAt: undefined,
    });
  });

  it("should return 403 when projectId doesn't match auth context", async () => {
    const differentId = "11111111-2222-3333-4444-555555555555";
    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${differentId}/api-keys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: ["read"] }),
      },
    );

    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/projects/:projectId/api-keys", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should list API keys for the project (prefix only)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: KEY_ID,
          key_prefix: "nxg_aaaa",
          label: "primary",
          permissions: ["read", "write"],
          revoked: false,
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "22222222-3333-4444-5555-666666666666",
          key_prefix: "nxg_bbbb",
          label: "readonly",
          permissions: ["read"],
          revoked: false,
          expires_at: null,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/api-keys`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.api_keys).toHaveLength(2);
    expect(body.api_keys[0].key_prefix).toBe("nxg_aaaa");
    // Ensure no full key is exposed
    expect(body.api_keys[0]).not.toHaveProperty("key");
    expect(body.api_keys[0]).not.toHaveProperty("key_hash");
  });

  it("should return 403 when projectId doesn't match", async () => {
    const differentId = "11111111-2222-3333-4444-555555555555";
    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${differentId}/api-keys`,
      { method: "GET" },
    );

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/projects/:projectId/api-keys/:keyId", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should revoke an API key and return 204", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: KEY_ID }] });

    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/api-keys/${KEY_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(204);

    // Verify the revoke query
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET revoked = TRUE"),
      [KEY_ID, PROJECT_ID],
    );
  });

  it("should return 404 when key not found or already revoked", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/api-keys/${KEY_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.error).toContain("not found or already revoked");
  });

  it("should return 403 when projectId doesn't match", async () => {
    const differentId = "11111111-2222-3333-4444-555555555555";
    const res = await apiKeyRoutes.request(
      `/api/v1/projects/${differentId}/api-keys/${KEY_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(403);
  });
});
