import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: () => {
    return async (
      c: { set: (key: string, value: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("projectId", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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

import { integrationRoutes } from "./integrations.js";

describe("GET /api/v1/integrations/claude-plugin/archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a zip archive containing the plugin template files", async () => {
    const res = await integrationRoutes.request(
      "http://localhost/api/v1/integrations/claude-plugin/archive",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");

    const buffer = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().map((entry) => entry.entryName);

    expect(entries).toContain(".claude-plugin/plugin.json");
    expect(entries).toContain("hooks/hooks.json");
    expect(entries).toContain("hooks/nexgraph-hook.js");
    expect(entries).toContain("skills/nexgraph-guide/SKILL.md");
    expect(entries).toContain("install.cjs");
  });
});
