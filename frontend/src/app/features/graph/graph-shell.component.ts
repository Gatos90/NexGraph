import { Component, input, output, inject, OnInit, OnDestroy, signal, ViewChild, HostListener, effect } from '@angular/core';
import { Subscription, firstValueFrom, merge } from 'rxjs';
import { ApiRepository } from '../../core/models/api.model';
import { GraphStats, GraphNode } from '../../core/models/graph.model';
import { ConnectedRepo } from '../../core/models/cross-repo.model';
import { ApiService } from '../../core/services/api.service';
import { GraphStateService } from '../../core/services/graph-state.service';
import { CrossRepoService } from '../../core/services/cross-repo.service';
import { D3GraphService } from '../../core/services/d3-graph.service';
import { PixiGraphService } from '../../core/services/pixi-graph.service';
import { IdleService } from '../../core/services/idle.service';
import { ScreensaverService } from '../../core/services/screensaver.service';
import { TopbarComponent } from './topbar/topbar.component';
import { FilterBarComponent } from './filter-bar/filter-bar.component';
import { GraphCanvasComponent } from './canvas/graph-canvas.component';
import { LoadingOverlayComponent } from './overlays/loading-overlay.component';
import { ZoomControlsComponent } from './overlays/zoom-controls.component';
import { FocusControlsComponent } from './overlays/focus-controls.component';
import { FocusLegendComponent } from './overlays/focus-legend.component';
import { TooltipComponent } from './overlays/tooltip.component';
import { MinimapComponent } from './overlays/minimap.component';
import { RepoLegendComponent } from './overlays/repo-legend.component';
import { CommunityLegendComponent } from './overlays/community-legend.component';
import { ProcessPanelComponent } from './overlays/process-panel.component';
import { DiffImpactPanelComponent } from './overlays/diff-impact-panel.component';
import { GitHistoryPanelComponent } from './overlays/git-history-panel.component';
import { SidePanelComponent } from './side-panel/side-panel.component';

@Component({
  selector: 'app-graph-shell',
  standalone: true,
  imports: [
    TopbarComponent,
    FilterBarComponent,
    GraphCanvasComponent,
    LoadingOverlayComponent,
    ZoomControlsComponent,
    FocusControlsComponent,
    FocusLegendComponent,
    TooltipComponent,
    MinimapComponent,
    RepoLegendComponent,
    CommunityLegendComponent,
    ProcessPanelComponent,
    DiffImpactPanelComponent,
    GitHistoryPanelComponent,
    SidePanelComponent,
  ],
  templateUrl: './graph-shell.component.html',
  styleUrl: './graph-shell.component.scss',
})
export class GraphShellComponent implements OnInit, OnDestroy {
  readonly repo = input.required<ApiRepository>();
  readonly backToRepos = output<void>();
  readonly disconnect = output<void>();

  private api = inject(ApiService);
  readonly state = inject(GraphStateService);
  private crossRepo = inject(CrossRepoService);
  private d3Graph = inject(D3GraphService);
  private pixiGraph = inject(PixiGraphService);
  private idle = inject(IdleService);
  readonly screensaver = inject(ScreensaverService);

  /** Returns whichever renderer is currently active */
  private get activeRenderer(): D3GraphService | PixiGraphService {
    return this.state.rendererMode() === 'webgl' ? this.pixiGraph : this.d3Graph;
  }

  @ViewChild(GraphCanvasComponent) canvasComponent!: GraphCanvasComponent;
  @ViewChild(TooltipComponent) tooltipComponent!: TooltipComponent;
  @ViewChild(MinimapComponent) minimapComponent!: MinimapComponent;
  @ViewChild(ProcessPanelComponent) processPanelComponent!: ProcessPanelComponent;
  @ViewChild(DiffImpactPanelComponent) diffImpactPanelComponent!: DiffImpactPanelComponent;
  @ViewChild(GitHistoryPanelComponent) gitHistoryPanelComponent!: GitHistoryPanelComponent;

  readonly graphStats = signal<GraphStats | null>(null);
  private subs: Subscription[] = [];
  private autoExpandingRepos = new Set<string>();

  constructor() {
    // Auto-expand connected repos when depth traversal reaches cross-repo phantom nodes
    effect(() => {
      const neighborIds = this.state.focusNeighborIds();
      const focusMode = this.state.focusMode();
      if (!focusMode || neighborIds.size === 0) return;

      const unexpanded = this.state.getUnexpandedPhantomRepoIds();
      const toExpand = unexpanded.filter(id => !this.autoExpandingRepos.has(id));
      if (toExpand.length === 0) return;

      // Mark as expanding to avoid duplicate triggers
      toExpand.forEach(id => this.autoExpandingRepos.add(id));

      // Auto-expand in background, then recompute neighborhood
      this.autoExpandRepos(toExpand).then(() => {
        toExpand.forEach(id => this.autoExpandingRepos.delete(id));
      });
    });

    // Idle → screensaver
    effect(() => {
      const idle = this.idle.isIdle();
      if (idle && !this.screensaver.active()) {
        this.screensaver.start();
      } else if (!idle && this.screensaver.active()) {
        this.screensaver.stop();
      }
    });
  }

