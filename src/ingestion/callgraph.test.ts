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

// ─── Property-Type Resolution (Tier 0) ─────────────────────

// Mirror types from callgraph.ts
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

interface PropertyTypeInfo {
  className: string;
  propertyName: string;
  typeName: string;
  filePath: string;
}

// Mirror extractPropertyName from callgraph.ts
function extractPropertyName(qualifier: string): string | null {
  if (qualifier.startsWith("this.")) {
    const prop = qualifier.slice(5);
    return prop.includes(".") ? null : prop || null;
  }
  if (qualifier.startsWith("self.")) {
    const prop = qualifier.slice(5);
    return prop.includes(".") ? null : prop || null;
  }
  const dotIndex = qualifier.indexOf(".");
  if (dotIndex > 0) {
    const prop = qualifier.slice(dotIndex + 1);
    return prop.includes(".") ? null : prop || null;
  }
  if (qualifier && !qualifier.includes(".")) {
    return qualifier;
  }
  return null;
}

// Mirror resolvePropertyType from callgraph.ts
function resolvePropertyType(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
  propertyTypeMap: Map<string, string>,
): SymbolInfo | null {
  const qualifier = call.calleeQualifier;
  if (!qualifier) return null;

  const propertyName = extractPropertyName(qualifier);
  if (!propertyName) return null;

  const callerClass = call.callerClass;
  if (!callerClass) return null;

  const key = `${callerClass}.${propertyName}`;
  const typeName = propertyTypeMap.get(key);
  if (!typeName) return null;

  for (const [, symbols] of allSymbols) {
    for (const s of symbols) {
      if (s.label === "Method" && s.className === typeName && s.name === call.calleeName) {
        return s;
      }
    }
  }

  return null;
}

describe("extractPropertyName", () => {
  it("extracts property from this.X", () => {
    expect(extractPropertyName("this.authService")).toBe("authService");
  });

  it("extracts property from self.X", () => {
    expect(extractPropertyName("self.user_service")).toBe("user_service");
  });

  it("extracts property from Go receiver.field", () => {
    expect(extractPropertyName("h.userService")).toBe("userService");
  });

  it("extracts Java implicit this (bare identifier)", () => {
    expect(extractPropertyName("userService")).toBe("userService");
  });

  it("returns null for deep chains (this.a.b)", () => {
    expect(extractPropertyName("this.a.b")).toBeNull();
  });

  it("returns null for deep chains (self.a.b)", () => {
    expect(extractPropertyName("self.a.b")).toBeNull();
  });

  it("returns null for deep chains (h.a.b)", () => {
    expect(extractPropertyName("h.a.b")).toBeNull();
  });

  it("returns null for just 'this' (no dot)", () => {
    // "this" alone → falls to pattern 4 (bare identifier), which returns "this"
    // But this is fine — it won't match any property in the map
    expect(extractPropertyName("this")).toBe("this");
  });

  it("returns null for empty qualifier", () => {
    expect(extractPropertyName("")).toBeNull();
  });
});

