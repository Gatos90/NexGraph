import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/connection.js";
import { cypherWithClient } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import type { ExtractResult, ProgressCallback } from "./extract.js";

const logger = createChildLogger("structure");

// ─── Language Detection ─────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  // Primary supported languages (tree-sitter parseable)
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".rb": "ruby",
  ".erb": "ruby",
  // Config and data formats
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".ini": "ini",
  ".cfg": "ini",
  ".env": "dotenv",
  // Web
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",
  // Docs and text
  ".md": "markdown",
  ".mdx": "markdown",
  ".txt": "text",
  ".rst": "restructuredtext",
  // Shell
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  // SQL
  ".sql": "sql",
  // Build and config
  ".dockerfile": "dockerfile",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".gradle": "gradle",
  ".cmake": "cmake",
  ".makefile": "makefile",
};

const FILENAME_MAP: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Jenkinsfile: "groovy",
  Vagrantfile: "ruby",
  Gemfile: "ruby",
  Rakefile: "ruby",
};

export function detectLanguage(filePath: string): string {
  const basename = path.basename(filePath);
  if (FILENAME_MAP[basename]) return FILENAME_MAP[basename];
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? "unknown";
}

// ─── File Metadata ──────────────────────────────────────────

interface FileMetadata {
  contentHash: string;
  lineCount: number;
}

async function computeFileMetadata(filePath: string): Promise<FileMetadata> {
  const buffer = await fsp.readFile(filePath);

  const contentHash = crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

  let lineCount = 0;
  if (buffer.length > 0) {
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x0a) lineCount++;
    }
    // If file doesn't end with a newline, count the last line
    if (buffer[buffer.length - 1] !== 0x0a) lineCount++;
  }

  return { contentHash, lineCount };
}

// ─── Structure Analysis ─────────────────────────────────────

export interface StructureResult {
  folderCount: number;
  fileCount: number;
  edgeCount: number;
}

/**
 * Ingestion Phase 2 (15–30%): Analyze directory structure and create graph nodes.
 *
 * Creates Folder and File nodes in the AGE graph with CONTAINS edges
 * representing the directory hierarchy. All operations run within a
 * single transaction for atomicity.
 */
export async function analyzeStructure(
  graphName: string,
  extractResult: ExtractResult,
  onProgress?: ProgressCallback,
): Promise<StructureResult> {
  const { rootDir, files } = extractResult;

  onProgress?.(15, "Starting structure analysis");

  // Step 1: Collect unique folder paths from the file list
  const folderPaths = new Set<string>();
  folderPaths.add(""); // root folder

  for (const file of files) {
    let dir = path.dirname(file.relativePath);
    while (dir && dir !== ".") {
      folderPaths.add(dir);
      dir = path.dirname(dir);
    }
  }

  const sortedFolders = Array.from(folderPaths).sort();

  logger.info(
    { graphName, folderCount: sortedFolders.length, fileCount: files.length },
    "Starting structure analysis",
  );

  const client = await pool.connect();
  let folderCount = 0;
  let fileCount = 0;
  let edgeCount = 0;

  try {
    await client.query("BEGIN");

    // Step 2: Create Folder nodes (15–20%)
    const folderIdMap = new Map<string, number>();

    for (let i = 0; i < sortedFolders.length; i++) {
      const folderPath = sortedFolders[i];
      const name =
        folderPath === "" ? path.basename(rootDir) : path.basename(folderPath);
      const depth =
        folderPath === "" ? 0 : folderPath.split("/").length;

      const rows = await cypherWithClient<{ v: AgeVertex }>(
        client,
        graphName,
        `CREATE (v:Folder {path: $path, name: $name, depth: $depth}) RETURN v`,
        { path: folderPath, name, depth },
        [{ name: "v" }],
      );

      folderIdMap.set(folderPath, rows[0].v.id);
      folderCount++;

      if (i % 50 === 0 || i === sortedFolders.length - 1) {
        const progress = 15 + ((i + 1) / sortedFolders.length) * 5;
        onProgress?.(
          Math.round(progress),
          `Creating folder nodes: ${i + 1}/${sortedFolders.length}`,
        );
      }
    }

    // Step 3: Create Folder CONTAINS Folder edges (20–22%)
    for (const folderPath of sortedFolders) {
      if (folderPath === "") continue;

      const parentDir = path.dirname(folderPath);
      const parentPath = parentDir === "." ? "" : parentDir;
      const parentId = folderIdMap.get(parentPath);
      const childId = folderIdMap.get(folderPath);

      if (parentId !== undefined && childId !== undefined) {
        await cypherWithClient(
          client,
          graphName,
          `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:CONTAINS]->(b) RETURN e`,
          { start_id: parentId, end_id: childId },
          [{ name: "e" }],
        );
        edgeCount++;
      }
    }

    onProgress?.(22, `Folder structure created: ${folderCount} folders, ${edgeCount} edges`);

    // Step 4: Create File nodes + CONTAINS edges from parent folder (22–30%)
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const language = detectLanguage(file.relativePath);
      const { contentHash, lineCount } = await computeFileMetadata(
        file.absolutePath,
      );

      const rows = await cypherWithClient<{ v: AgeVertex }>(
        client,
        graphName,
        `CREATE (v:File {path: $path, name: $name, language: $language, size: $size, content_hash: $content_hash, line_count: $line_count}) RETURN v`,
        {
          path: file.relativePath,
          name: path.basename(file.relativePath),
          language,
          size: file.sizeBytes,
          content_hash: contentHash,
          line_count: lineCount,
        },
        [{ name: "v" }],
      );

      // Create CONTAINS edge from parent folder to this file
      const parentDir = path.dirname(file.relativePath);
      const parentPath = parentDir === "." ? "" : parentDir;
      const parentId = folderIdMap.get(parentPath);
      const fileId = rows[0].v.id;

      if (parentId !== undefined) {
        await cypherWithClient(
          client,
          graphName,
          `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:CONTAINS]->(b) RETURN e`,
          { start_id: parentId, end_id: fileId },
          [{ name: "e" }],
        );
        edgeCount++;
      }

      fileCount++;

      if (i % 50 === 0 || i === files.length - 1) {
        const progress = 22 + ((i + 1) / files.length) * 8;
        onProgress?.(
          Math.round(progress),
          `Analyzing files: ${i + 1}/${files.length}`,
        );
      }
    }

    await client.query("COMMIT");

    onProgress?.(
      30,
      `Structure analysis complete: ${folderCount} folders, ${fileCount} files, ${edgeCount} edges`,
    );

    logger.info(
      { graphName, folderCount, fileCount, edgeCount },
      "Structure analysis complete",
    );

    return { folderCount, fileCount, edgeCount };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ graphName, err }, "Structure analysis failed, rolled back");
    throw err;
  } finally {
    client.release();
  }
}
