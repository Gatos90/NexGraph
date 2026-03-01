import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  EmbeddingConfigLockedError,
  deleteAllProjectEmbeddings,
  deleteProjectProviderSecret,
  getOrCreateProjectEmbeddingConfig,
  updateProjectEmbeddingConfig,
  upsertProjectProviderSecret,
} from "../../embeddings/config.js";
import { SUPPORTED_EMBEDDING_DIMENSIONS } from "../../embeddings/dimensions.js";
import { createChildLogger } from "../../logger.js";
import { pool } from "../../db/index.js";
import { EMBEDDING_REINDEX_QUEUE, getBoss } from "../../queue/boss.js";
import type { EmbeddingReindexJobData } from "../../queue/embeddingReindexWorker.js";

const logger = createChildLogger("embeddings-routes");

const embeddingRoutes = new OpenAPIHono<AppEnv>();

const ProjectIdParams = z.object({
  projectId: z.string().uuid(),
});

const JobIdParams = z.object({
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
});

const ProviderParams = z.object({
  projectId: z.string().uuid(),
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const EmbeddingConfigSchema = z.object({
  project_id: z.string().uuid(),
  provider: z.string(),
  model: z.string(),
  dimensions: z.number().int(),
  distance_metric: z.enum(["cosine"]),
  provider_options: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

const ReindexJobSchema = z.object({
  job_id: z.string().uuid(),
  project_id: z.string().uuid(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  phase: z.string().nullable(),
  progress: z.number(),
  error_message: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

interface JobRow {
  id: string;
  project_id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  phase: string | null;
  progress: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  boss_job_id: string | null;
}

function toConfigResponse(cfg: Awaited<ReturnType<typeof getOrCreateProjectEmbeddingConfig>>) {
  return {
    project_id: cfg.projectId,
    provider: cfg.provider,
    model: cfg.model,
    dimensions: cfg.dimensions,
    distance_metric: cfg.distanceMetric,
    provider_options: cfg.providerOptions,
    created_at: cfg.createdAt,
    updated_at: cfg.updatedAt,
  };
}

function toJobResponse(row: JobRow) {
  return {
    job_id: row.id,
    project_id: row.project_id,
    status: row.status,
    phase: row.phase,
    progress: row.progress,
    error_message: row.error_message,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function enforceProjectAccess(authedProjectId: string, projectId: string): boolean {
  return authedProjectId === projectId;
}

embeddingRoutes.use(`${config.API_PREFIX}/projects/:projectId/*`, authMiddleware());

const getConfigRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/embedding-config`,
  tags: ["Embeddings"],
  summary: "Get embedding configuration for a project",
  request: { params: ProjectIdParams },
  responses: {
    200: { content: { "application/json": { schema: EmbeddingConfigSchema } }, description: "Embedding config" },
    403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden" },
  },
});

embeddingRoutes.openapi(getConfigRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  if (!enforceProjectAccess(c.get("projectId"), projectId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const cfg = await getOrCreateProjectEmbeddingConfig(projectId);
  return c.json(toConfigResponse(cfg), 200);
});

const putConfigRoute = createRoute({
  method: "put",
  path: `${config.API_PREFIX}/projects/{projectId}/embedding-config`,
  tags: ["Embeddings"],
  summary: "Update project embedding configuration",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1).max(64),
            model: z.string().min(1).max(255),
            dimensions: z.enum(
              SUPPORTED_EMBEDDING_DIMENSIONS.map(String) as [
                `${(typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number]}`,
                ...`${(typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number]}`[],
              ],
            ).transform((v) => parseInt(v, 10)),
            distance_metric: z.enum(["cosine"]).default("cosine"),
            provider_options: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: EmbeddingConfigSchema } }, description: "Updated config" },
    403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden" },
    409: { content: { "application/json": { schema: ErrorSchema } }, description: "Config locked while embeddings exist" },
  },
});

embeddingRoutes.openapi(putConfigRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  if (!enforceProjectAccess(c.get("projectId"), projectId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!c.get("keyPermissions").includes("write")) {
    return c.json({ error: "Insufficient permissions: requires 'write'" }, 403);
  }

  const body = c.req.valid("json");

  try {
    const cfg = await updateProjectEmbeddingConfig(projectId, {
      provider: body.provider,
      model: body.model,
      dimensions: body.dimensions,
      distanceMetric: body.distance_metric,
      providerOptions: body.provider_options,
    });
    return c.json(toConfigResponse(cfg), 200);
  } catch (err) {
    if (err instanceof EmbeddingConfigLockedError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

const deleteEmbeddingsRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/projects/{projectId}/embeddings`,
  tags: ["Embeddings"],
  summary: "Delete all embeddings for a project",
  request: { params: ProjectIdParams },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            symbols_deleted: z.number(),
            chunks_deleted: z.number(),
            total_deleted: z.number(),
          }),
        },
      },
      description: "Deletion counts",
    },
    403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden" },
  },
});

embeddingRoutes.openapi(deleteEmbeddingsRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  if (!enforceProjectAccess(c.get("projectId"), projectId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!c.get("keyPermissions").includes("write")) {
    return c.json({ error: "Insufficient permissions: requires 'write'" }, 403);
  }

  const counts = await deleteAllProjectEmbeddings(projectId);
  return c.json(
    {
      symbols_deleted: counts.symbolsDeleted,
      chunks_deleted: counts.chunksDeleted,
      total_deleted: counts.totalDeleted,
    },
    200,
  );
});

const putProviderKeyRoute = createRoute({
  method: "put",
  path: `${config.API_PREFIX}/projects/{projectId}/embedding-keys/{provider}`,
  tags: ["Embeddings"],
  summary: "Set or update a provider API key for project embeddings",
  request: {
    params: ProviderParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            api_key: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string(),
            stored: z.literal(true),
          }),
        },
      },
      description: "Key stored",
    },
    403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden" },
  },
});

