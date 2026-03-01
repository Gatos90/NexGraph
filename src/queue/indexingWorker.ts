import type { Job } from "pg-boss";
import { pool } from "../db/index.js";
import { createChildLogger } from "../logger.js";
import { getBoss, INDEXING_QUEUE } from "./boss.js";
import { extractSource, cleanupTempDir } from "../ingestion/extract.js";
import type { ExtractResult, ExtractedFile, ProgressCallback } from "../ingestion/extract.js";
import { analyzeStructure } from "../ingestion/structure.js";
import { parseSymbols } from "../ingestion/parse.js";
import { resolveImports } from "../ingestion/imports.js";
import { buildCallGraph } from "../ingestion/callgraph.js";
import { detectCommunities } from "../ingestion/community.js";
import { detectProcesses } from "../ingestion/process-detection.js";
import { generateEmbeddings } from "../ingestion/embeddings.js";
import {
  getChangedFiles,
  cleanupFilesFromGraph,
  deleteImportsEdgesFrom,
  deleteCallGraphEdgesFrom,
} from "../ingestion/incremental.js";
import type { ChangedFile } from "../ingestion/incremental.js";
import { storeFileContents, deleteFileContents } from "../ingestion/content-store.js";
import { resolveUrlPathMatching } from "../ingestion/urlmatch.js";
import { resolveTypeMatching } from "../ingestion/typematch.js";
import { resolvePackageDependencies } from "../ingestion/pkgmatch.js";
import { extractGitHistory } from "../ingestion/git-history.js";
import { dropGraph, createGraph } from "../db/graph.js";

const logger = createChildLogger("indexing-worker");

// ─── Types ──────────────────────────────────────────────────

export interface IndexingJobData {
  jobId: string; // our indexing_jobs.id (not the pg-boss id)
  repositoryId: string;
  projectId: string;
  sourceType: "git_url" | "zip_upload" | "local_path";
  sourceUrl: string;
  graphName: string;
  mode: "full" | "incremental";
  defaultBranch: string;
  /** Phase to resume from (for recoverability) */
  resumeFromPhase?: string;
  /** Project settings (include/exclude globs) */
  settings?: { include_globs?: string[]; exclude_globs?: string[] };
  /** Last indexed commit SHA (for incremental mode) */
  lastIndexedCommit?: string;
}

const PHASES = ["extract", "structure", "parse", "imports", "callgraph", "community", "process", "embeddings"] as const;
type Phase = (typeof PHASES)[number];

// ─── Progress Updater ───────────────────────────────────────

async function updateJobProgress(
  jobId: string,
  phase: Phase,
  progress: number,
): Promise<void> {
  await pool.query(
    `UPDATE indexing_jobs
     SET phase = $1, progress = $2, updated_at = NOW()
     WHERE id = $3`,
    [phase, progress, jobId],
  );
}

async function updateJobStatus(
  jobId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sets = ["status = $1"];
  const values: unknown[] = [status];
  let idx = 2;

  if (extra.error_message !== undefined) {
    sets.push(`error_message = $${idx++}`);
    values.push(extra.error_message);
  }
  if (extra.phase !== undefined) {
    sets.push(`phase = $${idx++}`);
    values.push(extra.phase);
  }
  if (extra.progress !== undefined) {
    sets.push(`progress = $${idx++}`);
    values.push(extra.progress);
  }
  if (extra.last_completed_phase !== undefined) {
    sets.push(`last_completed_phase = $${idx++}`);
    values.push(extra.last_completed_phase);
  }
  if (status === "running") {
    sets.push(`started_at = COALESCE(started_at, NOW())`);
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    sets.push(`completed_at = NOW()`);
  }

  values.push(jobId);
  await pool.query(
    `UPDATE indexing_jobs SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${idx}`,
    values,
  );
}

async function updateJobFileCounts(
  jobId: string,
  total: number,
  done: number,
): Promise<void> {
  await pool.query(
    `UPDATE indexing_jobs SET files_total = $1, files_done = $2 WHERE id = $3`,
    [total, done, jobId],
  );
}

// ─── Phase Runner ───────────────────────────────────────────

