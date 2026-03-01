import { describe, it, expect, vi } from "vitest";

// Mock external dependencies
const mockQuery = vi.hoisted(() => vi.fn());
const mockCypher = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  pool: { query: mockQuery },
}));

vi.mock("../db/age.js", () => ({
  cypher: mockCypher,
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ─── Import module-private pure functions by re-implementing them ───
// parseDiffOutput, mergeLineRanges, assessRisk are not exported,
// so we test them through the exported analyzeChanges or reproduce them.

// Since parseDiffOutput, mergeLineRanges, assessRisk are private,
// we reproduce them for unit testing and test analyzeChanges for integration.

// ─── parseDiffOutput reproduction ───────────────────────────

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface ChangedFileInfo {
  filePath: string;
  addedLines: number[];
  removedLines: number[];
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    header: string;
  }>;
  additions: number;
  deletions: number;
}

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
      currentNewLine++;
      currentOldLine++;
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

// ─── mergeLineRanges reproduction ────────────────────────────

interface LineRange {
  start: number;
  end: number;
}

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

// ─── assessRisk reproduction ─────────────────────────────────

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

function assessRisk(totalImpact: number, processCount: number): RiskLevel {
  if (totalImpact > 20 || processCount > 3) return "CRITICAL";
  if (totalImpact > 10 || processCount > 1) return "HIGH";
  if (totalImpact > 3) return "MEDIUM";
  return "LOW";
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("parseDiffOutput", () => {
  it("returns empty array for empty string", () => {
    expect(parseDiffOutput("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseDiffOutput("   \n\n  ")).toEqual([]);
  });

  it("parses a single-file diff with one hunk", () => {
    const diff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -10,2 +10,3 @@",
      "-old line",
      "+new line 1",
      "+new line 2",
    ].join("\n");

    const result = parseDiffOutput(diff);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/index.ts");
    expect(result[0].additions).toBe(2);
    expect(result[0].deletions).toBe(1);
    expect(result[0].addedLines).toEqual([10, 11]);
    expect(result[0].removedLines).toEqual([10]);
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0].oldStart).toBe(10);
    expect(result[0].hunks[0].newStart).toBe(10);
  });

  it("parses a multi-file diff", () => {
    const diff = [
      "diff --git a/file1.ts b/file1.ts",
      "--- a/file1.ts",
      "+++ b/file1.ts",
      "@@ -5 +5 @@",
      "-old",
      "+new",
      "diff --git a/file2.ts b/file2.ts",
      "--- a/file2.ts",
      "+++ b/file2.ts",
      "@@ -1 +1 @@",
      "+added",
    ].join("\n");

    const result = parseDiffOutput(diff);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe("file1.ts");
    expect(result[1].filePath).toBe("file2.ts");
  });

  it("parses hunk header without count (single-line change)", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "@@ -5 +5 @@",
      "-removed",
      "+added",
    ].join("\n");

    const result = parseDiffOutput(diff);
    expect(result[0].hunks[0].oldCount).toBe(1);
    expect(result[0].hunks[0].newCount).toBe(1);
  });

  it("parses multiple hunks in one file", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "@@ -5,3 +5,3 @@",
      "-a",
      "+b",
      "@@ -20,1 +20,2 @@",
      "+new line",
    ].join("\n");

    const result = parseDiffOutput(diff);
    expect(result[0].hunks).toHaveLength(2);
    expect(result[0].hunks[0].oldStart).toBe(5);
    expect(result[0].hunks[1].oldStart).toBe(20);
  });

  it("handles renamed files (a/ and b/ differ)", () => {
    const diff = [
      "diff --git a/old-name.ts b/new-name.ts",
      "@@ -1 +1 @@",
      "+line",
    ].join("\n");

    const result = parseDiffOutput(diff);
    expect(result[0].filePath).toBe("new-name.ts");
  });

  it("skips lines before first diff header", () => {
    const diff = [
      "some random git output",
      "diff --git a/f.ts b/f.ts",
      "@@ -1 +1 @@",
      "+hello",
    ].join("\n");

    const result = parseDiffOutput(diff);
    expect(result).toHaveLength(1);
    expect(result[0].additions).toBe(1);
  });
});

