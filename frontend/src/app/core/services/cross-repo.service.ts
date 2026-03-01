import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { GraphNode, GraphEdge } from '../models/graph.model';
import { ConnectedRepo, ExpandedRepoData } from '../models/cross-repo.model';
import { REPO_COLORS } from '../constants/colors';

export interface CrossRepoResult {
  edges: GraphEdge[];
  phantomNodes: GraphNode[];
  connectedRepos: ConnectedRepo[];
}

@Injectable({ providedIn: 'root' })
export class CrossRepoService {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  async loadCrossRepoData(
    repoId: string,
    allNodes: GraphNode[],
  ): Promise<CrossRepoResult> {
    const projectId = this.auth.projectId();
    if (!projectId) return { edges: [], phantomNodes: [], connectedRepos: [] };

    try {
      const [connsData, reposData] = await Promise.all([
        firstValueFrom(this.api.getConnections(projectId)),
        firstValueFrom(this.api.getRepositories()),
      ]);
      const connections = connsData?.connections || [];
      const allRepos = reposData?.repositories || [];

      // Filter to connections involving the current repo
      const relevantConns = connections.filter(
        c => c.source_repo_id === repoId || c.target_repo_id === repoId,
      );
      if (!relevantConns.length) return { edges: [], phantomNodes: [], connectedRepos: [] };

      // Collect other repo IDs and their connection types
      const otherRepoMap = new Map<string, { connTypes: Set<string>; connIds: string[] }>();
      for (const conn of relevantConns) {
        const otherId = conn.source_repo_id === repoId ? conn.target_repo_id : conn.source_repo_id;
        if (!otherRepoMap.has(otherId)) {
          otherRepoMap.set(otherId, { connTypes: new Set(), connIds: [] });
        }
        otherRepoMap.get(otherId)!.connTypes.add(conn.connection_type);
        otherRepoMap.get(otherId)!.connIds.push(conn.id);
      }

      // Fetch edges for each connection
      interface AnnotatedEdgeRecord {
        source_repo_id: string;
        target_repo_id: string;
        source_node: string;
        target_node: string;
        edge_type: string;
        metadata: Record<string, unknown> | null;
        _conn_type: string;
        _other_repo_id: string;
      }
      const allEdges: AnnotatedEdgeRecord[] = [];
      for (const conn of relevantConns) {
        try {
          const edgeData = await firstValueFrom(this.api.getConnectionEdges(projectId, conn.id));
          const edges = (edgeData?.edges || []).map(e => ({
            ...e,
            _conn_type: conn.connection_type,
            _other_repo_id: conn.source_repo_id === repoId ? conn.target_repo_id : conn.source_repo_id,
          }));
          allEdges.push(...edges);
        } catch (err) {
          console.warn(`Failed to fetch edges for connection ${conn.id}:`, err);
        }
      }

      // Build phantom nodes for symbols from other repos
      const phantomNodeMap = new Map<string, GraphNode>();
      const graphEdges: GraphEdge[] = [];

      for (const edge of allEdges) {
        const isSource = edge.source_repo_id === repoId;
        const localSymbol = isSource ? edge.source_node : edge.target_node;
        const remoteSymbol = isSource ? edge.target_node : edge.source_node;
        const remoteRepoId = edge._other_repo_id;

        const localNode = this.findLocalNode(localSymbol, allNodes);

        const phantomId = `xrepo_${remoteRepoId}_${remoteSymbol}`;
        if (!phantomNodeMap.has(phantomId)) {
          phantomNodeMap.set(phantomId, {
            id: phantomId,
            label: '_CrossRepo',
            properties: {
              name: this.getDisplayName(remoteSymbol),
              full_name: remoteSymbol,
              repo_id: remoteRepoId,
            },
            _isPhantom: true,
            _repoId: remoteRepoId,
          });
        }

        if (localNode) {
          graphEdges.push({
            source: isSource ? localNode.id : phantomId,
            target: isSource ? phantomId : localNode.id,
            rel: edge.edge_type || edge._conn_type,
            _isCrossRepo: true,
            _confidence: (edge.metadata?.['confidence'] as number) ?? undefined,
            _metadata: edge.metadata ?? undefined,
          });
        }
      }

      // Create repo hub nodes — one per connected repo
      const repoHubs: GraphNode[] = [];
      const connectedRepos: ConnectedRepo[] = [];

      for (const [otherRepoId, info] of otherRepoMap) {
        const repoDetail = allRepos.find(r => r.id === otherRepoId);
        const repoName = repoDetail?.name || repoDetail?.url?.split('/').pop() || otherRepoId.slice(0, 8);
        const phantomsForRepo = Array.from(phantomNodeMap.values()).filter(n => n._repoId === otherRepoId);
        const edgesForRepo = graphEdges.filter(e => {
          const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
          const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
          return phantomsForRepo.some(p => p.id === tgtId || p.id === srcId);
        });

        const hubId = `repohub_${otherRepoId}`;
        repoHubs.push({
          id: hubId,
          label: '_RepoHub',
          properties: {
            name: repoName,
            repo_id: otherRepoId,
            url: repoDetail?.url || '',
            conn_types: Array.from(info.connTypes).join(', '),
            edge_count: edgesForRepo.length,
            phantom_count: phantomsForRepo.length,
          },
          _isPhantom: true,
          _isHub: true,
          _repoId: otherRepoId,
        });

        // Link each phantom to its repo hub
        for (const phantom of phantomsForRepo) {
          graphEdges.push({
            source: phantom.id,
            target: hubId,
            rel: '_BELONGS_TO_REPO',
            _isCrossRepo: true,
            _isHubLink: true,
          });
        }

        connectedRepos.push({
          id: otherRepoId,
          name: repoName,
          url: repoDetail?.url || '',
          phantomCount: phantomsForRepo.length,
          edgeCount: edgesForRepo.length,
          connectionTypes: new Set(info.connTypes),
        });
      }

      return {
        edges: graphEdges,
        phantomNodes: [...Array.from(phantomNodeMap.values()), ...repoHubs],
        connectedRepos,
      };
    } catch (err) {
      console.warn('Failed to fetch cross-repo data:', err);
      return { edges: [], phantomNodes: [], connectedRepos: [] };
    }
  }

