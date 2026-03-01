import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pool } from "../db/index.js";
import { cypher } from "../db/age.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("mcp-resources");

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// ---- DB Row Types ----

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  settings: Record<string, unknown>;
  created_at: string;
}

interface RepoRow {
  id: string;
  name: string | null;
  url: string;
  source_type: string;
  default_branch: string;
  graph_name: string | null;
  project_id: string;
  last_indexed_at: string | null;
  created_at: string;
}

interface RepoWithStats extends RepoRow {
  file_count: string;
  latest_job_status: string | null;
}

interface IndexedFileRow {
  file_path: string;
  language: string | null;
}

interface ConnectionRow {
  id: string;
  source_repo_id: string;
  target_repo_id: string;
  connection_type: string;
  match_rules: Record<string, unknown>;
  last_resolved_at: string | null;
  source_repo_name: string | null;
  target_repo_name: string | null;
  edge_count: string;
}

// ---- Helpers ----

async function getProject(projectId: string): Promise<ProjectRow | null> {
  const result = await pool.query<ProjectRow>(
    "SELECT id, name, description, settings, created_at FROM projects WHERE id = $1",
    [projectId],
  );
  return result.rows[0] ?? null;
}

async function resolveRepoByName(
  projectId: string,
  repoName: string,
): Promise<RepoRow | null> {
  const result = await pool.query<RepoRow>(
    `SELECT id, name, url, source_type, default_branch, graph_name, project_id, last_indexed_at, created_at
     FROM repositories WHERE name = $1 AND project_id = $2 LIMIT 1`,
    [repoName, projectId],
  );
  return result.rows[0] ?? null;
}

