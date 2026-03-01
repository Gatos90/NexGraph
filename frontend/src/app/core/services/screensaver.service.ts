import { Injectable, signal, inject, NgZone } from '@angular/core';
import * as d3 from 'd3';
import { firstValueFrom } from 'rxjs';
import { D3GraphService } from './d3-graph.service';
import { PixiGraphService } from './pixi-graph.service';
import { GraphStateService } from './graph-state.service';
import { ApiService } from './api.service';
import { GraphNode, GraphEdge } from '../models/graph.model';
import { NODE_COLORS, EDGE_COLORS, FOCUS_COLORS, REPO_COLORS, COMMUNITY_COLORS } from '../constants/colors';
import type { GitHistoryResponse, GitTimelineResponse, GitCommitEvent } from '../models/api.model';

export type ScreensaverMode = 'walk' | 'edgeFlow' | 'typeParade' | 'breathing' | 'gitGrowth';

/** '#rrggbb' → 0xRRGGBB */
function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', '').slice(0, 6), 16);
}

const MODE_LABELS: Record<ScreensaverMode, string> = {
  walk: 'Random Walk',
  edgeFlow: 'Edge Flow',
  typeParade: 'Type Parade',
  breathing: 'Breathing',
  gitGrowth: 'Git Growth',
};

interface SavedState {
  focusMode: boolean;
  focusNodeId: string | number | null;
  focusNeighborIds: Set<string | number>;
  focusDepth: number;
  communityOverlay: boolean;
  activeProcess: string | null;
  diffImpactActive: boolean;
  zoomTransform: d3.ZoomTransform | { x: number; y: number; k: number } | null;
  rendererMode: 'webgl' | 'svg';
}

