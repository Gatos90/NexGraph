import pino from "pino";
import { config } from "./config.js";

function buildLogger(): pino.Logger {
  const level = config.LOG_LEVEL;

  // MCP stdio transport uses stdout for JSON-RPC protocol messages,
  // so application logs must go to stderr to avoid corruption.
  if (process.env.MCP_STDIO === "1") {
    return pino({ level }, pino.destination(2));
  }

  if (config.NODE_ENV === "development") {
    return pino({
      level,
      transport: {
        target: "pino/file",
        options: { destination: 1 },
      },
    });
  }

  return pino({ level });
}

export const logger = buildLogger();

export function createChildLogger(name: string) {
  return logger.child({ component: name });
}
