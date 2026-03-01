import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import picomatch from "picomatch";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { cypher } from "../../db/age.js";
import type { AgeVertex, AgeEdge, AgePath } from "../../db/age.js";
import { authMiddleware } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";
import { analyzeChanges } from "../../ingestion/diff-impact.js";
import type { DiffScope } from "../../ingestion/diff-impact.js";
import { getGitHistoryForRepo, getGitTimelineForRepo } from "../../ingestion/git-history.js";
import { renameSymbol } from "../../ingestion/rename.js";

const logger = createChildLogger("graph-routes");

// ---- DB Row Types ----

interface RepositoryRow {
  id: string;
  project_id: string;
  graph_name: string | null;
}

// ---- Shared Schemas ----

const ErrorResponse = z.object({
  error: z.string(),
});

const RepoIdParams = z.object({
  repoId: z.string().uuid(),
});

const CypherRequestSchema = z.object({
  query: z.string().min(1).max(10000),
  params: z.record(z.unknown()).optional(),
  columns: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
      }),
    )
    .min(1)
    .max(50)
    .optional(),
});

const CypherResultSchema = z.object({
  rows: z.array(z.record(z.unknown())),
  columns: z.array(z.string()),
  row_count: z.number(),
});

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const NodeSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  properties: z.record(z.unknown()),
});

const EdgeWithEndpointsSchema = z.object({
  edge: z.object({
    id: z.union([z.number(), z.string()]),
    label: z.string(),
    start_id: z.union([z.number(), z.string()]),
    end_id: z.union([z.number(), z.string()]),
    properties: z.record(z.unknown()),
  }),
  source: NodeSchema,
  target: NodeSchema,
});

const ListNodesQuery = z.object({
  label: z.string().optional(),
  name: z.string().optional(),
  file_path: z.string().optional(),
  exported: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const NodeDetailParams = z.object({
  repoId: z.string().uuid(),
  nodeId: z.string(),
});

const ListEdgesQuery = z.object({
  type: z.string().optional(),
  source_label: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const DependencyRequestSchema = z.object({
  file_path: z.string().optional(),
  symbol: z.string().min(1).max(500).optional(),
  depth: z.coerce.number().int().min(1).max(10).default(1),
});

const DependencyNodeSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  name: z.string().optional(),
  file_path: z.string().optional(),
  properties: z.record(z.unknown()),
});

const FileDependencyResultSchema = z.object({
  type: z.literal("file"),
  root: NodeSchema,
  imports: z.array(DependencyNodeSchema),
  imported_by: z.array(DependencyNodeSchema),
});

const SymbolDependencyResultSchema = z.object({
  type: z.literal("symbol"),
  root: NodeSchema,
  calls: z.array(DependencyNodeSchema),
  called_by: z.array(DependencyNodeSchema),
});

const DependencyResultSchema = z.union([
  FileDependencyResultSchema,
  SymbolDependencyResultSchema,
]);

const ImpactRequestSchema = z.object({
  symbol: z.string().min(1).max(500),
  direction: z.enum(["callers", "callees", "both"]).default("both"),
  depth: z.coerce.number().int().min(1).max(10).default(3),
  file_path: z.string().optional(),
  include_cross_repo: z.boolean().default(true),
});

const AffectedSymbolSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  name: z.string().optional(),
  file_path: z.string().optional(),
  repo: z.string().optional(),
  is_cross_repo: z.boolean().optional(),
  relationship_type: z.string(),
  properties: z.record(z.unknown()),
});

const ImpactResultSchema = z.object({
  root: NodeSchema,
  affected: z.array(AffectedSymbolSchema),
  summary: z.object({
    total_affected: z.number(),
    cross_repo_affected: z.number().optional(),
    by_relationship_type: z.record(z.number()),
  }),
});

const PathRequestSchema = z.object({
  from: z.string().min(1).max(500),
  to: z.string().min(1).max(500),
  max_depth: z.coerce.number().int().min(1).max(10).default(5),
  from_file_path: z.string().optional(),
  to_file_path: z.string().optional(),
});

const PathEdgeSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  start_id: z.union([z.number(), z.string()]),
  end_id: z.union([z.number(), z.string()]),
  properties: z.record(z.unknown()),
});

const PathResultSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(PathEdgeSchema),
  length: z.number(),
});

// ---- Stats / Orphans / Routes Schemas ----

const StatsResultSchema = z.object({
  nodes: z.record(z.number()),
  edges: z.record(z.number()),
  total_nodes: z.number(),
  total_edges: z.number(),
});

const OrphanNodeSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  name: z.string().optional(),
  file_path: z.string().optional(),
  properties: z.record(z.unknown()),
});

const OrphansResultSchema = z.object({
  orphans: z.array(OrphanNodeSchema),
  count: z.number(),
});

const OrphansQuery = z.object({
  label: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const RouteEntrySchema = z.object({
  http_method: z.string(),
  url_pattern: z.string(),
  framework: z.string().optional(),
  handler_name: z.string().optional(),
  file_path: z.string().optional(),
  start_line: z.number().optional(),
});

const RoutesResultSchema = z.object({
  routes: z.array(RouteEntrySchema),
  count: z.number(),
});

// ---- Architecture Check Schemas ----

const DenyRuleSchema = z.object({
  from: z.string().min(1),
  deny: z.array(z.string().min(1)).min(1),
});

const ArchitectureCheckRequestSchema = z.object({
  layers: z.record(z.string().min(1)).optional(),
  rules: z.array(DenyRuleSchema).optional(),
  save: z.boolean().default(false),
  edge_types: z.array(z.enum(["IMPORTS", "CALLS"])).default(["IMPORTS", "CALLS"]),
});

const ViolationSchema = z.object({
  rule: z.string(),
  source_file: z.string(),
  source_symbol: z.string(),
  target_file: z.string(),
  target_symbol: z.string(),
  edge_type: z.string(),
  line: z.number().nullable(),
});

const ArchitectureCheckResultSchema = z.object({
  violations: z.array(ViolationSchema),
  summary: z.object({
    total_violations: z.number(),
    rules_checked: z.number(),
    layers_found: z.number(),
    files_classified: z.record(z.number()),
  }),
});

// ---- Community Schemas ----

const CommunityEntrySchema = z.object({
  community_id: z.string(),
  label: z.string(),
  heuristic_label: z.string(),
  cohesion: z.number(),
  symbol_count: z.number(),
  keywords: z.string(),
});

const CommunityMemberSchema = z.object({
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  name: z.string().optional(),
  file_path: z.string().optional(),
});

const CommunitiesListResultSchema = z.object({
  communities: z.array(CommunityEntrySchema),
  count: z.number(),
  total: z.number(),
});

const CommunityDetailResultSchema = z.object({
  community: CommunityEntrySchema,
  members: z.array(CommunityMemberSchema),
});

const CommunitiesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const CommunityIdParams = z.object({
  repoId: z.string().uuid(),
  communityId: z.string(),
});

// ---- Process Schemas ----

const ProcessEntrySchema = z.object({
  process_id: z.string(),
  label: z.string(),
  heuristic_label: z.string(),
  process_type: z.string(),
  step_count: z.number(),
  entry_point_name: z.string(),
  terminal_name: z.string(),
});

const ProcessStepSchema = z.object({
  step: z.number(),
  id: z.union([z.number(), z.string()]),
  label: z.string(),
  name: z.string().optional(),
  file_path: z.string().optional(),
});

const ProcessesListResultSchema = z.object({
  processes: z.array(ProcessEntrySchema),
  count: z.number(),
  total: z.number(),
});

const ProcessDetailResultSchema = z.object({
  process: ProcessEntrySchema,
  steps: z.array(ProcessStepSchema),
});

const ProcessesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.enum(["intra_community", "cross_community"]).optional(),
});

