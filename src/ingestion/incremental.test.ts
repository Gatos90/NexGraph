import { describe, it, expect, vi } from "vitest";

// Mock external dependencies
vi.mock("../db/age.js", () => ({
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

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(),
}));

// ─── Test the exported pure function parseDiffOutput ─────────

import { parseDiffOutput } from "./incremental.js";

describe("parseDiffOutput", () => {
  it("parses added files", () => {
    const output = "A\tsrc/new-file.ts";
    const result = parseDiffOutput(output);
    expect(result).toEqual([
      { status: "A", path: "src/new-file.ts" },
    ]);
  });

  it("parses modified files", () => {
    const output = "M\tsrc/existing.ts";
    const result = parseDiffOutput(output);
    expect(result).toEqual([
      { status: "M", path: "src/existing.ts" },
    ]);
  });

  it("parses deleted files", () => {
    const output = "D\tsrc/removed.ts";
    const result = parseDiffOutput(output);
    expect(result).toEqual([
      { status: "D", path: "src/removed.ts" },
    ]);
  });

  it("parses renames as delete + add", () => {
    const output = "R100\told/path.ts\tnew/path.ts";
    const result = parseDiffOutput(output);
    expect(result).toEqual([
      { status: "D", path: "old/path.ts", oldPath: "old/path.ts" },
      { status: "A", path: "new/path.ts", oldPath: "old/path.ts" },
    ]);
  });

  it("parses copies as add", () => {
    const output = "C100\toriginal.ts\tcopy.ts";
    const result = parseDiffOutput(output);
    expect(result).toEqual([
      { status: "A", path: "copy.ts" },
    ]);
  });

  it("handles multiple files", () => {
    const output = [
      "A\tsrc/new.ts",
      "M\tsrc/mod.ts",
      "D\tsrc/del.ts",
    ].join("\n");

    const result = parseDiffOutput(output);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ status: "A", path: "src/new.ts" });
    expect(result[1]).toEqual({ status: "M", path: "src/mod.ts" });
    expect(result[2]).toEqual({ status: "D", path: "src/del.ts" });
  });

  it("skips empty lines", () => {
    const output = "A\tsrc/file.ts\n\n\n";
    const result = parseDiffOutput(output);
    expect(result).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    expect(parseDiffOutput("")).toEqual([]);
  });

  it("ignores unknown status codes", () => {
    const output = "X\tsrc/unknown.ts";
    const result = parseDiffOutput(output);
    expect(result).toEqual([]);
  });
});
