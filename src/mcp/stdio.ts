#!/usr/bin/env node

// MCP stdio transport uses stdout for JSON-RPC protocol messages.
// Redirect application logs to stderr before any modules load.
process.env.MCP_STDIO = "1";

async function main() {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { createMcpServer } = await import("./server.js");
  const { NexGraphApiClient } = await import("./api-client.js");

  const rawKey = process.env.NEXGRAPH_API_KEY;
  if (!rawKey) {
    process.stderr.write(
      "Error: NEXGRAPH_API_KEY environment variable is required.\n" +
      "Set it in your MCP client config (e.g. Claude Code settings).\n",
    );
    process.exit(1);
  }

  const apiUrl = process.env.NEXGRAPH_API_URL;
  if (!apiUrl) {
    process.stderr.write(
      "Error: NEXGRAPH_API_URL environment variable is required.\n" +
      "Set it to the NexGraph API base URL (e.g. http://localhost:3000).\n",
    );
    process.exit(1);
  }

  // Discover the project by calling GET /projects with the API key
  const client = await NexGraphApiClient.discover({
    baseUrl: apiUrl,
    apiKey: rawKey,
  });

  const server = createMcpServer(client.projectId, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Failed to start MCP stdio server: ${err}\n`);
  process.exit(1);
});