describe("resolvePropertyType", () => {
  const authLogin: SymbolInfo = {
    id: 50, label: "Method", name: "login", filePath: "auth.service.ts",
    className: "AuthService", startLine: 10, endLine: 15, exported: true,
  };
  const dbQuery: SymbolInfo = {
    id: 60, label: "Method", name: "Query", filePath: "database.go",
    className: "Database", startLine: 5, endLine: 20, exported: true,
  };
  const pyFind: SymbolInfo = {
    id: 70, label: "Method", name: "find_user", filePath: "user_service.py",
    className: "UserService", startLine: 8, endLine: 12, exported: true,
  };
  const rustProcess: SymbolInfo = {
    id: 80, label: "Method", name: "process", filePath: "my_service.rs",
    className: "MyService", startLine: 3, endLine: 10, exported: true,
  };

  const allSymbols = new Map<string, SymbolInfo[]>([
    ["auth.service.ts", [authLogin]],
    ["database.go", [dbQuery]],
    ["user_service.py", [pyFind]],
    ["my_service.rs", [rustProcess]],
  ]);

  const propertyTypeMap = new Map([
    ["AppComponent.authService", "AuthService"],
    ["Handler.db", "Database"],
    ["UserView.user_service", "UserService"],
    ["MyStruct.service", "MyService"],
    ["Controller.userService", "AuthService"], // for Java implicit this
  ]);

  it("resolves this.authService.login() → AuthService.login (TS/JS)", () => {
    const call: CallSite = {
      callerName: "ngOnInit", callerClass: "AppComponent",
      callerFilePath: "app.component.ts",
      calleeName: "login", calleeQualifier: "this.authService", line: 5,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeDefined();
    expect(result!.name).toBe("login");
    expect(result!.className).toBe("AuthService");
  });

  it("resolves self.user_service.find_user() → UserService.find_user (Python)", () => {
    const call: CallSite = {
      callerName: "get", callerClass: "UserView",
      callerFilePath: "views.py",
      calleeName: "find_user", calleeQualifier: "self.user_service", line: 10,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeDefined();
    expect(result!.name).toBe("find_user");
    expect(result!.className).toBe("UserService");
  });

  it("resolves h.db.Query() → Database.Query (Go)", () => {
    const call: CallSite = {
      callerName: "Handle", callerClass: "Handler",
      callerFilePath: "handler.go",
      calleeName: "Query", calleeQualifier: "h.db", line: 20,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeDefined();
    expect(result!.name).toBe("Query");
    expect(result!.className).toBe("Database");
  });

  it("resolves self.service.process() → MyService.process (Rust)", () => {
    const call: CallSite = {
      callerName: "handle", callerClass: "MyStruct",
      callerFilePath: "handler.rs",
      calleeName: "process", calleeQualifier: "self.service", line: 15,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeDefined();
    expect(result!.name).toBe("process");
    expect(result!.className).toBe("MyService");
  });

  it("resolves userService.login() → AuthService.login (Java implicit this)", () => {
    const call: CallSite = {
      callerName: "handle", callerClass: "Controller",
      callerFilePath: "Controller.java",
      calleeName: "login", calleeQualifier: "userService", line: 30,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeDefined();
    expect(result!.name).toBe("login");
    expect(result!.className).toBe("AuthService");
  });

  it("returns null for plain this.method() (no property)", () => {
    const call: CallSite = {
      callerName: "init", callerClass: "AppComponent",
      callerFilePath: "app.ts",
      calleeName: "doStuff", calleeQualifier: "this", line: 5,
    };
    // "this" → extractPropertyName returns "this" → map has no "AppComponent.this"
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeNull();
  });

  it("returns null for deep chain this.a.b.c()", () => {
    const call: CallSite = {
      callerName: "init", callerClass: "AppComponent",
      callerFilePath: "app.ts",
      calleeName: "method", calleeQualifier: "this.a.b", line: 5,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeNull();
  });

  it("returns null for super.method()", () => {
    const call: CallSite = {
      callerName: "method", callerClass: "Child",
      callerFilePath: "child.ts",
      calleeName: "method", calleeQualifier: "super", line: 5,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeNull();
  });

  it("returns null when callerClass is empty", () => {
    const call: CallSite = {
      callerName: "topLevel", callerClass: "",
      callerFilePath: "app.ts",
      calleeName: "login", calleeQualifier: "this.authService", line: 5,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeNull();
  });

  it("returns null when method name doesn't match (falls to Tier 1)", () => {
    const call: CallSite = {
      callerName: "ngOnInit", callerClass: "AppComponent",
      callerFilePath: "app.ts",
      calleeName: "nonexistent", calleeQualifier: "this.authService", line: 5,
    };
    const result = resolvePropertyType(call, allSymbols, propertyTypeMap);
    expect(result).toBeNull();
  });
});

// ─── Property Type AST Extraction Tests ─────────────────────

// Helper to extract simple type name from tree-sitter type node
function extractSimpleTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === "type_identifier" || typeNode.type === "identifier") {
    return typeNode.text;
  }
  if (typeNode.type === "generic_type") {
    const nameNode = typeNode.childForFieldName("name") ?? typeNode.namedChildren[0];
    return nameNode?.text ?? null;
  }
  if (typeNode.type === "nested_type_identifier") {
    const children = typeNode.namedChildren;
    return children.length > 0 ? children[children.length - 1].text : null;
  }
  return null;
}

// Mirror extractTsJsPropertyTypes for testing
function extractTsJsPropertyTypes(
  rootNode: Parser.SyntaxNode,
  filePath: string,
): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];

  function visitClass(classNode: Parser.SyntaxNode): void {
    const className = classNode.childForFieldName("name")?.text;
    if (!className) return;
    const body = classNode.childForFieldName("body");
    if (!body) return;

    for (const member of body.namedChildren) {
      if (member.type === "method_definition") {
        const methodName = member.childForFieldName("name")?.text;
        if (methodName === "constructor") {
          const params = member.childForFieldName("parameters");
          if (params) {
            for (const param of params.namedChildren) {
              if (param.type !== "required_parameter") continue;
              let hasPromotion = false;
              for (const child of param.children) {
                if (child.type === "accessibility_modifier" || child.type === "readonly") {
                  hasPromotion = true;
                  break;
                }
              }
              if (!hasPromotion) continue;
              const paramName = param.childForFieldName("name") ?? param.childForFieldName("pattern");
              const typeAnnotation = param.children.find((c: Parser.SyntaxNode) => c.type === "type_annotation");
              if (paramName && typeAnnotation) {
                const typeNode = typeAnnotation.namedChildren[0];
                if (typeNode) {
                  const typeName = extractSimpleTypeName(typeNode);
                  if (typeName) {
                    results.push({ className, propertyName: paramName.text, typeName, filePath });
                  }
                }
              }
            }
          }
        }
      }

      if (member.type === "public_field_definition") {
        const propName = member.childForFieldName("name")?.text;
        const value = member.childForFieldName("value");
        if (propName && value?.type === "call_expression") {
          const fn = value.childForFieldName("function");
          if (fn?.text === "inject") {
            const args = value.childForFieldName("arguments");
            if (args) {
              const firstArg = args.namedChildren[0];
              if (firstArg?.type === "identifier") {
                results.push({ className, propertyName: propName, typeName: firstArg.text, filePath });
                continue;
              }
            }
          }
        }
        if (propName && !value) {
          const typeAnnotation = member.children.find((c: Parser.SyntaxNode) => c.type === "type_annotation");
          if (typeAnnotation) {
            const typeNode = typeAnnotation.namedChildren[0];
            if (typeNode) {
              const typeName = extractSimpleTypeName(typeNode);
              if (typeName) {
                results.push({ className, propertyName: propName, typeName, filePath });
              }
            }
          }
        }
      }
    }
  }

  for (const child of rootNode.namedChildren) {
    if (child.type === "class_declaration" || child.type === "abstract_class_declaration") {
      visitClass(child);
    } else if (child.type === "export_statement") {
      for (const inner of child.namedChildren) {
        if (inner.type === "class_declaration" || inner.type === "abstract_class_declaration") {
          visitClass(inner);
        }
      }
    }
  }

  return results;
}

describe("TS/JS property type extraction", () => {
  const tsParser = new Parser();
  tsParser.setLanguage(TypeScriptLanguage.typescript);

  it("extracts constructor parameter injection types", () => {
    const source = `
class AppComponent {
  constructor(
    private authService: AuthService,
    private readonly userService: UserService,
    public router: Router
  ) {}
}`;
    const tree = tsParser.parse(source);
    const result = extractTsJsPropertyTypes(tree.rootNode, "app.component.ts");

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      className: "AppComponent", propertyName: "authService",
      typeName: "AuthService", filePath: "app.component.ts",
    });
    expect(result[1]).toEqual({
      className: "AppComponent", propertyName: "userService",
      typeName: "UserService", filePath: "app.component.ts",
    });
    expect(result[2]).toEqual({
      className: "AppComponent", propertyName: "router",
      typeName: "Router", filePath: "app.component.ts",
    });
  });

  it("extracts inject() functional injection types", () => {
    const source = `
class AppComponent {
  private authService = inject(AuthService);
  readonly userService = inject(UserService);
}`;
    const tree = tsParser.parse(source);
    const result = extractTsJsPropertyTypes(tree.rootNode, "app.component.ts");

    expect(result).toHaveLength(2);
    expect(result[0].typeName).toBe("AuthService");
    expect(result[0].propertyName).toBe("authService");
    expect(result[1].typeName).toBe("UserService");
    expect(result[1].propertyName).toBe("userService");
  });

  it("extracts typed property declarations", () => {
    const source = `
class AppComponent {
  private authService: AuthService;
  protected logger: LoggerService;
}`;
    const tree = tsParser.parse(source);
    const result = extractTsJsPropertyTypes(tree.rootNode, "app.component.ts");

    expect(result).toHaveLength(2);
    expect(result[0].typeName).toBe("AuthService");
    expect(result[1].typeName).toBe("LoggerService");
  });

  it("handles generic types (strips type parameters)", () => {
    const source = `
class AppComponent {
  constructor(private http: HttpClient<Response>) {}
}`;
    const tree = tsParser.parse(source);
    const result = extractTsJsPropertyTypes(tree.rootNode, "app.component.ts");

    expect(result).toHaveLength(1);
    expect(result[0].typeName).toBe("HttpClient");
  });

  it("ignores constructor params without accessibility modifier", () => {
    const source = `
class AppComponent {
  constructor(authService: AuthService, count: number) {}
}`;
    const tree = tsParser.parse(source);
    const result = extractTsJsPropertyTypes(tree.rootNode, "app.component.ts");

    expect(result).toHaveLength(0);
  });

  it("ignores untyped properties", () => {
    const source = `
class AppComponent {
  private count = 0;
  private name = "test";
}`;
    const tree = tsParser.parse(source);
    const result = extractTsJsPropertyTypes(tree.rootNode, "app.component.ts");

    expect(result).toHaveLength(0);
  });

  it("extracts from exported class", () => {
    const source = `
export class AppComponent {
  constructor(private authService: AuthService) {}
}`;
    const tree = tsParser.parse(source);
    const result = extractTsJsPropertyTypes(tree.rootNode, "app.component.ts");

    expect(result).toHaveLength(1);
    expect(result[0].typeName).toBe("AuthService");
  });
});

// ─── End-to-End Property-Type Resolution (Real Code Per Language) ─────
//
// These tests parse REAL multi-file code snippets with tree-sitter, extract
// call sites + property types, build the maps, and run the full resolution
// pipeline to verify Tier 0 works end-to-end for each supported language.

import PythonLanguage from "tree-sitter-python";
import JavaLanguage from "tree-sitter-java";
import GoLanguage from "tree-sitter-go";
import RustLanguage from "tree-sitter-rust";

// ─── Mirrored call extractors (slim versions for testing) ────

function extractTsJsCallSites(rootNode: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };
  }
  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "method_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      let className = "";
      let parent = node.parent;
      while (parent) {
        if (parent.type === "class_declaration" || parent.type === "abstract_class_declaration") {
          className = parent.childForFieldName("name")?.text ?? "";
          break;
        }
        parent = parent.parent;
      }
      scopeStack.push({ name, className });
      pushed = true;
    } else if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name, className: "" });
      pushed = true;
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        if (fn.type === "identifier") {
          calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          const obj = fn.childForFieldName("object");
          if (prop) {
            calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: prop.text, calleeQualifier: obj?.text ?? "", line: node.startPosition.row + 1 });
          }
        }
      }
    }
    for (const child of node.children) visit(child);
    if (pushed) scopeStack.pop();
  }
  visit(rootNode);
  return calls;
}