const ProcessIdParams = z.object({
  repoId: z.string().uuid(),
  processId: z.string(),
});

// ---- Diff Impact Schemas ----

const DiffImpactRequestSchema = z.object({
  scope: z.enum(["unstaged", "staged", "all", "compare"]).default("all"),
  compare_ref: z.string().optional(),
  max_depth: z.coerce.number().int().min(1).max(10).default(3),
});

const DiffChangedFileSchema = z.object({
  filePath: z.string(),
  addedLines: z.array(z.number()),
  removedLines: z.array(z.number()),
  hunks: z.array(z.object({
    oldStart: z.number(),
    oldCount: z.number(),
    newStart: z.number(),
    newCount: z.number(),
    header: z.string(),
  })),
  additions: z.number(),
  deletions: z.number(),
});

const DiffDirectSymbolSchema = z.object({
  id: z.number(),
  name: z.string(),
  label: z.string(),
  filePath: z.string(),
  line: z.number(),
});

const DiffImpactedSymbolSchema = z.object({
  id: z.number(),
  name: z.string(),
  label: z.string(),
  filePath: z.string(),
  line: z.number(),
  depth: z.number(),
  via: z.string(),
});

const DiffAffectedProcessSchema = z.object({
  processId: z.number(),
  label: z.string(),
  processType: z.string(),
  stepCount: z.number(),
});

const DiffImpactResultSchema = z.object({
  changed_files: z.array(DiffChangedFileSchema),
  direct_symbols: z.array(DiffDirectSymbolSchema),
  impacted_symbols: z.array(DiffImpactedSymbolSchema),
  affected_processes: z.array(DiffAffectedProcessSchema),
  risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  summary: z.string(),
});

// ---- Route Definitions ----

const StatsQuery = z.object({
  extended: z.string().optional(),
});

const graphStatsRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/stats`,
  tags: ["Graph"],
  summary: "Get node and edge counts by type",
  request: {
    params: RepoIdParams,
    query: StatsQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: StatsResultSchema,
        },
      },
      description: "Graph statistics with node/edge counts by type",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const graphOrphansRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/orphans`,
  tags: ["Graph"],
  summary: "Find unreferenced symbols (no incoming edges)",
  request: {
    params: RepoIdParams,
    query: OrphansQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OrphansResultSchema,
        },
      },
      description: "Unreferenced symbol nodes",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid filter parameters",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const graphRoutesRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/routes`,
  tags: ["Graph"],
  summary: "List all HTTP route handlers in the repository",
  request: {
    params: RepoIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RoutesResultSchema,
        },
      },
      description: "All HTTP route handlers",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const executeCypherRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/cypher`,
  tags: ["Graph"],
  summary: "Execute a raw Cypher query against a repository's graph",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: CypherRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CypherResultSchema,
        },
      },
      description: "Cypher query results",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid query",
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

const listNodesRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/nodes`,
  tags: ["Graph"],
  summary: "List and filter graph nodes",
  request: {
    params: RepoIdParams,
    query: ListNodesQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            nodes: z.array(NodeSchema),
            count: z.number(),
          }),
        },
      },
      description: "List of graph nodes",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid filter parameters",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const getNodeRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/nodes/{nodeId}`,
  tags: ["Graph"],
  summary: "Get a single node with all its relationships",
  request: {
    params: NodeDetailParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            node: NodeSchema,
            relationships: z.object({
              outgoing: z.array(EdgeWithEndpointsSchema),
              incoming: z.array(EdgeWithEndpointsSchema),
            }),
          }),
        },
      },
      description: "Node details with relationships",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid node ID",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository or node not found",
    },
  },
});

const listEdgesRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/edges`,
  tags: ["Graph"],
  summary: "List and filter graph edges",
  request: {
    params: RepoIdParams,
    query: ListEdgesQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            edges: z.array(EdgeWithEndpointsSchema),
            count: z.number(),
          }),
        },
      },
      description: "List of graph edges",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid filter parameters",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const impactAnalysisRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/impact`,
  tags: ["Graph"],
  summary: "Analyze the blast radius of a symbol change",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: ImpactRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ImpactResultSchema,
        },
      },
      description: "Impact analysis results",
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

const dependencyTreeRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/dependencies`,
  tags: ["Graph"],
  summary: "Query file-level or symbol-level dependency trees",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: DependencyRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: DependencyResultSchema,
        },
      },
      description: "Dependency tree results",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid request — must provide file_path or symbol",
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
      description: "Repository, graph, file, or symbol not found",
    },
  },
});

const pathFindingRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/path`,
  tags: ["Graph"],
  summary: "Find the shortest path between two symbols",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: PathRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: PathResultSchema,
        },
      },
      description: "Shortest path between the two symbols",
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

const architectureCheckRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/architecture`,
  tags: ["Graph"],
  summary: "Detect architectural layer violations in the codebase",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: ArchitectureCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ArchitectureCheckResultSchema,
        },
      },
      description: "Architecture check results with any layer violations",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid request — missing layer definitions or rules",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const communitiesListRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/communities`,
  tags: ["Graph"],
  summary: "List detected communities with pagination",
  request: {
    params: RepoIdParams,
    query: CommunitiesQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CommunitiesListResultSchema,
        },
      },
      description: "List of communities sorted by symbol_count desc",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const communityDetailRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/communities/{communityId}`,
  tags: ["Graph"],
  summary: "Get a specific community with its members",
  request: {
    params: CommunityIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CommunityDetailResultSchema,
        },
      },
      description: "Community details with member list",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository or community not found",
    },
  },
});

const processesListRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/processes`,
  tags: ["Graph"],
  summary: "List detected processes with pagination and type filter",
  request: {
    params: RepoIdParams,
    query: ProcessesQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ProcessesListResultSchema,
        },
      },
      description: "List of processes sorted by step_count desc",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

const processDetailRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/processes/{processId}`,
  tags: ["Graph"],
  summary: "Get a specific process with its ordered steps",
  request: {
    params: ProcessIdParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ProcessDetailResultSchema,
        },
      },
      description: "Process details with ordered step sequence",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository or process not found",
    },
  },
});

const diffImpactRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/diff-impact`,
  tags: ["Graph"],
  summary: "Analyze git diff impact on graph symbols and processes",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: DiffImpactRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: DiffImpactResultSchema,
        },
      },
      description: "Diff impact analysis results with risk assessment",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

// ---- Git History Route ----

const GitFileInfoSchema = z.object({
  file_path: z.string(),
  last_author: z.string(),
  last_author_email: z.string(),
  last_commit_date: z.string(),
  commit_count: z.number(),
  recent_commits: z.array(z.object({
    sha: z.string(),
    author: z.string(),
    email: z.string(),
    date: z.string(),
    message: z.string(),
  })),
});

const GitAuthorSchema = z.object({
  name: z.string(),
  email: z.string(),
  file_count: z.number(),
  commit_count: z.number(),
});

const GitHistoryResultSchema = z.object({
  files: z.array(GitFileInfoSchema),
  authors: z.array(GitAuthorSchema),
  timeline: z.array(z.object({
    date: z.string(),
    commits: z.number(),
    files_changed: z.number(),
  })),
  total_commits: z.number(),
});

const GitHistoryQuery = z.object({
  file_path: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const gitHistoryRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/git-history`,
  tags: ["Graph"],
  summary: "Get git file history for visualization overlays (freshness, hotspots, authors)",
  request: {
    params: RepoIdParams,
    query: GitHistoryQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHistoryResultSchema,
        },
      },
      description: "Git history data with per-file stats, authors, and timeline",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found",
    },
  },
});

const GitTimelineResultSchema = z.object({
  commits: z.array(z.object({
    sha: z.string(),
    author_name: z.string(),
    author_email: z.string(),
    date: z.string(),
    message: z.string(),
    files: z.array(z.object({
      path: z.string(),
      change: z.string(),
    })),
  })),
  total_files: z.number(),
});

const GitTimelineQuery = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const gitTimelineRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/git-timeline`,
  tags: ["Graph"],
  summary: "Get chronological commit timeline for Gource-style visualization",
  request: {
    params: RepoIdParams,
    query: GitTimelineQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitTimelineResultSchema,
        },
      },
      description: "Chronological commit timeline with per-commit file changes",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found",
    },
  },
});

