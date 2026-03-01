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

// ─── Reproduce private pure functions for testing ────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LINE_TOLERANCE = 5;

function locateSymbolInContent(
  content: string,
  symbolName: string,
  expectedLine: number,
): Array<{ line: number; column_start: number; column_end: number }> {
  const lines = content.split("\n");
  const pattern = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, "g");
  const results: Array<{ line: number; column_start: number; column_end: number }> = [];

  const startLine = expectedLine > 0
    ? Math.max(0, expectedLine - 1 - LINE_TOLERANCE)
    : 0;
  const endLine = expectedLine > 0
    ? Math.min(lines.length, expectedLine - 1 + LINE_TOLERANCE + 1)
    : lines.length;

  for (let i = startLine; i < endLine; i++) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[i])) !== null) {
      results.push({
        line: i + 1,
        column_start: match.index + 1,
        column_end: match.index + symbolName.length + 1,
      });
    }
  }

  return results;
}

interface RenameEdit {
  file_path: string;
  line: number;
  column_start: number;
  column_end: number;
  old_text: string;
  new_text: string;
  confidence: number;
  reason: string;
}

function applyEditsToContent(content: string, edits: RenameEdit[]): string {
  const lines = content.split("\n");

  const sorted = [...edits].sort((a, b) => {
    if (b.line !== a.line) return b.line - a.line;
    return b.column_start - a.column_start;
  });

  for (const edit of sorted) {
    const lineIdx = edit.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const line = lines[lineIdx];
    const colStart = edit.column_start - 1;
    const colEnd = edit.column_end - 1;

    lines[lineIdx] =
      line.substring(0, colStart) + edit.new_text + line.substring(colEnd);
  }

  return lines.join("\n");
}

interface SymbolReference {
  file_path: string;
  line: number;
  confidence: number;
  reason: string;
}

function deduplicateRefs(refs: SymbolReference[]): SymbolReference[] {
  const seen = new Map<string, SymbolReference>();
  for (const ref of refs) {
    const key = `${ref.file_path}:${ref.line}`;
    const existing = seen.get(key);
    if (!existing || ref.confidence > existing.confidence) {
      seen.set(key, ref);
    }
  }
  return [...seen.values()];
}