  async loadExpandedRepoData(
    repoId: string,
    repoName: string,
    colorIndex: number,
    phantomNodes: GraphNode[],
  ): Promise<ExpandedRepoData> {
    const color = REPO_COLORS[colorIndex % REPO_COLORS.length];
    const prefix = `repo_${repoId}_`;

    // Fetch full graph data for this repo
    const [rawNodes, edgeResp] = await Promise.all([
      firstValueFrom(this.api.fetchAllNodes(repoId)),
      firstValueFrom(
        this.api.postCypher(repoId, 'MATCH (a)-[r]->(b) RETURN r', [{ name: 'r' }]),
      ),
    ]);

    // Build prefixed nodes
    const nodes: GraphNode[] = (rawNodes || []).map(n => ({
      id: `${prefix}${n.id}`,
      label: n.label as GraphNode['label'],
      properties: n.properties,
      _repoId: repoId,
      _repoName: repoName,
      _repoColor: color,
      _isExpandedRepo: true,
    }));

    // Build prefixed edges
    const edges: GraphEdge[] = (edgeResp?.rows || []).map((row: Record<string, unknown>) => {
      const r = row['r'] as Record<string, unknown>;
      return {
        source: `${prefix}${r['start_id']}`,
        target: `${prefix}${r['end_id']}`,
        rel: r['label'] as string,
        _isExpandedRepoEdge: true,
      };
    });

    // Build phantom-to-actual node mapping
    const phantomToNodeId = new Map<string, string | number>();
    const repoPhantoms = phantomNodes.filter(
      n => n._repoId === repoId && !n._isHub,
    );
    for (const phantom of repoPhantoms) {
      const symbolStr = (phantom.properties?.['full_name'] as string) || '';
      if (!symbolStr) continue;
      // Match against the un-prefixed nodes, then return the prefixed ID
      const rawMatch = (rawNodes || []).find(n => {
        return this.matchSymbol(symbolStr, n.label, n.properties);
      });
      if (rawMatch) {
        phantomToNodeId.set(phantom.id as string, `${prefix}${rawMatch.id}`);
      }
    }

    return { repoId, repoName, nodes, edges, colorIndex, color, phantomToNodeId };
  }

