import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { pool } from "../db/connection.js";
import { createChildLogger } from "../logger.js";
import { detectLanguage } from "./structure.js";
import type { ExtractResult, ProgressCallback } from "./extract.js";

const logger = createChildLogger("content-store");

/**
 * Store file contents in the file_contents table for search/grep.
 *
 * Reads each file from disk and upserts into the relational table.
 * Binary files (detected by null bytes) are skipped.
 * The search_vector tsvector is computed on insert for BM25 search.
 */
export async function storeFileContents(
  repositoryId: string,
  extractResult: ExtractResult,
  onProgress?: ProgressCallback,
): Promise<number> {
  const { files } = extractResult;
  let stored = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const content = await fsp.readFile(file.absolutePath, "utf-8");

      // Skip binary files (contain null bytes after UTF-8 decode)
      if (content.includes("\0")) {
        continue;
      }

      const contentHash = crypto.createHash("sha256").update(content).digest("hex");
      const language = detectLanguage(file.relativePath);

      await pool.query(
        `INSERT INTO file_contents (repository_id, file_path, content, search_vector)
         VALUES ($1, $2, $3, to_tsvector('simple', $3))
         ON CONFLICT (repository_id, file_path)
         DO UPDATE SET content = EXCLUDED.content,
                       search_vector = to_tsvector('simple', EXCLUDED.content)`,
        [repositoryId, file.relativePath, content],
      );

      await pool.query(
        `INSERT INTO indexed_files (repository_id, file_path, language, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (repository_id, file_path)
         DO UPDATE SET language = EXCLUDED.language,
                       content_hash = EXCLUDED.content_hash,
                       indexed_at = NOW()`,
        [repositoryId, file.relativePath, language, contentHash],
      );
      stored++;
    } catch (err) {
      logger.debug(
        { file: file.relativePath, err },
        "Skipping file for content storage",
      );
    }

    if (i % 100 === 0 || i === files.length - 1) {
      onProgress?.(
        Math.round((i / files.length) * 100),
        `Storing file contents: ${i + 1}/${files.length}`,
      );
    }
  }

  logger.info(
    { repositoryId, stored, total: files.length },
    "File content storage complete",
  );

  return stored;
}

/**
 * Delete file contents for specific paths (used during incremental indexing).
 */
export async function deleteFileContents(
  repositoryId: string,
  filePaths: string[],
): Promise<void> {
  if (filePaths.length === 0) return;

  await pool.query(
    `DELETE FROM file_contents
     WHERE repository_id = $1
       AND file_path = ANY($2)`,
    [repositoryId, filePaths],
  );

  await pool.query(
    `DELETE FROM indexed_files
     WHERE repository_id = $1
       AND file_path = ANY($2)`,
    [repositoryId, filePaths],
  );

  logger.debug(
    { repositoryId, count: filePaths.length },
    "Deleted file contents for removed files",
  );
}
