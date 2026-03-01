import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, expand, reduce, EMPTY } from 'rxjs';
import { map } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { ApiProject, ApiRepository, SearchResponse, SearchMode, CypherResponse, NodesResponse, DiffImpactResponse, GitHistoryResponse, GitTimelineResponse } from '../models/api.model';
import { GraphStats, NodeDetail } from '../models/graph.model';
import { CrossRepoConnection, CrossRepoEdgeRecord, CrossRepoStats } from '../models/cross-repo.model';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private get base(): string {
    return this.auth.apiBase();
  }

  // Projects
  getProjects(): Observable<{ projects: ApiProject[] }> {
    return this.http.get<{ projects: ApiProject[] }>(`${this.base}/projects`);
  }

  // Repositories
  getRepositories(): Observable<{ repositories: ApiRepository[] }> {
    return this.http.get<{ repositories: ApiRepository[] }>(`${this.base}/repositories`);
  }

  getRepository(repoId: string): Observable<ApiRepository> {
    return this.http.get<ApiRepository>(`${this.base}/repositories/${repoId}`);
  }

  // Graph
  getGraphStats(repoId: string): Observable<GraphStats> {
    return this.http.get<GraphStats>(`${this.base}/repositories/${repoId}/graph/stats`);
  }

  getGraphNodes(repoId: string, limit = 200, offset = 0): Observable<NodesResponse> {
    return this.http.get<NodesResponse>(
      `${this.base}/repositories/${repoId}/graph/nodes?limit=${limit}&offset=${offset}`
    );
  }

  fetchAllNodes(repoId: string): Observable<NodesResponse['nodes']> {
    const pageSize = 200;
    let offset = 0;
    let allNodes: NodesResponse['nodes'] = [];

    return this.getGraphNodes(repoId, pageSize, 0).pipe(
      expand(response => {
        allNodes = [...allNodes, ...response.nodes];
        offset += pageSize;
        if (response.nodes.length < pageSize) {
          return EMPTY;
        }
        return this.getGraphNodes(repoId, pageSize, offset);
      }),
      reduce((acc, response) => {
        if (acc.length === 0) {
          return response.nodes;
        }
        return [...acc, ...response.nodes];
      }, [] as NodesResponse['nodes']),
    );
  }

  postCypher(repoId: string, query: string, columns: Array<{ name: string }>): Observable<CypherResponse> {
    return this.http.post<CypherResponse>(
      `${this.base}/repositories/${repoId}/graph/cypher`,
      { query, columns }
    );
  }

  getNodeDetail(repoId: string, nodeId: string | number): Observable<NodeDetail> {
    return this.http.get<NodeDetail>(
      `${this.base}/repositories/${repoId}/graph/nodes/${nodeId}`
    );
  }

  // Search
  postSearch(repoId: string, query: string, limit = 10, mode: SearchMode = 'keyword'): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(
      `${this.base}/repositories/${repoId}/search`,
      { query, limit, mode }
    );
  }

  // Cross-repo connections
  getConnections(projectId: string): Observable<{ connections: CrossRepoConnection[] }> {
    return this.http.get<{ connections: CrossRepoConnection[] }>(
      `${this.base}/projects/${projectId}/connections`
    );
  }

  getConnectionEdges(projectId: string, connId: string, limit = 100): Observable<{ edges: CrossRepoEdgeRecord[]; total: number }> {
    return this.http.get<{ edges: CrossRepoEdgeRecord[]; total: number }>(
      `${this.base}/projects/${projectId}/connections/${connId}/edges?limit=${limit}`
    );
  }

  getCrossRepoStats(projectId: string): Observable<CrossRepoStats> {
    return this.http.get<CrossRepoStats>(
      `${this.base}/projects/${projectId}/graph/cross-repo/stats`
    );
  }

  // Diff impact
  postDiffImpact(repoId: string, scope: string, compareRef?: string, maxDepth = 3): Observable<DiffImpactResponse> {
    return this.http.post<DiffImpactResponse>(
      `${this.base}/repositories/${repoId}/graph/diff-impact`,
      { scope, compare_ref: compareRef, max_depth: maxDepth }
    );
  }

  // Graph routes
  getGraphRoutes(repoId: string): Observable<{ routes: Array<{ http_method: string; url_pattern: string }>; count: number }> {
    return this.http.get<{ routes: Array<{ http_method: string; url_pattern: string }>; count: number }>(
      `${this.base}/repositories/${repoId}/graph/routes`
    );
  }

  // Git history
  getGitHistory(repoId: string): Observable<GitHistoryResponse> {
    return this.http.get<GitHistoryResponse>(
      `${this.base}/repositories/${repoId}/graph/git-history`
    );
  }

  getGitTimeline(repoId: string): Observable<GitTimelineResponse> {
    return this.http.get<GitTimelineResponse>(
      `${this.base}/repositories/${repoId}/graph/git-timeline`
    );
  }
}
