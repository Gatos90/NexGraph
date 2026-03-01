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

const mockEmbedQuery = vi.hoisted(() => vi.fn());
vi.mock("../../ingestion/embeddings.js", () => ({
  embedQuery: mockEmbedQuery,
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

import { searchRoutes } from "./search.js";

const REPO_ID = "11111111-2222-3333-4444-555555555555";

const repoRow = {
  id: REPO_ID,
  project_id: PROJECT_ID,
};

// ---- BM25 search (repo-scoped) ----

describe("POST /api/v1/repositories/:repoId/search", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should return search results ranked by relevance", async () => {
    // verifyRepoAccess
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    // keyword results query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          file_path: "src/auth.ts",
          rank: 0.95,
          headline: "**authenticate** user ...",
          language: "typescript",
        },
        {
          file_path: "src/middleware.ts",
          rank: 0.72,
          headline: "... **auth** middleware ...",
          language: "typescript",
        },
      ],
    });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "authenticate" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.mode).toBe("keyword");
    expect(body.total).toBe(2);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].file_path).toBe("src/auth.ts");
    expect(body.results[0].rank).toBe(0.95);
    expect(body.results[0].highlights).toContain("authenticate");
    expect(body.results[0].language).toBe("typescript");
  });

  it("should return empty results when nothing matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "xyznonexistent" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.total).toBe(0);
    expect(body.results).toHaveLength(0);
  });

  it("should return 404 when repo not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("should return 404 when repo belongs to different project", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...repoRow, project_id: "other-project" }],
    });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("should respect limit parameter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", limit: 5 }),
      },
    );

    expect(res.status).toBe(200);
    // Verify that limit was passed to the keyword query (second call)
    const resultCall = mockQuery.mock.calls[1];
    expect(resultCall[1]).toContain(5); // limit
  });
});

// ---- Grep search ----

describe("POST /api/v1/repositories/:repoId/search/grep", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should return grep matches with context", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          file_path: "src/utils.ts",
          content:
            "line1\nline2\nconst foo = 'bar';\nline4\nline5\nconst baz = 'foo';\nline7",
          language: "typescript",
        },
      ],
    });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search/grep`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pattern: "const foo",
          context_lines: 1,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].file_path).toBe("src/utils.ts");
    expect(body.matches[0].line_number).toBe(3);
    expect(body.matches[0].line).toContain("const foo");
    expect(body.matches[0].context_before).toHaveLength(1);
    expect(body.matches[0].context_after).toHaveLength(1);
    expect(body.total_matches).toBe(1);
    expect(body.files_searched).toBe(1);
    expect(body.files_matched).toBe(1);
  });

  it("should support case-insensitive grep", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          file_path: "src/test.ts",
          content: "Hello World\nhello world",
          language: "typescript",
        },
      ],
    });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search/grep`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pattern: "hello",
          case_sensitive: false,
          context_lines: 0,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.matches).toHaveLength(2);
    expect(body.total_matches).toBe(2);

    // Verify SQL uses case-insensitive operator
    const sqlCall = mockQuery.mock.calls[1];
    expect(sqlCall[0]).toContain("~*");
  });

  it("should return 400 for invalid regex pattern", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search/grep`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "[invalid(" }),
      },
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain("Invalid regex");
  });

  it("should return 404 when repo not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search/grep`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "test" }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("should apply file_pattern filter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search/grep`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "test", file_pattern: "*.ts" }),
      },
    );

    expect(res.status).toBe(200);
    // Verify SQL includes LIKE clause
    const sqlCall = mockQuery.mock.calls[1];
    expect(sqlCall[0]).toContain("LIKE");
  });

  it("should respect the match limit", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [repoRow] });

    // File with many matching lines
    const lines = Array.from({ length: 200 }, (_, i) => `match_${i}`).join(
      "\n",
    );
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          file_path: "big.ts",
          content: lines,
          language: "typescript",
        },
      ],
    });

    const res = await searchRoutes.request(
      `/api/v1/repositories/${REPO_ID}/search/grep`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "match_", limit: 5, context_lines: 0 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.matches).toHaveLength(5);
  });
});

// ---- Project-wide search ----

describe("POST /api/v1/projects/:projectId/search", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("should return search results across all project repos", async () => {
    // count query
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] });
    // results query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          repository_id: REPO_ID,
          file_path: "src/index.ts",
          rank: 0.9,
          headline: "**import** from ...",
          language: "typescript",
        },
      ],
    });

    const res = await searchRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "import" }),
      },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.total).toBe(3);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].repository_id).toBe(REPO_ID);
  });

  it("should return 403 when projectId does not match auth", async () => {
    const otherProjectId = "99999999-8888-7777-6666-555555555555";

    const res = await searchRoutes.request(
      `/api/v1/projects/${otherProjectId}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      },
    );

    expect(res.status).toBe(403);
  });
});
