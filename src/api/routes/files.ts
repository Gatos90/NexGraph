import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { cypher } from "../../db/age.js";
import type { AgeVertex } from "../../db/age.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";

const logger = createChildLogger("files-routes");

// ---- DB Row Types ----

interface RepositoryRow {
  id: string;
  project_id: string;
  graph_name: string | null;
}

interface IndexedFileRow {
  file_path: string;
  language: string | null;
}

interface FileContentRow {
  file_path: string;
  content: string;
}

// ---- Shared Schemas ----

const ErrorResponse = z.object({
  error: z.string(),
});

const RepoIdParams = z.object({
  repoId: z.string().uuid(),
});

const FileTreeQuerySchema = z.object({
  path: z.string().optional(),
  language: z.string().optional(),
  flat: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
});

const FileEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  language: z.string().nullable(),
  type: z.enum(["file", "directory"]),
});

const FileTreeResponseSchema = z.object({
  files: z.array(FileEntrySchema),
  total: z.number(),
});

const TreeNodeSchema: z.ZodType = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    type: z.enum(["file", "directory"]),
    language: z.string().nullable(),
    children: z.array(TreeNodeSchema).optional(),
  }),
).openapi("TreeNode", {
  type: "object",
  properties: {
    path: { type: "string" },
    name: { type: "string" },
    type: { type: "string", enum: ["file", "directory"] },
    language: { type: "string", nullable: true },
    children: {
      type: "array",
      items: { $ref: "#/components/schemas/TreeNode" },
    },
  },
});

const TreeResponseSchema = z.object({
  tree: z.array(TreeNodeSchema),
  total: z.number(),
});

// ---- Helpers ----

async function verifyRepoAccess(
  repoId: string,
  projectId: string,
): Promise<RepositoryRow | null> {
  const result = await pool.query<RepositoryRow>(
    "SELECT id, project_id, graph_name FROM repositories WHERE id = $1",
    [repoId],
  );

  if (result.rows.length === 0) return null;
  if (result.rows[0].project_id !== projectId) return null;

  return result.rows[0];
}

interface TreeNode {
  path: string;
  name: string;
  type: "file" | "directory";
  language: string | null;
  children?: TreeNode[];
}

