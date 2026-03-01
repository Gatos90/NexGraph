import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { cypher } from "../../db/age.js";
import type { AgeVertex } from "../../db/age.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";

const logger = createChildLogger("cross-repo");

// ---- DB Row Types ----

interface RepoRow {
  id: string;
  project_id: string;
  graph_name: string | null;
}

interface CrossRepoEdgeRow {
  id: string;
  project_id: string;
  source_repo_id: string;
  target_repo_id: string;
  source_node: string;
  target_node: string;
  edge_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ---- Shared Schemas ----

const ErrorResponse = z.object({
  error: z.string(),
});

const ProjectIdParams = z.object({
  projectId: z.string().uuid(),
});

// ---- Trace Schemas ----

const TraceRequestSchema = z.object({
  start_repo_id: z.string().uuid(),
  start_symbol: z.string().min(1).max(500),
  direction: z.enum(["forward", "backward", "both"]).default("forward"),
  max_depth: z.coerce.number().int().min(1).max(10).default(3),
});

const TraceNodeSchema = z.object({
  repo_id: z.string().uuid(),
  symbol_name: z.string(),
  label: z.string().optional(),
  file_path: z.string().optional(),
  properties: z.record(z.unknown()),
});

const TraceEdgeSchema = z.object({
  from_repo_id: z.string().uuid(),
  from_symbol: z.string(),
  to_repo_id: z.string().uuid(),
  to_symbol: z.string(),
  edge_type: z.string(),
  cross_repo: z.boolean(),
  metadata: z.record(z.unknown()).nullable(),
});

const TraceResultSchema = z.object({
  start: TraceNodeSchema,
  nodes: z.array(TraceNodeSchema),
  edges: z.array(TraceEdgeSchema),
  depth_reached: z.number(),
  repos_traversed: z.array(z.string().uuid()),
});

// ---- Impact Schemas ----

const CrossRepoImpactRequestSchema = z.object({
  repo_id: z.string().uuid(),
  symbol: z.string().min(1).max(500),
  depth: z.coerce.number().int().min(1).max(10).default(3),
});

const ImpactNodeSchema = z.object({
  repo_id: z.string().uuid(),
  symbol_name: z.string(),
  label: z.string().optional(),
  file_path: z.string().optional(),
  is_cross_repo: z.boolean(),
  properties: z.record(z.unknown()),
});

const CrossRepoImpactResultSchema = z.object({
  root: ImpactNodeSchema,
  affected: z.array(ImpactNodeSchema),
  summary: z.object({
    total_affected: z.number(),
    repos_affected: z.number(),
    by_repo: z.record(z.number()),
    by_edge_type: z.record(z.number()),
  }),
});

// ---- Stats Schemas ----

const CrossRepoStatsSchema = z.object({
  total_edges: z.number(),
  total_connections: z.number(),
  by_edge_type: z.record(z.number()),
  by_repo_pair: z.array(
    z.object({
      source_repo_id: z.string().uuid(),
      target_repo_id: z.string().uuid(),
      edge_count: z.number(),
    }),
  ),
  repos_involved: z.number(),
});

// ---- Route Definitions ----

const traceRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/graph/cross-repo/trace`,
  tags: ["Cross-Repo Graph"],
  summary: "Trace end-to-end flows across connected repositories",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": {
          schema: TraceRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: TraceResultSchema },
      },
      description: "Trace results",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid request",
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
      description: "Repository, graph, or symbol not found",
    },
  },
});

const crossRepoImpactRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/projects/{projectId}/graph/cross-repo/impact`,
  tags: ["Cross-Repo Graph"],
  summary: "Analyze blast radius across connected repositories",
  request: {
    params: ProjectIdParams,
    body: {
      content: {
        "application/json": {
          schema: CrossRepoImpactRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: CrossRepoImpactResultSchema },
      },
      description: "Cross-repo impact analysis results",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid request",
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
      description: "Repository, graph, or symbol not found",
    },
  },
});

const crossRepoStatsRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/graph/cross-repo/stats`,
  tags: ["Cross-Repo Graph"],
  summary: "Get cross-repo connection statistics",
  request: {
    params: ProjectIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: CrossRepoStatsSchema },
      },
      description: "Cross-repo statistics",
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

// ---- Helpers ----

async function getProjectRepos(
  projectId: string,
): Promise<Map<string, RepoRow>> {
  const result = await pool.query<RepoRow>(
    "SELECT id, project_id, graph_name FROM repositories WHERE project_id = $1",
    [projectId],
  );
  const map = new Map<string, RepoRow>();
  for (const row of result.rows) {
    map.set(row.id, row);
  }
  return map;
}

async function findSymbolInGraph(
  graphName: string,
  symbolName: string,
): Promise<AgeVertex | null> {
  try {
    const rows = await cypher<{ n: AgeVertex }>(
      graphName,
      "MATCH (n) WHERE n.name = $symbol RETURN n LIMIT 1",
      { symbol: symbolName },
      [{ name: "n" }],
    );
    return rows.length > 0 ? rows[0].n : null;
  } catch {
    return null;
  }
}

async function findLocalConnectedSymbols(
  graphName: string,
  symbolName: string,
  direction: "forward" | "backward" | "both",
): Promise<Array<{ name: string; label: string; file_path?: string; properties: Record<string, unknown> }>> {
  const results: Array<{ name: string; label: string; file_path?: string; properties: Record<string, unknown> }> = [];
  const seen = new Set<string>();

  const edgeTypes = ["CALLS", "EXTENDS", "IMPLEMENTS"] as const;

  for (const edgeType of edgeTypes) {
    const queries: string[] = [];

    if (direction === "forward" || direction === "both") {
      queries.push(
        `MATCH (source)-[:${edgeType}]->(n) WHERE source.name = $symbol RETURN DISTINCT n`,
      );
    }
    if (direction === "backward" || direction === "both") {
      queries.push(
        `MATCH (n)-[:${edgeType}]->(target) WHERE target.name = $symbol RETURN DISTINCT n`,
      );
    }

    for (const q of queries) {
      try {
        const rows = await cypher<{ n: AgeVertex }>(
          graphName,
          q,
          { symbol: symbolName },
          [{ name: "n" }],
        );

        for (const row of rows) {
          const props = row.n.properties;
          const name = typeof props.name === "string" ? props.name : "";
          if (name && !seen.has(name)) {
            seen.add(name);
            results.push({
              name,
              label: row.n.label,
              file_path: typeof props.file_path === "string" ? props.file_path : undefined,
              properties: props,
            });
          }
        }
      } catch {
        // Edge type may not exist in graph
      }
    }
  }

  return results;
}

async function getCrossRepoEdges(
  projectId: string,
  repoId: string,
  direction: "forward" | "backward" | "both",
): Promise<CrossRepoEdgeRow[]> {
  const conditions: string[] = ["project_id = $1"];
  const params: unknown[] = [projectId];

  if (direction === "forward") {
    conditions.push("source_repo_id = $2");
    params.push(repoId);
  } else if (direction === "backward") {
    conditions.push("target_repo_id = $2");
    params.push(repoId);
  } else {
    conditions.push("(source_repo_id = $2 OR target_repo_id = $2)");
    params.push(repoId);
  }

  const result = await pool.query<CrossRepoEdgeRow>(
    `SELECT id, project_id, source_repo_id, target_repo_id,
            source_node, target_node, edge_type, metadata, created_at
     FROM cross_repo_edges
     WHERE ${conditions.join(" AND ")}`,
    params,
  );

  return result.rows;
}

// ---- Router & Middleware ----

const crossRepoRoutes = new OpenAPIHono<AppEnv>();

crossRepoRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/graph/cross-repo/trace`,
  authMiddleware(),
);
crossRepoRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/graph/cross-repo/impact`,
  authMiddleware(),
);
crossRepoRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/graph/cross-repo/stats`,
  authMiddleware(),
);

// ---- Handlers ----

