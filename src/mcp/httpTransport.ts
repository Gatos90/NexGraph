import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "./server.js";
import { validateApiKey } from "../api/keys.js";
import { NexGraphApiClient } from "./api-client.js";
import { config } from "../config.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("mcp-http");

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

const sessions = new Map<string, McpSession>();

export const mcpRoutes = new Hono();

// Handle all MCP HTTP/SSE requests (POST, GET for SSE, DELETE for session close)
mcpRoutes.all("/mcp", async (c) => {
  const sessionId = c.req.header("mcp-session-id");

  // Existing session — route to its transport
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing.transport.handleRequest(c.req.raw);
    }
  }

  // New session — validate API key first
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization: Bearer <API_KEY> header" }, 401);
  }

  const rawKey = authHeader.slice(7);
  const apiKey = await validateApiKey(rawKey);
  if (!apiKey) {
    return c.json({ error: "Invalid, revoked, or expired API key" }, 401);
  }

  // Create loopback API client for in-process MCP
  const client = new NexGraphApiClient({
    baseUrl: `http://localhost:${config.PORT}`,
    apiKey: rawKey,
    projectId: apiKey.project_id,
  });

  const mcpServer = createMcpServer(apiKey.project_id, client);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server: mcpServer });
      log.info({ sessionId: sid, projectId: apiKey.project_id }, "MCP session initialized");
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
      log.info({ sessionId: sid }, "MCP session closed");
    },
  });

  await mcpServer.connect(transport);
  return transport.handleRequest(c.req.raw);
});

/** Close all active MCP sessions (called during graceful shutdown). */
export async function closeMcpSessions(): Promise<void> {
  const count = sessions.size;
  if (count === 0) return;

  log.info({ count }, "Closing active MCP sessions");
  const closing = [...sessions.values()].map((s) => s.transport.close());
  await Promise.allSettled(closing);
  sessions.clear();
}