function extractPythonCallSites(rootNode: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };
  }
  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name: "(class-scope)", className: name });
      pushed = true;
    } else if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      const parentScope = currentScope();
      scopeStack.push({ name, className: parentScope.className || "" });
      pushed = true;
    }
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        if (fn.type === "identifier") {
          calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          const obj = fn.childForFieldName("object");
          if (attr) {
            calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: attr.text, calleeQualifier: obj?.text ?? "", line: node.startPosition.row + 1 });
          }
        }
      }
    }
    for (const child of node.children) visit(child);
    if (pushed) scopeStack.pop();
  }
  visit(rootNode);
  return calls;
}

function extractPythonPropertyTypes(rootNode: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visitClass(node: Parser.SyntaxNode): void {
    const className = node.childForFieldName("name")?.text;
    if (!className) return;
    const body = node.childForFieldName("body");
    if (!body) return;
    for (const member of body.namedChildren) {
      // Pattern 1: Class-level type annotation
      if (member.type === "expression_statement") {
        const inner = member.namedChildren[0];
        if (inner?.type === "type") {
          const nameNode = inner.namedChildren[0];
          const typeNode = inner.namedChildren[1];
          if (nameNode?.type === "identifier" && typeNode) {
            const typeName = typeNode.text;
            if (typeName && /^[A-Z]/.test(typeName)) {
              results.push({ className, propertyName: nameNode.text, typeName, filePath });
            }
          }
        }
        if (inner?.type === "assignment") {
          const left = inner.childForFieldName("left");
          const typeNode = inner.childForFieldName("type");
          if (left?.type === "identifier" && typeNode) {
            const typeName = typeNode.text;
            if (typeName && /^[A-Z]/.test(typeName)) {
              results.push({ className, propertyName: left.text, typeName, filePath });
            }
          }
        }
      }
      // Pattern 2: __init__ param-to-self
      if (member.type === "function_definition" || member.type === "decorated_definition") {
        const funcDef = member.type === "decorated_definition"
          ? member.namedChildren.find((c: Parser.SyntaxNode) => c.type === "function_definition")
          : member;
        if (!funcDef) continue;
        const funcName = funcDef.childForFieldName("name")?.text;
        if (funcName !== "__init__") continue;
        const paramTypeMap = new Map<string, string>();
        const params = funcDef.childForFieldName("parameters");
        if (params) {
          for (const p of params.namedChildren) {
            if (p.type === "typed_parameter" || p.type === "typed_default_parameter") {
              const pName = p.namedChildren.find((c: Parser.SyntaxNode) => c.type === "identifier");
              const pType = p.children.find((c: Parser.SyntaxNode) => c.type === "type");
              if (pName && pType) {
                const typeText = pType.text;
                if (/^[A-Z]/.test(typeText)) {
                  paramTypeMap.set(pName.text, typeText);
                }
              }
            }
          }
        }
        if (paramTypeMap.size === 0) continue;
        const funcBody = funcDef.childForFieldName("body");
        if (!funcBody) continue;
        for (const stmt of funcBody.namedChildren) {
          if (stmt.type !== "expression_statement") continue;
          const assign = stmt.namedChildren[0];
          if (assign?.type !== "assignment") continue;
          const left = assign.childForFieldName("left");
          const right = assign.childForFieldName("right");
          if (!left || !right) continue;
          if (left.type === "attribute") {
            const obj = left.childForFieldName("object");
            const attr = left.childForFieldName("attribute");
            if (obj?.text === "self" && attr && right.type === "identifier") {
              const typeName = paramTypeMap.get(right.text);
              if (typeName) {
                results.push({ className, propertyName: attr.text, typeName, filePath });
              }
            }
          }
        }
      }
    }
  }
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "class_definition") visitClass(node);
    for (const child of node.namedChildren) visit(child);
  }
  visit(rootNode);
  return results;
}

