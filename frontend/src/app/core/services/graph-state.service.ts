import { Injectable, signal, computed } from '@angular/core';
import { GraphNode, GraphEdge, FilteredGraphData, LayoutMode } from '../models/graph.model';
import { ALL_NODE_TYPES, ALL_EDGE_TYPES } from '../constants/types';
import { NodeType, EdgeType } from '../models/graph.model';
import { ConnectedRepo, ExpandedRepoData } from '../models/cross-repo.model';
import { GitOverlayMode, GitFileInfo, GitAuthor } from '../models/api.model';

@Injectable({ providedIn: 'root' })
export class GraphStateService {
  // Context
  readonly repoId = signal<string>('');

  // Raw data
  readonly allNodes = signal<GraphNode[]>([]);
  readonly allEdges = signal<GraphEdge[]>([]);
  readonly crossRepoNodes = signal<GraphNode[]>([]);
  readonly crossRepoEdges = signal<GraphEdge[]>([]);

  // Filters
  readonly activeNodeFilters = signal<Set<string>>(new Set(ALL_NODE_TYPES));
  readonly activeEdgeFilters = signal<Set<string>>(new Set([...ALL_EDGE_TYPES, 'CROSS_REPO']));
  readonly showCrossRepo = signal(false);
  readonly minConfidence = signal(0);

  // Multi-repo expansion
  readonly connectedRepos = signal<ConnectedRepo[]>([]);
  readonly expandedRepos = signal<Map<string, ExpandedRepoData>>(new Map());
  readonly expandingRepoIds = signal<Set<string>>(new Set());

  // Layout
  readonly layoutMode = signal<LayoutMode>('force');

  // Renderer
  readonly rendererMode = signal<'webgl' | 'svg'>('webgl');

  // Focus
  readonly focusMode = signal(false);
  readonly focusNodeId = signal<string | number | null>(null);
  readonly focusDepth = signal(1);
  readonly focusNeighborIds = signal<Set<string | number>>(new Set());

  // Selection
  readonly selectedNodeId = signal<string | number | null>(null);
  readonly sidePanelOpen = signal(false);

  // Community overlay
  readonly communityOverlay = signal(false);
  readonly communityMap = signal<Map<string | number, string>>(new Map());
  readonly communityColors = signal<Map<string, string>>(new Map());
  readonly activeCommunityId = signal<string | null>(null);

  // Process overlay
  readonly activeProcess = signal<string | null>(null);
  readonly processStepIds = signal<(string | number)[]>([]);

  // Diff impact overlay
  readonly diffImpactActive = signal(false);
  readonly diffDirectIds = signal<Set<string | number>>(new Set());
  readonly diffImpactedIds = signal<Set<string | number>>(new Set());

  // Git history overlay
  readonly gitOverlayMode = signal<GitOverlayMode>('none');
  readonly gitFileData = signal<Map<string, GitFileInfo>>(new Map());
  readonly gitAuthors = signal<GitAuthor[]>([]);
  readonly gitAuthorColors = signal<Map<string, string>>(new Map());

  // Loading
  readonly loading = signal(false);

  // Computed: filtered data for force/flow layouts
  readonly filteredData = computed<FilteredGraphData>(() => {
    return this.computeFilteredData();
  });