// ---- Rename Route ----

const RenameRequestSchema = z.object({
  symbol: z.string().min(1).max(500),
  new_name: z.string().min(1).max(500),
  file_path: z.string().optional(),
  label: z.string().optional(),
  dry_run: z.boolean().default(true),
  min_confidence: z.number().min(0).max(1).default(0.8),
});

const RenameEditSchema = z.object({
  file_path: z.string(),
  line: z.number(),
  column_start: z.number(),
  column_end: z.number(),
  old_text: z.string(),
  new_text: z.string(),
  confidence: z.number(),
  reason: z.string(),
});

const RenameResultSchema = z.object({
  symbol: z.string(),
  edits: z.array(RenameEditSchema),
  affected_files: z.array(z.string()),
  total_edits: z.number(),
  applied: z.boolean(),
  warnings: z.array(z.string()),
});

const renameRoute = createRoute({
  method: "post",
  path: `${config.API_PREFIX}/repositories/{repoId}/graph/rename`,
  tags: ["Graph"],
  summary: "Graph-aware multi-file symbol rename with confidence scoring",
  request: {
    params: RepoIdParams,
    body: {
      content: {
        "application/json": {
          schema: RenameRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RenameResultSchema,
        },
      },
      description: "Rename result with edits and affected files",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid request",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Repository not found or has no graph",
    },
  },
});

// ---- Helpers ----

async function verifyRepoAccess(
  repoId: string,
  projectId: string,
): Promise<RepositoryRow | null> {
  const result = await pool.query<RepositoryRow>(
    `SELECT id, project_id, graph_name
     FROM repositories WHERE id = $1`,
    [repoId],
  );

  if (result.rows.length === 0) return null;
  if (result.rows[0].project_id !== projectId) return null;

  return result.rows[0];
}

function verifyGraphRepoResult(
  repo: RepositoryRow | null,
): repo is RepositoryRow & { graph_name: string } {
  return repo !== null && repo.graph_name !== null;
}

// ---- Router & Middleware ----

const graphRoutes = new OpenAPIHono<AppEnv>();

graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/stats`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/orphans`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/routes`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/cypher`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/nodes`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/nodes/:nodeId`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/edges`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/impact`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/dependencies`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/path`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/architecture`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/communities`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/communities/:communityId`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/processes`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/processes/:processId`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/diff-impact`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/git-history`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/git-timeline`,
  authMiddleware(),
);
graphRoutes.use(
  `${config.API_PREFIX}/repositories/:repoId/graph/rename`,
  authMiddleware(),
);

// ---- Handlers ----

// POST /api/v1/repositories/:repoId/graph/cypher — Execute Cypher query
graphRoutes.openapi(executeCypherRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!repo.graph_name) {
    return c.json({ error: "Repository has no graph — index it first" }, 404);
  }

  const body = c.req.valid("json");
  const columns = body.columns ?? [{ name: "result" }];

  try {
    const rows = await cypher(
      repo.graph_name,
      body.query,
      body.params,
      columns,
    );

    return c.json(
      {
        rows,
        columns: columns.map((col) => col.name),
        row_count: rows.length,
      },
      200,
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error executing query";

    logger.warn({ repoId, query: body.query, err }, "Cypher query failed");

    return c.json({ error: message }, 400);
  }
});

// GET /api/v1/repositories/:repoId/graph/nodes — List and filter nodes
graphRoutes.openapi(listNodesRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { label, name, file_path, exported, limit, offset } = c.req.valid("query");

  // Validate label if provided — must be safe identifier for Cypher interpolation
  if (label && !SAFE_IDENTIFIER.test(label)) {
    return c.json({ error: "Invalid label: must be a valid identifier" }, 400);
  }

  const labelPattern = label ? `:${label}` : "";
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (file_path !== undefined) {
    conditions.push("n.file_path = $file_path");
    params.file_path = file_path;
  }
  if (exported !== undefined) {
    conditions.push("n.exported = $exported");
    params.exported = exported === "true";
  }
  if (name !== undefined) {
    conditions.push("n.name CONTAINS $name");
    params.name = name;
  }

  const whereClause =
    conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const cypherQuery = `MATCH (n${labelPattern})${whereClause} RETURN n ORDER BY id(n) SKIP ${offset} LIMIT ${limit}`;

  try {
    const rows = await cypher<{ n: AgeVertex }>(
      repo.graph_name,
      cypherQuery,
      Object.keys(params).length > 0 ? params : undefined,
      [{ name: "n" }],
    );

    const nodes = rows.map((r) => r.n);
    return c.json({ nodes, count: nodes.length }, 200);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error querying nodes";
    logger.warn({ repoId, err }, "Node listing query failed");
    return c.json({ error: message }, 400);
  }
});

// GET /api/v1/repositories/:repoId/graph/nodes/:nodeId — Node + relationships
graphRoutes.openapi(getNodeRoute, async (c) => {
  const { repoId, nodeId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  // Validate nodeId is a numeric string (AGE graph IDs are bigints)
  if (!/^\d+$/.test(nodeId)) {
    return c.json({ error: "Invalid node ID: must be a numeric value" }, 400);
  }

  try {
    // Fetch the node itself
    const nodeRows = await cypher<{ n: AgeVertex }>(
      repo.graph_name,
      `MATCH (n) WHERE id(n) = ${nodeId} RETURN n`,
      undefined,
      [{ name: "n" }],
    );

    if (nodeRows.length === 0) {
      return c.json({ error: "Node not found" }, 404);
    }

    const node = nodeRows[0].n;

    // Fetch outgoing relationships
    const outRows = await cypher<{ e: AgeEdge; m: AgeVertex }>(
      repo.graph_name,
      `MATCH (n)-[e]->(m) WHERE id(n) = ${nodeId} RETURN e, m`,
      undefined,
      [{ name: "e" }, { name: "m" }],
    );

    // Fetch incoming relationships
    const inRows = await cypher<{ m: AgeVertex; e: AgeEdge }>(
      repo.graph_name,
      `MATCH (m)-[e]->(n) WHERE id(n) = ${nodeId} RETURN m, e`,
      undefined,
      [{ name: "m" }, { name: "e" }],
    );

    const outgoing = outRows.map((r) => ({
      edge: r.e,
      source: node,
      target: r.m,
    }));

    const incoming = inRows.map((r) => ({
      edge: r.e,
      source: r.m,
      target: node,
    }));

    return c.json({ node, relationships: { outgoing, incoming } }, 200);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error fetching node";
    logger.warn({ repoId, nodeId, err }, "Node detail query failed");
    return c.json({ error: message }, 400);
  }
});

// GET /api/v1/repositories/:repoId/graph/edges — List and filter edges
graphRoutes.openapi(listEdgesRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { type, source_label, limit } = c.req.valid("query");

  // Validate identifiers for Cypher interpolation
  if (type && !SAFE_IDENTIFIER.test(type)) {
    return c.json({ error: "Invalid edge type: must be a valid identifier" }, 400);
  }
  if (source_label && !SAFE_IDENTIFIER.test(source_label)) {
    return c.json({ error: "Invalid source_label: must be a valid identifier" }, 400);
  }

  const sourcePattern = source_label ? `:${source_label}` : "";
  const edgePattern = type ? `:${type}` : "";
  const cypherQuery = `MATCH (a${sourcePattern})-[e${edgePattern}]->(b) RETURN a, e, b LIMIT ${limit}`;

  try {
    const rows = await cypher<{ a: AgeVertex; e: AgeEdge; b: AgeVertex }>(
      repo.graph_name,
      cypherQuery,
      undefined,
      [{ name: "a" }, { name: "e" }, { name: "b" }],
    );

    const edges = rows.map((r) => ({
      edge: r.e,
      source: r.a,
      target: r.b,
    }));

    return c.json({ edges, count: edges.length }, 200);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error querying edges";
    logger.warn({ repoId, err }, "Edge listing query failed");
    return c.json({ error: message }, 400);
  }
});

