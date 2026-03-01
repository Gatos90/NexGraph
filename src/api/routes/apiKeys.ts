import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { createApiKey } from "../keys.js";
import { authMiddleware, requirePermission } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";

const logger = createChildLogger("api-keys-routes");

// ---- Shared Schemas ----

const ProjectIdParams = z.object({
  projectId: z.string().uuid(),
});

const KeyIdParams = z.object({
  projectId: z.string().uuid(),
  keyId: z.string().uuid(),
});

const ApiKeyCreatedResponse = z.object({
  id: z.string().uuid(),
  key: z.string().describe("Full API key — shown only once"),
  key_prefix: z.string(),
  label: z.string().nullable(),
  permissions: z.array(z.enum(["read", "write"])),
  expires_at: z.string().nullable(),
  created_at: z.string(),
});

const ApiKeyListItem = z.object({
  id: z.string().uuid(),
  key_prefix: z.string(),
  label: z.string().nullable(),
  permissions: z.array(z.enum(["read", "write"])),
  revoked: z.boolean(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
});

const ErrorResponse = z.object({
  error: z.string(),
});

// ---- Route Definitions ----

const createApiKeyRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/api-keys`,
  tags: ["API Keys"],
  summary: "Generate a new API key for a project",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            label: z.string().optional(),
            permissions: z
              .array(z.enum(["read", "write"]))
              .min(1)
              .default(["read", "write"]),
            expires_at: z
              .string()
              .datetime()
              .optional()
              .describe("ISO 8601 expiry date"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: ApiKeyCreatedResponse },
      },
      description: "API key created. The full key is only shown once.",
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

const listApiKeysRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/api-keys`,
  tags: ["API Keys"],
  summary: "List API keys for a project (prefix only, never full key)",
  request: {
    params: ProjectIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            api_keys: z.array(ApiKeyListItem),
          }),
        },
      },
      description: "List of API keys",
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

const revokeApiKeyRoute = createRoute({
  method: "delete",
  path: `${config.API_PREFIX}/projects/{projectId}/api-keys/{keyId}`,
  tags: ["API Keys"],
  summary: "Revoke an API key",
  request: {
    params: KeyIdParams,
  },
  responses: {
    204: {
      description: "API key revoked successfully",
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
      description: "API key not found",
    },
  },
});

// ---- Router & Middleware ----

const apiKeyRoutes = new OpenAPIHono<AppEnv>();

// Auth + write permission for all api-keys routes
apiKeyRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/api-keys`,
  authMiddleware(),
);
apiKeyRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/api-keys`,
  requirePermission("write"),
);
apiKeyRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/api-keys/:keyId`,
  authMiddleware(),
);
apiKeyRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/api-keys/:keyId`,
  requirePermission("write"),
);

// ---- Handlers ----

// POST /api/v1/projects/:projectId/api-keys — Generate key
apiKeyRoutes.openapi(createApiKeyRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = c.req.valid("json");

  const result = await createApiKey({
    projectId,
    label: body.label,
    permissions: body.permissions,
    expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
  });

  logger.info({ keyPrefix: result.keyPrefix, projectId }, "API key generated");

  return c.json(
    {
      id: result.id,
      key: result.rawKey,
      key_prefix: result.keyPrefix,
      label: result.label,
      permissions: result.permissions,
      expires_at: result.expiresAt,
      created_at: result.createdAt,
    },
    201,
  );
});

// GET /api/v1/projects/:projectId/api-keys — List keys (prefix only)
apiKeyRoutes.openapi(listApiKeysRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await pool.query(
    `SELECT id, key_prefix, label, permissions, revoked, expires_at, created_at
     FROM api_keys
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId],
  );

  return c.json({ api_keys: result.rows }, 200);
});

// DELETE /api/v1/projects/:projectId/api-keys/:keyId — Revoke key
apiKeyRoutes.openapi(revokeApiKeyRoute, async (c) => {
  const { projectId, keyId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await pool.query(
    `UPDATE api_keys SET revoked = TRUE
     WHERE id = $1 AND project_id = $2 AND revoked = FALSE
     RETURNING id`,
    [keyId, projectId],
  );

  if (result.rows.length === 0) {
    return c.json({ error: "API key not found or already revoked" }, 404);
  }

  logger.info({ keyId, projectId }, "API key revoked");

  return c.body(null, 204);
});

export { apiKeyRoutes };