  private computeFilteredData(): FilteredGraphData {
    const nodeFilters = this.activeNodeFilters();
    const edgeFilters = this.activeEdgeFilters();
    const nodes = this.allNodes();
    const edges = this.allEdges();

    const nodeSet = new Set<string | number>();
    const resultNodes: GraphNode[] = nodes.filter(n => {
      if (!nodeFilters.has(n.label)) return false;
      nodeSet.add(n.id);
      return true;
    });

    const resultEdges: GraphEdge[] = edges.filter(e => {
      if (!edgeFilters.has(e.rel)) return false;
      const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
      return nodeSet.has(srcId) && nodeSet.has(tgtId);
    });

    if (!this.showCrossRepo()) {
      return { nodes: resultNodes, edges: resultEdges };
    }

    // Merge expanded repos
    const expanded = this.expandedRepos();
    const expandedRepoIds = new Set<string>();

    for (const [repoId, data] of expanded) {
      expandedRepoIds.add(repoId);
      for (const n of data.nodes) {
        if (!nodeFilters.has(n.label)) continue;
        nodeSet.add(n.id);
        resultNodes.push(n);
      }
      for (const e of data.edges) {
        if (!edgeFilters.has(e.rel)) continue;
        const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
        const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
        if (nodeSet.has(srcId) && nodeSet.has(tgtId)) {
          resultEdges.push(e);
        }
      }
    }

    // Process cross-repo edges (phantom/hub handling)
    const crossNodes = this.crossRepoNodes();
    const crossEdges = this.crossRepoEdges();
    if (edgeFilters.has('CROSS_REPO') && crossEdges.length) {
      const isPhantomId = (id: string | number) =>
        String(id).startsWith('xrepo_') || String(id).startsWith('repohub_');

      // Build phantom-to-actual resolution map from all expanded repos
      const phantomToActual = new Map<string | number, string | number>();
      for (const [, data] of expanded) {
        for (const [phantomId, actualId] of data.phantomToNodeId) {
          phantomToActual.set(phantomId, actualId);
        }
      }

      const confidence = this.minConfidence();
      const neededPhantoms = new Set<string | number>();

      for (const e of crossEdges) {
        // Skip hub links for expanded repos
        if (e._isHubLink) {
          const srcStr = String(typeof e.source === 'object' ? (e.source as GraphNode).id : e.source);
          const tgtStr = String(typeof e.target === 'object' ? (e.target as GraphNode).id : e.target);
          const hubStr = srcStr.startsWith('repohub_') ? srcStr : tgtStr;
          const hubRepoId = hubStr.replace('repohub_', '');
          if (expandedRepoIds.has(hubRepoId)) continue;
        }

        // Apply confidence filter
        if (!e._isHubLink && confidence > 0) {
          const conf = e._confidence ?? 0;
          if (conf < confidence) continue;
        }

        let srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
        let tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;

        // Resolve phantoms to actual expanded-repo nodes
        const resolvedSrc = phantomToActual.get(srcId);
        const resolvedTgt = phantomToActual.get(tgtId);
        if (resolvedSrc) srcId = resolvedSrc;
        if (resolvedTgt) tgtId = resolvedTgt;

        // Include edge if at least one endpoint is valid
        const srcValid = nodeSet.has(srcId) || isPhantomId(srcId);
        const tgtValid = nodeSet.has(tgtId) || isPhantomId(tgtId);
        if (srcValid && tgtValid) {
          if (isPhantomId(srcId) && !nodeSet.has(srcId)) neededPhantoms.add(srcId);
          if (isPhantomId(tgtId) && !nodeSet.has(tgtId)) neededPhantoms.add(tgtId);
          resultEdges.push({
            ...e,
            source: srcId,
            target: tgtId,
          });
        }
      }

      // Add phantom/hub nodes only for non-expanded repos
      const phantoms = crossNodes.filter(n => {
        if (n._isHub) return !expandedRepoIds.has(n._repoId || '');
        return neededPhantoms.has(n.id);
      });
      for (const n of phantoms) {
        nodeSet.add(n.id);
        resultNodes.push(n);
      }
    }

    return { nodes: resultNodes, edges: resultEdges };
  }