// POST /api/v1/repositories/:repoId/graph/impact — Impact analysis
graphRoutes.openapi(impactAnalysisRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { symbol, direction, depth, file_path, include_cross_repo } = c.req.valid("json");

  // Find the root symbol node
  const fileFilter = file_path ? " AND n.file_path = $file_path" : "";
  const findParams: Record<string, unknown> = { symbol };
  if (file_path) findParams.file_path = file_path;

  let rootRows: Array<{ n: AgeVertex }>;
  try {
    rootRows = await cypher<{ n: AgeVertex }>(
      repo.graph_name,
      `MATCH (n) WHERE n.name = $symbol${fileFilter} RETURN n LIMIT 1`,
      findParams,
      [{ name: "n" }],
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error finding symbol";
    logger.warn({ repoId, symbol, err }, "Impact analysis: symbol lookup failed");
    return c.json({ error: message }, 400);
  }

  if (rootRows.length === 0) {
    return c.json({ error: `Symbol '${symbol}' not found in graph` }, 404);
  }

  const rootNode = rootRows[0].n;
  const rootId = rootNode.id;

  // Traverse CALLS, EXTENDS, and IMPLEMENTS edges to find the blast radius
  const EDGE_TYPES = ["CALLS", "EXTENDS", "IMPLEMENTS"] as const;

  interface AffectedEntry {
    id: number | string;
    label: string;
    name?: string;
    file_path?: string;
    repo?: string;
    is_cross_repo?: boolean;
    relationship_type: string;
    properties: Record<string, unknown>;
  }

  const affected: AffectedEntry[] = [];
  const seen = new Set<string>();
  seen.add(String(rootId));

  for (const edgeType of EDGE_TYPES) {
    const queries: string[] = [];

    if (direction === "callers" || direction === "both") {
      // Backward: nodes that reach root via this edge type
      queries.push(
        `MATCH (n)-[:${edgeType}*1..${depth}]->(target) WHERE id(target) = ${rootId} RETURN DISTINCT n`,
      );
    }
    if (direction === "callees" || direction === "both") {
      // Forward: nodes reachable from root via this edge type
      queries.push(
        `MATCH (source)-[:${edgeType}*1..${depth}]->(n) WHERE id(source) = ${rootId} RETURN DISTINCT n`,
      );
    }

    for (const q of queries) {
      try {
        const rows = await cypher<{ n: AgeVertex }>(
          repo.graph_name,
          q,
          undefined,
          [{ name: "n" }],
        );

        for (const row of rows) {
          const nodeId = String(row.n.id);
          if (!seen.has(nodeId)) {
            seen.add(nodeId);
            const props = row.n.properties;
            affected.push({
              id: row.n.id,
              label: row.n.label,
              name: typeof props.name === "string" ? props.name : undefined,
              file_path:
                typeof props.file_path === "string"
                  ? props.file_path
                  : typeof props.path === "string"
                    ? props.path
                    : undefined,
              relationship_type: edgeType,
              properties: props,
            });
          }
        }
      } catch (err: unknown) {
        // Some edge types may not exist in the graph — log and continue
        logger.debug(
          { edgeType, err },
          "Impact traversal query failed for edge type",
        );
      }
    }
  }

  // Cross-repo impact traversal (BFS across repos via cross_repo_edges table)
  let crossRepoCount = 0;
  if (include_cross_repo) {
    try {
      // Get all repos in this project
      const allReposResult = await pool.query<{ id: string; name: string; graph_name: string | null }>(
        "SELECT id, name, graph_name FROM repositories WHERE project_id = $1",
        [projectId],
      );
      const repoMap = new Map(allReposResult.rows.map(r => [r.id, r]));

      const rootName = typeof rootNode.properties.name === "string" ? rootNode.properties.name : symbol;
      const crossVisited = new Set<string>([`${repoId}::${rootName}`]);
      let frontier: Array<{ fRepoId: string; symbolName: string }> = [
        { fRepoId: repoId, symbolName: rootName },
      ];

      for (let d = 0; d < depth && frontier.length > 0; d++) {
        const nextFrontier: Array<{ fRepoId: string; symbolName: string }> = [];

        for (const { fRepoId, symbolName: fSymbol } of frontier) {
          // Find cross-repo edges matching this symbol
          const namePattern = `%:${fSymbol}:%`;
          const crossDir = direction === "callers" ? "backward" : direction === "callees" ? "forward" : "both";
          let crossCondition: string;
          const crossParams: unknown[] = [projectId, fRepoId, fSymbol, namePattern];

          if (crossDir === "forward") {
            crossCondition = "source_repo_id = $2 AND (source_node = $3 OR source_node LIKE $4)";
          } else if (crossDir === "backward") {
            crossCondition = "target_repo_id = $2 AND (target_node = $3 OR target_node LIKE $4)";
          } else {
            crossCondition = "((source_repo_id = $2 AND (source_node = $3 OR source_node LIKE $4)) OR (target_repo_id = $2 AND (target_node = $3 OR target_node LIKE $4)))";
          }

          const crossEdges = await pool.query<{
            source_repo_id: string; target_repo_id: string;
            source_node: string; target_node: string; edge_type: string;
          }>(
            `SELECT source_repo_id, target_repo_id, source_node, target_node, edge_type
             FROM cross_repo_edges WHERE project_id = $1 AND ${crossCondition}`,
            crossParams,
          );

          for (const edge of crossEdges.rows) {
            const isSource = edge.source_repo_id === fRepoId;
            const otherRepoId = isSource ? edge.target_repo_id : edge.source_repo_id;
            const otherNodeRef = isSource ? edge.target_node : edge.source_node;
            // Extract name from "Label:Name:FilePath" format
            const parts = otherNodeRef.split(":");
            const otherSymbolName = parts.length >= 2 ? parts[1] : otherNodeRef;
            const key = `${otherRepoId}::${otherNodeRef}`;

            if (crossVisited.has(key)) continue;
            crossVisited.add(key);

            const otherRepo = repoMap.get(otherRepoId);
            if (!otherRepo?.graph_name) continue;

            // Look up the symbol in the other repo's graph
            let otherVertex: AgeVertex | null = null;
            try {
              const otherRows = await cypher<{ n: AgeVertex }>(
                otherRepo.graph_name,
                "MATCH (n) WHERE n.name = $symbol RETURN n LIMIT 1",
                { symbol: otherSymbolName },
                [{ name: "n" }],
              );
              otherVertex = otherRows.length > 0 ? otherRows[0].n : null;
            } catch {
              // Graph may not exist
            }

            const otherProps = otherVertex?.properties ?? {};
            affected.push({
              id: otherVertex?.id ?? otherNodeRef,
              label: otherVertex?.label ?? (parts[0] || "Unknown"),
              name: otherSymbolName,
              file_path:
                typeof otherProps.file_path === "string"
                  ? otherProps.file_path
                  : typeof otherProps.path === "string"
                    ? otherProps.path
                    : parts.length >= 3 ? parts.slice(2).join(":") : undefined,
              repo: otherRepo.name,
              is_cross_repo: true,
              relationship_type: edge.edge_type,
              properties: otherProps,
            });
            crossRepoCount++;

            nextFrontier.push({ fRepoId: otherRepoId, symbolName: otherSymbolName });
          }
        }

        frontier = nextFrontier;
      }
    } catch (err: unknown) {
      logger.debug({ err }, "Cross-repo impact traversal failed");
    }
  }

  // Build summary
  const byRelType: Record<string, number> = {};
  for (const sym of affected) {
    byRelType[sym.relationship_type] = (byRelType[sym.relationship_type] ?? 0) + 1;
  }

  return c.json(
    {
      root: rootNode,
      affected,
      summary: {
        total_affected: affected.length,
        cross_repo_affected: crossRepoCount,
        by_relationship_type: byRelType,
      },
    },
    200,
  );
});

