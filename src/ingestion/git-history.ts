/**
 * Git file history extraction.
 *
 * Extracts per-file commit history using simple-git and stores it
 * in the git_file_history table for visualization overlays
 * (freshness, hotspots, author attribution).
 */

import { simpleGit } from "simple-git";
import { pool } from "../db/index.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("git-history");

// ─── Types ───────────────────────────────────────────────────

export interface GitFileCommit {
  filePath: string;
  commitSha: string;
  authorName: string;
  authorEmail: string;
  commitDate: string; // ISO 8601
  commitMessage: string;
  changeType: string; // A, M, D, R
}

export interface GitFileInfo {
  file_path: string;
  last_author: string;
  last_author_email: string;
  last_commit_date: string;
  commit_count: number;
  recent_commits: Array<{
    sha: string;
    author: string;
    email: string;
    date: string;
    message: string;
  }>;
}

export interface GitAuthor {
  name: string;
  email: string;
  file_count: number;
  commit_count: number;
}

export interface GitHistoryResult {
  files: GitFileInfo[];
  authors: GitAuthor[];
  timeline: Array<{ date: string; commits: number; files_changed: number }>;
  total_commits: number;
}

export interface ExtractGitHistoryResult {
  filesProcessed: number;
  commitsStored: number;
}

export interface GitCommitEvent {
  sha: string;
  author_name: string;
  author_email: string;
  date: string;
  message: string;
  files: Array<{ path: string; change: string }>;
}

export interface GitTimelineResult {
  commits: GitCommitEvent[];
  total_files: number;
}

// ─── Extraction (runs during indexing) ───────────────────────

const MAX_COMMITS_PER_FILE = 20;

/**
 * Extract git history for all files in a repository and store in DB.
 * Called after the structure phase during indexing.
 */
export async function extractGitHistory(
  repositoryId: string,
  rootDir: string,
  filePaths: string[],
  onProgress?: (pct: number, msg: string) => void,
): Promise<ExtractGitHistoryResult> {
  onProgress?.(0, "Starting git history extraction...");

  const git = simpleGit(rootDir);

  // Check if this is a git repo
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    log.info({ rootDir }, "Not a git repository, skipping git history extraction");
    return { filesProcessed: 0, commitsStored: 0 };
  }

  // Get all file log data in one call using --name-status for efficiency
  let allCommits: GitFileCommit[] = [];

  try {
    // Use git log with --name-status to get file changes per commit
    const logOutput = await git.raw([
      "log",
      `--format=%H|%an|%ae|%aI|%s`,
      "--name-status",
      "--diff-filter=ADMR",
      "-n", "500", // Limit to recent 500 commits for performance
    ]);

    allCommits = parseGitLog(logOutput, filePaths);
  } catch (err) {
    log.warn({ rootDir, err }, "Failed to extract git log, trying per-file approach");

    // Fallback: per-file extraction for shallow clones or unusual repos
    allCommits = await extractPerFile(git, filePaths, onProgress);
  }

  onProgress?.(50, `Parsed ${allCommits.length} file-commit entries, storing...`);

  // Clear old data for this repo
  await pool.query(
    `DELETE FROM git_file_history WHERE repository_id = $1`,
    [repositoryId],
  );

  // Batch insert
  if (allCommits.length > 0) {
    const BATCH_SIZE = 200;
    for (let i = 0; i < allCommits.length; i += BATCH_SIZE) {
      const batch = allCommits.slice(i, i + BATCH_SIZE);
      await insertBatch(repositoryId, batch);
    }
  }

  // Update repository metadata
  await pool.query(
    `UPDATE repositories SET git_history_extracted_at = NOW() WHERE id = $1`,
    [repositoryId],
  );

  onProgress?.(100, `Git history: ${allCommits.length} entries from ${new Set(allCommits.map(c => c.filePath)).size} files`);

  log.info(
    { repositoryId, commits: allCommits.length, files: new Set(allCommits.map(c => c.filePath)).size },
    "Git history extraction complete",
  );

  return {
    filesProcessed: new Set(allCommits.map(c => c.filePath)).size,
    commitsStored: allCommits.length,
  };
}

/**
 * Parse git log output (--format=%H|%an|%ae|%aI|%s with --name-status).
 * Groups by commit, then creates per-file entries.
 */
