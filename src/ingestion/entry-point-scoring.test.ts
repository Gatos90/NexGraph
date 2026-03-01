import { describe, it, expect, vi } from "vitest";

// Mock dependencies
vi.mock("../db/age.js", () => ({
  cypher: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ─── Reproduce getNameMultiplier for unit testing ────────────

interface NamePattern {
  pattern: RegExp;
  multiplier: number;
}

const NAME_PATTERNS: NamePattern[] = [
  { pattern: /^handle/i, multiplier: 2.0 },
  { pattern: /^on[A-Z]/i, multiplier: 2.0 },
  { pattern: /Controller$/i, multiplier: 2.0 },
  { pattern: /Service$/i, multiplier: 2.0 },
  { pattern: /Handler$/i, multiplier: 2.0 },
  { pattern: /^process/i, multiplier: 1.8 },
  { pattern: /^execute/i, multiplier: 1.8 },
  { pattern: /^run/i, multiplier: 1.8 },
  { pattern: /^start/i, multiplier: 1.8 },
  { pattern: /^init/i, multiplier: 1.8 },
  { pattern: /^create/i, multiplier: 1.3 },
  { pattern: /^build/i, multiplier: 1.3 },
  { pattern: /^setup/i, multiplier: 1.3 },
  { pattern: /^get[A-Z]/i, multiplier: 0.8 },
  { pattern: /^set[A-Z]/i, multiplier: 0.8 },
  { pattern: /^is[A-Z]/i, multiplier: 0.8 },
  { pattern: /^has[A-Z]/i, multiplier: 0.8 },
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

// ═══════════════════════════════════════════════════════════════

describe("getNameMultiplier", () => {
  it("returns 2.0 for handler-like names", () => {
    expect(getNameMultiplier("handleRequest")).toBe(2.0);
    expect(getNameMultiplier("onClick")).toBe(2.0);
    expect(getNameMultiplier("UserController")).toBe(2.0);
    expect(getNameMultiplier("AuthService")).toBe(2.0);
    expect(getNameMultiplier("EventHandler")).toBe(2.0);
  });

  it("returns 1.8 for process/execute/run names", () => {
    expect(getNameMultiplier("processQueue")).toBe(1.8);
    expect(getNameMultiplier("executeQuery")).toBe(1.8);
    expect(getNameMultiplier("runMigration")).toBe(1.8);
    expect(getNameMultiplier("startServer")).toBe(1.8);
    expect(getNameMultiplier("initDatabase")).toBe(1.8);
  });

  it("returns 1.3 for create/build/setup names", () => {
    expect(getNameMultiplier("createUser")).toBe(1.3);
    expect(getNameMultiplier("buildGraph")).toBe(1.3);
    expect(getNameMultiplier("setupRoutes")).toBe(1.3);
  });

  it("returns 0.8 for getter/setter names", () => {
    expect(getNameMultiplier("getUserProfile")).toBe(0.8);
    expect(getNameMultiplier("setConfig")).toBe(0.8);
    expect(getNameMultiplier("isValid")).toBe(0.8);
    expect(getNameMultiplier("hasPermission")).toBe(0.8);
  });

  it("returns 0.5 for utility names", () => {
    expect(getNameMultiplier("formatHelper")).toBe(0.5);
    expect(getNameMultiplier("stringUtil")).toBe(0.5);
    expect(getNameMultiplier("arrayUtils")).toBe(0.5);
  });

  it("returns 1.0 for generic names", () => {
    expect(getNameMultiplier("doSomething")).toBe(1.0);
    expect(getNameMultiplier("transform")).toBe(1.0);
    expect(getNameMultiplier("parse")).toBe(1.0);
  });
});

// ─── Integration: scoreEntryPoints ───────────────────────────

import { scoreEntryPoints } from "./entry-point-scoring.js";
import { cypher } from "../db/age.js";

describe("scoreEntryPoints", () => {
  it("returns empty when no symbols exist", async () => {
    vi.mocked(cypher)
      .mockResolvedValueOnce([]) // symbols
      .mockResolvedValueOnce([]) // outgoing
      .mockResolvedValueOnce([]); // incoming

    const result = await scoreEntryPoints("test_graph");
    expect(result).toEqual([]);
  });

  it("filters out test files, non-callable types, and leaf nodes", async () => {
    vi.mocked(cypher)
      .mockResolvedValueOnce([
        // Test file — should be excluded
        { v: { id: 1, label: "Function", properties: { name: "testFunc", exported: true } }, file_path: "test/unit.test.ts" },
        // File node — should be excluded
        { v: { id: 2, label: "File", properties: { name: "index.ts" } }, file_path: "src/index.ts" },
        // Valid candidate
        { v: { id: 3, label: "Function", properties: { name: "handleRequest", exported: true } }, file_path: "src/server.ts" },
        // Leaf node (0 outgoing) — should be excluded
        { v: { id: 4, label: "Function", properties: { name: "helper", exported: false } }, file_path: "src/utils.ts" },
      ])
      .mockResolvedValueOnce([
        // outgoing calls: only node 3 has outgoing
        { src: 3, cnt: 5 },
      ])
      .mockResolvedValueOnce([
        // incoming calls
        { tgt: 3, cnt: 2 },
      ]);

    const result = await scoreEntryPoints("test_graph");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("handleRequest");
    expect(result[0].exportMultiplier).toBe(1.5);
    expect(result[0].nameMultiplier).toBe(2.0);
  });
});