// POST /api/v1/repositories/:repoId/graph/dependencies — Dependency tree
graphRoutes.openapi(dependencyTreeRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { file_path, symbol, depth } = c.req.valid("json");

  if (!file_path && !symbol) {
    return c.json({ error: "Must provide either file_path or symbol" }, 400);
  }

  try {
    if (file_path && !symbol) {
      // File-level dependency tree: IMPORTS edges between File nodes
      const fileRows = await cypher<{ n: AgeVertex }>(
        repo.graph_name,
        `MATCH (n:File) WHERE n.path = $file_path RETURN n LIMIT 1`,
        { file_path },
        [{ name: "n" }],
      );

      if (fileRows.length === 0) {
        return c.json({ error: `File '${file_path}' not found in graph` }, 404);
      }

      const rootNode = fileRows[0].n;
      const rootId = rootNode.id;

      // Files this file imports (outgoing IMPORTS edges)
      const importRows = await cypher<{ m: AgeVertex }>(
        repo.graph_name,
        `MATCH (f)-[:IMPORTS*1..${depth}]->(m) WHERE id(f) = ${rootId} RETURN DISTINCT m`,
        undefined,
        [{ name: "m" }],
      );

      // Files that import this file (incoming IMPORTS edges)
      const importedByRows = await cypher<{ m: AgeVertex }>(
        repo.graph_name,
        `MATCH (m)-[:IMPORTS*1..${depth}]->(f) WHERE id(f) = ${rootId} RETURN DISTINCT m`,
        undefined,
        [{ name: "m" }],
      );

      const toDependencyNode = (v: AgeVertex) => ({
        id: v.id,
        label: v.label,
        name: typeof v.properties.name === "string" ? v.properties.name : undefined,
        file_path: typeof v.properties.path === "string" ? v.properties.path : undefined,
        properties: v.properties,
      });

      return c.json(
        {
          type: "file" as const,
          root: rootNode,
          imports: importRows.map((r) => toDependencyNode(r.m)),
          imported_by: importedByRows.map((r) => toDependencyNode(r.m)),
        },
        200,
      );
    }

    // Symbol-level dependency tree: CALLS edges between symbol nodes
    const findParams: Record<string, unknown> = { symbol };
    const fileFilter = file_path ? " AND n.file_path = $file_path" : "";
    if (file_path) findParams.file_path = file_path;

    const symbolRows = await cypher<{ n: AgeVertex }>(
      repo.graph_name,
      `MATCH (n) WHERE n.name = $symbol${fileFilter} RETURN n LIMIT 1`,
      findParams,
      [{ name: "n" }],
    );

    if (symbolRows.length === 0) {
      return c.json({ error: `Symbol '${symbol}' not found in graph` }, 404);
    }

    const rootNode = symbolRows[0].n;
    const rootId = rootNode.id;

    // Symbols this symbol calls (outgoing CALLS edges)
    const callsRows = await cypher<{ m: AgeVertex }>(
      repo.graph_name,
      `MATCH (s)-[:CALLS*1..${depth}]->(m) WHERE id(s) = ${rootId} RETURN DISTINCT m`,
      undefined,
      [{ name: "m" }],
    );

    // Symbols that call this symbol (incoming CALLS edges)
    const calledByRows = await cypher<{ m: AgeVertex }>(
      repo.graph_name,
      `MATCH (m)-[:CALLS*1..${depth}]->(s) WHERE id(s) = ${rootId} RETURN DISTINCT m`,
      undefined,
      [{ name: "m" }],
    );

    const toDependencyNode = (v: AgeVertex) => ({
      id: v.id,
      label: v.label,
      name: typeof v.properties.name === "string" ? v.properties.name : undefined,
      file_path:
        typeof v.properties.file_path === "string"
          ? v.properties.file_path
          : typeof v.properties.path === "string"
            ? v.properties.path
            : undefined,
      properties: v.properties,
    });

    return c.json(
      {
        type: "symbol" as const,
        root: rootNode,
        calls: callsRows.map((r) => toDependencyNode(r.m)),
        called_by: calledByRows.map((r) => toDependencyNode(r.m)),
      },
      200,
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error querying dependencies";
    logger.warn({ repoId, file_path, symbol, err }, "Dependency tree query failed");
    return c.json({ error: message }, 400);
  }
});

