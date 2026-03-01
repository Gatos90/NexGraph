import { describe, it, expect } from "vitest";
import {
  SUPPORTED_EMBEDDING_DIMENSIONS,
  isSupportedEmbeddingDimension,
  symbolEmbeddingTableName,
  chunkEmbeddingTableName,
} from "./dimensions.js";

describe("SUPPORTED_EMBEDDING_DIMENSIONS", () => {
  it("contains expected dimensions", () => {
    expect(SUPPORTED_EMBEDDING_DIMENSIONS).toContain(384);
    expect(SUPPORTED_EMBEDDING_DIMENSIONS).toContain(768);
    expect(SUPPORTED_EMBEDDING_DIMENSIONS).toContain(1024);
    expect(SUPPORTED_EMBEDDING_DIMENSIONS).toContain(1536);
    expect(SUPPORTED_EMBEDDING_DIMENSIONS).toContain(3072);
    expect(SUPPORTED_EMBEDDING_DIMENSIONS).toContain(4096);
  });

  it("has 6 entries", () => {
    expect(SUPPORTED_EMBEDDING_DIMENSIONS).toHaveLength(6);
  });
});

describe("isSupportedEmbeddingDimension", () => {
  it("returns true for supported dimensions", () => {
    expect(isSupportedEmbeddingDimension(384)).toBe(true);
    expect(isSupportedEmbeddingDimension(1536)).toBe(true);
    expect(isSupportedEmbeddingDimension(4096)).toBe(true);
  });

  it("returns false for unsupported dimensions", () => {
    expect(isSupportedEmbeddingDimension(0)).toBe(false);
    expect(isSupportedEmbeddingDimension(100)).toBe(false);
    expect(isSupportedEmbeddingDimension(512)).toBe(false);
    expect(isSupportedEmbeddingDimension(999)).toBe(false);
  });
});

describe("symbolEmbeddingTableName", () => {
  it("returns correct table name for supported dimensions", () => {
    expect(symbolEmbeddingTableName(384)).toBe("symbol_embeddings_384");
    expect(symbolEmbeddingTableName(768)).toBe("symbol_embeddings_768");
    expect(symbolEmbeddingTableName(1536)).toBe("symbol_embeddings_1536");
  });

  it("throws for unsupported dimensions", () => {
    expect(() => symbolEmbeddingTableName(999)).toThrow("Unsupported embedding dimension");
  });
});

describe("chunkEmbeddingTableName", () => {
  it("returns correct table name for supported dimensions", () => {
    expect(chunkEmbeddingTableName(384)).toBe("chunk_embeddings_384");
    expect(chunkEmbeddingTableName(1024)).toBe("chunk_embeddings_1024");
    expect(chunkEmbeddingTableName(3072)).toBe("chunk_embeddings_3072");
  });

  it("throws for unsupported dimensions", () => {
    expect(() => chunkEmbeddingTableName(512)).toThrow("Unsupported embedding dimension");
  });
});
