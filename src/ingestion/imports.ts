import fsp from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/connection.js";
import { cypherWithClient } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import { detectLanguage } from "./structure.js";
import type { ExtractResult, ProgressCallback } from "./extract.js";

const logger = createChildLogger("imports");

// ─── Types ──────────────────────────────────────────────────

interface RawImport {
  specifier: string;
}

export interface ImportResult {
  importsEdgeCount: number;
  filesProcessed: number;
  importsExtracted: number;
  importsResolved: number;
}

// ─── File Index ─────────────────────────────────────────────

class FileIndex {
  private paths: Set<string>;
  private dirToFiles: Map<string, string[]>;
  private suffixMap: Map<string, string[]>;
  private suffixMapLower: Map<string, string[]>;

  constructor(relativePaths: string[]) {
    this.paths = new Set(relativePaths);
    this.dirToFiles = new Map();
    this.suffixMap = new Map();
    this.suffixMapLower = new Map();

    for (const p of relativePaths) {
      const dir = path.dirname(p);
      const normalizedDir = dir === "." ? "" : dir;
      const existing = this.dirToFiles.get(normalizedDir);
      if (existing) {
        existing.push(p);
      } else {
        this.dirToFiles.set(normalizedDir, [p]);
      }

      // Build suffix index for O(1) lookups by any path suffix
      const segments = p.split("/");
      for (let i = 0; i < segments.length; i++) {
        const suffix = segments.slice(i).join("/");
        // Case-sensitive
        const arr = this.suffixMap.get(suffix);
        if (arr) arr.push(p);
        else this.suffixMap.set(suffix, [p]);
        // Case-insensitive
        const lower = suffix.toLowerCase();
        const arrLower = this.suffixMapLower.get(lower);
        if (arrLower) arrLower.push(p);
        else this.suffixMapLower.set(lower, [p]);
      }
    }
  }

  has(relativePath: string): boolean {
    return this.paths.has(relativePath);
  }

  getFilesInDir(dirPath: string): string[] {
    return this.dirToFiles.get(dirPath) ?? [];
  }

  tryResolve(basePath: string, extensions: string[]): string | null {
    const normalized = basePath.split(path.sep).join("/");

    if (this.paths.has(normalized)) return normalized;

    for (const ext of extensions) {
      const withExt = normalized + ext;
      if (this.paths.has(withExt)) return withExt;
    }

    for (const ext of extensions) {
      const indexPath = normalized + "/index" + ext;
      if (this.paths.has(indexPath)) return indexPath;
    }

    return null;
  }

  /**
   * O(1) suffix lookup. Returns all files whose path ends with the given suffix.
   * Example: findBySuffix("format.ts") → ["src/core/utils/format.ts"]
   */
  findBySuffix(suffix: string): string[] {
    return this.suffixMap.get(suffix) ?? [];
  }

  /**
   * Case-insensitive suffix lookup.
   */
  findBySuffixIgnoreCase(suffix: string): string[] {
    return this.suffixMapLower.get(suffix.toLowerCase()) ?? [];
  }
}

// ─── tsconfig.json Path Aliases ─────────────────────────────

interface TsPathMapping {
  pattern: RegExp;
  replacements: string[];
}

interface TsConfig {
  baseUrl: string;
  mappings: TsPathMapping[];
}

async function loadTsConfig(rootDir: string): Promise<TsConfig | null> {
  const tsconfigPath = path.join(rootDir, "tsconfig.json");
  let content: string;
  try {
    content = await fsp.readFile(tsconfigPath, "utf-8");
  } catch {
    return null;
  }

  try {
    // Strip JSONC comments
    const stripped = content
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const parsed = JSON.parse(stripped);

    const compilerOptions = parsed.compilerOptions;
    if (!compilerOptions) return null;

    const baseUrl = compilerOptions.baseUrl || ".";
    const paths = compilerOptions.paths as
      | Record<string, string[]>
      | undefined;

    if (!paths) return { baseUrl, mappings: [] };

    const mappings: TsPathMapping[] = [];
    for (const [key, replacements] of Object.entries(paths)) {
      const escaped = key
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, "(.*)");
      mappings.push({
        pattern: new RegExp(`^${escaped}$`),
        replacements,
      });
    }

    return { baseUrl, mappings };
  } catch (err) {
    logger.warn({ tsconfigPath, err }, "Failed to parse tsconfig.json");
    return null;
  }
}