function buildTree(files: IndexedFileRow[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  // Ensure all parent directories exist
  function ensureDir(dirPath: string): TreeNode {
    if (dirPath === "" || dirPath === ".") {
      // root level — no node needed, children go to root
      return { path: "", name: "", type: "directory", language: null, children: root };
    }

    const existing = dirMap.get(dirPath);
    if (existing) return existing;

    const parts = dirPath.split("/");
    const name = parts[parts.length - 1];
    const node: TreeNode = {
      path: dirPath,
      name,
      type: "directory",
      language: null,
      children: [],
    };
    dirMap.set(dirPath, node);

    // Ensure parent exists and add this dir as child
    const parentPath = parts.slice(0, -1).join("/");
    const parent = ensureDir(parentPath);
    const siblings = parent.children ?? (parent.children = []);
    siblings.push(node);

    return node;
  }

  for (const file of files) {
    const parts = file.file_path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");

    const fileNode: TreeNode = {
      path: file.file_path,
      name,
      type: "file",
      language: file.language ?? null,
    };

    const parent = ensureDir(parentPath);
    const siblings = parent.children ?? (parent.children = []);
    siblings.push(fileNode);
  }

  return root;
}

// ---- Route Definitions ----

const fileTreeRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/files`,
  tags: ["Files"],
  summary: "Browse the file tree of a repository",
  request: {
    params: RepoIdParams,
    query: FileTreeQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.union([FileTreeResponseSchema, TreeResponseSchema]),
        },
      },
      description: "File tree or flat file list",
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

// ---- Router & Middleware ----

const fileRoutes = new OpenAPIHono<AppEnv>();

fileRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/files`,
  authMiddleware(),
);
fileRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/files/*`,
  authMiddleware(),
);

// ---- Handlers ----

// GET /api/v1/repositories/:repoId/files — File tree
fileRoutes.openapi(fileTreeRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const query = c.req.valid("query");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  // Build SQL query with optional filters
  let sql = `SELECT file_path, language FROM indexed_files WHERE repository_id = $1`;
  const params: unknown[] = [repoId];
  let paramIdx = 2;

  if (query.path) {
    // Filter by path prefix (directory)
    sql += ` AND file_path LIKE $${paramIdx}`;
    // Escape special LIKE characters in path, then add wildcard
    const safePath = query.path
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const prefix = safePath.endsWith("/") ? safePath : safePath + "/";
    params.push(prefix + "%");
    paramIdx++;
  }

  if (query.language) {
    sql += ` AND language = $${paramIdx}`;
    params.push(query.language);
    paramIdx++;
  }

  sql += " ORDER BY file_path";

  const result = await pool.query<IndexedFileRow>(sql, params);
  const files = result.rows;

  logger.debug(
    { repoId, path: query.path, language: query.language, flat: query.flat, count: files.length },
    "File tree query",
  );

  if (query.flat === "true") {
    return c.json(
      {
        files: files.map((f) => ({
          path: f.file_path,
          name: f.file_path.split("/").pop() ?? f.file_path,
          language: f.language ?? null,
          type: "file" as const,
        })),
        total: files.length,
      },
      200,
    );
  }

  // Build hierarchical tree
  const tree = buildTree(files);
  return c.json({ tree, total: files.length }, 200);
});

// GET /api/v1/repositories/:repoId/files/* — File content + graph nodes
// Uses plain Hono handler since OpenAPI doesn't support wildcard path params
fileRoutes.get(
  `${config.API_PREFIX}/repositories/:repoId/files/*`,
  async (c) => {
    const repoId = c.req.param("repoId");
    const projectId = c.get("projectId");

    // Extract file path from URL: everything after /files/
    const prefix = `${config.API_PREFIX}/repositories/${repoId}/files/`;
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const filePath = urlPath.startsWith(prefix)
      ? urlPath.slice(prefix.length)
      : c.req.param("*");

    if (!repoId || !filePath) {
      return c.json({ error: "Missing repoId or filePath" }, 400);
    }

    const repo = await verifyRepoAccess(repoId, projectId);
    if (!repo) {
      return c.json({ error: "Repository not found" }, 404);
    }

    // Fetch file content
    const contentResult = await pool.query<FileContentRow>(
      `SELECT file_path, content
       FROM file_contents
       WHERE repository_id = $1 AND file_path = $2`,
      [repoId, filePath],
    );

    if (contentResult.rows.length === 0) {
      return c.json({ error: "File not found" }, 404);
    }

    const fileContent = contentResult.rows[0];
    const allLines = fileContent.content.split("\n");
    const totalLineCount = allLines.length;

    // Fetch language from indexed_files
    const langResult = await pool.query<{ language: string | null }>(
      `SELECT language FROM indexed_files WHERE repository_id = $1 AND file_path = $2`,
      [repoId, filePath],
    );
    const language = langResult.rows[0]?.language ?? null;

    // Fetch associated graph nodes (symbols defined in this file)
    let symbols: Array<{ id: number | string; label: string; properties: Record<string, unknown> }> = [];
    if (repo.graph_name) {
      try {
        const rows = await cypher<{ s: AgeVertex }>(
          repo.graph_name,
          `MATCH (f:File {path: $path})-[:DEFINES]->(s) RETURN s`,
          { path: filePath },
          [{ name: "s" }],
        );
        symbols = rows.map((r) => ({
          id: r.s.id,
          label: r.s.label,
          properties: r.s.properties,
        }));
      } catch (err) {
        logger.warn({ repoId, filePath, err }, "Failed to fetch graph nodes for file");
      }
    }

    // Support optional line range via query params
    const url = new URL(c.req.url);
    const startLineParam = url.searchParams.get("start_line");
    const endLineParam = url.searchParams.get("end_line");

    let content = fileContent.content;
    let lineCount = totalLineCount;
    let range: { start_line: number; end_line: number } | undefined;

    if (startLineParam || endLineParam) {
      const startLine = startLineParam ? Math.max(1, parseInt(startLineParam, 10)) : 1;
      const endLine = endLineParam ? Math.min(totalLineCount, parseInt(endLineParam, 10)) : totalLineCount;

      if (!isNaN(startLine) && !isNaN(endLine) && startLine <= endLine) {
        const sliced = allLines.slice(startLine - 1, endLine);
        content = sliced.join("\n");
        lineCount = sliced.length;
        range = { start_line: startLine, end_line: Math.min(endLine, totalLineCount) };
      }
    }

    logger.debug(
      { repoId, filePath, language, symbols: symbols.length, range },
      "File content retrieved",
    );

    return c.json(
      {
        path: filePath,
        language,
        content,
        line_count: lineCount,
        total_lines: totalLineCount,
        ...(range ? { range } : {}),
        symbols,
      },
      200,
    );
  },
);

export { fileRoutes };