// POST /api/v1/projects/:projectId/graph/cross-repo/trace
crossRepoRoutes.openapi(traceRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { start_repo_id, start_symbol, direction, max_depth } =
    c.req.valid("json");

  // Load all project repos for graph lookups
  const repoMap = await getProjectRepos(projectId);

  const startRepo = repoMap.get(start_repo_id);
  if (!startRepo) {
    return c.json({ error: "Start repository not found in project" }, 404);
  }
  if (!startRepo.graph_name) {
    return c.json(
      { error: "Start repository has no graph — index it first" },
      404,
    );
  }

  // Find the starting symbol
  const startNode = await findSymbolInGraph(startRepo.graph_name, start_symbol);
  if (!startNode) {
    return c.json(
      { error: `Symbol '${start_symbol}' not found in repository graph` },
      404,
    );
  }

  const startProps = startNode.properties;

  interface TraceNode {
    repo_id: string;
    symbol_name: string;
    label?: string;
    file_path?: string;
    properties: Record<string, unknown>;
  }

  interface TraceEdge {
    from_repo_id: string;
    from_symbol: string;
    to_repo_id: string;
    to_symbol: string;
    edge_type: string;
    cross_repo: boolean;
    metadata: Record<string, unknown> | null;
  }

  const startTraceNode: TraceNode = {
    repo_id: start_repo_id,
    symbol_name: start_symbol,
    label: startNode.label,
    file_path:
      typeof startProps.file_path === "string" ? startProps.file_path : undefined,
    properties: startProps,
  };

  const allNodes: TraceNode[] = [];
  const allEdges: TraceEdge[] = [];
  const reposTraversed = new Set<string>([start_repo_id]);
  // Track visited (repo_id, symbol_name) to avoid cycles
  const visited = new Set<string>([`${start_repo_id}::${start_symbol}`]);

  // BFS frontier: (repo_id, symbol_name, current_depth)
  let frontier: Array<{ repoId: string; symbolName: string }> = [
    { repoId: start_repo_id, symbolName: start_symbol },
  ];

  let depthReached = 0;

  for (let depth = 0; depth < max_depth && frontier.length > 0; depth++) {
    depthReached = depth + 1;
    const nextFrontier: Array<{ repoId: string; symbolName: string }> = [];

    for (const { repoId, symbolName } of frontier) {
      const repo = repoMap.get(repoId);
      if (!repo?.graph_name) continue;

      // Step 1: Find locally connected symbols within the same repo graph
      const localSymbols = await findLocalConnectedSymbols(
        repo.graph_name,
        symbolName,
        direction,
      );

      for (const sym of localSymbols) {
        const key = `${repoId}::${sym.name}`;
        if (!visited.has(key)) {
          visited.add(key);
          const node: TraceNode = {
            repo_id: repoId,
            symbol_name: sym.name,
            label: sym.label,
            file_path: sym.file_path,
            properties: sym.properties,
          };
          allNodes.push(node);

          allEdges.push({
            from_repo_id: repoId,
            from_symbol: direction === "backward" ? sym.name : symbolName,
            to_repo_id: repoId,
            to_symbol: direction === "backward" ? symbolName : sym.name,
            edge_type: "LOCAL",
            cross_repo: false,
            metadata: null,
          });

          nextFrontier.push({ repoId, symbolName: sym.name });
        }
      }

      // Step 2: Lookup cross-repo edges from the relational table
      const crossEdges = await getCrossRepoEdges(projectId, repoId, direction);

      for (const edge of crossEdges) {
        // Determine if this edge connects to/from the current symbol
        const isSource = edge.source_repo_id === repoId;
        const edgeSymbol = isSource ? edge.source_node : edge.target_node;

        // The cross-repo edge references a symbol name — check if it matches
        // what we're currently tracing from
        if (edgeSymbol !== symbolName) continue;

        const targetRepoId = isSource
          ? edge.target_repo_id
          : edge.source_repo_id;
        const targetSymbol = isSource
          ? edge.target_node
          : edge.source_node;

        const key = `${targetRepoId}::${targetSymbol}`;
        if (visited.has(key)) continue;
        visited.add(key);

        const targetRepo = repoMap.get(targetRepoId);
        if (!targetRepo?.graph_name) continue;

        reposTraversed.add(targetRepoId);

        // Look up the target symbol in the target repo's graph
        const targetNode = await findSymbolInGraph(
          targetRepo.graph_name,
          targetSymbol,
        );
        const targetProps = targetNode?.properties ?? {};

        const node: TraceNode = {
          repo_id: targetRepoId,
          symbol_name: targetSymbol,
          label: targetNode?.label,
          file_path:
            typeof targetProps.file_path === "string"
              ? targetProps.file_path
              : undefined,
          properties: targetProps,
        };
        allNodes.push(node);

        allEdges.push({
          from_repo_id: edge.source_repo_id,
          from_symbol: edge.source_node,
          to_repo_id: edge.target_repo_id,
          to_symbol: edge.target_node,
          edge_type: edge.edge_type,
          cross_repo: true,
          metadata: edge.metadata,
        });

        nextFrontier.push({ repoId: targetRepoId, symbolName: targetSymbol });
      }
    }

    frontier = nextFrontier;
  }

  return c.json(
    {
      start: startTraceNode,
      nodes: allNodes,
      edges: allEdges,
      depth_reached: depthReached,
      repos_traversed: Array.from(reposTraversed),
    },
    200,
  );
});

