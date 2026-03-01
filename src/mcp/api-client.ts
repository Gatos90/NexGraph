import { createChildLogger } from "../logger.js";

const log = createChildLogger("mcp-api-client");

// ---- Types ----

export interface ApiClientConfig {
  baseUrl: string; // e.g., "http://localhost:3000"
  apiKey: string; // Bearer token
  projectId: string; // UUID
  apiPrefix?: string; // defaults to "/api/v1"
}

export interface RepoInfo {
  id: string;
  name: string;
  project_id: string;
  graph_name: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body && "error" in body
        ? String((body as { error: string }).error)
        : `HTTP ${status}`,
    );
    this.name = "ApiError";
  }
}

// ---- Client ----

export class NexGraphApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly projectId: string;
  private readonly prefix: string;
  private repoCache: { repos: RepoInfo[]; fetchedAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
    this.prefix = config.apiPrefix ?? "/api/v1";
  }

  /**
   * Bootstrap a client by calling GET /projects to discover the project ID.
   * Uses the first project returned for the given API key.
   */
  static async discover(opts: {
    baseUrl: string;
    apiKey: string;
    apiPrefix?: string;
  }): Promise<NexGraphApiClient> {
    const base = opts.baseUrl.replace(/\/$/, "");
    const prefix = opts.apiPrefix ?? "/api/v1";
    const res = await fetch(`${base}${prefix}/projects`, {
      headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to discover project (HTTP ${res.status}): ${body}`);
    }
    const data = (await res.json()) as { projects: { id: string; name: string }[] };
    if (!data.projects || data.projects.length === 0) {
      throw new Error("No projects found for this API key");
    }
    const project = data.projects[0];
    log.info({ projectId: project.id, projectName: project.name }, "Discovered project");
    return new NexGraphApiClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      projectId: project.id,
      apiPrefix: opts.apiPrefix,
    });
  }

  // ---- Internal helpers ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${this.prefix}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    log.debug({ method, path }, "API request");

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new ApiError(response.status, errorBody);
    }

    return response.json() as Promise<T>;
  }

  private qs(
    params: Record<string, string | number | boolean | undefined>,
  ): string {
    const entries = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(
        ([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      );
    return entries.length > 0 ? `?${entries.join("&")}` : "";
  }

  // ---- Repo Resolution ----

  async getAllRepos(): Promise<RepoInfo[]> {
    if (
      this.repoCache &&
      Date.now() - this.repoCache.fetchedAt < NexGraphApiClient.CACHE_TTL_MS
    ) {
      return this.repoCache.repos;
    }
    const result = await this.request<{ repositories: RepoInfo[] }>(
      "GET",
      "/repositories",
    );
    this.repoCache = { repos: result.repositories, fetchedAt: Date.now() };
    return result.repositories;
  }

  async resolveRepo(repoName?: string): Promise<RepoInfo | null> {
    const repos = await this.getAllRepos();
    if (repoName) {
      return repos.find((r) => r.name === repoName) ?? null;
    }
    // If no repo name given, return first indexed repo (or null if multiple)
    const indexed = repos.filter((r) => r.graph_name);
    return indexed.length === 1 ? indexed[0] : null;
  }

  invalidateRepoCache(): void {
    this.repoCache = null;
  }

  // ---- Graph ----

  async getGraphStats(repoId: string, extended?: boolean) {
    const q = extended ? "?extended=true" : "";
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/stats${q}`,
    );
  }

  async getOrphans(
    repoId: string,
    params?: { label?: string; limit?: number; offset?: number },
  ) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/orphans${this.qs(params ?? {})}`,
    );
  }

  async getRoutes(repoId: string) {
    return this.request<{ routes: unknown[]; count: number }>(
      "GET",
      `/repositories/${repoId}/graph/routes`,
    );
  }

  async executeCypher(
    repoId: string,
    body: {
      query: string;
      params?: Record<string, unknown>;
      columns?: Array<{ name: string }>;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/graph/cypher`,
      body,
    );
  }

  async listNodes(
    repoId: string,
    params?: {
      name?: string;
      label?: string;
      file_path?: string;
      exported?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    return this.request<{ nodes: unknown[]; count: number }>(
      "GET",
      `/repositories/${repoId}/graph/nodes${this.qs(params ?? {})}`,
    );
  }

  async getNodeDetail(repoId: string, nodeId: string) {
    return this.request<{
      node: unknown;
      relationships: { outgoing: unknown[]; incoming: unknown[] };
    }>("GET", `/repositories/${repoId}/graph/nodes/${nodeId}`);
  }

  async listEdges(
    repoId: string,
    params?: { type?: string; source_label?: string; limit?: number },
  ) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/edges${this.qs(params ?? {})}`,
    );
  }

  async analyzeImpact(
    repoId: string,
    body: {
      symbol: string;
      direction?: string;
      depth?: number;
      file_path?: string;
      include_cross_repo?: boolean;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/graph/impact`,
      body,
    );
  }

  async getDependencies(
    repoId: string,
    body: { file_path?: string; symbol?: string; depth?: number },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/graph/dependencies`,
      body,
    );
  }

  async findPath(
    repoId: string,
    body: {
      from: string;
      to: string;
      max_depth?: number;
      from_file_path?: string;
      to_file_path?: string;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/graph/path`,
      body,
    );
  }

  async checkArchitecture(
    repoId: string,
    body: {
      layers?: Record<string, string>;
      rules?: Array<{ from: string; deny: string[] }>;
      edge_types?: string[];
      save?: boolean;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/graph/architecture`,
      body,
    );
  }

  async listCommunities(
    repoId: string,
    params?: { limit?: number; offset?: number },
  ) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/communities${this.qs(params ?? {})}`,
    );
  }

  async getCommunityDetail(repoId: string, communityId: string) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/communities/${communityId}`,
    );
  }

  async listProcesses(
    repoId: string,
    params?: { limit?: number; offset?: number; type?: string },
  ) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/processes${this.qs(params ?? {})}`,
    );
  }

  async getProcessDetail(repoId: string, processId: string) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/processes/${processId}`,
    );
  }

  async diffImpact(
    repoId: string,
    body: { scope?: string; compare_ref?: string; max_depth?: number },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/graph/diff-impact`,
      body,
    );
  }

  async renameSymbol(
    repoId: string,
    body: {
      symbol: string;
      new_name: string;
      file_path?: string;
      label?: string;
      dry_run?: boolean;
      min_confidence?: number;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/graph/rename`,
      body,
    );
  }

  async getGitHistory(
    repoId: string,
    params?: { file_path?: string; limit?: number },
  ) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/git-history${this.qs(params ?? {})}`,
    );
  }

  async getGitTimeline(
    repoId: string,
    params?: { since?: string; until?: string; limit?: number },
  ) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/graph/git-timeline${this.qs(params ?? {})}`,
    );
  }

  // ---- Search ----

  async search(
    repoId: string,
    body: { query: string; limit?: number; mode?: string },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/search`,
      body,
    );
  }

  async grep(
    repoId: string,
    body: {
      pattern: string;
      case_sensitive?: boolean;
      context_lines?: number;
      limit?: number;
      file_pattern?: string;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/repositories/${repoId}/search/grep`,
      body,
    );
  }

  async projectSearch(body: {
    query: string;
    limit?: number;
    mode?: string;
  }) {
    return this.request<unknown>(
      "POST",
      `/projects/${this.projectId}/search`,
      body,
    );
  }

  // ---- Files ----

  async getFileTree(
    repoId: string,
    params?: { path?: string; language?: string; flat?: string },
  ) {
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/files${this.qs(params ?? {})}`,
    );
  }

  async readFile(
    repoId: string,
    filePath: string,
    params?: { start_line?: number; end_line?: number },
  ) {
    const q = this.qs(params ?? {});
    return this.request<unknown>(
      "GET",
      `/repositories/${repoId}/files/${filePath}${q}`,
    );
  }

  // ---- Cross-repo (project-level) ----

  async crossRepoTrace(body: {
    start_repo_id: string;
    start_symbol: string;
    direction?: string;
    max_depth?: number;
  }) {
    return this.request<unknown>(
      "POST",
      `/projects/${this.projectId}/graph/cross-repo/trace`,
      body,
    );
  }

  async crossRepoImpact(body: {
    symbol: string;
    repo_id: string;
    direction?: string;
    depth?: number;
  }) {
    return this.request<unknown>(
      "POST",
      `/projects/${this.projectId}/graph/cross-repo/impact`,
      body,
    );
  }

  async getCrossRepoStats() {
    return this.request<unknown>(
      "GET",
      `/projects/${this.projectId}/graph/cross-repo/stats`,
    );
  }

  // ---- Connections (project-level) ----

  async listConnections() {
    return this.request<unknown>(
      "GET",
      `/projects/${this.projectId}/connections`,
    );
  }
}
