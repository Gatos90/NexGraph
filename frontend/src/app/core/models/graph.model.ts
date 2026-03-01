export type NodeType = 'File' | 'Folder' | 'Function' | 'CodeElement' | 'Class' | 'Interface' | 'Method' | 'RouteHandler' | 'Struct' | 'Enum' | 'Trait' | 'TypeAlias' | 'Namespace' | 'Community' | 'Process';
export type SpecialNodeType = '_CrossRepo' | '_RepoHub' | '_Component';
export type AnyNodeType = NodeType | SpecialNodeType;

export type EdgeType = 'CONTAINS' | 'DEFINES' | 'IMPORTS' | 'CALLS' | 'EXTENDS' | 'IMPLEMENTS' | 'OVERRIDES' | 'EXPOSES' | 'HANDLES' | 'MEMBER_OF' | 'STEP_IN_PROCESS';
export type CrossRepoEdgeType = 'CROSS_REPO_CALLS' | 'CROSS_REPO_MIRRORS' | 'CROSS_REPO_DEPENDS' | 'CROSS_REPO_IMPORTS';

export type LayoutMode = 'force' | 'flow' | 'components';

export interface GraphNode {
  id: string | number;
  label: AnyNodeType;
  properties: Record<string, unknown>;
  // Synthetic fields added client-side
  _isPhantom?: boolean;
  _isHub?: boolean;
  _isComponent?: boolean;
  _repoId?: string;
  _repoName?: string;
  _repoColor?: string;
  _isExpandedRepo?: boolean;
  _fileId?: string | number;
  _childCount?: number;
  _childCounts?: Record<string, number>;
  _children?: GraphNode[];
  _componentColor?: { fill: string; glow: string; stroke: string };
  _confidence?: number;
  // D3 simulation position
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  // D3 internal
  index?: number;
  vx?: number;
  vy?: number;
}

export interface GraphEdge {
  source: string | number | GraphNode;
  target: string | number | GraphNode;
  rel: string;
  _isCrossRepo?: boolean;
  _isHubLink?: boolean;
  _isExpandedRepoEdge?: boolean;
  _confidence?: number;
  _metadata?: Record<string, unknown>;
}

export interface FilteredGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  nodes: Record<string, number>;
  edges: Record<string, number>;
}

export interface NodeDetail {
  node: {
    id: string | number;
    label: string;
    properties: Record<string, unknown>;
  };
  relationships: {
    outgoing: RelationshipEntry[];
    incoming: RelationshipEntry[];
  };
}

export interface RelationshipEntry {
  edge: {
    id: string | number;
    label: string;
    start_id: string | number;
    end_id: string | number;
    properties: Record<string, unknown>;
  };
  source: {
    id: string | number;
    label: string;
    properties: Record<string, unknown>;
  };
  target: {
    id: string | number;
    label: string;
    properties: Record<string, unknown>;
  };
}