function shouldRunPhase(
  phase: Phase,
  resumeFromPhase: string | undefined,
): boolean {
  if (!resumeFromPhase) return true;
  const resumeIdx = PHASES.indexOf(resumeFromPhase as Phase);
  const phaseIdx = PHASES.indexOf(phase);
  return phaseIdx >= resumeIdx;
}

// ─── Cancellation Check ─────────────────────────────────────

async function isJobCancelled(jobId: string): Promise<boolean> {
  const result = await pool.query<{ status: string }>(
    "SELECT status FROM indexing_jobs WHERE id = $1",
    [jobId],
  );
  return result.rows.length === 0 || result.rows[0].status === "cancelled";
}

// ─── Incremental Helpers ────────────────────────────────────

/**
 * Build a filtered ExtractResult containing only the specified file paths.
 * Files not found on disk (deleted) are excluded.
 */
function filterExtractResult(
  fullResult: ExtractResult,
  filePaths: Set<string>,
): ExtractResult {
  const filtered = fullResult.files.filter((f) => filePaths.has(f.relativePath));
  return {
    ...fullResult,
    files: filtered,
    totalDiscovered: filtered.length,
    totalExcluded: 0,
  };
}

interface ConnectionRuleRow {
  id: string;
  source_repo_id: string;
  target_repo_id: string;
  connection_type: string;
}

/**
 * Trigger cross-repo resolution for all connection rules involving this repository.
 * Re-resolves each connection and updates last_resolved_at timestamp.
 */
async function triggerCrossRepoResolution(
  repositoryId: string,
  projectId: string,
): Promise<void> {
  const connResult = await pool.query<ConnectionRuleRow>(
    `SELECT id, source_repo_id, target_repo_id, connection_type
     FROM repo_connections
     WHERE (source_repo_id = $1 OR target_repo_id = $1)
       AND project_id = $2`,
    [repositoryId, projectId],
  );

  if (connResult.rows.length === 0) return;

  logger.info(
    { repositoryId, connectionCount: connResult.rows.length },
    "Auto-resolving cross-repo connections after indexing",
  );

  for (const conn of connResult.rows) {
    try {
      let edgesCreated = 0;

      if (conn.connection_type === "CROSS_REPO_MIRRORS") {
        const result = await resolveTypeMatching(
          conn.id,
          conn.source_repo_id,
          conn.target_repo_id,
          projectId,
        );
        edgesCreated = result.edgesCreated;
      } else if (conn.connection_type === "CROSS_REPO_CALLS") {
        const result = await resolveUrlPathMatching(
          conn.id,
          conn.source_repo_id,
          conn.target_repo_id,
          projectId,
        );
        edgesCreated = result.edgesCreated;
      } else if (conn.connection_type === "CROSS_REPO_DEPENDS") {
        const result = await resolvePackageDependencies(
          conn.id,
          conn.source_repo_id,
          conn.target_repo_id,
          projectId,
        );
        edgesCreated = result.edgesCreated;
      } else {
        logger.warn(
          { connId: conn.id, connectionType: conn.connection_type },
          "No resolution strategy for connection type, skipping",
        );
        continue;
      }

      // Update last_resolved_at timestamp
      await pool.query(
        "UPDATE repo_connections SET last_resolved_at = NOW() WHERE id = $1",
        [conn.id],
      );

      logger.info(
        { connId: conn.id, connectionType: conn.connection_type, edgesCreated },
        "Cross-repo connection auto-resolved",
      );
    } catch (err) {
      logger.warn(
        { connId: conn.id, connectionType: conn.connection_type, err },
        "Failed to auto-resolve cross-repo connection",
      );
    }
  }
}

// ─── Main Worker Handler ────────────────────────────────────

