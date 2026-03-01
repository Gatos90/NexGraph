import { simpleGit } from "simple-git";
import type pg from "pg";
import { cypherWithClient } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("incremental");

// ─── Types ──────────────────────────────────────────────────

export type FileChangeStatus = "A" | "M" | "D" | "R";

export interface ChangedFile {
  status: FileChangeStatus;
  path: string;
  /** For renames: the old path before the rename */
  oldPath?: string;
}

export interface DiffResult {
  headCommit: string;
  changedFiles: ChangedFile[];
}

// ─── Git Operations ─────────────────────────────────────────

/**
 * Get the HEAD commit SHA from a git repository.
 */
export async function getHeadCommit(rootDir: string): Promise<string | null> {
  try {
    const git = simpleGit(rootDir);
    const sha = await git.revparse(["HEAD"]);
    return sha.trim();
  } catch {
    logger.debug({ rootDir }, "Not a git repository or no commits");
    return null;
  }
}

/**
 * Get changed files between two commits using `git diff --name-status`.
 *
 * For git_url sources (shallow clones), we first fetch the old commit
 * before running the diff.
 */
export async function getChangedFiles(
  rootDir: string,
  oldSha: string,
  newSha: string,
  isShallowClone?: boolean,
): Promise<ChangedFile[]> {
  const git = simpleGit(rootDir);

  // For shallow clones, fetch the old commit so we can diff against it
  if (isShallowClone) {
    try {
      await git.fetch(["origin", oldSha, "--depth=1"]);
    } catch (err) {
      logger.warn(
        { rootDir, oldSha, err },
        "Failed to fetch old commit for shallow clone diff; falling back to full reindex",
      );
      return [];
    }
  }

  const diffOutput = await git.diff([
    "--name-status",
    `${oldSha}..${newSha}`,
  ]);

  return parseDiffOutput(diffOutput);
}

/**
 * Parse `git diff --name-status` output into ChangedFile entries.
 *
 * Output format (tab-separated):
 *   A\tpath/to/new/file
 *   M\tpath/to/modified/file
 *   D\tpath/to/deleted/file
 *   R100\told/path\tnew/path
 */
export function parseDiffOutput(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = output.trim().split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split("\t");
    const statusCode = parts[0].trim();

    if (statusCode.startsWith("R")) {
      // Rename: treat as delete old + add new
      files.push(
        { status: "D", path: parts[1], oldPath: parts[1] },
        { status: "A", path: parts[2], oldPath: parts[1] },
      );
    } else if (statusCode === "A" || statusCode === "M" || statusCode === "D") {
      files.push({ status: statusCode, path: parts[1] });
    } else if (statusCode.startsWith("C")) {
      // Copy: treat the copy target as added
      files.push({ status: "A", path: parts[2] });
    }
  }

  return files;
}

// ─── Graph Cleanup ──────────────────────────────────────────

/**
 * Delete all graph data for a set of file paths:
 * - Symbol nodes (Function, Class, Method, Interface, CodeElement, RouteHandler) and their edges
 * - IMPORTS edges from/to the file
 * - CALLS, EXTENDS, IMPLEMENTS edges from symbols in the file
 * - EXPOSES edges from the file
 * - CONTAINS edge from parent folder to the file
 * - The File node itself (for deleted files)
 *
 * Returns the set of file paths that had IMPORTS edges pointing to the removed files
 * (these "reverse importers" may need their call graph re-resolved).
 */
