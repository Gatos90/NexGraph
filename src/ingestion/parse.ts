import fsp from "node:fs/promises";
import { pool } from "../db/connection.js";
import { cypherWithClient } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import { config } from "../config.js";
import { detectLanguage } from "./structure.js";
import { detectRouteHandlers } from "./routes.js";
import type { DetectedRoute } from "./routes.js";
import type { ExtractResult, ProgressCallback } from "./extract.js";
import { parseFileContent } from "./parse-core.js";
import type { ParsedSymbol } from "./parse-core.js";
import { WorkerPool, resolvePoolSize } from "./worker-pool.js";
import type { ParseTaskResult } from "./parse-worker.js";

export type { ParsedSymbol } from "./parse-core.js";

const logger = createChildLogger("parse");

function symbolToNodeLabel(symbol: ParsedSymbol): string {
  switch (symbol.kind) {
    case "function":
      return "Function";
    case "class":
      return "Class";
    case "interface":
      return "Interface";
    case "method":
      return "Method";
    case "struct":
      return "Struct";
    case "enum":
      return "Enum";
    case "trait":
      return "Trait";
    case "type_alias":
      return "TypeAlias";
    case "namespace":
      return "Namespace";
    case "code_element":
      return "CodeElement";
  }
}

interface CypherTemplate {
  query: string;
  params: Record<string, unknown>;
}

function buildCreateQuery(
  label: string,
  symbol: ParsedSymbol,
  filePath: string,
): CypherTemplate {
  switch (symbol.kind) {
    case "function":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, params: $params, signature: $signature, is_async: $is_async, is_generator: $is_generator}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          params: symbol.params,
          signature: symbol.signature,
          is_async: symbol.isAsync,
          is_generator: symbol.isGenerator,
        },
      };

    case "class":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature, decorators: $decorators, is_abstract: $is_abstract}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
          decorators: symbol.decorators,
          is_abstract: symbol.isAbstract,
        },
      };

    case "interface":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
        },
      };

    case "method":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, params: $params, signature: $signature, decorators: $decorators, is_abstract: $is_abstract, visibility: $visibility, is_static: $is_static, is_async: $is_async, class_name: $class_name}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          params: symbol.params,
          signature: symbol.signature,
          decorators: symbol.decorators,
          is_abstract: symbol.isAbstract,
          visibility: symbol.visibility,
          is_static: symbol.isStatic,
          is_async: symbol.isAsync,
          class_name: symbol.className,
        },
      };

    case "struct":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature, element_type: $element_type}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
          element_type: symbol.elementType,
        },
      };

    case "enum":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature, element_type: $element_type}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
          element_type: symbol.elementType,
        },
      };

    case "trait":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
        },
      };

    case "type_alias":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature, element_type: $element_type}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
          element_type: symbol.elementType,
        },
      };

    case "namespace":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature, element_type: $element_type}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
          element_type: symbol.elementType,
        },
      };

    case "code_element":
      return {
        query: `CREATE (v:${label} {name: $name, file_path: $file_path, start_line: $start_line, end_line: $end_line, exported: $exported, export_default: $export_default, signature: $signature, element_type: $element_type}) RETURN v`,
        params: {
          name: symbol.name,
          file_path: filePath,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported,
          export_default: symbol.exportDefault,
          signature: symbol.signature,
          element_type: symbol.elementType,
        },
      };
  }
}

function buildRouteHandlerQuery(
  route: DetectedRoute,
  filePath: string,
): CypherTemplate {
  return {
    query: `CREATE (v:RouteHandler {http_method: $http_method, url_pattern: $url_pattern, framework: $framework, start_line: $start_line, handler_name: $handler_name, file_path: $file_path}) RETURN v`,
    params: {
      http_method: route.httpMethod,
      url_pattern: route.urlPattern,
      framework: route.framework,
      start_line: route.startLine,
      handler_name: route.handlerName,
      file_path: filePath,
    },
  };
}

// ─── Types ──────────────────────────────────────────────────

export interface ParseResult {
  symbolCount: number;
  definesEdgeCount: number;
  routeHandlerCount: number;
  exposesEdgeCount: number;
  filesParsed: number;
  filesSkipped: number;
}

interface FileParseResult {
  relativePath: string;
  symbols: ParsedSymbol[];
  routes: DetectedRoute[];
  error?: string;
}

// ─── Supported Languages ────────────────────────────────────

const PARSEABLE_LANGUAGES = new Set([
  "typescript", "javascript", "python", "rust", "go", "java",
]);