async function handleIndexingJob(jobs: Job<IndexingJobData>[]): Promise<void> {
  // pg-boss 12.x delivers jobs as an array; we process one at a time
  const job = jobs[0];
  const data = job.data;
  const { jobId, repositoryId, graphName, mode } = data;

  logger.info({ jobId, repositoryId, graphName, mode }, "Starting indexing job");

  // Store pg-boss job ID for cancellation lookup
  await pool.query(
    "UPDATE indexing_jobs SET boss_job_id = $1 WHERE id = $2",
    [job.id, jobId],
  );

  // Mark as running
  await updateJobStatus(jobId, "running");

  let extractResult: ExtractResult | null = null;

  try {
    // ── Phase 1: Extract ──────────────────────────────────
    if (shouldRunPhase("extract", data.resumeFromPhase)) {
      if (await isJobCancelled(jobId)) return;

      const onProgress: ProgressCallback = (pct, msg) => {
        updateJobProgress(jobId, "extract", pct).catch(() => {});
        logger.debug({ jobId, phase: "extract", pct, msg }, "Progress");
      };

      extractResult = await extractSource(
        data.sourceType,
        data.sourceUrl,
        {
          includeGlobs: data.settings?.include_globs,
          excludeGlobs: data.settings?.exclude_globs,
          branch: data.defaultBranch,
        },
        onProgress,
      );

      await updateJobFileCounts(jobId, extractResult.files.length, 0);
      await updateJobStatus(jobId, "running", { last_completed_phase: "extract" });
      logger.info(
        { jobId, files: extractResult.files.length, headCommit: extractResult.headCommit },
        "Phase 1 (extract) complete",
      );
    }

    // If resuming past extract, we still need the file list
    if (!extractResult) {
      const onProgress: ProgressCallback = (pct, msg) => {
        updateJobProgress(jobId, "extract", pct).catch(() => {});
        logger.debug({ jobId, phase: "extract", pct, msg }, "Progress (re-extract)");
      };

      extractResult = await extractSource(
        data.sourceType,
        data.sourceUrl,
        {
          includeGlobs: data.settings?.include_globs,
          excludeGlobs: data.settings?.exclude_globs,
          branch: data.defaultBranch,
        },
        onProgress,
      );
      await updateJobFileCounts(jobId, extractResult.files.length, 0);
    }

    // ── Incremental: Detect changed files ─────────────────
    let changedFiles: ChangedFile[] | null = null;
    let isIncremental = false;

    if (
      mode === "incremental" &&
      data.lastIndexedCommit &&
      extractResult.headCommit &&
      data.lastIndexedCommit !== extractResult.headCommit
    ) {
      if (await isJobCancelled(jobId)) return;

      updateJobProgress(jobId, "structure", 15).catch(() => {});
      logger.info(
        {
          jobId,
          oldSha: data.lastIndexedCommit,
          newSha: extractResult.headCommit,
        },
        "Detecting changed files for incremental indexing",
      );

      changedFiles = await getChangedFiles(
        extractResult.rootDir,
        data.lastIndexedCommit,
        extractResult.headCommit,
        extractResult.isShallowClone,
      );

      if (changedFiles.length > 0) {
        isIncremental = true;

        // Store changed files count
        await pool.query(
          "UPDATE indexing_jobs SET changed_files_count = $1 WHERE id = $2",
          [changedFiles.length, jobId],
        );

        logger.info(
          {
            jobId,
            changedFiles: changedFiles.length,
            added: changedFiles.filter((f) => f.status === "A").length,
            modified: changedFiles.filter((f) => f.status === "M").length,
            deleted: changedFiles.filter((f) => f.status === "D").length,
          },
          "Changed files detected for incremental indexing",
        );
      } else {
        // No changes detected — either git diff failed (fallback to full) or no real changes
        logger.info(
          { jobId },
          "No changed files detected; falling back to full reindex",
        );
      }
    }

    if (isIncremental && changedFiles) {
      // ── INCREMENTAL PATH ────────────────────────────────
      await handleIncrementalIndexing(
        jobId,
        data,
        extractResult,
        changedFiles,
      );
    } else {
      // ── FULL REINDEX PATH ───────────────────────────────
      await handleFullIndexing(jobId, data, extractResult);
    }

    // ── All phases done ───────────────────────────────────
    await updateJobStatus(jobId, "completed", { progress: 100, phase: "done" });

    // Update repository metadata
    const updateSets = ["last_indexed_at = NOW()"];
    const updateValues: unknown[] = [];
    let paramIdx = 1;

    if (extractResult.headCommit) {
      updateSets.push(`last_indexed_commit = $${paramIdx++}`);
      updateValues.push(extractResult.headCommit);
    }

    updateValues.push(repositoryId);
    await pool.query(
      `UPDATE repositories SET ${updateSets.join(", ")} WHERE id = $${paramIdx}`,
      updateValues,
    );

    // Trigger cross-repo resolution for all connection rules involving this repo
    await triggerCrossRepoResolution(repositoryId, data.projectId).catch((err) => {
      logger.warn({ jobId, err }, "Cross-repo resolution trigger failed");
    });

    logger.info({ jobId, repositoryId, mode: isIncremental ? "incremental" : "full" }, "Indexing job completed successfully");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "Indexing job failed");
    await updateJobStatus(jobId, "failed", { error_message: errorMessage });
    throw err; // Let pg-boss know the job failed
  } finally {
    // Clean up temp directory if one was created
    if (extractResult?.isTempDir) {
      await cleanupTempDir(extractResult.rootDir);
    }
  }
}

