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

// ─── Reproduce private helper functions for unit testing ─────

const SKIP_FOLDERS = new Set([
  "src", "lib", "core", "utils", "common", "shared", "helpers",
  ".", "", "dist", "build", "node_modules", "vendor", "pkg",
]);

const SKIP_WORDS = new Set([
  "get", "set", "is", "has", "do", "on", "the", "a", "an",
  "to", "of", "in", "for", "new", "from", "with", "by",
  "id", "fn", "cb", "err", "res", "req", "ctx", "db",
]);

interface SymbolNode {
  id: number;
  name: string;
  filePath: string;
  label: string;
}

function splitName(name: string): string[] {
  const parts = name.split(/[_\-./]+/);
  const words: string[] = [];
  for (const part of parts) {
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

function computeKeywords(members: SymbolNode[], topN: number = 5): string[] {
  const freq = new Map<string, number>();
  for (const m of members) {
    const words = splitName(m.name);
    const unique = new Set(words);
    for (const w of unique) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

function computeHeuristicLabel(
  members: SymbolNode[],
  communityIndex: number,
): string {
  const folderFreq = new Map<string, number>();
  for (const m of members) {
    const parts = m.filePath.split("/");
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
    if (sorted[0][1] >= Math.max(2, members.length * 0.3)) {
      return topFolder;
    }
  }

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
    if (prefix.length >= 3) {
      const lastSegment = prefix.split("/").filter((s) => s.length > 0).pop();
      if (lastSegment && !SKIP_FOLDERS.has(lastSegment)) {
        return lastSegment;
      }
    }
  }

  return `Cluster_${communityIndex}`;
}

// ═══════════════════════════════════════════════════════════════

describe("splitName", () => {
  it("splits camelCase", () => {
    expect(splitName("getUserProfile")).toEqual(["user", "profile"]);
  });

  it("splits PascalCase", () => {
    expect(splitName("UserService")).toEqual(["user", "service"]);
  });

  it("splits snake_case", () => {
    expect(splitName("get_user_profile")).toEqual(["user", "profile"]);
  });

  it("filters short and skip words", () => {
    expect(splitName("getId")).toEqual([]);
    expect(splitName("setNewFromDb")).toEqual([]);
  });

  it("splits mixed formats", () => {
    expect(splitName("myFunc_helperMethod")).toEqual(["my", "func", "helper", "method"]);
  });

  it("handles dot-separated names", () => {
    expect(splitName("module.exports")).toEqual(["module", "exports"]);
  });
});

describe("computeKeywords", () => {
  it("returns top keywords by frequency", () => {
    const members: SymbolNode[] = [
      { id: 1, name: "createUser", filePath: "a.ts", label: "Function" },
      { id: 2, name: "deleteUser", filePath: "b.ts", label: "Function" },
      { id: 3, name: "updateUser", filePath: "c.ts", label: "Function" },
      { id: 4, name: "createOrder", filePath: "d.ts", label: "Function" },
    ];

    const keywords = computeKeywords(members);
    // "user" appears 3 times, should be first
    expect(keywords[0]).toBe("user");
  });

  it("returns empty for empty members", () => {
    expect(computeKeywords([])).toEqual([]);
  });

  it("limits to topN", () => {
    const members: SymbolNode[] = [
      { id: 1, name: "createUserProfileSettings", filePath: "a.ts", label: "Function" },
    ];
    const keywords = computeKeywords(members, 2);
    expect(keywords.length).toBeLessThanOrEqual(2);
  });
});

describe("computeHeuristicLabel", () => {
  it("uses most frequent meaningful folder", () => {
    const members: SymbolNode[] = [
      { id: 1, name: "a", filePath: "src/controllers/userController.ts", label: "Function" },
      { id: 2, name: "b", filePath: "src/controllers/authController.ts", label: "Function" },
      { id: 3, name: "c", filePath: "src/controllers/orderController.ts", label: "Function" },
    ];

    expect(computeHeuristicLabel(members, 0)).toBe("controllers");
  });

  it("skips generic folders (src, lib, utils)", () => {
    const members: SymbolNode[] = [
      { id: 1, name: "a", filePath: "src/a.ts", label: "Function" },
      { id: 2, name: "b", filePath: "src/b.ts", label: "Function" },
    ];

    // "src" is in SKIP_FOLDERS, should fall through
    const label = computeHeuristicLabel(members, 5);
    // Should fallback to Cluster_5 since "src" is skipped
    expect(label).toBe("Cluster_5");
  });

  it("falls back to Cluster_N when no meaningful folder found", () => {
    const members: SymbolNode[] = [
      { id: 1, name: "a", filePath: "src/a.ts", label: "Function" },
      { id: 2, name: "b", filePath: "lib/b.ts", label: "Function" },
    ];

    // Both folders (src, lib) are in SKIP_FOLDERS, no common prefix of 3+ chars
    expect(computeHeuristicLabel(members, 42)).toBe("Cluster_42");
  });

  it("uses common path prefix as fallback", () => {
    const members: SymbolNode[] = [
      { id: 1, name: "a", filePath: "services/auth/login.ts", label: "Function" },
      { id: 2, name: "b", filePath: "services/auth/register.ts", label: "Function" },
    ];

    const label = computeHeuristicLabel(members, 0);
    expect(label).toBe("auth");
  });
});