// ─── Go Module Path ─────────────────────────────────────────

async function loadGoModulePath(rootDir: string): Promise<string | null> {
  const goModPath = path.join(rootDir, "go.mod");
  try {
    const content = await fsp.readFile(goModPath, "utf-8");
    const match = content.match(/^module\s+(\S+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ─── Java Source Root Detection ─────────────────────────────

function detectJavaSourceRoots(fileIndex: FileIndex): string[] {
  const roots: string[] = [];
  // Check common Java source root patterns
  const candidates = [
    "src/main/java",
    "src/main/kotlin",
    "src/test/java",
    "src",
    "",
  ];
  for (const candidate of candidates) {
    if (fileIndex.getFilesInDir(candidate).some((f) => f.endsWith(".java"))) {
      roots.push(candidate);
    }
  }
  return roots.length > 0 ? roots : [""];
}

// ─── Import Extractors (per language) ───────────────────────

function extractTsJsImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  for (const line of lines) {
    // from "specifier" (covers import/export with from clause)
    let match = line.match(/\bfrom\s+['"]([^'"]+)['"]/);
    if (match) {
      add(match[1]);
      continue;
    }

    // import "specifier" (side-effect import)
    match = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
    if (match) {
      add(match[1]);
      continue;
    }

    // require("specifier")
    match = line.match(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (match) {
      add(match[1]);
      continue;
    }

    // Dynamic import("specifier")
    match = line.match(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (match) {
      add(match[1]);
    }
  }

  function add(specifier: string) {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      imports.push({ specifier });
    }
  }

  return imports;
}

function extractPythonImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // from .module import X or from ..module import X or from module import X
    let match = trimmed.match(/^from\s+(\.{0,10}[\w.]*)\s+import/);
    if (match && match[1]) {
      add(match[1]);
      continue;
    }

    // import module or import module.submodule (skip "import" alone)
    match = trimmed.match(/^import\s+([\w.]+)/);
    if (match) {
      add(match[1]);
    }
  }

  function add(specifier: string) {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      imports.push({ specifier });
    }
  }

  return imports;
}

function extractRustImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  let blockBase: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // End of a use block
    if (blockBase !== null) {
      if (trimmed.includes("}")) {
        blockBase = null;
        continue;
      }
      // Extract item from block: "  module::Item,"
      const itemMatch = trimmed.match(/^([\w:]+)/);
      if (itemMatch) {
        const fullPath = blockBase + "::" + itemMatch[1].replace(/,$/, "");
        add(fullPath);
      }
      continue;
    }

    // use crate::module::{...} block start
    let match = trimmed.match(
      /^(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)*)::\{/,
    );
    if (match) {
      blockBase = match[1];
      // Check if the block closes on the same line
      const closeIdx = trimmed.indexOf("}");
      if (closeIdx !== -1) {
        const blockContent = trimmed.slice(trimmed.indexOf("{") + 1, closeIdx);
        for (const item of blockContent.split(",")) {
          const clean = item.trim();
          if (clean) {
            add(blockBase + "::" + clean);
          }
        }
        blockBase = null;
      }
      continue;
    }

    // Single-line use: use crate::module::Item;
    match = trimmed.match(
      /^(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/,
    );
    if (match) {
      add(match[1]);
      continue;
    }

    // mod declarations: mod module_name;
    match = trimmed.match(/^(?:pub\s+)?mod\s+(\w+)\s*;/);
    if (match) {
      add("mod:" + match[1]);
      continue;
    }
  }

  function add(specifier: string) {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      imports.push({ specifier });
    }
  }

  return imports;
}

function extractGoImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inBlock) {
      if (trimmed === ")") {
        inBlock = false;
        continue;
      }
      // Individual import line: optional alias + "path"
      const match = trimmed.match(/(?:\w+\s+)?"([^"]+)"/);
      if (match) {
        add(match[1]);
      }
      continue;
    }

    // import ( — start block
    if (trimmed.startsWith("import") && trimmed.includes("(")) {
      inBlock = true;
      continue;
    }

    // Single import: import "path" or import alias "path"
    const match = trimmed.match(/^import\s+(?:\w+\s+)?"([^"]+)"/);
    if (match) {
      add(match[1]);
    }
  }

  function add(specifier: string) {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      imports.push({ specifier });
    }
  }

  return imports;
}

function extractJavaImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const lines = source.split("\n");

  for (const line of lines) {
    const match = line
      .trim()
      .match(/^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/);
    if (match) {
      imports.push({ specifier: match[1] });
    }
  }

  return imports;
}

function extractCSharpImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const lines = source.split("\n");

  for (const line of lines) {
    const match = line
      .trim()
      .match(/^using\s+(?:static\s+)?([\w.]+)\s*;/);
    if (match) {
      // Skip common system namespaces
      const ns = match[1];
      if (!ns.startsWith("System") && !ns.startsWith("Microsoft")) {
        imports.push({ specifier: ns });
      }
    }
  }

  return imports;
}

function extractCppImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  for (const line of lines) {
    // #include "local/header.h" — project-relative
    let match = line.match(/^\s*#\s*include\s+"([^"]+)"/);
    if (match) {
      add(match[1]);
      continue;
    }

    // #include <possibly/local/header.h> — might be project header
    match = line.match(/^\s*#\s*include\s+<([^>]+)>/);
    if (match) {
      add("angle:" + match[1]);
    }
  }

  function add(specifier: string) {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      imports.push({ specifier });
    }
  }

  return imports;
}

function extractRubyImports(source: string): RawImport[] {
  const imports: RawImport[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // require_relative "path" (more specific, check first)
    let match = trimmed.match(/\brequire_relative\s+['"]([^'"]+)['"]/);
    if (match) {
      add("relative:" + match[1]);
      continue;
    }

    // require "path"
    match = trimmed.match(/\brequire\s+['"]([^'"]+)['"]/);
    if (match) {
      add(match[1]);
    }
  }

  function add(specifier: string) {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      imports.push({ specifier });
    }
  }

  return imports;
}

// ─── Import Resolvers (per language) ────────────────────────

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];

function resolveTsJsImport(
  specifier: string,
  fromFile: string,
  fileIndex: FileIndex,
  tsConfig: TsConfig | null,
  language: string,
): string | null {
  const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
  const extensions = language === "typescript" ? TS_EXTENSIONS : JS_EXTENSIONS;

  if (isRelative) {
    const dir = path.dirname(fromFile);
    let resolved = path.join(dir, specifier);
    resolved = path.normalize(resolved).split(path.sep).join("/");

    // ESM convention: .js extensions may point to .ts source files
    if (specifier.endsWith(".js")) {
      const withoutJs = resolved.slice(0, -3);
      if (fileIndex.has(withoutJs + ".ts")) return withoutJs + ".ts";
      if (fileIndex.has(withoutJs + ".tsx")) return withoutJs + ".tsx";
    }
    if (specifier.endsWith(".mjs")) {
      const withoutMjs = resolved.slice(0, -4);
      if (fileIndex.has(withoutMjs + ".mts")) return withoutMjs + ".mts";
    }
    if (specifier.endsWith(".cjs")) {
      const withoutCjs = resolved.slice(0, -4);
      if (fileIndex.has(withoutCjs + ".cts")) return withoutCjs + ".cts";
    }

    return fileIndex.tryResolve(resolved, extensions);
  }

  // Try tsconfig path aliases
  if (tsConfig) {
    for (const mapping of tsConfig.mappings) {
      const match = specifier.match(mapping.pattern);
      if (match) {
        const captured = match[1] || "";
        for (const replacement of mapping.replacements) {
          const expanded = replacement.replace("*", captured);
          let resolvedPath = path.join(tsConfig.baseUrl, expanded);
          resolvedPath = path.normalize(resolvedPath).split(path.sep).join("/");

          const result = fileIndex.tryResolve(resolvedPath, extensions);
          if (result) return result;
        }
      }
    }
  }

  // Bare specifier — skip (node_modules / external)
  return null;
}

