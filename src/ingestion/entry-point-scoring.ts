/**
 * Entry-point scoring for process detection.
 * Scores symbols based on call ratio, export status, name patterns, and framework multipliers.
 */

import { cypher } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import { getFrameworkMultiplier, isTestFile } from "./framework-detection.js";

const logger = createChildLogger("entry-point-scoring");

// ─── Types ──────────────────────────────────────────────

export interface ScoredEntryPoint {
  id: number;
  name: string;
  filePath: string;
  label: string;
  exported: boolean;
  outgoingCalls: number;
  incomingCalls: number;
  baseScore: number;
  exportMultiplier: number;
  nameMultiplier: number;
  frameworkMultiplier: number;
  finalScore: number;
}

// ─── Name Multiplier Patterns ───────────────────────────

interface NamePattern {
  pattern: RegExp;
  multiplier: number;
}

const NAME_PATTERNS: NamePattern[] = [
  // handle/on/Controller/Service/Handler → 2.0
  { pattern: /^handle/i, multiplier: 2.0 },
  { pattern: /^on[A-Z]/i, multiplier: 2.0 },
  { pattern: /Controller$/i, multiplier: 2.0 },
  { pattern: /Service$/i, multiplier: 2.0 },
  { pattern: /Handler$/i, multiplier: 2.0 },

  // process/execute/run/start/init → 1.8
  { pattern: /^process/i, multiplier: 1.8 },
  { pattern: /^execute/i, multiplier: 1.8 },
  { pattern: /^run/i, multiplier: 1.8 },
  { pattern: /^start/i, multiplier: 1.8 },
  { pattern: /^init/i, multiplier: 1.8 },

  // create/build/setup → 1.3
  { pattern: /^create/i, multiplier: 1.3 },
  { pattern: /^build/i, multiplier: 1.3 },
  { pattern: /^setup/i, multiplier: 1.3 },

  // get/set/is/has → 0.8
  { pattern: /^get[A-Z]/i, multiplier: 0.8 },
  { pattern: /^set[A-Z]/i, multiplier: 0.8 },
  { pattern: /^is[A-Z]/i, multiplier: 0.8 },
  { pattern: /^has[A-Z]/i, multiplier: 0.8 },

  // Helper/Util → 0.5
  { pattern: /Helper$/i, multiplier: 0.5 },
  { pattern: /Util$/i, multiplier: 0.5 },
  { pattern: /Utils$/i, multiplier: 0.5 },
];

function getNameMultiplier(name: string): number {
  for (const { pattern, multiplier } of NAME_PATTERNS) {
    if (pattern.test(name)) {
      return multiplier;
    }
  }
  return 1.0;
}

// ─── Main Function ──────────────────────────────────────

/**
 * Score all candidate entry points in the graph.
 * Returns the top 200 scored entry points.
 */
export async function scoreEntryPoints(
  graphName: string,
): Promise<ScoredEntryPoint[]> {
  // Step 1: Get all symbols with their call counts
  // Using separate queries for outgoing and incoming to avoid AGE query complexity issues
  const symbolRows = await cypher<{ v: AgeVertex; file_path: unknown }>(
    graphName,
    `MATCH (f:File)-[:DEFINES]->(v) WHERE v.name IS NOT NULL RETURN v, f.path AS file_path`,
    undefined,
    [{ name: "v" }, { name: "file_path" }],
  );

  // Step 2: Count outgoing CALLS per symbol
  const outgoingRows = await cypher<{ src: number; cnt: number }>(
    graphName,
    `MATCH (a)-[:CALLS]->(b) RETURN id(a) AS src, count(b) AS cnt`,
    undefined,
    [{ name: "src" }, { name: "cnt" }],
  );
  const outgoingMap = new Map<number, number>();
  for (const row of outgoingRows) {
    const id = typeof row.src === "number" ? row.src : Number(row.src);
    const cnt = typeof row.cnt === "number" ? row.cnt : Number(row.cnt);
    outgoingMap.set(id, cnt);
  }

  // Step 3: Count incoming CALLS per symbol
  const incomingRows = await cypher<{ tgt: number; cnt: number }>(
    graphName,
    `MATCH (a)-[:CALLS]->(b) RETURN id(b) AS tgt, count(a) AS cnt`,
    undefined,
    [{ name: "tgt" }, { name: "cnt" }],
  );
  const incomingMap = new Map<number, number>();
  for (const row of incomingRows) {
    const id = typeof row.tgt === "number" ? row.tgt : Number(row.tgt);
    const cnt = typeof row.cnt === "number" ? row.cnt : Number(row.cnt);
    incomingMap.set(id, cnt);
  }

  // Step 4: Score each symbol
  const scored: ScoredEntryPoint[] = [];

  for (const row of symbolRows) {
    const id = typeof row.v.id === "number" ? row.v.id : Number(row.v.id);
    const name = (row.v.properties.name as string) ?? "";
    const filePath = typeof row.file_path === "string" ? row.file_path : "";
    const exported = row.v.properties.exported === true;
    const label = row.v.label;

    // Exclude test files
    if (isTestFile(filePath)) continue;

    // Exclude non-callable types (File, Folder, Community, etc.)
    if (
      label === "File" ||
      label === "Folder" ||
      label === "Community" ||
      label === "Process"
    ) {
      continue;
    }

    const outgoingCalls = outgoingMap.get(id) ?? 0;
    const incomingCalls = incomingMap.get(id) ?? 0;

    // Exclude leaf nodes (0 outgoing calls)
    if (outgoingCalls === 0) continue;

    // Calculate scores
    const baseScore = outgoingCalls / (incomingCalls + 1);
    const exportMultiplier = exported ? 1.5 : 1.0;
    const nameMultiplier = getNameMultiplier(name);
    const frameworkMultiplier = getFrameworkMultiplier(filePath);
    const finalScore =
      baseScore * exportMultiplier * nameMultiplier * frameworkMultiplier;

    scored.push({
      id,
      name,
      filePath,
      label,
      exported,
      outgoingCalls,
      incomingCalls,
      baseScore: Math.round(baseScore * 100) / 100,
      exportMultiplier,
      nameMultiplier,
      frameworkMultiplier,
      finalScore: Math.round(finalScore * 100) / 100,
    });
  }

  // Step 5: Sort by finalScore desc, take top 200
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const top = scored.slice(0, 200);

  logger.info(
    { totalCandidates: scored.length, selected: top.length },
    "Entry points scored",
  );

  return top;
}