// ─── Full Reindex ────────────────────────────────────────────

async function handleFullIndexing(
  jobId: string,
  data: IndexingJobData,
  extractResult: ExtractResult,
): Promise<void> {
  const { graphName } = data;

  // ── Clear existing graph for a clean full re-index ───
  logger.info({ jobId, graphName }, "Dropping existing graph for full re-index");
  try {
    await dropGraph(graphName);
  } catch {
    // Graph may not exist yet on first run — that's fine
  }
  await createGraph(graphName);
  logger.info({ jobId, graphName }, "Graph recreated, starting phases");

  // ── Phase 2: Structure ────────────────────────────────
  if (shouldRunPhase("structure", data.resumeFromPhase)) {
    if (await isJobCancelled(jobId)) return;

    const onProgress: ProgressCallback = (pct, msg) => {
      updateJobProgress(jobId, "structure", pct).catch(() => {});
      logger.debug({ jobId, phase: "structure", pct, msg }, "Progress");
    };

    const structureResult = await analyzeStructure(graphName, extractResult, onProgress);

    // Store file contents for search/grep
    const storedCount = await storeFileContents(data.repositoryId, extractResult);
    logger.info({ jobId, storedFiles: storedCount }, "File contents stored for search");

    // Extract git history for visualization overlays (non-blocking)
    try {
      const filePaths = extractResult.files.map((f: ExtractedFile) => f.relativePath);
      const gitResult = await extractGitHistory(data.repositoryId, extractResult.rootDir, filePaths);
      logger.info({ jobId, files: gitResult.filesProcessed, commits: gitResult.commitsStored }, "Git history extracted");
    } catch (err) {
      logger.warn({ jobId, err }, "Git history extraction failed (non-fatal)");
    }

    await updateJobStatus(jobId, "running", { last_completed_phase: "structure" });
    logger.info(
      { jobId, folders: structureResult.folderCount, files: structureResult.fileCount },
      "Phase 2 (structure) complete",
    );
  }

  // ── Phase 3: Parse ────────────────────────────────────
  if (shouldRunPhase("parse", data.resumeFromPhase)) {
    if (await isJobCancelled(jobId)) return;

    const onProgress: ProgressCallback = (pct, msg) => {
      updateJobProgress(jobId, "parse", pct).catch(() => {});
      logger.debug({ jobId, phase: "parse", pct, msg }, "Progress");
    };

    const parseResult = await parseSymbols(graphName, extractResult, onProgress);
    await updateJobFileCounts(jobId, extractResult.files.length, parseResult.filesParsed);
    await updateJobStatus(jobId, "running", { last_completed_phase: "parse" });
    logger.info(
      { jobId, symbols: parseResult.symbolCount, parsed: parseResult.filesParsed },
      "Phase 3 (parse) complete",
    );
  }

  // ── Phase 4: Imports ──────────────────────────────────
  if (shouldRunPhase("imports", data.resumeFromPhase)) {
    if (await isJobCancelled(jobId)) return;

    const onProgress: ProgressCallback = (pct, msg) => {
      updateJobProgress(jobId, "imports", pct).catch(() => {});
      logger.debug({ jobId, phase: "imports", pct, msg }, "Progress");
    };

    const importResult = await resolveImports(graphName, extractResult, onProgress);
    await updateJobStatus(jobId, "running", { last_completed_phase: "imports" });
    logger.info(
      { jobId, edges: importResult.importsEdgeCount },
      "Phase 4 (imports) complete",
    );
  }

  // ── Phase 5: Call Graph ───────────────────────────────
  if (shouldRunPhase("callgraph", data.resumeFromPhase)) {
    if (await isJobCancelled(jobId)) return;

    const onProgress: ProgressCallback = (pct, msg) => {
      updateJobProgress(jobId, "callgraph", pct).catch(() => {});
      logger.debug({ jobId, phase: "callgraph", pct, msg }, "Progress");
    };

    const callGraphResult = await buildCallGraph(graphName, extractResult, onProgress);
    await updateJobStatus(jobId, "running", { last_completed_phase: "callgraph" });
    logger.info(
      { jobId, calls: callGraphResult.callsEdgeCount, extends: callGraphResult.extendsEdgeCount, overrides: callGraphResult.overridesEdgeCount, handles: callGraphResult.handlesEdgeCount },
      "Phase 5 (callgraph) complete",
    );
  }

  // ── Phase 6: Community Detection ─────────────────────────
  if (shouldRunPhase("community", data.resumeFromPhase)) {
    if (await isJobCancelled(jobId)) return;

    const onProgress: ProgressCallback = (pct, msg) => {
      // Map community progress (0-100) to overall job progress (85-92%)
      const mappedPct = 85 + Math.round(pct * 0.07);
      updateJobProgress(jobId, "community", mappedPct).catch(() => {});
      logger.debug({ jobId, phase: "community", pct: mappedPct, msg }, "Progress");
    };

    const communityResult = await detectCommunities(graphName, onProgress);

    // Update repository metadata
    await pool.query(
      `UPDATE repositories SET community_detected_at = NOW(), community_count = $1 WHERE id = $2`,
      [communityResult.communitiesCreated, data.repositoryId],
    );

    await updateJobStatus(jobId, "running", { last_completed_phase: "community" });
    logger.info(
      { jobId, communities: communityResult.communitiesCreated, memberEdges: communityResult.memberEdgesCreated },
      "Phase 6 (community) complete",
    );
  }

  // ── Phase 7: Process Detection ──────────────────────────────
  if (shouldRunPhase("process", data.resumeFromPhase)) {
    if (await isJobCancelled(jobId)) return;

    const onProgress: ProgressCallback = (pct, msg) => {
      // Map process progress (0-100) to overall job progress (92-97%)
      const mappedPct = 92 + Math.round(pct * 0.05);
      updateJobProgress(jobId, "process", mappedPct).catch(() => {});
      logger.debug({ jobId, phase: "process", pct: mappedPct, msg }, "Progress");
    };

    const processResult = await detectProcesses(graphName, onProgress);

    // Update repository metadata
    await pool.query(
      `UPDATE repositories SET process_count = $1 WHERE id = $2`,
      [processResult.processesCreated, data.repositoryId],
    );

    await updateJobStatus(jobId, "running", { last_completed_phase: "process" });
    logger.info(
      { jobId, processes: processResult.processesCreated, stepEdges: processResult.stepEdgesCreated, entryPoints: processResult.entryPointsScored },
      "Phase 7 (process) complete",
    );
  }

  // ── Phase 8: Embeddings ─────────────────────────────────────
  if (shouldRunPhase("embeddings", data.resumeFromPhase)) {
    if (await isJobCancelled(jobId)) return;

    const onProgress: ProgressCallback = (pct, msg) => {
      // Map embeddings progress (0-100) to overall job progress (97-100%)
      const mappedPct = 97 + Math.round(pct * 0.03);
      updateJobProgress(jobId, "embeddings", mappedPct).catch(() => {});
      logger.debug({ jobId, phase: "embeddings", pct: mappedPct, msg }, "Progress");
    };

    try {
      const embeddingResult = await generateEmbeddings(
        data.repositoryId,
        data.projectId,
        graphName,
        onProgress,
      );
      await updateJobStatus(jobId, "running", { last_completed_phase: "embeddings" });
      logger.info(
        { jobId, embedded: embeddingResult.symbolsEmbedded, staleDeleted: embeddingResult.staleDeleted },
        "Phase 8 (embeddings) complete",
      );
    } catch (err) {
      // Embeddings are optional for graph correctness; keep the index usable.
      logger.warn(
        { jobId, err },
        "Phase 8 (embeddings) failed, continuing without embeddings",
      );
    }
  }
}

