import { pool } from "../db/connection.js";
import { cypher } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { config } from "../config.js";
import { createChildLogger } from "../logger.js";
import type { ProgressCallback } from "./extract.js";
import path from "node:path";
import {
  embedManyForProject,
  embedQueryForProject,
} from "../embeddings/provider.js";
import { getOrCreateProjectEmbeddingConfig } from "../embeddings/config.js";
import {
  deleteStaleSymbolEmbeddings,
  upsertSymbolEmbedding,
} from "../embeddings/store.js";

const logger = createChildLogger("embeddings");

// ─── Types ──────────────────────────────────────────────────

export interface EmbeddingResult {
  symbolsEmbedded: number;
  staleDeleted: number;
}

interface SymbolForEmbedding {
  ageId: number;
  name: string;
  filePath: string;
  label: string;
  params?: string;
  signature?: string;
  className?: string;
  startLine?: number;
  endLine?: number;
}

// ─── Text Representation ────────────────────────────────────

const MAX_SIGNATURE_CHARS = 1000;
const MAX_SNIPPET_LINES = 120;
const MAX_SNIPPET_CHARS = 4000;

function asOptionalString(
  value: unknown,
  maxChars: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars)}...`
    : trimmed;
}

function asPositiveLine(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function extractCodeSnippet(
  fileContent: string | undefined,
  startLine: number | undefined,
  endLine: number | undefined,
): string | undefined {
  if (!fileContent) return undefined;

  const lines = fileContent.split(/\r?\n/);
  if (lines.length === 0) return undefined;

  const from = Math.max(0, (startLine ?? 1) - 1);
  let to = endLine
    ? Math.min(lines.length, endLine)
    : Math.min(lines.length, from + MAX_SNIPPET_LINES);

  if (to <= from) {
    to = Math.min(lines.length, from + MAX_SNIPPET_LINES);
  }
  if (to - from > MAX_SNIPPET_LINES) {
    to = from + MAX_SNIPPET_LINES;
  }

  let snippet = lines.slice(from, to).join("\n").trim();
  if (snippet.length === 0) return undefined;
  if (snippet.length > MAX_SNIPPET_CHARS) {
    snippet = `${snippet.slice(0, MAX_SNIPPET_CHARS)}\n...`;
  }
  return snippet;
}

export function buildTextRepresentation(
  sym: SymbolForEmbedding,
  fileContent?: string,
): string {
  const parts = [
    `Label: ${sym.label}`,
    `Name: ${sym.name}`,
    `Path: ${sym.filePath}`,
  ];

  if (sym.className) {
    parts.push(`Container: ${sym.className}`);
  }
  if (sym.params) {
    parts.push(`Parameters: ${sym.params}`);
  }
  if (sym.signature) {
    parts.push(`Signature: ${sym.signature}`);
  }

  const snippet = extractCodeSnippet(fileContent, sym.startLine, sym.endLine);
  if (snippet) {
    parts.push(`Code:\n${snippet}`);
  }

  return parts.join("\n");
}

function mapDefinedSymbolRow(
  label: string,
  row: { n: AgeVertex; file_path: unknown },
): SymbolForEmbedding | null {
  const props = row.n.properties;
  const name = asOptionalString(props.name, 255);
  const filePath = asOptionalString(row.file_path, 2048);
  if (!name || !filePath) return null;

  return {
    ageId: row.n.id,
    name,
    filePath,
    label,
    params: asOptionalString(props.params, 1000),
    signature: asOptionalString(props.signature, MAX_SIGNATURE_CHARS),
    className: asOptionalString(props.class_name, 255),
    startLine: asPositiveLine(props.start_line),
    endLine: asPositiveLine(props.end_line),
  };
}

// ─── Symbol Collector ───────────────────────────────────────

const DEFINES_SYMBOL_LABELS = [
  "Function",
  "Class",
  "Interface",
  "Method",
  "CodeElement",
  "Struct",
  "Enum",
  "Trait",
  "TypeAlias",
  "Namespace",
] as const;

async function collectDefinedSymbols(
  graphName: string,
): Promise<SymbolForEmbedding[]> {
  const symbols: SymbolForEmbedding[] = [];

  for (const label of DEFINES_SYMBOL_LABELS) {
    try {
      const rows = await cypher<{ n: AgeVertex; file_path: unknown }>(
        graphName,
        `MATCH (f:File)-[:DEFINES]->(n:${label}) RETURN n, f.path AS file_path`,
        {},
        [{ name: "n" }, { name: "file_path" }],
      );

      for (const row of rows) {
        const mapped = mapDefinedSymbolRow(label, row);
        if (mapped) {
          symbols.push(mapped);
        }
      }
    } catch {
      // Label may not exist in graph
    }
  }

  return symbols;
}

async function collectRouteHandlerSymbols(
  graphName: string,
): Promise<SymbolForEmbedding[]> {
  try {
    const rows = await cypher<{ n: AgeVertex; file_path: unknown }>(
      graphName,
      "MATCH (f:File)-[:EXPOSES]->(n:RouteHandler) RETURN n, f.path AS file_path",
      {},
      [{ name: "n" }, { name: "file_path" }],
    );

    const symbols: SymbolForEmbedding[] = [];
    for (const row of rows) {
      const props = row.n.properties;
      const filePath = asOptionalString(row.file_path, 2048);
      if (!filePath) continue;

      const handlerName =
        asOptionalString(props.handler_name, 255) ??
        asOptionalString(props.url_pattern, 512) ??
        "(anonymous-route)";

      const httpMethod = asOptionalString(props.http_method, 32);
      const urlPattern = asOptionalString(props.url_pattern, 512);
      const framework = asOptionalString(props.framework, 64);
      const signatureParts = [framework, httpMethod, urlPattern].filter(
        (x): x is string => !!x,
      );

      symbols.push({
        ageId: row.n.id,
        name: handlerName,
        filePath,
        label: "RouteHandler",
        params: urlPattern,
        signature:
          signatureParts.length > 0
            ? signatureParts.join(" ")
            : undefined,
        startLine: asPositiveLine(props.start_line),
      });
    }
    return symbols;
  } catch {
    // Label may not exist in graph.
    return [];
  }
}

async function collectFileSymbols(
  graphName: string,
): Promise<SymbolForEmbedding[]> {
  const rows = await cypher<{ f: AgeVertex }>(
    graphName,
    "MATCH (f:File) RETURN f",
    {},
    [{ name: "f" }],
  );

  const symbols: SymbolForEmbedding[] = [];
  for (const row of rows) {
    const props = row.f.properties;
    const filePath = asOptionalString(props.path, 2048);
    if (!filePath) continue;

    const fileName = asOptionalString(props.name, 255) ?? path.basename(filePath);
    const language = asOptionalString(props.language, 64);
    const lineCount = asPositiveLine(props.line_count);

    symbols.push({
      ageId: row.f.id,
      name: fileName,
      filePath,
      label: "File",
      signature: language ? `language=${language}` : undefined,
      startLine: 1,
      endLine: lineCount,
    });
  }
  return symbols;
}

interface FileContentRow {
  file_path: string;
  content: string;
}

async function loadFileContentMap(
  repositoryId: string,
  filePaths: string[],
): Promise<Map<string, string>> {
  if (filePaths.length === 0) return new Map();

  const result = await pool.query<FileContentRow>(
    `SELECT file_path, content
     FROM file_contents
     WHERE repository_id = $1
       AND file_path = ANY($2::text[])`,
    [repositoryId, filePaths],
  );

  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.file_path, row.content);
  }
  return map;
}

// ─── Main Function ──────────────────────────────────────────

export async function generateEmbeddings(
  repoId: string,
  projectId: string,
  graphName: string,
  onProgress?: ProgressCallback,
): Promise<EmbeddingResult> {
  if (!config.EMBEDDING_ENABLED) {
    logger.info("Embeddings disabled (EMBEDDING_ENABLED=false), skipping");
    return { symbolsEmbedded: 0, staleDeleted: 0 };
  }

  onProgress?.(0, "Collecting symbols for embedding");

  // 1. Load project embedding config and collect symbols from graph
  const embeddingConfig = await getOrCreateProjectEmbeddingConfig(projectId);
  const [definedSymbols, routeSymbols, fileSymbols] = await Promise.all([
    collectDefinedSymbols(graphName),
    collectRouteHandlerSymbols(graphName),
    collectFileSymbols(graphName),
  ]);
  const symbolsByAgeId = new Map<number, SymbolForEmbedding>();
  for (const sym of [...definedSymbols, ...routeSymbols, ...fileSymbols]) {
    symbolsByAgeId.set(sym.ageId, sym);
  }
  const symbols = [...symbolsByAgeId.values()];
  logger.info(
    {
      count: symbols.length,
      definedSymbols: definedSymbols.length,
      routeSymbols: routeSymbols.length,
      fileSymbols: fileSymbols.length,
      projectId,
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
    },
    "Collected symbols for embedding",
  );

  if (symbols.length === 0) {
    const staleDeleted = await deleteStaleSymbolEmbeddings(
      projectId,
      repoId,
      embeddingConfig.dimensions,
      embeddingConfig.model,
      [],
    );
    onProgress?.(100, "No symbols to embed");
    return { symbolsEmbedded: 0, staleDeleted };
  }

  // 2. Build text representations
  const filePaths = [...new Set(symbols.map((s) => s.filePath))];
  const contentByPath = await loadFileContentMap(repoId, filePaths);
  const texts = symbols.map((sym) =>
    buildTextRepresentation(sym, contentByPath.get(sym.filePath)),
  );
  const batchSize = config.EMBEDDING_BATCH_SIZE;

  // 3. Batch embed and upsert
  let embedded = 0;
  const totalBatches = Math.ceil(texts.length / batchSize);

  for (let i = 0; i < texts.length; i += batchSize) {
    const batchTexts = texts.slice(i, i + batchSize);
    const batchSymbols = symbols.slice(i, i + batchSize);
    const batchIdx = Math.floor(i / batchSize) + 1;

    // Compute progress: 10-90% range for embedding
    const pct = 10 + Math.round((batchIdx / totalBatches) * 80);
    onProgress?.(pct, `Embedding batch ${batchIdx}/${totalBatches}`);

    // Generate embeddings via project-configured provider.
    const embedResult = await embedManyForProject(projectId, batchTexts);

    // Upsert into database
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (let j = 0; j < batchSymbols.length; j++) {
        const sym = batchSymbols[j];
        const textContent = batchTexts[j];

        await upsertSymbolEmbedding(
          {
            projectId,
            repositoryId: repoId,
            nodeAgeId: sym.ageId,
            symbolName: sym.name,
            filePath: sym.filePath,
            label: sym.label,
            textContent,
            provider: embedResult.provider,
            model: embedResult.model,
            embedding: embedResult.embeddings[j],
            dimensions: embedResult.dimensions,
          },
          client,
        );
      }

      await client.query("COMMIT");
      embedded += batchSymbols.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // 4. Delete stale entries (symbols no longer in graph)
  onProgress?.(92, "Cleaning up stale embeddings");
  const currentAgeIds = symbols.map((s) => s.ageId);
  const staleDeleted = await deleteStaleSymbolEmbeddings(
    projectId,
    repoId,
    embeddingConfig.dimensions,
    embeddingConfig.model,
    currentAgeIds,
  );

  // 5. Update repository metadata
  onProgress?.(95, "Updating repository metadata");
  await pool.query(
    `UPDATE repositories
     SET embeddings_generated_at = NOW(), embedding_count = $1
     WHERE id = $2`,
    [embedded, repoId],
  );

  onProgress?.(100, "Embeddings complete");
  logger.info(
    { repoId, embedded, staleDeleted },
    "Embedding generation complete",
  );

  return { symbolsEmbedded: embedded, staleDeleted };
}

// ─── Query Embedding ────────────────────────────────────────

export async function embedQuery(
  projectId: string,
  text: string,
): Promise<number[]> {
  const result = await embedQueryForProject(projectId, text);
  return result.embedding;
}
