import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

const mockQuery = vi.hoisted(() => vi.fn());

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
  cypher: vi.fn().mockResolvedValue([]),
}));

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

import { fileRoutes } from "./files.js";

const REPO_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/repositories/:repoId/files", () => {
  const URL = `http://localhost/api/v1/repositories/${REPO_ID}/files`;

  it("returns 404 when repository not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await fileRoutes.request(URL);
    expect(res.status).toBe(404);
  });

  it("returns 404 when repository belongs to different project", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: REPO_ID, project_id: "other-project", graph_name: "g" }],
    });

    const res = await fileRoutes.request(URL);
    expect(res.status).toBe(404);
  });

  it("returns file list when repository found", async () => {
    // verifyRepoAccess
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: REPO_ID, project_id: PROJECT_ID, graph_name: "graph_test" }],
    });
    // file list query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { file_path: "src/index.ts", language: "TypeScript", content_hash: "abc" },
      ],
    });

    const res = await fileRoutes.request(URL);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body).toBeDefined();
  });
});