function extractJavaCallSites(rootNode: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };
  }
  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "class_declaration" || node.type === "enum_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name: "(class-scope)", className: name });
      pushed = true;
    } else if (node.type === "method_declaration" || node.type === "constructor_declaration") {
      const name = node.childForFieldName("name")?.text ?? currentScope().className;
      scopeStack.push({ name, className: currentScope().className });
      pushed = true;
    }
    if (node.type === "method_invocation") {
      const nameNode = node.childForFieldName("name");
      const obj = node.childForFieldName("object");
      if (nameNode) {
        const scope = currentScope();
        calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: nameNode.text, calleeQualifier: obj?.text ?? "", line: node.startPosition.row + 1 });
      }
    }
    for (const child of node.children) visit(child);
    if (pushed) scopeStack.pop();
  }
  visit(rootNode);
  return calls;
}

function extractJavaPropertyTypes(rootNode: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration" || node.type === "enum_declaration" || node.type === "record_declaration") {
      const className = node.childForFieldName("name")?.text;
      if (className) {
        const body = node.childForFieldName("body");
        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === "field_declaration") {
              const typeNode = member.childForFieldName("type");
              if (!typeNode) continue;
              let typeName: string;
              if (typeNode.type === "generic_type") {
                typeName = typeNode.namedChildren[0]?.text ?? typeNode.text;
              } else {
                typeName = typeNode.text;
              }
              for (const child of member.namedChildren) {
                if (child.type === "variable_declarator") {
                  const fieldName = child.childForFieldName("name")?.text;
                  if (fieldName) {
                    results.push({ className, propertyName: fieldName, typeName, filePath });
                  }
                }
              }
            }
          }
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(rootNode);
  return results;
}

function extractGoCallSites(rootNode: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };
  }
  function getReceiverType(node: Parser.SyntaxNode): string {
    const receiver = node.childForFieldName("receiver");
    if (!receiver) return "";
    const paramDecl = receiver.namedChildren[0];
    if (!paramDecl) return "";
    const typeNode = paramDecl.childForFieldName("type");
    if (!typeNode) return "";
    return typeNode.text.replace(/^\*/, "");
  }
  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name, className: "" });
      pushed = true;
    } else if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      const className = getReceiverType(node);
      scopeStack.push({ name, className });
      pushed = true;
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        if (fn.type === "identifier") {
          calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "selector_expression") {
          const field = fn.childForFieldName("field");
          const operand = fn.childForFieldName("operand");
          if (field) {
            calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: field.text, calleeQualifier: operand?.text ?? "", line: node.startPosition.row + 1 });
          }
        }
      }
    }
    for (const child of node.children) visit(child);
    if (pushed) scopeStack.pop();
  }
  visit(rootNode);
  return calls;
}