// ─── Incremental Indexing ────────────────────────────────────

async function handleIncrementalIndexing(
  jobId: string,
  data: IndexingJobData,
  extractResult: ExtractResult,
  changedFiles: ChangedFile[],
): Promise<void> {
  const { graphName } = data;

  // Classify changed files
  const deletedPaths = changedFiles
    .filter((f) => f.status === "D")
    .map((f) => f.path);
  const modifiedPaths = changedFiles
    .filter((f) => f.status === "M")
    .map((f) => f.path);
  const addedPaths = changedFiles
    .filter((f) => f.status === "A")
    .map((f) => f.path);

  // Build the set of file paths that exist on disk and need processing
  const extractFileMap = new Map<string, ExtractedFile>();
  for (const f of extractResult.files) {
    extractFileMap.set(f.relativePath, f);
  }

  // ── Phase 2: Incremental Structure ─────────────────────
  if (await isJobCancelled(jobId)) return;

  const onStructureProgress: ProgressCallback = (pct, msg) => {
    updateJobProgress(jobId, "structure", pct).catch(() => {});
    logger.debug({ jobId, phase: "structure", pct, msg }, "Progress");
  };

  onStructureProgress(16, `Cleaning up graph for ${deletedPaths.length + modifiedPaths.length} removed/modified files`);

  const client = await pool.connect();
  let reverseImporters: Set<string>;

  try {
    await client.query("BEGIN");

    // Clean up deleted files (remove nodes and edges entirely)
    const deletedReverseImporters = await cleanupFilesFromGraph(
      client,
      graphName,
      deletedPaths,
      true, // delete File nodes
    );

    // Clean up modified files (remove symbols/edges but keep File node)
    const modifiedReverseImporters = await cleanupFilesFromGraph(
      client,
      graphName,
      modifiedPaths,
      false, // keep File nodes — they'll be updated
    );

    // Merge reverse importers from both sets
    reverseImporters = new Set([...deletedReverseImporters, ...modifiedReverseImporters]);
    // Remove changed files themselves from reverse importers (they're already being processed)
    const changedPathSet = new Set([...deletedPaths, ...modifiedPaths, ...addedPaths]);
    for (const p of changedPathSet) {
      reverseImporters.delete(p);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  onStructureProgress(20, "Graph cleanup complete, updating structure");

  // Create structure for added files (new File nodes + CONTAINS edges)
  // and update File node properties for modified files
  const addedAndModifiedPaths = new Set([...addedPaths, ...modifiedPaths]);
  const structureFiles = filterExtractResult(extractResult, addedAndModifiedPaths);

  if (structureFiles.files.length > 0) {
    // For modified files, we need to update their File node properties
    // For added files, analyzeStructure will create new nodes
    // We use analyzeStructure for added files and update modified files separately

    const addedFilesResult = filterExtractResult(
      extractResult,
      new Set(addedPaths),
    );

    if (addedFilesResult.files.length > 0) {
      await analyzeStructure(graphName, addedFilesResult, onStructureProgress);
    }

    // Update modified File nodes with new content_hash, size, line_count
    if (modifiedPaths.length > 0) {
      await updateModifiedFileNodes(graphName, extractResult, modifiedPaths);
    }
  }

  // Update file_contents for search/grep
  if (deletedPaths.length > 0) {
    await deleteFileContents(data.repositoryId, deletedPaths);
  }
  if (addedAndModifiedPaths.size > 0) {
    const contentFiles = filterExtractResult(extractResult, addedAndModifiedPaths);
    await storeFileContents(data.repositoryId, contentFiles);
  }

  await updateJobStatus(jobId, "running", { last_completed_phase: "structure" });
  await updateJobFileCounts(jobId, changedFiles.length, 0);

  logger.info(
    {
      jobId,
      added: addedPaths.length,
      modified: modifiedPaths.length,
      deleted: deletedPaths.length,
      reverseImporters: reverseImporters.size,
    },
    "Phase 2 (incremental structure) complete",
  );

  // ── Phase 3: Incremental Parse ─────────────────────────
  if (await isJobCancelled(jobId)) return;

  const onParseProgress: ProgressCallback = (pct, msg) => {
    updateJobProgress(jobId, "parse", pct).catch(() => {});
    logger.debug({ jobId, phase: "parse", pct, msg }, "Progress");
  };

  // Parse only added and modified files
  const parseFilesResult = filterExtractResult(extractResult, addedAndModifiedPaths);
  const parseResult = await parseSymbols(graphName, parseFilesResult, onParseProgress);
  await updateJobFileCounts(jobId, changedFiles.length, parseResult.filesParsed);
  await updateJobStatus(jobId, "running", { last_completed_phase: "parse" });

  logger.info(
    { jobId, symbols: parseResult.symbolCount, parsed: parseResult.filesParsed },
    "Phase 3 (incremental parse) complete",
  );

  // ── Phase 4: Incremental Imports ───────────────────────
  if (await isJobCancelled(jobId)) return;

  const onImportsProgress: ProgressCallback = (pct, msg) => {
    updateJobProgress(jobId, "imports", pct).catch(() => {});
    logger.debug({ jobId, phase: "imports", pct, msg }, "Progress");
  };

  // Re-resolve imports for: changed files + reverse importers
  const importAffectedPaths = new Set([
    ...addedPaths,
    ...modifiedPaths,
    ...reverseImporters,
  ]);

  // First delete existing IMPORTS edges from reverse importers
  // (changed files' edges were already deleted in cleanup)
  if (reverseImporters.size > 0) {
    const importClient = await pool.connect();
    try {
      await importClient.query("BEGIN");
      await deleteImportsEdgesFrom(importClient, graphName, [...reverseImporters]);
      await importClient.query("COMMIT");
    } catch (err) {
      await importClient.query("ROLLBACK");
      throw err;
    } finally {
      importClient.release();
    }
  }

  // Resolve imports for all affected files
  const importFilesResult = filterExtractResult(extractResult, importAffectedPaths);
  const importResult = await resolveImports(graphName, importFilesResult, onImportsProgress);
  await updateJobStatus(jobId, "running", { last_completed_phase: "imports" });

  logger.info(
    {
      jobId,
      edges: importResult.importsEdgeCount,
      affectedFiles: importAffectedPaths.size,
    },
    "Phase 4 (incremental imports) complete",
  );

  // ── Phase 5: Incremental Call Graph ────────────────────
  if (await isJobCancelled(jobId)) return;

  const onCallGraphProgress: ProgressCallback = (pct, msg) => {
    updateJobProgress(jobId, "callgraph", pct).catch(() => {});
    logger.debug({ jobId, phase: "callgraph", pct, msg }, "Progress");
  };

  // Re-resolve call graph for: changed files + reverse importers
  // (their calls to changed files may now target different symbols)
  const callGraphAffectedPaths = new Set([
    ...addedPaths,
    ...modifiedPaths,
    ...reverseImporters,
  ]);

  // Delete existing call graph edges from reverse importers
  if (reverseImporters.size > 0) {
    const cgClient = await pool.connect();
    try {
      await cgClient.query("BEGIN");
      await deleteCallGraphEdgesFrom(cgClient, graphName, [...reverseImporters]);
      await cgClient.query("COMMIT");
    } catch (err) {
      await cgClient.query("ROLLBACK");
      throw err;
    } finally {
      cgClient.release();
    }
  }

  const callGraphFilesResult = filterExtractResult(extractResult, callGraphAffectedPaths);
  const callGraphResult = await buildCallGraph(graphName, callGraphFilesResult, onCallGraphProgress);
  await updateJobStatus(jobId, "running", { last_completed_phase: "callgraph" });

  logger.info(
    {
      jobId,
      calls: callGraphResult.callsEdgeCount,
      extends: callGraphResult.extendsEdgeCount,
      overrides: callGraphResult.overridesEdgeCount,
      handles: callGraphResult.handlesEdgeCount,
      affectedFiles: callGraphAffectedPaths.size,
    },
    "Phase 5 (incremental callgraph) complete",
  );

  // ── Phase 6: Community Re-detection ─────────────────────
  if (await isJobCancelled(jobId)) return;

  const onCommunityProgress: ProgressCallback = (pct, msg) => {
    const mappedPct = 85 + Math.round(pct * 0.07);
    updateJobProgress(jobId, "community", mappedPct).catch(() => {});
    logger.debug({ jobId, phase: "community", pct: mappedPct, msg }, "Progress");
  };

  const communityResult = await detectCommunities(graphName, onCommunityProgress);

  await pool.query(
    `UPDATE repositories SET community_detected_at = NOW(), community_count = $1 WHERE id = $2`,
    [communityResult.communitiesCreated, data.repositoryId],
  );

  await updateJobStatus(jobId, "running", { last_completed_phase: "community" });
  logger.info(
    {
      jobId,
      communities: communityResult.communitiesCreated,
      memberEdges: communityResult.memberEdgesCreated,
    },
    "Phase 6 (incremental community) complete",
  );

  // ── Phase 7: Process Re-detection ─────────────────────────
  if (await isJobCancelled(jobId)) return;

  const onProcessProgress: ProgressCallback = (pct, msg) => {
    const mappedPct = 92 + Math.round(pct * 0.05);
    updateJobProgress(jobId, "process", mappedPct).catch(() => {});
    logger.debug({ jobId, phase: "process", pct: mappedPct, msg }, "Progress");
  };

  const processResult = await detectProcesses(graphName, onProcessProgress);

  await pool.query(
    `UPDATE repositories SET process_count = $1 WHERE id = $2`,
    [processResult.processesCreated, data.repositoryId],
  );

  await updateJobStatus(jobId, "running", { last_completed_phase: "process" });
  logger.info(
    {
      jobId,
      processes: processResult.processesCreated,
      stepEdges: processResult.stepEdgesCreated,
    },
    "Phase 7 (incremental process) complete",
  );

  // ── Phase 8: Embeddings ─────────────────────────────────────
  if (await isJobCancelled(jobId)) return;

  const onEmbeddingsProgress: ProgressCallback = (pct, msg) => {
    const mappedPct = 97 + Math.round(pct * 0.03);
    updateJobProgress(jobId, "embeddings", mappedPct).catch(() => {});
    logger.debug({ jobId, phase: "embeddings", pct: mappedPct, msg }, "Progress");
  };

  try {
    const embeddingResult = await generateEmbeddings(
      data.repositoryId,
      data.projectId,
      graphName,
      onEmbeddingsProgress,
    );

    await updateJobStatus(jobId, "running", { last_completed_phase: "embeddings" });
    logger.info(
      {
        jobId,
        embedded: embeddingResult.symbolsEmbedded,
        staleDeleted: embeddingResult.staleDeleted,
      },
      "Phase 8 (incremental embeddings) complete",
    );
  } catch (err) {
    // Embeddings are optional for graph correctness; keep the index usable.
    logger.warn(
      { jobId, err },
      "Phase 8 (incremental embeddings) failed, continuing without embeddings",
    );
  }
}

// ─── File Node Updater ───────────────────────────────────────

/**
 * Update File node properties for modified files (content_hash, size, line_count).
 */
async function updateModifiedFileNodes(
  graphName: string,
  extractResult: ExtractResult,
  modifiedPaths: string[],
): Promise<void> {
  const crypto = await import("node:crypto");
  const fsp = await import("node:fs/promises");
  const { cypherWithClient } = await import("../db/age.js");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const filePath of modifiedPaths) {
      const file = extractResult.files.find((f) => f.relativePath === filePath);
      if (!file) continue;

      // Compute new metadata
      const buffer = await fsp.readFile(file.absolutePath);
      const contentHash = crypto
        .createHash("sha256")
        .update(buffer)
        .digest("hex");

      let lineCount = 0;
      if (buffer.length > 0) {
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] === 0x0a) lineCount++;
        }
        if (buffer[buffer.length - 1] !== 0x0a) lineCount++;
      }

      // Update the File node
      await cypherWithClient(
        client,
        graphName,
        `MATCH (f:File {path: $path}) SET f.content_hash = $content_hash, f.size = $size, f.line_count = $line_count RETURN f`,
        {
          path: filePath,
          content_hash: contentHash,
          size: file.sizeBytes,
          line_count: lineCount,
        },
        [{ name: "f" }],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Worker Registration ────────────────────────────────────

export async function registerIndexingWorker(): Promise<void> {
  const boss = getBoss();

  await boss.work<IndexingJobData>(
    INDEXING_QUEUE,
    { localConcurrency: 1 },
    handleIndexingJob,
  );

  logger.info("Indexing worker registered");
}