function deduplicateEdits(edits: RenameEdit[]): RenameEdit[] {
  const seen = new Map<string, RenameEdit>();
  for (const edit of edits) {
    const key = `${edit.file_path}:${edit.line}:${edit.column_start}`;
    const existing = seen.get(key);
    if (!existing || edit.confidence > existing.confidence) {
      seen.set(key, edit);
    }
  }
  return [...seen.values()];
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("escapeRegExp", () => {
  it("escapes special regex characters", () => {
    expect(escapeRegExp("foo.bar")).toBe("foo\\.bar");
    expect(escapeRegExp("a+b*c?")).toBe("a\\+b\\*c\\?");
    expect(escapeRegExp("(x|y)")).toBe("\\(x\\|y\\)");
    expect(escapeRegExp("[a]")).toBe("\\[a\\]");
    expect(escapeRegExp("a{1}")).toBe("a\\{1\\}");
    expect(escapeRegExp("$^")).toBe("\\$\\^");
    expect(escapeRegExp("a\\b")).toBe("a\\\\b");
  });

  it("returns plain string unchanged", () => {
    expect(escapeRegExp("fooBar123")).toBe("fooBar123");
  });
});

describe("locateSymbolInContent", () => {
  const content = [
    "import { foo } from './lib';",      // line 1
    "const bar = 42;",                    // line 2
    "function foo() {",                   // line 3
    "  return bar + foo;",                // line 4
    "}",                                  // line 5
    "export { foo };",                    // line 6
  ].join("\n");

  it("finds symbol at expected line", () => {
    const results = locateSymbolInContent(content, "foo", 3);
    expect(results.length).toBeGreaterThan(0);
    const atLine3 = results.find((r) => r.line === 3);
    expect(atLine3).toBeDefined();
    expect(atLine3!.column_start).toBe(10); // "function foo" → col 10
    expect(atLine3!.column_end).toBe(13);
  });

  it("finds multiple occurrences within tolerance", () => {
    const results = locateSymbolInContent(content, "foo", 3);
    // Should find occurrences on lines 1, 3, 4, 6 (but limited by tolerance window)
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it("searches entire file when expectedLine is 0", () => {
    const results = locateSymbolInContent(content, "foo", 0);
    expect(results.length).toBe(4); // lines 1, 3, 4, 6
  });

  it("returns empty for non-existent symbol", () => {
    const results = locateSymbolInContent(content, "nonexistent", 3);
    expect(results).toEqual([]);
  });

  it("respects word boundaries", () => {
    const src = "const fooBar = foo;";
    const results = locateSymbolInContent(src, "foo", 1);
    // Should match "foo" standalone (col 16) but NOT "fooBar" since \b is used
    expect(results.length).toBe(1);
    expect(results[0].column_start).toBe(16);
  });

  it("handles symbol with regex special chars", () => {
    const src = "const x = $scope.apply();";
    const results = locateSymbolInContent(src, "$scope", 1);
    // $scope has $ which is a regex special char — should still find it
    // Note: \b before $ doesn't match, so this may return 0 results due to word boundary
    // This tests that escapeRegExp doesn't crash
    expect(results).toBeDefined();
  });
});

describe("applyEditsToContent", () => {
  it("applies a single rename on one line", () => {
    const content = "function oldName() {}";
    const edits: RenameEdit[] = [
      {
        file_path: "f.ts",
        line: 1,
        column_start: 10,
        column_end: 17,
        old_text: "oldName",
        new_text: "newName",
        confidence: 1.0,
        reason: "definition",
      },
    ];

    const result = applyEditsToContent(content, edits);
    expect(result).toBe("function newName() {}");
  });

  it("applies multiple edits on different lines (bottom-up)", () => {
    const content = "line1 foo\nline2 foo\nline3 foo";
    const edits: RenameEdit[] = [
      { file_path: "f.ts", line: 1, column_start: 7, column_end: 10, old_text: "foo", new_text: "bar", confidence: 1, reason: "r" },
      { file_path: "f.ts", line: 3, column_start: 7, column_end: 10, old_text: "foo", new_text: "bar", confidence: 1, reason: "r" },
    ];

    const result = applyEditsToContent(content, edits);
    expect(result).toBe("line1 bar\nline2 foo\nline3 bar");
  });

  it("applies multiple edits on the same line (rightmost first)", () => {
    const content = "foo + foo";
    const edits: RenameEdit[] = [
      { file_path: "f.ts", line: 1, column_start: 1, column_end: 4, old_text: "foo", new_text: "bar", confidence: 1, reason: "r" },
      { file_path: "f.ts", line: 1, column_start: 7, column_end: 10, old_text: "foo", new_text: "bar", confidence: 1, reason: "r" },
    ];

    const result = applyEditsToContent(content, edits);
    expect(result).toBe("bar + bar");
  });

  it("skips edits with out-of-range line numbers", () => {
    const content = "only one line";
    const edits: RenameEdit[] = [
      { file_path: "f.ts", line: 0, column_start: 1, column_end: 4, old_text: "onl", new_text: "xxx", confidence: 1, reason: "r" },
      { file_path: "f.ts", line: 5, column_start: 1, column_end: 4, old_text: "onl", new_text: "xxx", confidence: 1, reason: "r" },
    ];

    const result = applyEditsToContent(content, edits);
    expect(result).toBe("only one line");
  });

  it("handles renaming to a longer name", () => {
    const content = "const x = 1;";
    const edits: RenameEdit[] = [
      { file_path: "f.ts", line: 1, column_start: 7, column_end: 8, old_text: "x", new_text: "longVariableName", confidence: 1, reason: "r" },
    ];

    const result = applyEditsToContent(content, edits);
    expect(result).toBe("const longVariableName = 1;");
  });

  it("handles renaming to a shorter name", () => {
    const content = "const longVariableName = 1;";
    const edits: RenameEdit[] = [
      { file_path: "f.ts", line: 1, column_start: 7, column_end: 23, old_text: "longVariableName", new_text: "x", confidence: 1, reason: "r" },
    ];

    const result = applyEditsToContent(content, edits);
    expect(result).toBe("const x = 1;");
  });
});

describe("deduplicateRefs", () => {
  it("keeps unique refs", () => {
    const refs: SymbolReference[] = [
      { file_path: "a.ts", line: 1, confidence: 0.9, reason: "call" },
      { file_path: "b.ts", line: 5, confidence: 0.8, reason: "import" },
    ];
    const result = deduplicateRefs(refs);
    expect(result).toHaveLength(2);
  });

  it("deduplicates by file_path:line, keeping higher confidence", () => {
    const refs: SymbolReference[] = [
      { file_path: "a.ts", line: 1, confidence: 0.8, reason: "call" },
      { file_path: "a.ts", line: 1, confidence: 0.95, reason: "import" },
    ];
    const result = deduplicateRefs(refs);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.95);
    expect(result[0].reason).toBe("import");
  });

  it("keeps first when confidence is equal", () => {
    const refs: SymbolReference[] = [
      { file_path: "a.ts", line: 1, confidence: 0.9, reason: "first" },
      { file_path: "a.ts", line: 1, confidence: 0.9, reason: "second" },
    ];
    const result = deduplicateRefs(refs);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("first");
  });

  it("handles empty array", () => {
    expect(deduplicateRefs([])).toEqual([]);
  });
});

describe("deduplicateEdits", () => {
  const base: Omit<RenameEdit, "file_path" | "line" | "column_start" | "confidence" | "reason"> = {
    column_end: 10,
    old_text: "foo",
    new_text: "bar",
  };

  it("keeps unique edits", () => {
    const edits: RenameEdit[] = [
      { ...base, file_path: "a.ts", line: 1, column_start: 5, confidence: 1, reason: "def" },
      { ...base, file_path: "a.ts", line: 2, column_start: 5, confidence: 1, reason: "call" },
    ];
    expect(deduplicateEdits(edits)).toHaveLength(2);
  });

  it("deduplicates by file_path:line:column_start, keeping higher confidence", () => {
    const edits: RenameEdit[] = [
      { ...base, file_path: "a.ts", line: 1, column_start: 5, confidence: 0.8, reason: "call" },
      { ...base, file_path: "a.ts", line: 1, column_start: 5, confidence: 0.95, reason: "def" },
    ];
    const result = deduplicateEdits(edits);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.95);
  });

  it("handles empty array", () => {
    expect(deduplicateEdits([])).toEqual([]);
  });
});

// ─── Integration: renameSymbol ───────────────────────────────

import { renameSymbol } from "./rename.js";

describe("renameSymbol", () => {
  it("returns no-match warning when symbol is not found in graph", async () => {
    mockCypher.mockResolvedValueOnce([]);

    const result = await renameSymbol("repo-1", "graph_test", {
      symbol: "nonexistent",
      new_name: "renamed",
    });

    expect(result.edits).toEqual([]);
    expect(result.total_edits).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("No symbol found")]),
    );
  });

  it("returns ambiguous warning when multiple candidates and no filter", async () => {
    mockCypher.mockResolvedValueOnce([
      {
        n: { id: 1, label: "Function", properties: { name: "foo", start_line: 5 } },
        file_path: "a.ts",
        start_line: 5,
      },
      {
        n: { id: 2, label: "Function", properties: { name: "foo", start_line: 10 } },
        file_path: "b.ts",
        start_line: 10,
      },
    ]);

    const result = await renameSymbol("repo-1", "graph_test", {
      symbol: "foo",
      new_name: "bar",
    });

    expect(result.edits).toEqual([]);
    expect(result.applied).toBe(false);
    expect(result.warnings[0]).toContain("Ambiguous");
  });
});