embeddingRoutes.openapi(putProviderKeyRoute, async (c) => {
  const { projectId, provider } = c.req.valid("param");
  const body = c.req.valid("json");
  if (!enforceProjectAccess(c.get("projectId"), projectId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!c.get("keyPermissions").includes("write")) {
    return c.json({ error: "Insufficient permissions: requires 'write'" }, 403);
  }

  await upsertProjectProviderSecret(projectId, provider, body.api_key);
  return c.json({ provider, stored: true as const }, 200);
});

const deleteProviderKeyRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/projects/{projectId}/embedding-keys/{provider}`,
  tags: ["Embeddings"],
  summary: "Delete a provider API key for project embeddings",
  request: { params: ProviderParams },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string(),
            deleted: z.boolean(),
          }),
        },
      },
      description: "Deletion result",
    },
    403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden" },
  },
});

embeddingRoutes.openapi(deleteProviderKeyRoute, async (c) => {
  const { projectId, provider } = c.req.valid("param");
  if (!enforceProjectAccess(c.get("projectId"), projectId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!c.get("keyPermissions").includes("write")) {
    return c.json({ error: "Insufficient permissions: requires 'write'" }, 403);
  }

  const deleted = await deleteProjectProviderSecret(projectId, provider);
  return c.json({ provider, deleted }, 200);
});

const triggerReindexRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/embeddings/reindex`,
  tags: ["Embeddings"],
  summary: "Queue an async full embedding reindex for a project",
  request: { params: ProjectIdParams },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            job_id: z.string().uuid(),
            message: z.string(),
          }),
        },
      },
      description: "Job queued",
    },
    403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden" },
    409: { content: { "application/json": { schema: ErrorSchema } }, description: "Job already active" },
  },
});

embeddingRoutes.openapi(triggerReindexRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  if (!enforceProjectAccess(c.get("projectId"), projectId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!c.get("keyPermissions").includes("write")) {
    return c.json({ error: "Insufficient permissions: requires 'write'" }, 403);
  }

  const active = await pool.query<{ id: string }>(
    `SELECT id
     FROM embedding_reindex_jobs
     WHERE project_id = $1 AND status IN ('pending', 'running')
     LIMIT 1`,
    [projectId],
  );
  if (active.rows.length > 0) {
    return c.json({ error: "Embedding reindex already in progress" }, 409);
  }

  const created = await pool.query<{ id: string }>(
    `INSERT INTO embedding_reindex_jobs (project_id, status, phase, progress)
     VALUES ($1, 'pending', 'queued', 0)
     RETURNING id`,
    [projectId],
  );
  const jobId = created.rows[0].id;

  const boss = getBoss();
  const payload: EmbeddingReindexJobData = { jobId, projectId };
  const bossJobId = await boss.send(EMBEDDING_REINDEX_QUEUE, payload, {
    expireInSeconds: 7200,
    retryLimit: 0,
  });
  if (bossJobId) {
    await pool.query(
      "UPDATE embedding_reindex_jobs SET boss_job_id = $1, updated_at = NOW() WHERE id = $2",
      [bossJobId, jobId],
    );
  }

  logger.info({ projectId, jobId, bossJobId }, "Embedding reindex queued");
  return c.json({ job_id: jobId, message: "Embedding reindex queued" }, 202);
});

const getJobStatusRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/embeddings/jobs/{jobId}`,
  tags: ["Embeddings"],
  summary: "Get embedding reindex job status",
  request: { params: JobIdParams },
  responses: {
    200: { content: { "application/json": { schema: ReindexJobSchema } }, description: "Job status" },
    403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Job not found" },
  },
});

embeddingRoutes.openapi(getJobStatusRoute, async (c) => {
  const { projectId, jobId } = c.req.valid("param");
  if (!enforceProjectAccess(c.get("projectId"), projectId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await pool.query<JobRow>(
    `SELECT id, project_id, status, phase, progress, error_message,
            started_at, completed_at, created_at, updated_at, boss_job_id
     FROM embedding_reindex_jobs
     WHERE id = $1 AND project_id = $2
     LIMIT 1`,
    [jobId, projectId],
  );
  if (result.rows.length === 0) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json(toJobResponse(result.rows[0]), 200);
});

export { embeddingRoutes };
