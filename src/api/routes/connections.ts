import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";
import { resolveUrlPathMatching } from "../../ingestion/urlmatch.js";
import { resolveTypeMatching } from "../../ingestion/typematch.js";
import { resolvePackageDependencies } from "../../ingestion/pkgmatch.js";

const logger = createChildLogger("connections");

// ---- DB row type ----

interface ConnectionRow {
  id: string;
  project_id: string;
  source_repo_id: string;
  target_repo_id: string;
  connection_type: string;
  match_rules: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_resolved_at: string | null;
}

interface ConnectionWithEdgeCount extends ConnectionRow {
  edge_count: string;
}

// ---- Shared Schemas ----

const ConnectionType = z.enum([
  "CROSS_REPO_CALLS",
  "CROSS_REPO_IMPORTS",
  "CROSS_REPO_DEPENDS",
  "CROSS_REPO_MIRRORS",
]);

const MatchRulesSchema = z.record(z.unknown()).default({});

const ConnectionSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  source_repo_id: z.string().uuid(),
  target_repo_id: z.string().uuid(),
  connection_type: z.string(),
  match_rules: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  last_resolved_at: z.string().nullable(),
});

const ConnectionWithEdgeCountSchema = ConnectionSchema.extend({
  edge_count: z.number(),
});

const ErrorResponse = z.object({
  error: z.string(),
});

const ProjectIdParams = z.object({
  projectId: z.string().uuid(),
});

const ConnIdParams = z.object({
  projectId: z.string().uuid(),
  connId: z.string().uuid(),
});

// ---- Route Definitions ----

const createConnectionRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/connections`,
  tags: ["Connections"],
  summary: "Create a cross-repo connection rule",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            source_repo_id: z.string().uuid(),
            target_repo_id: z.string().uuid(),
            connection_type: ConnectionType,
            match_rules: MatchRulesSchema,
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: ConnectionSchema },
      },
      description: "Connection rule created",
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
      description: "Connection rule already exists",
    },
  },
});

const listConnectionsRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/connections`,
  tags: ["Connections"],
  summary: "List cross-repo connection rules",
  request: {
    params: ProjectIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            connections: z.array(ConnectionSchema),
          }),
        },
      },
      description: "List of connection rules",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
  },
});

const getConnectionRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/connections/{connId}`,
  tags: ["Connections"],
  summary: "Get connection rule details with resolved edge count",
  request: {
    params: ConnIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConnectionWithEdgeCountSchema },
      },
      description: "Connection rule with edge count",
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
      description: "Connection rule not found",
    },
  },
});

const updateConnectionRoute = createRoute({
  method: "patch",
  path: `${config.API_PREFIX}/projects/{projectId}/connections/{connId}`,
  tags: ["Connections"],
  summary: "Update a connection rule",
  request: {
    params: ConnIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            connection_type: ConnectionType.optional(),
            match_rules: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConnectionSchema },
      },
      description: "Updated connection rule",
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
      description: "Connection rule not found",
    },
  },
});

const deleteConnectionRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/projects/{projectId}/connections/{connId}`,
  tags: ["Connections"],
  summary: "Delete a connection rule and its resolved edges",
  request: {
    params: ConnIdParams,
  },
  responses: {
    204: {
      description: "Connection rule and resolved edges deleted",
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
      description: "Connection rule not found",
    },
  },
});

// ---- Route Definitions: Resolve & Edges ----

const CrossRepoEdgeSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  source_repo_id: z.string().uuid(),
  target_repo_id: z.string().uuid(),
  source_node: z.string(),
  target_node: z.string(),
  edge_type: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string(),
});

const ManualEdgeSchema = CrossRepoEdgeSchema.extend({
  manual: z.boolean(),
});

const ManualEdgeIdParams = z.object({
  projectId: z.string().uuid(),
  id: z.string().uuid(),
});

const resolveConnectionRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/connections/{connId}/resolve`,
  tags: ["Connections"],
  summary: "Trigger resolution for a connection (URL matching, type matching, etc.)",
  request: {
    params: ConnIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            connection_id: z.string().uuid(),
            edges_created: z.number(),
            strategy: z.string(),
            details: z.record(z.unknown()),
          }),
        },
      },
      description: "Resolution completed",
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
      description: "Connection rule not found",
    },
    422: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Resolution failed (repos not indexed)",
    },
  },
});

const listEdgesRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/connections/{connId}/edges`,
  tags: ["Connections"],
  summary: "List resolved cross-repo edges for a connection",
  request: {
    params: ConnIdParams,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
      offset: z.coerce.number().int().min(0).default(0).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            edges: z.array(CrossRepoEdgeSchema),
            total: z.number(),
          }),
        },
      },
      description: "List of resolved edges",
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
      description: "Connection rule not found",
    },
  },
});

// ---- Route Definitions: Manual Edges ----

const createManualEdgeRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/connections/manual-edge`,
  tags: ["Connections"],
  summary: "Create a manual cross-repo edge",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            source_repo_id: z.string().uuid(),
            target_repo_id: z.string().uuid(),
            source_node: z.string().min(1).max(500),
            target_node: z.string().min(1).max(500),
            edge_type: z.string().min(1).max(100),
            metadata: z.record(z.unknown()).nullable().default(null),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: ManualEdgeSchema },
      },
      description: "Manual edge created",
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
      description: "Repository not found in project",
    },
  },
});

const deleteManualEdgeRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/projects/{projectId}/connections/manual-edge/{id}`,
  tags: ["Connections"],
  summary: "Delete a manual cross-repo edge",
  request: {
    params: ManualEdgeIdParams,
  },
  responses: {
    204: {
      description: "Manual edge deleted",
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
      description: "Manual edge not found",
    },
  },
});

// ---- Router & Middleware ----

const connectionRoutes = new OpenAPIHono<AppEnv>();

// Auth + write for mutation endpoints, auth for read endpoints
connectionRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/connections`,
  authMiddleware(),
);
connectionRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/connections/manual-edge`,
  authMiddleware(),
);
connectionRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/connections/manual-edge/:id`,
  authMiddleware(),
);
connectionRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/connections/:connId`,
  authMiddleware(),
);
connectionRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/connections/:connId/resolve`,
  authMiddleware(),
);
connectionRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/connections/:connId/edges`,
  authMiddleware(),
);

// ---- Helpers ----

async function verifyRepoInProject(
  repoId: string,
  projectId: string,
): Promise<boolean> {
  const result = await pool.query(
    "SELECT id FROM repositories WHERE id = $1 AND project_id = $2",
    [repoId, projectId],
  );
  return result.rows.length > 0;
}

// ---- Handlers ----

// POST /api/v1/projects/:projectId/connections — Create connection rule
connectionRoutes.openapi(createConnectionRoute, async (c) => {
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

  // Verify both repos belong to this project
  const [sourceExists, targetExists] = await Promise.all([
    verifyRepoInProject(body.source_repo_id, projectId),
    verifyRepoInProject(body.target_repo_id, projectId),
  ]);

  if (!sourceExists) {
    return c.json({ error: "Source repository not found in project" }, 404);
  }
  if (!targetExists) {
    return c.json({ error: "Target repository not found in project" }, 404);
  }

  let result;
  try {
    result = await pool.query<ConnectionRow>(
      `INSERT INTO repo_connections
         (project_id, source_repo_id, target_repo_id, connection_type, match_rules)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id, source_repo_id, target_repo_id,
                 connection_type, match_rules, created_at, updated_at, last_resolved_at`,
      [
        projectId,
        body.source_repo_id,
        body.target_repo_id,
        body.connection_type,
        JSON.stringify(body.match_rules),
      ],
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("duplicate key value violates unique constraint")
    ) {
      return c.json(
        {
          error:
            "Connection rule already exists for this source/target/type combination",
        },
        409,
      );
    }
    throw err;
  }

  logger.info(
    {
      connId: result.rows[0].id,
      projectId,
      type: body.connection_type,
    },
    "Connection rule created",
  );

  return c.json(result.rows[0], 201);
});