const ROUTE_ONLY_LANGUAGES = new Set(["ruby"]);

// ─── Worker Pool Parsing ────────────────────────────────────

const WORKER_URL = new URL("./parse-worker.js", import.meta.url);

async function parseFilesWithPool(
  files: Array<{ absolutePath: string; relativePath: string; language: string }>,
  onProgress?: (parsed: number, total: number) => void,
): Promise<FileParseResult[]> {
  const poolSize = resolvePoolSize(config.WORKER_POOL_SIZE);
  const workerPool = new WorkerPool(WORKER_URL, poolSize);

  logger.info(
    { poolSize: workerPool.size, files: files.length },
    "Parsing files with worker pool",
  );

  const results: FileParseResult[] = [];
  let completed = 0;

  try {
    const promises = files.map((file, idx) =>
      workerPool
        .exec({
          id: idx,
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
          language: file.language,
        })
        .then((raw) => {
          const result = raw as unknown as ParseTaskResult;
          results.push({
            relativePath: result.relativePath,
            symbols: result.symbols as ParsedSymbol[],
            routes: result.routes,
            error: result.error,
          });
          completed++;
          if (completed % 20 === 0 || completed === files.length) {
            onProgress?.(completed, files.length);
          }
        }),
    );

    await Promise.all(promises);
  } finally {
    await workerPool.destroy();
  }

  return results;
}

// ─── Single-threaded Fallback ───────────────────────────────