/** Cancellable delay that resolves immediately on abort. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

@Injectable({ providedIn: 'root' })
export class ScreensaverService {
  private zone = inject(NgZone);
  private d3 = inject(D3GraphService);
  private pixi = inject(PixiGraphService);
  private state = inject(GraphStateService);
  private api = inject(ApiService);

  // Public state
  readonly active = signal(false);
  readonly currentMode = signal<ScreensaverMode | null>(null);
  readonly selectedMode = signal<ScreensaverMode | 'auto'>('auto');

  // Internal
  private savedState: SavedState | null = null;
  private abortController: AbortController | null = null;

  // WebGL screensaver tracking
  private pixiOverlayTexts: any[] = [];
  private pixiTickerFn: ((ticker: any) => void) | null = null;

  private isWebGL(): boolean {
    return this.state.rendererMode() === 'webgl';
  }

  get currentModeLabel(): string {
    const m = this.currentMode();
    return m ? MODE_LABELS[m] : '';
  }

  start(): void {
    if (this.active()) return;
    this.zone.runOutsideAngular(() => this.doStart());
  }

  stop(): void {
    if (!this.active()) return;

    // Abort all running animations
    this.abortController?.abort();
    this.abortController = null;

    // Kill transitions
    this.d3.interruptAll();
    this.pixi.interruptAll();

    // Stop tween engine
    this.pixi.ssStopTweenEngine();

    // Clean up any mode-specific DOM state
    this.cleanupCurrentMode();

    // Restore saved state
    if (this.savedState) {
      this.restoreState(this.savedState);
      this.savedState = null;
    }

    this.zone.run(() => {
      this.active.set(false);
      this.currentMode.set(null);
    });
  }

  private doStart(): void {
    // Save current state
    this.savedState = this.captureState();

    // Clear active overlays to start clean
    this.state.exitFocusMode();
    this.state.setActiveProcess(null);
    this.state.setDiffImpact(false);
    this.state.setCommunityOverlay(false);

    this.abortController = new AbortController();

    // Start tween engine for smooth WebGL animations
    if (this.isWebGL()) {
      this.pixi.ssStartTweenEngine();
    }

    this.zone.run(() => {
      this.active.set(true);
    });

    // Start mode rotation
    this.rotateLoop(this.abortController.signal);
  }

  private async rotateLoop(signal: AbortSignal): Promise<void> {
    const allModes: ScreensaverMode[] = ['walk', 'edgeFlow', 'typeParade', 'breathing', 'gitGrowth'];

    while (!signal.aborted) {
      const selected = this.selectedMode();

      if (selected !== 'auto') {
        // Single mode loop
        this.zone.run(() => this.currentMode.set(selected));
        await this.runMode(selected, signal);
        if (signal.aborted) return;
        this.cleanupCurrentMode();
        await delay(1500, signal);
      } else {
        // Auto-rotate: shuffle and cycle
        const shuffled = [...allModes].sort(() => Math.random() - 0.5);
        for (const mode of shuffled) {
          if (signal.aborted) return;
          this.zone.run(() => this.currentMode.set(mode));
          await this.runMode(mode, signal);
          if (signal.aborted) return;
          this.cleanupCurrentMode();
          await delay(1500, signal);
        }
      }
    }
  }

  private async runMode(mode: ScreensaverMode, parentSignal: AbortSignal): Promise<void> {
    // Create a child abort that fires on parent abort OR after mode duration
    const modeAbort = new AbortController();
    const modeDuration = mode === 'breathing' ? 35_000 : mode === 'gitGrowth' ? 60_000 : 30_000;
    const timeout = setTimeout(() => modeAbort.abort(), modeDuration);

    const onParentAbort = () => { clearTimeout(timeout); modeAbort.abort(); };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      switch (mode) {
        case 'walk': await this.runRandomWalk(modeAbort.signal); break;
        case 'edgeFlow': await this.runEdgeFlow(modeAbort.signal); break;
        case 'typeParade': await this.runTypeParade(modeAbort.signal); break;
        case 'breathing': await this.runBreathing(modeAbort.signal); break;
        case 'gitGrowth': await this.runGitGrowth(modeAbort.signal); break;
      }
    } catch {
      // swallowed — animation aborted
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  // ======================================================================
  // MODE A: Random Walk Explorer
  // ======================================================================

  private async runRandomWalk(signal: AbortSignal): Promise<void> {
    if (this.isWebGL()) { await this.runRandomWalkWebGL(signal); return; }

    const nodes = this.d3.getRenderedNodeData();
    if (nodes.length === 0) return;
    const edges = this.d3.getRenderedEdgeData();

    // Build adjacency for fast neighbor lookup
    const adj = new Map<string | number, Array<{ neighbor: string | number; rel: string }>>();
    for (const e of edges) {
      const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
      if (!adj.has(srcId)) adj.set(srcId, []);
      if (!adj.has(tgtId)) adj.set(tgtId, []);
      adj.get(srcId)!.push({ neighbor: tgtId, rel: e.rel });
      adj.get(tgtId)!.push({ neighbor: srcId, rel: e.rel });
    }

    // Prefer interesting nodes (Classes, RouteHandlers, Interfaces)
    const interesting = nodes.filter(n =>
      ['Class', 'Interface', 'RouteHandler', 'Struct'].includes(n.label as string),
    );
    const pool = interesting.length > 5 ? interesting : nodes.filter(n => !n._isPhantom && !n._isHub);

    const visited = new Set<string | number>();
    let current = pool[Math.floor(Math.random() * pool.length)];
    const svgGroup = this.d3.getSvgGroup();

    while (!signal.aborted) {
      visited.add(current.id);
      if (visited.size > 20) {
        const oldest = visited.values().next().value;
        if (oldest !== undefined) visited.delete(oldest);
      }

      // Zoom to node
      this.d3.zoomToNode(current.id);
      await delay(600, signal);
      if (signal.aborted) return;

      // Enter focus mode on this node
      const compEdges = this.state.layoutMode() === 'components'
        ? this.d3.getRenderedEdgeData() : undefined;
      this.state.enterFocusMode(current.id, compEdges);
      await delay(400, signal);
      if (signal.aborted) return;

      // Show floating label
      if (svgGroup) {
        const color = NODE_COLORS[current.label]?.fill || '#888';
        const name = this.getNodeName(current);
        svgGroup.selectAll('.nxg-walk-label').remove();
        svgGroup.append('text')
          .attr('class', 'nxg-walk-label')
          .attr('x', (current.x || 0))
          .attr('y', (current.y || 0) - 20)
          .attr('text-anchor', 'middle')
          .attr('fill', color)
          .attr('font-size', '14px')
          .text(`${current.label} · ${name}`);
        // Fade in via CSS
        requestAnimationFrame(() => {
          svgGroup.selectAll('.nxg-walk-label').classed('visible', true);
        });
      }

      // Hold
      await delay(3000, signal);
      if (signal.aborted) return;

      // Fade out label
      svgGroup?.selectAll('.nxg-walk-label').classed('visible', false);
      await delay(400, signal);
      if (signal.aborted) return;
      svgGroup?.selectAll('.nxg-walk-label').remove();

      // Exit focus
      this.state.exitFocusMode();
      await delay(300, signal);
      if (signal.aborted) return;

      // Pick next node via edge
      const neighbors = adj.get(current.id) || [];
      const unvisited = neighbors.filter(n => !visited.has(n.neighbor));
      const candidates = unvisited.length > 0 ? unvisited : neighbors;

      if (candidates.length > 0) {
        const nextId = candidates[Math.floor(Math.random() * candidates.length)].neighbor;
        const nextNode = nodes.find(n => n.id === nextId);
        if (nextNode) {
          current = nextNode;
          continue;
        }
      }

      // No edges — teleport to a random node
      const remaining = pool.filter(n => !visited.has(n.id));
      current = remaining.length > 0
        ? remaining[Math.floor(Math.random() * remaining.length)]
        : pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // ======================================================================
  // MODE B: Edge Flow
  // ======================================================================

  private async runEdgeFlow(signal: AbortSignal): Promise<void> {
    if (this.isWebGL()) { await this.runEdgeFlowWebGL(signal); return; }

    const svgGroup = this.d3.getSvgGroup();
    if (!svgGroup) return;

    const edgeTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'DEFINES', 'CONTAINS'];
    const activeTypes = new Set<string>();

    // Phase 1-N: add one edge type at a time
    svgGroup.classed('nxg-screensaver-flow', true);

    for (const type of edgeTypes) {
      if (signal.aborted) return;
      activeTypes.add(type);
      this.applyFlowClasses(svgGroup, activeTypes);
      await delay(4000, signal);
    }

    // Hold all flowing
    await delay(8000, signal);

    // Remove one at a time in reverse
    for (let i = edgeTypes.length - 1; i >= 0; i--) {
      if (signal.aborted) return;
      activeTypes.delete(edgeTypes[i]);
      this.applyFlowClasses(svgGroup, activeTypes);
      await delay(2000, signal);
    }
  }

  private applyFlowClasses(
    svgGroup: d3.Selection<SVGGElement, unknown, null, undefined>,
    activeTypes: Set<string>,
  ): void {
    svgGroup.selectAll<SVGLineElement, any>('.nxg-links line')
      .classed('flow-active', d => activeTypes.has(d.rel));
  }

  // ======================================================================
  // MODE C: Type Parade
  // ======================================================================

  private async runTypeParade(signal: AbortSignal): Promise<void> {
    if (this.isWebGL()) { await this.runTypeParadeWebGL(signal); return; }

    const svgGroup = this.d3.getSvgGroup();
    if (!svgGroup) return;
    const nodes = this.d3.getRenderedNodeData();
    if (!nodes.length) return;

    // Node types present in graph, ordered by count desc
    const typeCounts = new Map<string, number>();
    for (const n of nodes) {
      if (n._isPhantom || n._isHub || n._isComponent) continue;
      typeCounts.set(n.label, (typeCounts.get(n.label) || 0) + 1);
    }
    const types = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type]) => type);

    svgGroup.classed('nxg-screensaver-parade', true);

    // Fit graph first
    this.d3.fitGraph();
    await delay(800, signal);

    for (const type of types) {
      if (signal.aborted) return;

      const count = typeCounts.get(type) || 0;
      const color = NODE_COLORS[type]?.fill || '#888';

      // Highlight nodes of this type
      svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
        .classed('parade-highlight', d => d.label === type);

      // Highlight edges connected to these nodes
      const typeNodeIds = new Set(nodes.filter(n => n.label === type).map(n => n.id));
      svgGroup.selectAll<SVGLineElement, any>('.nxg-links line')
        .classed('parade-highlight', d => {
          const srcId = typeof d.source === 'object' ? d.source.id : d.source;
          const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
          return typeNodeIds.has(srcId) || typeNodeIds.has(tgtId);
        });

      // Show count overlay
      svgGroup.selectAll('.nxg-parade-count').remove();
      const svg = this.d3.getSvgGroup()?.node()?.ownerSVGElement;
      if (svg) {
        const w = svg.clientWidth;
        const h = svg.clientHeight;
        const transform = this.d3.getZoomTransform();
        // Position in screen coords by using inverse transform
        const cx = transform ? (w / 2 - transform.x) / transform.k : w / 2;
        const cy = transform ? (h * 0.85 - transform.y) / transform.k : h * 0.85;

        svgGroup.append('text')
          .attr('class', 'nxg-parade-count')
          .attr('x', cx)
          .attr('y', cy)
          .attr('text-anchor', 'middle')
          .attr('fill', color)
          .attr('font-size', `${40 / (transform?.k || 1)}px`);

        // Set text after append to ensure proper rendering
        svgGroup.select('.nxg-parade-count')
          .text(`${count} ${type}${count !== 1 ? 's' : ''}`);

        requestAnimationFrame(() => {
          svgGroup.selectAll('.nxg-parade-count').classed('visible', true);
        });
      }

      // Hold
      await delay(4000, signal);
      if (signal.aborted) return;

      // Fade out count
      svgGroup.selectAll('.nxg-parade-count').classed('visible', false);
      await delay(500, signal);
      svgGroup.selectAll('.nxg-parade-count').remove();

      // Clear highlights
      svgGroup.selectAll('.nxg-node-group').classed('parade-highlight', false);
      svgGroup.selectAll('.nxg-links line').classed('parade-highlight', false);
      await delay(300, signal);
    }
  }

  // ======================================================================
  // MODE D: Breathing Graph
  // ======================================================================

  private async runBreathing(signal: AbortSignal): Promise<void> {
    if (this.isWebGL()) { await this.runBreathingWebGL(signal); return; }

    const svgGroup = this.d3.getSvgGroup();
    if (!svgGroup) return;
    const nodes = this.d3.getRenderedNodeData();
    if (!nodes.length) return;

    // Compute centroid
    let sumX = 0, sumY = 0, count = 0;
    for (const n of nodes) {
      if (n.x != null && n.y != null) {
        sumX += n.x;
        sumY += n.y;
        count++;
      }
    }
    if (count === 0) return;
    const cx = sumX / count;
    const cy = sumY / count;

    // Compute max distance for delay normalization
    let maxDist = 0;
    for (const n of nodes) {
      if (n.x != null && n.y != null) {
        const dist = Math.hypot(n.x - cx, n.y - cy);
        if (dist > maxDist) maxDist = dist;
      }
    }
    if (maxDist === 0) maxDist = 1;

    // Performance: for large graphs, only animate a subset of nodes
    const maxAnimatedNodes = 800;
    const shouldSubset = nodes.length > maxAnimatedNodes;

    // Pick random subset if needed
    let animatedSet: Set<string | number> | null = null;
    if (shouldSubset) {
      const shuffled = [...nodes].sort(() => Math.random() - 0.5);
      animatedSet = new Set(shuffled.slice(0, maxAnimatedNodes).map(n => n.id));
    }

    // Set animation-delay based on distance from center
    svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
      .each(function (d: GraphNode) {
        const circle = d3.select(this).select('circle');
        if (circle.empty()) return;

        const isAnimated = !animatedSet || animatedSet.has(d.id);
        if (!isAnimated) return;

        const dist = Math.hypot((d.x || 0) - cx, (d.y || 0) - cy);
        const delayS = (dist / maxDist) * 2; // 0-2s delay for radial wave
        circle.classed('breathe-active', true)
          .style('animation-delay', `${delayS.toFixed(2)}s`);
      });

    svgGroup.classed('nxg-screensaver-breathing', true);

    // Fit graph to show the full breathing effect
    this.d3.fitGraph();

    // Color cycling: shift hue every 8 seconds
    let hueShift = 0;
    while (!signal.aborted) {
      await delay(8000, signal);
      if (signal.aborted) return;

      hueShift = (hueShift + 25) % 360;

      svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
        .select<SVGCircleElement>('circle')
        .transition().duration(3000)
        .attr('fill', (d: GraphNode) => {
          if (d._isPhantom) return 'transparent';
          const base = NODE_COLORS[d.label]?.fill || '#666';
          const hsl = d3.hsl(base);
          hsl.h = ((hsl.h || 0) + hueShift) % 360;
          return hsl.formatHex();
        });
    }
  }

  // ======================================================================
  // MODE E: Git Growth — replay commit history as the graph grows
  // ======================================================================

  private async runGitGrowth(signal: AbortSignal): Promise<void> {
    if (this.isWebGL()) { await this.runGitGrowthWebGL(signal); return; }

    const svgGroup = this.d3.getSvgGroup();
    if (!svgGroup) return;

    const repoId = this.state.repoId();
    if (!repoId) return;

    // Fetch git history data
    let gitData: GitHistoryResponse;
    try {
      gitData = await firstValueFrom(this.api.getGitHistory(repoId));
    } catch {
      // Git history not available — fall back to breathing
      await this.runBreathing(signal);
      return;
    }

    if (!gitData.files.length) {
      await this.runBreathing(signal);
      return;
    }

    const nodes = this.d3.getRenderedNodeData();
    if (!nodes.length) return;

    // Build path→nodeId map for File nodes
    const pathToNode = new Map<string, GraphNode>();
    for (const n of nodes) {
      if (n.label === 'File') {
        const path = (n.properties?.['path'] as string) || '';
        if (path) pathToNode.set(path, n);
      }
    }

    // Assign author colors
    const authorColors = new Map<string, string>();
    gitData.authors.forEach((a, i) => {
      authorColors.set(a.email, REPO_COLORS[i % REPO_COLORS.length]);
    });

    // Sort files by their earliest commit (first appearance)
    const filesWithDates = gitData.files
      .filter(f => pathToNode.has(f.file_path))
      .map(f => {
        // Find the earliest commit for this file
        const earliest = f.recent_commits.length > 0
          ? f.recent_commits[f.recent_commits.length - 1]
          : null;
        return {
          ...f,
          firstDate: earliest ? new Date(earliest.date).getTime() : new Date(f.last_commit_date).getTime(),
          firstAuthor: earliest?.email || f.last_author_email,
          firstMessage: earliest?.message || '',
        };
      })
      .sort((a, b) => a.firstDate - b.firstDate);

    if (!filesWithDates.length) {
      await this.runBreathing(signal);
      return;
    }

    // Group files into time-batches (commits close together)
    const batches: Array<{
      files: typeof filesWithDates;
      date: number;
      author: string;
      message: string;
    }> = [];

    let currentBatch = [filesWithDates[0]];
    for (let i = 1; i < filesWithDates.length; i++) {
      const prev = filesWithDates[i - 1];
      const curr = filesWithDates[i];
      // Group files within 5 seconds of each other (same commit)
      if (curr.firstDate - prev.firstDate < 5000) {
        currentBatch.push(curr);
      } else {
        batches.push({
          files: currentBatch,
          date: currentBatch[0].firstDate,
          author: currentBatch[0].firstAuthor,
          message: currentBatch[0].firstMessage,
        });
        currentBatch = [curr];
      }
    }
    batches.push({
      files: currentBatch,
      date: currentBatch[0].firstDate,
      author: currentBatch[0].firstAuthor,
      message: currentBatch[0].firstMessage,
    });

    // Cap display batches for animation timing
    const maxBatches = 40;
    const displayBatches = batches.length > maxBatches
      ? this.sampleBatches(batches, maxBatches)
      : batches;

    // Start: dim everything
    svgGroup.classed('nxg-screensaver-growth', true);

    svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
      .style('opacity', 0.03);
    svgGroup.selectAll('.nxg-links line')
      .style('opacity', 0.02);

    // Fit to see the whole graph
    this.d3.fitGraph();
    await delay(800, signal);
    if (signal.aborted) return;

    // Show commit counter
    const revealedNodes = new Set<string | number>();

    // Step through batches
    for (let i = 0; i < displayBatches.length; i++) {
      if (signal.aborted) return;
      const batch = displayBatches[i];
      const authorColor = authorColors.get(batch.author) || '#888';
      const authorName = gitData.authors.find(a => a.email === batch.author)?.name || batch.author;
      const dateStr = new Date(batch.date).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });

      // Reveal files in this batch
      for (const fileInfo of batch.files) {
        const node = pathToNode.get(fileInfo.file_path);
        if (!node) continue;
        revealedNodes.add(node.id);

        // Light up the node with author color
        svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
          .filter(d => d.id === node.id)
          .style('opacity', 1)
          .select('circle')
          .style('fill', authorColor)
          .style('filter', `drop-shadow(0 0 6px ${authorColor})`);
      }

      // Reveal edges connecting visible nodes
      svgGroup.selectAll<SVGLineElement, any>('.nxg-links line')
        .each(function (d: any) {
          const srcId = typeof d.source === 'object' ? d.source.id : d.source;
          const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
          if (revealedNodes.has(srcId) && revealedNodes.has(tgtId)) {
            d3.select(this).style('opacity', 0.3);
          }
        });

      // Show commit info label
      svgGroup.selectAll('.nxg-growth-label').remove();
      const svg = svgGroup.node()?.ownerSVGElement;
      if (svg) {
        const w = svg.clientWidth;
        const h = svg.clientHeight;
        const transform = this.d3.getZoomTransform();
        const labelX = transform ? (w / 2 - transform.x) / transform.k : w / 2;
        const labelY = transform ? (h * 0.92 - transform.y) / transform.k : h * 0.92;
        const fontSize = 14 / (transform?.k || 1);

        const labelG = svgGroup.append('g').attr('class', 'nxg-growth-label');

        // Author + date
        labelG.append('text')
          .attr('x', labelX)
          .attr('y', labelY)
          .attr('text-anchor', 'middle')
          .attr('fill', authorColor)
          .attr('font-size', `${fontSize}px`)
          .attr('font-family', "'JetBrains Mono', monospace")
          .attr('font-weight', '600')
          .text(`${authorName} · ${dateStr}`);

        // Commit message (truncated)
        if (batch.message) {
          const msg = batch.message.length > 50
            ? batch.message.slice(0, 47) + '...'
            : batch.message;
          labelG.append('text')
            .attr('x', labelX)
            .attr('y', labelY + fontSize * 1.4)
            .attr('text-anchor', 'middle')
            .attr('fill', 'rgba(255,255,255,0.5)')
            .attr('font-size', `${fontSize * 0.8}px`)
            .attr('font-family', "'DM Sans', sans-serif")
            .text(msg);
        }

        // Progress
        labelG.append('text')
          .attr('x', labelX)
          .attr('y', labelY - fontSize * 1.4)
          .attr('text-anchor', 'middle')
          .attr('fill', 'rgba(255,255,255,0.3)')
          .attr('font-size', `${fontSize * 0.7}px`)
          .attr('font-family', "'JetBrains Mono', monospace")
          .text(`${revealedNodes.size} / ${pathToNode.size} files`);

        requestAnimationFrame(() => {
          labelG.style('opacity', '0')
            .transition().duration(300)
            .style('opacity', '1');
        });
      }

      // Zoom toward the newly revealed nodes (if there are a few)
      if (batch.files.length <= 5) {
        const firstNode = pathToNode.get(batch.files[0].file_path);
        if (firstNode) {
          this.d3.zoomToNode(firstNode.id);
        }
      }

      // Pause between commits — faster near the end
      const holdTime = i < displayBatches.length * 0.3 ? 1200 :
                        i < displayBatches.length * 0.7 ? 800 : 500;
      await delay(holdTime, signal);
    }

    if (signal.aborted) return;

    // Final: reveal all remaining nodes gently
    svgGroup.selectAll('.nxg-growth-label').remove();
    svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
      .transition().duration(1500)
      .style('opacity', 1)
      .select('circle')
      .style('fill', (d: GraphNode) => NODE_COLORS[d.label]?.fill || '#666')
      .style('filter', null);

    svgGroup.selectAll('.nxg-links line')
      .transition().duration(1500)
      .style('opacity', null);

    this.d3.fitGraph();

    // Show final count
    if (svgGroup.node()?.ownerSVGElement) {
      const svg = svgGroup.node()!.ownerSVGElement!;
      const w = svg.clientWidth;
      const h = svg.clientHeight;
      const transform = this.d3.getZoomTransform();
      const cx = transform ? (w / 2 - transform.x) / transform.k : w / 2;
      const cy = transform ? (h / 2 - transform.y) / transform.k : h / 2;
      const fontSize = 24 / (transform?.k || 1);

      svgGroup.append('text')
        .attr('class', 'nxg-growth-label')
        .attr('x', cx)
        .attr('y', cy)
        .attr('text-anchor', 'middle')
        .attr('fill', '#4ade80')
        .attr('font-size', `${fontSize}px`)
        .attr('font-family', "'JetBrains Mono', monospace")
        .attr('font-weight', '700')
        .text(`${gitData.total_commits} commits · ${gitData.authors.length} authors · ${pathToNode.size} files`)
        .style('opacity', '0')
        .transition().duration(800)
        .style('opacity', '1');
    }

    await delay(5000, signal);
  }

  // ======================================================================
  // WebGL Mode Implementations
  // ======================================================================

  private async runRandomWalkWebGL(signal: AbortSignal): Promise<void> {
    const nodes = this.pixi.getRenderedNodeData();
    if (nodes.length === 0) return;
    const edges = this.pixi.getRenderedEdgeData();
    const screen = this.pixi.ssGetScreenSize();

    // Build adjacency
    const adj = new Map<string | number, Array<{ neighbor: string | number; rel: string }>>();
    for (const e of edges) {
      const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
      if (!adj.has(srcId)) adj.set(srcId, []);
      if (!adj.has(tgtId)) adj.set(tgtId, []);
      adj.get(srcId)!.push({ neighbor: tgtId, rel: e.rel });
      adj.get(tgtId)!.push({ neighbor: srcId, rel: e.rel });
    }

    const interesting = nodes.filter(n =>
      ['Class', 'Interface', 'RouteHandler', 'Struct'].includes(n.label as string),
    );
    const pool = interesting.length > 5 ? interesting : nodes.filter(n => !n._isPhantom && !n._isHub);

    const visited = new Set<string | number>();
    let current = pool[Math.floor(Math.random() * pool.length)];
    let currentLabel: any = null;
    let prevNodeId: string | number | null = null;

    while (!signal.aborted) {
      visited.add(current.id);
      if (visited.size > 20) {
        const oldest = visited.values().next().value;
        if (oldest !== undefined) visited.delete(oldest);
      }

      // Smooth animated camera glide to node
      this.pixi.ssAnimatedZoomToNode(current.id, 1.8, 1200);
      await delay(800, signal);
      if (signal.aborted) break;

      // Show glow halo on current node, hide previous
      if (prevNodeId != null) this.pixi.ssHideGlowHalo(prevNodeId);
      const color = NODE_COLORS[current.label]?.fill || '#888';
      this.pixi.ssShowGlowHalo(current.id, hexToNum(color), 3);

      await delay(300, signal);
      if (signal.aborted) break;

      // Fade out old label, create new screen-space label
      if (currentLabel) {
        const oldLabel = currentLabel;
        this.pixi.ssFadeText(oldLabel, 0, 300, () => this.pixi.ssDestroyScreenText(oldLabel));
      }
      const name = this.getNodeName(current);
      currentLabel = this.pixi.ssCreateScreenText(
        `${current.label}  ·  ${name}`,
        screen.w / 2, 36,
        { fontSize: 22, fill: hexToNum(color), fontWeight: '600', alpha: 0 },
      );
      this.pixi.ssFadeText(currentLabel, 0.9, 400);

      await delay(3000, signal);
      if (signal.aborted) break;

      // Fade out label
      if (currentLabel) {
        const lbl = currentLabel;
        this.pixi.ssFadeText(lbl, 0, 300, () => this.pixi.ssDestroyScreenText(lbl));
        currentLabel = null;
      }

      await delay(300, signal);
      if (signal.aborted) break;

      prevNodeId = current.id;

      // Pick next node
      const neighbors = adj.get(current.id) || [];
      const unvisited = neighbors.filter(n => !visited.has(n.neighbor));
      const candidates = unvisited.length > 0 ? unvisited : neighbors;

      if (candidates.length > 0) {
        const nextId = candidates[Math.floor(Math.random() * candidates.length)].neighbor;
        const nextNode = nodes.find(n => n.id === nextId);
        if (nextNode) { current = nextNode; continue; }
      }

      const remaining = pool.filter(n => !visited.has(n.id));
      current = remaining.length > 0
        ? remaining[Math.floor(Math.random() * remaining.length)]
        : pool[Math.floor(Math.random() * pool.length)];
    }

    // Cleanup
    if (currentLabel) this.pixi.ssDestroyScreenText(currentLabel);
    this.pixi.ssHideAllGlowHalos();
  }

  private async runEdgeFlowWebGL(signal: AbortSignal): Promise<void> {
    const edgeTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'DEFINES', 'CONTAINS'];
    const activeTypes = new Set<string>();
    const screen = this.pixi.ssGetScreenSize();

    // Smooth dim nodes to emphasize edges
    this.pixi.ssFadeAllNodesAlpha(0.35, 800);
    this.pixi.ssFadeEdgeLayerAlpha(0.3, 600);
    await delay(900, signal);
    if (signal.aborted) return;

    let typeLabel: any = null;

    // Phase: add one edge type at a time
    for (const type of edgeTypes) {
      if (signal.aborted) return;
      activeTypes.add(type);
      this.pixi.ssSetEdgeMode('byType', { activeTypes: new Set(activeTypes) });
      this.pixi.ssFadeEdgeLayerAlpha(1, 500);

      // Show type label at bottom-center
      if (typeLabel) {
        const old = typeLabel;
        this.pixi.ssFadeText(old, 0, 200, () => this.pixi.ssDestroyScreenText(old));
      }
      const edgeColor = EDGE_COLORS[type] || '#888';
      typeLabel = this.pixi.ssCreateScreenText(
        type, screen.w / 2, screen.h - 80,
        { fontSize: 28, fill: hexToNum(edgeColor), fontWeight: '700', alpha: 0 },
      );
      this.pixi.ssFadeText(typeLabel, 0.9, 400);

      await delay(4000, signal);
    }

    // Hold all flowing
    if (typeLabel) {
      const old = typeLabel;
      this.pixi.ssFadeText(old, 0, 300, () => this.pixi.ssDestroyScreenText(old));
      typeLabel = null;
    }
    await delay(8000, signal);

    // Remove one at a time in reverse
    for (let i = edgeTypes.length - 1; i >= 0; i--) {
      if (signal.aborted) return;
      activeTypes.delete(edgeTypes[i]);
      this.pixi.ssSetEdgeMode('byType', { activeTypes: new Set(activeTypes) });
      await delay(2000, signal);
    }

    // Smooth restore
    this.pixi.ssFadeAllNodesAlpha(1, 600);
    this.pixi.ssFadeEdgeLayerAlpha(1, 600);
    this.pixi.ssSetEdgeMode('default');
    if (typeLabel) this.pixi.ssDestroyScreenText(typeLabel);
  }

  private async runTypeParadeWebGL(signal: AbortSignal): Promise<void> {
    const nodes = this.pixi.getRenderedNodeData();
    if (!nodes.length) return;
    const screen = this.pixi.ssGetScreenSize();

    // Node types ordered by count desc
    const typeCounts = new Map<string, number>();
    for (const n of nodes) {
      if (n._isPhantom || n._isHub || n._isComponent) continue;
      typeCounts.set(n.label, (typeCounts.get(n.label) || 0) + 1);
    }
    const types = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type]) => type);

    this.pixi.fitGraph();
    await delay(800, signal);

    for (const type of types) {
      if (signal.aborted) return;

      const count = typeCounts.get(type) || 0;
      const color = NODE_COLORS[type]?.fill || '#888';
      const colorNum = hexToNum(color);

      // Smooth dim all nodes
      this.pixi.ssFadeAllNodesAlpha(0.08, 600);
      this.pixi.ssFadeEdgeLayerAlpha(0.1, 400);
      await delay(400, signal);
      if (signal.aborted) return;

      // Fade in type nodes + glow halos
      const typeNodeIds: (string | number)[] = [];
      for (const n of nodes) {
        if (n.label === type) {
          typeNodeIds.push(n.id);
          this.pixi.ssFadeNodeAlpha(n.id, 1, 500);
          this.pixi.ssShowGlowHalo(n.id, colorNum, 3);
        }
      }

      // Highlight edges connected to these nodes
      this.pixi.ssSetEdgeMode('typeHighlight', { highlightNodeIds: new Set(typeNodeIds) });
      this.pixi.ssFadeEdgeLayerAlpha(0.8, 400);

      // Screen-space type label at top center
      const overlayText = this.pixi.ssCreateScreenText(
        `${count}  ${type}${count !== 1 ? 's' : ''}`,
        screen.w / 2, 36,
        { fontSize: 32, fill: colorNum, fontWeight: '700', alpha: 0 },
      );
      this.pixi.ssFadeText(overlayText, 0.9, 400);

      await delay(3500, signal);
      if (signal.aborted) { this.pixi.ssDestroyScreenText(overlayText); return; }

      // Fade out label and halos
      this.pixi.ssFadeText(overlayText, 0, 300, () => this.pixi.ssDestroyScreenText(overlayText));
      this.pixi.ssHideAllGlowHalos();

      // Smooth restore before next type
      this.pixi.ssFadeAllNodesAlpha(1, 400);
      this.pixi.ssFadeEdgeLayerAlpha(1, 400);
      this.pixi.ssHideAllHalos();
      this.pixi.ssSetEdgeMode('default');
      await delay(500, signal);
    }
  }

  private async runBreathingWebGL(signal: AbortSignal): Promise<void> {
    const nodes = this.pixi.getRenderedNodeData();
    if (!nodes.length) return;

    // Compute centroid
    let sumX = 0, sumY = 0, count = 0;
    for (const n of nodes) {
      if (n.x != null && n.y != null) { sumX += n.x; sumY += n.y; count++; }
    }
    if (count === 0) return;
    const cx = sumX / count;
    const cy = sumY / count;

    let maxDist = 0;
    for (const n of nodes) {
      if (n.x != null && n.y != null) {
        const dist = Math.hypot(n.x - cx, n.y - cy);
        if (dist > maxDist) maxDist = dist;
      }
    }
    if (maxDist === 0) maxDist = 1;

    // Limit animated nodes for performance
    const maxAnimatedNodes = 800;
    const shouldSubset = nodes.length > maxAnimatedNodes;
    let animatedSet: Set<string | number> | null = null;
    if (shouldSubset) {
      const shuffled = [...nodes].sort(() => Math.random() - 0.5);
      animatedSet = new Set(shuffled.slice(0, maxAnimatedNodes).map(n => n.id));
    }

    // Build per-node phase offsets based on distance from centroid
    const phaseOffsets = new Map<string | number, number>();
    for (const n of nodes) {
      const isAnimated = !animatedSet || animatedSet.has(n.id);
      if (!isAnimated) continue;
      const dist = Math.hypot((n.x || 0) - cx, (n.y || 0) - cy);
      phaseOffsets.set(n.id, (dist / maxDist) * Math.PI * 2);
    }

    // Add glow halos on hub/component nodes
    for (const n of nodes) {
      if (n._isHub || n._isComponent) {
        const c = NODE_COLORS[n.label]?.fill || '#888';
        this.pixi.ssShowGlowHalo(n.id, hexToNum(c), 4);
      }
    }

    this.pixi.fitGraph();

    // Start ticker for scale oscillation + GPU hue rotation
    const startTime = Date.now();
    let currentHueDeg = 0;
    let lastHueStep = 0;

    this.pixiTickerFn = () => {
      const elapsed = (Date.now() - startTime) / 1000;

      // Scale breathing wave (smooth sine per node)
      for (const [id, phase] of phaseOffsets) {
        const s = 1 + 0.18 * Math.sin(elapsed * 1.2 + phase);
        this.pixi.ssSetNodeScale(id, s);
      }

      // GPU hue rotation every 8s — smooth tween over 2s instead of snap
      const hueStep = Math.floor(elapsed / 8);
      if (hueStep > lastHueStep) {
        lastHueStep = hueStep;
        const targetDeg = (currentHueDeg + 25) % 360;
        // Tween a proxy object and apply to filter each frame
        const proxy = { deg: currentHueDeg };
        this.pixi.ssTween(proxy, 'deg', currentHueDeg, targetDeg, 2000, undefined, undefined);
        // Use a secondary ticker to read the proxy and apply hue
        const hueApply = () => {
          this.pixi.ssSetNodeLayerHue(proxy.deg);
        };
        this.pixi.ssAddTicker(hueApply);
        // Remove after 2.1s
        setTimeout(() => {
          this.pixi.ssRemoveTicker(hueApply);
        }, 2100);
        currentHueDeg = targetDeg;
      }
    };

    this.pixi.ssAddTicker(this.pixiTickerFn);

    // Wait until signal aborts (breathing runs indefinitely until mode timer)
    while (!signal.aborted) {
      await delay(1000, signal);
    }

    // Cleanup handled by cleanupCurrentModeWebGL
  }

  // ─── Change-type colors for Gource-style visualization ───
  private readonly CHANGE_COLORS = {
    A: 0x4ade80, // green  — Added
    M: 0xf59e0b, // amber  — Modified
    D: 0xef4444, // red    — Deleted
    R: 0x60a5fa, // blue   — Renamed
  } as const;

  private async runGitGrowthWebGL(signal: AbortSignal): Promise<void> {
    const repoId = this.state.repoId();
    if (!repoId) return;

    // ── Phase A: Fetch commit timeline ──
    let timeline: GitTimelineResponse;
    try {
      timeline = await firstValueFrom(this.api.getGitTimeline(repoId));
    } catch {
      await this.runBreathingWebGL(signal);
      return;
    }

    if (!timeline.commits.length) {
      await this.runBreathingWebGL(signal);
      return;
    }

    const nodes = this.pixi.getRenderedNodeData();
    if (!nodes.length) return;

    // Build path→node map (File nodes only)
    const pathToNode = new Map<string, GraphNode>();
    for (const n of nodes) {
      if (n.label === 'File') {
        const path = (n.properties?.['path'] as string) || '';
        if (path) pathToNode.set(path, n);
      }
    }

    // Filter commits to only include files that have graph nodes
    const filteredCommits = timeline.commits
      .map(c => ({
        ...c,
        files: c.files.filter(f => pathToNode.has(f.path)),
      }))
      .filter(c => c.files.length > 0);

    if (!filteredCommits.length) {
      await this.runBreathingWebGL(signal);
      return;
    }

    // Assign author colors (use COMMUNITY_COLORS for 12-color variety)
    const authorEmails = [...new Set(filteredCommits.map(c => c.author_email))];
    const authorColorMap = new Map<string, string>();
    const authorNameMap = new Map<string, string>();
    for (const commit of filteredCommits) {
      if (!authorColorMap.has(commit.author_email)) {
        const idx = authorColorMap.size;
        authorColorMap.set(commit.author_email, COMMUNITY_COLORS[idx % COMMUNITY_COLORS.length]);
      }
      authorNameMap.set(commit.author_email, commit.author_name);
    }

    // Sample commits if too many (cap at 60 for smooth playback)
    const maxCommits = 60;
    const displayCommits = filteredCommits.length > maxCommits
      ? this.sampleBatches(filteredCommits, maxCommits)
      : filteredCommits;

    const screen = this.pixi.ssGetScreenSize();

    // ── Phase B: Initial state — everything hidden ──
    this.pixi.ssSetAllNodesAlpha(0);
    this.pixi.ssSetEdgeMode('dim');
    this.pixi.ssSetEdgeLayerAlpha(0);
    this.pixi.fitGraph();
    await delay(800, signal);
    if (signal.aborted) return;

    // ── Phase C: HUD setup ──
    const dateText = this.pixi.ssCreateScreenText(
      '', 80, 40,
      { fontSize: 28, fill: 0xffffff, fontWeight: '700', alpha: 0, anchorX: 0, anchorY: 0.5 },
    );
    const counterText = this.pixi.ssCreateScreenText(
      '0 files', screen.w - 80, screen.h - 40,
      { fontSize: 16, fill: 0x888888, fontWeight: '500', alpha: 0, anchorX: 1, anchorY: 0.5 },
    );
    const authorText = this.pixi.ssCreateScreenText(
      '', screen.w / 2, screen.h - 55,
      { fontSize: 22, fill: 0xffffff, fontWeight: '600', alpha: 0 },
    );
    const messageText = this.pixi.ssCreateScreenText(
      '', screen.w / 2, screen.h - 90,
      { fontSize: 14, fill: 0x666666, fontWeight: '400', alpha: 0 },
    );

    // Fade in HUD
    this.pixi.ssFadeText(dateText, 0.9, 400);
    this.pixi.ssFadeText(counterText, 0.7, 400);

    // ── Phase D: Commit replay loop ──
    const revealedNodeIds = new Set<string | number>();
    let lastAuthorEmail = '';
    let authorOrigin: { x: number; y: number } | null = null;

    for (let i = 0; i < displayCommits.length; i++) {
      if (signal.aborted) return;
      const commit = displayCommits[i];
      const authorColor = authorColorMap.get(commit.author_email) || '#888';
      const authorColorNum = hexToNum(authorColor);
      const authorName = authorNameMap.get(commit.author_email) || commit.author_name;

      // Update date
      const dateStr = new Date(commit.date).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      dateText.text = dateStr;

      // Update author label (fade transition on author change)
      if (commit.author_email !== lastAuthorEmail) {
        lastAuthorEmail = commit.author_email;
        authorText.style.fill = authorColorNum;
        authorText.text = authorName;
        authorText.alpha = 0;
        this.pixi.ssFadeText(authorText, 0.85, 200);
      }

      // Update commit message (truncated)
      const msg = commit.message.length > 60 ? commit.message.slice(0, 57) + '...' : commit.message;
      messageText.text = msg;
      messageText.alpha = 0;
      this.pixi.ssFadeText(messageText, 0.5, 200);

      // Compute author origin (average of recently-touched files, or graph center)
      const recentPositions: { x: number; y: number }[] = [];
      for (const f of commit.files) {
        const node = pathToNode.get(f.path);
        if (node) {
          const pos = this.pixi.ssGetNodeWorldPos(node.id);
          if (pos) recentPositions.push(pos);
        }
      }
      if (recentPositions.length > 0) {
        const avgX = recentPositions.reduce((s, p) => s + p.x, 0) / recentPositions.length;
        const avgY = recentPositions.reduce((s, p) => s + p.y, 0) / recentPositions.length;
        // Offset origin away from the cluster center for visual beam spread
        authorOrigin = { x: avgX - 150, y: avgY - 100 };
      } else if (!authorOrigin) {
        authorOrigin = { x: 0, y: 0 };
      }

      // Process each file in this commit
      const newNodeIds: (string | number)[] = [];
      for (const file of commit.files) {
        const node = pathToNode.get(file.path);
        if (!node) continue;

        const changeType = (file.change || 'M') as keyof typeof this.CHANGE_COLORS;
        const changeColor = this.CHANGE_COLORS[changeType] || this.CHANGE_COLORS.M;

        const isFirstAppearance = !revealedNodeIds.has(node.id);

        if (isFirstAppearance) {
          // First time this file appears — fade in from nothing
          revealedNodeIds.add(node.id);
          newNodeIds.push(node.id);
          this.pixi.ssFadeNodeAlpha(node.id, 1, 400);
          this.pixi.ssSetNodeTint(node.id, changeColor);
          this.pixi.ssShowGlowHalo(node.id, changeColor, 4);
        } else {
          // File already visible — pulse glow to show modification
          this.pixi.ssShowGlowHalo(node.id, changeColor, 3);
          this.pixi.ssSetNodeTint(node.id, changeColor);
          // Schedule glow removal after 800ms
          const nodeId = node.id;
          setTimeout(() => {
            if (!signal.aborted) this.pixi.ssHideGlowHalo(nodeId);
          }, 800);
        }

        // Draw beam from author origin to file
        const nodePos = this.pixi.ssGetNodeWorldPos(node.id);
        if (nodePos && authorOrigin) {
          this.pixi.ssDrawBeam(authorOrigin.x, authorOrigin.y, nodePos.x, nodePos.y, changeColor, 600);
        }
      }

      // Update file counter
      counterText.text = `${revealedNodeIds.size} / ${pathToNode.size} files`;

      // Progressively reveal edges between visible nodes
      this.pixi.ssSetEdgeMode('revealByNodes', { revealedNodeIds: new Set(revealedNodeIds) });
      // Gradually increase edge layer visibility as more nodes appear
      const edgeAlpha = Math.min(0.6, (revealedNodeIds.size / pathToNode.size) * 0.8);
      this.pixi.ssFadeEdgeLayerAlpha(edgeAlpha, 300);

      // Camera follow — zoom to first new file every 2 commits
      // Start zoomed in, gradually zoom out as graph fills
      if (i % 2 === 0 && newNodeIds.length > 0) {
        const progress = i / displayCommits.length;
        const zoomScale = 2.0 - progress * 1.4; // 2.0 → 0.6
        this.pixi.ssAnimatedZoomToNode(newNodeIds[0], Math.max(0.6, zoomScale), 1000);
      }

      // Adaptive timing: slow start, fast middle, rapid finale
      const progress = i / displayCommits.length;
      const holdTime = progress < 0.2 ? 1200 :
                       progress < 0.8 ? 600 : 400;
      await delay(holdTime, signal);
    }

    if (signal.aborted) return;

    // ── Phase E: Grand finale ──
    // Fade out commit message
    this.pixi.ssFadeText(messageText, 0, 200);
    this.pixi.ssFadeText(authorText, 0, 200);

    // Zoom out to show the whole graph
    this.pixi.fitGraph();
    await delay(800, signal);
    if (signal.aborted) return;

    // Flash ALL glow halos with golden color
    for (const [, node] of pathToNode) {
      if (revealedNodeIds.has(node.id)) {
        this.pixi.ssShowGlowHalo(node.id, 0xfbbf24, 3); // golden
      }
    }
    await delay(1500, signal);
    if (signal.aborted) return;
    this.pixi.ssHideAllGlowHalos();

    // Show summary
    const totalAuthors = authorEmails.length;
    const summaryText = this.pixi.ssCreateScreenText(
      `${timeline.commits.length} commits  ·  ${totalAuthors} authors  ·  ${pathToNode.size} files`,
      screen.w / 2, screen.h / 2,
      { fontSize: 32, fill: 0x4ade80, fontWeight: '700', alpha: 0 },
    );
    this.pixi.ssFadeText(summaryText, 0.9, 600);
    await delay(4000, signal);
    if (signal.aborted) return;

    this.pixi.ssFadeText(summaryText, 0, 500, () => this.pixi.ssDestroyScreenText(summaryText));

    // ── Phase F: Cleanup — restore everything ──
    // Fade out HUD
    this.pixi.ssFadeText(dateText, 0, 300, () => this.pixi.ssDestroyScreenText(dateText));
    this.pixi.ssFadeText(counterText, 0, 300, () => this.pixi.ssDestroyScreenText(counterText));

    this.pixi.ssRestoreAllNodeColors();
    this.pixi.ssFadeAllNodesAlpha(1, 800);
    this.pixi.ssHideAllGlowHalos();
    this.pixi.ssHideAllHalos();
    this.pixi.ssFadeEdgeLayerAlpha(1, 600);
    this.pixi.ssSetEdgeMode('default');
    this.pixi.fitGraph();

    await delay(600, signal);
  }

  /** Evenly sample N batches from a larger array, keeping first and last. */
  private sampleBatches<T>(arr: T[], n: number): T[] {
    if (arr.length <= n) return arr;
    const result: T[] = [arr[0]];
    const step = (arr.length - 1) / (n - 1);
    for (let i = 1; i < n - 1; i++) {
      result.push(arr[Math.round(i * step)]);
    }
    result.push(arr[arr.length - 1]);
    return result;
  }

  // ======================================================================
  // State management
  // ======================================================================

  private captureState(): SavedState {
    return {
      focusMode: this.state.focusMode(),
      focusNodeId: this.state.focusNodeId(),
      focusNeighborIds: new Set(this.state.focusNeighborIds()),
      focusDepth: this.state.focusDepth(),
      communityOverlay: this.state.communityOverlay(),
      activeProcess: this.state.activeProcess(),
      diffImpactActive: this.state.diffImpactActive(),
      zoomTransform: this.isWebGL() ? this.pixi.getZoomTransform() : this.d3.getZoomTransform(),
      rendererMode: this.state.rendererMode(),
    };
  }

  private restoreState(saved: SavedState): void {
    // Restore overlays
    if (saved.communityOverlay) this.state.setCommunityOverlay(true);
    if (saved.activeProcess) this.state.setActiveProcess(saved.activeProcess);
    if (saved.diffImpactActive) {
      this.state.setDiffImpact(true, this.state.diffDirectIds(), this.state.diffImpactedIds());
    }

    // Restore focus
    if (saved.focusMode && saved.focusNodeId != null) {
      this.state.focusNodeId.set(saved.focusNodeId);
      this.state.focusDepth.set(saved.focusDepth);
      this.state.focusNeighborIds.set(saved.focusNeighborIds);
      this.state.focusMode.set(true);
    }

    // Reset viewport to fit-to-screen (screensaver may have zoomed to arbitrary positions)
    if (this.isWebGL()) {
      this.pixi.fitGraph();
    } else {
      this.d3.fitGraph();
    }
  }

  private cleanupCurrentMode(): void {
    // Exit focus mode if walk mode was using it
    if (this.state.focusMode()) {
      this.state.exitFocusMode();
    }

    if (this.isWebGL()) {
      this.cleanupCurrentModeWebGL();
    } else {
      this.cleanupCurrentModeSVG();
    }
  }

  private cleanupCurrentModeSVG(): void {
    const svgGroup = this.d3.getSvgGroup();
    if (!svgGroup) return;

    // Remove all screensaver CSS classes
    svgGroup
      .classed('nxg-screensaver-flow', false)
      .classed('nxg-screensaver-parade', false)
      .classed('nxg-screensaver-breathing', false)
      .classed('nxg-screensaver-growth', false);

    // Remove mode-specific element classes
    svgGroup.selectAll('.nxg-links line')
      .classed('flow-active', false)
      .classed('parade-highlight', false)
      .attr('stroke-dasharray', null)
      .style('animation', null);

    svgGroup.selectAll('.nxg-node-group')
      .classed('parade-highlight', false);

    // Remove breathing animation-delay and restore colors
    svgGroup.selectAll('.nxg-node-group circle')
      .classed('breathe-active', false)
      .style('animation-delay', null)
      .interrupt(); // kill color-cycling transitions

    // Restore original fill colors after breathing hue shift
    svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
      .select<SVGCircleElement>('circle')
      .attr('fill', (d: GraphNode) => {
        if (d._isPhantom) return 'transparent';
        return NODE_COLORS[d.label]?.fill || '#666';
      });

    // Remove injected overlay elements
    svgGroup.selectAll('.nxg-walk-label').remove();
    svgGroup.selectAll('.nxg-parade-count').remove();
    svgGroup.selectAll('.nxg-growth-label').remove();

    // Restore node opacity/styles after git growth mode
    svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
      .style('opacity', null)
      .select('circle')
      .style('filter', null);
  }

  private cleanupCurrentModeWebGL(): void {
    // Remove ticker
    if (this.pixiTickerFn) {
      this.pixi.ssRemoveTicker(this.pixiTickerFn);
      this.pixiTickerFn = null;
    }

    // Destroy old-style overlay texts (viewport-space, backward compat)
    for (const t of this.pixiOverlayTexts) {
      this.pixi.ssDestroyTextOverlay(t);
    }
    this.pixiOverlayTexts = [];

    // Destroy all screen-space overlay texts
    this.pixi.ssDestroyAllScreenTexts();

    // Remove glow halos
    this.pixi.ssHideAllGlowHalos();

    // Remove GPU hue filter
    this.pixi.ssClearNodeLayerFilter();

    // Restore edge layer alpha
    this.pixi.ssResetEdgeLayerAlpha();

    // Restore all node visuals
    this.pixi.ssRestoreAllNodeColors();
    this.pixi.ssResetAllNodeScales();
    this.pixi.ssSetAllNodesAlpha(1);
    this.pixi.ssHideAllHalos();
    this.pixi.ssSetEdgeMode('default');
  }

  // ======================================================================
  // Utilities
  // ======================================================================

  private getNodeName(d: GraphNode): string {
    const p = d.properties;
    if (d.label === 'RouteHandler') {
      return `${p?.['http_method'] || '?'} ${p?.['url_pattern'] || p?.['name'] || ''}`;
    }
    return (p?.['name'] as string) || (p?.['path'] as string) || `node-${d.id}`;
  }
}