  computeNeighborhood(
    nodeId: string | number,
    depth: number,
    componentEdges?: GraphEdge[],
  ): Set<string | number> {
    let edges: GraphEdge[];
    // Build phantom ↔ actual ID bridge for expanded repos
    const phantomToActual = new Map<string | number, string | number>();
    const actualToPhantom = new Map<string | number, string | number>();

    if (componentEdges) {
      edges = componentEdges;
    } else {
      edges = [...this.allEdges()];
      if (this.showCrossRepo()) {
        edges.push(...this.crossRepoEdges());
      }
      for (const [, data] of this.expandedRepos()) {
        edges.push(...data.edges);
        // Map phantom IDs to expanded-repo actual IDs (and reverse)
        for (const [phantomId, actualId] of data.phantomToNodeId) {
          phantomToActual.set(phantomId, actualId);
          actualToPhantom.set(actualId, phantomId);
        }
      }
    }

    const neighbors = new Set<string | number>([nodeId]);
    let frontier = new Set<string | number>([nodeId]);

    for (let hop = 0; hop < depth; hop++) {
      // Expand frontier: if a phantom ID has a resolved actual ID, add it too
      // This bridges cross-repo edges (phantom endpoints) with expanded-repo edges (actual endpoints)
      const expandedFrontier = new Set(frontier);
      for (const fId of frontier) {
        const actual = phantomToActual.get(fId);
        if (actual && !neighbors.has(actual)) {
          expandedFrontier.add(actual);
          neighbors.add(actual);
        }
        const phantom = actualToPhantom.get(fId);
        if (phantom && !neighbors.has(phantom)) {
          expandedFrontier.add(phantom);
          neighbors.add(phantom);
        }
      }

      const nextFrontier = new Set<string | number>();
      for (const edge of edges) {
        const srcId = typeof edge.source === 'object' ? (edge.source as GraphNode).id : edge.source;
        const tgtId = typeof edge.target === 'object' ? (edge.target as GraphNode).id : edge.target;
        if (expandedFrontier.has(srcId) && !neighbors.has(tgtId)) {
          nextFrontier.add(tgtId);
          neighbors.add(tgtId);
        }
        if (expandedFrontier.has(tgtId) && !neighbors.has(srcId)) {
          nextFrontier.add(srcId);
          neighbors.add(srcId);
        }
      }
      frontier = nextFrontier;
    }
    return neighbors;
  }

  // Mutators
  toggleNodeFilter(type: NodeType): void {
    const filters = new Set(this.activeNodeFilters());
    if (filters.has(type)) {
      filters.delete(type);
    } else {
      filters.add(type);
    }
    this.activeNodeFilters.set(filters);
  }

  toggleEdgeFilter(type: EdgeType | 'CROSS_REPO'): void {
    const filters = new Set(this.activeEdgeFilters());
    if (filters.has(type)) {
      filters.delete(type);
    } else {
      filters.add(type);
    }
    this.activeEdgeFilters.set(filters);
  }

  setLayoutMode(mode: LayoutMode): void {
    this.layoutMode.set(mode);
  }

  enterFocusMode(nodeId: string | number, componentEdges?: GraphEdge[]): void {
    this.focusNodeId.set(nodeId);
    this.focusDepth.set(1);
    this.focusMode.set(true);
    this.focusNeighborIds.set(this.computeNeighborhood(nodeId, 1, componentEdges));
  }

  setFocusDepth(depth: number, componentEdges?: GraphEdge[]): void {
    this.focusDepth.set(depth);
    const nodeId = this.focusNodeId();
    if (nodeId != null) {
      this.focusNeighborIds.set(this.computeNeighborhood(nodeId, depth, componentEdges));
    }
  }

  exitFocusMode(): void {
    this.focusMode.set(false);
    this.focusNodeId.set(null);
    this.focusNeighborIds.set(new Set());
  }

  /** Returns repo IDs of phantom nodes in the current neighbor set that aren't expanded yet. */
  getUnexpandedPhantomRepoIds(): string[] {
    const neighbors = this.focusNeighborIds();
    const expanded = this.expandedRepos();
    const repoIds = new Set<string>();
    for (const id of neighbors) {
      const idStr = String(id);
      if (idStr.startsWith('xrepo_')) {
        // Extract repo ID from "xrepo_{repoId}_{symbol}"
        const rest = idStr.slice('xrepo_'.length);
        const underscoreIdx = rest.indexOf('_');
        if (underscoreIdx > 0) {
          const repoId = rest.slice(0, underscoreIdx);
          if (!expanded.has(repoId)) {
            repoIds.add(repoId);
          }
        }
      }
    }
    return Array.from(repoIds);
  }

