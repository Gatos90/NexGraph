import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { createChildLogger } from "./logger.js";
import { apiKeyRoutes } from "./api/routes/apiKeys.js";
import { projectRoutes } from "./api/routes/projects.js";
import { repositoryRoutes } from "./api/routes/repositories.js";
import { indexingRoutes } from "./api/routes/indexing.js";
import { graphRoutes } from "./api/routes/graph.js";
import { connectionRoutes } from "./api/routes/connections.js";
import { crossRepoRoutes } from "./api/routes/crossRepo.js";
import { searchRoutes } from "./api/routes/search.js";
import { fileRoutes } from "./api/routes/files.js";
import { exportRoutes } from "./api/routes/export.js";
import { embeddingRoutes } from "./api/routes/embeddings.js";
import { integrationRoutes } from "./api/routes/integrations.js";
import { mcpRoutes } from "./mcp/httpTransport.js";
import type { Permission } from "./api/keys.js";

const log = createChildLogger("app");

export type AppEnv = {
  Variables: {
    requestId: string;
    projectId: string;
    apiKeyId: string;
    keyPermissions: Permission[];
  };
};

export function createApp() {
  const app = new OpenAPIHono<AppEnv>();

  // CORS
  app.use("*", cors());

  // Request logging middleware
  app.use("*", async (c, next) => {
    const start = Date.now();
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);

    await next();

    const duration = Date.now() - start;
    log.info({
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration,
      requestId,
    });
  });

  // Register routes
  app.route("/", projectRoutes);
  app.route("/", apiKeyRoutes);
  app.route("/", repositoryRoutes);
  app.route("/", indexingRoutes);
  app.route("/", graphRoutes);
  app.route("/", connectionRoutes);
  app.route("/", crossRepoRoutes);
  app.route("/", searchRoutes);
  app.route("/", fileRoutes);
  app.route("/", exportRoutes);
  app.route("/", embeddingRoutes);
  app.route("/", integrationRoutes);

  // MCP HTTP/SSE transport (for remote AI agents)
  app.route("/", mcpRoutes);

  // Health check endpoint (no auth)
  const healthRoute = createRoute({
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Health check",
    responses: {
      200: {
        description: "Service is healthy",
        content: {
          "application/json": {
            schema: z.object({
              status: z.string(),
              uptime: z.number(),
            }),
          },
        },
      },
    },
  });

  app.openapi(healthRoute, (c) => {
    return c.json({ status: "ok", uptime: process.uptime() }, 200);
  });

  // OpenAPI documentation endpoint
  app.doc31(`${config.API_PREFIX}/openapi.json`, {
    openapi: "3.1.0",
    info: {
      title: "NexGraph API",
      version: "0.3.1",
      description:
        "Headless Code Intelligence Engine — Build Knowledge Graphs, Let AI Agents Consume Them",
    },
  });

  return app;
}