function parseGitLog(output: string, knownFiles: string[]): GitFileCommit[] {
  const knownSet = new Set(knownFiles);
  const fileCommitCounts = new Map<string, number>();
  const results: GitFileCommit[] = [];

  const lines = output.split("\n");
  let currentCommit: {
    sha: string;
    author: string;
    email: string;
    date: string;
    message: string;
  } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if this is a commit line (contains pipe-separated values)
    const commitMatch = trimmed.match(/^([0-9a-f]{40})\|(.+?)\|(.+?)\|(.+?)\|(.*)$/);
    if (commitMatch) {
      currentCommit = {
        sha: commitMatch[1],
        author: commitMatch[2],
        email: commitMatch[3],
        date: commitMatch[4],
        message: commitMatch[5],
      };
      continue;
    }

    // Check if this is a name-status line (A/M/D/R followed by tab and file path)
    const statusMatch = trimmed.match(/^([ADMR])\d*\t(.+?)(?:\t(.+))?$/);
    if (statusMatch && currentCommit) {
      const changeType = statusMatch[1];
      const filePath = statusMatch[3] || statusMatch[2]; // For renames, use new path

      // Only track files we know about (indexed files)
      if (!knownSet.has(filePath)) continue;

      // Limit commits per file
      const count = fileCommitCounts.get(filePath) || 0;
      if (count >= MAX_COMMITS_PER_FILE) continue;
      fileCommitCounts.set(filePath, count + 1);

      results.push({
        filePath,
        commitSha: currentCommit.sha,
        authorName: currentCommit.author,
        authorEmail: currentCommit.email,
        commitDate: currentCommit.date,
        commitMessage: currentCommit.message,
        changeType,
      });
    }
  }

  return results;
}

/**
 * Fallback: extract git log per-file (slower but works with shallow clones).
 */
async function extractPerFile(
  git: ReturnType<typeof simpleGit>,
  filePaths: string[],
  onProgress?: (pct: number, msg: string) => void,
): Promise<GitFileCommit[]> {
  const results: GitFileCommit[] = [];
  const total = filePaths.length;

  for (let i = 0; i < total; i++) {
    const filePath = filePaths[i];
    if (i % 50 === 0) {
      onProgress?.(Math.round((i / total) * 50), `Processing file ${i + 1}/${total}`);
    }

    try {
      const logOutput = await git.raw([
        "log",
        `--format=%H|%an|%ae|%aI|%s`,
        `-n`, String(MAX_COMMITS_PER_FILE),
        "--", filePath,
      ]);

      for (const line of logOutput.split("\n")) {
        const match = line.trim().match(/^([0-9a-f]{40})\|(.+?)\|(.+?)\|(.+?)\|(.*)$/);
        if (match) {
          results.push({
            filePath,
            commitSha: match[1],
            authorName: match[2],
            authorEmail: match[3],
            commitDate: match[4],
            commitMessage: match[5],
            changeType: "M",
          });
        }
      }
    } catch {
      // Skip files that can't be logged (new files, etc.)
    }
  }

  return results;
}

/**
 * Batch insert git file history records.
 */
