/**
 * Git diff → symbol impact analysis.
 *
 * Parses unified diff output, maps changed lines to graph symbols,
 * traces indirect impact through CALLS edges, and identifies affected processes.
 */

import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pool } from "../db/index.js";
import { cypher } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const log = createChildLogger("diff-impact");

// ─── Types ───────────────────────────────────────────────────

export type DiffScope = "unstaged" | "staged" | "all" | "compare";

export interface DiffImpactOptions {
  scope?: DiffScope;
  compareRef?: string;
  maxDepth?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
}

export interface ChangedFileInfo {
  filePath: string;
  addedLines: number[];
  removedLines: number[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DirectSymbol {
  id: number;
  name: string;
  label: string;
  filePath: string;
  line: number;
}

export interface ImpactedSymbol {
  id: number;
  name: string;
  label: string;
  filePath: string;
  line: number;
  depth: number;
  via: string;
}

export interface AffectedProcess {
  processId: number;
  label: string;
  processType: string;
  stepCount: number;
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface DiffImpactResult {
  changed_files: ChangedFileInfo[];
  direct_symbols: DirectSymbol[];
  impacted_symbols: ImpactedSymbol[];
  affected_processes: AffectedProcess[];
  risk: RiskLevel;
  summary: string;
}

// ─── Repository Path Resolution ──────────────────────────────

interface RepoInfo {
  id: string;
  url: string;
  sourceType: string;
  graphName: string;
}

async function getRepoInfo(repoId: string, graphName: string): Promise<RepoInfo> {
  const result = await pool.query<{
    id: string;
    url: string;
    source_type: string;
    graph_name: string;
  }>(
    "SELECT id, url, source_type, graph_name FROM repositories WHERE id = $1 AND graph_name = $2 LIMIT 1",
    [repoId, graphName],
  );
  if (result.rows.length === 0) {
    throw new Error(`Repository ${repoId} not found or has no graph`);
  }
  const row = result.rows[0];
  return {
    id: row.id,
    url: row.url,
    sourceType: row.source_type,
    graphName: row.graph_name,
  };
}

function getRepoPath(repo: RepoInfo): string {
  if (repo.sourceType === "local_path") {
    return path.resolve(repo.url);
  }
  throw new Error(
    `UNSUPPORTED_SOURCE_TYPE: detect_changes requires a local_path repository. ` +
      `Received source type "${repo.sourceType}" for "${repo.url}".`,
  );
}

async function validateLocalGitRepo(repoPath: string): Promise<void> {
  try {
    const stat = await fsp.stat(repoPath);
    if (!stat.isDirectory()) {
      throw new Error("path is not a directory");
    }
  } catch {
    throw new Error(`REPO_PATH_NOT_FOUND: '${repoPath}' does not exist on disk.`);
  }

  try {
    await fsp.access(path.join(repoPath, ".git"));
  } catch {
    throw new Error(`NOT_A_GIT_REPO: '${repoPath}' is not a git repository.`);
  }
}

// ─── Git Diff Execution ──────────────────────────────────────

async function runGitDiff(
  repoPath: string,
  scope: DiffScope,
  compareRef?: string,
): Promise<string> {
  const args = ["diff", "--unified=0", "--no-color"];

  switch (scope) {
    case "unstaged":
      // default: git diff (working tree vs index)
      break;
    case "staged":
      args.push("--cached");
      break;
    case "all":
      args.push("HEAD");
      break;
    case "compare":
      if (!compareRef) {
        throw new Error("compare_ref is required when scope is 'compare'");
      }
      args.push(`${compareRef}..HEAD`);
      break;
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return stdout;
  } catch (err: unknown) {
    // git diff returns exit code 1 when there are differences in some modes.
    // node child_process treats non-zero exit as error, but stdout is still valid.
    if (err && typeof err === "object" && "stdout" in err) {
      const stdout = (err as { stdout: string }).stdout;
      if (typeof stdout === "string" && stdout.length > 0) {
        return stdout;
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run git diff: ${message}`);
  }
}

// ─── Unified Diff Parser ────────────────────────────────────

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseDiffOutput(diffOutput: string): ChangedFileInfo[] {
  if (!diffOutput.trim()) return [];

  const files: ChangedFileInfo[] = [];
  let currentFile: ChangedFileInfo | null = null;
  let currentNewLine = 0;
  let currentOldLine = 0;

  const lines = diffOutput.split("\n");

  for (const line of lines) {
    const fileMatch = FILE_HEADER_RE.exec(line);
    if (fileMatch) {
      if (currentFile) {
        files.push(currentFile);
      }
      currentFile = {
        filePath: fileMatch[2],
        addedLines: [],
        removedLines: [],
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    if (!currentFile) continue;

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      currentFile.hunks.push({
        oldStart,
        oldCount,
        newStart,
        newCount,
        header: line,
      });

      currentOldLine = oldStart;
      currentNewLine = newStart;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentFile.addedLines.push(currentNewLine);
      currentFile.additions++;
      currentNewLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentFile.removedLines.push(currentOldLine);
      currentFile.deletions++;
      currentOldLine++;
    } else if (!line.startsWith("\\")) {
      // Context line (not present with --unified=0, but handle anyway)
      currentNewLine++;
      currentOldLine++;
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

// ─── Line Range Merging ─────────────────────────────────────

interface LineRange {
  start: number;
  end: number;
}

/**
 * Merge adjacent/overlapping changed line ranges within a proximity threshold.
 */
function mergeLineRanges(lines: number[], proximity: number = 3): LineRange[] {
  if (lines.length === 0) return [];

  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: LineRange[] = [{ start: sorted[0], end: sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = ranges[ranges.length - 1];
    if (sorted[i] <= current.end + proximity) {
      current.end = sorted[i];
    } else {
      ranges.push({ start: sorted[i], end: sorted[i] });
    }
  }

  return ranges;
}

// ─── Symbol Mapping ─────────────────────────────────────────

const SYMBOL_LABELS = [
  "Function", "Class", "Interface", "Method", "CodeElement",
  "RouteHandler", "Struct", "Enum", "Trait", "TypeAlias", "Namespace",
];

/**
 * Query AGE for symbols in a changed file whose line is within `tolerance` lines
 * of any changed line range.
 */
async function findDirectSymbols(
  graphName: string,
  changedFiles: ChangedFileInfo[],
  tolerance: number = 5,
): Promise<DirectSymbol[]> {
  const directSymbols: DirectSymbol[] = [];
  const seenIds = new Set<number>();

  for (const file of changedFiles) {
    const allChanged = [...file.addedLines, ...file.removedLines];
    if (allChanged.length === 0) continue;

    const ranges = mergeLineRanges(allChanged);

    // Query symbols in this file
    let rows: { n: AgeVertex; start_line: unknown }[];
    try {
      rows = await cypher<{ n: AgeVertex; start_line: unknown }>(
        graphName,
        `MATCH (f:File {path: $filePath})-[:DEFINES]->(n)
         RETURN n, n.start_line AS start_line`,
        { filePath: file.filePath },
        [{ name: "n" }, { name: "start_line" }],
      );
    } catch {
      continue;
    }

    for (const { n, start_line } of rows) {
      if (seenIds.has(n.id)) continue;
      if (!SYMBOL_LABELS.includes(n.label)) continue;

      const line = typeof start_line === "number"
        ? start_line
        : typeof n.properties.start_line === "number"
          ? n.properties.start_line
          : typeof n.properties.line === "number"
            ? n.properties.line
            : null;
      if (line === null) continue;

      // Check if symbol line is within tolerance of any changed range
      const isAffected = ranges.some(
        (r) => line >= r.start - tolerance && line <= r.end + tolerance,
      );

      if (isAffected) {
        seenIds.add(n.id);
        directSymbols.push({
          id: n.id,
          name: typeof n.properties.name === "string" ? n.properties.name : "",
          label: n.label,
          filePath: file.filePath,
          line,
        });
      }
    }
  }

  return directSymbols;
}

// ─── Indirect Impact Tracing ────────────────────────────────

async function traceIndirectImpact(
  graphName: string,
  directSymbolIds: number[],
  maxDepth: number,
): Promise<ImpactedSymbol[]> {
  if (directSymbolIds.length === 0) return [];

  const impacted: ImpactedSymbol[] = [];
  const seenIds = new Set<number>(directSymbolIds);

  for (const targetId of directSymbolIds) {
    try {
      // Find callers up to maxDepth levels deep
      const rows = await cypher<{ caller: AgeVertex; depth: number }>(
        graphName,
        `MATCH (caller)-[:CALLS*1..${maxDepth}]->(target)
         WHERE id(target) = $targetId
         RETURN DISTINCT caller, 1 as depth`,
        { targetId },
        [{ name: "caller" }, { name: "depth" }],
      );

      for (const { caller } of rows) {
        if (seenIds.has(caller.id)) continue;
        seenIds.add(caller.id);

        const targetSymbol = directSymbolIds.find((id) => id === targetId);
        impacted.push({
          id: caller.id,
          name: typeof caller.properties.name === "string" ? caller.properties.name : "",
          label: caller.label,
          filePath:
            typeof caller.properties.file_path === "string"
              ? caller.properties.file_path
              : "",
          line: typeof caller.properties.line === "number" ? caller.properties.line : 0,
          depth: 1,
          via: `calls → symbol id ${targetSymbol}`,
        });
      }
    } catch (err: unknown) {
      // Variable-length CALLS path may not be supported by AGE.
      // Fall back to single-hop query.
      log.debug({ err, targetId }, "Variable-length CALLS query failed, using single-hop");
      try {
        const rows = await cypher<{ caller: AgeVertex }>(
          graphName,
          `MATCH (caller)-[:CALLS]->(target)
           WHERE id(target) = $targetId
           RETURN DISTINCT caller`,
          { targetId },
          [{ name: "caller" }],
        );

        for (const { caller } of rows) {
          if (seenIds.has(caller.id)) continue;
          seenIds.add(caller.id);

          impacted.push({
            id: caller.id,
            name: typeof caller.properties.name === "string" ? caller.properties.name : "",
            label: caller.label,
            filePath:
              typeof caller.properties.file_path === "string"
                ? caller.properties.file_path
                : "",
            line: typeof caller.properties.line === "number" ? caller.properties.line : 0,
            depth: 1,
            via: `calls → symbol id ${targetId}`,
          });
        }
      } catch {
        // Skip this target if the query fails entirely
        continue;
      }
    }
  }

  return impacted;
}

// ─── Affected Processes ─────────────────────────────────────

async function findAffectedProcesses(
  graphName: string,
  affectedIds: number[],
): Promise<AffectedProcess[]> {
  if (affectedIds.length === 0) return [];

  const processes = new Map<number, AffectedProcess>();

  for (const symbolId of affectedIds) {
    try {
      const rows = await cypher<{ p: AgeVertex }>(
        graphName,
        `MATCH (s)-[:STEP_IN_PROCESS]->(p:Process)
         WHERE id(s) = $symbolId
         RETURN DISTINCT p`,
        { symbolId },
        [{ name: "p" }],
      );

      for (const { p } of rows) {
        if (processes.has(p.id)) continue;
        processes.set(p.id, {
          processId: p.id,
          label:
            typeof p.properties.heuristic_label === "string"
              ? p.properties.heuristic_label
              : typeof p.properties.label === "string"
                ? p.properties.label
                : `Process ${p.id}`,
          processType:
            typeof p.properties.process_type === "string"
              ? p.properties.process_type
              : "unknown",
          stepCount:
            typeof p.properties.step_count === "number" ? p.properties.step_count : 0,
        });
      }
    } catch {
      continue;
    }
  }

  return [...processes.values()];
}

// ─── Risk Assessment ────────────────────────────────────────

function assessRisk(
  totalImpact: number,
  processCount: number,
): RiskLevel {
  if (totalImpact > 20 || processCount > 3) return "CRITICAL";
  if (totalImpact > 10 || processCount > 1) return "HIGH";
  if (totalImpact > 3) return "MEDIUM";
  return "LOW";
}

// ─── Main Entry Point ───────────────────────────────────────

export async function analyzeChanges(
  repoId: string,
  graphName: string,
  options: DiffImpactOptions = {},
): Promise<DiffImpactResult> {
  const scope = options.scope ?? "all";
  const maxDepth = options.maxDepth ?? 3;

  log.info({ repoId, graphName, scope, maxDepth }, "Starting diff impact analysis");

  // 1. Resolve repo path
  const repo = await getRepoInfo(repoId, graphName);
  const repoPath = getRepoPath(repo);
  await validateLocalGitRepo(repoPath);

  // 2. Run git diff
  const diffOutput = await runGitDiff(repoPath, scope, options.compareRef);
  const changedFiles = parseDiffOutput(diffOutput);

  log.info({ fileCount: changedFiles.length }, "Parsed changed files from diff");

  if (changedFiles.length === 0) {
    return {
      changed_files: [],
      direct_symbols: [],
      impacted_symbols: [],
      affected_processes: [],
      risk: "LOW",
      summary: "No changes detected",
    };
  }

  // 3. Map to direct symbols
  const directSymbols = await findDirectSymbols(graphName, changedFiles);

  // 4. Trace indirect impact
  const directIds = directSymbols.map((s) => s.id);
  const impactedSymbols = await traceIndirectImpact(graphName, directIds, maxDepth);

  // 5. Find affected processes
  const allAffectedIds = [...directIds, ...impactedSymbols.map((s) => s.id)];
  const affectedProcesses = await findAffectedProcesses(graphName, allAffectedIds);

  // 6. Assess risk
  const totalImpact = directSymbols.length + impactedSymbols.length;
  const risk = assessRisk(totalImpact, affectedProcesses.length);

  // 7. Build summary
  const summary =
    `${changedFiles.length} file(s) changed, ` +
    `${directSymbols.length} direct symbol(s), ` +
    `${impactedSymbols.length} indirectly impacted, ` +
    `${affectedProcesses.length} process(es) affected — ` +
    `Risk: ${risk}`;

  log.info({ risk, totalImpact, processes: affectedProcesses.length }, summary);

  return {
    changed_files: changedFiles,
    direct_symbols: directSymbols,
    impacted_symbols: impactedSymbols,
    affected_processes: affectedProcesses,
    risk,
    summary,
  };
}
