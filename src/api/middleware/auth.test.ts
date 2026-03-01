import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

// Mock validateApiKey before importing auth module
vi.mock("../keys.js", () => ({
  validateApiKey: vi.fn(),
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

import { authMiddleware, requirePermission } from "./auth.js";
import { validateApiKey } from "../keys.js";
import type { AppEnv } from "../../app.js";

function createTestApp() {
  const app = new Hono<AppEnv>();
  return app;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    vi.mocked(validateApiKey).mockReset();
  });

  it("should return 401 when Authorization header is missing", async () => {
    const app = createTestApp();
    app.use("*", authMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe("Missing Authorization header");
  });

  it("should return 401 when Authorization header does not use Bearer scheme", async () => {
    const app = createTestApp();
    app.use("*", authMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe("Authorization header must use Bearer scheme");
  });

  it("should return 401 when key format is invalid (wrong prefix)", async () => {
    const app = createTestApp();
    app.use("*", authMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer bad_" + "a".repeat(64) },
    });
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe("Invalid API key format");
  });

  it("should return 401 when key format is invalid (wrong length)", async () => {
    const app = createTestApp();
    app.use("*", authMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer nxg_tooshort" },
    });
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe("Invalid API key format");
  });

  it("should return 401 when validateApiKey returns null", async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce(null);

    const app = createTestApp();
    app.use("*", authMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    const validKey = "nxg_" + "a".repeat(64);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe("Invalid or expired API key");
  });

  it("should set context variables and call next on valid key", async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({
      id: "key-id-1",
      project_id: "proj-id-1",
      key_hash: "hash",
      key_prefix: "nxg_abcd",
      label: null,
      permissions: ["read", "write"],
      revoked: false,
      expires_at: null,
      created_at: "2026-01-01T00:00:00Z",
    });

    const app = createTestApp();
    app.use("*", authMiddleware());
    app.get("/test", (c) => {
      return c.json({
        projectId: c.get("projectId"),
        apiKeyId: c.get("apiKeyId"),
        permissions: c.get("keyPermissions"),
      });
    });

    const validKey = "nxg_" + "a".repeat(64);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.projectId).toBe("proj-id-1");
    expect(body.apiKeyId).toBe("key-id-1");
    expect(body.permissions).toEqual(["read", "write"]);
  });
});

describe("requirePermission", () => {
  beforeEach(() => {
    vi.mocked(validateApiKey).mockReset();
  });

  function setupAuthenticatedApp(permissions: string[]) {
    vi.mocked(validateApiKey).mockResolvedValue({
      id: "key-id-1",
      project_id: "proj-id-1",
      key_hash: "hash",
      key_prefix: "nxg_abcd",
      label: null,
      permissions: permissions as ("read" | "write")[],
      revoked: false,
      expires_at: null,
      created_at: "2026-01-01T00:00:00Z",
    });
  }

  it("should allow access when key has required permission", async () => {
    setupAuthenticatedApp(["read", "write"]);

    const app = createTestApp();
    app.use("*", authMiddleware());
    app.use("*", requirePermission("write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const validKey = "nxg_" + "a".repeat(64);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(200);
  });

  it("should return 403 when key lacks required permission", async () => {
    setupAuthenticatedApp(["read"]);

    const app = createTestApp();
    app.use("*", authMiddleware());
    app.use("*", requirePermission("write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const validKey = "nxg_" + "a".repeat(64);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(403);
    const body = await jsonBody(res);
    expect(body.error).toContain("Insufficient permissions");
    expect(body.error).toContain("write");
  });

  it("should check multiple required permissions", async () => {
    setupAuthenticatedApp(["read"]);

    const app = createTestApp();
    app.use("*", authMiddleware());
    app.use("*", requirePermission("read", "write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const validKey = "nxg_" + "a".repeat(64);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("should allow when all required permissions are present", async () => {
    setupAuthenticatedApp(["read", "write"]);

    const app = createTestApp();
    app.use("*", authMiddleware());
    app.use("*", requirePermission("read", "write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const validKey = "nxg_" + "a".repeat(64);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(200);
  });
});