  /** Recompute focus neighborhood with current data (call after repo expansion). */
  recomputeFocusNeighborhood(): void {
    const nodeId = this.focusNodeId();
    const depth = this.focusDepth();
    if (nodeId != null && this.focusMode()) {
      this.focusNeighborIds.set(this.computeNeighborhood(nodeId, depth));
    }
  }

  selectNode(nodeId: string | number | null): void {
    this.selectedNodeId.set(nodeId);
    this.sidePanelOpen.set(nodeId != null);
  }

  closeSidePanel(): void {
    this.sidePanelOpen.set(false);
    this.selectedNodeId.set(null);
  }

  setShowCrossRepo(show: boolean): void {
    this.showCrossRepo.set(show);
  }

  setMinConfidence(value: number): void {
    this.minConfidence.set(value);
  }

  setConnectedRepos(repos: ConnectedRepo[]): void {
    this.connectedRepos.set(repos);
  }

  expandRepo(data: ExpandedRepoData): void {
    const map = new Map(this.expandedRepos());
    map.set(data.repoId, data);
    this.expandedRepos.set(map);
  }

  collapseRepo(repoId: string): void {
    const map = new Map(this.expandedRepos());
    map.delete(repoId);
    this.expandedRepos.set(map);
  }

  collapseAllRepos(): void {
    this.expandedRepos.set(new Map());
  }

  setCommunityOverlay(enabled: boolean): void {
    this.communityOverlay.set(enabled);
    if (!enabled) {
      this.activeCommunityId.set(null);
    }
  }

  setCommunityData(
    communityMap: Map<string | number, string>,
    communityColors: Map<string, string>,
  ): void {
    this.communityMap.set(communityMap);
    this.communityColors.set(communityColors);
  }

  setActiveCommunityId(communityId: string | null): void {
    this.activeCommunityId.set(communityId);
  }

  setActiveProcess(processId: string | null): void {
    this.activeProcess.set(processId);
  }

  setProcessStepIds(ids: (string | number)[]): void {
    this.processStepIds.set(ids);
  }

  setDiffImpact(
    active: boolean,
    directIds: Set<string | number> = new Set(),
    impactedIds: Set<string | number> = new Set(),
  ): void {
    this.diffImpactActive.set(active);
    this.diffDirectIds.set(directIds);
    this.diffImpactedIds.set(impactedIds);
  }

  setGitOverlay(
    mode: GitOverlayMode,
    fileData: Map<string, GitFileInfo> = new Map(),
    authors: GitAuthor[] = [],
    authorColors: Map<string, string> = new Map(),
  ): void {
    this.gitOverlayMode.set(mode);
    this.gitFileData.set(fileData);
    this.gitAuthors.set(authors);
    this.gitAuthorColors.set(authorColors);
  }

  reset(): void {
    this.repoId.set('');
    this.allNodes.set([]);
    this.allEdges.set([]);
    this.crossRepoNodes.set([]);
    this.crossRepoEdges.set([]);
    this.activeNodeFilters.set(new Set(ALL_NODE_TYPES));
    this.activeEdgeFilters.set(new Set([...ALL_EDGE_TYPES, 'CROSS_REPO']));
    this.showCrossRepo.set(false);
    this.minConfidence.set(0);
    this.connectedRepos.set([]);
    this.expandedRepos.set(new Map());
    this.expandingRepoIds.set(new Set());
    this.layoutMode.set('force');
    this.rendererMode.set('webgl');
    this.focusMode.set(false);
    this.focusNodeId.set(null);
    this.focusDepth.set(1);
    this.focusNeighborIds.set(new Set());
    this.selectedNodeId.set(null);
    this.sidePanelOpen.set(false);
    this.communityOverlay.set(false);
    this.communityMap.set(new Map());
    this.communityColors.set(new Map());
    this.activeCommunityId.set(null);
    this.activeProcess.set(null);
    this.processStepIds.set([]);
    this.diffImpactActive.set(false);
    this.diffDirectIds.set(new Set());
    this.diffImpactedIds.set(new Set());
    this.gitOverlayMode.set('none');
    this.gitFileData.set(new Map());
    this.gitAuthors.set([]);
    this.gitAuthorColors.set(new Map());
    this.loading.set(false);
  }
}
