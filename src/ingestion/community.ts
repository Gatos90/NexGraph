import { UndirectedGraph } from "graphology";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pool } from "../db/connection.js";
import { cypher, cypherWithClient } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import type { ProgressCallback } from "./extract.js";

// ─── Leiden Algorithm (vendored) ────────────────────────────
// The Leiden algorithm source is vendored from graphology's repo
// (src/communities-leiden) because it was never published to npm.
// We use createRequire to load the CommonJS vendored files in ESM context.
// Reference: Traag et al. "From Louvain to Leiden: Guaranteeing
// Well-Connected Communities" (Scientific Reports, 2019)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const leidenPath = resolve(__dirname, "..", "..", "vendor", "leiden", "index.cjs");
const _require = createRequire(import.meta.url);

interface DetailedLeidenOutput {
  communities: Record<string, number>;
  count: number;
  deltaComputations: number;
  dendrogram: unknown[];
  modularity: number;
  moves: number[][] | number[];
  nodesVisited: number;
  resolution: number;
}

const leiden = _require(leidenPath) as {
  detailed: (
    graph: UndirectedGraph,
    options?: { resolution?: number },
  ) => DetailedLeidenOutput;
};

const logger = createChildLogger("community");

// ─── Types ──────────────────────────────────────────────────

export interface CommunityDetectionResult {
  communitiesCreated: number;
  memberEdgesCreated: number;
  totalSymbols: number;
}

interface SymbolNode {
  id: number;
  name: string;
  filePath: string;
  label: string;
}

// ─── Constants ──────────────────────────────────────────────

/** Folders that are too generic to use as community labels */
const SKIP_FOLDERS = new Set([
  "src", "lib", "core", "utils", "common", "shared", "helpers",
  ".", "", "dist", "build", "node_modules", "vendor", "pkg",
]);

/** Words too generic to use as keywords */
const SKIP_WORDS = new Set([
  "get", "set", "is", "has", "do", "on", "the", "a", "an",
  "to", "of", "in", "for", "new", "from", "with", "by",
  "id", "fn", "cb", "err", "res", "req", "ctx", "db",
]);

const TIMEOUT_MS = 60_000;

// ─── Helpers ────────────────────────────────────────────────

/**
 * Split camelCase/PascalCase/snake_case names into individual words.
 */
function splitName(name: string): string[] {
  // First split on underscores/hyphens/dots
  const parts = name.split(/[_\-./]+/);
  const words: string[] = [];
  for (const part of parts) {
    // Split camelCase: insert boundary before uppercase after lowercase
    const camelParts = part.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
    for (const w of camelParts) {
      const lower = w.toLowerCase();
      if (lower.length >= 2 && !SKIP_WORDS.has(lower)) {
        words.push(lower);
      }
    }
  }
  return words;
}

/**
 * Compute top N keywords from member names.
 */