// GET /api/v1/projects/:projectId/connections — List rules
connectionRoutes.openapi(listConnectionsRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await pool.query<ConnectionRow>(
    `SELECT id, project_id, source_repo_id, target_repo_id,
            connection_type, match_rules, created_at, updated_at, last_resolved_at
     FROM repo_connections
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId],
  );

  return c.json({ connections: result.rows }, 200);
});

// GET /api/v1/projects/:projectId/connections/:connId — Get rule + edge count
connectionRoutes.openapi(getConnectionRoute, async (c) => {
  const { projectId, connId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await pool.query<ConnectionWithEdgeCount>(
    `SELECT rc.id, rc.project_id, rc.source_repo_id, rc.target_repo_id,
            rc.connection_type, rc.match_rules, rc.created_at, rc.updated_at,
            rc.last_resolved_at, COUNT(cre.id)::text AS edge_count
     FROM repo_connections rc
     LEFT JOIN cross_repo_edges cre
       ON cre.source_repo_id = rc.source_repo_id
       AND cre.target_repo_id = rc.target_repo_id
       AND cre.edge_type = rc.connection_type
       AND cre.project_id = rc.project_id
     WHERE rc.id = $1 AND rc.project_id = $2
     GROUP BY rc.id`,
    [connId, projectId],
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Connection rule not found" }, 404);
  }

  const row = result.rows[0];

  return c.json(
    {
      id: row.id,
      project_id: row.project_id,
      source_repo_id: row.source_repo_id,
      target_repo_id: row.target_repo_id,
      connection_type: row.connection_type,
      match_rules: row.match_rules,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_resolved_at: row.last_resolved_at,
      edge_count: parseInt(row.edge_count, 10),
    },
    200,
  );
});

// PATCH /api/v1/projects/:projectId/connections/:connId — Update rule
connectionRoutes.openapi(updateConnectionRoute, async (c) => {
  const { projectId, connId } = c.req.valid("param");
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

  // Verify connection exists and belongs to project
  const check = await pool.query<{ project_id: string }>(
    "SELECT project_id FROM repo_connections WHERE id = $1",
    [connId],
  );

  if (check.rows.length === 0) {
    return c.json({ error: "Connection rule not found" }, 404);
  }

  if (check.rows[0].project_id !== projectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = c.req.valid("json");
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (body.connection_type !== undefined) {
    sets.push(`connection_type = $${idx++}`);
    values.push(body.connection_type);
  }
  if (body.match_rules !== undefined) {
    sets.push(`match_rules = $${idx++}`);
    values.push(JSON.stringify(body.match_rules));
  }

  if (sets.length === 0) {
    const result = await pool.query<ConnectionRow>(
      `SELECT id, project_id, source_repo_id, target_repo_id,
              connection_type, match_rules, created_at, updated_at, last_resolved_at
       FROM repo_connections WHERE id = $1`,
      [connId],
    );
    return c.json(result.rows[0], 200);
  }

  sets.push("updated_at = NOW()");
  values.push(connId);

  const result = await pool.query<ConnectionRow>(
    `UPDATE repo_connections SET ${sets.join(", ")}
     WHERE id = $${idx}
     RETURNING id, project_id, source_repo_id, target_repo_id,
               connection_type, match_rules, created_at, updated_at, last_resolved_at`,
    values,
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Connection rule not found" }, 404);
  }

  logger.info({ connId, projectId }, "Connection rule updated");

  return c.json(result.rows[0], 200);
});

// DELETE /api/v1/projects/:projectId/connections/:connId — Delete rule + resolved edges
connectionRoutes.openapi(deleteConnectionRoute, async (c) => {
  const { projectId, connId } = c.req.valid("param");
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

  // Fetch connection to verify existence and get repo/type info for edge cleanup
  const connResult = await pool.query<ConnectionRow>(
    `SELECT id, project_id, source_repo_id, target_repo_id, connection_type
     FROM repo_connections
     WHERE id = $1`,
    [connId],
  );

  if (connResult.rows.length === 0) {
    return c.json({ error: "Connection rule not found" }, 404);
  }

  if (connResult.rows[0].project_id !== projectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const conn = connResult.rows[0];

  // Delete resolved cross-repo edges for this connection
  const edgeResult = await pool.query(
    `DELETE FROM cross_repo_edges
     WHERE project_id = $1
       AND source_repo_id = $2
       AND target_repo_id = $3
       AND edge_type = $4`,
    [projectId, conn.source_repo_id, conn.target_repo_id, conn.connection_type],
  );

  // Delete the connection rule
  await pool.query("DELETE FROM repo_connections WHERE id = $1", [connId]);

  logger.info(
    {
      connId,
      projectId,
      edgesDeleted: edgeResult.rowCount,
    },
    "Connection rule and resolved edges deleted",
  );

  return c.body(null, 204);
});

// POST /api/v1/projects/:projectId/connections/:connId/resolve — Trigger resolution
connectionRoutes.openapi(resolveConnectionRoute, async (c) => {
  const { projectId, connId } = c.req.valid("param");
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

  // Load connection rule
  const connResult = await pool.query<ConnectionRow>(
    `SELECT id, project_id, source_repo_id, target_repo_id, connection_type
     FROM repo_connections
     WHERE id = $1`,
    [connId],
  );

  if (connResult.rows.length === 0) {
    return c.json({ error: "Connection rule not found" }, 404);
  }

  if (connResult.rows[0].project_id !== projectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const conn = connResult.rows[0];

  try {
    let responsePayload: {
      connection_id: string;
      edges_created: number;
      strategy: string;
      details: Record<string, unknown>;
    };

    if (conn.connection_type === "CROSS_REPO_MIRRORS") {
      const result = await resolveTypeMatching(
        connId,
        conn.source_repo_id,
        conn.target_repo_id,
        projectId,
      );

      responsePayload = {
        connection_id: connId,
        edges_created: result.edgesCreated,
        strategy: "type_matching",
        details: {
          source_types_loaded: result.sourceTypesLoaded,
          target_types_loaded: result.targetTypesLoaded,
          matches_found: result.matchesFound,
        },
      };
    } else if (conn.connection_type === "CROSS_REPO_CALLS") {
      const result = await resolveUrlPathMatching(
        connId,
        conn.source_repo_id,
        conn.target_repo_id,
        projectId,
      );

      responsePayload = {
        connection_id: connId,
        edges_created: result.edgesCreated,
        strategy: "url_path_matching",
        details: {
          calls_detected: result.callsDetected,
          routes_loaded: result.routesLoaded,
        },
      };
    } else if (conn.connection_type === "CROSS_REPO_DEPENDS") {
      const result = await resolvePackageDependencies(
        connId,
        conn.source_repo_id,
        conn.target_repo_id,
        projectId,
      );

      responsePayload = {
        connection_id: connId,
        edges_created: result.edgesCreated,
        strategy: "package_dependency_matching",
        details: {
          dependencies_found: result.dependenciesFound,
          repos_scanned: result.reposScanned,
          matches_found: result.matchesFound,
        },
      };
    } else {
      return c.json(
        { error: `No resolution strategy available for connection type '${conn.connection_type}'` },
        422,
      );
    }

    // Update last_resolved_at timestamp
    await pool.query(
      "UPDATE repo_connections SET last_resolved_at = NOW() WHERE id = $1",
      [connId],
    );

    logger.info(
      { connId, projectId, ...responsePayload },
      "Connection resolution completed",
    );

    return c.json(responsePayload, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Resolution failed";
    logger.error({ connId, projectId, err }, "Connection resolution failed");
    return c.json({ error: message }, 422);
  }
});

// GET /api/v1/projects/:projectId/connections/:connId/edges — List resolved edges
connectionRoutes.openapi(listEdgesRoute, async (c) => {
  const { projectId, connId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Load connection rule to get repo IDs and type
  const connResult = await pool.query<ConnectionRow>(
    `SELECT id, project_id, source_repo_id, target_repo_id, connection_type
     FROM repo_connections
     WHERE id = $1`,
    [connId],
  );

  if (connResult.rows.length === 0) {
    return c.json({ error: "Connection rule not found" }, 404);
  }

  if (connResult.rows[0].project_id !== projectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const conn = connResult.rows[0];
  const query = c.req.valid("query");
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  // Count total edges
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM cross_repo_edges
     WHERE project_id = $1
       AND source_repo_id = $2
       AND target_repo_id = $3
       AND edge_type = $4`,
    [projectId, conn.source_repo_id, conn.target_repo_id, conn.connection_type],
  );

  const total = parseInt(countResult.rows[0].count, 10);

  // Fetch edges with pagination
  interface CrossRepoEdgeRow {
    id: string;
    project_id: string;
    source_repo_id: string;
    target_repo_id: string;
    source_node: string;
    target_node: string;
    edge_type: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }

  const edgesResult = await pool.query<CrossRepoEdgeRow>(
    `SELECT id, project_id, source_repo_id, target_repo_id,
            source_node, target_node, edge_type, metadata, created_at
     FROM cross_repo_edges
     WHERE project_id = $1
       AND source_repo_id = $2
       AND target_repo_id = $3
       AND edge_type = $4
     ORDER BY created_at DESC
     LIMIT $5 OFFSET $6`,
    [
      projectId,
      conn.source_repo_id,
      conn.target_repo_id,
      conn.connection_type,
      limit,
      offset,
    ],
  );

  return c.json(
    {
      edges: edgesResult.rows,
      total,
    },
    200,
  );
});