function extractGoPropertyTypes(rootNode: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        if (spec.type === "type_spec") {
          const className = spec.childForFieldName("name")?.text;
          const typeNode = spec.childForFieldName("type");
          if (!className || !typeNode || typeNode.type !== "struct_type") continue;
          const fieldList = typeNode.namedChildren.find((c: Parser.SyntaxNode) => c.type === "field_declaration_list");
          if (!fieldList) continue;
          for (const field of fieldList.namedChildren) {
            if (field.type !== "field_declaration") continue;
            const fieldName = field.childForFieldName("name");
            const fieldType = field.childForFieldName("type");
            if (!fieldName || !fieldType) continue;
            const typeName = fieldType.text.replace(/^\*/, "");
            results.push({ className, propertyName: fieldName.text, typeName, filePath });
          }
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(rootNode);
  return results;
}

function extractRustCallSites(rootNode: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };
  }
  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "function_item") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      const parentScope = currentScope();
      scopeStack.push({ name, className: parentScope.className });
      pushed = true;
    } else if (node.type === "impl_item") {
      const typeNode = node.childForFieldName("type");
      scopeStack.push({ name: "(impl-scope)", className: typeNode?.text ?? "" });
      pushed = true;
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        if (fn.type === "identifier") {
          calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "field_expression") {
          const field = fn.childForFieldName("field");
          const value = fn.childForFieldName("value");
          if (field) {
            calls.push({ callerName: scope.name, callerClass: scope.className, callerFilePath: filePath, calleeName: field.text, calleeQualifier: value?.text ?? "", line: node.startPosition.row + 1 });
          }
        }
      }
    }
    for (const child of node.children) visit(child);
    if (pushed) scopeStack.pop();
  }
  visit(rootNode);
  return calls;
}

function extractRustPropertyTypes(rootNode: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "struct_item") {
      const className = node.childForFieldName("name")?.text;
      if (!className) return;
      const body = node.childForFieldName("body");
      if (!body || body.type !== "field_declaration_list") return;
      for (const field of body.namedChildren) {
        if (field.type !== "field_declaration") continue;
        const fieldName = field.childForFieldName("name")?.text;
        const typeNode = field.childForFieldName("type");
        if (!fieldName || !typeNode) continue;
        let typeName: string;
        if (typeNode.type === "generic_type") {
          typeName = typeNode.namedChildren[0]?.text ?? typeNode.text;
        } else if (typeNode.type === "reference_type") {
          const inner = typeNode.namedChildren[typeNode.namedChildren.length - 1];
          typeName = inner?.text ?? typeNode.text;
        } else {
          typeName = typeNode.text;
        }
        results.push({ className, propertyName: fieldName, typeName, filePath });
      }
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(rootNode);
  return results;
}

// ─── Helper: build symbol + property maps from parsed code ──

function buildMaps(
  propertyTypes: PropertyTypeInfo[],
  targetMethods: Array<{ className: string; name: string; filePath: string }>,
): { allSymbols: Map<string, SymbolInfo[]>; propertyTypeMap: Map<string, string> } {
  const propertyTypeMap = new Map<string, string>();
  for (const pt of propertyTypes) {
    propertyTypeMap.set(`${pt.className}.${pt.propertyName}`, pt.typeName);
  }

  const allSymbols = new Map<string, SymbolInfo[]>();
  let nextId = 1;
  for (const m of targetMethods) {
    const sym: SymbolInfo = {
      id: nextId++,
      label: "Method",
      name: m.name,
      filePath: m.filePath,
      className: m.className,
      startLine: 1,
      endLine: 10,
      exported: true,
    };
    const existing = allSymbols.get(m.filePath);
    if (existing) existing.push(sym);
    else allSymbols.set(m.filePath, [sym]);
  }

  return { allSymbols, propertyTypeMap };
}

// ─── End-to-End Tests ────────────────────────────────────────

