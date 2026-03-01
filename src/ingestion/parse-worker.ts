/**
 * Worker thread script for parallel AST parsing.
 * Receives file tasks, parses with tree-sitter, returns extracted symbols.
 *
 * Imports only from parse-core.ts (no DB dependencies).
 */
import { parentPort } from "node:worker_threads";
import fsp from "node:fs/promises";
import { parseFileContent } from "./parse-core.js";
import { detectRouteHandlers } from "./routes.js";
import type { ParsedSymbol } from "./parse-core.js";
import type { DetectedRoute } from "./routes.js";

// ─── Message Types ──────────────────────────────────────────

export interface ParseTask {
  id: number;
  absolutePath: string;
  relativePath: string;
  language: string;
}

export interface ParseTaskResult {
  id: number;
  relativePath: string;
  symbols: ParsedSymbol[];
  routes: DetectedRoute[];
  error?: string;
}

// ─── Message Handler ────────────────────────────────────────

if (!parentPort) {
  throw new Error("parse-worker.ts must be run as a worker thread");
}

const port = parentPort;

port.on("message", async (task: ParseTask) => {
  try {
    const source = await fsp.readFile(task.absolutePath, "utf-8");

    const symbols = parseFileContent(source, task.relativePath, task.language);
    const routes = detectRouteHandlers(source, task.language);

    const result: ParseTaskResult = {
      id: task.id,
      relativePath: task.relativePath,
      symbols,
      routes,
    };
    port.postMessage(result);
  } catch (err) {
    const result: ParseTaskResult = {
      id: task.id,
      relativePath: task.relativePath,
      symbols: [],
      routes: [],
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(result);
  }
});
