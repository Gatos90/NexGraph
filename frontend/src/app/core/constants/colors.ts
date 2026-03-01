export interface NodeColor {
  fill: string;
  glow: string;
  stroke: string;
}

export const NODE_COLORS: Record<string, NodeColor> = {
  File:         { fill: '#4a9eff', glow: '#4a9eff40', stroke: '#3580d0' },
  Folder:       { fill: '#f0b840', glow: '#f0b84040', stroke: '#c89830' },
  Function:     { fill: '#40e8a0', glow: '#40e8a040', stroke: '#30b880' },
  CodeElement:  { fill: '#b060ff', glow: '#b060ff40', stroke: '#9040d0' },
  Class:        { fill: '#ff6090', glow: '#ff609040', stroke: '#d04070' },
  Interface:    { fill: '#60d0ff', glow: '#60d0ff40', stroke: '#40a8d0' },
  Method:       { fill: '#80e060', glow: '#80e06040', stroke: '#60b840' },
  RouteHandler: { fill: '#ff9040', glow: '#ff904040', stroke: '#d07030' },
  Struct:       { fill: '#f472b6', glow: '#f472b640', stroke: '#db2777' },
  Enum:         { fill: '#a78bfa', glow: '#a78bfa40', stroke: '#7c3aed' },
  Trait:        { fill: '#2dd4bf', glow: '#2dd4bf40', stroke: '#0d9488' },
  TypeAlias:    { fill: '#c084fc', glow: '#c084fc40', stroke: '#9333ea' },
  Namespace:    { fill: '#fcd34d', glow: '#fcd34d40', stroke: '#d97706' },
  Community:    { fill: '#fbbf24', glow: '#fbbf2440', stroke: '#d4a020' },
  Process:      { fill: '#34d399', glow: '#34d39940', stroke: '#059669' },
  _CrossRepo:   { fill: '#ff4080', glow: '#ff408040', stroke: '#d03060' },
  _RepoHub:     { fill: '#ff4080', glow: '#ff408060', stroke: '#ff4080' },
  _Component:   { fill: '#4a9eff', glow: '#4a9eff40', stroke: '#3580d0' },
};

export const EDGE_COLORS: Record<string, string> = {
  DEFINES:            '#40e8a0',
  CONTAINS:           '#f0b840',
  IMPORTS:            '#4a9eff',
  CALLS:              '#ff6090',
  EXTENDS:            '#60d0ff',
  IMPLEMENTS:         '#b060ff',
  OVERRIDES:          '#f43f5e',
  EXPOSES:            '#ff9040',
  HANDLES:            '#ff9040',
  MEMBER_OF:          '#fbbf24',
  STEP_IN_PROCESS:    '#34d399',
  CROSS_REPO_CALLS:   '#ff4080',
  CROSS_REPO_MIRRORS: '#ff4080',
  CROSS_REPO_DEPENDS: '#ff4080',
  CROSS_REPO_IMPORTS: '#ff4080',
};

export const NODE_SIZES: Record<string, number> = {
  Folder:       8,
  File:         6,
  Function:     5,
  CodeElement:  4,
  Class:        7,
  Interface:    6,
  Method:       5,
  RouteHandler: 6,
  Struct:       7,
  Enum:         5,
  Trait:        6,
  TypeAlias:    4,
  Namespace:    8,
  Community:    8,
  Process:      7,
  _CrossRepo:   5,
  _RepoHub:     18,
};

export const FOCUS_COLORS = {
  outgoing: '#ff9040',
  incoming: '#40aaff',
} as const;

export const REPO_COLORS: string[] = [
  '#e8b84a', '#e86040', '#44d4a0', '#a878ff',
  '#e85890', '#50b8e8', '#d0a030', '#70e870',
];

export const COMMUNITY_COLORS: string[] = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635',
  '#34d399', '#22d3ee', '#60a5fa', '#a78bfa',
  '#f472b6', '#e879f9', '#94a3b8', '#fcd34d',
];