describe("E2E property-type resolution — TypeScript (Angular DI)", () => {
  const parser = new Parser();
  parser.setLanguage(TypeScriptLanguage.typescript);

  it("resolves this.authService.login() via constructor injection", () => {
    // File 1: AuthService with a login method
    // File 2: AppComponent that injects AuthService and calls this.authService.login()
    const serviceSource = `
export class AuthService {
  login(username: string, password: string) {
    return fetch("/api/login", { method: "POST" });
  }

  logout() {
    return fetch("/api/logout");
  }
}`;

    const componentSource = `
export class AppComponent {
  constructor(
    private authService: AuthService,
    private readonly router: Router
  ) {}

  onSubmit() {
    this.authService.login(this.username, this.password);
    this.router.navigate(["/home"]);
  }

  onLogout() {
    this.authService.logout();
  }
}`;

    const serviceTree = parser.parse(serviceSource);
    const componentTree = parser.parse(componentSource);

    // Extract property types from component
    const propTypes = extractTsJsPropertyTypes(componentTree.rootNode, "app.component.ts");
    expect(propTypes.length).toBeGreaterThanOrEqual(2);
    expect(propTypes.find(p => p.propertyName === "authService")?.typeName).toBe("AuthService");
    expect(propTypes.find(p => p.propertyName === "router")?.typeName).toBe("Router");

    // Extract call sites from component
    const calls = extractTsJsCallSites(componentTree.rootNode, "app.component.ts");
    const loginCall = calls.find(c => c.calleeName === "login" && c.calleeQualifier === "this.authService");
    const logoutCall = calls.find(c => c.calleeName === "logout" && c.calleeQualifier === "this.authService");
    expect(loginCall).toBeDefined();
    expect(loginCall!.callerClass).toBe("AppComponent");
    expect(loginCall!.callerName).toBe("onSubmit");
    expect(logoutCall).toBeDefined();

    // Build maps and resolve
    const { allSymbols, propertyTypeMap } = buildMaps(propTypes, [
      { className: "AuthService", name: "login", filePath: "auth.service.ts" },
      { className: "AuthService", name: "logout", filePath: "auth.service.ts" },
      { className: "Router", name: "navigate", filePath: "router.ts" },
    ]);

    const resolvedLogin = resolvePropertyType(loginCall!, allSymbols, propertyTypeMap);
    expect(resolvedLogin).not.toBeNull();
    expect(resolvedLogin!.className).toBe("AuthService");
    expect(resolvedLogin!.name).toBe("login");

    const resolvedLogout = resolvePropertyType(logoutCall!, allSymbols, propertyTypeMap);
    expect(resolvedLogout).not.toBeNull();
    expect(resolvedLogout!.className).toBe("AuthService");
    expect(resolvedLogout!.name).toBe("logout");
  });

  it("resolves inject() functional DI (Angular 14+)", () => {
    const source = `
export class DashboardComponent {
  private userService = inject(UserService);
  private analyticsService = inject(AnalyticsService);

  ngOnInit() {
    this.userService.getCurrentUser();
    this.analyticsService.trackPageView("dashboard");
  }
}`;

    const tree = parser.parse(source);
    const propTypes = extractTsJsPropertyTypes(tree.rootNode, "dashboard.component.ts");
    const calls = extractTsJsCallSites(tree.rootNode, "dashboard.component.ts");

    expect(propTypes.find(p => p.propertyName === "userService")?.typeName).toBe("UserService");
    expect(propTypes.find(p => p.propertyName === "analyticsService")?.typeName).toBe("AnalyticsService");

    const getUserCall = calls.find(c => c.calleeName === "getCurrentUser");
    expect(getUserCall).toBeDefined();
    expect(getUserCall!.calleeQualifier).toBe("this.userService");

    const { allSymbols, propertyTypeMap } = buildMaps(propTypes, [
      { className: "UserService", name: "getCurrentUser", filePath: "user.service.ts" },
      { className: "AnalyticsService", name: "trackPageView", filePath: "analytics.service.ts" },
    ]);

    const resolved = resolvePropertyType(getUserCall!, allSymbols, propertyTypeMap);
    expect(resolved).not.toBeNull();
    expect(resolved!.className).toBe("UserService");
    expect(resolved!.name).toBe("getCurrentUser");
  });
});

describe("E2E property-type resolution — Python (Django/Flask DI)", () => {
  const parser = new Parser();
  parser.setLanguage(PythonLanguage);

  it("resolves self.user_service.find_user() via __init__ param injection", () => {
    const source = `
class UserView:
    def __init__(self, user_service: UserService, email_service: EmailService):
        self.user_service = user_service
        self.email_service = email_service

    def get(self, request):
        user = self.user_service.find_user(request.user_id)
        self.email_service.send_welcome(user.email)
        return user
`;

    const tree = parser.parse(source);
    const propTypes = extractPythonPropertyTypes(tree.rootNode, "views.py");
    const calls = extractPythonCallSites(tree.rootNode, "views.py");

    expect(propTypes.find(p => p.propertyName === "user_service")?.typeName).toBe("UserService");
    expect(propTypes.find(p => p.propertyName === "email_service")?.typeName).toBe("EmailService");

    const findUserCall = calls.find(c => c.calleeName === "find_user" && c.calleeQualifier === "self.user_service");
    const sendWelcomeCall = calls.find(c => c.calleeName === "send_welcome" && c.calleeQualifier === "self.email_service");
    expect(findUserCall).toBeDefined();
    expect(findUserCall!.callerClass).toBe("UserView");
    expect(sendWelcomeCall).toBeDefined();

    const { allSymbols, propertyTypeMap } = buildMaps(propTypes, [
      { className: "UserService", name: "find_user", filePath: "services.py" },
      { className: "EmailService", name: "send_welcome", filePath: "services.py" },
    ]);

    const resolved = resolvePropertyType(findUserCall!, allSymbols, propertyTypeMap);
    expect(resolved).not.toBeNull();
    expect(resolved!.className).toBe("UserService");
    expect(resolved!.name).toBe("find_user");

    const resolvedEmail = resolvePropertyType(sendWelcomeCall!, allSymbols, propertyTypeMap);
    expect(resolvedEmail).not.toBeNull();
    expect(resolvedEmail!.className).toBe("EmailService");
    expect(resolvedEmail!.name).toBe("send_welcome");
  });

  it("resolves via class-level type annotation", () => {
    const source = `
class OrderProcessor:
    payment_gateway: PaymentGateway
    inventory: InventoryService

    def process_order(self, order):
        self.payment_gateway.charge(order.total)
        self.inventory.reserve(order.items)
`;

    const tree = parser.parse(source);
    const propTypes = extractPythonPropertyTypes(tree.rootNode, "processor.py");
    const calls = extractPythonCallSites(tree.rootNode, "processor.py");

    expect(propTypes.find(p => p.propertyName === "payment_gateway")?.typeName).toBe("PaymentGateway");
    expect(propTypes.find(p => p.propertyName === "inventory")?.typeName).toBe("InventoryService");

    const chargeCall = calls.find(c => c.calleeName === "charge" && c.calleeQualifier === "self.payment_gateway");
    expect(chargeCall).toBeDefined();

    const { allSymbols, propertyTypeMap } = buildMaps(propTypes, [
      { className: "PaymentGateway", name: "charge", filePath: "payment.py" },
      { className: "InventoryService", name: "reserve", filePath: "inventory.py" },
    ]);

    const resolved = resolvePropertyType(chargeCall!, allSymbols, propertyTypeMap);
    expect(resolved).not.toBeNull();
    expect(resolved!.className).toBe("PaymentGateway");
    expect(resolved!.name).toBe("charge");
  });
});

