import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  // Server
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Database
  DATABASE_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/nexgraph"),
  DB_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // API
  API_PREFIX: z.string().default("/api/v1"),

  // MCP
  NEXGRAPH_API_KEY: z.string().optional(),
  NEXGRAPH_API_URL: z.string().url().optional(),

  // Ingestion
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(1_048_576), // 1 MB
  INGESTION_TEMP_DIR: z.string().default(""),
  WORKER_POOL_SIZE: z.coerce.number().int().nonnegative().default(0), // 0 = auto (CPU cores - 1)

  // Embeddings
  EMBEDDING_MODEL: z.string().default("Snowflake/snowflake-arctic-embed-xs"),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(32),
  EMBEDDING_MAX_PARALLEL_CALLS: z.coerce.number().int().positive().default(2),
  EMBEDDING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  PROJECT_SECRETS_ENCRYPTION_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    const message = Object.entries(formatted)
      .map(([key, errors]) => `  ${key}: ${errors?.join(", ")}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${message}`);
  }
  return result.data;
}

export const config = loadConfig();
