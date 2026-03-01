import { NodeType, EdgeType } from '../models/graph.model';

export const ALL_NODE_TYPES: NodeType[] = [
  'File', 'Folder', 'Function', 'CodeElement', 'Class', 'Interface', 'Method', 'RouteHandler',
  'Struct', 'Enum', 'Trait', 'TypeAlias', 'Namespace', 'Community', 'Process',
];

export const ALL_EDGE_TYPES: EdgeType[] = [
  'CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES', 'EXPOSES', 'HANDLES', 'MEMBER_OF', 'STEP_IN_PROCESS',
];

export const FLOW_EDGE_TYPES = new Set([
  'CALLS', 'IMPORTS', 'EXPOSES', 'HANDLES', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES',
  'CROSS_REPO_CALLS', 'CROSS_REPO_MIRRORS', 'CROSS_REPO_DEPENDS', 'CROSS_REPO_IMPORTS',
]);

export const COMPONENT_EDGE_TYPES = new Set([
  'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES', 'EXPOSES', 'HANDLES',
]);

export const SYMBOL_NODE_TYPES = new Set([
  'Function', 'Class', 'Interface', 'Method', 'CodeElement', 'RouteHandler',
  'Struct', 'Enum', 'Trait', 'TypeAlias', 'Namespace',
]);