  async loadAllExpandedRepos(
    repos: ConnectedRepo[],
    phantomNodes: GraphNode[],
  ): Promise<ExpandedRepoData[]> {
    return Promise.all(
      repos.map((repo, i) =>
        this.loadExpandedRepoData(repo.id, repo.name, i, phantomNodes),
      ),
    );
  }

  private matchSymbol(
    symbolStr: string,
    label: string,
    properties: Record<string, unknown>,
  ): boolean {
    const fileLineMatch = symbolStr.match(/^(.+):(\d+)$/);
    if (fileLineMatch) {
      const filePath = fileLineMatch[1];
      return label === 'File' &&
        ((properties?.['path'] as string) === filePath ||
         (properties?.['path'] as string)?.endsWith('/' + filePath));
    }

    const routeMatch = symbolStr.match(/^RouteHandler:(\w+):(.+)$/);
    if (routeMatch) {
      return label === 'RouteHandler' &&
        properties?.['http_method'] === routeMatch[1] &&
        properties?.['url_pattern'] === routeMatch[2];
    }

    const labelNameFile = symbolStr.match(/^(\w+):([^:]+):(.+)$/);
    if (labelNameFile) {
      const [, matchLabel, name] = labelNameFile;
      return (label === matchLabel && properties?.['name'] === name) ||
        properties?.['name'] === name;
    }

    const name = (properties?.['name'] as string) || (properties?.['path'] as string) || '';
    return name === symbolStr || name.endsWith('/' + symbolStr);
  }

  private findLocalNode(symbolStr: string, allNodes: GraphNode[]): GraphNode | undefined {
    // Format: "src/api.ts:86" (file:line — legacy, falls back to File node)
    const fileLineMatch = symbolStr.match(/^(.+):(\d+)$/);
    if (fileLineMatch) {
      const filePath = fileLineMatch[1];
      return allNodes.find(n =>
        n.label === 'File' &&
        (n.properties?.['path'] === filePath ||
         (n.properties?.['path'] as string)?.endsWith('/' + filePath)),
      );
    }

    // Format: "RouteHandler:GET:/articles/feed" (label:method:path)
    const routeMatch = symbolStr.match(/^RouteHandler:(\w+):(.+)$/);
    if (routeMatch) {
      return allNodes.find(n =>
        n.label === 'RouteHandler' &&
        n.properties?.['http_method'] === routeMatch[1] &&
        n.properties?.['url_pattern'] === routeMatch[2],
      ) || allNodes.find(n =>
        n.label === 'RouteHandler' &&
        n.properties?.['url_pattern'] === routeMatch[2],
      );
    }

    // Format: "Function:login:src/api.ts" (label:name:file)
    const labelNameFile = symbolStr.match(/^(\w+):([^:]+):(.+)$/);
    if (labelNameFile) {
      const [, label, name] = labelNameFile;
      return allNodes.find(n =>
        n.label === label && n.properties?.['name'] === name,
      ) || allNodes.find(n =>
        n.properties?.['name'] === name,
      );
    }

    // Fallback: match by name
    return allNodes.find(n => {
      const name = (n.properties?.['name'] as string) || (n.properties?.['path'] as string) || '';
      return name === symbolStr || name.endsWith('/' + symbolStr);
    });
  }

  private getDisplayName(symbolStr: string): string {
    const fileLineMatch = symbolStr.match(/^(.+):(\d+)$/);
    if (fileLineMatch) return fileLineMatch[1].split('/').pop() + ':' + fileLineMatch[2];

    const routeMatch = symbolStr.match(/^RouteHandler:(\w+):(.+)$/);
    if (routeMatch) return routeMatch[1] + ' ' + routeMatch[2];

    const labelNameFile = symbolStr.match(/^(\w+):([^:]+):(.+)$/);
    if (labelNameFile) return labelNameFile[2];

    return symbolStr;
  }
}