// POST /api/v1/repositories/:repoId/graph/path — Shortest path between two symbols
graphRoutes.openapi(pathFindingRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { from, to, max_depth, from_file_path, to_file_path } = c.req.valid("json");

  // Resolve the "from" node
  const fromFileFilter = from_file_path ? " AND n.file_path = $from_file_path" : "";
  const fromParams: Record<string, unknown> = { from_name: from };
  if (from_file_path) fromParams.from_file_path = from_file_path;

  let fromRows: Array<{ n: AgeVertex }>;
  try {
    fromRows = await cypher<{ n: AgeVertex }>(
      repo.graph_name,
      `MATCH (n) WHERE n.name = $from_name${fromFileFilter} RETURN n LIMIT 1`,
      fromParams,
      [{ name: "n" }],
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error finding 'from' symbol";
    logger.warn({ repoId, from, err }, "Path finding: from symbol lookup failed");
    return c.json({ error: message }, 400);
  }

  if (fromRows.length === 0) {
    return c.json({ error: `Symbol '${from}' not found in graph` }, 404);
  }

  // Resolve the "to" node
  const toFileFilter = to_file_path ? " AND n.file_path = $to_file_path" : "";
  const toParams: Record<string, unknown> = { to_name: to };
  if (to_file_path) toParams.to_file_path = to_file_path;

  let toRows: Array<{ n: AgeVertex }>;
  try {
    toRows = await cypher<{ n: AgeVertex }>(
      repo.graph_name,
      `MATCH (n) WHERE n.name = $to_name${toFileFilter} RETURN n LIMIT 1`,
      toParams,
      [{ name: "n" }],
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error finding 'to' symbol";
    logger.warn({ repoId, to, err }, "Path finding: to symbol lookup failed");
    return c.json({ error: message }, 400);
  }

  if (toRows.length === 0) {
    return c.json({ error: `Symbol '${to}' not found in graph` }, 404);
  }

  const fromId = fromRows[0].n.id;
  const toId = toRows[0].n.id;

  if (fromId === toId) {
    const node = fromRows[0].n;
    return c.json({ nodes: [node], edges: [], length: 0 }, 200);
  }

  // Iterative deepening: try increasing path lengths to find the shortest path
  for (let d = 1; d <= max_depth; d++) {
    try {
      const rows = await cypher<{ p: AgePath }>(
        repo.graph_name,
        `MATCH p = (a)-[*${d}..${d}]-(b) WHERE id(a) = ${fromId} AND id(b) = ${toId} RETURN p LIMIT 1`,
        undefined,
        [{ name: "p" }],
      );

      if (rows.length > 0) {
        const pathElements = rows[0].p;

        // AgePath alternates: [vertex, edge, vertex, edge, vertex, ...]
        const nodes: AgeVertex[] = [];
        const edges: AgeEdge[] = [];
        for (const el of pathElements) {
          if ("start_id" in el && "end_id" in el) {
            edges.push(el as AgeEdge);
          } else {
            nodes.push(el as AgeVertex);
          }
        }

        return c.json({ nodes, edges, length: edges.length }, 200);
      }
    } catch (err: unknown) {
      // Some depths may fail (e.g., no edges exist) — continue trying
      logger.debug({ depth: d, err }, "Path query failed at depth, continuing");
    }
  }

  return c.json(
    { error: `No path found between '${from}' and '${to}' within depth ${max_depth}` },
    404,
  );
});

// GET /api/v1/repositories/:repoId/graph/stats — Node/edge counts by type
graphRoutes.openapi(graphStatsRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");
  const { extended } = c.req.valid("query");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const NODE_LABELS = [
    "File", "Folder", "Function", "Class", "Interface",
    "Method", "CodeElement", "RouteHandler",
    "Struct", "Enum", "Trait", "TypeAlias", "Namespace",
    "Community", "Process",
  ] as const;
  const EDGE_LABELS = [
    "DEFINES", "CONTAINS", "EXPOSES", "CALLS",
    "IMPORTS", "EXTENDS", "IMPLEMENTS",
    "OVERRIDES", "HANDLES", "MEMBER_OF", "STEP_IN_PROCESS",
  ] as const;

  try {
    const nodes: Record<string, number> = {};
    let totalNodes = 0;

    for (const label of NODE_LABELS) {
      const rows = await cypher<{ cnt: number }>(
        repo.graph_name,
        `MATCH (n:${label}) RETURN count(n)`,
        undefined,
        [{ name: "cnt" }],
      );
      const count = rows[0]?.cnt ?? 0;
      if (count > 0) {
        nodes[label] = count;
        totalNodes += count;
      }
    }

    const edges: Record<string, number> = {};
    let totalEdges = 0;

    for (const label of EDGE_LABELS) {
      const rows = await cypher<{ cnt: number }>(
        repo.graph_name,
        `MATCH ()-[e:${label}]->() RETURN count(e)`,
        undefined,
        [{ name: "cnt" }],
      );
      const count = rows[0]?.cnt ?? 0;
      if (count > 0) {
        edges[label] = count;
        totalEdges += count;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {
      nodes,
      edges,
      total_nodes: totalNodes,
      total_edges: totalEdges,
    };

    // Extended stats: indexing status, language breakdown, file counts
    if (extended === "true") {
      const jobsResult = await pool.query<{
        status: string;
        started_at: string | null;
        completed_at: string | null;
        error_message: string | null;
        phase: string | null;
        progress: number;
        mode: string;
        last_completed_phase: string | null;
      }>(
        `SELECT status, started_at, completed_at, error_message, phase, progress, mode, last_completed_phase
         FROM indexing_jobs
         WHERE repository_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [repoId],
      );

      const langResult = await pool.query<{
        language: string;
        count: string;
      }>(
        `SELECT COALESCE(language, 'unknown') AS language, COUNT(*)::text AS count
         FROM indexed_files
         WHERE repository_id = $1
         GROUP BY language
         ORDER BY count DESC`,
        [repoId],
      );

      const totalFilesResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM indexed_files WHERE repository_id = $1`,
        [repoId],
      );

      result.indexing = jobsResult.rows.length > 0
        ? jobsResult.rows[0]
        : null;

      result.languages = Object.fromEntries(
        langResult.rows.map((r) => [r.language, parseInt(r.count, 10)]),
      );

      result.total_files = parseInt(totalFilesResult.rows[0]?.count ?? "0", 10);
    }

    return c.json(result, 200);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error querying stats";
    logger.warn({ repoId, err }, "Graph stats query failed");
    return c.json({ error: message }, 404);
  }
});

// GET /api/v1/repositories/:repoId/graph/orphans — Unreferenced symbols
graphRoutes.openapi(graphOrphansRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { label, limit, offset } = c.req.valid("query");

  // Validate label if provided
  if (label && !SAFE_IDENTIFIER.test(label)) {
    return c.json({ error: "Invalid label: must be a valid identifier" }, 400);
  }

  // Only consider symbol node types (not File/Folder/RouteHandler)
  const SYMBOL_LABELS = ["Function", "Class", "Interface", "Method", "CodeElement"];
  const labels = label ? [label] : SYMBOL_LABELS;

  try {
    const allOrphans: Array<{
      id: number | string;
      label: string;
      name?: string;
      file_path?: string;
      properties: Record<string, unknown>;
    }> = [];

    for (const lbl of labels) {
      if (!SAFE_IDENTIFIER.test(lbl)) continue;

      // Find nodes with no incoming edges at all
      const rows = await cypher<{ n: AgeVertex }>(
        repo.graph_name,
        `MATCH (n:${lbl}) WHERE NOT EXISTS ((n)<-[]-()) RETURN n ORDER BY id(n) SKIP ${offset} LIMIT ${limit}`,
        undefined,
        [{ name: "n" }],
      );

      for (const row of rows) {
        const props = row.n.properties;
        allOrphans.push({
          id: row.n.id,
          label: row.n.label,
          name: typeof props.name === "string" ? props.name : undefined,
          file_path:
            typeof props.file_path === "string"
              ? props.file_path
              : typeof props.path === "string"
                ? props.path
                : undefined,
          properties: props,
        });
      }
    }

    return c.json({ orphans: allOrphans, count: allOrphans.length }, 200);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error querying orphans";
    logger.warn({ repoId, err }, "Graph orphans query failed");
    return c.json({ error: message }, 400);
  }
});

// GET /api/v1/repositories/:repoId/graph/routes — All HTTP route handlers
graphRoutes.openapi(graphRoutesRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  try {
    // Match RouteHandler nodes and their source File via EXPOSES edge
    const rows = await cypher<{ r: AgeVertex; f: AgeVertex }>(
      repo.graph_name,
      `MATCH (f:File)-[:EXPOSES]->(r:RouteHandler) RETURN r, f ORDER BY r.http_method, r.url_pattern`,
      undefined,
      [{ name: "r" }, { name: "f" }],
    );

    const routes = rows.map((row) => {
      const rp = row.r.properties;
      const fp = row.f.properties;
      return {
        http_method: typeof rp.http_method === "string" ? rp.http_method : "UNKNOWN",
        url_pattern: typeof rp.url_pattern === "string" ? rp.url_pattern : "",
        framework: typeof rp.framework === "string" ? rp.framework : undefined,
        handler_name: typeof rp.handler_name === "string" && rp.handler_name !== ""
          ? rp.handler_name
          : undefined,
        file_path: typeof fp.path === "string" ? fp.path : undefined,
        start_line: typeof rp.start_line === "number" ? rp.start_line : undefined,
      };
    });

    return c.json({ routes, count: routes.length }, 200);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error querying routes";
    logger.warn({ repoId, err }, "Graph routes query failed");
    return c.json({ error: message }, 404);
  }
});