  ngOnInit(): void {
    this.idle.enable();
    this.loadGraphData();

    // Node click -> select + focus (from whichever renderer is active)
    this.subs.push(
      merge(this.d3Graph.nodeClicked$, this.pixiGraph.nodeClicked$).subscribe(({ node }) => {
        if (!node) {
          this.state.closeSidePanel();
          return;
        }
        this.state.selectNode(node.id);
        const compEdges = this.state.layoutMode() === 'components'
          ? this.activeRenderer.getRenderedEdgeData() : undefined;
        this.state.enterFocusMode(node.id, compEdges);
      }),
    );

    // Hover -> tooltip (from whichever renderer is active)
    this.subs.push(
      merge(this.d3Graph.nodeHovered$, this.pixiGraph.nodeHovered$).subscribe(({ node, event }) => {
        if (this.tooltipComponent) {
          let text: string;
          if (node._isHub) {
            text = `Connected Repo · ${node.properties?.['name']} · ${node.properties?.['edge_count']} edges`;
          } else if (node._isComponent) {
            text = `Component · ${node.properties?.['name']} · ${node.properties?.['summary']}`;
          } else {
            const label = node._isPhantom ? '↔ Cross-Repo' : node.label;
            const name = (node.properties?.['name'] as string) || (node.properties?.['path'] as string) || `node-${node.id}`;
            const repoTag = node._isExpandedRepo ? ` [${node._repoName}]` : '';
            text = `${label} · ${name}${repoTag}`;
          }
          this.tooltipComponent.show(text, event.clientX, event.clientY);
        }
      }),
    );

    this.subs.push(
      merge(this.d3Graph.nodeUnhovered$, this.pixiGraph.nodeUnhovered$).subscribe(() => {
        this.tooltipComponent?.hide();
      }),
    );
  }