async function parseFilesSingleThreaded(
  files: Array<{ absolutePath: string; relativePath: string; language: string }>,
  onProgress?: (parsed: number, total: number) => void,
): Promise<FileParseResult[]> {
  const results: FileParseResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const source = await fsp.readFile(file.absolutePath, "utf-8");
      const symbols = parseFileContent(source, file.relativePath, file.language);
      const routes = detectRouteHandlers(source, file.language);
      results.push({ relativePath: file.relativePath, symbols, routes });
    } catch (err) {
      results.push({
        relativePath: file.relativePath,
        symbols: [],
        routes: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if ((i + 1) % 20 === 0 || i === files.length - 1) {
      onProgress?.(i + 1, files.length);
    }
  }

  return results;
}

// ─── Main Parse Function ────────────────────────────────────

/**
 * Ingestion Phase 3 (30–70%): Parse source files with tree-sitter and detect route handlers.
 *
 * Uses a worker_threads pool for parallel AST parsing when file count justifies it.
 * Workers handle the CPU-intensive tree-sitter parsing; graph writes stay on the main thread.
 */
export async function parseSymbols(
  graphName: string,
  extractResult: ExtractResult,
  onProgress?: ProgressCallback,
): Promise<ParseResult> {
  onProgress?.(30, "Starting AST parsing");

  // Classify files for processing
  const parseableFiles: Array<{ file: typeof extractResult.files[0]; language: string }> = [];
  const routeOnlyFiles: Array<{ file: typeof extractResult.files[0]; language: string }> = [];

  for (const f of extractResult.files) {
    const lang = detectLanguage(f.relativePath);
    if (PARSEABLE_LANGUAGES.has(lang)) {
      parseableFiles.push({ file: f, language: lang });
    } else if (ROUTE_ONLY_LANGUAGES.has(lang)) {
      routeOnlyFiles.push({ file: f, language: lang });
    }
  }

  logger.info(
    {
      graphName,
      totalFiles: extractResult.files.length,
      parseableFiles: parseableFiles.length,
      routeOnlyFiles: routeOnlyFiles.length,
    },
    "Starting AST parsing phase",
  );

  // ── Step 1: Parallel AST parsing via worker pool ──────────

  const fileTasks = parseableFiles.map((pf) => ({
    absolutePath: pf.file.absolutePath,
    relativePath: pf.file.relativePath,
    language: pf.language,
  }));

  const poolSize = resolvePoolSize(config.WORKER_POOL_SIZE);
  // Use worker pool when there are enough files to justify the overhead
  const usePool = fileTasks.length >= poolSize;

  const parseResults = await (usePool
    ? parseFilesWithPool(fileTasks, (done, total) => {
        const progress = 32 + (done / total) * 30;
        onProgress?.(Math.round(progress), `Parsing files: ${done}/${total}`);
      })
    : parseFilesSingleThreaded(fileTasks, (done, total) => {
        const progress = 32 + (done / total) * 30;
        onProgress?.(Math.round(progress), `Parsing files: ${done}/${total}`);
      }));

  onProgress?.(62, `Parsed ${parseResults.length} files, writing to graph`);

  // ── Step 2: Write results to graph in single transaction ──

  const client = await pool.connect();
  let symbolCount = 0;
  let definesEdgeCount = 0;
  let routeHandlerCount = 0;
  let exposesEdgeCount = 0;
  let filesParsed = 0;
  let filesSkipped = 0;

  try {
    await client.query("BEGIN");

    // Build file path → AGE node ID map
    const fileIdMap = new Map<string, number>();
    const fileRows = await cypherWithClient<{ v: AgeVertex }>(
      client,
      graphName,
      "MATCH (v:File) RETURN v",
      undefined,
      [{ name: "v" }],
    );
    for (const row of fileRows) {
      fileIdMap.set(row.v.properties.path as string, row.v.id);
    }

    onProgress?.(63, `Loaded ${fileIdMap.size} file nodes from graph`);

    // Helper: create RouteHandler nodes and EXPOSES edges
    async function createRouteNodes(
      fileId: number,
      routes: DetectedRoute[],
      filePath: string,
    ): Promise<void> {
      for (const route of routes) {
        const { query, params } = buildRouteHandlerQuery(route, filePath);
        const rows = await cypherWithClient<{ v: AgeVertex }>(
          client,
          graphName,
          query,
          params,
          [{ name: "v" }],
        );
        routeHandlerCount++;

        const routeNodeId = rows[0].v.id;
        await cypherWithClient(
          client,
          graphName,
          `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:EXPOSES]->(b) RETURN e`,
          { start_id: fileId, end_id: routeNodeId },
          [{ name: "e" }],
        );
        exposesEdgeCount++;
      }
    }

    // Write parsed symbols to graph
    for (const result of parseResults) {
      if (result.error) {
        logger.warn({ path: result.relativePath, error: result.error }, "File parse error, skipping");
        filesSkipped++;
        continue;
      }

      const fileId = fileIdMap.get(result.relativePath);
      if (fileId === undefined) {
        logger.warn({ path: result.relativePath }, "File node not found in graph, skipping");
        filesSkipped++;
        continue;
      }

      for (const symbol of result.symbols) {
        const label = symbolToNodeLabel(symbol);
        const { query, params } = buildCreateQuery(label, symbol, result.relativePath);

        const rows = await cypherWithClient<{ v: AgeVertex }>(
          client,
          graphName,
          query,
          params,
          [{ name: "v" }],
        );
        symbolCount++;

        const symbolId = rows[0].v.id;
        await cypherWithClient(
          client,
          graphName,
          `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:DEFINES]->(b) RETURN e`,
          { start_id: fileId, end_id: symbolId },
          [{ name: "e" }],
        );
        definesEdgeCount++;
      }

      if (result.routes.length > 0) {
        await createRouteNodes(fileId, result.routes, result.relativePath);
      }

      filesParsed++;
    }

    // Route detection for non-parseable files (ruby, etc.)
    for (let i = 0; i < routeOnlyFiles.length; i++) {
      const { file, language } = routeOnlyFiles[i];

      const fileId = fileIdMap.get(file.relativePath);
      if (fileId === undefined) continue;

      let source: string;
      try {
        source = await fsp.readFile(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      const routes = detectRouteHandlers(source, language);
      if (routes.length > 0) {
        await createRouteNodes(fileId, routes, file.relativePath);
      }

      if (i % 50 === 0 || i === routeOnlyFiles.length - 1) {
        const progress = 65 + ((i + 1) / routeOnlyFiles.length) * 3;
        onProgress?.(
          Math.round(progress),
          `Detecting routes: ${i + 1}/${routeOnlyFiles.length} (${routeHandlerCount} routes)`,
        );
      }
    }

    await client.query("COMMIT");

    onProgress?.(
      70,
      `AST parsing complete: ${filesParsed} files, ${symbolCount} symbols, ${routeHandlerCount} routes`,
    );

    logger.info(
      {
        graphName,
        filesParsed,
        filesSkipped,
        symbolCount,
        definesEdgeCount,
        routeHandlerCount,
        exposesEdgeCount,
        workerPool: usePool,
      },
      "AST parsing complete",
    );

    return {
      symbolCount,
      definesEdgeCount,
      routeHandlerCount,
      exposesEdgeCount,
      filesParsed,
      filesSkipped,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ graphName, err }, "AST parsing failed, rolled back");
    throw err;
  } finally {
    client.release();
  }
}
