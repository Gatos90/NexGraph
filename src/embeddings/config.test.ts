import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());
const mockClientQuery = vi.hoisted(() => vi.fn());
const mockClientRelease = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  pool: {
    query: mockQuery,
    connect: mockConnect,
  },
}));

vi.mock("../config.js", () => ({
  config: {
    EMBEDDING_MODEL: "all-MiniLM-L6-v2",
    OPENAI_API_KEY: "sk-test-key",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    MISTRAL_API_KEY: "",
    COHERE_API_KEY: "",
    AWS_BEARER_TOKEN_BEDROCK: "",
    PROJECT_SECRETS_ENCRYPTION_KEY: "test-key-123",
  },
}));

vi.mock("./dimensions.js", () => ({
  symbolEmbeddingTableName: (dim: number) => `symbol_embeddings_${dim}`,
  chunkEmbeddingTableName: (dim: number) => `chunk_embeddings_${dim}`,
  isSupportedEmbeddingDimension: (dim: number) => [384, 768, 1024, 1536, 3072].includes(dim),
  SUPPORTED_EMBEDDING_DIMENSIONS: [384, 768, 1024, 1536, 3072],
}));

vi.mock("./secrets.js", () => ({
  encryptSecret: vi.fn((s: string) => `encrypted:${s}`),
  decryptSecret: vi.fn((s: string) => s.replace("encrypted:", "")),
}));

import {
  getProjectEmbeddingConfig,
  getOrCreateProjectEmbeddingConfig,
  updateProjectEmbeddingConfig,
  countProjectEmbeddings,
  upsertProjectProviderSecret,
  getProjectProviderSecret,
  resolveProviderApiKey,
  EmbeddingConfigLockedError,
} from "./config.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
});

describe("getProjectEmbeddingConfig", () => {
  it("returns config when found", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        project_id: "proj-1",
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        distance_metric: "cosine",
        provider_options: {},
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
      }],
    });

    const result = await getProjectEmbeddingConfig("proj-1");

    expect(result).toBeDefined();
    expect(result!.provider).toBe("openai");
    expect(result!.dimensions).toBe(1536);
  });

  it("returns null when not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getProjectEmbeddingConfig("proj-1");
    expect(result).toBeNull();
  });
});

describe("getOrCreateProjectEmbeddingConfig", () => {
  it("creates config with defaults if not existing", async () => {
    // INSERT (upsert)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT after insert
    mockQuery.mockResolvedValueOnce({
      rows: [{
        project_id: "proj-1",
        provider: "local_hf",
        model: "all-MiniLM-L6-v2",
        dimensions: 384,
        distance_metric: "cosine",
        provider_options: {},
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
      }],
    });

    const result = await getOrCreateProjectEmbeddingConfig("proj-1");

    expect(result.provider).toBe("local_hf");
    expect(result.dimensions).toBe(384);
  });
});

describe("updateProjectEmbeddingConfig", () => {
  it("throws EmbeddingConfigLockedError if embeddings exist", async () => {
    // countRowsInTable calls — simulate embeddings exist
    // The function calls countProjectEmbeddings which calls countRowsInTable for each dimension
    // Each dimension has 2 calls (symbol + chunk table)
    for (let i = 0; i < 10; i++) {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: i === 0 ? "5" : "0" }] });
    }

    await expect(
      updateProjectEmbeddingConfig("proj-1", {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      }),
    ).rejects.toThrow(EmbeddingConfigLockedError);
  });

  it("throws for unsupported dimensions", async () => {
    await expect(
      updateProjectEmbeddingConfig("proj-1", {
        provider: "openai",
        model: "m",
        dimensions: 999,
      }),
    ).rejects.toThrow("Unsupported embedding dimension");
  });
});

describe("countProjectEmbeddings", () => {
  it("sums counts across all dimension tables", async () => {
    // 5 dimensions * 2 tables = 10 queries
    for (let i = 0; i < 10; i++) {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "10" }] });
    }

    const result = await countProjectEmbeddings("proj-1");
    expect(result.symbols).toBe(50); // 5 * 10
    expect(result.chunks).toBe(50);
    expect(result.total).toBe(100);
  });
});

describe("upsertProjectProviderSecret", () => {
  it("encrypts and stores the secret", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await upsertProjectProviderSecret("proj-1", "openai", "sk-my-key");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_secrets"),
      expect.arrayContaining(["proj-1", "openai", "encrypted:sk-my-key"]),
    );
  });
});

describe("getProjectProviderSecret", () => {
  it("returns decrypted secret when found", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ciphertext: "encrypted:sk-my-key" }],
    });

    const result = await getProjectProviderSecret("proj-1", "openai");
    expect(result).toBe("sk-my-key");
  });

  it("returns null when not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getProjectProviderSecret("proj-1", "openai");
    expect(result).toBeNull();
  });
});

describe("resolveProviderApiKey", () => {
  it("returns project secret if available", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ciphertext: "encrypted:project-key" }],
    });

    const result = await resolveProviderApiKey("proj-1", "openai");
    expect(result).toBe("project-key");
  });

  it("falls back to env var if no project secret", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no project secret

    const result = await resolveProviderApiKey("proj-1", "openai");
    expect(result).toBe("sk-test-key"); // from mocked config
  });

  it("returns null for unknown provider with no secret", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no project secret

    const result = await resolveProviderApiKey("proj-1", "unknown-provider");
    expect(result).toBeNull();
  });
});
