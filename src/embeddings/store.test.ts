import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  pool: { query: mockQuery },
}));

vi.mock("./dimensions.js", () => ({
  symbolEmbeddingTableName: (dim: number) => `symbol_embeddings_${dim}`,
}));

import {
  upsertSymbolEmbedding,
  deleteStaleSymbolEmbeddings,
  semanticSearchSymbolsByRepository,
} from "./store.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertSymbolEmbedding", () => {
  it("inserts embedding with correct vector format", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await upsertSymbolEmbedding({
      projectId: "proj-1",
      repositoryId: "repo-1",
      nodeAgeId: 42,
      symbolName: "myFunction",
      filePath: "src/utils.ts",
      label: "Function",
      textContent: "function myFunction() {}",
      provider: "openai",
      model: "text-embedding-3-small",
      embedding: [0.1, 0.2, 0.3],
      dimensions: 384,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];

    // Should use the correct table name
    expect(sql).toContain("symbol_embeddings_384");
    // Should include the vector as a formatted string
    expect(params[9]).toBe("[0.1,0.2,0.3]");
    // Should include all other params
    expect(params[0]).toBe("proj-1");
    expect(params[1]).toBe("repo-1");
    expect(params[2]).toBe(42);
    expect(params[3]).toBe("myFunction");
  });
});

describe("deleteStaleSymbolEmbeddings", () => {
  it("deletes all when currentAgeIds is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 });

    const count = await deleteStaleSymbolEmbeddings(
      "proj-1",
      "repo-1",
      384,
      "text-embedding-3-small",
      [],
    );

    expect(count).toBe(5);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("ALL");
  });

  it("deletes only stale embeddings when currentAgeIds provided", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 });

    const count = await deleteStaleSymbolEmbeddings(
      "proj-1",
      "repo-1",
      384,
      "text-embedding-3-small",
      [1, 2, 3],
    );

    expect(count).toBe(3);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("ALL");
    expect(params[3]).toEqual([1, 2, 3]);
  });

  it("returns 0 when no rows deleted", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const count = await deleteStaleSymbolEmbeddings(
      "proj-1", "repo-1", 384, "model", [1],
    );

    expect(count).toBe(0);
  });
});

describe("semanticSearchSymbolsByRepository", () => {
  it("returns search results with similarity scores", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { symbol_name: "createUser", file_path: "src/user.ts", label: "Function", similarity: 0.95123 },
        { symbol_name: "deleteUser", file_path: "src/user.ts", label: "Function", similarity: 0.82456 },
      ],
    });

    const results = await semanticSearchSymbolsByRepository(
      "proj-1",
      "repo-1",
      384,
      [0.1, 0.2, 0.3],
      10,
    );

    expect(results).toHaveLength(2);
    expect(results[0].symbolName).toBe("createUser");
    expect(results[0].similarity).toBe(0.9512); // rounded to 4 decimal places
    expect(results[1].symbolName).toBe("deleteUser");
  });

  it("formats query vector correctly", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await semanticSearchSymbolsByRepository("p", "r", 384, [1.0, 2.0], 5);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBe("[1,2]");
  });

  it("returns empty array when no matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const results = await semanticSearchSymbolsByRepository(
      "p", "r", 384, [0.1], 10,
    );

    expect(results).toEqual([]);
  });
});
