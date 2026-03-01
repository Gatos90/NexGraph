import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmbedMany = vi.hoisted(() => vi.fn());
const mockResolveKey = vi.hoisted(() => vi.fn());
const mockGetConfig = vi.hoisted(() => vi.fn());

const mockOpenAIEmbedding = vi.hoisted(() => vi.fn((id: string) => `openai:${id}`));
const mockGoogleEmbedding = vi.hoisted(() => vi.fn((id: string) => `google:${id}`));
const mockMistralEmbedding = vi.hoisted(() => vi.fn((id: string) => `mistral:${id}`));
const mockCohereEmbedding = vi.hoisted(() => vi.fn((id: string) => `cohere:${id}`));
const mockBedrockEmbedding = vi.hoisted(() => vi.fn((id: string) => `bedrock:${id}`));

const mockCreateOpenAI = vi.hoisted(() =>
  vi.fn(() => ({ embedding: mockOpenAIEmbedding })),
);
const mockCreateGoogle = vi.hoisted(() =>
  vi.fn(() => ({ embedding: mockGoogleEmbedding })),
);
const mockCreateMistral = vi.hoisted(() =>
  vi.fn(() => ({ embedding: mockMistralEmbedding })),
);
const mockCreateCohere = vi.hoisted(() =>
  vi.fn(() => ({ embedding: mockCohereEmbedding })),
);
const mockCreateBedrock = vi.hoisted(() =>
  vi.fn(() => ({ embedding: mockBedrockEmbedding })),
);

vi.mock("ai", () => ({
  embedMany: mockEmbedMany,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mockCreateOpenAI,
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: mockCreateGoogle,
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: mockCreateMistral,
}));

vi.mock("@ai-sdk/cohere", () => ({
  createCohere: mockCreateCohere,
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: mockCreateBedrock,
}));

vi.mock("../config.js", () => ({
  config: {
    EMBEDDING_MAX_PARALLEL_CALLS: 2,
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_SESSION_TOKEN: "",
  },
}));

vi.mock("./config.js", () => ({
  getOrCreateProjectEmbeddingConfig: mockGetConfig,
  resolveProviderApiKey: mockResolveKey,
}));

import { embedManyForProject } from "./provider.js";

describe("embedManyForProject provider routing", () => {
  beforeEach(() => {
    mockEmbedMany.mockReset();
    mockResolveKey.mockReset();
    mockGetConfig.mockReset();
    mockCreateOpenAI.mockClear();
    mockCreateGoogle.mockClear();
    mockCreateMistral.mockClear();
    mockCreateCohere.mockClear();
    mockCreateBedrock.mockClear();
  });

  it("uses OpenAI provider", async () => {
    mockGetConfig.mockResolvedValueOnce({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      providerOptions: {},
    });
    mockResolveKey.mockResolvedValueOnce("sk-openai");
    mockEmbedMany.mockResolvedValueOnce({
      embeddings: [Array(1536).fill(0.1)],
      usage: { tokens: 10 },
    });

    const result = await embedManyForProject("p1", ["hello"]);
    expect(result.provider).toBe("openai");
    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: "sk-openai" });
    expect(mockEmbedMany).toHaveBeenCalledOnce();
  });

  it("uses Google provider", async () => {
    mockGetConfig.mockResolvedValueOnce({
      provider: "google",
      model: "text-embedding-004",
      dimensions: 768,
      providerOptions: {},
    });
    mockResolveKey.mockResolvedValueOnce("g-key");
    mockEmbedMany.mockResolvedValueOnce({
      embeddings: [Array(768).fill(0.2)],
      usage: { tokens: 12 },
    });

    const result = await embedManyForProject("p1", ["hello"]);
    expect(result.provider).toBe("google");
    expect(mockCreateGoogle).toHaveBeenCalledWith({ apiKey: "g-key" });
  });

  it("uses Mistral provider", async () => {
    mockGetConfig.mockResolvedValueOnce({
      provider: "mistral",
      model: "mistral-embed",
      dimensions: 1024,
      providerOptions: {},
    });
    mockResolveKey.mockResolvedValueOnce("m-key");
    mockEmbedMany.mockResolvedValueOnce({
      embeddings: [Array(1024).fill(0.3)],
      usage: { tokens: 13 },
    });

    const result = await embedManyForProject("p1", ["hello"]);
    expect(result.provider).toBe("mistral");
    expect(mockCreateMistral).toHaveBeenCalledWith({ apiKey: "m-key" });
  });

  it("uses Cohere provider", async () => {
    mockGetConfig.mockResolvedValueOnce({
      provider: "cohere",
      model: "embed-english-v3.0",
      dimensions: 1024,
      providerOptions: {},
    });
    mockResolveKey.mockResolvedValueOnce("c-key");
    mockEmbedMany.mockResolvedValueOnce({
      embeddings: [Array(1024).fill(0.4)],
      usage: { tokens: 8 },
    });

    const result = await embedManyForProject("p1", ["hello"]);
    expect(result.provider).toBe("cohere");
    expect(mockCreateCohere).toHaveBeenCalledWith({ apiKey: "c-key" });
  });

  it("uses Bedrock provider", async () => {
    mockGetConfig.mockResolvedValueOnce({
      provider: "amazon-bedrock",
      model: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      providerOptions: {},
    });
    mockResolveKey.mockResolvedValueOnce("bedrock-bearer");
    mockEmbedMany.mockResolvedValueOnce({
      embeddings: [Array(1024).fill(0.5)],
      usage: { tokens: 5 },
    });

    const result = await embedManyForProject("p1", ["hello"]);
    expect(result.provider).toBe("amazon-bedrock");
    expect(mockCreateBedrock).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "us-east-1",
        apiKey: "bedrock-bearer",
      }),
    );
  });
});

