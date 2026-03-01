/**
 * Process detection via BFS tracing from entry points.
 * Creates Process nodes and STEP_IN_PROCESS edges in the AGE graph.
 */

import { pool } from "../db/connection.js";
import { cypher, cypherWithClient } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import type { ProgressCallback } from "./extract.js";
import { scoreEntryPoints } from "./entry-point-scoring.js";
import type { ScoredEntryPoint } from "./entry-point-scoring.js";

const logger = createChildLogger("process-detection");

// ─── Types ──────────────────────────────────────────────

export interface ProcessDetectionResult {
  processesCreated: number;
  stepEdgesCreated: number;
  entryPointsScored: number;
}

interface TracePath {
  nodeIds: number[];
  entryId: number;
  terminalId: number;
}

// ─── Constants ──────────────────────────────────────────

const MAX_DEPTH = 10;
const MAX_BRANCHING = 4;
const MAX_PROCESSES = 75;
const MIN_STEPS = 3;

// ─── BFS Trace ──────────────────────────────────────────

/**
 * BFS trace from an entry point through CALLS edges.
 * Returns all paths from entry to terminal nodes (nodes with no further outgoing calls in the trace).
 */
function bfsTrace(
  entryId: number,
  callGraph: Map<number, number[]>,
): TracePath[] {
  const paths: TracePath[] = [];

  // BFS with path tracking: each queue entry is the current path
  const queue: number[][] = [[entryId]];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath) break;
    const currentNode = currentPath[currentPath.length - 1];

    // Get callees
    const callees = callGraph.get(currentNode) ?? [];

    // Filter callees: cycle detection (path membership check), branching limit
    const validCallees: number[] = [];
    const pathSet = new Set(currentPath);
    for (const callee of callees) {
      if (pathSet.has(callee)) continue; // cycle detection
      validCallees.push(callee);
      if (validCallees.length >= MAX_BRANCHING) break;
    }

    if (validCallees.length === 0 || currentPath.length >= MAX_DEPTH) {
      // Terminal: record this path
      paths.push({
        nodeIds: currentPath,
        entryId,
        terminalId: currentNode,
      });
    } else {
      // Expand BFS
      for (const callee of validCallees) {
        queue.push([...currentPath, callee]);
      }
    }
  }

  return paths;
}

// ─── Deduplication ──────────────────────────────────────

/**
 * Group paths by (entry, terminal) pair.
 * Keep longest path per group.
 * Remove strict subset paths.
 */
