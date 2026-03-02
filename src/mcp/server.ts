import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createChildLogger } from "../logger.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import type { NexGraphApiClient } from "./api-client.js";

const log = createChildLogger("mcp");

export function createMcpServer(projectId: string, apiClient: NexGraphApiClient): McpServer {
  log.info({ projectId }, "Creating MCP server scoped to project");

  const server = new McpServer({
    name: "nexgraph",
    version: "0.3.0",
  }, {
    capabilities: {
      logging: {},
      resources: {},
    },
  });

  registerTools(server, projectId, apiClient);
  registerResources(server, projectId);

  return server;
}
