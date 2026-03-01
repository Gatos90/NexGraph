import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { getBoss, INDEXING_QUEUE } from "../../queue/boss.js";
import { createChildLogger } from "../../logger.js";
import type { IndexingJobData } from "../../queue/indexingWorker.js";

const logger = createChildLogger("indexing-routes");

// ---- DB Row Types ----

interface RepositoryRow {
  id: string;
  project_id: string;
  source_type: "git_url" | "zip_upload" | "local_path";
  url: string;
  default_branch: string;
  graph_name: string | null;
  last_indexed_commit: string | null;
}

interface IndexingJobRow {
  id: string;
  repository_id: string;
  status: string;
  mode: string;
  phase: string | null;
  progress: number;
  last_completed_phase: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  files_total: number;
  files_done: number;
  boss_job_id: string | null;
  created_at: string;
}

interface ProjectRow {
  settings: Record<string, unknown>;
}

// ---- Shared Schemas ----

const ErrorResponse = z.object({
  error: z.string(),
});

const RepoIdParams = z.object({
  repoId: z.string().uuid(),
});

const IndexingStatusSchema = z.object({
  job_id: z.string().uuid(),
  status: z.string(),
  mode: z.string(),
  phase: z.string().nullable(),
  progress: z.number(),
  last_completed_phase: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  files_total: z.number(),
  files_done: z.number(),
  created_at: z.string(),
});

// ---- Route Definitions ----

const triggerIndexRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/index`,
  tags: ["Indexing"],
  summary: "Trigger indexing for a repository",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            mode: z.enum(["full", "incremental"]).default("full"),
          }),
        },
      },
    },
  },
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
      description: "Indexing job queued",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Indexing already in progress",
    },
  },
});

const getIndexStatusRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/index/status`,
  tags: ["Indexing"],
  summary: "Get indexing progress for a repository",
  request: {
    params: RepoIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            current: IndexingStatusSchema.nullable(),
            history: z.array(IndexingStatusSchema),
          }),
        },
      },
      description: "Indexing status",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found",
    },
  },
});

const cancelIndexRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/repositories/{repoId}/index`,
  tags: ["Indexing"],
  summary: "Cancel a running indexing job",
  request: {
    params: RepoIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            job_id: z.string().uuid(),
          }),
        },
      },
      description: "Indexing job cancelled",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "No active indexing job found",
    },
  },
});

// ---- Helpers ----

async function verifyRepoAccess(
  repoId: string,
  projectId: string,
): Promise<RepositoryRow | null> {
  const result = await pool.query<RepositoryRow>(
    `SELECT id, project_id, source_type, url, default_branch, graph_name, last_indexed_commit
     FROM repositories WHERE id = $1`,
    [repoId],
  );

  if (result.rows.length === 0) return null;
  if (result.rows[0].project_id !== projectId) return null;

  return result.rows[0];
}

function mapJobRow(row: IndexingJobRow) {
  return {
    job_id: row.id,
    status: row.status,
    mode: row.mode,
    phase: row.phase,
    progress: row.progress,
    last_completed_phase: row.last_completed_phase,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    files_total: row.files_total,
    files_done: row.files_done,
    created_at: row.created_at,
  };
}

// ---- Router & Middleware ----

const indexingRoutes = new OpenAPIHono<AppEnv>();

// Auth for all indexing endpoints
indexingRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/index`,
  authMiddleware(),
);
indexingRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/index/status`,
  authMiddleware(),
);

// ---- Handlers ----

// POST /api/v1/repositories/:repoId/index — Trigger indexing
indexingRoutes.openapi(triggerIndexRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const permissions = c.get("keyPermissions");

  if (!permissions.includes("write")) {
    return c.json(
      { error: "Insufficient permissions: requires 'write'" },
      403,
    );
  }

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!repo.graph_name) {
    return c.json({ error: "Repository has no graph — recreate it" }, 404);
  }

  // Check for active indexing job
  const activeJob = await pool.query<{ id: string }>(
    `SELECT id FROM indexing_jobs
     WHERE repository_id = $1 AND status IN ('pending', 'running')
     LIMIT 1`,
    [repoId],
  );

  if (activeJob.rows.length > 0) {
    return c.json(
      { error: "Indexing already in progress for this repository" },
      409,
    );
  }

  const body = c.req.valid("json");

  // Load project settings for include/exclude globs
  const projResult = await pool.query<ProjectRow>(
    "SELECT settings FROM projects WHERE id = $1",
    [projectId],
  );
  const settings = projResult.rows[0]?.settings ?? {};

  // Create the indexing_jobs row
  const jobResult = await pool.query<{ id: string }>(
    `INSERT INTO indexing_jobs (repository_id, status, mode)
     VALUES ($1, 'pending', $2)
     RETURNING id`,
    [repoId, body.mode],
  );
  const jobId = jobResult.rows[0].id;

  // Enqueue pg-boss job
  const boss = getBoss();
  const jobData: IndexingJobData = {
    jobId,
    repositoryId: repoId,
    projectId,
    sourceType: repo.source_type,
    sourceUrl: repo.url,
    graphName: repo.graph_name,
    mode: body.mode,
    defaultBranch: repo.default_branch,
    settings: {
      include_globs: (settings as Record<string, unknown>).include_globs as string[] | undefined,
      exclude_globs: (settings as Record<string, unknown>).exclude_globs as string[] | undefined,
    },
    lastIndexedCommit: repo.last_indexed_commit ?? undefined,
  };

  const bossJobId = await boss.send(INDEXING_QUEUE, jobData, {
    expireInSeconds: 7200, // 2 hours
    retryLimit: 0, // avoid destructive full-reindex retry loops on hard failures
  });

  // Store boss job ID for cancellation
  if (bossJobId) {
    await pool.query(
      "UPDATE indexing_jobs SET boss_job_id = $1 WHERE id = $2",
      [bossJobId, jobId],
    );
  }

  logger.info({ jobId, repoId, mode: body.mode }, "Indexing job queued");

  return c.json(
    { job_id: jobId, message: "Indexing job queued" },
    202,
  );
});

// GET /api/v1/repositories/:repoId/index/status — Get progress
indexingRoutes.openapi(getIndexStatusRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  // Get all jobs, most recent first
  const result = await pool.query<IndexingJobRow>(
    `SELECT id, repository_id, status, mode, phase, progress,
            last_completed_phase, started_at, completed_at,
            error_message, files_total, files_done, boss_job_id, created_at
     FROM indexing_jobs
     WHERE repository_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [repoId],
  );

  if (result.rows.length === 0) {
    return c.json({ current: null, history: [] }, 200);
  }

  // Current = the most recent pending/running job, or the latest job
  const activeJob = result.rows.find(
    (r) => r.status === "pending" || r.status === "running",
  );
  const current = activeJob ? mapJobRow(activeJob) : mapJobRow(result.rows[0]);
  const history = result.rows.map(mapJobRow);

  return c.json({ current, history }, 200);
});

// DELETE /api/v1/repositories/:repoId/index — Cancel running job
indexingRoutes.openapi(cancelIndexRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const permissions = c.get("keyPermissions");

  if (!permissions.includes("write")) {
    return c.json(
      { error: "Insufficient permissions: requires 'write'" },
      403,
    );
  }

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  // Find active job
  const activeJob = await pool.query<IndexingJobRow>(
    `SELECT id, boss_job_id, status
     FROM indexing_jobs
     WHERE repository_id = $1 AND status IN ('pending', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
    [repoId],
  );

  if (activeJob.rows.length === 0) {
    return c.json({ error: "No active indexing job found" }, 404);
  }

  const job = activeJob.rows[0];

  // Mark as cancelled in our table
  await pool.query(
    `UPDATE indexing_jobs
     SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [job.id],
  );

  // Cancel in pg-boss if we have the boss job id
  if (job.boss_job_id) {
    try {
      const boss = getBoss();
      await boss.cancel(INDEXING_QUEUE, job.boss_job_id);
    } catch (err) {
      logger.warn({ jobId: job.id, bossJobId: job.boss_job_id, err }, "Failed to cancel pg-boss job");
    }
  }

  logger.info({ jobId: job.id, repoId }, "Indexing job cancelled");

  return c.json(
    { message: "Indexing job cancelled", job_id: job.id },
    200,
  );
});

export { indexingRoutes };
