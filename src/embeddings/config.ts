import { pool } from "../db/index.js";
import { config } from "../config.js";
import {
  chunkEmbeddingTableName,
  isSupportedEmbeddingDimension,
  SUPPORTED_EMBEDDING_DIMENSIONS,
  symbolEmbeddingTableName,
  type EmbeddingDimension,
} from "./dimensions.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

export type DistanceMetric = "cosine";

export interface ProjectEmbeddingConfig {
  projectId: string;
  provider: string;
  model: string;
  dimensions: EmbeddingDimension;
  distanceMetric: DistanceMetric;
  providerOptions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ConfigRow {
  project_id: string;
  provider: string;
  model: string;
  dimensions: number;
  distance_metric: DistanceMetric;
  provider_options: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface SecretRow {
  ciphertext: string;
}

export class EmbeddingConfigLockedError extends Error {
  constructor(message = "Embedding config cannot be changed while embeddings exist") {
    super(message);
    this.name = "EmbeddingConfigLockedError";
  }
}

function mapConfigRow(row: ConfigRow): ProjectEmbeddingConfig {
  if (!isSupportedEmbeddingDimension(row.dimensions)) {
    throw new Error(`Unsupported dimensions in DB: ${row.dimensions}`);
  }

  return {
    projectId: row.project_id,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    distanceMetric: row.distance_metric,
    providerOptions:
      row.provider_options && typeof row.provider_options === "object"
        ? row.provider_options
        : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultConfigInput() {
  return {
    provider: "local_hf",
    model: config.EMBEDDING_MODEL,
    dimensions: 384 as EmbeddingDimension,
    distance_metric: "cosine" as DistanceMetric,
    provider_options: {},
  };
}

export async function getProjectEmbeddingConfig(
  projectId: string,
): Promise<ProjectEmbeddingConfig | null> {
  const result = await pool.query<ConfigRow>(
    `SELECT project_id, provider, model, dimensions, distance_metric, provider_options, created_at, updated_at
     FROM project_embedding_config
     WHERE project_id = $1`,
    [projectId],
  );
  if (result.rows.length === 0) return null;
  return mapConfigRow(result.rows[0]);
}

export async function getOrCreateProjectEmbeddingConfig(
  projectId: string,
): Promise<ProjectEmbeddingConfig> {
  const defaults = defaultConfigInput();
  await pool.query(
    `INSERT INTO project_embedding_config
       (project_id, provider, model, dimensions, distance_metric, provider_options)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (project_id) DO NOTHING`,
    [
      projectId,
      defaults.provider,
      defaults.model,
      defaults.dimensions,
      defaults.distance_metric,
      JSON.stringify(defaults.provider_options),
    ],
  );

  const cfg = await getProjectEmbeddingConfig(projectId);
  if (!cfg) {
    throw new Error(`Failed to load embedding config for project ${projectId}`);
  }
  return cfg;
}

async function countRowsInTable(tableName: string, projectId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${tableName} WHERE project_id = $1`,
    [projectId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function countProjectEmbeddings(projectId: string): Promise<{
  symbols: number;
  chunks: number;
  total: number;
}> {
  let symbols = 0;
  let chunks = 0;

  for (const dim of SUPPORTED_EMBEDDING_DIMENSIONS) {
    symbols += await countRowsInTable(symbolEmbeddingTableName(dim), projectId);
    chunks += await countRowsInTable(chunkEmbeddingTableName(dim), projectId);
  }

  return { symbols, chunks, total: symbols + chunks };
}

export async function hasAnyProjectEmbeddings(projectId: string): Promise<boolean> {
  const counts = await countProjectEmbeddings(projectId);
  return counts.total > 0;
}

export async function updateProjectEmbeddingConfig(
  projectId: string,
  input: {
    provider: string;
    model: string;
    dimensions: number;
    distanceMetric?: DistanceMetric;
    providerOptions?: Record<string, unknown>;
  },
): Promise<ProjectEmbeddingConfig> {
  if (!isSupportedEmbeddingDimension(input.dimensions)) {
    throw new Error(`Unsupported embedding dimension: ${input.dimensions}`);
  }

  if (await hasAnyProjectEmbeddings(projectId)) {
    throw new EmbeddingConfigLockedError();
  }

  const distanceMetric = input.distanceMetric ?? "cosine";
  const providerOptions = input.providerOptions ?? {};

  const result = await pool.query<ConfigRow>(
    `INSERT INTO project_embedding_config
       (project_id, provider, model, dimensions, distance_metric, provider_options)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (project_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       dimensions = EXCLUDED.dimensions,
       distance_metric = EXCLUDED.distance_metric,
       provider_options = EXCLUDED.provider_options,
       updated_at = NOW()
     RETURNING project_id, provider, model, dimensions, distance_metric, provider_options, created_at, updated_at`,
    [
      projectId,
      input.provider,
      input.model,
      input.dimensions,
      distanceMetric,
      JSON.stringify(providerOptions),
    ],
  );

  return mapConfigRow(result.rows[0]);
}

export async function deleteAllProjectEmbeddings(projectId: string): Promise<{
  symbolsDeleted: number;
  chunksDeleted: number;
  totalDeleted: number;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let symbolsDeleted = 0;
    let chunksDeleted = 0;

    for (const dim of SUPPORTED_EMBEDDING_DIMENSIONS) {
      const symbolTable = symbolEmbeddingTableName(dim);
      const chunkTable = chunkEmbeddingTableName(dim);

      const symRes = await client.query(
        `DELETE FROM ${symbolTable} WHERE project_id = $1`,
        [projectId],
      );
      symbolsDeleted += symRes.rowCount ?? 0;

      const chunkRes = await client.query(
        `DELETE FROM ${chunkTable} WHERE project_id = $1`,
        [projectId],
      );
      chunksDeleted += chunkRes.rowCount ?? 0;
    }

    // Keep repository metadata consistent.
    await client.query(
      `UPDATE repositories
       SET embedding_count = 0, embeddings_generated_at = NULL
       WHERE project_id = $1`,
      [projectId],
    );

    await client.query("COMMIT");
    return {
      symbolsDeleted,
      chunksDeleted,
      totalDeleted: symbolsDeleted + chunksDeleted,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertProjectProviderSecret(
  projectId: string,
  provider: string,
  secretValue: string,
): Promise<void> {
  const ciphertext = encryptSecret(secretValue);
  await pool.query(
    `INSERT INTO project_secrets (project_id, provider, secret_name, ciphertext)
     VALUES ($1, $2, 'api_key', $3)
     ON CONFLICT (project_id, provider, secret_name) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       updated_at = NOW()`,
    [projectId, provider, ciphertext],
  );
}

export async function deleteProjectProviderSecret(
  projectId: string,
  provider: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM project_secrets
     WHERE project_id = $1 AND provider = $2 AND secret_name = 'api_key'`,
    [projectId, provider],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getProjectProviderSecret(
  projectId: string,
  provider: string,
): Promise<string | null> {
  const result = await pool.query<SecretRow>(
    `SELECT ciphertext
     FROM project_secrets
     WHERE project_id = $1 AND provider = $2 AND secret_name = 'api_key'
     LIMIT 1`,
    [projectId, provider],
  );
  if (result.rows.length === 0) return null;
  return decryptSecret(result.rows[0].ciphertext);
}

const PROVIDER_ENV_KEYS: Record<string, keyof typeof config> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cohere: "COHERE_API_KEY",
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
};

export async function resolveProviderApiKey(
  projectId: string,
  provider: string,
): Promise<string | null> {
  const projectSecret = await getProjectProviderSecret(projectId, provider);
  if (projectSecret) return projectSecret;

  const envKeyName = PROVIDER_ENV_KEYS[provider];
  if (!envKeyName) return null;

  const envValue = config[envKeyName];
  return typeof envValue === "string" && envValue.length > 0 ? envValue : null;
}
