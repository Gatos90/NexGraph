import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { createApiKey } from "../keys.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";

const logger = createChildLogger("projects");

// ---- DB row type ----

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Shared Schemas ----

const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ErrorResponse = z.object({
  error: z.string(),
});

const ProjectIdParams = z.object({
  projectId: z.string().uuid(),
});

// ---- Route Definitions ----

const createProjectRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects`,
  tags: ["Projects"],
  summary: "Create a new project with an initial API key",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(255),
            description: z.string().max(1000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            project: ProjectSchema,
            api_key: z.object({
              id: z.string().uuid(),
              key: z.string().describe("Full API key — shown only once"),
              key_prefix: z.string(),
              permissions: z.array(z.enum(["read", "write"])),
              expires_at: z.string().nullable(),
              created_at: z.string(),
            }),
          }),
        },
      },
      description: "Project created with initial API key",
    },
  },
});

const listProjectsRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects`,
  tags: ["Projects"],
  summary: "List projects accessible to the authenticated API key",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            projects: z.array(ProjectSchema),
          }),
        },
      },
      description: "List of accessible projects",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
  },
});

const getProjectRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}`,
  tags: ["Projects"],
  summary: "Get project details",
  request: {
    params: ProjectIdParams,
  },
  responses: {
    200: {
      content: { "application/json": { schema: ProjectSchema } },
      description: "Project details",
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
      description: "Project not found",
    },
  },
});

const updateProjectRoute = createRoute({
  method: "patch",
  path: `${config.API_PREFIX}/projects/{projectId}`,
  tags: ["Projects"],
  summary: "Update a project",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(255).optional(),
            description: z.string().max(1000).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ProjectSchema } },
      description: "Updated project",
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
      description: "Project not found",
    },
  },
});

const deleteProjectRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/projects/{projectId}`,
  tags: ["Projects"],
  summary: "Delete a project and all associated data",
  request: {
    params: ProjectIdParams,
  },
  responses: {
    204: {
      description: "Project deleted successfully",
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
      description: "Project not found",
    },
  },
});

// ---- Router & Middleware ----

const projectRoutes = new OpenAPIHono<AppEnv>();

// Auth for GET /projects (skip POST — project creation is unauthenticated)
projectRoutes.use(`${config.API_PREFIX}/projects`, async (c, next) => {
  if (c.req.method === "POST") {
    await next();
    return;
  }
  return authMiddleware()(c, next);
});

// Auth for all /projects/:projectId routes
projectRoutes.use(
  `${config.API_PREFIX}/projects/:projectId`,
  authMiddleware(),
);

// ---- Handlers ----

// POST /api/v1/projects — Create project (no auth required)
projectRoutes.openapi(createProjectRoute, async (c) => {
  const body = c.req.valid("json");

  const result = await pool.query<ProjectRow>(
    `INSERT INTO projects (name, description)
     VALUES ($1, $2)
     RETURNING id, name, description, created_at, updated_at`,
    [body.name, body.description ?? null],
  );
  const project = result.rows[0];

  const apiKey = await createApiKey({
    projectId: project.id,
    permissions: ["read", "write"],
  });

  logger.info({ projectId: project.id }, "Project created");

  return c.json(
    {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        created_at: project.created_at,
        updated_at: project.updated_at,
      },
      api_key: {
        id: apiKey.id,
        key: apiKey.rawKey,
        key_prefix: apiKey.keyPrefix,
        permissions: apiKey.permissions,
        expires_at: apiKey.expiresAt,
        created_at: apiKey.createdAt,
      },
    },
    201,
  );
});

// GET /api/v1/projects — List projects (auth required)
projectRoutes.openapi(listProjectsRoute, async (c) => {
  const projectId = c.get("projectId");

  const result = await pool.query<ProjectRow>(
    `SELECT id, name, description, created_at, updated_at
     FROM projects WHERE id = $1`,
    [projectId],
  );

  return c.json({ projects: result.rows }, 200);
});

// GET /api/v1/projects/:projectId — Get details (auth required)
projectRoutes.openapi(getProjectRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await pool.query<ProjectRow>(
    `SELECT id, name, description, created_at, updated_at
     FROM projects WHERE id = $1`,
    [projectId],
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json(result.rows[0], 200);
});

// PATCH /api/v1/projects/:projectId — Update (auth + write required)
projectRoutes.openapi(updateProjectRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const permissions = c.get("keyPermissions");
  if (!permissions.includes("write")) {
    return c.json(
      { error: "Insufficient permissions: requires 'write'" },
      403,
    );
  }

  const body = c.req.valid("json");
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (body.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push(`description = $${idx++}`);
    values.push(body.description);
  }

  if (sets.length === 0) {
    const result = await pool.query<ProjectRow>(
      `SELECT id, name, description, created_at, updated_at
       FROM projects WHERE id = $1`,
      [projectId],
    );
    if (result.rows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(result.rows[0], 200);
  }

  sets.push("updated_at = NOW()");
  values.push(projectId);

  const result = await pool.query<ProjectRow>(
    `UPDATE projects SET ${sets.join(", ")}
     WHERE id = $${idx}
     RETURNING id, name, description, created_at, updated_at`,
    values,
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Project not found" }, 404);
  }

  logger.info({ projectId }, "Project updated");

  return c.json(result.rows[0], 200);
});

// DELETE /api/v1/projects/:projectId — Delete (auth + write required)
projectRoutes.openapi(deleteProjectRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const permissions = c.get("keyPermissions");
  if (!permissions.includes("write")) {
    return c.json(
      { error: "Insufficient permissions: requires 'write'" },
      403,
    );
  }

  const result = await pool.query(
    "DELETE FROM projects WHERE id = $1 RETURNING id",
    [projectId],
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Project not found" }, 404);
  }

  logger.info({ projectId }, "Project deleted");

  return c.body(null, 204);
});

export { projectRoutes };
