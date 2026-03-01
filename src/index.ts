import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { initBoss, stopBoss } from "./queue/boss.js";
import { registerIndexingWorker } from "./queue/indexingWorker.js";
import { registerEmbeddingReindexWorker } from "./queue/embeddingReindexWorker.js";
import { closeMcpSessions } from "./mcp/httpTransport.js";
import { closePool } from "./db/index.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

const app = createApp();

// Initialize pg-boss and register workers
initBoss()
  .then(() => registerIndexingWorker())
  .then(() => registerEmbeddingReindexWorker())
  .then(() => logger.info("Job queue initialized"))
  .catch((err) => {
    logger.error({ err }, "Failed to initialize job queue");
  });

const server = serve(
  {
    fetch: app.fetch,
    port: config.PORT,
    hostname: config.HOST,
  },
  (info) => {
    logger.info(
      { host: info.address, port: info.port, env: config.NODE_ENV },
      "NexGraph server started"
    );
  }
);

// Graceful shutdown
let shutdownInProgress = false;

async function shutdown(signal: string) {
  if (shutdownInProgress) {
    logger.warn({ signal }, "Shutdown already in progress, ignoring");
    return;
  }
  shutdownInProgress = true;

  logger.info({ signal }, "Graceful shutdown initiated");

  // Force exit if shutdown takes too long
  const forceTimer = setTimeout(() => {
    logger.error("Shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    // 1. Close MCP sessions
    await closeMcpSessions();

    // 2. Stop pg-boss (waits for in-flight jobs to finish)
    await stopBoss();

    // 3. Stop accepting new HTTP connections; wait for in-flight requests
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info("HTTP server closed");

    // 4. Close database connection pool
    await closePool();

    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