function resolvePythonImport(
  specifier: string,
  fromFile: string,
  fileIndex: FileIndex,
): string | null {
  // Count leading dots for relative imports
  let dots = 0;
  while (dots < specifier.length && specifier[dots] === ".") dots++;

  const modulePart = specifier.slice(dots);
  const modulePath = modulePart.replace(/\./g, "/");

  if (dots > 0) {
    // Relative import
    let dir = path.dirname(fromFile);
    for (let i = 1; i < dots; i++) {
      dir = path.dirname(dir);
      if (dir === ".") dir = "";
    }

    if (modulePath) {
      const resolved = dir ? dir + "/" + modulePath : modulePath;

      // Try module.py
      if (fileIndex.has(resolved + ".py")) return resolved + ".py";
      // Try module/__init__.py
      if (fileIndex.has(resolved + "/__init__.py"))
        return resolved + "/__init__.py";
    } else {
      // from . import X — resolves to current package __init__.py
      const initPath = dir ? dir + "/__init__.py" : "__init__.py";
      if (fileIndex.has(initPath)) return initPath;
    }
  } else {
    // Absolute import — try from project root
    if (modulePath) {
      if (fileIndex.has(modulePath + ".py")) return modulePath + ".py";
      if (fileIndex.has(modulePath + "/__init__.py"))
        return modulePath + "/__init__.py";
    }
  }

  return null;
}

function resolveRustImport(
  specifier: string,
  fromFile: string,
  fileIndex: FileIndex,
): string | null {
  // mod declarations: "mod:name"
  if (specifier.startsWith("mod:")) {
    const modName = specifier.slice(4);
    const dir = path.dirname(fromFile);
    const prefix = dir === "." ? "" : dir + "/";

    // Try name.rs
    if (fileIndex.has(prefix + modName + ".rs"))
      return prefix + modName + ".rs";
    // Try name/mod.rs
    if (fileIndex.has(prefix + modName + "/mod.rs"))
      return prefix + modName + "/mod.rs";

    return null;
  }

  const parts = specifier.split("::");

  if (parts[0] === "crate") {
    // Resolve from src/ directory
    const moduleParts = parts.slice(1);
    return resolveRustModulePath("src", moduleParts, fileIndex);
  }

  if (parts[0] === "super") {
    // Count chained super:: segments (e.g., super::super::module)
    let superCount = 0;
    let idx = 0;
    while (idx < parts.length && parts[idx] === "super") {
      superCount++;
      idx++;
    }
    let dir = path.dirname(fromFile);
    for (let i = 0; i < superCount; i++) {
      dir = path.dirname(dir);
      if (dir === ".") dir = "";
    }
    const moduleParts = parts.slice(idx);
    return resolveRustModulePath(dir, moduleParts, fileIndex);
  }

  if (parts[0] === "self") {
    const dir = path.dirname(fromFile);
    const base = dir === "." ? "" : dir;
    const moduleParts = parts.slice(1);
    return resolveRustModulePath(base, moduleParts, fileIndex);
  }

  return null;
}

