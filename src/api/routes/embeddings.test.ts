import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = (res: Response): Promise<any> => res.json();

const mockGetConfig = vi.hoisted(() => vi.fn());
const mockUpdateConfig = vi.hoisted(() => vi.fn());
const mockDeleteEmbeddings = vi.hoisted(() => vi.fn());
const mockUpsertSecret = vi.hoisted(() => vi.fn());
const mockDeleteSecret = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockBossSend = vi.hoisted(() => vi.fn());
const MockEmbeddingConfigLockedError = vi.hoisted(
  () =>
    class EmbeddingConfigLockedError extends Error {
      constructor(message = "Embedding config cannot be changed while embeddings exist") {
        super(message);
        this.name = "EmbeddingConfigLockedError";
      }
    },
);

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

vi.mock("../../embeddings/config.js", () => ({
  EmbeddingConfigLockedError: MockEmbeddingConfigLockedError,
  getOrCreateProjectEmbeddingConfig: mockGetConfig,
  updateProjectEmbeddingConfig: mockUpdateConfig,
  deleteAllProjectEmbeddings: mockDeleteEmbeddings,
  upsertProjectProviderSecret: mockUpsertSecret,
  deleteProjectProviderSecret: mockDeleteSecret,
}));

vi.mock("../../db/index.js", () => ({
  pool: { query: mockQuery },
}));

vi.mock("../../queue/boss.js", () => ({
  EMBEDDING_REINDEX_QUEUE: "embedding-reindex",
  getBoss: () => ({ send: mockBossSend }),
}));

import { embeddingRoutes } from "./embeddings.js";

describe("embedding routes", () => {
  beforeEach(() => {
    mockGetConfig.mockReset();
    mockUpdateConfig.mockReset();
    mockDeleteEmbeddings.mockReset();
    mockUpsertSecret.mockReset();
    mockDeleteSecret.mockReset();
    mockQuery.mockReset();
    mockBossSend.mockReset();
  });

  it("GET /embedding-config returns config", async () => {
    mockGetConfig.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      distanceMetric: "cosine",
      providerOptions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const res = await embeddingRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/embedding-config`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.provider).toBe("openai");
    expect(body.dimensions).toBe(1536);
  });

  it("PUT /embedding-config returns 200 on update", async () => {
    mockUpdateConfig.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      provider: "google",
      model: "text-embedding-004",
      dimensions: 768,
      distanceMetric: "cosine",
      providerOptions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    });

    const res = await embeddingRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/embedding-config`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          model: "text-embedding-004",
          dimensions: "768",
          distance_metric: "cosine",
          provider_options: {},
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledOnce();
  });

  it("PUT /embedding-config returns 409 when locked", async () => {
    mockUpdateConfig.mockRejectedValueOnce(new MockEmbeddingConfigLockedError());

    const res = await embeddingRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/embedding-config`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: "1536",
        }),
      },
    );

    expect(res.status).toBe(409);
  });

  it("DELETE /embeddings returns deletion counts", async () => {
    mockDeleteEmbeddings.mockResolvedValueOnce({
      symbolsDeleted: 11,
      chunksDeleted: 9,
      totalDeleted: 20,
    });

    const res = await embeddingRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/embeddings`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.total_deleted).toBe(20);
  });

  it("PUT /embedding-keys/:provider stores provider key", async () => {
    const res = await embeddingRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/embedding-keys/openai`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: "sk-test" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockUpsertSecret).toHaveBeenCalledWith(PROJECT_ID, "openai", "sk-test");
  });

  it("POST /embeddings/reindex queues a job", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // active job check
      .mockResolvedValueOnce({ rows: [{ id: "11111111-2222-3333-4444-555555555555" }] }) // create row
      .mockResolvedValueOnce({ rows: [] }); // update boss job id
    mockBossSend.mockResolvedValueOnce("boss-1");

    const res = await embeddingRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/embeddings/reindex`,
      { method: "POST" },
    );

    expect(res.status).toBe(202);
    const body = await jsonBody(res);
    expect(body.job_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(mockBossSend).toHaveBeenCalledOnce();
  });

  it("GET /embeddings/jobs/:jobId returns status", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-2222-3333-4444-555555555555",
          project_id: PROJECT_ID,
          status: "running",
          phase: "repository_1_of_2",
          progress: 42,
          error_message: null,
          started_at: "2026-01-01T00:00:00Z",
          completed_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:10Z",
          boss_job_id: "boss-1",
        },
      ],
    });

    const res = await embeddingRoutes.request(
      `/api/v1/projects/${PROJECT_ID}/embeddings/jobs/11111111-2222-3333-4444-555555555555`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe("running");
    expect(body.progress).toBe(42);
  });
});
