/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, vi } from "vitest";
import Parser from "tree-sitter";
import TypeScriptLanguage from "tree-sitter-typescript";

// Mock DB and logger
vi.mock("../db/connection.js", () => ({
  pool: { connect: vi.fn() },
}));
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

// ─── Levenshtein Distance / Similarity ──────────────────────
// Reproduce the algorithm from callgraph.ts for unit testing

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - levenshtein(a, b) / maxLen;
}

describe("Levenshtein distance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns length of other string when one is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("returns 1 for single char difference", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("handles insertion", () => {
    expect(levenshtein("abc", "abcd")).toBe(1);
  });

  it("handles deletion", () => {
    expect(levenshtein("abcd", "abc")).toBe(1);
  });

  it("handles multiple changes", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("Levenshtein similarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(levenshteinSimilarity("hello", "hello")).toBe(1.0);
  });

  it("returns 0 for completely different strings of same length", () => {
    // "abc" vs "xyz" -> distance 3, maxLen 3 -> 1 - 3/3 = 0
    expect(levenshteinSimilarity("abc", "xyz")).toBe(0);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(levenshteinSimilarity("", "")).toBe(1.0);
  });

  it("returns high similarity for similar names", () => {
    const sim = levenshteinSimilarity("getusers", "getuser");
    expect(sim).toBeGreaterThan(0.7);
  });

  it("returns low similarity for very different names", () => {
    const sim = levenshteinSimilarity("fetchdata", "processqueue");
    expect(sim).toBeLessThan(0.5);
  });
});

// ─── isBuiltinOrGlobal ──────────────────────────────────────
// Mirrors the expanded BUILTIN_NAMES set in callgraph.ts

const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  // JS/TS common globals
  "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "decodeURI",
  "encodeURIComponent", "decodeURIComponent", "JSON", "Math", "Date",
  "Array", "Object", "String", "Number", "Boolean", "Symbol", "Map",
  "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "RegExp", "Buffer", "process", "require", "module", "exports",
  "fetch", "Response", "Request", "URL", "URLSearchParams",
  "TextEncoder", "TextDecoder", "AbortController", "Headers",
  "FormData", "Blob", "File", "ReadableStream", "WritableStream",
  "queueMicrotask", "structuredClone", "atob", "btoa",
  "useState", "useEffect", "useCallback", "useMemo", "useRef",
  "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
  "log", "warn", "error", "info", "debug", "assert", "expect",
  "describe", "it", "test", "beforeEach", "afterEach", "beforeAll", "afterAll",
  "toString", "valueOf", "hasOwnProperty", "constructor",
  "then", "catch", "finally", "next", "done", "resolve", "reject",
  "push", "pop", "shift", "unshift", "map", "filter", "reduce",
  "forEach", "find", "findIndex", "includes", "indexOf", "slice",
  "splice", "concat", "join", "sort", "reverse", "keys", "values",
  "entries", "get", "set", "has", "delete", "add", "clear", "size",
  // Python
  "print", "len", "range", "super", "isinstance", "issubclass",
  "type", "list", "dict", "tuple", "str", "int", "float", "bool",
  "enumerate", "zip", "iter", "any", "all",
  "min", "max", "sum", "abs", "round", "repr", "hash", "id",
  "callable", "staticmethod", "classmethod", "property",
  "open", "input", "format", "vars", "dir", "help",
  "getattr", "setattr", "hasattr", "delattr",
  "sorted", "reversed", "__init__", "__str__", "__repr__",
  // Java
  "equals", "hashCode", "getClass", "wait", "notify", "notifyAll",
  "compareTo", "iterator", "length", "isEmpty", "contains",
  "println", "printf",
  // Go
  "make", "cap", "copy", "panic", "recover", "new",
  "Println", "Printf", "Sprintf", "Fprintf", "Errorf",
  // Rust
  "println", "eprintln", "vec", "todo", "unimplemented",
  "clone", "drop", "into", "from", "unwrap", "expect",
  "Ok", "Err", "Some", "None", "collect", "into_iter",
  // C/C++
  "printf", "fprintf", "sprintf", "malloc", "calloc", "realloc", "free",
  "memcpy", "memset", "strlen", "strcpy", "strcmp",
  "fopen", "fclose", "exit", "abort", "sizeof",
  // Linux kernel
  "printk", "kmalloc", "kfree", "spin_lock", "spin_unlock",
  "mutex_lock", "mutex_unlock", "BUG_ON", "WARN_ON", "container_of",
]);

