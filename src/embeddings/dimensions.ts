export const SUPPORTED_EMBEDDING_DIMENSIONS = [
  384,
  768,
  1024,
  1536,
  3072,
  4096,
] as const;

export type EmbeddingDimension = (typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number];

const SUPPORTED_SET = new Set<number>(SUPPORTED_EMBEDDING_DIMENSIONS);

function assertSupportedDimension(dim: number): asserts dim is EmbeddingDimension {
  if (!SUPPORTED_SET.has(dim)) {
    throw new Error(`Unsupported embedding dimension: ${dim}`);
  }
}

export function isSupportedEmbeddingDimension(dim: number): dim is EmbeddingDimension {
  return SUPPORTED_SET.has(dim);
}

export function symbolEmbeddingTableName(dim: number): string {
  assertSupportedDimension(dim);
  return `symbol_embeddings_${dim}`;
}

export function chunkEmbeddingTableName(dim: number): string {
  assertSupportedDimension(dim);
  return `chunk_embeddings_${dim}`;
}