describe("mergeLineRanges", () => {
  it("returns empty for empty input", () => {
    expect(mergeLineRanges([])).toEqual([]);
  });

  it("returns single range for single line", () => {
    expect(mergeLineRanges([5])).toEqual([{ start: 5, end: 5 }]);
  });

  it("merges adjacent lines within proximity", () => {
    expect(mergeLineRanges([1, 2, 3])).toEqual([{ start: 1, end: 3 }]);
  });

  it("merges lines within proximity gap (default 3)", () => {
    // 1, 4 → gap of 3, within default proximity
    expect(mergeLineRanges([1, 4])).toEqual([{ start: 1, end: 4 }]);
  });

  it("splits lines beyond proximity gap", () => {
    // 1, 5 → gap of 4, beyond default proximity of 3
    expect(mergeLineRanges([1, 5])).toEqual([
      { start: 1, end: 1 },
      { start: 5, end: 5 },
    ]);
  });

  it("handles unsorted input", () => {
    expect(mergeLineRanges([10, 2, 5, 3])).toEqual([
      { start: 2, end: 5 },
      { start: 10, end: 10 },
    ]);
  });

  it("respects custom proximity", () => {
    expect(mergeLineRanges([1, 10], 10)).toEqual([{ start: 1, end: 10 }]);
    expect(mergeLineRanges([1, 10], 5)).toEqual([
      { start: 1, end: 1 },
      { start: 10, end: 10 },
    ]);
  });

  it("handles multiple ranges with gaps", () => {
    expect(mergeLineRanges([1, 2, 3, 20, 21, 22, 50])).toEqual([
      { start: 1, end: 3 },
      { start: 20, end: 22 },
      { start: 50, end: 50 },
    ]);
  });
});

describe("assessRisk", () => {
  it("returns LOW for <= 3 impact and 0 processes", () => {
    expect(assessRisk(0, 0)).toBe("LOW");
    expect(assessRisk(1, 0)).toBe("LOW");
    expect(assessRisk(3, 0)).toBe("LOW");
  });

  it("returns MEDIUM for 4-10 impact and <= 1 process", () => {
    expect(assessRisk(4, 0)).toBe("MEDIUM");
    expect(assessRisk(10, 0)).toBe("MEDIUM");
    expect(assessRisk(4, 1)).toBe("MEDIUM");
  });

  it("returns HIGH for 11-20 impact or 2-3 processes", () => {
    expect(assessRisk(11, 0)).toBe("HIGH");
    expect(assessRisk(20, 0)).toBe("HIGH");
    expect(assessRisk(1, 2)).toBe("HIGH");
    expect(assessRisk(1, 3)).toBe("HIGH");
  });

  it("returns CRITICAL for > 20 impact or > 3 processes", () => {
    expect(assessRisk(21, 0)).toBe("CRITICAL");
    expect(assessRisk(100, 0)).toBe("CRITICAL");
    expect(assessRisk(0, 4)).toBe("CRITICAL");
    expect(assessRisk(0, 10)).toBe("CRITICAL");
  });

  it("takes the higher risk when both thresholds trigger", () => {
    // totalImpact > 20 → CRITICAL, processCount > 3 → CRITICAL
    expect(assessRisk(25, 5)).toBe("CRITICAL");
  });
});

// ─── Integration test for analyzeChanges ─────────────────────

import { analyzeChanges } from "./diff-impact.js";

describe("analyzeChanges", () => {
  it("returns empty result when repo is not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      analyzeChanges("repo-1", "graph_test"),
    ).rejects.toThrow("not found");
  });

  it("returns empty result when source type is not local_path", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "repo-1", url: "https://github.com/x/y", source_type: "git_url", graph_name: "graph_test" }],
    });
    await expect(
      analyzeChanges("repo-1", "graph_test"),
    ).rejects.toThrow("UNSUPPORTED_SOURCE_TYPE");
  });
});