function buildFileTree(
  files: IndexedFileRow[],
): Array<{ path: string; name: string; type: string; language: string | null; children?: unknown[] }> {
  interface TreeNode {
    path: string;
    name: string;
    type: "file" | "directory";
    language: string | null;
    children?: TreeNode[];
  }

  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  function ensureDir(dirPath: string): TreeNode {
    if (dirPath === "" || dirPath === ".") {
      return { path: "", name: "", type: "directory", language: null, children: root };
    }
    const existing = dirMap.get(dirPath);
    if (existing) return existing;

    const parts = dirPath.split("/");
    const name = parts[parts.length - 1];
    const node: TreeNode = { path: dirPath, name, type: "directory", language: null, children: [] };
    dirMap.set(dirPath, node);

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

// ---- Resource Registration ----

export function registerResources(server: McpServer, projectId: string): void {
  log.info({ projectId }, "Registering MCP resources");

  // 1. nexgraph://project/info — Project name, settings, repo list
  server.registerResource(
    "project-info",
    "nexgraph://project/info",
    {
      description: "Project name, settings, and repository list",
      mimeType: "application/json",
    },
    async () => {
      const project = await getProject(projectId);
      if (!project) {
        return {
          contents: [
            {
              uri: "nexgraph://project/info",
              mimeType: "application/json",
              text: JSON.stringify({ error: "No project found" }),
            },
          ],
        };
      }

      const repos = await pool.query<{ id: string; name: string | null; url: string; source_type: string }>(
        "SELECT id, name, url, source_type FROM repositories WHERE project_id = $1 ORDER BY created_at",
        [project.id],
      );

      const data = {
        id: project.id,
        name: project.name,
        description: project.description,
        settings: project.settings,
        created_at: project.created_at,
        repositories: repos.rows.map((r) => ({
          id: r.id,
          name: r.name,
          url: r.url,
          source_type: r.source_type,
        })),
      };

      return {
        contents: [
          {
            uri: "nexgraph://project/info",
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // 2. nexgraph://repos — All repos with status + stats
  server.registerResource(
    "repos",
    "nexgraph://repos",
    {
      description: "All repositories with indexing status and file counts",
      mimeType: "application/json",
    },
    async () => {
      const result = await pool.query<RepoWithStats>(
        `SELECT r.id, r.name, r.url, r.source_type, r.default_branch,
                r.graph_name, r.project_id, r.last_indexed_at, r.created_at,
                COUNT(f.id)::text AS file_count,
                (SELECT ij.status FROM indexing_jobs ij
                 WHERE ij.repository_id = r.id
                 ORDER BY ij.created_at DESC LIMIT 1) AS latest_job_status
         FROM repositories r
         LEFT JOIN indexed_files f ON f.repository_id = r.id
         WHERE r.project_id = $1
         GROUP BY r.id
         ORDER BY r.created_at`,
        [projectId],
      );

      const repos = result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        source_type: r.source_type,
        default_branch: r.default_branch,
        graph_name: r.graph_name,
        last_indexed_at: r.last_indexed_at,
        file_count: parseInt(r.file_count, 10),
        latest_job_status: r.latest_job_status,
      }));

      return {
        contents: [
          {
            uri: "nexgraph://repos",
            mimeType: "application/json",
            text: JSON.stringify({ repositories: repos }, null, 2),
          },
        ],
      };
    },
  );

  // 3. nexgraph://repos/{repo}/tree — File tree for a repository
  const repoTreeTemplate = new ResourceTemplate(
    "nexgraph://repos/{repo}/tree",
    {
      list: async () => {
        const repos = await pool.query<{ name: string }>(
          "SELECT name FROM repositories WHERE name IS NOT NULL AND project_id = $1 ORDER BY created_at",
          [projectId],
        );
        return {
          resources: repos.rows.map((r) => ({
            uri: `nexgraph://repos/${encodeURIComponent(r.name)}/tree`,
            name: `${r.name} file tree`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        repo: async (value: string) => {
          const repos = await pool.query<{ name: string }>(
            "SELECT name FROM repositories WHERE name IS NOT NULL AND project_id = $1 AND name ILIKE $2 ORDER BY name LIMIT 10",
            [projectId, `${value}%`],
          );
          return repos.rows.map((r) => r.name);
        },
      },
    },
  );

  server.registerResource(
    "repo-tree",
    repoTreeTemplate,
    {
      description: "File tree of a repository",
      mimeType: "application/json",
    },
    async (_uri, variables) => {
      const repoName = String(variables.repo);
      const repo = await resolveRepoByName(projectId, repoName);

      if (!repo) {
        return {
          contents: [
            {
              uri: `nexgraph://repos/${encodeURIComponent(repoName)}/tree`,
              mimeType: "application/json",
              text: JSON.stringify({ error: `Repository '${repoName}' not found` }),
            },
          ],
        };
      }

      const files = await pool.query<IndexedFileRow>(
        "SELECT file_path, language FROM indexed_files WHERE repository_id = $1 ORDER BY file_path",
        [repo.id],
      );

      const tree = buildFileTree(files.rows);
      const resourceUri = `nexgraph://repos/${encodeURIComponent(repoName)}/tree`;

      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: "application/json",
            text: JSON.stringify({ repo: repoName, total_files: files.rows.length, tree }, null, 2),
          },
        ],
      };
    },
  );

  // 4. nexgraph://repos/{repo}/stats — Graph statistics for a repository
  const repoStatsTemplate = new ResourceTemplate(
    "nexgraph://repos/{repo}/stats",
    {
      list: async () => {
        const repos = await pool.query<{ name: string }>(
          "SELECT name FROM repositories WHERE name IS NOT NULL AND graph_name IS NOT NULL AND project_id = $1 ORDER BY created_at",
          [projectId],
        );
        return {
          resources: repos.rows.map((r) => ({
            uri: `nexgraph://repos/${encodeURIComponent(r.name)}/stats`,
            name: `${r.name} graph stats`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        repo: async (value: string) => {
          const repos = await pool.query<{ name: string }>(
            "SELECT name FROM repositories WHERE name IS NOT NULL AND graph_name IS NOT NULL AND project_id = $1 AND name ILIKE $2 ORDER BY name LIMIT 10",
            [projectId, `${value}%`],
          );
          return repos.rows.map((r) => r.name);
        },
      },
    },
  );

  server.registerResource(
    "repo-stats",
    repoStatsTemplate,
    {
      description: "Graph statistics for a repository (node/edge counts by label)",
      mimeType: "application/json",
    },
    async (_uri, variables) => {
      const repoName = String(variables.repo);
      const repo = await resolveRepoByName(projectId, repoName);
      const resourceUri = `nexgraph://repos/${encodeURIComponent(repoName)}/stats`;

      if (!repo || !repo.graph_name) {
        return {
          contents: [
            {
              uri: resourceUri,
              mimeType: "application/json",
              text: JSON.stringify({
                error: !repo
                  ? `Repository '${repoName}' not found`
                  : `Repository '${repoName}' has no graph`,
              }),
            },
          ],
        };
      }

      const graphName = repo.graph_name;
      if (!SAFE_IDENTIFIER.test(graphName)) {
        return {
          contents: [
            {
              uri: resourceUri,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Invalid graph name" }),
            },
          ],
        };
      }

      // Count nodes by label
      let nodeCounts: Array<{ label: string; count: number }> = [];
      try {
        const nodeRows = await cypher<{ label: string; count: unknown }>(
          graphName,
          "MATCH (n) RETURN label(n) AS label, count(n) AS count",
          {},
          [{ name: "label" }, { name: "count" }],
        );
        nodeCounts = nodeRows.map((r) => ({
          label: String(r.label),
          count: Number(r.count),
        }));
      } catch (err) {
        log.warn({ err, graphName }, "Failed to count nodes");
      }

      // Count edges by label
      let edgeCounts: Array<{ label: string; count: number }> = [];
      try {
        const edgeRows = await cypher<{ label: string; count: unknown }>(
          graphName,
          "MATCH ()-[e]->() RETURN label(e) AS label, count(e) AS count",
          {},
          [{ name: "label" }, { name: "count" }],
        );
        edgeCounts = edgeRows.map((r) => ({
          label: String(r.label),
          count: Number(r.count),
        }));
      } catch (err) {
        log.warn({ err, graphName }, "Failed to count edges");
      }

      const totalNodes = nodeCounts.reduce((sum, r) => sum + r.count, 0);
      const totalEdges = edgeCounts.reduce((sum, r) => sum + r.count, 0);

      // File count from indexed_files
      const fileResult = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM indexed_files WHERE repository_id = $1",
        [repo.id],
      );
      const fileCount = parseInt(fileResult.rows[0].count, 10);

      const data = {
        repo: repoName,
        graph_name: graphName,
        file_count: fileCount,
        total_nodes: totalNodes,
        total_edges: totalEdges,
        nodes_by_label: Object.fromEntries(nodeCounts.map((r) => [r.label, r.count])),
        edges_by_label: Object.fromEntries(edgeCounts.map((r) => [r.label, r.count])),
      };

      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // 5. nexgraph://connections — Cross-repo connection rules + edge counts
  server.registerResource(
    "connections",
    "nexgraph://connections",
    {
      description: "Cross-repo connection rules with edge counts",
      mimeType: "application/json",
    },
    async () => {
      const result = await pool.query<ConnectionRow>(
        `SELECT rc.id, rc.source_repo_id, rc.target_repo_id,
                rc.connection_type, rc.match_rules, rc.last_resolved_at,
                sr.name AS source_repo_name, tr.name AS target_repo_name,
                COUNT(cre.id)::text AS edge_count
         FROM repo_connections rc
         LEFT JOIN repositories sr ON sr.id = rc.source_repo_id
         LEFT JOIN repositories tr ON tr.id = rc.target_repo_id
         LEFT JOIN cross_repo_edges cre
           ON cre.source_repo_id = rc.source_repo_id
           AND cre.target_repo_id = rc.target_repo_id
           AND cre.edge_type = rc.connection_type
           AND cre.project_id = rc.project_id
         WHERE rc.project_id = $1
         GROUP BY rc.id, sr.name, tr.name
         ORDER BY rc.created_at`,
        [projectId],
      );

      const connections = result.rows.map((r) => ({
        id: r.id,
        source_repo: r.source_repo_name,
        target_repo: r.target_repo_name,
        connection_type: r.connection_type,
        match_rules: r.match_rules,
        last_resolved_at: r.last_resolved_at,
        edge_count: parseInt(r.edge_count, 10),
      }));

      return {
        contents: [
          {
            uri: "nexgraph://connections",
            mimeType: "application/json",
            text: JSON.stringify({ connections }, null, 2),
          },
        ],
      };
    },
  );

  log.info("MCP resources registered (5 resources)");
}
