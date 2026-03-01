import { GraphNode, GraphEdge } from './graph.model';

export interface CrossRepoConnection {
  id: string;
  project_id: string;
  source_repo_id: string;
  target_repo_id: string;
  connection_type: string;
  match_rules: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_resolved_at: string | null;
  edge_count?: number;
}

export interface CrossRepoEdgeRecord {
  id: string;
  project_id: string;
  connection_id: string;
  source_repo_id: string;
  target_repo_id: string;
  source_node: string;
  target_node: string;
  edge_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ConnectedRepo {
  id: string;
  name: string;
  url: string;
  phantomCount: number;
  edgeCount: number;
  connectionTypes: Set<string>;
}

export interface ExpandedRepoData {
  repoId: string;
  repoName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  colorIndex: number;
  color: string;
  /** Maps phantom IDs (xrepo_{repoId}_{symbol}) to actual expanded-repo node IDs */
  phantomToNodeId: Map<string, string | number>;
}

export interface CrossRepoStats {
  total_edges: number;
  total_connections: number;
  by_edge_type: Record<string, number>;
  by_repo_pair: Array<{
    source_repo_id: string;
    target_repo_id: string;
    edge_count: number;
  }>;
  repos_involved: number;
}
