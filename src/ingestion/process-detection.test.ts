import { describe, it, expect, vi } from "vitest";

// Mock external dependencies
vi.mock("../db/connection.js", () => ({
  pool: {
    connect: vi.fn(),
  },
}));

vi.mock("../db/age.js", () => ({
  cypher: vi.fn(),
  cypherWithClient: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./entry-point-scoring.js", () => ({
  scoreEntryPoints: vi.fn(),
}));

// ─── Reproduce private pure functions for unit testing ───────

const MAX_DEPTH = 10;
const MAX_BRANCHING = 4;

interface TracePath {
  nodeIds: number[];
  entryId: number;
  terminalId: number;
}

function bfsTrace(
  entryId: number,
  callGraph: Map<number, number[]>,
): TracePath[] {
  const paths: TracePath[] = [];
  const queue: number[][] = [[entryId]];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath) break;
    const currentNode = currentPath[currentPath.length - 1];

    const callees = callGraph.get(currentNode) ?? [];

    const validCallees: number[] = [];
    const pathSet = new Set(currentPath);
    for (const callee of callees) {
      if (pathSet.has(callee)) continue;
      validCallees.push(callee);
      if (validCallees.length >= MAX_BRANCHING) break;
    }

    if (validCallees.length === 0 || currentPath.length >= MAX_DEPTH) {
      paths.push({
        nodeIds: currentPath,
        entryId,
        terminalId: currentNode,
      });
    } else {
      for (const callee of validCallees) {
        queue.push([...currentPath, callee]);
      }
    }
  }

  return paths;
}

function deduplicatePaths(allPaths: TracePath[]): TracePath[] {
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

  const bestPaths: TracePath[] = [];
  for (const paths of groups.values()) {
    paths.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
    bestPaths.push(paths[0]);
  }

  const result: TracePath[] = [];
  for (let i = 0; i < bestPaths.length; i++) {
    const pathI = bestPaths[i];
    let isSubset = false;

    for (let j = 0; j < bestPaths.length; j++) {
      if (i === j) continue;
      const pathJ = bestPaths[j];
      if (pathJ.nodeIds.length <= pathI.nodeIds.length) continue;

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

// ═══════════════════════════════════════════════════════════════

describe("bfsTrace", () => {
  it("returns single-node path for a node with no callees", () => {
    const graph = new Map<number, number[]>();
    const paths = bfsTrace(1, graph);
    expect(paths).toHaveLength(1);
    expect(paths[0].nodeIds).toEqual([1]);
    expect(paths[0].entryId).toBe(1);
    expect(paths[0].terminalId).toBe(1);
  });

  it("traces a linear call chain", () => {
    const graph = new Map<number, number[]>([
      [1, [2]],
      [2, [3]],
      [3, [4]],
    ]);
    const paths = bfsTrace(1, graph);
    expect(paths).toHaveLength(1);
    expect(paths[0].nodeIds).toEqual([1, 2, 3, 4]);
    expect(paths[0].terminalId).toBe(4);
  });

  it("handles branching (multiple callees)", () => {
    const graph = new Map<number, number[]>([
      [1, [2, 3]],
    ]);
    const paths = bfsTrace(1, graph);
    expect(paths).toHaveLength(2);
    expect(paths.map(p => p.terminalId).sort()).toEqual([2, 3]);
  });

  it("detects and avoids cycles", () => {
    const graph = new Map<number, number[]>([
      [1, [2]],
      [2, [3]],
      [3, [1]], // cycle back to 1
    ]);
    const paths = bfsTrace(1, graph);
    expect(paths).toHaveLength(1);
    expect(paths[0].nodeIds).toEqual([1, 2, 3]);
    // Should NOT contain 1 again
    expect(paths[0].nodeIds.filter(n => n === 1)).toHaveLength(1);
  });

  it("limits branching to MAX_BRANCHING (4)", () => {
    const graph = new Map<number, number[]>([
      [1, [2, 3, 4, 5, 6, 7, 8]],
    ]);
    const paths = bfsTrace(1, graph);
    // Should only explore first 4 callees
    expect(paths.length).toBeLessThanOrEqual(4);
  });

  it("respects MAX_DEPTH", () => {
    // Build a chain of depth > 10
    const graph = new Map<number, number[]>();
    for (let i = 1; i <= 15; i++) {
      graph.set(i, [i + 1]);
    }
    const paths = bfsTrace(1, graph);
    expect(paths).toHaveLength(1);
    // Path should be capped at MAX_DEPTH (10) nodes
    expect(paths[0].nodeIds.length).toBeLessThanOrEqual(MAX_DEPTH);
  });
});

describe("deduplicatePaths", () => {
  it("keeps longest path per (entry, terminal) group", () => {
    const paths: TracePath[] = [
      { nodeIds: [1, 2, 3], entryId: 1, terminalId: 3 },
      { nodeIds: [1, 3], entryId: 1, terminalId: 3 },
    ];
    const result = deduplicatePaths(paths);
    expect(result).toHaveLength(1);
    expect(result[0].nodeIds).toEqual([1, 2, 3]);
  });

  it("removes strict subset paths", () => {
    const paths: TracePath[] = [
      { nodeIds: [1, 2], entryId: 1, terminalId: 2 },
      { nodeIds: [1, 2, 3, 4], entryId: 1, terminalId: 4 },
    ];
    const result = deduplicatePaths(paths);
    // [1,2] is a subset of [1,2,3,4], so it should be removed
    expect(result).toHaveLength(1);
    expect(result[0].terminalId).toBe(4);
  });

  it("keeps non-overlapping paths", () => {
    const paths: TracePath[] = [
      { nodeIds: [1, 2, 3], entryId: 1, terminalId: 3 },
      { nodeIds: [4, 5, 6], entryId: 4, terminalId: 6 },
    ];
    const result = deduplicatePaths(paths);
    expect(result).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(deduplicatePaths([])).toEqual([]);
  });
});
