import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  effect,
  signal,
  HostListener,
  ChangeDetectionStrategy,
  ViewEncapsulation,
} from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { D3GraphService } from '../../../core/services/d3-graph.service';
import { PixiGraphService } from '../../../core/services/pixi-graph.service';
import { ComponentDataService } from '../../../core/services/component-data.service';
import { LayoutService } from '../../../core/services/layout.service';

@Component({
  selector: 'app-graph-canvas',
  standalone: true,
  template: `
    <div class="graph-canvas" #graphContainer>
      <svg #graphSvg [style.display]="state.rendererMode() === 'svg' ? 'block' : 'none'"></svg>
      <div #pixiContainer
           [style.display]="state.rendererMode() === 'webgl' ? 'block' : 'none'"
           style="width:100%;height:100%;position:absolute;top:0;left:0"></div>
    </div>
  `,
  styleUrl: './graph-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class GraphCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('graphContainer', { static: true }) containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('graphSvg', { static: true }) svgRef!: ElementRef<SVGSVGElement>;
  @ViewChild('pixiContainer', { static: true }) pixiRef!: ElementRef<HTMLDivElement>;

  state = inject(GraphStateService);
  private d3 = inject(D3GraphService);
  private pixi = inject(PixiGraphService);
  private componentData = inject(ComponentDataService);
  private layout = inject(LayoutService);
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = signal(false);
  private pixiInitialized = false;

  /** Returns the active renderer service */
  private get renderer(): D3GraphService | PixiGraphService {
    return this.state.rendererMode() === 'webgl' ? this.pixi : this.d3;
  }

  constructor() {
    // Rebuild graph when data, layout, or filters change
    effect(() => {
      if (!this.initialized()) return;

      const mode = this.state.rendererMode();
      const nodes = this.state.allNodes();
      const layoutMode = this.state.layoutMode();
      // Track filter signals to trigger recompute
      this.state.activeNodeFilters();
      this.state.activeEdgeFilters();
      this.state.showCrossRepo();
      this.state.minConfidence();
      this.state.crossRepoNodes();
      this.state.crossRepoEdges();
      this.state.expandedRepos();

      if (!nodes.length) return;

      let data = this.state.filteredData();
      let positions: Record<string, { x: number; y: number }> | undefined;

      if (layoutMode === 'components') {
        data = this.componentData.buildComponentData(
          data,
          this.state.crossRepoNodes(),
          this.state.crossRepoEdges(),
          this.state.showCrossRepo(),
        );
      }

      if (layoutMode === 'flow' || layoutMode === 'components') {
        positions = this.layout.computeFlowLayout(data.nodes, data.edges);
      }

      const el = this.containerRef.nativeElement;
      const dims = { width: el.clientWidth, height: el.clientHeight };

      if (mode === 'webgl') {
        this.pixi.buildGraph(data, layoutMode, dims, positions);
      } else {
        this.d3.buildGraph(data, layoutMode, dims, positions);
      }
    });

    // Watch focus changes and apply
    effect(() => {
      if (!this.initialized()) return;
      const mode = this.state.rendererMode();
      const focusMode = this.state.focusMode();
      const focusNodeId = this.state.focusNodeId();
      const neighborIds = this.state.focusNeighborIds();
      if (mode === 'webgl') {
        this.pixi.applyFocus(focusNodeId, neighborIds, focusMode);
      } else {
        this.d3.applyFocus(focusNodeId, neighborIds, focusMode);
      }
    });

    // Watch community overlay changes and apply
    effect(() => {
      if (!this.initialized()) return;
      const mode = this.state.rendererMode();
      const enabled = this.state.communityOverlay();
      const communityMap = this.state.communityMap();
      const communityColors = this.state.communityColors();
      const activeCommunityId = this.state.activeCommunityId();
      if (mode === 'webgl') {
        this.pixi.applyCommunityOverlay(enabled, communityMap, communityColors, activeCommunityId);
      } else {
        this.d3.applyCommunityOverlay(enabled, communityMap, communityColors, activeCommunityId);
      }
    });

    // Watch process overlay changes and apply
    effect(() => {
      if (!this.initialized()) return;
      const mode = this.state.rendererMode();
      const activeProcess = this.state.activeProcess();
      const stepIds = this.state.processStepIds();
      if (mode === 'webgl') {
        this.pixi.highlightProcess(activeProcess, stepIds);
      } else {
        this.d3.highlightProcess(activeProcess, stepIds);
      }
    });

    // Watch diff impact overlay changes and apply
    effect(() => {
      if (!this.initialized()) return;
      const mode = this.state.rendererMode();
      const active = this.state.diffImpactActive();
      const directIds = this.state.diffDirectIds();
      const impactedIds = this.state.diffImpactedIds();
      if (mode === 'webgl') {
        this.pixi.highlightDiffImpact(active, directIds, impactedIds);
      } else {
        this.d3.highlightDiffImpact(active, directIds, impactedIds);
      }
    });

    // Watch git overlay changes and apply
    effect(() => {
      if (!this.initialized()) return;
      const mode = this.state.rendererMode();
      const gitMode = this.state.gitOverlayMode();
      const fileData = this.state.gitFileData();
      const authorColors = this.state.gitAuthorColors();
      if (mode === 'webgl') {
        this.pixi.applyGitOverlay(gitMode, fileData, authorColors);
      } else {
        this.d3.applyGitOverlay(gitMode, fileData, authorColors);
      }
    });
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.state.rendererMode() === 'webgl') {
        this.pixi.fitGraph();
      } else {
        this.d3.fitGraph();
      }
    }, 300);
  }

  async ngAfterViewInit(): Promise<void> {
    // Initialize D3 (SVG) renderer
    this.d3.initialize(this.svgRef.nativeElement);

    // Initialize PixiJS (WebGL) renderer
    await this.pixi.initialize(this.pixiRef.nativeElement);
    this.pixiInitialized = true;

    this.initialized.set(true);
  }

  ngOnDestroy(): void {
    this.d3.destroy();
    this.pixi.destroy();
  }
}
