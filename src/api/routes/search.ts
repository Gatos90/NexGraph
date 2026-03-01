import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";
import { embedQuery } from "../../ingestion/embeddings.js";
import { getOrCreateProjectEmbeddingConfig } from "../../embeddings/config.js";
import { semanticSearchSymbolsByRepository } from "../../embeddings/store.js";

const logger = createChildLogger("search-routes");

// ---- DB Row Types ----

interface RepositoryRow {
  id: string;
  project_id: string;
}

interface SearchResultRow {
  file_path: string;
  rank: number;
  headline: string;
  language: string | null;
}

interface FileContentRow {
  file_path: string;
  content: string;
  language: string | null;
}

// ---- Shared Schemas ----

const ErrorResponse = z.object({
  error: z.string(),
});

const RepoIdParams = z.object({
  repoId: z.string().uuid(),
});

const ProjectIdParams = z.object({
  projectId: z.string().uuid(),
});

const SearchRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  mode: z.enum(["keyword", "semantic", "hybrid"]).default("keyword"),
});

const SearchResultSchema = z.object({
  file_path: z.string(),
  rank: z.number().optional(),
  highlights: z.string().optional(),
  language: z.string().nullable().optional(),
  symbol_name: z.string().optional(),
  label: z.string().optional(),
  similarity: z.number().optional(),
  rrf_rank: z.number().optional(),
  rrf_score: z.number().optional(),
  keyword_rank: z.number().optional(),
  semantic_rank: z.number().optional(),
});

const SearchResponseSchema = z.object({
  mode: z.enum(["keyword", "semantic", "hybrid"]),
  results: z.array(SearchResultSchema),
  total: z.number(),
});

const GrepRequestSchema = z.object({
  pattern: z.string().min(1).max(1000),
  case_sensitive: z.boolean().default(true),
  context_lines: z.number().int().min(0).max(10).default(2),
  limit: z.number().int().min(1).max(500).default(100),
  file_pattern: z.string().max(500).optional(),
});

const GrepMatchSchema = z.object({
  file_path: z.string(),
  line_number: z.number(),
  line: z.string(),
  context_before: z.array(z.string()),
  context_after: z.array(z.string()),
});

const GrepResponseSchema = z.object({
  matches: z.array(GrepMatchSchema),
  total_matches: z.number(),
  files_searched: z.number(),
  files_matched: z.number(),
});

const ProjectSearchResultSchema = SearchResultSchema.extend({
  repository_id: z.string().uuid(),
});

const ProjectSearchResponseSchema = z.object({
  results: z.array(ProjectSearchResultSchema),
  total: z.number(),
});

// ---- Helpers ----

interface GrepMatch {
  file_path: string;
  line_number: number;
  line: string;
  context_before: string[];
  context_after: string[];
}

function grepFileContent(
  filePath: string,
  content: string,
  pattern: RegExp,
  contextLines: number,
  limit: number,
  matches: GrepMatch[],
): number {
  const lines = content.split("\n");
  let matchCount = 0;

  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    if (pattern.test(lines[i])) {
      const ctxBefore: string[] = [];
      for (let j = Math.max(0, i - contextLines); j < i; j++) {
        ctxBefore.push(lines[j]);
      }

      const ctxAfter: string[] = [];
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextLines); j++) {
        ctxAfter.push(lines[j]);
      }

      matches.push({
        file_path: filePath,
        line_number: i + 1,
        line: lines[i],
        context_before: ctxBefore,
        context_after: ctxAfter,
      });
      matchCount++;
    }
  }

  return matchCount;
}

async function verifyRepoAccess(
  repoId: string,
  projectId: string,
): Promise<RepositoryRow | null> {
  const result = await pool.query<RepositoryRow>(
    "SELECT id, project_id FROM repositories WHERE id = $1",
    [repoId],
  );

  if (result.rows.length === 0) return null;
  if (result.rows[0].project_id !== projectId) return null;

  return result.rows[0];
}

// ---- Route Definitions ----

const repoSearchRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/search`,
  tags: ["Search"],
  summary: "BM25 keyword search across repository file contents",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": { schema: SearchRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: SearchResponseSchema },
      },
      description: "Search results ranked by relevance",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found",
    },
  },
});

const repoGrepRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/search/grep`,
  tags: ["Search"],
  summary: "Regex search across repository file contents",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": { schema: GrepRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: GrepResponseSchema },
      },
      description: "Grep results with line numbers and context",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid regex pattern",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found",
    },
  },
});

const projectSearchRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/search`,
  tags: ["Search"],
  summary: "BM25 keyword search across ALL repositories in a project",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": { schema: SearchRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ProjectSearchResponseSchema },
      },
      description: "Search results across all project repositories",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Forbidden",
    },
  },
});

// ---- Router & Middleware ----

const searchRoutes = new OpenAPIHono<AppEnv>();

searchRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/search`,
  authMiddleware(),
);
searchRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/search/grep`,
  authMiddleware(),
);
searchRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/search`,
  authMiddleware(),
);

// ---- Handlers ----

// POST /api/v1/repositories/:repoId/search — Multi-mode search
searchRoutes.openapi(repoSearchRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const body = c.req.valid("json");
  const mode = body.mode ?? "keyword";

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  // ── Keyword search helper ─────────────────────────────
  async function doKeywordSearch() {
    const result = await pool.query<SearchResultRow>(
      `SELECT
         fc.file_path,
         ts_rank(fc.search_vector, plainto_tsquery('simple', $2)) AS rank,
         ts_headline('simple', fc.content, plainto_tsquery('simple', $2),
           'StartSel=**, StopSel=**, MaxWords=50, MinWords=20, MaxFragments=3, FragmentDelimiter= ... ') AS headline,
         if2.language
       FROM file_contents fc
       LEFT JOIN indexed_files if2
         ON if2.repository_id = fc.repository_id AND if2.file_path = fc.file_path
       WHERE fc.repository_id = $1
         AND fc.search_vector @@ plainto_tsquery('simple', $2)
       ORDER BY rank DESC
       LIMIT $3`,
      [repoId, body.query, body.limit],
    );
    return result.rows.map((r) => ({
      file_path: r.file_path,
      rank: r.rank,
      highlights: r.headline,
      language: r.language ?? null,
    }));
  }

  // ── Semantic search helper ────────────────────────────
  async function doSemanticSearch() {
    const embeddingConfig = await getOrCreateProjectEmbeddingConfig(projectId);
    const queryVec = await embedQuery(projectId, body.query);
    const rows = await semanticSearchSymbolsByRepository(
      projectId,
      repoId,
      embeddingConfig.dimensions,
      queryVec,
      body.limit,
    );
    return rows.map((r) => ({
      file_path: r.filePath,
      symbol_name: r.symbolName,
      label: r.label,
      similarity: r.similarity,
    }));
  }

  if (mode === "keyword") {
    const results = await doKeywordSearch();
    logger.debug({ repoId, query: body.query, mode, returned: results.length }, "Search completed");
    return c.json({ mode: "keyword" as const, results, total: results.length }, 200);
  }

  if (mode === "semantic") {
    const results = await doSemanticSearch();
    logger.debug({ repoId, query: body.query, mode, returned: results.length }, "Search completed");
    return c.json({ mode: "semantic" as const, results, total: results.length }, 200);
  }

  // ── Hybrid: RRF fusion ────────────────────────────────
  const RRF_K = 60;
  const [kwResults, semResults] = await Promise.all([
    doKeywordSearch(),
    doSemanticSearch(),
  ]);

  const rrfMap = new Map<string, {
    score: number;
    file_path: string;
    keyword_rank?: number;
    semantic_rank?: number;
    highlights?: string;
    language?: string | null;
    symbol_name?: string;
    label?: string;
    similarity?: number;
  }>();

  for (let i = 0; i < kwResults.length; i++) {
    const r = kwResults[i];
    const existing = rrfMap.get(r.file_path);
    const contrib = 1 / (RRF_K + i + 1);
    if (existing) {
      existing.score += contrib;
      existing.keyword_rank = i + 1;
      existing.highlights = r.highlights;
      existing.language = r.language;
    } else {
      rrfMap.set(r.file_path, {
        score: contrib, keyword_rank: i + 1, file_path: r.file_path,
        highlights: r.highlights, language: r.language,
      });
    }
  }

  for (let i = 0; i < semResults.length; i++) {
    const r = semResults[i];
    const existing = rrfMap.get(r.file_path);
    const contrib = 1 / (RRF_K + i + 1);
    if (existing) {
      existing.score += contrib;
      existing.semantic_rank = i + 1;
      if (!existing.symbol_name) existing.symbol_name = r.symbol_name;
      if (!existing.label) existing.label = r.label;
      if (existing.similarity === undefined) existing.similarity = r.similarity;
    } else {
      rrfMap.set(r.file_path, {
        score: contrib, semantic_rank: i + 1, file_path: r.file_path,
        symbol_name: r.symbol_name, label: r.label, similarity: r.similarity,
      });
    }
  }

  const hybridResults = [...rrfMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, body.limit)
    .map((r, idx) => ({
      file_path: r.file_path,
      rrf_rank: idx + 1,
      rrf_score: Math.round(r.score * 10000) / 10000,
      keyword_rank: r.keyword_rank,
      semantic_rank: r.semantic_rank,
      highlights: r.highlights,
      language: r.language ?? null,
      symbol_name: r.symbol_name,
      label: r.label,
      similarity: r.similarity,
    }));

  logger.debug({ repoId, query: body.query, mode, returned: hybridResults.length }, "Search completed");
  return c.json({ mode: "hybrid" as const, results: hybridResults, total: hybridResults.length }, 200);
});