function computeKeywords(members: SymbolNode[], topN: number = 5): string[] {
  const freq = new Map<string, number>();
  for (const m of members) {
    const words = splitName(m.name);
    const unique = new Set(words); // count each word once per member
    for (const w of unique) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

/**
 * Compute a heuristic label for a community based on member file paths.
 */
function computeHeuristicLabel(
  members: SymbolNode[],
  communityIndex: number,
): string {
  // Strategy 1: Most frequent meaningful parent folder
  const folderFreq = new Map<string, number>();
  for (const m of members) {
    const parts = m.filePath.split("/");
    // Walk from leaf to root, find first meaningful folder
    for (let i = parts.length - 2; i >= 0; i--) {
      const folder = parts[i];
      if (!SKIP_FOLDERS.has(folder) && folder.length > 0) {
        folderFreq.set(folder, (folderFreq.get(folder) ?? 0) + 1);
        break;
      }
    }
  }

  if (folderFreq.size > 0) {
    const sorted = [...folderFreq.entries()].sort((a, b) => b[1] - a[1]);
    const topFolder = sorted[0][0];
    // Only use if it covers a meaningful proportion of members
    if (sorted[0][1] >= Math.max(2, members.length * 0.3)) {
      return topFolder;
    }
  }

  // Strategy 2: Longest common path prefix (at least 3 chars)
  if (members.length > 0) {
    const paths = members.map((m) => m.filePath);
    let prefix = paths[0];
    for (let i = 1; i < paths.length; i++) {
      while (!paths[i].startsWith(prefix)) {
        prefix = prefix.substring(0, prefix.lastIndexOf("/"));
        if (prefix.length < 3) break;
      }
      if (prefix.length < 3) break;
    }
    // Clean up: remove trailing slash, take last segment
    if (prefix.length >= 3) {
      const lastSegment = prefix.split("/").filter((s) => s.length > 0).pop();
      if (lastSegment && !SKIP_FOLDERS.has(lastSegment)) {
        return lastSegment;
      }
    }
  }

  // Strategy 3: Fallback
  return `Cluster_${communityIndex}`;
}

/**
 * Compute cohesion score for a community.
 * Sample up to 50 members; cohesion = internal_edges / total_edges
 */
function computeCohesion(
  communityMembers: Set<string>,
  graph: UndirectedGraph,
  sampleSize: number = 50,
): number {
  const memberArr = [...communityMembers];
  const sample =
    memberArr.length <= sampleSize
      ? memberArr
      : memberArr.sort(() => Math.random() - 0.5).slice(0, sampleSize);

  let internalEdges = 0;
  let totalEdges = 0;

  for (const nodeId of sample) {
    if (!graph.hasNode(nodeId)) continue;
    graph.forEachEdge(nodeId, (_edge: string, _attrs: Record<string, unknown>, source: string, target: string) => {
      totalEdges++;
      if (communityMembers.has(source) && communityMembers.has(target)) {
        internalEdges++;
      }
    });
  }

  if (totalEdges === 0) return 0;
  return Math.min(1, Math.max(0, internalEdges / totalEdges));
}

// ─── Main Function ──────────────────────────────────────────

export async function detectCommunities(
  graphName: string,
  onProgress?: ProgressCallback,
): Promise<CommunityDetectionResult> {
  const progress = (pct: number, msg: string) => onProgress?.(pct, msg);

  progress(0, "Loading CALLS edges from graph");

  // Step 1: Load all CALLS edges with confidence >= 0.5
  let callEdges: Array<{ source: number; target: number }>;
  try {
    const rows = await cypher<{ src: number; tgt: number }>(
      graphName,
      `MATCH (a)-[e:CALLS]->(b)
       WHERE e.confidence >= 0.5
       RETURN id(a) AS src, id(b) AS tgt`,
      undefined,
      [{ name: "src" }, { name: "tgt" }],
    );
    callEdges = rows.map((r) => ({
      source: typeof r.src === "number" ? r.src : Number(r.src),
      target: typeof r.tgt === "number" ? r.tgt : Number(r.tgt),
    }));
  } catch {
    logger.warn("No CALLS edges found in graph, skipping community detection");
    return { communitiesCreated: 0, memberEdgesCreated: 0, totalSymbols: 0 };
  }

  if (callEdges.length === 0) {
    logger.info("No CALLS edges with confidence >= 0.5, skipping");
    return { communitiesCreated: 0, memberEdgesCreated: 0, totalSymbols: 0 };
  }

  progress(10, "Loading symbol nodes");

  // Step 2: Load all symbol node metadata
  const symbolRows = await cypher<{ v: AgeVertex; file_path: unknown }>(
    graphName,
    `MATCH (f:File)-[:DEFINES]->(v) WHERE v.name IS NOT NULL RETURN v, f.path AS file_path`,
    undefined,
    [{ name: "v" }, { name: "file_path" }],
  );

  const symbolMap = new Map<number, SymbolNode>();
  for (const row of symbolRows) {
    const id =
      typeof row.v.id === "number" ? row.v.id : Number(row.v.id);
    symbolMap.set(id, {
      id,
      name: (row.v.properties.name as string) ?? "",
      filePath: typeof row.file_path === "string" ? row.file_path : "",
      label: row.v.label,
    });
  }

  progress(20, "Building graphology graph");

  // Step 3: Build undirected graphology Graph
  const g = new UndirectedGraph();
  const nodeIds = new Set<string>();

  for (const edge of callEdges) {
    // Skip self-loops
    if (edge.source === edge.target) continue;

    const srcStr = String(edge.source);
    const tgtStr = String(edge.target);

    if (!nodeIds.has(srcStr)) {
      g.addNode(srcStr);
      nodeIds.add(srcStr);
    }
    if (!nodeIds.has(tgtStr)) {
      g.addNode(tgtStr);
      nodeIds.add(tgtStr);
    }

    // Only add edge if not already present (undirected)
    if (!g.hasEdge(srcStr, tgtStr)) {
      g.addEdge(srcStr, tgtStr);
    }
  }

  const totalNodes = g.order;
  logger.info({ nodes: totalNodes, edges: g.size }, "Built graphology graph");

  // Filter low-degree nodes for large graphs.
  // Degree-0 nodes are isolated; degree-1 nodes just get absorbed into their
  // single neighbor's community but cost iteration time.
  if (totalNodes > 10_000) {
    const toRemove: string[] = [];
    g.forEachNode((node: string) => {
      if (g.degree(node) <= 1) toRemove.push(node);
    });
    for (const node of toRemove) {
      g.dropNode(node);
    }
    logger.info(
      { removed: toRemove.length, remaining: g.order },
      "Removed degree-0/1 nodes from large graph",
    );
  }

  progress(30, "Running Leiden community detection");

  // Step 4: Run Leiden with resolution tuning
  const resolution = totalNodes > 10_000 ? 2.0 : 1.0;

  let communities: Record<string, number>;
  let communityCount: number;

  try {
    const result = await Promise.race([
      new Promise<DetailedLeidenOutput>((resolve) => {
        const detailed = leiden.detailed(g, { resolution });
        resolve(detailed);
      }),
      new Promise<DetailedLeidenOutput>((_, reject) =>
        setTimeout(
          () => reject(new Error("Community detection timeout")),
          TIMEOUT_MS,
        ),
      ),
    ]);

    communities = result.communities;
    communityCount = result.count;
    logger.info(
      {
        communities: communityCount,
        resolution,
        modularity: result.modularity,
      },
      "Leiden community detection complete",
    );
  } catch (err) {
    logger.warn({ err }, "Community detection timed out, using single community fallback");
    communities = {};
    g.forEachNode((node: string) => {
      communities[node] = 0;
    });
    communityCount = 1;
  }

  progress(50, "Processing community results");

  // Step 5: Group members by community, filter >= 2 members
  const communityGroups = new Map<number, SymbolNode[]>();
  for (const [nodeIdStr, communityId] of Object.entries(communities)) {
    const nodeId = Number(nodeIdStr);
    const symbol = symbolMap.get(nodeId);
    if (!symbol) continue;

    let group = communityGroups.get(communityId);
    if (!group) {
      group = [];
      communityGroups.set(communityId, group);
    }
    group.push(symbol);
  }

  // Filter out communities with < 2 members
  const validCommunities: Array<{
    id: number;
    members: SymbolNode[];
  }> = [];
  for (const [id, members] of communityGroups) {
    if (members.length >= 2) {
      validCommunities.push({ id, members });
    }
  }

  logger.info(
    {
      total: communityGroups.size,
      valid: validCommunities.length,
    },
    "Filtered communities (>= 2 members)",
  );

  progress(60, "Deleting old Community nodes");

  // Step 6: Delete old Community nodes and MEMBER_OF edges
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    try {
      await cypherWithClient(
        client,
        graphName,
        "MATCH (c:Community) DETACH DELETE c",
        undefined,
        [{ name: "result" }],
      );
    } catch {
      // Community nodes may not exist yet
    }

    progress(65, "Creating Community nodes and MEMBER_OF edges");

    // Step 7: Create Community nodes and MEMBER_OF edges
    let communitiesCreated = 0;
    let memberEdgesCreated = 0;

    for (let i = 0; i < validCommunities.length; i++) {
      const { id: communityId, members } = validCommunities[i];

      // Compute community metadata
      const memberIdSet = new Set(members.map((m) => String(m.id)));
      const heuristicLabel = computeHeuristicLabel(members, communityId);
      const cohesion = computeCohesion(memberIdSet, g);
      const keywords = computeKeywords(members);

      // Create Community node
      const communityNodeId = `community_${communityId}`;
      try {
        await cypherWithClient(
          client,
          graphName,
          `CREATE (c:Community {
            community_id: $community_id,
            label: $label,
            heuristic_label: $heuristic_label,
            cohesion: $cohesion,
            symbol_count: $symbol_count,
            keywords: $keywords
          }) RETURN c`,
          {
            community_id: communityNodeId,
            label: heuristicLabel,
            heuristic_label: heuristicLabel,
            cohesion: Math.round(cohesion * 100) / 100,
            symbol_count: members.length,
            keywords: keywords.join(","),
          },
          [{ name: "c" }],
        );
        communitiesCreated++;
      } catch (err) {
        logger.warn(
          { communityId: communityNodeId, err },
          "Failed to create Community node",
        );
        continue;
      }

      // Create MEMBER_OF edges from each member to the community
      for (const member of members) {
        try {
          await cypherWithClient(
            client,
            graphName,
            `MATCH (s), (c:Community {community_id: $community_id})
             WHERE id(s) = ${member.id}
             CREATE (s)-[:MEMBER_OF]->(c)`,
            { community_id: communityNodeId },
            [{ name: "result" }],
          );
          memberEdgesCreated++;
        } catch {
          // May fail for removed/missing symbols — skip silently
        }
      }

      // Progress update every 10 communities
      if (i % 10 === 0) {
        const pct = 65 + Math.round((i / validCommunities.length) * 30);
        progress(pct, `Created ${communitiesCreated} communities`);
      }
    }

    await client.query("COMMIT");

    progress(100, "Community detection complete");

    logger.info(
      {
        communitiesCreated,
        memberEdgesCreated,
        totalSymbols: symbolMap.size,
      },
      "Community detection complete",
    );

    return {
      communitiesCreated,
      memberEdgesCreated,
      totalSymbols: symbolMap.size,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
