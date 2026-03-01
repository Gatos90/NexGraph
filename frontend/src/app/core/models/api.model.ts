export interface ApiProject {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiRepository {
  id: string;
  project_id: string;
  name: string | null;
  source_type: 'git_url' | 'zip_upload' | 'local_path';
  url: string;
  default_branch: string;
  graph_name: string | null;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
  indexing_status?: {
    status: string;
    started_at: string | null;
    completed_at: string | null;
    files_total: number;
    files_done: number;
    error_message: string | null;
  } | null;
}

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchResult {
  file_path: string;
  rank?: number;
  highlights?: string;
  language?: string | null;
  // Semantic fields
  symbol_name?: string;
  label?: string;
  similarity?: number;
  // Hybrid fields
  rrf_rank?: number;
  rrf_score?: number;
  keyword_rank?: number;
  semantic_rank?: number;
}

export interface SearchResponse {
  mode: SearchMode;
  results: SearchResult[];
  total: number;
}

export interface CypherResponse {
  rows: Record<string, unknown>[];
  columns: string[];
  row_count: number;
}

export interface NodesResponse {
  nodes: Array<{
    id: string | number;
    label: string;
    properties: Record<string, unknown>;
  }>;
  count: number;
}

export type DiffScope = 'unstaged' | 'staged' | 'all' | 'compare';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DiffChangedFile {
  filePath: string;
  addedLines: number[];
  removedLines: number[];
  hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; header: string }>;
  additions: number;
  deletions: number;
}

export interface DiffDirectSymbol {
  id: number;
  name: string;
  label: string;
  filePath: string;
  line: number;
}

export interface DiffImpactedSymbol {
  id: number;
  name: string;
  label: string;
  filePath: string;
  line: number;
  depth: number;
  via: string;
}

export interface DiffAffectedProcess {
  processId: number;
  label: string;
  processType: string;
  stepCount: number;
}

export interface DiffImpactResponse {
  changed_files: DiffChangedFile[];
  direct_symbols: DiffDirectSymbol[];
  impacted_symbols: DiffImpactedSymbol[];
  affected_processes: DiffAffectedProcess[];
  risk: RiskLevel;
  summary: string;
}

// Git history overlay types
export type GitOverlayMode = 'none' | 'freshness' | 'hotspots' | 'authors';

export interface GitFileCommit {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface GitFileInfo {
  file_path: string;
  last_author: string;
  last_author_email: string;
  last_commit_date: string;
  commit_count: number;
  recent_commits: GitFileCommit[];
}

export interface GitAuthor {
  name: string;
  email: string;
  file_count: number;
  commit_count: number;
}

export interface GitHistoryResponse {
  files: GitFileInfo[];
  authors: GitAuthor[];
  timeline: Array<{ date: string; commits: number; files_changed: number }>;
  total_commits: number;
}

export interface GitCommitEvent {
  sha: string;
  author_name: string;
  author_email: string;
  date: string;
  message: string;
  files: Array<{ path: string; change: string }>;
}

export interface GitTimelineResponse {
  commits: GitCommitEvent[];
  total_files: number;
}

export interface RoutesResponse {
  routes: Array<{
    http_method: string;
    url_pattern: string;
    framework?: string;
    handler_name?: string;
    file_path?: string;
    start_line?: number;
  }>;
  count: number;
}
