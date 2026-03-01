import { simpleGit } from "simple-git";
import AdmZip from "adm-zip";
import ignore from "ignore";
import picomatch from "picomatch";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";
import { createChildLogger } from "../logger.js";
import { getHeadCommit } from "./incremental.js";

const logger = createChildLogger("extract");

// ---- Types ----

export interface ExtractOptions {
  /** Include globs from project settings */
  includeGlobs?: string[];
  /** Exclude globs from project settings */
  excludeGlobs?: string[];
  /** Max file size in bytes (defaults to config.MAX_FILE_SIZE) */
  maxFileSize?: number;
  /** Branch to checkout for git sources */
  branch?: string;
}

export interface ExtractedFile {
  /** Absolute path to the file on disk */
  absolutePath: string;
  /** Relative path from the repository root */
  relativePath: string;
  /** File size in bytes */
  sizeBytes: number;
}

export interface ExtractResult {
  /** Root directory of the extracted source */
  rootDir: string;
  /** List of files passing all filters */
  files: ExtractedFile[];
  /** Whether rootDir is a temp directory that should be cleaned up */
  isTempDir: boolean;
  /** Total files discovered before filtering */
  totalDiscovered: number;
  /** Files excluded by filters */
  totalExcluded: number;
  /** HEAD commit SHA (only for git sources) */
  headCommit: string | null;
  /** Whether this is a shallow clone (affects git diff strategy) */
  isShallowClone: boolean;
}

export type ProgressCallback = (percent: number, message: string) => void;

// ---- Temp directory helpers ----

function getTempBase(): string {
  return config.INGESTION_TEMP_DIR || os.tmpdir();
}

export async function createTempDir(prefix: string): Promise<string> {
  const base = getTempBase();
  await fsp.mkdir(base, { recursive: true });
  return fsp.mkdtemp(path.join(base, `nexgraph-${prefix}-`));
}

export async function cleanupTempDir(dirPath: string): Promise<void> {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ dirPath, err }, "Failed to clean up temp directory");
  }
}

// ---- Source extractors ----

/**
 * Clone a git repository and checkout the specified branch.
 */
async function extractGitSource(
  url: string,
  branch: string,
  onProgress?: ProgressCallback,
): Promise<{ rootDir: string; isTempDir: boolean }> {
  const destDir = await createTempDir("git");

  onProgress?.(1, `Cloning ${url}`);
  logger.info({ url, branch, destDir }, "Cloning git repository");

  const git = simpleGit();
  await git.clone(url, destDir, [
    "--branch",
    branch,
    "--single-branch",
  ]);

  onProgress?.(8, `Cloned ${url}, checking out ${branch}`);

  return { rootDir: destDir, isTempDir: true };
}

/**
 * Extract a ZIP file to a temporary directory.
 */
async function extractZipSource(
  zipPath: string,
  onProgress?: ProgressCallback,
): Promise<{ rootDir: string; isTempDir: boolean }> {
  onProgress?.(1, `Extracting ZIP ${zipPath}`);
  logger.info({ zipPath }, "Extracting ZIP upload");

  // Validate ZIP file exists
  await fsp.access(zipPath, fs.constants.R_OK);

  const destDir = await createTempDir("zip");
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);

  // If the ZIP contains a single top-level directory, use that as the root
  const entries = await fsp.readdir(destDir);
  if (entries.length === 1) {
    const singleEntry = path.join(destDir, entries[0]);
    const stat = await fsp.stat(singleEntry);
    if (stat.isDirectory()) {
      onProgress?.(8, "ZIP extracted (single root detected)");
      return { rootDir: singleEntry, isTempDir: true };
    }
  }

  onProgress?.(8, "ZIP extracted");
  return { rootDir: destDir, isTempDir: true };
}

/**
 * Validate a local path is accessible and readable.
 */
