import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { cypher } from "../../db/age.js";
import type { AgeVertex, AgeEdge } from "../../db/age.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";

const logger = createChildLogger("export");

// ---- DB Row Types ----

interface RepositoryRow {
  id: string;
  project_id: string;
  name: string | null;
  graph_name: string | null;
}

interface CrossRepoEdgeRow {
  id: string;
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

const RepoIdParams = z.object({
  repoId: z.string().uuid(),
});

const ProjectIdParams = z.object({
  projectId: z.string().uuid(),
});

const ExportNodeSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  properties: z.record(z.unknown()),
});

const ExportEdgeSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  start_id: z.union([z.number(), z.string()]),
  end_id: z.union([z.number(), z.string()]),
  properties: z.record(z.unknown()),
});

// ---- Helpers ----

async function verifyRepoAccess(
  repoId: string,
  projectId: string,
): Promise<RepositoryRow | null> {
  const result = await pool.query<RepositoryRow>(
    `SELECT id, project_id, name, graph_name
     FROM repositories WHERE id = $1`,
    [repoId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows[0].project_id !== projectId) return null;
  return result.rows[0];
}

function hasGraph(
  repo: RepositoryRow | null,
): repo is RepositoryRow & { graph_name: string } {
  return repo !== null && repo.graph_name !== null;
}

async function fetchAllNodes(graphName: string): Promise<AgeVertex[]> {
  const rows = await cypher<{ n: AgeVertex }>(
    graphName,
    "MATCH (n) RETURN n",
    undefined,
    [{ name: "n" }],
  );
  return rows.map((r) => r.n);
}

async function fetchAllEdges(
  graphName: string,
): Promise<Array<{ edge: AgeEdge; source: AgeVertex; target: AgeVertex }>> {
  const rows = await cypher<{ a: AgeVertex; e: AgeEdge; b: AgeVertex }>(
    graphName,
    "MATCH (a)-[e]->(b) RETURN a, e, b",
    undefined,
    [{ name: "a" }, { name: "e" }, { name: "b" }],
  );
  return rows.map((r) => ({ source: r.a, edge: r.e, target: r.b }));
}

function escapeCSV(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function nodesToCSV(nodes: AgeVertex[]): string {
  const header = "id,label,name,file_path,exported,kind,properties";
  const rows = nodes.map((n) => {
    const props = n.properties;
    return [
      String(n.id),
      escapeCSV(n.label),
      escapeCSV(String(props.name ?? "")),
      escapeCSV(String(props.file_path ?? "")),
      String(props.exported ?? ""),
      escapeCSV(String(props.kind ?? "")),
      escapeCSV(JSON.stringify(props)),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

function edgesToCSV(
  edges: Array<{ edge: AgeEdge; source: AgeVertex; target: AgeVertex }>,
): string {
  const header =
    "id,label,start_id,end_id,source_name,target_name,properties";
  const rows = edges.map(({ edge, source, target }) => {
    return [
      String(edge.id),
      escapeCSV(edge.label),
      String(edge.start_id),
      String(edge.end_id),
      escapeCSV(String(source.properties.name ?? "")),
      escapeCSV(String(target.properties.name ?? "")),
      escapeCSV(JSON.stringify(edge.properties)),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

function escapeCypherString(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function buildCypherProps(props: Record<string, unknown>): string {
  const entries = Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${escapeCypherString(v)}`);
  return entries.length > 0 ? ` {${entries.join(", ")}}` : "";
}

function nodesToCypher(nodes: AgeVertex[]): string[] {
  return nodes.map((n) => {
    const propsStr = buildCypherProps(n.properties);
    return `CREATE (:${n.label}${propsStr});`;
  });
}

function edgesToCypher(
  edges: Array<{ edge: AgeEdge; source: AgeVertex; target: AgeVertex }>,
): string[] {
  return edges.map(({ edge, source, target }) => {
    const srcName = String(source.properties.name ?? "");
    const tgtName = String(target.properties.name ?? "");
    const propsStr = buildCypherProps(edge.properties);
    return (
      `MATCH (a:${source.label} {name: ${escapeCypherString(srcName)}}), ` +
      `(b:${target.label} {name: ${escapeCypherString(tgtName)}}) ` +
      `CREATE (a)-[:${edge.label}${propsStr}]->(b);`
    );
  });
}

// ---- Route Definitions ----

const exportJsonRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/export/json`,
  tags: ["Export"],
  summary: "Export repository knowledge graph as JSON",
  request: {
    params: RepoIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            nodes: z.array(ExportNodeSchema),
            edges: z.array(ExportEdgeSchema),
            metadata: z.object({
              repo_id: z.string().uuid(),
              node_count: z.number(),
              edge_count: z.number(),
              exported_at: z.string(),
            }),
          }),
        },
      },
      description: "Graph as JSON with nodes and edges",
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
      description: "Repository not found or has no graph",
    },
  },
});

const exportCsvRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/export/csv`,
  tags: ["Export"],
  summary: "Export repository knowledge graph as CSV (nodes + edges)",
  request: {
    params: RepoIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            nodes_csv: z.string(),
            edges_csv: z.string(),
            metadata: z.object({
              repo_id: z.string().uuid(),
              node_count: z.number(),
              edge_count: z.number(),
              exported_at: z.string(),
            }),
          }),
        },
      },
      description: "Nodes.csv + edges.csv as strings in JSON envelope",
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
      description: "Repository not found or has no graph",
    },
  },
});

const exportCypherRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/export/cypher`,
  tags: ["Export"],
  summary: "Export repository knowledge graph as Cypher CREATE statements",
  request: {
    params: RepoIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            cypher: z.string(),
            metadata: z.object({
              repo_id: z.string().uuid(),
              node_count: z.number(),
              edge_count: z.number(),
              exported_at: z.string(),
            }),
          }),
        },
      },
      description: "Cypher CREATE statements for recreating the graph",
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
      description: "Repository not found or has no graph",
    },
  },
});

const exportFullRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/projects/{projectId}/export/full`,
  tags: ["Export"],
  summary: "Export all repositories and cross-repo edges for a project",
  request: {
    params: ProjectIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            repositories: z.array(
              z.object({
                repo_id: z.string().uuid(),
                repo_name: z.string().nullable(),
                nodes: z.array(ExportNodeSchema),
                edges: z.array(ExportEdgeSchema),
              }),
            ),
            cross_repo_edges: z.array(
              z.object({
                id: z.string().uuid(),
                source_repo_id: z.string().uuid(),
                target_repo_id: z.string().uuid(),
                source_node: z.string(),
                target_node: z.string(),
                edge_type: z.string(),
                metadata: z.record(z.unknown()).nullable(),
              }),
            ),
            metadata: z.object({
              project_id: z.string().uuid(),
              repo_count: z.number(),
              total_nodes: z.number(),
              total_edges: z.number(),
              cross_repo_edge_count: z.number(),
              exported_at: z.string(),
            }),
          }),
        },
      },
      description: "Full project export with all repos and cross-repo edges",
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

const exportRoutes = new OpenAPIHono<AppEnv>();

exportRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/export/json`,
  authMiddleware(),
);
exportRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/export/csv`,
  authMiddleware(),
);
exportRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/export/cypher`,
  authMiddleware(),
);
exportRoutes.use(
  `${config.API_PREFIX}/projects/:projectId/export/full`,
  authMiddleware(),
);

// ---- Handlers ----

// GET /api/v1/repositories/:repoId/export/json
exportRoutes.openapi(exportJsonRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!hasGraph(repo)) {
    return c.json(
      {
        error: repo
          ? "Repository has no graph — index it first"
          : "Repository not found",
      },
      404,
    );
  }

  const nodes = await fetchAllNodes(repo.graph_name);
  const edgeTriples = await fetchAllEdges(repo.graph_name);

  logger.debug(
    { repoId, nodeCount: nodes.length, edgeCount: edgeTriples.length },
    "JSON export completed",
  );

  return c.json(
    {
      nodes,
      edges: edgeTriples.map(({ edge }) => edge),
      metadata: {
        repo_id: repoId,
        node_count: nodes.length,
        edge_count: edgeTriples.length,
        exported_at: new Date().toISOString(),
      },
    },
    200,
  );
});