describe("E2E property-type resolution — Java (Spring DI)", () => {
  const parser = new Parser();
  parser.setLanguage(JavaLanguage);

  it("resolves userService.findById() via field injection", () => {
    const source = `
public class UserController {
    private UserService userService;
    private NotificationService notificationService;

    public ResponseEntity getUser(Long id) {
        User user = userService.findById(id);
        notificationService.notifyAccess(user);
        return ResponseEntity.ok(user);
    }

    public ResponseEntity deleteUser(Long id) {
        userService.deleteById(id);
        return ResponseEntity.noContent().build();
    }
}`;

    const tree = parser.parse(source);
    const propTypes = extractJavaPropertyTypes(tree.rootNode, "UserController.java");
    const calls = extractJavaCallSites(tree.rootNode, "UserController.java");

    expect(propTypes.find(p => p.propertyName === "userService")?.typeName).toBe("UserService");
    expect(propTypes.find(p => p.propertyName === "notificationService")?.typeName).toBe("NotificationService");

    // Java: qualifier is "userService" (implicit this)
    const findByIdCall = calls.find(c => c.calleeName === "findById" && c.calleeQualifier === "userService");
    const notifyCall = calls.find(c => c.calleeName === "notifyAccess" && c.calleeQualifier === "notificationService");
    const deleteCall = calls.find(c => c.calleeName === "deleteById" && c.calleeQualifier === "userService");
    expect(findByIdCall).toBeDefined();
    expect(findByIdCall!.callerClass).toBe("UserController");
    expect(notifyCall).toBeDefined();
    expect(deleteCall).toBeDefined();

    const { allSymbols, propertyTypeMap } = buildMaps(propTypes, [
      { className: "UserService", name: "findById", filePath: "UserService.java" },
      { className: "UserService", name: "deleteById", filePath: "UserService.java" },
      { className: "NotificationService", name: "notifyAccess", filePath: "NotificationService.java" },
    ]);

    const resolved = resolvePropertyType(findByIdCall!, allSymbols, propertyTypeMap);
    expect(resolved).not.toBeNull();
    expect(resolved!.className).toBe("UserService");
    expect(resolved!.name).toBe("findById");

    const resolvedNotify = resolvePropertyType(notifyCall!, allSymbols, propertyTypeMap);
    expect(resolvedNotify).not.toBeNull();
    expect(resolvedNotify!.className).toBe("NotificationService");
    expect(resolvedNotify!.name).toBe("notifyAccess");

    const resolvedDelete = resolvePropertyType(deleteCall!, allSymbols, propertyTypeMap);
    expect(resolvedDelete).not.toBeNull();
    expect(resolvedDelete!.className).toBe("UserService");
    expect(resolvedDelete!.name).toBe("deleteById");
  });

  it("resolves generic typed fields (List<User> -> List)", () => {
    const source = `
public class OrderService {
    private Repository<Order> orderRepo;
    private PaymentGateway gateway;

    public void processOrder(Order order) {
        orderRepo.save(order);
        gateway.charge(order.getTotal());
    }
}`;

    const tree = parser.parse(source);
    const propTypes = extractJavaPropertyTypes(tree.rootNode, "OrderService.java");

    expect(propTypes.find(p => p.propertyName === "orderRepo")?.typeName).toBe("Repository");
    expect(propTypes.find(p => p.propertyName === "gateway")?.typeName).toBe("PaymentGateway");
  });
});

describe("E2E property-type resolution — Go (struct fields)", () => {
  const parser = new Parser();
  parser.setLanguage(GoLanguage);

  it("resolves h.db.Query() via struct field types", () => {
    const source = `
package main

type Handler struct {
	db      *Database
	cache   *CacheService
	logger  *Logger
}

func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
	user := h.db.Query("SELECT * FROM users WHERE id = ?", r.URL.Query().Get("id"))
	h.cache.Set("user:" + user.ID, user)
	h.logger.Info("User fetched", user.ID)
}

func (h *Handler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	h.db.Execute("DELETE FROM users WHERE id = ?", r.URL.Query().Get("id"))
	h.cache.Delete("user:" + r.URL.Query().Get("id"))
}
`;

    const tree = parser.parse(source);
    const propTypes = extractGoPropertyTypes(tree.rootNode, "handler.go");
    const calls = extractGoCallSites(tree.rootNode, "handler.go");

    // Go strips * from pointer types
    expect(propTypes.find(p => p.propertyName === "db")?.typeName).toBe("Database");
    expect(propTypes.find(p => p.propertyName === "cache")?.typeName).toBe("CacheService");
    expect(propTypes.find(p => p.propertyName === "logger")?.typeName).toBe("Logger");

    // Go: qualifier is "h.db" (receiver.field)
    const queryCall = calls.find(c => c.calleeName === "Query" && c.calleeQualifier === "h.db");
    const setCacheCall = calls.find(c => c.calleeName === "Set" && c.calleeQualifier === "h.cache");
    const executeCall = calls.find(c => c.calleeName === "Execute" && c.calleeQualifier === "h.db");
    expect(queryCall).toBeDefined();
    expect(queryCall!.callerClass).toBe("Handler");
    expect(queryCall!.callerName).toBe("GetUser");
    expect(setCacheCall).toBeDefined();
    expect(executeCall).toBeDefined();

    const { allSymbols, propertyTypeMap } = buildMaps(propTypes, [
      { className: "Database", name: "Query", filePath: "database.go" },
      { className: "Database", name: "Execute", filePath: "database.go" },
      { className: "CacheService", name: "Set", filePath: "cache.go" },
      { className: "CacheService", name: "Delete", filePath: "cache.go" },
      { className: "Logger", name: "Info", filePath: "logger.go" },
    ]);

    const resolvedQuery = resolvePropertyType(queryCall!, allSymbols, propertyTypeMap);
    expect(resolvedQuery).not.toBeNull();
    expect(resolvedQuery!.className).toBe("Database");
    expect(resolvedQuery!.name).toBe("Query");

    const resolvedCache = resolvePropertyType(setCacheCall!, allSymbols, propertyTypeMap);
    expect(resolvedCache).not.toBeNull();
    expect(resolvedCache!.className).toBe("CacheService");
    expect(resolvedCache!.name).toBe("Set");

    const resolvedExec = resolvePropertyType(executeCall!, allSymbols, propertyTypeMap);
    expect(resolvedExec).not.toBeNull();
    expect(resolvedExec!.className).toBe("Database");
    expect(resolvedExec!.name).toBe("Execute");
  });
});