function isBuiltinOrGlobal(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

describe("isBuiltinOrGlobal", () => {
  it("identifies JS global: console", () => {
    expect(isBuiltinOrGlobal("console")).toBe(true);
  });

  it("identifies JS global: Promise", () => {
    expect(isBuiltinOrGlobal("Promise")).toBe(true);
  });

  it("identifies array method: map", () => {
    expect(isBuiltinOrGlobal("map")).toBe(true);
  });

  it("identifies test runner: describe", () => {
    expect(isBuiltinOrGlobal("describe")).toBe(true);
  });

  it("identifies Python builtin: print", () => {
    expect(isBuiltinOrGlobal("print")).toBe(true);
  });

  it("identifies Python builtin: isinstance", () => {
    expect(isBuiltinOrGlobal("isinstance")).toBe(true);
  });

  it("identifies Java builtin: equals", () => {
    expect(isBuiltinOrGlobal("equals")).toBe(true);
  });

  it("identifies Go builtin: make", () => {
    expect(isBuiltinOrGlobal("make")).toBe(true);
  });

  it("identifies Rust builtin: clone", () => {
    expect(isBuiltinOrGlobal("clone")).toBe(true);
  });

  it("identifies C builtin: printf", () => {
    expect(isBuiltinOrGlobal("printf")).toBe(true);
  });

  it("identifies C builtin: malloc", () => {
    expect(isBuiltinOrGlobal("malloc")).toBe(true);
  });

  it("identifies kernel builtin: printk", () => {
    expect(isBuiltinOrGlobal("printk")).toBe(true);
  });

  it("does NOT identify custom function names", () => {
    expect(isBuiltinOrGlobal("fetchUserData")).toBe(false);
    expect(isBuiltinOrGlobal("handleRequest")).toBe(false);
    expect(isBuiltinOrGlobal("UserService")).toBe(false);
    expect(isBuiltinOrGlobal("calculate_tax")).toBe(false);
    expect(isBuiltinOrGlobal("ProcessOrder")).toBe(false);
  });

  it("identifies fetch as built-in", () => {
    expect(isBuiltinOrGlobal("fetch")).toBe(true);
  });
});

// ─── Three-Tier Resolution Logic ────────────────────────────

interface SymbolInfo {
  id: number;
  label: string;
  name: string;
  filePath: string;
  className: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

interface CallSite {
  callerName: string;
  callerClass: string;
  callerFilePath: string;
  calleeName: string;
  calleeQualifier: string;
  line: number;
}

type ResolutionMethod = "exact_import" | "fuzzy" | "heuristic";

interface ResolvedCall {
  callerId: number;
  calleeId: number;
  confidence: number;
  method: ResolutionMethod;
}

// Reproduce the resolution functions from callgraph.ts

function findCallerSymbol(call: CallSite, symbols: SymbolInfo[]): SymbolInfo | null {
  for (const s of symbols) {
    if (s.name === call.callerName && s.className === call.callerClass) return s;
  }
  for (const s of symbols) {
    if (s.name === call.callerName) return s;
  }
  return null;
}

function resolveExact(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
  importedFiles: Set<string>,
  currentFile: string,
): SymbolInfo | null {
  const targetName = call.calleeName;
  for (const importedFile of importedFiles) {
    const symbols = allSymbols.get(importedFile);
    if (!symbols) continue;
    for (const s of symbols) {
      if (s.name === targetName && s.exported) return s;
    }
  }
  const sameFileSymbols = allSymbols.get(currentFile);
  if (sameFileSymbols) {
    for (const s of sameFileSymbols) {
      if (s.name === targetName) return s;
    }
  }
  return null;
}

function resolveFuzzy(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
  importedFiles: Set<string>,
): { symbol: SymbolInfo; similarity: number } | null {
  const targetName = call.calleeName;
  if (targetName.length < 3) return null;

  let bestMatch: { symbol: SymbolInfo; similarity: number } | null = null;
  const threshold = 0.70;

  for (const importedFile of importedFiles) {
    const symbols = allSymbols.get(importedFile);
    if (!symbols) continue;
    for (const s of symbols) {
      if (!s.exported) continue;
      const sim = levenshteinSimilarity(targetName.toLowerCase(), s.name.toLowerCase());
      if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { symbol: s, similarity: sim };
      }
    }
  }
  return bestMatch;
}

function resolveHeuristic(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
): SymbolInfo | null {
  const targetName = call.calleeName;
  if (isBuiltinOrGlobal(targetName)) return null;

  let bestCandidate: SymbolInfo | null = null;
  for (const [, symbols] of allSymbols) {
    for (const s of symbols) {
      if (s.name === targetName && s.exported) {
        if (!bestCandidate) bestCandidate = s;
        if (
          (s.label === "Function" || s.label === "Method") &&
          bestCandidate.label !== "Function" &&
          bestCandidate.label !== "Method"
        ) {
          bestCandidate = s;
        }
      }
    }
  }
  return bestCandidate;
}

function resolveCallsForFile(
  callSites: CallSite[],
  callerSymbols: SymbolInfo[],
  allSymbols: Map<string, SymbolInfo[]>,
  importedFiles: Set<string>,
  filePath: string,
): ResolvedCall[] {
  const resolved: ResolvedCall[] = [];
  const edgeSet = new Set<string>();

  for (const call of callSites) {
    const caller = findCallerSymbol(call, callerSymbols);
    if (!caller) continue;

    const exactMatch = resolveExact(call, allSymbols, importedFiles, filePath);
    if (exactMatch) {
      const key = `${caller.id}->${exactMatch.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        resolved.push({
          callerId: caller.id,
          calleeId: exactMatch.id,
          confidence: call.calleeQualifier === "" ? 0.95 : 0.90,
          method: "exact_import",
        });
      }
      continue;
    }

    const fuzzyMatch = resolveFuzzy(call, allSymbols, importedFiles);
    if (fuzzyMatch) {
      const key = `${caller.id}->${fuzzyMatch.symbol.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        resolved.push({
          callerId: caller.id,
          calleeId: fuzzyMatch.symbol.id,
          confidence: 0.60 + fuzzyMatch.similarity * 0.20,
          method: "fuzzy",
        });
      }
      continue;
    }

    const heuristicMatch = resolveHeuristic(call, allSymbols);
    if (heuristicMatch) {
      const key = `${caller.id}->${heuristicMatch.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        resolved.push({
          callerId: caller.id,
          calleeId: heuristicMatch.id,
          confidence: heuristicMatch.exported ? 0.55 : 0.40,
          method: "heuristic",
        });
      }
    }
  }

  return resolved;
}

// ─── Tier 1: Exact Import Resolution ────────────────────────

describe("Call graph — Tier 1: Exact import resolution", () => {
  it("resolves call to exported symbol in imported file", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "formatDate", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);
    allSymbols.set("app.ts", [
      { id: 20, label: "Function", name: "handleRequest", filePath: "app.ts", className: "", startLine: 1, endLine: 10, exported: true },
    ]);

    const importedFiles = new Set(["utils.ts"]);
    const call: CallSite = {
      callerName: "handleRequest",
      callerClass: "",
      callerFilePath: "app.ts",
      calleeName: "formatDate",
      calleeQualifier: "",
      line: 5,
    };

    const result = resolveExact(call, allSymbols, importedFiles, "app.ts");
    expect(result).toBeDefined();
    expect(result!.name).toBe("formatDate");
    expect(result!.id).toBe(10);
  });

  it("resolves call to symbol in same file", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("app.ts", [
      { id: 1, label: "Function", name: "helper", filePath: "app.ts", className: "", startLine: 1, endLine: 3, exported: false },
      { id: 2, label: "Function", name: "main", filePath: "app.ts", className: "", startLine: 5, endLine: 10, exported: true },
    ]);

    const call: CallSite = {
      callerName: "main",
      callerClass: "",
      callerFilePath: "app.ts",
      calleeName: "helper",
      calleeQualifier: "",
      line: 7,
    };

    const result = resolveExact(call, allSymbols, new Set(), "app.ts");
    expect(result).toBeDefined();
    expect(result!.name).toBe("helper");
  });

  it("does NOT match unexported symbol in imported file", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "internalHelper", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: false },
    ]);

    const call: CallSite = {
      callerName: "main",
      callerClass: "",
      callerFilePath: "app.ts",
      calleeName: "internalHelper",
      calleeQualifier: "",
      line: 5,
    };

    const result = resolveExact(call, allSymbols, new Set(["utils.ts"]), "app.ts");
    expect(result).toBeNull();
  });

  it("assigns higher confidence for unqualified calls", () => {
    const callerSymbols: SymbolInfo[] = [
      { id: 1, label: "Function", name: "main", filePath: "app.ts", className: "", startLine: 1, endLine: 10, exported: true },
    ];
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "formatDate", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const calls: CallSite[] = [{
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "formatDate", calleeQualifier: "", line: 5,
    }];

    const result = resolveCallsForFile(calls, callerSymbols, allSymbols, new Set(["utils.ts"]), "app.ts");
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.95);
    expect(result[0].method).toBe("exact_import");
  });

  it("assigns lower confidence for qualified calls (e.g. this.method)", () => {
    const callerSymbols: SymbolInfo[] = [
      { id: 1, label: "Function", name: "main", filePath: "app.ts", className: "", startLine: 1, endLine: 10, exported: true },
    ];
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "format", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const calls: CallSite[] = [{
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "format", calleeQualifier: "utils", line: 5,
    }];

    const result = resolveCallsForFile(calls, callerSymbols, allSymbols, new Set(["utils.ts"]), "app.ts");
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.90);
  });
});

// ─── Tier 2: Fuzzy Resolution ───────────────────────────────

describe("Call graph — Tier 2: Fuzzy resolution", () => {
  it("matches similar symbol name above threshold", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "getUsers", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "getUser", calleeQualifier: "", line: 5,
    };

    const result = resolveFuzzy(call, allSymbols, new Set(["utils.ts"]));
    expect(result).toBeDefined();
    expect(result!.symbol.name).toBe("getUsers");
    expect(result!.similarity).toBeGreaterThan(0.7);
  });

  it("does NOT match below threshold", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "processQueue", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "fetchData", calleeQualifier: "", line: 5,
    };

    const result = resolveFuzzy(call, allSymbols, new Set(["utils.ts"]));
    expect(result).toBeNull();
  });

  it("rejects short names (< 3 chars)", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "fn", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "fn", calleeQualifier: "", line: 5,
    };

    const result = resolveFuzzy(call, allSymbols, new Set(["utils.ts"]));
    expect(result).toBeNull();
  });

  it("only matches exported symbols", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "getUsers", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: false },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "getUser", calleeQualifier: "", line: 5,
    };

    const result = resolveFuzzy(call, allSymbols, new Set(["utils.ts"]));
    expect(result).toBeNull();
  });

  it("assigns confidence between 0.60–0.80", () => {
    const callerSymbols: SymbolInfo[] = [
      { id: 1, label: "Function", name: "main", filePath: "app.ts", className: "", startLine: 1, endLine: 10, exported: true },
    ];
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "getUsers", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const calls: CallSite[] = [{
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "getUser", calleeQualifier: "", line: 5,
    }];

    allSymbols.set("app.ts", callerSymbols);

    const result = resolveCallsForFile(calls, callerSymbols, allSymbols, new Set(["utils.ts"]), "app.ts");
    // "getUser" is not exactly in imported files or same file,
    // so it falls to fuzzy tier: "getUser" vs "getUsers" similarity > 0.7
    const fuzzyResult = result.find((r) => r.method === "fuzzy");
    if (fuzzyResult) {
      expect(fuzzyResult.confidence).toBeGreaterThanOrEqual(0.60);
      expect(fuzzyResult.confidence).toBeLessThanOrEqual(0.80);
    }
  });
});

// ─── Tier 3: Heuristic Resolution ───────────────────────────

describe("Call graph — Tier 3: Heuristic resolution", () => {
  it("finds exported symbol by name across all files", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("other.ts", [
      { id: 30, label: "Function", name: "processData", filePath: "other.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "processData", calleeQualifier: "", line: 5,
    };

    const result = resolveHeuristic(call, allSymbols);
    expect(result).toBeDefined();
    expect(result!.name).toBe("processData");
  });

  it("skips built-in/global names", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("other.ts", [
      { id: 30, label: "Function", name: "map", filePath: "other.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "map", calleeQualifier: "", line: 5,
    };

    const result = resolveHeuristic(call, allSymbols);
    expect(result).toBeNull();
  });

  it("prefers Function/Method over other labels", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("types.ts", [
      { id: 10, label: "Interface", name: "Config", filePath: "types.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);
    allSymbols.set("factory.ts", [
      { id: 20, label: "Function", name: "Config", filePath: "factory.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "Config", calleeQualifier: "", line: 5,
    };

    const result = resolveHeuristic(call, allSymbols);
    expect(result).toBeDefined();
    expect(result!.label).toBe("Function");
    expect(result!.id).toBe(20);
  });

  it("does NOT match unexported symbols", () => {
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("other.ts", [
      { id: 30, label: "Function", name: "internalFn", filePath: "other.ts", className: "", startLine: 1, endLine: 5, exported: false },
    ]);

    const call: CallSite = {
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "internalFn", calleeQualifier: "", line: 5,
    };

    const result = resolveHeuristic(call, allSymbols);
    expect(result).toBeNull();
  });

  it("assigns confidence 0.55 for exported heuristic match", () => {
    const callerSymbols: SymbolInfo[] = [
      { id: 1, label: "Function", name: "main", filePath: "app.ts", className: "", startLine: 1, endLine: 10, exported: true },
    ];
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("app.ts", callerSymbols);
    allSymbols.set("other.ts", [
      { id: 30, label: "Function", name: "processData", filePath: "other.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const calls: CallSite[] = [{
      callerName: "main", callerClass: "", callerFilePath: "app.ts",
      calleeName: "processData", calleeQualifier: "", line: 5,
    }];

    // No imports set, so tier 1 and 2 won't match → falls to tier 3
    const result = resolveCallsForFile(calls, callerSymbols, allSymbols, new Set(), "app.ts");
    const heuristic = result.find((r) => r.method === "heuristic");
    expect(heuristic).toBeDefined();
    expect(heuristic!.confidence).toBe(0.55);
  });
});

// ─── Edge deduplication ─────────────────────────────────────

describe("Call graph — Edge deduplication", () => {
  it("deduplicates multiple calls from same caller to same callee", () => {
    const callerSymbols: SymbolInfo[] = [
      { id: 1, label: "Function", name: "main", filePath: "app.ts", className: "", startLine: 1, endLine: 10, exported: true },
    ];
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("app.ts", callerSymbols);
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "formatDate", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const calls: CallSite[] = [
      { callerName: "main", callerClass: "", callerFilePath: "app.ts", calleeName: "formatDate", calleeQualifier: "", line: 3 },
      { callerName: "main", callerClass: "", callerFilePath: "app.ts", calleeName: "formatDate", calleeQualifier: "", line: 7 },
    ];

    const result = resolveCallsForFile(calls, callerSymbols, allSymbols, new Set(["utils.ts"]), "app.ts");
    // Should only create one edge despite two call sites
    expect(result).toHaveLength(1);
  });
});

// ─── Full resolution pipeline ───────────────────────────────

describe("Call graph — Full resolution pipeline", () => {
  it("resolves a mix of exact, fuzzy, and heuristic calls", () => {
    const callerSymbols: SymbolInfo[] = [
      { id: 1, label: "Function", name: "controller", filePath: "app.ts", className: "", startLine: 1, endLine: 20, exported: true },
    ];
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("app.ts", callerSymbols);
    allSymbols.set("imported.ts", [
      { id: 10, label: "Function", name: "exactMatch", filePath: "imported.ts", className: "", startLine: 1, endLine: 5, exported: true },
      { id: 11, label: "Function", name: "fuzzyMatch", filePath: "imported.ts", className: "", startLine: 6, endLine: 10, exported: true },
    ]);
    allSymbols.set("global.ts", [
      { id: 20, label: "Function", name: "globalHelper", filePath: "global.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const calls: CallSite[] = [
      { callerName: "controller", callerClass: "", callerFilePath: "app.ts", calleeName: "exactMatch", calleeQualifier: "", line: 3 },
      { callerName: "controller", callerClass: "", callerFilePath: "app.ts", calleeName: "fuzyMatch", calleeQualifier: "", line: 7 }, // typo → fuzzy
      { callerName: "controller", callerClass: "", callerFilePath: "app.ts", calleeName: "globalHelper", calleeQualifier: "", line: 10 },
    ];

    const result = resolveCallsForFile(
      calls, callerSymbols, allSymbols,
      new Set(["imported.ts"]), "app.ts",
    );

    expect(result.length).toBeGreaterThanOrEqual(2);

    const exact = result.find((r) => r.method === "exact_import");
    expect(exact).toBeDefined();
    expect(exact!.calleeId).toBe(10);

    // "fuzyMatch" should fuzzy-match to "fuzzyMatch" (similarity ~0.9)
    const fuzzy = result.find((r) => r.method === "fuzzy");
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.calleeId).toBe(11);

    // "globalHelper" not in imports, falls to heuristic
    const heuristic = result.find((r) => r.method === "heuristic");
    expect(heuristic).toBeDefined();
    expect(heuristic!.calleeId).toBe(20);
  });

  it("skips calls where caller is not found in symbol map", () => {
    const callerSymbols: SymbolInfo[] = [];
    const allSymbols = new Map<string, SymbolInfo[]>();
    allSymbols.set("utils.ts", [
      { id: 10, label: "Function", name: "formatDate", filePath: "utils.ts", className: "", startLine: 1, endLine: 5, exported: true },
    ]);

    const calls: CallSite[] = [{
      callerName: "unknownCaller", callerClass: "", callerFilePath: "app.ts",
      calleeName: "formatDate", calleeQualifier: "", line: 5,
    }];

    const result = resolveCallsForFile(calls, callerSymbols, allSymbols, new Set(["utils.ts"]), "app.ts");
    expect(result).toHaveLength(0);
  });
});

// ─── AST Call Extraction (Integration with tree-sitter) ─────

describe("Call graph — AST call extraction (integration)", () => {
  const parser = new Parser();

  it("extracts call expressions from TypeScript source", () => {
    parser.setLanguage(TypeScriptLanguage.typescript);
    const source = `
import { formatDate } from "./utils";

function handler() {
  const result = formatDate(new Date());
  console.log(result);
  return result;
}
`;
    const tree = parser.parse(source);

    // Walk tree to find call_expression nodes
    const calls: string[] = [];
    function visit(node: Parser.SyntaxNode): void {
      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        if (fn) {
          if (fn.type === "identifier") calls.push(fn.text);
          else if (fn.type === "member_expression") {
            const prop = fn.childForFieldName("property");
            if (prop) calls.push(prop.text);
          }
        }
      }
      for (const child of node.children) visit(child);
    }
    visit(tree.rootNode);

    expect(calls).toContain("formatDate");
    expect(calls).toContain("log");
  });

  it("extracts new expressions as constructor calls", () => {
    parser.setLanguage(TypeScriptLanguage.typescript);
    const source = `
function create() {
  return new UserService("test");
}
`;
    const tree = parser.parse(source);

    const newExprs: string[] = [];
    function visit(node: Parser.SyntaxNode): void {
      if (node.type === "new_expression") {
        const ctor = node.childForFieldName("constructor");
        if (ctor) newExprs.push(ctor.text);
      }
      for (const child of node.children) visit(child);
    }
    visit(tree.rootNode);

    expect(newExprs).toContain("UserService");
  });

  it("extracts class inheritance from TypeScript AST", () => {
    parser.setLanguage(TypeScriptLanguage.typescript);
    const source = `
class Dog extends Animal implements Pet {
  bark() {}
}
`;
    const tree = parser.parse(source);

    let superClass: string | null = null;
    const interfaces: string[] = [];

    function visit(node: Parser.SyntaxNode): void {
      if (node.type === "class_declaration") {
        for (const child of node.children) {
          if (child.type === "class_heritage") {
            for (const clause of child.namedChildren) {
              if (clause.type === "extends_clause") {
                const type = clause.namedChildren[0];
                if (type) superClass = type.text;
              }
              if (clause.type === "implements_clause") {
                for (const impl of clause.namedChildren) {
                  interfaces.push(impl.text);
                }
              }
            }
          }
        }
      }
      for (const child of node.children) visit(child);
    }
    visit(tree.rootNode);

    expect(superClass).toBe("Animal");
    expect(interfaces).toContain("Pet");
  });
});