async function extractLocalSource(
  localPath: string,
  onProgress?: ProgressCallback,
): Promise<{ rootDir: string; isTempDir: boolean }> {
  onProgress?.(1, `Validating local path ${localPath}`);
  logger.info({ localPath }, "Validating local path source");

  const resolved = path.resolve(localPath);

  // Verify it exists and is a directory
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Local path is not a directory: ${resolved}`);
  }

  // Verify read access
  await fsp.access(resolved, fs.constants.R_OK);

  onProgress?.(8, "Local path validated");
  return { rootDir: resolved, isTempDir: false };
}

// ---- File filtering ----

/**
 * Load .gitignore rules from a directory.
 * Returns an ignore instance with all .gitignore rules loaded.
 */
async function loadGitignoreRules(
  rootDir: string,
): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();

  // Always ignore .git directory
  ig.add(".git");

  const gitignorePath = path.join(rootDir, ".gitignore");
  try {
    const content = await fsp.readFile(gitignorePath, "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore — that's fine
  }

  return ig;
}

/**
 * Recursively walk a directory and collect all files, applying filters.
 */
async function collectFiles(
  rootDir: string,
  options: ExtractOptions,
): Promise<{ files: ExtractedFile[]; totalDiscovered: number; totalExcluded: number }> {
  const maxFileSize = options.maxFileSize ?? config.MAX_FILE_SIZE;
  const ig = await loadGitignoreRules(rootDir);

  // Build include/exclude matchers from project settings
  const includeMatch =
    options.includeGlobs && options.includeGlobs.length > 0
      ? picomatch(options.includeGlobs)
      : null;
  const excludeMatch =
    options.excludeGlobs && options.excludeGlobs.length > 0
      ? picomatch(options.excludeGlobs)
      : null;

  const files: ExtractedFile[] = [];
  let totalDiscovered = 0;
  let totalExcluded = 0;

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // Skip unreadable directories
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      // Apply .gitignore rules
      if (ig.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        totalDiscovered++;

        // Apply include globs
        if (includeMatch && !includeMatch(relativePath)) {
          totalExcluded++;
          continue;
        }

        // Apply exclude globs
        if (excludeMatch && excludeMatch(relativePath)) {
          totalExcluded++;
          continue;
        }

        // Apply max file size
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(fullPath);
        } catch {
          totalExcluded++;
          continue;
        }

        if (stat.size > maxFileSize) {
          totalExcluded++;
          continue;
        }

        files.push({
          absolutePath: fullPath,
          relativePath,
          sizeBytes: stat.size,
        });
      }
    }
  }

  await walk(rootDir);

  return { files, totalDiscovered, totalExcluded };
}

// ---- Main extract function ----

/**
 * Extract Phase 1 (0–15%): Acquire source code and build filtered file list.
 *
 * Handles three source types:
 * - git_url: Clone with simple-git, shallow single-branch
 * - zip_upload: Extract AdmZip to temp directory
 * - local_path: Validate accessibility
 *
 * Then applies filtering:
 * - .gitignore rules
 * - include/exclude globs from project settings
 * - max file size limit
 */
export async function extractSource(
  sourceType: "git_url" | "zip_upload" | "local_path",
  sourceUrl: string,
  options: ExtractOptions = {},
  onProgress?: ProgressCallback,
): Promise<ExtractResult> {
  onProgress?.(0, "Starting extraction");

  // Step 1: Acquire source (0–8%)
  let rootDir: string;
  let isTempDir: boolean;

  switch (sourceType) {
    case "git_url": {
      const branch = options.branch ?? "main";
      const result = await extractGitSource(sourceUrl, branch, onProgress);
      rootDir = result.rootDir;
      isTempDir = result.isTempDir;
      break;
    }
    case "zip_upload": {
      const result = await extractZipSource(sourceUrl, onProgress);
      rootDir = result.rootDir;
      isTempDir = result.isTempDir;
      break;
    }
    case "local_path": {
      const result = await extractLocalSource(sourceUrl, onProgress);
      rootDir = result.rootDir;
      isTempDir = result.isTempDir;
      break;
    }
  }

  // Step 2: Collect and filter files (8–15%)
  onProgress?.(9, "Scanning files and applying filters");

  const { files, totalDiscovered, totalExcluded } = await collectFiles(
    rootDir,
    options,
  );

  // Step 3: Detect HEAD commit for git repositories
  const headCommit = await getHeadCommit(rootDir);
  const isShallowClone = false;

  logger.info(
    {
      sourceType,
      rootDir,
      totalDiscovered,
      totalExcluded,
      filesKept: files.length,
      headCommit,
    },
    "Extraction complete",
  );

  onProgress?.(15, `Extraction complete: ${files.length} files`);

  return {
    rootDir,
    files,
    isTempDir,
    totalDiscovered,
    totalExcluded,
    headCommit,
    isShallowClone,
  };
}