function deduplicatePaths(allPaths: TracePath[]): TracePath[] {
  // Group by (entry, terminal) key
  const groups = new Map<string, TracePath[]>();
  for (const path of allPaths) {
    const key = `${path.entryId}_${path.terminalId}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(path);
  }

  // Keep longest per group
  const bestPaths: TracePath[] = [];
  for (const paths of groups.values()) {
    paths.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
    bestPaths.push(paths[0]);
  }

  // Remove strict subset paths
  const result: TracePath[] = [];
  for (let i = 0; i < bestPaths.length; i++) {
    const pathI = bestPaths[i];
    let isSubset = false;

    for (let j = 0; j < bestPaths.length; j++) {
      if (i === j) continue;
      const pathJ = bestPaths[j];
      if (pathJ.nodeIds.length <= pathI.nodeIds.length) continue;

      // Check if pathI is a strict subset of pathJ
      const setJ = new Set(pathJ.nodeIds);
      if (pathI.nodeIds.every((id) => setJ.has(id))) {
        isSubset = true;
        break;
      }
    }

    if (!isSubset) {
      result.push(pathI);
    }
  }

  return result;
}

// ─── Main Function ──────────────────────────────────────

export async function detectProcesses(
  graphName: string,
  onProgress?: ProgressCallback,
): Promise<ProcessDetectionResult> {
  const progress = (pct: number, msg: string) => onProgress?.(pct, msg);

  progress(0, "Scoring entry points");

  // Step 1: Score entry points
  let entryPoints: ScoredEntryPoint[];
  try {
    entryPoints = await scoreEntryPoints(graphName);
  } catch (err) {
    logger.warn({ err }, "Failed to score entry points, skipping process detection");
    return { processesCreated: 0, stepEdgesCreated: 0, entryPointsScored: 0 };
  }

  if (entryPoints.length === 0) {
    logger.info("No entry points found, skipping process detection");
    return { processesCreated: 0, stepEdgesCreated: 0, entryPointsScored: 0 };
  }

  progress(20, "Loading CALLS edges for BFS trace");

  // Step 2: Load CALLS edges into an adjacency list
  const callGraph = new Map<number, number[]>();
  try {
    const edgeRows = await cypher<{ src: number; tgt: number }>(
      graphName,
      `MATCH (a)-[:CALLS]->(b) RETURN id(a) AS src, id(b) AS tgt`,
      undefined,
      [{ name: "src" }, { name: "tgt" }],
    );

    for (const row of edgeRows) {
      const src = typeof row.src === "number" ? row.src : Number(row.src);
      const tgt = typeof row.tgt === "number" ? row.tgt : Number(row.tgt);
      let list = callGraph.get(src);
      if (!list) {
        list = [];
        callGraph.set(src, list);
      }
      list.push(tgt);
    }
  } catch {
    logger.warn("No CALLS edges found, skipping process detection");
    return { processesCreated: 0, stepEdgesCreated: 0, entryPointsScored: entryPoints.length };
  }

  progress(35, "Loading community membership");

  // Step 3: Load community map (nodeId → communityId)
  const communityMap = new Map<number, string>();
  try {
    const memberRows = await cypher<{ sid: number; cid: AgeVertex }>(
      graphName,
      `MATCH (s)-[:MEMBER_OF]->(c:Community) RETURN id(s) AS sid, c AS cid`,
      undefined,
      [{ name: "sid" }, { name: "cid" }],
    );
    for (const row of memberRows) {
      const sid = typeof row.sid === "number" ? row.sid : Number(row.sid);
      const communityId =
        typeof row.cid.properties.community_id === "string"
          ? row.cid.properties.community_id
          : "";
      if (communityId) {
        communityMap.set(sid, communityId);
      }
    }
  } catch {
    // Community data may not exist — proceed without it
    logger.debug("No community data available for process type detection");
  }

  progress(45, "Tracing processes via BFS");

  // Step 4: BFS trace from each entry point
  let allPaths: TracePath[] = [];
  for (const ep of entryPoints) {
    const paths = bfsTrace(ep.id, callGraph);
    allPaths.push(...paths);
  }

  progress(60, "Deduplicating paths");

  // Step 5: Deduplicate and filter
  allPaths = deduplicatePaths(allPaths);

  // Filter: minimum step count
  allPaths = allPaths.filter((p) => p.nodeIds.length >= MIN_STEPS);

  // Sort by path length desc, cap at MAX_PROCESSES
  allPaths.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
  allPaths = allPaths.slice(0, MAX_PROCESSES);

  if (allPaths.length === 0) {
    logger.info("No processes met minimum step requirement");
    return { processesCreated: 0, stepEdgesCreated: 0, entryPointsScored: entryPoints.length };
  }

  progress(65, "Loading symbol names for process labeling");

  // Step 6: Load symbol names for labeling
  const symbolNames = new Map<number, string>();
  const symbolRows = await cypher<{ v: AgeVertex }>(
    graphName,
    `MATCH (v) WHERE v.name IS NOT NULL RETURN v`,
    undefined,
    [{ name: "v" }],
  );
  for (const row of symbolRows) {
    const id = typeof row.v.id === "number" ? row.v.id : Number(row.v.id);
    symbolNames.set(id, (row.v.properties.name as string) ?? "");
  }

  progress(70, "Deleting old Process nodes");

  // Step 7: Delete old Process nodes and STEP_IN_PROCESS edges
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    try {
      await cypherWithClient(
        client,
        graphName,
        "MATCH (p:Process) DETACH DELETE p",
        undefined,
        [{ name: "result" }],
      );
    } catch {
      // Process nodes may not exist yet
    }

    progress(75, "Creating Process nodes and STEP_IN_PROCESS edges");

    // Step 8: Create Process nodes and edges
    let processesCreated = 0;
    let stepEdgesCreated = 0;

    for (let i = 0; i < allPaths.length; i++) {
      const path = allPaths[i];
      const entryName = symbolNames.get(path.entryId) ?? "unknown";
      const terminalName =
        symbolNames.get(path.terminalId) ?? "unknown";

      // Determine process_type by counting distinct communities
      const distinctCommunities = new Set<string>();
      for (const nodeId of path.nodeIds) {
        const cid = communityMap.get(nodeId);
        if (cid) distinctCommunities.add(cid);
      }
      const processType =
        distinctCommunities.size > 1 ? "cross_community" : "intra_community";

      const processId = `process_${i}`;
      const label = `${entryName} → ${terminalName}`;

      // Create Process node
      try {
        await cypherWithClient(
          client,
          graphName,
          `CREATE (p:Process {
            process_id: $process_id,
            label: $label,
            heuristic_label: $heuristic_label,
            process_type: $process_type,
            step_count: $step_count,
            entry_point_name: $entry_point_name,
            terminal_name: $terminal_name
          }) RETURN p`,
          {
            process_id: processId,
            label,
            heuristic_label: label,
            process_type: processType,
            step_count: path.nodeIds.length,
            entry_point_name: entryName,
            terminal_name: terminalName,
          },
          [{ name: "p" }],
        );
        processesCreated++;
      } catch (err) {
        logger.warn({ processId, err }, "Failed to create Process node");
        continue;
      }

      // Create STEP_IN_PROCESS edges (1-indexed)
      for (let step = 0; step < path.nodeIds.length; step++) {
        const nodeId = path.nodeIds[step];
        try {
          await cypherWithClient(
            client,
            graphName,
            `MATCH (s), (p:Process {process_id: $process_id})
             WHERE id(s) = ${nodeId}
             CREATE (s)-[:STEP_IN_PROCESS {step: ${step + 1}}]->(p)`,
            { process_id: processId },
            [{ name: "result" }],
          );
          stepEdgesCreated++;
        } catch {
          // May fail for removed/missing symbols — skip
        }
      }

      // Progress update
      if (i % 5 === 0) {
        const pct = 75 + Math.round((i / allPaths.length) * 20);
        progress(pct, `Created ${processesCreated} processes`);
      }
    }

    await client.query("COMMIT");

    progress(100, "Process detection complete");

    logger.info(
      {
        processesCreated,
        stepEdgesCreated,
        entryPointsScored: entryPoints.length,
      },
      "Process detection complete",
    );

    return {
      processesCreated,
      stepEdgesCreated,
      entryPointsScored: entryPoints.length,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