function resolveRustModulePath(
  base: string,
  moduleParts: string[],
  fileIndex: FileIndex,
): string | null {
  if (moduleParts.length === 0) {
    // Bare crate::, self::, super:: — resolve to the module file itself
    if (base) {
      if (fileIndex.has(base + "/mod.rs")) return base + "/mod.rs";
      if (fileIndex.has(base + "/lib.rs")) return base + "/lib.rs";
      // Rust 2018: parent_dir/base_name.rs
      const parentDir = path.dirname(base);
      const baseName = path.basename(base);
      const parentPrefix = parentDir === "." ? "" : parentDir + "/";
      if (fileIndex.has(parentPrefix + baseName + ".rs"))
        return parentPrefix + baseName + ".rs";
    }
    return null;
  }

  // Try progressively: the whole path as a module, then without the last item
  for (let depth = moduleParts.length; depth > 0; depth--) {
    const modPath = moduleParts.slice(0, depth).join("/");
    const fullPath = base ? base + "/" + modPath : modPath;

    if (fileIndex.has(fullPath + ".rs")) return fullPath + ".rs";
    if (fileIndex.has(fullPath + "/mod.rs")) return fullPath + "/mod.rs";
  }

  return null;
}

function resolveGoImport(
  specifier: string,
  _fromFile: string,
  fileIndex: FileIndex,
  goModulePath: string | null,
): string[] {
  let localPath: string | null = null;

  // If module path is known, strip it to get the local package dir
  if (goModulePath && specifier.startsWith(goModulePath + "/")) {
    localPath = specifier.slice(goModulePath.length + 1);
  }

  if (!localPath) {
    // Try matching the import suffix against repo directories
    const parts = specifier.split("/");
    for (let i = 0; i < parts.length; i++) {
      const tryPath = parts.slice(i).join("/");
      const goFiles = fileIndex
        .getFilesInDir(tryPath)
        .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
      if (goFiles.length > 0) {
        return goFiles;
      }
    }
    return [];
  }

  // Find all .go files in the local package directory (exclude test files)
  const goFiles = fileIndex
    .getFilesInDir(localPath)
    .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
  return goFiles;
}

function resolveJavaImport(
  specifier: string,
  fileIndex: FileIndex,
  javaSourceRoots: string[],
): string[] {
  // Wildcard imports: com.example.* → find all .java files in com/example/
  if (specifier.endsWith(".*")) {
    const packagePath = specifier.slice(0, -2).replace(/\./g, "/");
    const results: string[] = [];
    for (const root of javaSourceRoots) {
      const fullDir = root ? root + "/" + packagePath : packagePath;
      const javaFiles = fileIndex
        .getFilesInDir(fullDir)
        .filter((f) => f.endsWith(".java"));
      results.push(...javaFiles);
    }
    return results;
  }

  // Try exact match first: com.example.Foo → com/example/Foo.java
  const filePath = specifier.replace(/\./g, "/") + ".java";
  for (const root of javaSourceRoots) {
    const fullPath = root ? root + "/" + filePath : filePath;
    if (fileIndex.has(fullPath)) return [fullPath];
  }

  // Static imports / inner classes: progressively strip trailing segments
  // com.example.Util.doSomething → try com/example/Util.java
  // com.example.Outer.Inner → try com/example/Outer.java
  const segments = specifier.split(".");
  for (let depth = segments.length - 1; depth >= 2; depth--) {
    const candidate = segments.slice(0, depth).join("/") + ".java";
    for (const root of javaSourceRoots) {
      const fullPath = root ? root + "/" + candidate : candidate;
      if (fileIndex.has(fullPath)) return [fullPath];
    }
  }

  return [];
}

function resolveCSharpImport(
  specifier: string,
  fileIndex: FileIndex,
): string[] {
  // C# using statements refer to namespaces, not files directly.
  // Best effort: map namespace segments to directories and find .cs files.
  const dirPath = specifier.replace(/\./g, "/");

  // Try as exact directory
  const csFiles = fileIndex
    .getFilesInDir(dirPath)
    .filter((f) => f.endsWith(".cs"));
  if (csFiles.length > 0) return csFiles;

  // Try under common C# source roots
  for (const root of ["src", ""]) {
    const fullDir = root ? root + "/" + dirPath : dirPath;
    const files = fileIndex
      .getFilesInDir(fullDir)
      .filter((f) => f.endsWith(".cs"));
    if (files.length > 0) return files;
  }

  return [];
}