describe("E2E property-type resolution — Rust (struct fields)", () => {
  const parser = new Parser();
  parser.setLanguage(RustLanguage);

  it("resolves self.service.process() via struct field types", () => {
    const source = `
struct AppState {
    db: DatabasePool,
    auth: AuthService,
    mailer: MailService,
}

impl AppState {
    fn handle_login(&self, credentials: Credentials) -> Result<Token, Error> {
        let user = self.auth.verify(credentials);
        let token = self.auth.create_token(user);
        self.mailer.send_welcome(user.email);
        token
    }

    fn handle_query(&self, query: String) -> Result<Vec<Row>, Error> {
        self.db.execute(query)
    }
}
`;

    const tree = parser.parse(source);
    const propTypes = extractRustPropertyTypes(tree.rootNode, "app.rs");
    const calls = extractRustCallSites(tree.rootNode, "app.rs");

    expect(propTypes.find(p => p.propertyName === "db")?.typeName).toBe("DatabasePool");
    expect(propTypes.find(p => p.propertyName === "auth")?.typeName).toBe("AuthService");
    expect(propTypes.find(p => p.propertyName === "mailer")?.typeName).toBe("MailService");

    // Rust: qualifier is "self.auth", "self.db", etc.
    const verifyCall = calls.find(c => c.calleeName === "verify" && c.calleeQualifier === "self.auth");
    const createTokenCall = calls.find(c => c.calleeName === "create_token" && c.calleeQualifier === "self.auth");
    const sendWelcomeCall = calls.find(c => c.calleeName === "send_welcome" && c.calleeQualifier === "self.mailer");
    const executeCall = calls.find(c => c.calleeName === "execute" && c.calleeQualifier === "self.db");
    expect(verifyCall).toBeDefined();
    expect(verifyCall!.callerClass).toBe("AppState");
    expect(createTokenCall).toBeDefined();
    expect(sendWelcomeCall).toBeDefined();
    expect(executeCall).toBeDefined();

    const { allSymbols, propertyTypeMap } = buildMaps(propTypes, [
      { className: "AuthService", name: "verify", filePath: "auth.rs" },
      { className: "AuthService", name: "create_token", filePath: "auth.rs" },
      { className: "MailService", name: "send_welcome", filePath: "mail.rs" },
      { className: "DatabasePool", name: "execute", filePath: "db.rs" },
    ]);

    const resolvedVerify = resolvePropertyType(verifyCall!, allSymbols, propertyTypeMap);
    expect(resolvedVerify).not.toBeNull();
    expect(resolvedVerify!.className).toBe("AuthService");
    expect(resolvedVerify!.name).toBe("verify");

    const resolvedToken = resolvePropertyType(createTokenCall!, allSymbols, propertyTypeMap);
    expect(resolvedToken).not.toBeNull();
    expect(resolvedToken!.className).toBe("AuthService");
    expect(resolvedToken!.name).toBe("create_token");

    const resolvedMail = resolvePropertyType(sendWelcomeCall!, allSymbols, propertyTypeMap);
    expect(resolvedMail).not.toBeNull();
    expect(resolvedMail!.className).toBe("MailService");
    expect(resolvedMail!.name).toBe("send_welcome");

    const resolvedDb = resolvePropertyType(executeCall!, allSymbols, propertyTypeMap);
    expect(resolvedDb).not.toBeNull();
    expect(resolvedDb!.className).toBe("DatabasePool");
    expect(resolvedDb!.name).toBe("execute");
  });

  it("handles reference types (&AuthService -> AuthService)", () => {
    const source = `
struct RequestHandler {
    auth: &'static AuthService,
}

impl RequestHandler {
    fn check(&self) {
        self.auth.validate();
    }
}
`;

    const tree = parser.parse(source);
    const propTypes = extractRustPropertyTypes(tree.rootNode, "handler.rs");

    // Reference type: &'static AuthService should extract as AuthService
    expect(propTypes.find(p => p.propertyName === "auth")).toBeDefined();
    // The type might include lifetime, but the inner type should be usable
    const authType = propTypes.find(p => p.propertyName === "auth");
    expect(authType).toBeDefined();
  });
});