export async function cleanupFilesFromGraph(
  client: pg.PoolClient,
  graphName: string,
  filePaths: string[],
  deleteFileNodes: boolean,
): Promise<Set<string>> {
  if (filePaths.length === 0) return new Set();

  const reverseImporters = new Set<string>();

  for (const filePath of filePaths) {
    // 1. Find the File node
    const fileRows = await cypherWithClient<{ v: AgeVertex }>(
      client,
      graphName,
      "MATCH (v:File {path: $path}) RETURN v",
      { path: filePath },
      [{ name: "v" }],
    );

    if (fileRows.length === 0) continue;

    // 2. Find reverse importers (files that IMPORT this file) — needed for callgraph re-resolution
    const importerRows = await cypherWithClient<{ f: AgeVertex }>(
      client,
      graphName,
      "MATCH (f:File)-[:IMPORTS]->(t:File {path: $path}) WHERE f.path <> $path RETURN f",
      { path: filePath },
      [{ name: "f" }],
    );
    for (const row of importerRows) {
      reverseImporters.add(row.f.properties.path as string);
    }

    // 3. Delete CALLS/EXTENDS/IMPLEMENTS edges from symbols defined in this file
    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:DEFINES]->(s)-[e:CALLS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {
      // No CALLS edges — that's fine
    });

    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:DEFINES]->(s)-[e:EXTENDS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:DEFINES]->(s)-[e:IMPLEMENTS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    // 4. Delete incoming CALLS/EXTENDS/IMPLEMENTS to symbols in this file
    await cypherWithClient(
      client,
      graphName,
      "MATCH ()-[e:CALLS]->(s)<-[:DEFINES]-(:File {path: $path}) DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    await cypherWithClient(
      client,
      graphName,
      "MATCH ()-[e:EXTENDS]->(s)<-[:DEFINES]-(:File {path: $path}) DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    await cypherWithClient(
      client,
      graphName,
      "MATCH ()-[e:IMPLEMENTS]->(s)<-[:DEFINES]-(:File {path: $path}) DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    // 5. Delete DEFINES edges and symbol nodes
    // First get the symbol IDs so we can delete the nodes after removing edges
    const symbolRows = await cypherWithClient<{ s: AgeVertex }>(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:DEFINES]->(s) RETURN s",
      { path: filePath },
      [{ name: "s" }],
    );

    // Delete DEFINES edges
    if (symbolRows.length > 0) {
      await cypherWithClient(
        client,
        graphName,
        "MATCH (:File {path: $path})-[e:DEFINES]->() DELETE e RETURN count(e) as cnt",
        { path: filePath },
        [{ name: "cnt" }],
      );

      // Delete symbol nodes
      for (const row of symbolRows) {
        await cypherWithClient(
          client,
          graphName,
          "MATCH (s) WHERE id(s) = $sid DELETE s RETURN count(s) as cnt",
          { sid: row.s.id },
          [{ name: "cnt" }],
        );
      }
    }

    // 6. Delete EXPOSES edges and RouteHandler nodes
    const routeRows = await cypherWithClient<{ r: AgeVertex }>(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:EXPOSES]->(r:RouteHandler) RETURN r",
      { path: filePath },
      [{ name: "r" }],
    ).catch(() => [] as Array<{ r: AgeVertex }>);

    if (routeRows.length > 0) {
      await cypherWithClient(
        client,
        graphName,
        "MATCH (:File {path: $path})-[e:EXPOSES]->() DELETE e RETURN count(e) as cnt",
        { path: filePath },
        [{ name: "cnt" }],
      ).catch(() => {});

      for (const row of routeRows) {
        await cypherWithClient(
          client,
          graphName,
          "MATCH (r) WHERE id(r) = $rid DELETE r RETURN count(r) as cnt",
          { rid: row.r.id },
          [{ name: "cnt" }],
        ).catch(() => {});
      }
    }

    // 7. Delete IMPORTS edges from this file
    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[e:IMPORTS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    // 8. Delete IMPORTS edges to this file
    await cypherWithClient(
      client,
      graphName,
      "MATCH ()-[e:IMPORTS]->(:File {path: $path}) DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    // 9. For deleted files: delete CONTAINS edge and the File node
    if (deleteFileNodes) {
      await cypherWithClient(
        client,
        graphName,
        "MATCH ()-[e:CONTAINS]->(:File {path: $path}) DELETE e RETURN count(e) as cnt",
        { path: filePath },
        [{ name: "cnt" }],
      ).catch(() => {});

      await cypherWithClient(
        client,
        graphName,
        "MATCH (f:File {path: $path}) DELETE f RETURN count(f) as cnt",
        { path: filePath },
        [{ name: "cnt" }],
      );
    }
  }

  logger.info(
    {
      graphName,
      cleanedFiles: filePaths.length,
      reverseImporters: reverseImporters.size,
      deletedNodes: deleteFileNodes,
    },
    "Graph cleanup complete",
  );

  return reverseImporters;
}

/**
 * Delete IMPORTS edges FROM a set of files (outgoing imports).
 * Used when we need to re-resolve imports for files that imported changed files.
 */
export async function deleteImportsEdgesFrom(
  client: pg.PoolClient,
  graphName: string,
  filePaths: string[],
): Promise<void> {
  for (const filePath of filePaths) {
    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[e:IMPORTS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});
  }
}

/**
 * Delete CALLS/EXTENDS/IMPLEMENTS edges FROM symbols in a set of files.
 * Used when we need to re-resolve call graph for affected files.
 */
export async function deleteCallGraphEdgesFrom(
  client: pg.PoolClient,
  graphName: string,
  filePaths: string[],
): Promise<void> {
  for (const filePath of filePaths) {
    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:DEFINES]->(s)-[e:CALLS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:DEFINES]->(s)-[e:EXTENDS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});

    await cypherWithClient(
      client,
      graphName,
      "MATCH (:File {path: $path})-[:DEFINES]->(s)-[e:IMPLEMENTS]->() DELETE e RETURN count(e) as cnt",
      { path: filePath },
      [{ name: "cnt" }],
    ).catch(() => {});
  }
}