function resolveCppImport(
  specifier: string,
  fromFile: string,
  fileIndex: FileIndex,
): string | null {
  const isAngle = specifier.startsWith("angle:");
  const actualPath = isAngle ? specifier.slice(6) : specifier;

  if (!isAngle) {
    // Quoted include: resolve relative to current file first
    const dir = path.dirname(fromFile);
    const relative = dir === "." ? actualPath : dir + "/" + actualPath;
    const normalized = path.normalize(relative).split(path.sep).join("/");
    if (fileIndex.has(normalized)) return normalized;
  }

  // Try relative to project root
  if (fileIndex.has(actualPath)) return actualPath;

  // Try common include directories
  for (const includeDir of ["include", "src", "lib"]) {
    const withDir = includeDir + "/" + actualPath;
    if (fileIndex.has(withDir)) return withDir;
  }

  return null;
}

function resolveRubyImport(
  specifier: string,
  fromFile: string,
  fileIndex: FileIndex,
): string | null {
  if (specifier.startsWith("relative:")) {
    // require_relative — resolve relative to current file
    const relPath = specifier.slice(9);
    const dir = path.dirname(fromFile);
    const resolved = dir === "." ? relPath : dir + "/" + relPath;
    const normalized = path.normalize(resolved).split(path.sep).join("/");

    if (fileIndex.has(normalized)) return normalized;
    if (fileIndex.has(normalized + ".rb")) return normalized + ".rb";
    return null;
  }

  // require — try lib/ and project root
  for (const root of ["lib", "app", ""]) {
    const fullPath = root ? root + "/" + specifier : specifier;
    if (fileIndex.has(fullPath)) return fullPath;
    if (fileIndex.has(fullPath + ".rb")) return fullPath + ".rb";
  }

  return null;
}

// ─── Dispatcher Functions ───────────────────────────────────

type ExtractorFn = (source: string) => RawImport[];

const EXTRACTOR_MAP: Record<string, ExtractorFn> = {
  typescript: extractTsJsImports,
  javascript: extractTsJsImports,
  python: extractPythonImports,
  rust: extractRustImports,
  go: extractGoImports,
  java: extractJavaImports,
  csharp: extractCSharpImports,
  c: extractCppImports,
  cpp: extractCppImports,
  ruby: extractRubyImports,
};

function resolveImport(
  language: string,
  specifier: string,
  fromFile: string,
  fileIndex: FileIndex,
  tsConfig: TsConfig | null,
  goModulePath: string | null,
  javaSourceRoots: string[],
): string[] {
  switch (language) {
    case "typescript":
    case "javascript": {
      const result = resolveTsJsImport(
        specifier,
        fromFile,
        fileIndex,
        tsConfig,
        language,
      );
      return result ? [result] : [];
    }
    case "python": {
      const result = resolvePythonImport(specifier, fromFile, fileIndex);
      return result ? [result] : [];
    }
    case "rust": {
      const result = resolveRustImport(specifier, fromFile, fileIndex);
      return result ? [result] : [];
    }
    case "go":
      return resolveGoImport(specifier, fromFile, fileIndex, goModulePath);
    case "java":
      return resolveJavaImport(specifier, fileIndex, javaSourceRoots);
    case "csharp":
      return resolveCSharpImport(specifier, fileIndex);
    case "c":
    case "cpp": {
      const result = resolveCppImport(specifier, fromFile, fileIndex);
      return result ? [result] : [];
    }
    case "ruby": {
      const result = resolveRubyImport(specifier, fromFile, fileIndex);
      return result ? [result] : [];
    }
    default:
      return [];
  }
}

// ─── Main Function ──────────────────────────────────────────

/**
 * Ingestion Phase 4 (70–85%): Resolve import statements and create IMPORTS edges.
 *
 * Extracts import/require statements from source files across 8 language families,
 * resolves them to actual files within the repository, and creates IMPORTS edges
 * between File nodes in the graph. All operations run in a single transaction.
 */