// POST /api/v1/repositories/:repoId/graph/architecture — Layer violation detection
graphRoutes.openapi(architectureCheckRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const body = c.req.valid("json");
  let { layers, rules } = body;
  const { save, edge_types } = body;

  // Fall back to project settings if not provided in request
  if (!layers || !rules) {
    const settingsResult = await pool.query<{ settings: Record<string, unknown> | null }>(
      "SELECT settings FROM projects WHERE id = $1",
      [projectId],
    );
    const settings = settingsResult.rows[0]?.settings ?? {};
    const archConfig = settings.architecture_layers as
      | { layers?: Record<string, string>; rules?: Array<{ from: string; deny: string[] }> }
      | undefined;

    if (!layers && archConfig?.layers) layers = archConfig.layers;
    if (!rules && archConfig?.rules) rules = archConfig.rules;
  }

  if (!layers || Object.keys(layers).length === 0) {
    return c.json({ error: "No layer definitions provided (in request or project settings)" }, 400);
  }
  if (!rules || rules.length === 0) {
    return c.json({ error: "No rules provided (in request or project settings)" }, 400);
  }

  // Validate all layer names referenced in rules exist in layers
  const layerNames = new Set(Object.keys(layers));
  for (const rule of rules) {
    if (!layerNames.has(rule.from)) {
      return c.json({ error: `Rule references unknown layer: '${rule.from}'` }, 400);
    }
    for (const denied of rule.deny) {
      if (!layerNames.has(denied)) {
        return c.json({ error: `Rule references unknown layer: '${denied}'` }, 400);
      }
    }
  }

  // Optionally persist to project settings
  if (save) {
    await pool.query(
      `UPDATE projects SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb), '{architecture_layers}', $1::jsonb
      ) WHERE id = $2`,
      [JSON.stringify({ layers, rules }), projectId],
    );
  }

  // Build glob matchers
  const layerMatchers = Object.entries(layers).map(([name, pattern]) => ({
    name,
    isMatch: picomatch(pattern),
  }));

  // Query all File nodes from the graph
  let files: Array<{ id: number; path: string }>;
  try {
    const fileRows = await cypher<{ f: AgeVertex }>(
      repo.graph_name,
      "MATCH (f:File) RETURN f",
      undefined,
      [{ name: "f" }],
    );
    files = fileRows.map((r) => ({
      id: r.f.id as number,
      path: (r.f.properties.path as string) ?? "",
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to query files";
    logger.warn({ repoId, err }, "Architecture check: file query failed");
    return c.json({ error: message }, 400);
  }

  // Classify files into layers
  const filePathToLayer = new Map<string, string>();
  const filesClassified: Record<string, number> = {};

  for (const file of files) {
    for (const matcher of layerMatchers) {
      if (matcher.isMatch(file.path)) {
        filePathToLayer.set(file.path, matcher.name);
        filesClassified[matcher.name] = (filesClassified[matcher.name] ?? 0) + 1;
        break; // first matching layer wins
      }
    }
  }

  // Build deny lookup
  const denyMap = new Map<string, Set<string>>();
  for (const rule of rules) {
    denyMap.set(rule.from, new Set(rule.deny));
  }

  // Query cross-file edges and check violations
  interface CrossFileEdge {
    f1_path: string;
    s1_name: string;
    s1_line: unknown;
    f2_path: string;
    s2_name: string;
  }

  const crossEdges: Array<CrossFileEdge & { edge_type: string }> = [];

  if (edge_types.includes("CALLS")) {
    try {
      const rows = await cypher<{
        f1_path: unknown; s1_name: unknown; s1_line: unknown;
        f2_path: unknown; s2_name: unknown;
      }>(
        repo.graph_name,
        `MATCH (f1:File)-[:DEFINES]->(s1)-[:CALLS]->(s2)<-[:DEFINES]-(f2:File)
         WHERE id(f1) <> id(f2)
         RETURN f1.path AS f1_path, s1.name AS s1_name, s1.start_line AS s1_line,
                f2.path AS f2_path, s2.name AS s2_name`,
        undefined,
        [{ name: "f1_path" }, { name: "s1_name" }, { name: "s1_line" }, { name: "f2_path" }, { name: "s2_name" }],
      );
      for (const r of rows) {
        crossEdges.push({
          f1_path: String(r.f1_path ?? ""),
          s1_name: String(r.s1_name ?? ""),
          s1_line: r.s1_line,
          f2_path: String(r.f2_path ?? ""),
          s2_name: String(r.s2_name ?? ""),
          edge_type: "CALLS",
        });
      }
    } catch (err: unknown) {
      logger.debug({ err }, "Architecture check: CALLS edge query failed");
    }
  }

  if (edge_types.includes("IMPORTS")) {
    try {
      const rows = await cypher<{ f1_path: unknown; f2_path: unknown }>(
        repo.graph_name,
        `MATCH (f1:File)-[:IMPORTS]->(f2:File)
         WHERE id(f1) <> id(f2)
         RETURN f1.path AS f1_path, f2.path AS f2_path`,
        undefined,
        [{ name: "f1_path" }, { name: "f2_path" }],
      );
      for (const r of rows) {
        crossEdges.push({
          f1_path: String(r.f1_path ?? ""),
          s1_name: String(r.f1_path ?? ""),
          s1_line: null,
          f2_path: String(r.f2_path ?? ""),
          s2_name: String(r.f2_path ?? ""),
          edge_type: "IMPORTS",
        });
      }
    } catch (err: unknown) {
      logger.debug({ err }, "Architecture check: IMPORTS edge query failed");
    }
  }

  // Check each edge against deny rules
  interface Violation {
    rule: string;
    source_file: string;
    source_symbol: string;
    target_file: string;
    target_symbol: string;
    edge_type: string;
    line: number | null;
  }

  const violations: Violation[] = [];

  for (const edge of crossEdges) {
    const sourceLayer = filePathToLayer.get(edge.f1_path);
    const targetLayer = filePathToLayer.get(edge.f2_path);
    if (!sourceLayer || !targetLayer) continue;

    const denied = denyMap.get(sourceLayer);
    if (denied && denied.has(targetLayer)) {
      violations.push({
        rule: `${sourceLayer} → ${targetLayer} (denied)`,
        source_file: edge.f1_path,
        source_symbol: edge.s1_name,
        target_file: edge.f2_path,
        target_symbol: edge.s2_name,
        edge_type: edge.edge_type,
        line: typeof edge.s1_line === "number" ? edge.s1_line : null,
      });
    }
  }

  return c.json(
    {
      violations,
      summary: {
        total_violations: violations.length,
        rules_checked: rules.length,
        layers_found: Object.keys(filesClassified).length,
        files_classified: filesClassified,
      },
    },
    200,
  );
});

// GET /api/v1/repositories/:repoId/graph/communities — List communities
graphRoutes.openapi(communitiesListRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { limit, offset } = c.req.valid("query");

  try {
    // Get total count
    const countRows = await cypher<{ cnt: number }>(
      repo.graph_name,
      "MATCH (c:Community) RETURN count(c)",
      undefined,
      [{ name: "cnt" }],
    );
    const total = countRows[0]?.cnt ?? 0;

    // Fetch communities sorted by symbol_count desc
    const rows = await cypher<{ c: AgeVertex }>(
      repo.graph_name,
      `MATCH (c:Community) RETURN c ORDER BY c.symbol_count DESC SKIP ${offset} LIMIT ${limit}`,
      undefined,
      [{ name: "c" }],
    );

    const communities = rows.map((r) => {
      const p = r.c.properties;
      return {
        community_id: typeof p.community_id === "string" ? p.community_id : "",
        label: typeof p.label === "string" ? p.label : "",
        heuristic_label: typeof p.heuristic_label === "string" ? p.heuristic_label : "",
        cohesion: typeof p.cohesion === "number" ? p.cohesion : 0,
        symbol_count: typeof p.symbol_count === "number" ? p.symbol_count : 0,
        keywords: typeof p.keywords === "string" ? p.keywords : "",
      };
    });

    return c.json({ communities, count: communities.length, total }, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to query communities";
    logger.warn({ repoId, err }, "Communities list query failed");
    return c.json({ error: message }, 404);
  }
});

// GET /api/v1/repositories/:repoId/graph/communities/:communityId — Community with members
graphRoutes.openapi(communityDetailRoute, async (c) => {
  const { repoId, communityId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  try {
    // Fetch the community node
    const communityRows = await cypher<{ c: AgeVertex }>(
      repo.graph_name,
      `MATCH (c:Community {community_id: $cid}) RETURN c LIMIT 1`,
      { cid: communityId },
      [{ name: "c" }],
    );

    if (communityRows.length === 0) {
      return c.json({ error: `Community '${communityId}' not found` }, 404);
    }

    const p = communityRows[0].c.properties;
    const community = {
      community_id: typeof p.community_id === "string" ? p.community_id : "",
      label: typeof p.label === "string" ? p.label : "",
      heuristic_label: typeof p.heuristic_label === "string" ? p.heuristic_label : "",
      cohesion: typeof p.cohesion === "number" ? p.cohesion : 0,
      symbol_count: typeof p.symbol_count === "number" ? p.symbol_count : 0,
      keywords: typeof p.keywords === "string" ? p.keywords : "",
    };

    // Fetch members
    const memberRows = await cypher<{ s: AgeVertex }>(
      repo.graph_name,
      `MATCH (s)-[:MEMBER_OF]->(c:Community {community_id: $cid}) RETURN s`,
      { cid: communityId },
      [{ name: "s" }],
    );

    const members = memberRows.map((r) => ({
      id: r.s.id,
      label: r.s.label,
      name: typeof r.s.properties.name === "string" ? r.s.properties.name : undefined,
      file_path: typeof r.s.properties.file_path === "string" ? r.s.properties.file_path : undefined,
    }));

    return c.json({ community, members }, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to query community";
    logger.warn({ repoId, communityId, err }, "Community detail query failed");
    return c.json({ error: message }, 404);
  }
});

// GET /api/v1/repositories/:repoId/graph/processes — List processes
graphRoutes.openapi(processesListRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const { limit, offset, type } = c.req.valid("query");

  try {
    // Get total count (with optional type filter)
    const countQuery = type
      ? `MATCH (p:Process {process_type: $ptype}) RETURN count(p)`
      : `MATCH (p:Process) RETURN count(p)`;
    const countRows = await cypher<{ cnt: number }>(
      repo.graph_name,
      countQuery,
      type ? { ptype: type } : undefined,
      [{ name: "cnt" }],
    );
    const total = countRows[0]?.cnt ?? 0;

    // Fetch processes sorted by step_count desc
    const listQuery = type
      ? `MATCH (p:Process {process_type: $ptype}) RETURN p ORDER BY p.step_count DESC SKIP ${offset} LIMIT ${limit}`
      : `MATCH (p:Process) RETURN p ORDER BY p.step_count DESC SKIP ${offset} LIMIT ${limit}`;
    const rows = await cypher<{ p: AgeVertex }>(
      repo.graph_name,
      listQuery,
      type ? { ptype: type } : undefined,
      [{ name: "p" }],
    );

    const processes = rows.map((r) => {
      const pr = r.p.properties;
      return {
        process_id: typeof pr.process_id === "string" ? pr.process_id : "",
        label: typeof pr.label === "string" ? pr.label : "",
        heuristic_label: typeof pr.heuristic_label === "string" ? pr.heuristic_label : "",
        process_type: typeof pr.process_type === "string" ? pr.process_type : "",
        step_count: typeof pr.step_count === "number" ? pr.step_count : 0,
        entry_point_name: typeof pr.entry_point_name === "string" ? pr.entry_point_name : "",
        terminal_name: typeof pr.terminal_name === "string" ? pr.terminal_name : "",
      };
    });

    return c.json({ processes, count: processes.length, total }, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to query processes";
    logger.warn({ repoId, err }, "Processes list query failed");
    return c.json({ error: message }, 404);
  }
});

// GET /api/v1/repositories/:repoId/graph/processes/:processId — Process with ordered steps
graphRoutes.openapi(processDetailRoute, async (c) => {
  const { repoId, processId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  try {
    // Fetch the process node
    const processRows = await cypher<{ p: AgeVertex }>(
      repo.graph_name,
      `MATCH (p:Process {process_id: $pid}) RETURN p LIMIT 1`,
      { pid: processId },
      [{ name: "p" }],
    );

    if (processRows.length === 0) {
      return c.json({ error: `Process '${processId}' not found` }, 404);
    }

    const pr = processRows[0].p.properties;
    const process = {
      process_id: typeof pr.process_id === "string" ? pr.process_id : "",
      label: typeof pr.label === "string" ? pr.label : "",
      heuristic_label: typeof pr.heuristic_label === "string" ? pr.heuristic_label : "",
      process_type: typeof pr.process_type === "string" ? pr.process_type : "",
      step_count: typeof pr.step_count === "number" ? pr.step_count : 0,
      entry_point_name: typeof pr.entry_point_name === "string" ? pr.entry_point_name : "",
      terminal_name: typeof pr.terminal_name === "string" ? pr.terminal_name : "",
    };

    // Fetch ordered steps
    const stepRows = await cypher<{ s: AgeVertex; step: number }>(
      repo.graph_name,
      `MATCH (s)-[e:STEP_IN_PROCESS]->(p:Process {process_id: $pid}) RETURN s, e.step AS step ORDER BY e.step`,
      { pid: processId },
      [{ name: "s" }, { name: "step" }],
    );

    const steps = stepRows.map((r) => ({
      step: typeof r.step === "number" ? r.step : Number(r.step),
      id: r.s.id,
      label: r.s.label,
      name: typeof r.s.properties.name === "string" ? r.s.properties.name : undefined,
      file_path: typeof r.s.properties.file_path === "string" ? r.s.properties.file_path : undefined,
    }));

    return c.json({ process, steps }, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to query process";
    logger.warn({ repoId, processId, err }, "Process detail query failed");
    return c.json({ error: message }, 404);
  }
});

// POST /api/v1/repositories/:repoId/graph/diff-impact — Analyze diff impact
graphRoutes.openapi(diffImpactRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const body = c.req.valid("json");

  try {
    const result = await analyzeChanges(repoId, repo.graph_name, {
      scope: body.scope as DiffScope,
      compareRef: body.compare_ref,
      maxDepth: body.max_depth,
    });

    return c.json(result, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to analyze diff impact";
    logger.warn({ repoId, err }, "Diff impact analysis failed");
    return c.json({ error: message }, 404);
  }
});

// GET /api/v1/repositories/:repoId/graph/git-history — Get git file history
graphRoutes.openapi(gitHistoryRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const { file_path, limit } = c.req.valid("query");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  try {
    const result = await getGitHistoryForRepo(repoId, { file_path, limit });
    return c.json(result, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to get git history";
    logger.warn({ repoId, err }, "Git history query failed");
    return c.json({ error: message }, 404);
  }
});

// GET /api/v1/repositories/:repoId/graph/git-timeline — Chronological commit timeline
graphRoutes.openapi(gitTimelineRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const { since, until, limit } = c.req.valid("query");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  try {
    const result = await getGitTimelineForRepo(repoId, { since, until, limit });
    return c.json(result, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to get git timeline";
    logger.warn({ repoId, err }, "Git timeline query failed");
    return c.json({ error: message }, 404);
  }
});

// POST /api/v1/repositories/:repoId/graph/rename — Graph-aware symbol rename
graphRoutes.openapi(renameRoute, async (c) => {
  const { repoId } = c.req.valid("param");
  const projectId = c.get("projectId");

  const repo = await verifyRepoAccess(repoId, projectId);
  if (!verifyGraphRepoResult(repo)) {
    return c.json(
      { error: repo ? "Repository has no graph — index it first" : "Repository not found" },
      404,
    );
  }

  const body = c.req.valid("json");

  try {
    const result = await renameSymbol(repoId, repo.graph_name, {
      symbol: body.symbol,
      new_name: body.new_name,
      file_path: body.file_path,
      label: body.label,
      dry_run: body.dry_run,
      min_confidence: body.min_confidence,
    });
    return c.json(result, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Rename operation failed";
    logger.warn({ repoId, symbol: body.symbol, err }, "Rename failed");
    return c.json({ error: message }, 400);
  }
});

export { graphRoutes };