// GET /api/v1/repositories/:repoId/export/csv
exportRoutes.openapi(exportCsvRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!hasGraph(repo)) {
    return c.json(
      {
        error: repo
          ? "Repository has no graph — index it first"
          : "Repository not found",
      },
      404,
    );
  }

  const nodes = await fetchAllNodes(repo.graph_name);
  const edgeTriples = await fetchAllEdges(repo.graph_name);

  logger.debug(
    { repoId, nodeCount: nodes.length, edgeCount: edgeTriples.length },
    "CSV export completed",
  );

  return c.json(
    {
      nodes_csv: nodesToCSV(nodes),
      edges_csv: edgesToCSV(edgeTriples),
      metadata: {
        repo_id: repoId,
        node_count: nodes.length,
        edge_count: edgeTriples.length,
        exported_at: new Date().toISOString(),
      },
    },
    200,
  );
});

// GET /api/v1/repositories/:repoId/export/cypher
exportRoutes.openapi(exportCypherRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!hasGraph(repo)) {
    return c.json(
      {
        error: repo
          ? "Repository has no graph — index it first"
          : "Repository not found",
      },
      404,
    );
  }

  const nodes = await fetchAllNodes(repo.graph_name);
  const edgeTriples = await fetchAllEdges(repo.graph_name);

  const nodeStatements = nodesToCypher(nodes);
  const edgeStatements = edgesToCypher(edgeTriples);
  const allStatements = [
    "// Nodes",
    ...nodeStatements,
    "",
    "// Edges",
    ...edgeStatements,
  ].join("\n");

  logger.debug(
    { repoId, nodeCount: nodes.length, edgeCount: edgeTriples.length },
    "Cypher export completed",
  );

  return c.json(
    {
      cypher: allStatements,
      metadata: {
        repo_id: repoId,
        node_count: nodes.length,
        edge_count: edgeTriples.length,
        exported_at: new Date().toISOString(),
      },
    },
    200,
  );
});

// GET /api/v1/projects/:projectId/export/full
exportRoutes.openapi(exportFullRoute, async (c) => {
  const { projectId } = c.req.valid("param");
  const authedProjectId = c.get("projectId");

  if (projectId !== authedProjectId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Fetch all repos in the project
  const repoResult = await pool.query<RepositoryRow>(
    `SELECT id, project_id, name, graph_name
     FROM repositories
     WHERE project_id = $1
     ORDER BY created_at ASC`,
    [projectId],
  );

  const repositories: Array<{
    repo_id: string;
    repo_name: string | null;
    nodes: AgeVertex[];
    edges: AgeEdge[];
  }> = [];

  let totalNodes = 0;
  let totalEdges = 0;

  for (const repo of repoResult.rows) {
    if (!repo.graph_name) {
      repositories.push({
        repo_id: repo.id,
        repo_name: repo.name,
        nodes: [],
        edges: [],
      });
      continue;
    }

    const nodes = await fetchAllNodes(repo.graph_name);
    const edgeTriples = await fetchAllEdges(repo.graph_name);

    totalNodes += nodes.length;
    totalEdges += edgeTriples.length;

    repositories.push({
      repo_id: repo.id,
      repo_name: repo.name,
      nodes,
      edges: edgeTriples.map(({ edge }) => edge),
    });
  }

  // Fetch cross-repo edges
  const crossResult = await pool.query<CrossRepoEdgeRow>(
    `SELECT id, source_repo_id, target_repo_id, source_node,
            target_node, edge_type, metadata, created_at
     FROM cross_repo_edges
     WHERE project_id = $1
     ORDER BY created_at ASC`,
    [projectId],
  );

  const crossRepoEdges = crossResult.rows.map((row) => ({
    id: row.id,
    source_repo_id: row.source_repo_id,
    target_repo_id: row.target_repo_id,
    source_node: row.source_node,
    target_node: row.target_node,
    edge_type: row.edge_type,
    metadata: row.metadata,
  }));

  logger.debug(
    {
      projectId,
      repoCount: repositories.length,
      totalNodes,
      totalEdges,
      crossRepoEdges: crossRepoEdges.length,
    },
    "Full project export completed",
  );

  return c.json(
    {
      repositories,
      cross_repo_edges: crossRepoEdges,
      metadata: {
        project_id: projectId,
        repo_count: repositories.length,
        total_nodes: totalNodes,
        total_edges: totalEdges,
        cross_repo_edge_count: crossRepoEdges.length,
        exported_at: new Date().toISOString(),
      },
    },
    200,
  );
});

export { exportRoutes };