async function insertBatch(
  repositoryId: string,
  commits: GitFileCommit[],
): Promise<void> {
  if (commits.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const offset = i * 8;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::timestamptz, $${offset + 7}, $${offset + 8})`,
    );
    values.push(
      repositoryId,
      c.filePath,
      c.commitSha,
      c.authorName,
      c.authorEmail,
      c.commitDate,
      c.commitMessage?.slice(0, 500) || "",
      c.changeType || "M",
    );
  }

  await pool.query(
    `INSERT INTO git_file_history (repository_id, file_path, commit_sha, author_name, author_email, commit_date, commit_message, change_type)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (repository_id, file_path, commit_sha) DO NOTHING`,
    values,
  );
}

// ─── Query API (called from routes) ─────────────────────────

/**
 * Get aggregated git history data for a repository.
 * Used by the frontend overlay.
 */
export async function getGitHistoryForRepo(
  repositoryId: string,
  options?: { file_path?: string; limit?: number },
): Promise<GitHistoryResult> {
  const fileLimit = Math.min(options?.limit ?? 50, 100);
  const filePath = options?.file_path;

  // Get per-file aggregated data (with limit)
  const fileParams: unknown[] = [repositoryId];
  let fileWhere = "WHERE repository_id = $1";
  if (filePath) {
    fileParams.push(filePath);
    fileWhere += ` AND file_path = $${fileParams.length}`;
  }
  fileParams.push(fileLimit);

  const fileQuery = await pool.query<{
    file_path: string;
    last_author: string;
    last_email: string;
    last_date: string;
    commit_count: string;
  }>(
    `SELECT
       file_path,
       (ARRAY_AGG(author_name ORDER BY commit_date DESC))[1] AS last_author,
       (ARRAY_AGG(author_email ORDER BY commit_date DESC))[1] AS last_email,
       MAX(commit_date)::text AS last_date,
       COUNT(*)::text AS commit_count
     FROM git_file_history
     ${fileWhere}
     GROUP BY file_path
     ORDER BY MAX(commit_date) DESC
     LIMIT $${fileParams.length}`,
    fileParams,
  );

  // Get recent commits only for the files we're returning (top 5 for each)
  const returnedPaths = fileQuery.rows.map((r) => r.file_path);
  let recentRows: Array<{
    file_path: string;
    commit_sha: string;
    author_name: string;
    author_email: string;
    commit_date: string;
    commit_message: string;
  }> = [];

  if (returnedPaths.length > 0) {
    const recentQuery = await pool.query<{
      file_path: string;
      commit_sha: string;
      author_name: string;
      author_email: string;
      commit_date: string;
      commit_message: string;
    }>(
      `SELECT file_path, commit_sha, author_name, author_email, commit_date::text, commit_message
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY commit_date DESC) AS rn
         FROM git_file_history
         WHERE repository_id = $1 AND file_path = ANY($2)
       ) sub
       WHERE rn <= 5
       ORDER BY file_path, commit_date DESC`,
      [repositoryId, returnedPaths],
    );
    recentRows = recentQuery.rows;
  }

  // Build recent commits map
  const recentMap = new Map<string, GitFileInfo["recent_commits"]>();
  for (const row of recentRows) {
    const list = recentMap.get(row.file_path) || [];
    list.push({
      sha: row.commit_sha,
      author: row.author_name,
      email: row.author_email,
      date: row.commit_date,
      message: row.commit_message || "",
    });
    recentMap.set(row.file_path, list);
  }

  const files: GitFileInfo[] = fileQuery.rows.map((r) => ({
    file_path: r.file_path,
    last_author: r.last_author,
    last_author_email: r.last_email,
    last_commit_date: r.last_date,
    commit_count: parseInt(r.commit_count, 10),
    recent_commits: recentMap.get(r.file_path) || [],
  }));

  // Get author stats
  const authorQuery = await pool.query<{
    author_name: string;
    author_email: string;
    file_count: string;
    commit_count: string;
  }>(
    `SELECT
       author_name,
       author_email,
       COUNT(DISTINCT file_path)::text AS file_count,
       COUNT(DISTINCT commit_sha)::text AS commit_count
     FROM git_file_history
     WHERE repository_id = $1
     GROUP BY author_name, author_email
     ORDER BY COUNT(DISTINCT commit_sha) DESC`,
    [repositoryId],
  );

  const authors: GitAuthor[] = authorQuery.rows.map((r) => ({
    name: r.author_name,
    email: r.author_email,
    file_count: parseInt(r.file_count, 10),
    commit_count: parseInt(r.commit_count, 10),
  }));

  // Get timeline (commits per day, last 90 days)
  const timelineQuery = await pool.query<{
    day: string;
    commits: string;
    files_changed: string;
  }>(
    `SELECT
       commit_date::date::text AS day,
       COUNT(DISTINCT commit_sha)::text AS commits,
       COUNT(DISTINCT file_path)::text AS files_changed
     FROM git_file_history
     WHERE repository_id = $1
       AND commit_date >= NOW() - INTERVAL '90 days'
     GROUP BY commit_date::date
     ORDER BY commit_date::date`,
    [repositoryId],
  );

  const timeline = timelineQuery.rows.map((r) => ({
    date: r.day,
    commits: parseInt(r.commits, 10),
    files_changed: parseInt(r.files_changed, 10),
  }));

  // Total unique commits
  const totalQuery = await pool.query<{ cnt: string }>(
    `SELECT COUNT(DISTINCT commit_sha)::text AS cnt FROM git_file_history WHERE repository_id = $1`,
    [repositoryId],
  );

  return {
    files,
    authors,
    timeline,
    total_commits: parseInt(totalQuery.rows[0]?.cnt || "0", 10),
  };
}

/**
 * Get chronological commit timeline for Gource-style visualization.
 * Returns commits in chronological order with their file changes grouped.
 */
export async function getGitTimelineForRepo(
  repositoryId: string,
  options?: { since?: string; until?: string; limit?: number },
): Promise<GitTimelineResult> {
  const commitLimit = Math.min(options?.limit ?? 20, 100);

  const params: unknown[] = [repositoryId];
  let dateFilter = "";
  if (options?.since) {
    params.push(options.since);
    dateFilter += ` AND commit_date >= $${params.length}::timestamptz`;
  }
  if (options?.until) {
    params.push(options.until);
    dateFilter += ` AND commit_date <= $${params.length}::timestamptz`;
  }
  params.push(commitLimit);

  const commitQuery = await pool.query<{
    commit_sha: string;
    author_name: string;
    author_email: string;
    commit_date: string;
    commit_message: string;
    files: Array<{ path: string; change: string }>;
  }>(
    `SELECT
       commit_sha,
       author_name,
       author_email,
       commit_date::text,
       commit_message,
       json_agg(json_build_object('path', file_path, 'change', COALESCE(change_type, 'M'))) AS files
     FROM git_file_history
     WHERE repository_id = $1${dateFilter}
     GROUP BY commit_sha, author_name, author_email, commit_date, commit_message
     ORDER BY commit_date ASC
     LIMIT $${params.length}`,
    params,
  );

  const totalFilesQuery = await pool.query<{ cnt: string }>(
    `SELECT COUNT(DISTINCT file_path)::text AS cnt FROM git_file_history WHERE repository_id = $1`,
    [repositoryId],
  );

  return {
    commits: commitQuery.rows.map((r) => ({
      sha: r.commit_sha,
      author_name: r.author_name,
      author_email: r.author_email,
      date: r.commit_date,
      message: r.commit_message || "",
      files: r.files,
    })),
    total_files: parseInt(totalFilesQuery.rows[0]?.cnt || "0", 10),
  };
}