export async function resolveImports(
  graphName: string,
  extractResult: ExtractResult,
  onProgress?: ProgressCallback,
): Promise<ImportResult> {
  onProgress?.(70, "Starting import resolution");

  // Build file index for fast lookups
  const fileIndex = new FileIndex(
    extractResult.files.map((f) => f.relativePath),
  );

  // Load language-specific config files
  const tsConfig = await loadTsConfig(extractResult.rootDir);
  const goModulePath = await loadGoModulePath(extractResult.rootDir);
  const javaSourceRoots = detectJavaSourceRoots(fileIndex);

  logger.info(
    {
      graphName,
      totalFiles: extractResult.files.length,
      hasTsConfig: tsConfig !== null,
      hasGoMod: goModulePath !== null,
      javaSourceRoots,
    },
    "Starting import resolution phase",
  );

  const client = await pool.connect();
  let importsEdgeCount = 0;
  let filesProcessed = 0;
  let importsExtracted = 0;
  let importsResolved = 0;

  try {
    await client.query("BEGIN");

    // Build file path → AGE node ID map
    const fileIdMap = new Map<string, number>();
    const fileRows = await cypherWithClient<{ v: AgeVertex }>(
      client,
      graphName,
      "MATCH (v:File) RETURN v",
      undefined,
      [{ name: "v" }],
    );
    for (const row of fileRows) {
      fileIdMap.set(row.v.properties.path as string, row.v.id);
    }

    onProgress?.(71, `Loaded ${fileIdMap.size} file nodes from graph`);

    // Track edges to avoid duplicates (multiple imports between same files)
    const edgeSet = new Set<string>();
    const totalFiles = extractResult.files.length;

    for (let i = 0; i < totalFiles; i++) {
      const file = extractResult.files[i];
      const language = detectLanguage(file.relativePath);

      // Get extractor for this language
      const extractor = EXTRACTOR_MAP[language];
      if (!extractor) continue;

      // Get source file AGE node ID
      const fromId = fileIdMap.get(file.relativePath);
      if (fromId === undefined) continue;

      // Read file
      let source: string;
      try {
        source = await fsp.readFile(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      // Extract imports
      const rawImports = extractor(source);
      importsExtracted += rawImports.length;

      // Resolve and create edges
      for (const imp of rawImports) {
        const targets = resolveImport(
          language,
          imp.specifier,
          file.relativePath,
          fileIndex,
          tsConfig,
          goModulePath,
          javaSourceRoots,
        );

        for (const target of targets) {
          const toId = fileIdMap.get(target);
          if (toId === undefined) continue;
          if (fromId === toId) continue; // skip self-imports

          const edgeKey = `${fromId}->${toId}`;
          if (edgeSet.has(edgeKey)) continue;
          edgeSet.add(edgeKey);

          // Create IMPORTS edge
          await cypherWithClient(
            client,
            graphName,
            `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:IMPORTS]->(b) RETURN e`,
            { start_id: fromId, end_id: toId },
            [{ name: "e" }],
          );

          importsEdgeCount++;
          importsResolved++;
        }
      }

      filesProcessed++;

      if (i % 50 === 0 || i === totalFiles - 1) {
        const progress = 71 + ((i + 1) / totalFiles) * 14;
        onProgress?.(
          Math.round(progress),
          `Resolving imports: ${i + 1}/${totalFiles} (${importsEdgeCount} edges)`,
        );
      }
    }

    await client.query("COMMIT");

    onProgress?.(
      85,
      `Import resolution complete: ${importsEdgeCount} IMPORTS edges from ${filesProcessed} files`,
    );

    logger.info(
      {
        graphName,
        filesProcessed,
        importsExtracted,
        importsResolved,
        importsEdgeCount,
      },
      "Import resolution complete",
    );

    return {
      importsEdgeCount,
      filesProcessed,
      importsExtracted,
      importsResolved,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ graphName, err }, "Import resolution failed, rolled back");
    throw err;
  } finally {
    client.release();
  }
}
