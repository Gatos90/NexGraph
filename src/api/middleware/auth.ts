import type { Context, Next } from "hono";
import type { AppEnv } from "../../app.js";
import { validateApiKey } from "../keys.js";
import { createChildLogger } from "../../logger.js";
import type { Permission } from "../keys.js";

const logger = createChildLogger("auth");

const BEARER_PREFIX = "Bearer ";

/**
 * Authentication middleware that validates API keys from the Authorization header.
 * Sets projectId, apiKeyId, and keyPermissions on the Hono context.
 */
export function authMiddleware() {
  return async (c: Context<AppEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    if (!authHeader.startsWith(BEARER_PREFIX)) {
      return c.json({ error: "Authorization header must use Bearer scheme" }, 401);
    }

    const rawKey = authHeader.slice(BEARER_PREFIX.length);

    if (!rawKey.startsWith("nxg_") || rawKey.length !== 68) {
      return c.json({ error: "Invalid API key format" }, 401);
    }

    const apiKey = await validateApiKey(rawKey);

    if (!apiKey) {
      return c.json({ error: "Invalid or expired API key" }, 401);
    }

    c.set("projectId", apiKey.project_id);
    c.set("apiKeyId", apiKey.id);
    c.set("keyPermissions", apiKey.permissions);

    logger.debug(
      { keyPrefix: apiKey.key_prefix, projectId: apiKey.project_id },
      "Authenticated request",
    );

    await next();
  };
}

/**
 * Permission-checking middleware. Must be used after authMiddleware.
 * Verifies the API key has the required permission(s).
 */
export function requirePermission(...required: Permission[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const permissions = c.get("keyPermissions");

    for (const perm of required) {
      if (!permissions.includes(perm)) {
        return c.json(
          { error: `Insufficient permissions: requires '${perm}'` },
          403,
        );
      }
    }

    await next();
  };
}
