import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool, ensureGraph, dropGraph, graphExists } from "../../db/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";

const logger = createChildLogger("repositories");

// ---- DB row type ----

interface RepositoryRow {
  id: string;
  project_id: string;
  name: string | null;
  source_type: "git_url" | "zip_upload" | "local_path";
  url: string;
  default_branch: string;
  graph_name: string | null;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IndexingStatusRow {
  status: string;
  started_at: string | null;
  completed_at: string | null;
  files_total: number;
  files_done: number;
  error_message: string | null;
}

// ---- Shared Schemas ----

const SourceType = z.enum(["git_url", "zip_upload", "local_path"]);

const RepositorySchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string().nullable(),
  source_type: SourceType,
  url: z.string(),
  default_branch: z.string(),
  graph_name: z.string().nullable(),
  last_indexed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const RepositoryWithStatusSchema = RepositorySchema.extend({
  indexing_status: z
    .object({
      status: z.string(),
      started_at: z.string().nullable(),
      completed_at: z.string().nullable(),
      files_total: z.number(),
      files_done: z.number(),
      error_message: z.string().nullable(),
    })
    .nullable(),
});

const ErrorResponse = z.object({
  error: z.string(),
});

const RepoIdParams = z.object({
  repoId: z.string().uuid(),
});

// ---- Helpers ----

function buildGraphName(projectId: string, repoId: string): string {
  const safeProjectId = projectId.replace(/-/g, "_");
  const safeRepoId = repoId.replace(/-/g, "_");
  return `proj_${safeProjectId}_repo_${safeRepoId}`;
}

// ---- Route Definitions ----

const createRepositoryRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories`,
  tags: ["Repositories"],
  summary: "Add a repository to the project",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(255).optional(),
            source_type: SourceType,
            url: z.string().min(1).max(2048),
            default_branch: z.string().min(1).max(255).default("main"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: RepositorySchema },
      },
      description: "Repository created",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
    409: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository already exists in this project",
    },
  },
});

const listRepositoriesRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories`,
  tags: ["Repositories"],
  summary: "List repositories in the authenticated project",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            repositories: z.array(RepositorySchema),
          }),
        },
      },
      description: "List of repositories",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
  },
});

const getRepositoryRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}`,
  tags: ["Repositories"],
  summary: "Get repository details including indexing status",
  request: {
    params: RepoIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: RepositoryWithStatusSchema },
      },
      description: "Repository details with indexing status",
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

const updateRepositoryRoute = createRoute({
  method: "patch",
  path: `${config.API_PREFIX}/repositories/{repoId}`,
  tags: ["Repositories"],
  summary: "Update repository settings",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(255).nullable().optional(),
            default_branch: z.string().min(1).max(255).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: RepositorySchema },
      },
      description: "Updated repository",
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

const deleteRepositoryRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/repositories/{repoId}`,
  tags: ["Repositories"],
  summary: "Delete a repository and its AGE graph",
  request: {
    params: RepoIdParams,
  },
  responses: {
    204: {
      description: "Repository deleted successfully",
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

// ---- Router & Middleware ----

const repositoryRoutes = new OpenAPIHono<AppEnv>();

// Auth for all repository endpoints
repositoryRoutes.use(
  `${config.API_PREFIX}/repositories`,
  authMiddleware(),
);
repositoryRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId`,
  authMiddleware(),
);

// ---- Handlers ----

// POST /api/v1/repositories — Add repo
repositoryRoutes.openapi(createRepositoryRoute, async (c) => {
  const projectId = c.get("projectId");
  const permissions = c.get("keyPermissions");

  if (!permissions.includes("write")) {
    return c.json(
      { error: "Insufficient permissions: requires 'write'" },
      403,
    );
  }

  const body = c.req.valid("json");

  // Insert repository
  let result;
  try {
    result = await pool.query<RepositoryRow>(
      `INSERT INTO repositories (project_id, name, source_type, url, default_branch)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id, name, source_type, url, default_branch,
                 graph_name, last_indexed_at, created_at, updated_at`,
      [projectId, body.name ?? null, body.source_type, body.url, body.default_branch],
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("duplicate key value violates unique constraint")
    ) {
      return c.json(
        { error: "Repository with this URL already exists in the project" },
        409,
      );
    }
    throw err;
  }

  const repo = result.rows[0];

  // Create AGE graph for this repository
  const graphName = buildGraphName(projectId, repo.id);
  await ensureGraph(graphName);

  // Store the graph name on the repository record
  const updated = await pool.query<RepositoryRow>(
    `UPDATE repositories SET graph_name = $1
     WHERE id = $2
     RETURNING id, project_id, name, source_type, url, default_branch,
               graph_name, last_indexed_at, created_at, updated_at`,
    [graphName, repo.id],
  );

  logger.info(
    { repoId: repo.id, projectId, graphName },
    "Repository created with AGE graph",
  );

  return c.json(updated.rows[0], 201);
});

// GET /api/v1/repositories — List repos in project
repositoryRoutes.openapi(listRepositoriesRoute, async (c) => {
  const projectId = c.get("projectId");

  const result = await pool.query<RepositoryRow>(
    `SELECT id, project_id, name, source_type, url, default_branch,
            graph_name, last_indexed_at, created_at, updated_at
     FROM repositories
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId],
  );

  return c.json({ repositories: result.rows }, 200);
});

