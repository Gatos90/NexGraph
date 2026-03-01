import type pg from "pg";
import { pool } from "../db/index.js";
import { symbolEmbeddingTableName } from "./dimensions.js";

interface SymbolEmbeddingWrite {
  projectId: string;
  repositoryId: string;
  nodeAgeId: number;
  symbolName: string;
  filePath: string;
  label: string;
  textContent: string;
  provider: string;
  model: string;
  embedding: number[];
  dimensions: number;
}

interface SymbolSemanticResultRow {
  symbol_name: string;
  file_path: string;
  label: string;
  similarity: number;
}

export async function upsertSymbolEmbedding(
  row: SymbolEmbeddingWrite,
  executor: pg.Pool | pg.PoolClient = pool,
): Promise<void> {
  const table = symbolEmbeddingTableName(row.dimensions);
  const vector = `[${row.embedding.join(",")}]`;

  await executor.query(
    `INSERT INTO ${table}
       (project_id, repository_id, node_age_id, symbol_name, file_path, label, text_content, provider, model, embedding, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, NOW())
     ON CONFLICT (repository_id, node_age_id, model) DO UPDATE SET
       symbol_name = EXCLUDED.symbol_name,
       file_path = EXCLUDED.file_path,
       label = EXCLUDED.label,
       text_content = EXCLUDED.text_content,
       provider = EXCLUDED.provider,
       embedding = EXCLUDED.embedding,
       updated_at = NOW()`,
    [
      row.projectId,
      row.repositoryId,
      row.nodeAgeId,
      row.symbolName,
      row.filePath,
      row.label,
      row.textContent,
      row.provider,
      row.model,
      vector,
    ]
  );
}

export async function deleteStaleSymbolEmbeddings(
  projectId: string,
  repositoryId: string,
  dimensions: number,
  model: string,
  currentAgeIds: number[],
): Promise<number> {
  const table = symbolEmbeddingTableName(dimensions);

  const result =
    currentAgeIds.length === 0
      ? await pool.query(
          `DELETE FROM ${table}
           WHERE project_id = $1 AND repository_id = $2 AND model = $3`,
          [projectId, repositoryId, model],
        )
      : await pool.query(
          `DELETE FROM ${table}
           WHERE project_id = $1
             AND repository_id = $2
             AND model = $3
             AND node_age_id != ALL($4::bigint[])`,
          [projectId, repositoryId, model, currentAgeIds],
        );

  return result.rowCount ?? 0;
}

export async function semanticSearchSymbolsByRepository(
  projectId: string,
  repositoryId: string,
  dimensions: number,
  queryVector: number[],
  limit: number,
): Promise<
  Array<{
    symbolName: string;
    filePath: string;
    label: string;
    similarity: number;
  }>
> {
  const table = symbolEmbeddingTableName(dimensions);
  const vectorStr = `[${queryVector.join(",")}]`;

  const result = await pool.query<SymbolSemanticResultRow>(
    `SELECT
       symbol_name,
       file_path,
       label,
       (1 - (embedding <=> $4::vector)) AS similarity
     FROM ${table}
     WHERE project_id = $1
       AND repository_id = $2
     ORDER BY embedding <=> $4::vector
     LIMIT $3`,
    [projectId, repositoryId, limit, vectorStr],
  );

  return result.rows.map((row) => ({
    symbolName: row.symbol_name,
    filePath: row.file_path,
    label: row.label,
    similarity: Math.round(row.similarity * 10000) / 10000,
  }));
}