// POST /api/v1/projects/:projectId/graph/cross-repo/impact
crossRepoRoutes.openapi(crossRepoImpactRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { repo_id, symbol, depth } = c.req.valid("json");

  const repoMap = await getProjectRepos(projectId);

  const startRepo = repoMap.get(repo_id);
  if (!startRepo) {
    return c.json({ error: "Repository not found in project" }, 404);
  }
  if (!startRepo.graph_name) {
    return c.json(
      { error: "Repository has no graph — index it first" },
      404,
    );
  }

  // Find the root symbol
  const rootVertex = await findSymbolInGraph(startRepo.graph_name, symbol);
  if (!rootVertex) {
    return c.json(
      { error: `Symbol '${symbol}' not found in repository graph` },
      404,
    );
  }

  const rootProps = rootVertex.properties;

  interface ImpactNode {
    repo_id: string;
    symbol_name: string;
    label?: string;
    file_path?: string;
    is_cross_repo: boolean;
    properties: Record<string, unknown>;
  }

  const rootImpactNode: ImpactNode = {
    repo_id: repo_id,
    symbol_name: symbol,
    label: rootVertex.label,
    file_path:
      typeof rootProps.file_path === "string" ? rootProps.file_path : undefined,
    is_cross_repo: false,
    properties: rootProps,
  };

  const affected: ImpactNode[] = [];
  const visited = new Set<string>([`${repo_id}::${symbol}`]);
  const byRepo: Record<string, number> = {};
  const byEdgeType: Record<string, number> = {};

  // BFS to find local + cross-repo impact
  let frontier: Array<{ repoId: string; symbolName: string }> = [
    { repoId: repo_id, symbolName: symbol },
  ];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: Array<{ repoId: string; symbolName: string }> = [];

    for (const { repoId, symbolName } of frontier) {
      const repo = repoMap.get(repoId);
      if (!repo?.graph_name) continue;

      // Local impact: callers (backward traversal — who depends on this symbol)
      const localCallers = await findLocalConnectedSymbols(
        repo.graph_name,
        symbolName,
        "backward",
      );

      for (const sym of localCallers) {
        const key = `${repoId}::${sym.name}`;
        if (visited.has(key)) continue;
        visited.add(key);

        affected.push({
          repo_id: repoId,
          symbol_name: sym.name,
          label: sym.label,
          file_path: sym.file_path,
          is_cross_repo: false,
          properties: sym.properties,
        });

        byRepo[repoId] = (byRepo[repoId] ?? 0) + 1;
        byEdgeType["LOCAL"] = (byEdgeType["LOCAL"] ?? 0) + 1;

        nextFrontier.push({ repoId, symbolName: sym.name });
      }

      // Cross-repo impact: find edges where this repo's symbol is the target
      // (meaning other repos depend on this symbol)
      const crossEdges = await getCrossRepoEdges(
        projectId,
        repoId,
        "both",
      );

      for (const edge of crossEdges) {
        // For impact, we want edges where target_node matches our symbol
        // (meaning something calls/depends on our symbol from another repo)
        const matchesAsTarget =
          edge.target_repo_id === repoId && edge.target_node === symbolName;
        const matchesAsSource =
          edge.source_repo_id === repoId && edge.source_node === symbolName;

        if (!matchesAsTarget && !matchesAsSource) continue;

        const otherRepoId = matchesAsTarget
          ? edge.source_repo_id
          : edge.target_repo_id;
        const otherSymbol = matchesAsTarget
          ? edge.source_node
          : edge.target_node;

        const key = `${otherRepoId}::${otherSymbol}`;
        if (visited.has(key)) continue;
        visited.add(key);

        const otherRepo = repoMap.get(otherRepoId);
        if (!otherRepo?.graph_name) continue;

        const otherVertex = await findSymbolInGraph(
          otherRepo.graph_name,
          otherSymbol,
        );
        const otherProps = otherVertex?.properties ?? {};

        affected.push({
          repo_id: otherRepoId,
          symbol_name: otherSymbol,
          label: otherVertex?.label,
          file_path:
            typeof otherProps.file_path === "string"
              ? otherProps.file_path
              : undefined,
          is_cross_repo: true,
          properties: otherProps,
        });

        byRepo[otherRepoId] = (byRepo[otherRepoId] ?? 0) + 1;
        byEdgeType[edge.edge_type] = (byEdgeType[edge.edge_type] ?? 0) + 1;

        nextFrontier.push({
          repoId: otherRepoId,
          symbolName: otherSymbol,
        });
      }
    }

    frontier = nextFrontier;
  }

  return c.json(
    {
      root: rootImpactNode,
      affected,
      summary: {
        total_affected: affected.length,
        repos_affected: Object.keys(byRepo).length,
        by_repo: byRepo,
        by_edge_type: byEdgeType,
      },
    },
    200,
  );
});