  ngOnDestroy(): void {
    this.idle.disable();
    this.screensaver.stop();
    this.state.reset();
    this.subs.forEach(s => s.unsubscribe());
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.state.focusMode()) {
      this.state.exitFocusMode();
    } else if (this.state.sidePanelOpen()) {
      this.state.closeSidePanel();
    }
  }

  private async loadGraphData(): Promise<void> {
    const repoId = this.repo().id;
    this.state.repoId.set(repoId);
    this.state.loading.set(true);

    try {
      // Fetch stats and nodes in parallel
      const [stats, rawNodes] = await Promise.all([
        firstValueFrom(this.api.getGraphStats(repoId)),
        firstValueFrom(this.api.fetchAllNodes(repoId)),
      ]);

      this.graphStats.set(stats);

      const nodes: GraphNode[] = (rawNodes || []).map(n => ({
        id: n.id,
        label: n.label as GraphNode['label'],
        properties: n.properties,
      }));

      // Fetch edges via cypher
      const edgeResp = await firstValueFrom(
        this.api.postCypher(repoId, 'MATCH (a)-[r]->(b) RETURN r', [{ name: 'r' }])
      );
      const edges = (edgeResp?.rows || []).map((row: Record<string, unknown>) => {
        const r = row['r'] as Record<string, unknown>;
        return {
          source: r['start_id'] as string | number,
          target: r['end_id'] as string | number,
          rel: r['label'] as string,
        };
      });

      this.state.allNodes.set(nodes);
      this.state.allEdges.set(edges);

      // Load cross-repo data in background
      this.loadCrossRepoData(repoId, nodes);
    } catch (err) {
      console.error('Failed to load graph data:', err);
    } finally {
      this.state.loading.set(false);
    }
  }

  private async loadCrossRepoData(repoId: string, allNodes: GraphNode[]): Promise<void> {
    try {
      const result = await this.crossRepo.loadCrossRepoData(repoId, allNodes);
      if (result.phantomNodes.length || result.edges.length) {
        this.state.crossRepoNodes.set(result.phantomNodes);
        this.state.crossRepoEdges.set(result.edges);
        this.state.setShowCrossRepo(true);
        if (result.connectedRepos.length) {
          this.state.setConnectedRepos(result.connectedRepos);
        }
      }
    } catch (err) {
      console.warn('Failed to load cross-repo data:', err);
    }
  }

  onSearchNavigate(filePath: string): void {
    const nodes = this.state.allNodes();
    const fileNode = nodes.find(
      n => n.label === 'File' &&
        (n.properties?.['path'] === filePath ||
         n.properties?.['name'] === filePath.split('/').pop()),
    );
    if (fileNode) {
      this.state.selectNode(fileNode.id);
      this.activeRenderer.zoomToNode(fileNode.id);
    }
  }

  onToggleFlows(): void {
    if (this.processPanelComponent?.visible()) {
      this.processPanelComponent.close();
    } else {
      this.processPanelComponent?.show();
    }
  }

  onToggleDiffImpact(): void {
    if (this.diffImpactPanelComponent?.visible()) {
      this.diffImpactPanelComponent.close();
    } else {
      this.diffImpactPanelComponent?.show();
    }
  }

  onToggleGitHistory(): void {
    if (this.gitHistoryPanelComponent?.visible()) {
      this.gitHistoryPanelComponent.close();
    } else {
      this.gitHistoryPanelComponent?.show();
    }
  }

  onBack(): void {
    this.backToRepos.emit();
  }

  onNavigateToNode(nodeId: string | number): void {
    this.state.selectNode(nodeId);
    const compEdges = this.state.layoutMode() === 'components'
      ? this.activeRenderer.getRenderedEdgeData() : undefined;
    this.state.enterFocusMode(nodeId, compEdges);
    this.activeRenderer.zoomToNode(nodeId);
  }

  async onExpandRepo(repo: ConnectedRepo): Promise<void> {
    if (this.state.expandedRepos().has(repo.id)) return;
    const phantomNodes = this.state.crossRepoNodes();
    const colorIndex = this.state.connectedRepos().indexOf(repo);

    // Set loading state
    const loading = new Set(this.state.expandingRepoIds());
    loading.add(repo.id);
    this.state.expandingRepoIds.set(loading);

    try {
      const data = await this.crossRepo.loadExpandedRepoData(
        repo.id, repo.name, colorIndex >= 0 ? colorIndex : 0, phantomNodes,
      );
      this.state.expandRepo(data);
      // Fit graph so new nodes are visible
      setTimeout(() => this.activeRenderer.fitGraph(), 300);
    } catch (err) {
      console.warn('Failed to expand repo:', repo.name, err);
    } finally {
      const done = new Set(this.state.expandingRepoIds());
      done.delete(repo.id);
      this.state.expandingRepoIds.set(done);
    }
  }

  onCollapseRepo(repoId: string): void {
    this.state.collapseRepo(repoId);
  }

  async onExpandAllRepos(): Promise<void> {
    const connected = this.state.connectedRepos();
    const expanded = this.state.expandedRepos();
    const phantomNodes = this.state.crossRepoNodes();
    const toExpand = connected.filter(r => !expanded.has(r.id));

    // Set loading state for all
    const loading = new Set(this.state.expandingRepoIds());
    toExpand.forEach(r => loading.add(r.id));
    this.state.expandingRepoIds.set(loading);

    try {
      const results = await Promise.all(
        toExpand.map(repo => {
          const idx = connected.indexOf(repo);
          return this.crossRepo.loadExpandedRepoData(
            repo.id, repo.name, idx >= 0 ? idx : 0, phantomNodes,
          );
        }),
      );
      for (const data of results) {
        this.state.expandRepo(data);
      }
      // Fit graph so new nodes are visible
      setTimeout(() => this.activeRenderer.fitGraph(), 300);
    } catch (err) {
      console.warn('Failed to expand all repos:', err);
    } finally {
      const done = new Set(this.state.expandingRepoIds());
      toExpand.forEach(r => done.delete(r.id));
      this.state.expandingRepoIds.set(done);
    }
  }

  onCollapseAllRepos(): void {
    this.state.collapseAllRepos();
  }

  private async autoExpandRepos(repoIds: string[]): Promise<void> {
    const connected = this.state.connectedRepos();
    const phantomNodes = this.state.crossRepoNodes();

    for (const repoId of repoIds) {
      if (this.state.expandedRepos().has(repoId)) continue;
      const repo = connected.find(r => r.id === repoId);
      if (!repo) continue;

      const loading = new Set(this.state.expandingRepoIds());
      loading.add(repoId);
      this.state.expandingRepoIds.set(loading);

      try {
        const idx = connected.indexOf(repo);
        const data = await this.crossRepo.loadExpandedRepoData(
          repo.id, repo.name, idx >= 0 ? idx : 0, phantomNodes,
        );
        this.state.expandRepo(data);
      } catch (err) {
        console.warn('Auto-expand failed for repo:', repoId, err);
      } finally {
        const done = new Set(this.state.expandingRepoIds());
        done.delete(repoId);
        this.state.expandingRepoIds.set(done);
      }
    }

    // Recompute focus neighborhood now that expanded repo edges are available
    this.state.recomputeFocusNeighborhood();
  }

  onZoomIn(): void {
    this.activeRenderer.zoomIn();
  }

  onZoomOut(): void {
    this.activeRenderer.zoomOut();
  }

  onFitGraph(): void {
    this.activeRenderer.fitGraph();
  }
}