// GET /api/v1/repositories/:repoId — Get repo + indexing status
repositoryRoutes.openapi(getRepositoryRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repoResult = await pool.query<RepositoryRow>(
    `SELECT id, project_id, name, source_type, url, default_branch,
            graph_name, last_indexed_at, created_at, updated_at
     FROM repositories
     WHERE id = $1`,
    [repoId],
  );

  if (repoResult.rows.length === 0) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const repo = repoResult.rows[0];

  if (repo.project_id !== projectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Get latest indexing job status
  const jobResult = await pool.query<IndexingStatusRow>(
    `SELECT status, started_at, completed_at, files_total, files_done, error_message
     FROM indexing_jobs
     WHERE repository_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [repoId],
  );

  const indexingStatus = jobResult.rows.length > 0 ? jobResult.rows[0] : null;

  return c.json({ ...repo, indexing_status: indexingStatus }, 200);
});

// PATCH /api/v1/repositories/:repoId — Update repo settings
repositoryRoutes.openapi(updateRepositoryRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const permissions = c.get("keyPermissions");

  if (!permissions.includes("write")) {
    return c.json(
      { error: "Insufficient permissions: requires 'write'" },
      403,
    );
  }

  // Verify repo belongs to authenticated project
  const check = await pool.query<{ project_id: string }>(
    "SELECT project_id FROM repositories WHERE id = $1",
    [repoId],
  );

  if (check.rows.length === 0) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (check.rows[0].project_id !== projectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = c.req.valid("json");
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (body.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(body.name);
  }
  if (body.default_branch !== undefined) {
    sets.push(`default_branch = $${idx++}`);
    values.push(body.default_branch);
  }

  if (sets.length === 0) {
    const result = await pool.query<RepositoryRow>(
      `SELECT id, project_id, name, source_type, url, default_branch,
              graph_name, last_indexed_at, created_at, updated_at
       FROM repositories WHERE id = $1`,
      [repoId],
    );
    return c.json(result.rows[0], 200);
  }

  sets.push("updated_at = NOW()");
  values.push(repoId);

  const result = await pool.query<RepositoryRow>(
    `UPDATE repositories SET ${sets.join(", ")}
     WHERE id = $${idx}
     RETURNING id, project_id, name, source_type, url, default_branch,
               graph_name, last_indexed_at, created_at, updated_at`,
    values,
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Repository not found" }, 404);
  }

  logger.info({ repoId, projectId }, "Repository updated");

  return c.json(result.rows[0], 200);
});

// DELETE /api/v1/repositories/:repoId — Delete repo + its AGE graph
repositoryRoutes.openapi(deleteRepositoryRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const permissions = c.get("keyPermissions");

  if (!permissions.includes("write")) {
    return c.json(
      { error: "Insufficient permissions: requires 'write'" },
      403,
    );
  }

  // Fetch repository to get graph_name and verify project ownership
  const repoResult = await pool.query<{ project_id: string; graph_name: string | null }>(
    "SELECT project_id, graph_name FROM repositories WHERE id = $1",
    [repoId],
  );

  if (repoResult.rows.length === 0) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (repoResult.rows[0].project_id !== projectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { graph_name } = repoResult.rows[0];

  // Drop the AGE graph if it exists
  if (graph_name) {
    const exists = await graphExists(graph_name);
    if (exists) {
      await dropGraph(graph_name);
      logger.info({ repoId, graphName: graph_name }, "AGE graph dropped");
    }
  }

  // Delete the repository (CASCADE handles indexed_files, indexing_jobs, etc.)
  await pool.query("DELETE FROM repositories WHERE id = $1", [repoId]);

  logger.info({ repoId, projectId }, "Repository deleted");

  return c.body(null, 204);
});

export { repositoryRoutes };