// GET /api/v1/projects/:projectId/graph/cross-repo/stats
crossRepoRoutes.openapi(crossRepoStatsRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Total edges
  const totalResult = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM cross_repo_edges WHERE project_id = $1",
    [projectId],
  );
  const totalEdges = parseInt(totalResult.rows[0].count, 10);

  // Total connections (rules)
  const connResult = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM repo_connections WHERE project_id = $1",
    [projectId],
  );
  const totalConnections = parseInt(connResult.rows[0].count, 10);

  // Edges by type
  const byTypeResult = await pool.query<{
    edge_type: string;
    count: string;
  }>(
    `SELECT edge_type, COUNT(*)::text AS count
     FROM cross_repo_edges
     WHERE project_id = $1
     GROUP BY edge_type
     ORDER BY count DESC`,
    [projectId],
  );
  const byEdgeType: Record<string, number> = {};
  for (const row of byTypeResult.rows) {
    byEdgeType[row.edge_type] = parseInt(row.count, 10);
  }

  // Edges by repo pair
  const byPairResult = await pool.query<{
    source_repo_id: string;
    target_repo_id: string;
    count: string;
  }>(
    `SELECT source_repo_id, target_repo_id, COUNT(*)::text AS count
     FROM cross_repo_edges
     WHERE project_id = $1
     GROUP BY source_repo_id, target_repo_id
     ORDER BY count DESC`,
    [projectId],
  );
  const byRepoPair = byPairResult.rows.map((row) => ({
    source_repo_id: row.source_repo_id,
    target_repo_id: row.target_repo_id,
    edge_count: parseInt(row.count, 10),
  }));

  // Count distinct repos involved
  const reposResult = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT repo_id)::text AS count FROM (
       SELECT source_repo_id AS repo_id FROM cross_repo_edges WHERE project_id = $1
       UNION
       SELECT target_repo_id AS repo_id FROM cross_repo_edges WHERE project_id = $1
     ) AS repos`,
    [projectId],
  );
  const reposInvolved = parseInt(reposResult.rows[0].count, 10);

  logger.debug(
    { projectId, totalEdges, totalConnections },
    "Cross-repo stats retrieved",
  );

  return c.json(
    {
      total_edges: totalEdges,
      total_connections: totalConnections,
      by_edge_type: byEdgeType,
      by_repo_pair: byRepoPair,
      repos_involved: reposInvolved,
    },
    200,
  );
});

export { crossRepoRoutes };
