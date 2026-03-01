import fsp from "node:fs/promises";
import { pool } from "../db/connection.js";
import { cypher } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import { cleanupTempDir } from "./extract.js";
import type { ExtractResult } from "./extract.js";
import { detectLanguage } from "./structure.js";

const logger = createChildLogger("urlmatch");

// ─── Types ──────────────────────────────────────────────────

export interface HttpCallSite {
  httpMethod: string;
  urlPath: string;
  filePath: string;
  line: number;
}

export interface RouteHandlerInfo {
  nodeId: string;
  httpMethod: string;
  urlPattern: string;
  filePath: string;
  framework: string;
  handlerName: string;
}

export interface ResolvedCrossRepoEdge {
  sourceNode: string;
  targetNode: string;
  httpMethod: string;
  sourceUrl: string;
  targetPattern: string;
  confidence: number;
  resolutionMethod: string;
}

interface RepoRow {
  id: string;
  project_id: string;
  url: string;
  source_type: string;
  graph_name: string;
  default_branch: string;
}

// ─── HTTP Call Extraction Patterns ──────────────────────────

// fetch('/api/users') or fetch("/api/users")
const FETCH_PATTERN =
  /\bfetch\s*\(\s*['"`]([^'"`\s]+)['"`]/g;

// fetch(`/api/users/${id}`) — template literals
const FETCH_TEMPLATE_PATTERN =
  /\bfetch\s*\(\s*`([^`]+)`/g;

// axios.get('/api/users'), axios.post('/api/users', ...) etc.
const AXIOS_METHOD_PATTERN =
  /\baxios\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi;

// axios.get(`/api/users/${id}`) — template literals
const AXIOS_TEMPLATE_PATTERN =
  /\baxios\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*`([^`]+)`/gi;

// axios({ url: '/api/users', method: 'post' }) or axios({ method: 'post', url: '/api/users' })
const AXIOS_CONFIG_PATTERN =
  /\baxios\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`\s]+)['"`][^}]*(?:method\s*:\s*['"`](\w+)['"`])?[^}]*\}/gi;

// $http.get('/api/users') — Angular HttpClient
const HTTP_CLIENT_PATTERN =
  /\b(?:\$http|http|this\.http|this\.httpClient|httpClient)\s*\.\s*(get|post|put|delete|patch|head|options)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`\s]+)['"`]/gi;

// HTTP client template literals
const HTTP_CLIENT_TEMPLATE_PATTERN =
  /\b(?:\$http|http|this\.http|this\.httpClient|httpClient)\s*\.\s*(get|post|put|delete|patch|head|options)\s*(?:<[^>]*>)?\s*\(\s*`([^`]+)`/gi;

// Python requests: requests.get('/api/users'), requests.post('/api/users')
const PYTHON_REQUESTS_PATTERN =
  /\brequests\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]+)['"]/gi;

// Python httpx: httpx.get('/api/users')
const PYTHON_HTTPX_PATTERN =
  /\bhttpx\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]+)['"]/gi;

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Normalize template literal URL paths to parameter notation.
 * Converts `${...}` segments to `:param`.
 */
function normalizeTemplateLiteral(url: string): string {
  let result = url.replace(/\$\{[^}]+\}/g, ":param");
  // Dynamic base URL: ${this.base}/endpoint → :param/endpoint → /endpoint
  if (result.startsWith(":param/")) {
    result = result.slice(":param".length);
  }
  return result;
}

/**
 * Extract URL path from a full URL string, stripping protocol/host/query.
 */
function extractPathFromUrl(url: string): string {
  // If it starts with http(s)://, extract the path portion
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.pathname;
    } catch {
      return url;
    }
  }
  // Strip query string and hash
  const qIdx = url.indexOf("?");
  const hIdx = url.indexOf("#");
  let end = url.length;
  if (qIdx !== -1) end = Math.min(end, qIdx);
  if (hIdx !== -1) end = Math.min(end, hIdx);
  return url.slice(0, end);
}

/**
 * Infer HTTP method from a variable/property/function name.
 * E.g. "PostLoginPath" → POST, "getUsers" → GET, "deleteItem" → DELETE.
 */
function inferMethodFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("get") || lower.startsWith("list") || lower.startsWith("fetch") || lower.startsWith("find")) return "GET";
  if (lower.startsWith("post") || lower.startsWith("create") || lower.startsWith("add")) return "POST";
  if (lower.startsWith("put") || lower.startsWith("update") || lower.startsWith("replace")) return "PUT";
  if (lower.startsWith("delete") || lower.startsWith("remove")) return "DELETE";
  if (lower.startsWith("patch")) return "PATCH";
  return "ANY";
}

/**
 * Extract HTTP client calls from source code.
 */
export function extractHttpCalls(
  source: string,
  filePath: string,
  language: string,
): HttpCallSite[] {
  const calls: HttpCallSite[] = [];

  if (
    language === "typescript" ||
    language === "javascript"
  ) {
    // fetch() calls
    FETCH_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FETCH_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(match[1]);
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: "ANY",
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }

    // fetch() with template literals
    FETCH_TEMPLATE_PATTERN.lastIndex = 0;
    while ((match = FETCH_TEMPLATE_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(normalizeTemplateLiteral(match[1]));
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: "ANY",
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }

    // axios method calls
    AXIOS_METHOD_PATTERN.lastIndex = 0;
    while ((match = AXIOS_METHOD_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(match[2]);
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: match[1].toUpperCase(),
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }

    // axios method with template literals
    AXIOS_TEMPLATE_PATTERN.lastIndex = 0;
    while ((match = AXIOS_TEMPLATE_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(normalizeTemplateLiteral(match[2]));
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: match[1].toUpperCase(),
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }

    // axios config object
    AXIOS_CONFIG_PATTERN.lastIndex = 0;
    while ((match = AXIOS_CONFIG_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(match[1]);
      const method = match[2] ? match[2].toUpperCase() : "ANY";
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: method,
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }

    // $http / httpClient calls (Angular)
    HTTP_CLIENT_PATTERN.lastIndex = 0;
    while ((match = HTTP_CLIENT_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(match[2]);
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: match[1].toUpperCase(),
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }

    // httpClient template literals
    HTTP_CLIENT_TEMPLATE_PATTERN.lastIndex = 0;
    while ((match = HTTP_CLIENT_TEMPLATE_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(normalizeTemplateLiteral(match[2]));
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: match[1].toUpperCase(),
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }
  }

  if (language === "python") {
    // requests library
    PYTHON_REQUESTS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PYTHON_REQUESTS_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(match[2]);
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: match[1].toUpperCase(),
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }

    // httpx library
    PYTHON_HTTPX_PATTERN.lastIndex = 0;
    while ((match = PYTHON_HTTPX_PATTERN.exec(source)) !== null) {
      const urlPath = extractPathFromUrl(match[2]);
      if (urlPath.startsWith("/")) {
        calls.push({
          httpMethod: match[1].toUpperCase(),
          urlPath,
          filePath,
          line: lineNumberAt(source, match.index),
        });
      }
    }
  }

  // ── Universal: scan ALL string literals for URL API paths ──
  // Language-agnostic catch-all that detects auto-generated clients,
  // enum constants, config objects, custom wrappers, any language.
  const URL_PATH_STRING =
    /(?:['"`])(\/[a-zA-Z{:][\w\-{}:.]*(?:\/[\w\-{}:.]*)*\/?)(?:['"`])/g;

  const SKIP_PREFIXES = [
    "/usr", "/home", "/tmp", "/var", "/etc", "/opt", "/bin",
    "/lib", "/dev", "/proc", "/sys", "/mnt", "/root", "/srv", "/boot",
    "/node_modules", "/dist", "/build", "/assets", "/static", "/public",
  ];
  const FILE_EXT_RE = /\.\w{1,5}$/;

  // Dedup against calls already found by HTTP-client-specific patterns
  const foundSet = new Set(calls.map((c) => `${c.urlPath}::${c.line}`));

  URL_PATH_STRING.lastIndex = 0;
  let uMatch: RegExpExecArray | null;
  while ((uMatch = URL_PATH_STRING.exec(source)) !== null) {
    const raw = uMatch[1];
    const urlPath = extractPathFromUrl(raw);

    // Skip non-API-like paths
    if (urlPath.length < 2) continue;
    if (SKIP_PREFIXES.some((p) => urlPath.toLowerCase().startsWith(p))) continue;
    const lastSeg = urlPath.split("/").pop() || "";
    if (FILE_EXT_RE.test(lastSeg)) continue;
    if (/[^/\w\-{}:.~@]/.test(urlPath)) continue;

    const line = lineNumberAt(source, uMatch.index);
    const dedupKey = `${urlPath}::${line}`;
    if (foundSet.has(dedupKey)) continue;
    foundSet.add(dedupKey);

    // Infer HTTP method from surrounding context (look backward for identifier)
    // Captures "postLogin.PATH" or "PostLoginPath" or "getEndpoint" before = or :
    const before = source.slice(Math.max(0, uMatch.index - 120), uMatch.index);
    const idMatch = before.match(/([\w.]+)\s*(?:=|:)\s*$/);
    let httpMethod = "ANY";
    if (idMatch) {
      // For "postLogin.PATH" → use "postLogin"; for "PostLoginPath" → use "PostLoginPath"
      const raw = idMatch[1];
      const parts = raw.split(".");
      const name = parts.length > 1 ? parts[0] : raw;
      httpMethod = inferMethodFromName(name);
    }

    calls.push({ httpMethod, urlPath, filePath, line });
  }

  return calls;
}

// ─── URL Path Matching ──────────────────────────────────────

/**
 * Normalize a URL path for comparison:
 * - Strips trailing slash (except root)
 * - Lowercases
 */
function normalizePath(p: string): string {
  let result = p.toLowerCase();
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Convert a route pattern with params to a regex.
 * Handles Express-style `:param` and `{param}` patterns.
 */
function routePatternToRegex(pattern: string): RegExp {
  // Escape regex special chars except for param placeholders
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Restore param patterns after escaping
    .replace(/\\:(\w+)/g, "([^/]+)")
    .replace(/\\{(\w+)\\}/g, "([^/]+)");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Split a path into segments for segment-level matching.
 */
function pathSegments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

/**
 * Check if a call URL matches a route pattern.
 * Returns confidence score (0-1) or null if no match.
 */
export function matchUrlToRoute(
  callUrl: string,
  callMethod: string,
  route: RouteHandlerInfo,
): number | null {
  const normalizedCallUrl = normalizePath(callUrl);
  const normalizedRoutePattern = normalizePath(route.urlPattern);

  // Method matching
  const methodMatch =
    callMethod === "ANY" ||
    route.httpMethod === "ANY" ||
    callMethod === route.httpMethod;

  if (!methodMatch) return null;

  // Exact path match
  if (normalizedCallUrl === normalizedRoutePattern) {
    return callMethod !== "ANY" && route.httpMethod !== "ANY" ? 0.95 : 0.90;
  }

  // Parameterized route matching: /api/users/:id matches /api/users/123
  const routeRegex = routePatternToRegex(normalizedRoutePattern);
  if (routeRegex.test(normalizedCallUrl)) {
    return callMethod !== "ANY" && route.httpMethod !== "ANY" ? 0.90 : 0.85;
  }

  // Call URL has :param placeholders (from template literal normalization)
  // Try matching call URL as a pattern against the route pattern
  if (normalizedCallUrl.includes(":param")) {
    const callSegments = pathSegments(normalizedCallUrl);
    const routeSegments = pathSegments(normalizedRoutePattern);

    if (callSegments.length === routeSegments.length) {
      let allMatch = true;
      for (let i = 0; i < callSegments.length; i++) {
        const cs = callSegments[i];
        const rs = routeSegments[i];
        // Both are params, or both are same literal, or one is a param
        const isCallParam = cs === ":param" || cs.startsWith(":");
        const isRouteParam = rs.startsWith(":") || rs.startsWith("{");
        if (!isCallParam && !isRouteParam && cs !== rs) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        return callMethod !== "ANY" && route.httpMethod !== "ANY" ? 0.85 : 0.80;
      }
    }
  }

  // Segment prefix matching: call /api/users matches route /api/users/:id
  const callSegs = pathSegments(normalizedCallUrl);
  const routeSegs = pathSegments(normalizedRoutePattern);

  if (
    callSegs.length > 0 &&
    routeSegs.length > 0 &&
    callSegs.length <= routeSegs.length
  ) {
    let prefixMatch = true;
    for (let i = 0; i < callSegs.length; i++) {
      const rs = routeSegs[i];
      const isRouteParam = rs.startsWith(":") || rs.startsWith("{");
      if (!isRouteParam && callSegs[i] !== rs) {
        prefixMatch = false;
        break;
      }
    }
    if (prefixMatch && callSegs.length >= routeSegs.length - 1) {
      return callMethod !== "ANY" && route.httpMethod !== "ANY" ? 0.65 : 0.55;
    }
  }

  return null;
}

// ─── Main Resolution Function ───────────────────────────────

/**
 * Resolve URL path matches between a source repo (frontend) and
 * target repo (backend). Extracts HTTP calls from source repo files,
 * loads RouteHandler nodes from target repo graph, and creates
 * CROSS_REPO_CALLS edges in the cross_repo_edges table.
 */
export async function resolveUrlPathMatching(
  connectionId: string,
  sourceRepoId: string,
  targetRepoId: string,
  projectId: string,
): Promise<{ edgesCreated: number; callsDetected: number; routesLoaded: number }> {
  // Load repo info
  const [sourceRepo, targetRepo] = await Promise.all([
    loadRepoInfo(sourceRepoId),
    loadRepoInfo(targetRepoId),
  ]);

  if (!sourceRepo || !targetRepo) {
    throw new Error("Source or target repository not found");
  }

  if (!sourceRepo.graph_name || !targetRepo.graph_name) {
    throw new Error(
      "Source or target repository has not been indexed (no graph)",
    );
  }

  // Step 1: Load RouteHandler nodes from target repo graph
  logger.info(
    { targetRepoId, graphName: targetRepo.graph_name },
    "Loading route handlers from target repo",
  );

  const routeHandlers = await loadRouteHandlers(targetRepo.graph_name);

  if (routeHandlers.length === 0) {
    logger.info({ targetRepoId }, "No route handlers found in target repo");
    return { edgesCreated: 0, callsDetected: 0, routesLoaded: 0 };
  }

  logger.info(
    { targetRepoId, routeCount: routeHandlers.length },
    "Loaded route handlers",
  );

  // Step 2: Extract HTTP calls from source repo files
  const httpCalls = await extractHttpCallsFromRepo(sourceRepo);

  if (httpCalls.length === 0) {
    logger.info({ sourceRepoId }, "No HTTP calls found in source repo");
    return { edgesCreated: 0, callsDetected: httpCalls.length, routesLoaded: routeHandlers.length };
  }

  logger.info(
    { sourceRepoId, callCount: httpCalls.length },
    "Extracted HTTP calls from source repo",
  );

  // Step 2b: Load function map to resolve file:line → Function node
  const functionMap = await loadFunctionMap(sourceRepo.graph_name);
  logger.info(
    { sourceRepoId, filesWithFunctions: functionMap.size },
    "Loaded function map for source repo",
  );

  // Step 3: Match calls to route handlers
  const resolvedEdges: ResolvedCrossRepoEdge[] = [];
  const edgeSet = new Set<string>(); // dedup key

  for (const call of httpCalls) {
    let bestMatch: { route: RouteHandlerInfo; confidence: number } | null = null;

    for (const route of routeHandlers) {
      const confidence = matchUrlToRoute(call.urlPath, call.httpMethod, route);
      if (confidence !== null) {
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { route, confidence };
        }
      }
    }

    if (bestMatch) {
      const sourceRef = findEnclosingFunction(functionMap, call.filePath, call.line);
      const dedupKey = `${sourceRef}->${bestMatch.route.nodeId}`;
      if (!edgeSet.has(dedupKey)) {
        edgeSet.add(dedupKey);
        resolvedEdges.push({
          sourceNode: sourceRef,
          targetNode: `RouteHandler:${bestMatch.route.httpMethod}:${bestMatch.route.urlPattern}`,
          httpMethod: call.httpMethod,
          sourceUrl: call.urlPath,
          targetPattern: bestMatch.route.urlPattern,
          confidence: bestMatch.confidence,
          resolutionMethod: "url_path_matching",
        });
      }
    }
  }

  logger.info(
    { sourceRepoId, targetRepoId, matchCount: resolvedEdges.length },
    "URL path matching complete",
  );

  // Step 4: Delete previous resolved edges for this connection
  await pool.query(
    `DELETE FROM cross_repo_edges
     WHERE project_id = $1
       AND source_repo_id = $2
       AND target_repo_id = $3
       AND edge_type = 'CROSS_REPO_CALLS'`,
    [projectId, sourceRepoId, targetRepoId],
  );

  // Step 5: Insert new edges
  let edgesCreated = 0;

  for (const edge of resolvedEdges) {
    await pool.query(
      `INSERT INTO cross_repo_edges
         (project_id, source_repo_id, target_repo_id, source_node, target_node, edge_type, metadata)
       VALUES ($1, $2, $3, $4, $5, 'CROSS_REPO_CALLS', $6)`,
      [
        projectId,
        sourceRepoId,
        targetRepoId,
        edge.sourceNode,
        edge.targetNode,
        JSON.stringify({
          http_method: edge.httpMethod,
          source_url: edge.sourceUrl,
          target_pattern: edge.targetPattern,
          confidence: edge.confidence,
          resolution_method: edge.resolutionMethod,
        }),
      ],
    );
    edgesCreated++;
  }

  logger.info(
    { connectionId, edgesCreated },
    "Cross-repo edges created",
  );

  return {
    edgesCreated,
    callsDetected: httpCalls.length,
    routesLoaded: routeHandlers.length,
  };
}

// ─── Helper Functions ───────────────────────────────────────

async function loadRepoInfo(repoId: string): Promise<RepoRow | null> {
  const result = await pool.query<RepoRow>(
    `SELECT id, project_id, url, source_type, graph_name, default_branch
     FROM repositories WHERE id = $1`,
    [repoId],
  );
  return result.rows[0] ?? null;
}

async function loadRouteHandlers(
  graphName: string,
): Promise<RouteHandlerInfo[]> {
  try {
    const rows = await cypher<{ f: AgeVertex; r: AgeVertex }>(
      graphName,
      "MATCH (f:File)-[:EXPOSES]->(r:RouteHandler) RETURN f, r",
      undefined,
      [{ name: "f" }, { name: "r" }],
    );

    return rows.map((row) => ({
      nodeId: String(row.r.id),
      httpMethod: (row.r.properties.http_method as string) ?? "ANY",
      urlPattern: (row.r.properties.url_pattern as string) ?? "",
      filePath: (row.f.properties.path as string) ?? "",
      framework: (row.r.properties.framework as string) ?? "",
      handlerName: (row.r.properties.handler_name as string) ?? "",
    }));
  } catch (err) {
    logger.warn({ graphName, err }, "Failed to load route handlers from graph");
    return [];
  }
}

// ─── Function Map for resolving file:line → Function node ────

interface FunctionEntry {
  name: string;
  startLine: number;
  endLine: number;
}

type FunctionMap = Map<string, FunctionEntry[]>;

async function loadFunctionMap(graphName: string): Promise<FunctionMap> {
  try {
    const rows = await cypher<{ path: string; name: string; sl: number; el: number }>(
      graphName,
      `MATCH (f:File)-[:DEFINES]->(fn)
       WHERE label(fn) = 'Function' OR label(fn) = 'Method'
       RETURN f.path AS path, fn.name AS name, fn.start_line AS sl, fn.end_line AS el`,
      undefined,
      [{ name: "path" }, { name: "name" }, { name: "sl" }, { name: "el" }],
    );

    const map: FunctionMap = new Map();
    for (const row of rows) {
      const path = row.path as string;
      if (!path) continue;
      if (!map.has(path)) map.set(path, []);
      map.get(path)!.push({
        name: row.name as string,
        startLine: Number(row.sl),
        endLine: Number(row.el),
      });
    }
    return map;
  } catch (err) {
    logger.warn({ graphName, err }, "Failed to load function map from graph");
    return new Map();
  }
}

export function findEnclosingFunction(
  functionMap: FunctionMap,
  filePath: string,
  line: number,
): string {
  const functions = functionMap.get(filePath);
  if (!functions) return `${filePath}:${line}`;

  // Find the most specific (smallest range) enclosing function
  let best: FunctionEntry | null = null;
  for (const fn of functions) {
    if (fn.startLine <= line && fn.endLine >= line) {
      if (!best || (fn.endLine - fn.startLine) < (best.endLine - best.startLine)) {
        best = fn;
      }
    }
  }

  if (best) {
    return `Function:${best.name}:${filePath}`;
  }
  return `${filePath}:${line}`;
}

// ─── Extract HTTP calls from repo ───────────────────────────

async function extractHttpCallsFromRepo(
  repo: RepoRow,
): Promise<HttpCallSite[]> {
  let extractResult: ExtractResult | null = null;

  try {
    // Extract source files from the repository
    extractResult = await extractSource(
      repo.source_type as "git_url" | "zip_upload" | "local_path",
      repo.url,
      { branch: repo.default_branch },
    );

    const allCalls: HttpCallSite[] = [];

    for (const file of extractResult.files) {
      const language = detectLanguage(file.relativePath);
      // The universal string scanner works on any language; skip only
      // unrecognized files (binaries, images, etc.)
      if (language === "unknown") continue;

      let source: string;
      try {
        source = await fsp.readFile(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      const calls = extractHttpCalls(source, file.relativePath, language);
      allCalls.push(...calls);
    }

    return allCalls;
  } finally {
    // Clean up temp dir if used
    if (extractResult?.isTempDir) {
      await cleanupTempDir(extractResult.rootDir);
    }
  }
}

async function extractSource(
  sourceType: "git_url" | "zip_upload" | "local_path",
  url: string,
  options: { branch?: string },
): Promise<ExtractResult> {
  // Import dynamically to avoid circular dependency issues
  const { extractSource: extract } = await import("./extract.js");
  return extract(sourceType, url, options);
}