// ---- Manual Edge Handlers ----

interface ManualEdgeRow {
  id: string;
  project_id: string;
  source_repo_id: string;
  target_repo_id: string;
  source_node: string;
  target_node: string;
  edge_type: string;
  metadata: Record<string, unknown> | null;
  manual: boolean;
  created_at: string;
}

// POST /api/v1/projects/:projectId/connections/manual-edge — Create manual cross-repo edge
connectionRoutes.openapi(createManualEdgeRoute, async (c) => {
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

  // Verify both repos belong to this project
  const [sourceExists, targetExists] = await Promise.all([
    verifyRepoInProject(body.source_repo_id, projectId),
    verifyRepoInProject(body.target_repo_id, projectId),
  ]);

  if (!sourceExists) {
    return c.json({ error: "Source repository not found in project" }, 404);
  }
  if (!targetExists) {
    return c.json({ error: "Target repository not found in project" }, 404);
  }

  const result = await pool.query<ManualEdgeRow>(
    `INSERT INTO cross_repo_edges
       (project_id, source_repo_id, target_repo_id, source_node, target_node, edge_type, metadata, manual)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     RETURNING id, project_id, source_repo_id, target_repo_id,
               source_node, target_node, edge_type, metadata, manual, created_at`,
    [
      projectId,
      body.source_repo_id,
      body.target_repo_id,
      body.source_node,
      body.target_node,
      body.edge_type,
      body.metadata ? JSON.stringify(body.metadata) : null,
    ],
  );

  logger.info(
    {
      edgeId: result.rows[0].id,
      projectId,
      edgeType: body.edge_type,
      sourceNode: body.source_node,
      targetNode: body.target_node,
    },
    "Manual cross-repo edge created",
  );

  return c.json(result.rows[0], 201);
});

// DELETE /api/v1/projects/:projectId/connections/manual-edge/:id — Delete manual edge
connectionRoutes.openapi(deleteManualEdgeRoute, async (c) => {
  const { projectId, id } = c.req.valid("param");
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
    `DELETE FROM cross_repo_edges
     WHERE id = $1 AND project_id = $2 AND manual = TRUE`,
    [id, projectId],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Manual edge not found" }, 404);
  }

  logger.info({ edgeId: id, projectId }, "Manual cross-repo edge deleted");

  return c.body(null, 204);
});

export { connectionRoutes };