// POST /api/v1/repositories/:repoId/search/grep — Regex grep
searchRoutes.openapi(repoGrepRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const body = c.req.valid("json");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  // Validate regex pattern
  const flags = body.case_sensitive ? "" : "i";
  try {
    new RegExp(body.pattern, flags);
  } catch {
    return c.json({ error: "Invalid regex pattern" }, 400);
  }

  // Build SQL query — pre-filter files with PostgreSQL regex, then process in app
  const regexOp = body.case_sensitive ? "~" : "~*";

  let sql = `SELECT fc.file_path, fc.content, if2.language
     FROM file_contents fc
     LEFT JOIN indexed_files if2
       ON if2.repository_id = fc.repository_id AND if2.file_path = fc.file_path
     WHERE fc.repository_id = $1
       AND fc.content ${regexOp} $2`;
  const params: unknown[] = [repoId, body.pattern];
  let paramIdx = 3;

  if (body.file_pattern) {
    sql += ` AND fc.file_path LIKE $${paramIdx}`;
    // Convert glob-like pattern to SQL LIKE: * -> %, ? -> _
    const likePattern = body.file_pattern
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_")
      .replace(/\*/g, "%")
      .replace(/\?/g, "_");
    params.push(likePattern);
    paramIdx++;
  }

  sql += ` ORDER BY fc.file_path`;

  const result = await pool.query<FileContentRow>(sql, params);

  // Process matches in application layer for line numbers and context
  const matches: GrepMatch[] = [];
  let totalMatches = 0;
  let filesMatched = 0;

  for (const row of result.rows) {
    if (matches.length >= body.limit) break;

    const beforeCount = matches.length;
    const reMatch = new RegExp(body.pattern, flags);
    totalMatches += grepFileContent(
      row.file_path,
      row.content,
      reMatch,
      body.context_lines,
      body.limit,
      matches,
    );

    if (matches.length > beforeCount) {
      filesMatched++;
    }
  }

  logger.debug(
    {
      repoId,
      pattern: body.pattern,
      filesSearched: result.rows.length,
      filesMatched,
      totalMatches,
    },
    "Grep search completed",
  );

  return c.json(
    {
      matches,
      total_matches: totalMatches,
      files_searched: result.rows.length,
      files_matched: filesMatched,
    },
    200,
  );
});

// POST /api/v1/projects/:projectId/search — Search across ALL repos in project
searchRoutes.openapi(projectSearchRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authProjectId = c.get("projectId");
  const body = c.req.valid("json");

  if (projectId !== authProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Count total matching files across all repos in the project
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM file_contents fc
     JOIN repositories r ON r.id = fc.repository_id
     WHERE r.project_id = $1
       AND fc.search_vector @@ plainto_tsquery('simple', $2)`,
    [projectId, body.query],
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Fetch ranked results across all repos
  const result = await pool.query<SearchResultRow & { repository_id: string }>(
    `SELECT
       fc.repository_id,
       fc.file_path,
       ts_rank(fc.search_vector, plainto_tsquery('simple', $2)) AS rank,
       ts_headline('simple', fc.content, plainto_tsquery('simple', $2),
         'StartSel=**, StopSel=**, MaxWords=50, MinWords=20, MaxFragments=3, FragmentDelimiter= ... ') AS headline,
       if2.language
     FROM file_contents fc
     JOIN repositories r ON r.id = fc.repository_id
     LEFT JOIN indexed_files if2
       ON if2.repository_id = fc.repository_id AND if2.file_path = fc.file_path
     WHERE r.project_id = $1
       AND fc.search_vector @@ plainto_tsquery('simple', $2)
     ORDER BY rank DESC
     LIMIT $3 OFFSET $4`,
    [projectId, body.query, body.limit, body.offset],
  );

  logger.debug(
    { projectId, query: body.query, total, returned: result.rows.length },
    "Project-wide BM25 search completed",
  );

  return c.json(
    {
      results: result.rows.map((r) => ({
        repository_id: r.repository_id,
        file_path: r.file_path,
        rank: r.rank,
        highlights: r.headline,
        language: r.language ?? null,
      })),
      total,
    },
    200,
  );
});

export { searchRoutes };
