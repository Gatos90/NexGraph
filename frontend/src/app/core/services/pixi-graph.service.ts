import { Injectable, NgZone, inject } from '@angular/core';
import { Subject } from 'rxjs';
import * as d3 from 'd3';
import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  Circle as PixiCircle,
  Texture,
  Sprite,
  Ticker,
  RenderTexture,
  ColorMatrixFilter,
} from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { GraphNode, GraphEdge, FilteredGraphData, LayoutMode } from '../models/graph.model';
import { NODE_COLORS, EDGE_COLORS, NODE_SIZES, FOCUS_COLORS, REPO_COLORS } from '../constants/colors';
import type { GitFileInfo, GitOverlayMode } from '../models/api.model';

export interface NodeEvent {
  node: GraphNode;
  event: MouseEvent | PointerEvent | any;
}

/** Hex color string '#rrggbb' → 0xRRGGBB number */
function hexToNum(hex: string): number {
  const h = hex.replace('#', '').slice(0, 6);
  return parseInt(h, 16);
}

/** Interpolate between two hex colors, t in [0,1] */
function lerpColor(a: string, b: string, t: number): number {
  const c = d3.interpolateRgb(a, b)(t);
  // d3 returns "rgb(r, g, b)"
  const m = c.match(/\d+/g);
  if (!m) return 0x888888;
  return (parseInt(m[0]) << 16) | (parseInt(m[1]) << 8) | parseInt(m[2]);
}

// ---- Easing functions ----
function easeOutCubic(t: number): number { return 1 - (1 - t) ** 3; }
function easeInOutSine(t: number): number { return -(Math.cos(Math.PI * t) - 1) / 2; }
function linear(t: number): number { return t; }

/** Lightweight tween descriptor */
interface SSTween {
  target: any;
  prop: string;
  from: number;
  to: number;
  duration: number;   // ms
  elapsed: number;
  ease: (t: number) => number;
  onComplete?: () => void;
}

// Node graphics structure stored per-node
interface NodeGfx {
  container: Container;
  shape: Graphics | Sprite;
  halo: Graphics;
  label: Text | null;
  repoRing: Graphics | null;
  baseRadius: number;
  originalFill: number;
  originalStroke: number;
  isCircle: boolean;
  isPhantom: boolean;
  glowSprite: Sprite | null;
}

@Injectable({ providedIn: 'root' })
export class PixiGraphService {
  private zone = inject(NgZone);

  // Event subjects (same interface as D3GraphService)
  readonly nodeClicked$ = new Subject<NodeEvent>();
  readonly nodeHovered$ = new Subject<NodeEvent>();
  readonly nodeUnhovered$ = new Subject<void>();

  private app: Application | null = null;
  private viewport: Viewport | null = null;
  private containerEl: HTMLElement | null = null;

  // Scene layers
  private edgeLayer = new Container();
  private nodeLayer = new Container();
  private labelLayer = new Container();

  // Edge graphics — single Graphics object for all edges (one draw call)
  private edgeGfx = new Graphics();

  // Arrow graphics — single Graphics for all arrow markers
  private arrowGfx = new Graphics();

  // Data mappings
  private nodeGfxMap = new Map<string | number, NodeGfx>();
  private nodeById = new Map<string | number, GraphNode>();
  private nodes: GraphNode[] = [];
  private edges: { source: string | number; target: string | number; rel: string; _isCrossRepo: boolean; _isHubLink: boolean; _isExpandedRepoEdge: boolean; _confidence?: number }[] = [];

  // Simulation (main thread or worker)
  private simulation: d3.Simulation<GraphNode, GraphEdge> | null = null;
  private worker: Worker | null = null;
  private nodeIndexMap = new Map<string | number, number>(); // id → array index for worker
  private isInitialBuild = true;
  private lastLayoutMode: LayoutMode | null = null;

  /** Threshold: use Web Worker for graphs with this many nodes or more */
  private static readonly WORKER_THRESHOLD = 300;

  // Minimap
  private minimapCanvas: HTMLCanvasElement | null = null;
  private minimapCtx: CanvasRenderingContext2D | null = null;
  private minimapTimer: ReturnType<typeof setTimeout> | null = null;

  // Simulation state for edge redraw throttling
  private simulationActive = false;
  private edgeTickCounter = 0;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  // Screensaver infrastructure
  private overlayLayer = new Container();
  private glowTexture: Texture | null = null;
  private ssTweens: SSTween[] = [];
  private ssTweenTickerBound: ((ticker: Ticker) => void) | null = null;
  private ssHueFilter: ColorMatrixFilter | null = null;

  // Label style (shared)
  private labelStyle = new TextStyle({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 8,
    fontWeight: '400',
    fill: 0x888888,
  });

  async initialize(container: HTMLElement): Promise<void> {
    this.containerEl = container;

    this.app = new Application();
    await this.app.init({
      background: 0x000000,
      backgroundAlpha: 0,
      resizeTo: container,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    // Append canvas to container
    container.appendChild(this.app.canvas);
    // Style the canvas to fill
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = '100%';
    this.app.canvas.style.display = 'block';

    // Create viewport
    this.viewport = new Viewport({
      screenWidth: container.clientWidth,
      screenHeight: container.clientHeight,
      events: this.app.renderer.events,
    });
    this.app.stage.addChild(this.viewport);
    this.app.stage.addChild(this.overlayLayer); // Screen-space overlay (above viewport)
    this.viewport
      .drag()
      .pinch()
      .wheel()
      .decelerate()
      .clampZoom({ minScale: 0.1, maxScale: 5 });

    // Add layers in order (edges behind nodes)
    this.viewport.addChild(this.edgeLayer);
    this.viewport.addChild(this.nodeLayer);
    this.viewport.addChild(this.labelLayer);

    // Edge graphics in edge layer
    this.edgeLayer.addChild(this.edgeGfx);
    this.edgeLayer.addChild(this.arrowGfx);

    // LOD: 3-tier label visibility based on zoom level
    this.viewport.on('zoomed', () => {
      const scale = this.viewport!.scale.x;
      if (scale < 0.3) {
        // Far zoom: hide all labels
        this.labelLayer.visible = false;
      } else if (scale < 0.7) {
        // Mid zoom: show only important labels (Folder, Class, Interface, Hub, Component)
        this.labelLayer.visible = true;
        for (const [id, gfx] of this.nodeGfxMap) {
          if (gfx.label) {
            const node = this.nodeById.get(id);
            gfx.label.visible = !!node && (
              node.label === 'Folder' || node.label === 'Class' ||
              node.label === 'Interface' || !!node._isHub || !!node._isComponent
            );
          }
        }
      } else {
        // Close zoom: show all labels
        this.labelLayer.visible = true;
        for (const [, gfx] of this.nodeGfxMap) {
          if (gfx.label) gfx.label.visible = true;
        }
      }
    });

    // Hide edges during pan/zoom for smooth interaction
    this.viewport.on('moved', () => {
      if (this.simulationActive) return; // Don't hide during simulation — handled by tick throttle
      this.edgeLayer.visible = false;
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        this.edgeLayer.visible = true;
      }, 150);
    });

    // Background click to deselect
    this.viewport.on('pointerup', (e: any) => {
      if (e.target === this.viewport) {
        this.zone.run(() => {
          this.nodeClicked$.next({ node: null as any, event: e });
        });
      }
    });
  }

  setMinimapElement(el: SVGSVGElement | HTMLCanvasElement | null): void {
    if (el instanceof HTMLCanvasElement) {
      this.minimapCanvas = el;
      this.minimapCtx = el.getContext('2d');
    } else if (el) {
      // For backward compatibility with SVG minimap element, create an offscreen canvas
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      this.minimapCanvas = canvas;
      this.minimapCtx = canvas.getContext('2d');
    } else {
      this.minimapCanvas = null;
      this.minimapCtx = null;
    }
  }

  buildGraph(
    data: FilteredGraphData,
    layoutMode: LayoutMode,
    dimensions: { width: number; height: number },
    positions?: Record<string, { x: number; y: number }>,
  ): void {
    if (!this.viewport || !this.app) return;
    const { width, height } = dimensions;

    this.zone.runOutsideAngular(() => {
      const layoutChanged = this.lastLayoutMode !== null && this.lastLayoutMode !== layoutMode;
      const shouldFit = this.isInitialBuild || layoutChanged;

      // Clean previous
      this.clearGraph();

      const { nodes, edges } = data;
      this.nodes = nodes;
      this.nodeById = new Map(nodes.map(n => [n.id, n]));
      const nodeById = this.nodeById;

      // Validate edges
      this.edges = edges.filter(e => {
        const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
        const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
        return nodeById.has(srcId) && nodeById.has(tgtId);
      }).map(e => ({
        source: typeof e.source === 'object' ? (e.source as GraphNode).id : e.source,
        target: typeof e.target === 'object' ? (e.target as GraphNode).id : e.target,
        rel: e.rel,
        _isCrossRepo: e._isCrossRepo || false,
        _isHubLink: e._isHubLink || false,
        _isExpandedRepoEdge: e._isExpandedRepoEdge || false,
        _confidence: e._confidence,
      }));

      // Create node graphics
      for (const node of nodes) {
        const gfx = this.createNodeGfx(node);
        this.nodeGfxMap.set(node.id, gfx);
        this.nodeLayer.addChild(gfx.container);
        if (gfx.label) this.labelLayer.addChild(gfx.label);
      }

      const tickSkip = nodes.length > 5000 ? 3 : (nodes.length > 1000 ? 2 : 1);
      const alphaDecay = nodes.length > 5000 ? 0.04 : 0.0228;

      // Flow / Components layout: apply dagre positions (no simulation needed)
      if ((layoutMode === 'flow' || layoutMode === 'components') && positions) {
        nodes.forEach(n => {
          const pos = positions[String(n.id)];
          if (pos) {
            n.x = n.fx = pos.x;
            n.y = n.fy = pos.y;
          }
        });
        this.updatePositions();
        setTimeout(() => {
          if (shouldFit) this.fitGraph();
          this.updateMinimap();
        }, 50);
      } else if (nodes.length >= PixiGraphService.WORKER_THRESHOLD) {
        // --- Off-thread simulation via Web Worker ---
        this.startWorkerSimulation(nodes, this.edges, width, height, tickSkip, alphaDecay, shouldFit);
      } else {
        // --- Main-thread simulation for small graphs ---
        this.startMainThreadSimulation(nodes, this.edges, width, height, tickSkip, alphaDecay, shouldFit);
      }

      this.isInitialBuild = false;
      this.lastLayoutMode = layoutMode;
    });
  }

  // --- Overlay methods ---

  applyFocus(
    focusNodeId: string | number | null,
    neighborIds: Set<string | number>,
    focusMode: boolean,
  ): void {
    if (!this.app || !this.viewport) return;

    this.zone.runOutsideAngular(() => {
      if (!focusMode || !focusNodeId) {
        // Restore all nodes
        for (const [, gfx] of this.nodeGfxMap) {
          gfx.container.alpha = 1;
        }
        this.drawEdges(); // Restore default edge colors
        return;
      }

      // Dim non-neighbor nodes
      for (const [id, gfx] of this.nodeGfxMap) {
        gfx.container.alpha = neighborIds.has(id) ? 1.0 : 0.06;
      }

      // Redraw edges with focus styling
      this.drawEdges(focusNodeId, neighborIds);
    });
  }

  applyCommunityOverlay(
    enabled: boolean,
    communityMap: Map<string | number, string>,
    communityColors: Map<string, string>,
    activeCommunityId: string | null,
  ): void {
    if (!this.app || !this.viewport) return;

    this.zone.runOutsideAngular(() => {
      for (const [id, gfx] of this.nodeGfxMap) {
        if (!enabled) {
          gfx.container.alpha = 1;
          gfx.halo.visible = false;
          continue;
        }

        const communityId = communityMap.get(id);
        const color = communityId ? communityColors.get(communityId) : undefined;

        if (activeCommunityId) {
          if (communityId === activeCommunityId && color) {
            gfx.container.alpha = 1;
            this.showHalo(gfx, hexToNum(color), 0.6, 3);
          } else {
            gfx.container.alpha = 0.15;
            gfx.halo.visible = false;
          }
        } else {
          if (color) {
            gfx.container.alpha = 1;
            this.showHalo(gfx, hexToNum(color), 0.5, 2.5);
          } else {
            gfx.container.alpha = 0.15;
            gfx.halo.visible = false;
          }
        }
      }
    });
  }

  highlightProcess(
    processId: string | null,
    stepIds: (string | number)[],
  ): void {
    if (!this.app || !this.viewport) return;

    this.zone.runOutsideAngular(() => {
      if (!processId || stepIds.length === 0) {
        for (const [, gfx] of this.nodeGfxMap) {
          gfx.container.alpha = 1;
          gfx.halo.visible = false;
        }
        this.drawEdges();
        return;
      }

      const stepSet = new Set(stepIds.map(String));
      const stepOrder = new Map<string, number>();
      stepIds.forEach((id, i) => stepOrder.set(String(id), i));
      const totalSteps = stepIds.length;

      for (const [id, gfx] of this.nodeGfxMap) {
        const nodeIdStr = String(id);
        if (stepSet.has(nodeIdStr)) {
          const idx = stepOrder.get(nodeIdStr) ?? 0;
          const t = totalSteps > 1 ? idx / (totalSteps - 1) : 0;
          const color = lerpColor('#22c55e', '#3b82f6', t);
          gfx.container.alpha = 1;
          this.showHalo(gfx, color, 0.7, 3);
        } else {
          gfx.container.alpha = 0.06;
          gfx.halo.visible = false;
        }
      }

      // Dim edges not between steps
      this.drawEdgesProcessMode(stepSet);
    });
  }

  highlightDiffImpact(
    active: boolean,
    directIds: Set<string | number>,
    impactedIds: Set<string | number>,
  ): void {
    if (!this.app || !this.viewport) return;

    this.zone.runOutsideAngular(() => {
      if (!active || (directIds.size === 0 && impactedIds.size === 0)) {
        for (const [, gfx] of this.nodeGfxMap) {
          gfx.container.alpha = 1;
          gfx.halo.visible = false;
        }
        this.drawEdges();
        return;
      }

      const directSet = new Set([...directIds].map(String));
      const impactedSet = new Set([...impactedIds].map(String));

      for (const [id, gfx] of this.nodeGfxMap) {
        const nodeIdStr = String(id);
        const isDirect = directSet.has(nodeIdStr);
        const isImpacted = impactedSet.has(nodeIdStr);

        if (isDirect || isImpacted) {
          const color = isDirect ? 0xef4444 : 0xf97316;
          gfx.container.alpha = 1;
          this.showHalo(gfx, color, 0.8, 3);
        } else {
          gfx.container.alpha = 0.08;
          gfx.halo.visible = false;
        }
      }

      // Dim edges not between affected nodes
      this.drawEdgesDiffMode(directSet, impactedSet);
    });
  }

  applyGitOverlay(
    mode: GitOverlayMode,
    fileData: Map<string, GitFileInfo>,
    authorColors: Map<string, string>,
  ): void {
    if (!this.app || !this.viewport) return;

    this.zone.runOutsideAngular(() => {
      if (mode === 'none' || fileData.size === 0) {
        for (const [, gfx] of this.nodeGfxMap) {
          gfx.container.alpha = 1;
          gfx.halo.visible = false;
          // Restore original shape tint
          if (gfx.shape instanceof Sprite) {
            gfx.shape.tint = 0xffffff;
          }
        }
        this.drawEdges();
        return;
      }

      const now = Date.now();

      for (const [id, gfx] of this.nodeGfxMap) {
        const node = this.nodeById.get(id);
        if (!node || node.label !== 'File') {
          gfx.container.alpha = 0.1;
          gfx.halo.visible = false;
          continue;
        }

        const filePath = (node.properties?.['path'] as string) || '';
        const info = fileData.get(filePath);

        if (!info) {
          gfx.container.alpha = 0.1;
          gfx.halo.visible = false;
          continue;
        }

        gfx.container.alpha = 1;

        if (mode === 'freshness') {
          const daysSince = (now - new Date(info.last_commit_date).getTime()) / 86400000;
          let color: number;
          if (daysSince < 7) color = 0x22c55e;
          else if (daysSince < 30) color = 0xeab308;
          else if (daysSince < 90) color = 0xf97316;
          else color = 0xef4444;

          if (gfx.shape instanceof Sprite) gfx.shape.tint = color;
          this.showHalo(gfx, color, 0.6, 2);
        } else if (mode === 'hotspots') {
          const intensity = Math.min(info.commit_count / 30, 1);
          const color = lerpColor('#3b82f6', '#ef4444', intensity);
          const scaledR = gfx.baseRadius + Math.min(Math.log2(info.commit_count + 1) * 2, 12);
          const scaleRatio = scaledR / gfx.baseRadius;

          if (gfx.shape instanceof Sprite) gfx.shape.tint = color;
          gfx.shape.scale.set(scaleRatio);
          this.showHalo(gfx, color, 0.5 + intensity * 0.3, 2 + intensity * 2);
        } else if (mode === 'authors') {
          const authorColor = authorColors.get(info.last_author_email) || '#888888';
          const cn = hexToNum(authorColor);

          if (gfx.shape instanceof Sprite) gfx.shape.tint = cn;
          this.showHalo(gfx, cn, 0.6, 2);
        }
      }

      // Dim edges — single batch stroke
      this.edgeGfx.clear();
      this.arrowGfx.clear();
      for (const edge of this.edges) {
        const srcNode = this.nodeById.get(edge.source);
        const tgtNode = this.nodeById.get(edge.target);
        if (!srcNode || !tgtNode || srcNode.x == null || tgtNode.x == null) continue;
        this.edgeGfx.moveTo(srcNode.x!, srcNode.y!);
        this.edgeGfx.lineTo(tgtNode.x!, tgtNode.y!);
      }
      this.edgeGfx.stroke({ width: 0.5, color: 0x333333, alpha: 0.08 });
    });
  }

  // --- Navigation ---

  fitGraph(): void {
    if (!this.viewport || !this.nodes.length) return;
    const xs = this.nodes.filter(n => n.x != null).map(n => n.x!);
    const ys = this.nodes.filter(n => n.y != null).map(n => n.y!);
    if (!xs.length) return;

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const padding = 80;
    const graphW = (maxX - minX) + padding * 2;
    const graphH = (maxY - minY) + padding * 2;

    this.viewport.fit(true, graphW, graphH);
    this.viewport.moveCenter((minX + maxX) / 2, (minY + maxY) / 2);
  }

  zoomIn(): void {
    if (!this.viewport) return;
    this.viewport.zoomPercent(0.3, true);
  }

  zoomOut(): void {
    if (!this.viewport) return;
    this.viewport.zoomPercent(-0.3, true);
  }

  zoomToNode(nodeId: string | number): void {
    if (!this.viewport) return;
    const node = this.nodeById.get(nodeId);
    if (node && node.x != null && node.y != null) {
      this.viewport.moveCenter(node.x, node.y);
    }
  }

  destroy(): void {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    this.nodeGfxMap.clear();
    this.nodeById.clear();
    this.nodes = [];
    this.edges = [];
    if (this.app) {
      this.app.destroy(true, { children: true, texture: true });
      this.app = null;
    }
    this.viewport = null;
    this.containerEl = null;
    this.isInitialBuild = true;
    this.lastLayoutMode = null;
    this.simulationActive = false;
    if (this.moveTimer) { clearTimeout(this.moveTimer); this.moveTimer = null; }
    // Re-create layers & graphics destroyed by app.destroy() (singleton service survives)
    this.edgeLayer = new Container();
    this.nodeLayer = new Container();
    this.labelLayer = new Container();
    this.edgeGfx = new Graphics();
    this.arrowGfx = new Graphics();
    this.overlayLayer = new Container();
  }

  // --- Screensaver helpers ---

  getRenderedEdgeData(): GraphEdge[] {
    return this.edges as any[];
  }

  getRenderedNodeData(): GraphNode[] {
    return this.nodes;
  }

  getZoomTransform(): { x: number; y: number; k: number } | null {
    if (!this.viewport) return null;
    return {
      x: this.viewport.x,
      y: this.viewport.y,
      k: this.viewport.scale.x,
    };
  }

  setZoomTransform(transform: { x: number; y: number; k: number }, duration = 500): void {
    if (!this.viewport) return;
    if (duration > 0) {
      this.viewport.animate({
        position: { x: -transform.x / transform.k, y: -transform.y / transform.k },
        scale: transform.k,
        time: duration,
      });
    } else {
      this.viewport.scale.set(transform.k);
      this.viewport.position.set(transform.x, transform.y);
    }
  }

  getViewport(): Viewport | null {
    return this.viewport;
  }

  interruptAll(): void {
    // PixiJS doesn't have D3-style transitions to interrupt
    // This is a no-op for compatibility
  }

  // --- Private: simulation strategies ---

  private startMainThreadSimulation(
    nodes: GraphNode[],
    edges: typeof this.edges,
    width: number,
    height: number,
    tickSkip: number,
    alphaDecay: number,
    shouldFit: boolean,
  ): void {
    let tickCount = 0;
    const simEdges = edges.map(e => ({ ...e }));

    this.simulation = d3.forceSimulation<GraphNode>(nodes)
      .alphaDecay(alphaDecay)
      .velocityDecay(0.4)
      .force('link', d3.forceLink(simEdges)
        .id((d: any) => d.id)
        .distance((d: any) => {
          if (d._isHubLink) return 50;
          if (d._isCrossRepo) return 180;
          if (d._isExpandedRepoEdge) return 50;
          return d.rel === 'CONTAINS' ? 40 : 70;
        })
        .strength((d: any) => {
          if (d._isHubLink) return 0.9;
          if (d._isCrossRepo) return 0.12;
          if (d._isExpandedRepoEdge) return 0.5;
          return d.rel === 'CONTAINS' ? 0.8 : 0.3;
        }))
      .force('charge', d3.forceManyBody<GraphNode>().strength((d: GraphNode) => {
        if (d._isHub) return -500;
        if (d._isComponent) return -400;
        if (d._isPhantom) return -120;
        if (d._isExpandedRepo) return -60;
        return d.label === 'Folder' ? -200 : -80;
      }))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<GraphNode>().radius((d: GraphNode) => {
        if (d._isHub) return 70;
        if (d._isComponent) return 60;
        return (NODE_SIZES[d.label] || 5) + 8;
      }))
      .force('x', d3.forceX(width / 2).strength(0.03))
      .force('y', d3.forceY(height / 2).strength(0.03))
      .force('repoCluster', this.createRepoClusterForce(nodes, width, height))
      .on('tick', () => {
        tickCount++;
        if (tickCount % tickSkip !== 0) return;
        this.updatePositions();
      })
      .on('end', () => {
        this.simulationActive = false;
        this.updatePositions(true);
        if (shouldFit) this.fitGraph();
        this.updateMinimap();
      });

    this.simulationActive = true;
    this.edgeTickCounter = 0;
    nodes.forEach(n => { n.fx = null; n.fy = null; });
    setTimeout(() => this.updateMinimap(), 500);
  }

  private startWorkerSimulation(
    nodes: GraphNode[],
    edges: typeof this.edges,
    width: number,
    height: number,
    tickSkip: number,
    alphaDecay: number,
    shouldFit: boolean,
  ): void {
    this.terminateWorker();

    // Build index map for fast node lookup from position arrays
    this.nodeIndexMap.clear();
    nodes.forEach((n, i) => this.nodeIndexMap.set(n.id, i));

    // Serialize nodes for the worker (strip non-serializable fields)
    const workerNodes = nodes.map(n => ({
      id: n.id,
      label: n.label,
      _isHub: n._isHub || false,
      _isComponent: n._isComponent || false,
      _isPhantom: n._isPhantom || false,
      _isExpandedRepo: n._isExpandedRepo || false,
      _repoId: n._repoId || undefined,
      x: n.x,
      y: n.y,
      fx: null as number | null,
      fy: null as number | null,
    }));

    const workerEdges = edges.map(e => ({
      source: e.source,
      target: e.target,
      rel: e.rel,
      _isCrossRepo: e._isCrossRepo,
      _isHubLink: e._isHubLink,
      _isExpandedRepoEdge: e._isExpandedRepoEdge,
    }));

    try {
      this.worker = new Worker(
        new URL('../workers/force-simulation.worker', import.meta.url),
        { type: 'module' },
      );
    } catch {
      // Fallback to main-thread if Worker creation fails
      console.warn('Web Worker creation failed, falling back to main thread');
      this.startMainThreadSimulation(nodes, edges, width, height, tickSkip, alphaDecay, shouldFit);
      return;
    }

    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'tick') {
        const positions = msg.positions as Float64Array;
        // Apply positions from worker to local node objects
        for (let i = 0; i < nodes.length; i++) {
          nodes[i].x = positions[i * 2];
          nodes[i].y = positions[i * 2 + 1];
        }
        this.updatePositions();
      } else if (msg.type === 'end') {
        this.simulationActive = false;
        this.updatePositions(true);
        if (shouldFit) this.fitGraph();
        this.updateMinimap();
      }
    };

    this.worker.onerror = (err) => {
      console.warn('Force Worker error, falling back to main thread:', err);
      this.simulationActive = false;
      this.terminateWorker();
      this.startMainThreadSimulation(nodes, edges, width, height, tickSkip, alphaDecay, shouldFit);
    };

    this.simulationActive = true;
    this.edgeTickCounter = 0;

    // Start simulation in worker
    this.worker.postMessage({
      type: 'start',
      nodes: workerNodes,
      edges: workerEdges,
      config: {
        width,
        height,
        nodeSizes: NODE_SIZES,
        tickSkip,
        alphaDecay,
      },
    });

    setTimeout(() => this.updateMinimap(), 500);
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.nodeIndexMap.clear();
  }

  // --- Private: node creation ---

  private createNodeGfx(node: GraphNode): NodeGfx {
    const container = new Container();
    container.eventMode = 'static';
    container.cursor = 'pointer';

    let shape: Graphics | Sprite;
    let baseRadius: number;
    let label: Text | null = null;
    let repoRing: Graphics | null = null;
    let originalFill = 0x666666;
    let originalStroke = 0x444444;
    let isCircle = false;
    let isPhantom = false;

    if (node._isHub) {
      // Hub node: rounded rect with dashed border
      const g = new Graphics();
      g.roundRect(-60, -20, 120, 40, 10);
      g.fill({ color: 0xff4080, alpha: 0.09 });
      g.stroke({ width: 2, color: 0xff4080 });
      shape = g;
      baseRadius = 30;
      container.hitArea = new PixiCircle(0, 0, 35);

      // Hub label (name)
      const hubName = new Text({
        text: (node.properties?.['name'] as string) || '',
        style: new TextStyle({
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          fontWeight: '700',
          fill: 0xff4080,
          align: 'center',
        }),
      });
      hubName.anchor.set(0.5, 0.5);
      hubName.y = -2;
      container.addChild(hubName);

      // Connection count
      const hubCount = new Text({
        text: `${node.properties?.['edge_count'] || 0} connections`,
        style: new TextStyle({
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 9,
          fill: 0xff4080,
          align: 'center',
        }),
      });
      hubCount.anchor.set(0.5, 0.5);
      hubCount.y = 13;
      hubCount.alpha = 0.56;
      container.addChild(hubCount);
      originalFill = 0xff4080;
      originalStroke = 0xff4080;
    } else if (node._isComponent) {
      // Component node: rounded rect
      const name = (node.properties?.['name'] as string) || '';
      const w = Math.min(Math.max(name.length * 7 + 20, 100), 200);
      const c = node._childCounts || {};
      let fillColor = 0x4a9eff;
      let strokeColor = 0x4a9eff;
      if (c['RouteHandler']) { fillColor = 0xff9040; strokeColor = 0xff9040; }
      else if (c['Class']) { fillColor = 0xff6090; strokeColor = 0xff6090; }
      else if (c['Interface']) { fillColor = 0x60d0ff; strokeColor = 0x60d0ff; }

      const g = new Graphics();
      g.roundRect(-w / 2, -22, w, 44, 8);
      g.fill({ color: fillColor, alpha: 0.09 });
      g.stroke({ width: 1.5, color: strokeColor });
      shape = g;
      baseRadius = 22;
      container.hitArea = new PixiCircle(0, 0, 30);

      // Component name
      const compName = new Text({
        text: name.length > 26 ? name.slice(0, 24) + '...' : name,
        style: new TextStyle({
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          fontWeight: '600',
          fill: strokeColor,
          align: 'center',
        }),
      });
      compName.anchor.set(0.5, 0.5);
      compName.y = -5;
      container.addChild(compName);

      // Summary
      const summary = new Text({
        text: (node.properties?.['summary'] as string) || 'empty',
        style: new TextStyle({
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 8,
          fill: 0x888888,
          align: 'center',
        }),
      });
      summary.anchor.set(0.5, 0.5);
      summary.y = 10;
      container.addChild(summary);
      originalFill = fillColor;
      originalStroke = strokeColor;
    } else {
      // Regular node: circle
      const r = NODE_SIZES[node.label] || 5;
      baseRadius = r;
      const colors = NODE_COLORS[node.label];
      const fillColor = colors ? hexToNum(colors.fill) : 0x666666;
      const strokeColor = colors ? hexToNum(colors.stroke) : 0x444444;

      const g = new Graphics();
      g.circle(0, 0, r);
      if (node._isPhantom) {
        g.fill({ color: 0x000000, alpha: 0 });
        g.stroke({ width: 2, color: strokeColor });
      } else {
        g.fill({ color: fillColor, alpha: 0.9 });
        g.stroke({ width: 1.5, color: strokeColor });
      }
      shape = g;
      container.hitArea = new PixiCircle(0, 0, r + 4);

      // Repo ring for expanded-repo nodes
      if (node._isExpandedRepo && node._repoColor) {
        repoRing = new Graphics();
        repoRing.circle(0, 0, r + 3);
        repoRing.stroke({ width: 2, color: hexToNum(node._repoColor), alpha: 0.7 });
        container.addChild(repoRing);
      }

      // Label (outside node)
      const name = this.getNodeName(node);
      const displayName = name.length > 20 ? name.slice(0, 18) + '...' : name;
      label = new Text({
        text: displayName,
        style: new TextStyle({
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: node.label === 'Folder' ? 9 : 8,
          fontWeight: node.label === 'Folder' ? '600' : '400',
          fill: fillColor,
        }),
      });
      label.anchor.set(0, 0.5);
      label.x = 0; // Will be positioned relative to node in updatePositions
      label.y = 0;
      label.alpha = 0.85;
      originalFill = fillColor;
      originalStroke = strokeColor;
      isCircle = true;
      isPhantom = !!node._isPhantom;
    }

    // Halo (hidden by default, used by overlays)
    const halo = new Graphics();
    halo.circle(0, 0, baseRadius + 5);
    halo.stroke({ width: 3, color: 0xffffff });
    halo.visible = false;
    container.addChildAt(halo, 0); // Behind everything

    // Add shape to container
    container.addChild(shape);

    // Interactions
    container.on('pointerover', (e: any) => {
      container.scale.set(1.1);
      this.zone.run(() => this.nodeHovered$.next({ node, event: e }));
    });
    container.on('pointerout', (e: any) => {
      container.scale.set(1.0);
      this.zone.run(() => this.nodeUnhovered$.next());
    });
    container.on('pointertap', (e: any) => {
      e.stopPropagation();
      this.zone.run(() => this.nodeClicked$.next({ node, event: e }));
    });

    // Drag — works with both main-thread simulation and Web Worker
    let dragging = false;
    container.on('pointerdown', (e: any) => {
      dragging = true;
      const idx = this.nodeIndexMap.get(node.id);
      if (this.worker && idx != null) {
        this.worker.postMessage({ type: 'pin', nodeIndex: idx, x: node.x, y: node.y });
        this.worker.postMessage({ type: 'reheat' });
      } else if (this.simulation) {
        this.simulation.alphaTarget(0.1).restart();
        node.fx = node.x;
        node.fy = node.y;
      }
      e.stopPropagation();
    });
    container.on('globalpointermove', (e: any) => {
      if (!dragging || !this.viewport) return;
      const pos = this.viewport.toWorld(e.global);
      const idx = this.nodeIndexMap.get(node.id);
      if (this.worker && idx != null) {
        this.worker.postMessage({ type: 'pin', nodeIndex: idx, x: pos.x, y: pos.y });
      } else {
        node.fx = pos.x;
        node.fy = pos.y;
      }
    });
    container.on('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const idx = this.nodeIndexMap.get(node.id);
      const keepFixed = this.lastLayoutMode === 'flow' || this.lastLayoutMode === 'components';
      if (this.worker && idx != null) {
        this.worker.postMessage({ type: 'cool' });
        if (!keepFixed) this.worker.postMessage({ type: 'unpin', nodeIndex: idx });
      } else if (this.simulation) {
        this.simulation.alphaTarget(0);
        if (keepFixed) { node.fx = node.x; node.fy = node.y; }
        else { node.fx = null; node.fy = null; }
      }
    });
    container.on('pointerupoutside', () => {
      if (!dragging) return;
      dragging = false;
      const idx = this.nodeIndexMap.get(node.id);
      const keepFixed = this.lastLayoutMode === 'flow' || this.lastLayoutMode === 'components';
      if (this.worker && idx != null) {
        this.worker.postMessage({ type: 'cool' });
        if (!keepFixed) this.worker.postMessage({ type: 'unpin', nodeIndex: idx });
      } else if (this.simulation) {
        this.simulation.alphaTarget(0);
        if (!keepFixed) { node.fx = null; node.fy = null; }
      }
    });

    return { container, shape, halo, label, repoRing, baseRadius, originalFill, originalStroke, isCircle, isPhantom, glowSprite: null };
  }

  // --- Private: position updates ---

  private updatePositions(isSimulationEnd = false): void {
    // Update node sprite positions
    for (const node of this.nodes) {
      const gfx = this.nodeGfxMap.get(node.id);
      if (!gfx || node.x == null || node.y == null) continue;
      gfx.container.x = node.x;
      gfx.container.y = node.y;

      // Position label offset from node
      if (gfx.label) {
        gfx.label.x = node.x + gfx.baseRadius + 4;
        gfx.label.y = node.y;
      }
    }

    // Throttle edge redraws during simulation: only every 3rd tick
    this.edgeTickCounter++;
    if (isSimulationEnd || !this.simulationActive || this.edgeTickCounter % 3 === 0) {
      this.drawEdges(undefined, undefined, { skipArrows: this.simulationActive && !isSimulationEnd });
    }
  }

  private drawEdges(
    focusNodeId?: string | number | null,
    neighborIds?: Set<string | number>,
    options?: { skipArrows?: boolean },
  ): void {
    if (!this.edgeGfx || !this.arrowGfx) return;
    this.edgeGfx.clear();
    this.arrowGfx.clear();

    const isFocusMode = focusNodeId != null && neighborIds != null;
    const skipArrows = options?.skipArrows ?? false;

    // Viewport culling bounds (skip edges entirely off-screen)
    const bounds = this.getViewBounds();

    // Batch edges by style to minimize draw calls
    const edgeBuckets = new Map<string, { color: number; width: number; alpha: number; segs: number[] }>();
    const arrowBuckets = new Map<string, { color: number; alpha: number; segs: number[] }>();

    for (const edge of this.edges) {
      const srcNode = this.nodeById.get(edge.source);
      const tgtNode = this.nodeById.get(edge.target);
      if (!srcNode || !tgtNode || srcNode.x == null || tgtNode.x == null) continue;

      // Viewport culling: skip edges where both endpoints are off-screen
      if (bounds && this.isEdgeOffScreen(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!, bounds)) continue;

      let color: number;
      let width: number;
      let alpha: number;

      if (isFocusMode) {
        const srcVisible = neighborIds!.has(edge.source);
        const tgtVisible = neighborIds!.has(edge.target);
        if (!srcVisible || !tgtVisible) {
          color = 0x333333;
          width = 0.5;
          alpha = 0.03;
        } else if (edge.source === focusNodeId) {
          color = hexToNum(FOCUS_COLORS.outgoing);
          width = 2.5;
          alpha = 1;
        } else if (edge.target === focusNodeId) {
          color = hexToNum(FOCUS_COLORS.incoming);
          width = 2.5;
          alpha = 1;
        } else {
          color = edge._isCrossRepo ? 0xff4080 : (hexToNum(EDGE_COLORS[edge.rel] || '#555555'));
          width = edge._isCrossRepo ? 2.0 : 1.0;
          alpha = 0.7;
        }
      } else {
        color = edge._isHubLink ? 0xff4080 : (edge._isCrossRepo ? 0xff4080 : hexToNum(EDGE_COLORS[edge.rel] || '#333333'));
        width = edge._isHubLink ? 0.5 : (edge._isCrossRepo ? 2.0 : (edge.rel === 'IMPORTS' || edge.rel === 'CALLS' ? 1.5 : 0.8));
        alpha = edge._isHubLink ? 0.2 : (edge._isExpandedRepoEdge ? 0.25 : (edge._isCrossRepo ? 0.8 : ((edge.rel === 'IMPORTS' || edge.rel === 'CALLS') ? 0.7 : 0.3)));
      }

      // Add to edge bucket
      const key = `${color}:${width}:${alpha}`;
      let bucket = edgeBuckets.get(key);
      if (!bucket) {
        bucket = { color, width, alpha, segs: [] };
        edgeBuckets.set(key, bucket);
      }
      bucket.segs.push(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!);

      // Add to arrow bucket (skip hub links and very dim edges)
      if (!skipArrows && !edge._isHubLink && alpha > 0.05) {
        const aKey = `${color}:${alpha}`;
        let aBucket = arrowBuckets.get(aKey);
        if (!aBucket) {
          aBucket = { color, alpha, segs: [] };
          arrowBuckets.set(aKey, aBucket);
        }
        aBucket.segs.push(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!);
      }
    }

    // Flush edge buckets — one stroke() per unique style
    for (const [, b] of edgeBuckets) {
      const segs = b.segs;
      for (let i = 0; i < segs.length; i += 4) {
        this.edgeGfx.moveTo(segs[i], segs[i + 1]);
        this.edgeGfx.lineTo(segs[i + 2], segs[i + 3]);
      }
      this.edgeGfx.stroke({ width: b.width, color: b.color, alpha: b.alpha });
    }

    // Flush arrow buckets
    if (!skipArrows) {
      this.flushArrowBuckets(arrowBuckets);
    }
  }

  private drawEdgesProcessMode(stepSet: Set<string>): void {
    if (!this.edgeGfx || !this.arrowGfx) return;
    this.edgeGfx.clear();
    this.arrowGfx.clear();

    const activeBucket: number[] = [];
    const dimBucket: number[] = [];
    const arrowSegs: number[] = [];

    for (const edge of this.edges) {
      const srcNode = this.nodeById.get(edge.source);
      const tgtNode = this.nodeById.get(edge.target);
      if (!srcNode || !tgtNode || srcNode.x == null || tgtNode.x == null) continue;

      const srcInStep = stepSet.has(String(edge.source));
      const tgtInStep = stepSet.has(String(edge.target));

      if (srcInStep && tgtInStep) {
        activeBucket.push(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!);
        arrowSegs.push(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!);
      } else {
        dimBucket.push(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!);
      }
    }

    // Dim edges — one stroke
    if (dimBucket.length) {
      for (let i = 0; i < dimBucket.length; i += 4) {
        this.edgeGfx.moveTo(dimBucket[i], dimBucket[i + 1]);
        this.edgeGfx.lineTo(dimBucket[i + 2], dimBucket[i + 3]);
      }
      this.edgeGfx.stroke({ width: 0.5, color: 0x333333, alpha: 0.06 });
    }

    // Active edges — one stroke
    if (activeBucket.length) {
      for (let i = 0; i < activeBucket.length; i += 4) {
        this.edgeGfx.moveTo(activeBucket[i], activeBucket[i + 1]);
        this.edgeGfx.lineTo(activeBucket[i + 2], activeBucket[i + 3]);
      }
      this.edgeGfx.stroke({ width: 3, color: 0x34d399, alpha: 1 });
    }

    // Arrows for active edges
    const aBuckets = new Map<string, { color: number; alpha: number; segs: number[] }>();
    if (arrowSegs.length) {
      aBuckets.set('active', { color: 0x34d399, alpha: 1, segs: arrowSegs });
    }
    this.flushArrowBuckets(aBuckets);
  }

  private drawEdgesDiffMode(directSet: Set<string>, impactedSet: Set<string>): void {
    if (!this.edgeGfx || !this.arrowGfx) return;
    this.edgeGfx.clear();
    this.arrowGfx.clear();

    const affectedBucket: number[] = [];
    const dimBucket: number[] = [];

    for (const edge of this.edges) {
      const srcNode = this.nodeById.get(edge.source);
      const tgtNode = this.nodeById.get(edge.target);
      if (!srcNode || !tgtNode || srcNode.x == null || tgtNode.x == null) continue;

      const srcAffected = directSet.has(String(edge.source)) || impactedSet.has(String(edge.source));
      const tgtAffected = directSet.has(String(edge.target)) || impactedSet.has(String(edge.target));

      if (srcAffected && tgtAffected) {
        affectedBucket.push(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!);
      } else {
        dimBucket.push(srcNode.x!, srcNode.y!, tgtNode.x!, tgtNode.y!);
      }
    }

    if (dimBucket.length) {
      for (let i = 0; i < dimBucket.length; i += 4) {
        this.edgeGfx.moveTo(dimBucket[i], dimBucket[i + 1]);
        this.edgeGfx.lineTo(dimBucket[i + 2], dimBucket[i + 3]);
      }
      this.edgeGfx.stroke({ width: 0.5, color: 0x333333, alpha: 0.08 });
    }

    if (affectedBucket.length) {
      for (let i = 0; i < affectedBucket.length; i += 4) {
        this.edgeGfx.moveTo(affectedBucket[i], affectedBucket[i + 1]);
        this.edgeGfx.lineTo(affectedBucket[i + 2], affectedBucket[i + 3]);
      }
      this.edgeGfx.stroke({ width: 1, color: 0x888888, alpha: 0.6 });
    }
  }

  /** Get viewport bounds in world coordinates for culling */
  private getViewBounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    if (!this.viewport) return null;
    const vp = this.viewport;
    const pad = 100;
    const corner = vp.toWorld(0, 0);
    const corner2 = vp.toWorld(vp.screenWidth, vp.screenHeight);
    return {
      minX: Math.min(corner.x, corner2.x) - pad,
      maxX: Math.max(corner.x, corner2.x) + pad,
      minY: Math.min(corner.y, corner2.y) - pad,
      maxY: Math.max(corner.y, corner2.y) + pad,
    };
  }

  /** Check if both endpoints are entirely outside the same side of the viewport */
  private isEdgeOffScreen(
    sx: number, sy: number, tx: number, ty: number,
    bounds: { minX: number; maxX: number; minY: number; maxY: number },
  ): boolean {
    return (sx < bounds.minX && tx < bounds.minX) || (sx > bounds.maxX && tx > bounds.maxX) ||
           (sy < bounds.minY && ty < bounds.minY) || (sy > bounds.maxY && ty > bounds.maxY);
  }

  /** Flush batched arrow segments — one stroke per style bucket */
  private flushArrowBuckets(buckets: Map<string, { color: number; alpha: number; segs: number[] }>): void {
    for (const [, b] of buckets) {
      const segs = b.segs;
      for (let i = 0; i < segs.length; i += 4) {
        const x1 = segs[i], y1 = segs[i + 1], x2 = segs[i + 2], y2 = segs[i + 3];
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        if (dist < 20) continue;
        const len = 5;
        const offset = 12;
        const ax = x2 - Math.cos(angle) * offset;
        const ay = y2 - Math.sin(angle) * offset;
        const p1x = ax - Math.cos(angle - Math.PI / 6) * len;
        const p1y = ay - Math.sin(angle - Math.PI / 6) * len;
        const p2x = ax - Math.cos(angle + Math.PI / 6) * len;
        const p2y = ay - Math.sin(angle + Math.PI / 6) * len;
        this.arrowGfx.moveTo(ax, ay);
        this.arrowGfx.lineTo(p1x, p1y);
        this.arrowGfx.moveTo(ax, ay);
        this.arrowGfx.lineTo(p2x, p2y);
      }
      this.arrowGfx.stroke({ width: 1.2, color: b.color, alpha: b.alpha * 0.6 });
    }
  }

  private showHalo(gfx: NodeGfx, color: number, alpha: number, strokeWidth: number): void {
    gfx.halo.clear();
    gfx.halo.circle(0, 0, gfx.baseRadius + 5);
    gfx.halo.stroke({ width: strokeWidth, color, alpha });
    gfx.halo.visible = true;
  }

  // --- Private: cleanup ---

  private clearGraph(): void {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    this.terminateWorker();
    this.nodeLayer.removeChildren();
    this.labelLayer.removeChildren();
    // Safely re-create edge graphics (may have been destroyed by app.destroy())
    if (this.edgeGfx) {
      try { this.edgeGfx.clear(); } catch { /* destroyed */ }
    }
    if (this.arrowGfx) {
      try { this.arrowGfx.clear(); } catch { /* destroyed */ }
    }
    this.nodeGfxMap.clear();
    this.nodeById.clear();
    this.nodes = [];
    this.edges = [];
  }

  // --- Private: minimap ---

  private updateMinimap(): void {
    if (!this.minimapCtx || !this.minimapCanvas) return;
    const ctx = this.minimapCtx;
    const canvas = this.minimapCanvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const filtered = this.nodes.filter(n => n.x != null && n.y != null);
    if (!filtered.length) return;

    const xs = filtered.map(n => n.x!);
    const ys = filtered.map(n => n.y!);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rangeX = (maxX - minX) || 1;
    const rangeY = (maxY - minY) || 1;
    const pad = 10;
    const mw = canvas.width - pad * 2;
    const mh = canvas.height - pad * 2;
    const scale = Math.min(mw / rangeX, mh / rangeY);

    for (const n of filtered) {
      const cx = pad + (n.x! - minX) * scale;
      const cy = pad + (n.y! - minY) * scale;
      const colors = NODE_COLORS[n.label];
      const color = (n._isExpandedRepo && n._repoColor)
        ? n._repoColor
        : (colors?.fill || '#666');

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- Private: force helpers ---

  private createRepoClusterForce(
    nodes: GraphNode[],
    width: number,
    height: number,
  ): (alpha: number) => void {
    const repoNodes = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (n._isExpandedRepo && n._repoId) {
        if (!repoNodes.has(n._repoId)) repoNodes.set(n._repoId, []);
        repoNodes.get(n._repoId)!.push(n);
      }
    }
    if (repoNodes.size === 0) return () => {};

    const repoIds = Array.from(repoNodes.keys());
    const angleStep = (2 * Math.PI) / (repoIds.length + 1);
    const radius = Math.min(width, height) * 0.3;
    const targets = new Map<string, { x: number; y: number }>();
    repoIds.forEach((id, i) => {
      targets.set(id, {
        x: width / 2 + Math.cos(angleStep * (i + 1)) * radius,
        y: height / 2 + Math.sin(angleStep * (i + 1)) * radius,
      });
    });

    const strength = 0.03;
    return (alpha: number) => {
      for (const [repoId, repoNodeList] of repoNodes) {
        const target = targets.get(repoId)!;
        for (const n of repoNodeList) {
          if (n.x != null) n.vx = (n.vx || 0) + (target.x - n.x) * strength * alpha;
          if (n.y != null) n.vy = (n.vy || 0) + (target.y - n.y) * strength * alpha;
        }
      }
    };
  }

  private getNodeName(d: GraphNode): string {
    const p = d.properties;
    if (d.label === 'RouteHandler') {
      return `${p?.['http_method'] || '?'} ${p?.['url_pattern'] || p?.['name'] || ''}`;
    }
    return (p?.['name'] as string) || (p?.['path'] as string) || `node-${d.id}`;
  }

  // ========= Screensaver Helper Methods (ss*) =========

  /** Set alpha on all node containers */
  ssSetAllNodesAlpha(alpha: number): void {
    for (const [, gfx] of this.nodeGfxMap) {
      gfx.container.alpha = alpha;
    }
  }

  /** Set alpha on a single node container */
  ssSetNodeAlpha(id: string | number, alpha: number): void {
    const gfx = this.nodeGfxMap.get(id);
    if (gfx) gfx.container.alpha = alpha;
  }

  /** Redraw a node's shape with a new fill color */
  ssSetNodeTint(id: string | number, colorNum: number): void {
    const gfx = this.nodeGfxMap.get(id);
    if (!gfx) return;
    if (gfx.isCircle) {
      const g = gfx.shape as Graphics;
      g.clear();
      g.circle(0, 0, gfx.baseRadius);
      if (gfx.isPhantom) {
        g.fill({ color: 0x000000, alpha: 0 });
        g.stroke({ width: 2, color: colorNum });
      } else {
        g.fill({ color: colorNum, alpha: 0.9 });
        g.stroke({ width: 1.5, color: colorNum });
      }
    } else {
      // Hub/Component: use container tint (multiplicative, approximate)
      gfx.shape.tint = colorNum;
    }
  }

  /** Restore a single node to its original colors */
  ssRestoreNodeColor(id: string | number): void {
    const gfx = this.nodeGfxMap.get(id);
    if (!gfx) return;
    if (gfx.isCircle) {
      const g = gfx.shape as Graphics;
      g.clear();
      g.circle(0, 0, gfx.baseRadius);
      if (gfx.isPhantom) {
        g.fill({ color: 0x000000, alpha: 0 });
        g.stroke({ width: 2, color: gfx.originalStroke });
      } else {
        g.fill({ color: gfx.originalFill, alpha: 0.9 });
        g.stroke({ width: 1.5, color: gfx.originalStroke });
      }
    } else {
      gfx.shape.tint = 0xffffff; // Reset multiplicative tint
    }
  }

  /** Restore all nodes to their original colors */
  ssRestoreAllNodeColors(): void {
    for (const [id] of this.nodeGfxMap) {
      this.ssRestoreNodeColor(id);
    }
  }

  /** Set scale on a single node container */
  ssSetNodeScale(id: string | number, scale: number): void {
    const gfx = this.nodeGfxMap.get(id);
    if (gfx) gfx.container.scale.set(scale);
  }

  /** Reset all node container scales to 1 */
  ssResetAllNodeScales(): void {
    for (const [, gfx] of this.nodeGfxMap) {
      gfx.container.scale.set(1);
    }
  }

  /** Show colored halo rings on specific nodes */
  ssShowHaloForNodes(ids: (string | number)[], color: number, alpha = 0.6, width = 3): void {
    const idSet = new Set(ids.map(String));
    for (const [id, gfx] of this.nodeGfxMap) {
      if (idSet.has(String(id))) {
        this.showHalo(gfx, color, alpha, width);
      }
    }
  }

  /** Hide all halo rings */
  ssHideAllHalos(): void {
    for (const [, gfx] of this.nodeGfxMap) {
      gfx.halo.visible = false;
    }
  }

  /** Declarative edge rendering for screensaver modes */
  ssSetEdgeMode(
    mode: 'default' | 'dim' | 'byType' | 'typeHighlight' | 'revealByNodes',
    opts?: {
      activeTypes?: Set<string>;
      highlightNodeIds?: Set<string | number>;
      revealedNodeIds?: Set<string | number>;
    },
  ): void {
    if (!this.edgeGfx || !this.arrowGfx) return;
    switch (mode) {
      case 'default':
        this.drawEdges();
        break;

      case 'dim': {
        this.edgeGfx.clear();
        this.arrowGfx.clear();
        for (const edge of this.edges) {
          const src = this.nodeById.get(edge.source);
          const tgt = this.nodeById.get(edge.target);
          if (!src || !tgt || src.x == null || tgt.x == null) continue;
          this.edgeGfx.moveTo(src.x!, src.y!);
          this.edgeGfx.lineTo(tgt.x!, tgt.y!);
        }
        this.edgeGfx.stroke({ width: 0.5, color: 0x333333, alpha: 0.06 });
        break;
      }

      case 'byType': {
        const activeTypes = opts?.activeTypes || new Set<string>();
        this.edgeGfx.clear();
        this.arrowGfx.clear();
        const edgeBuckets = new Map<string, { color: number; width: number; alpha: number; segs: number[] }>();
        const arrowBuckets = new Map<string, { color: number; alpha: number; segs: number[] }>();

        for (const edge of this.edges) {
          const src = this.nodeById.get(edge.source);
          const tgt = this.nodeById.get(edge.target);
          if (!src || !tgt || src.x == null || tgt.x == null) continue;
          let color: number, width: number, alpha: number;
          if (activeTypes.has(edge.rel)) {
            color = hexToNum(EDGE_COLORS[edge.rel] || '#ffffff');
            width = 2; alpha = 0.8;
            const aKey = `${color}:${alpha}`;
            let ab = arrowBuckets.get(aKey);
            if (!ab) { ab = { color, alpha, segs: [] }; arrowBuckets.set(aKey, ab); }
            ab.segs.push(src.x!, src.y!, tgt.x!, tgt.y!);
          } else {
            color = 0x333333; width = 0.5; alpha = 0.06;
          }
          const key = `${color}:${width}:${alpha}`;
          let eb = edgeBuckets.get(key);
          if (!eb) { eb = { color, width, alpha, segs: [] }; edgeBuckets.set(key, eb); }
          eb.segs.push(src.x!, src.y!, tgt.x!, tgt.y!);
        }

        for (const [, b] of edgeBuckets) {
          for (let i = 0; i < b.segs.length; i += 4) {
            this.edgeGfx.moveTo(b.segs[i], b.segs[i + 1]);
            this.edgeGfx.lineTo(b.segs[i + 2], b.segs[i + 3]);
          }
          this.edgeGfx.stroke({ width: b.width, color: b.color, alpha: b.alpha });
        }
        this.flushArrowBuckets(arrowBuckets);
        break;
      }

      case 'typeHighlight': {
        const highlightIds = opts?.highlightNodeIds || new Set<string | number>();
        this.edgeGfx.clear();
        this.arrowGfx.clear();
        const edgeBuckets = new Map<string, { color: number; width: number; alpha: number; segs: number[] }>();

        for (const edge of this.edges) {
          const src = this.nodeById.get(edge.source);
          const tgt = this.nodeById.get(edge.target);
          if (!src || !tgt || src.x == null || tgt.x == null) continue;
          let color: number, width: number, alpha: number;
          if (highlightIds.has(edge.source) || highlightIds.has(edge.target)) {
            color = hexToNum(EDGE_COLORS[edge.rel] || '#666666');
            width = 1.5; alpha = 0.7;
          } else {
            color = 0x333333; width = 0.5; alpha = 0.04;
          }
          const key = `${color}:${width}:${alpha}`;
          let eb = edgeBuckets.get(key);
          if (!eb) { eb = { color, width, alpha, segs: [] }; edgeBuckets.set(key, eb); }
          eb.segs.push(src.x!, src.y!, tgt.x!, tgt.y!);
        }

        for (const [, b] of edgeBuckets) {
          for (let i = 0; i < b.segs.length; i += 4) {
            this.edgeGfx.moveTo(b.segs[i], b.segs[i + 1]);
            this.edgeGfx.lineTo(b.segs[i + 2], b.segs[i + 3]);
          }
          this.edgeGfx.stroke({ width: b.width, color: b.color, alpha: b.alpha });
        }
        break;
      }

      case 'revealByNodes': {
        const revealed = opts?.revealedNodeIds || new Set<string | number>();
        this.edgeGfx.clear();
        this.arrowGfx.clear();
        const edgeBuckets = new Map<string, { color: number; width: number; alpha: number; segs: number[] }>();
        const arrowBuckets = new Map<string, { color: number; alpha: number; segs: number[] }>();

        for (const edge of this.edges) {
          const src = this.nodeById.get(edge.source);
          const tgt = this.nodeById.get(edge.target);
          if (!src || !tgt || src.x == null || tgt.x == null) continue;
          let color: number, width: number, alpha: number;
          if (revealed.has(edge.source) && revealed.has(edge.target)) {
            color = hexToNum(EDGE_COLORS[edge.rel] || '#555555');
            width = 1; alpha = 0.5;
            const aKey = `${color}:${alpha}`;
            let ab = arrowBuckets.get(aKey);
            if (!ab) { ab = { color, alpha, segs: [] }; arrowBuckets.set(aKey, ab); }
            ab.segs.push(src.x!, src.y!, tgt.x!, tgt.y!);
          } else {
            color = 0x333333; width = 0.3; alpha = 0.03;
          }
          const key = `${color}:${width}:${alpha}`;
          let eb = edgeBuckets.get(key);
          if (!eb) { eb = { color, width, alpha, segs: [] }; edgeBuckets.set(key, eb); }
          eb.segs.push(src.x!, src.y!, tgt.x!, tgt.y!);
        }

        for (const [, b] of edgeBuckets) {
          for (let i = 0; i < b.segs.length; i += 4) {
            this.edgeGfx.moveTo(b.segs[i], b.segs[i + 1]);
            this.edgeGfx.lineTo(b.segs[i + 2], b.segs[i + 3]);
          }
          this.edgeGfx.stroke({ width: b.width, color: b.color, alpha: b.alpha });
        }
        this.flushArrowBuckets(arrowBuckets);
        break;
      }
    }
  }

  /** Create a PixiJS text overlay on the viewport (world coords) — kept for backward compat */
  ssCreateTextOverlay(text: string, opts: {
    x: number;
    y: number;
    fontSize?: number;
    fill?: number;
    alpha?: number;
    fontWeight?: string;
  }): Text | null {
    if (!this.viewport) return null;
    const t = new Text({
      text,
      style: new TextStyle({
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: opts.fontSize || 12,
        fontWeight: (opts.fontWeight as any) || '400',
        fill: opts.fill ?? 0xffffff,
      }),
    });
    t.anchor.set(0.5, 0.5);
    t.x = opts.x;
    t.y = opts.y;
    t.alpha = opts.alpha ?? 1;
    this.viewport.addChild(t);
    return t;
  }

  /** Remove and destroy a text overlay */
  ssDestroyTextOverlay(text: Text | null): void {
    if (!text) return;
    text.removeFromParent();
    text.destroy();
  }

  /** Register a callback on the PixiJS app ticker */
  ssAddTicker(fn: (ticker: Ticker) => void): void {
    if (!this.app) return;
    this.app.ticker.add(fn);
  }

  /** Deregister a ticker callback */
  ssRemoveTicker(fn: (ticker: Ticker) => void): void {
    if (!this.app) return;
    this.app.ticker.remove(fn);
  }

  // ========= Tween Engine =========

  /** Start the tween engine — registers a ticker that advances all active tweens */
  ssStartTweenEngine(): void {
    if (this.ssTweenTickerBound || !this.app) return;
    this.ssTweenTickerBound = (ticker: Ticker) => {
      const dt = ticker.deltaMS;
      for (let i = this.ssTweens.length - 1; i >= 0; i--) {
        const tw = this.ssTweens[i];
        tw.elapsed += dt;
        const progress = Math.min(tw.elapsed / tw.duration, 1);
        const eased = tw.ease(progress);
        const val = tw.from + (tw.to - tw.from) * eased;

        // Apply value — handle nested props like 'scale.x'
        const parts = tw.prop.split('.');
        if (parts.length === 2) {
          tw.target[parts[0]][parts[1]] = val;
        } else {
          tw.target[tw.prop] = val;
        }

        if (progress >= 1) {
          this.ssTweens.splice(i, 1);
          tw.onComplete?.();
        }
      }
    };
    this.app.ticker.add(this.ssTweenTickerBound);
  }

  /** Stop the tween engine — removes ticker and clears all tweens */
  ssStopTweenEngine(): void {
    if (this.ssTweenTickerBound && this.app) {
      this.app.ticker.remove(this.ssTweenTickerBound);
    }
    this.ssTweenTickerBound = null;
    this.ssTweens = [];
  }

  /** Start a tween. Replaces any existing tween on same target+prop. */
  ssTween(
    target: any,
    prop: string,
    from: number,
    to: number,
    duration: number,
    ease: (t: number) => number = easeOutCubic,
    onComplete?: () => void,
  ): void {
    // Remove existing tween on same target+prop
    this.ssTweens = this.ssTweens.filter(tw => !(tw.target === target && tw.prop === prop));
    this.ssTweens.push({ target, prop, from, to, duration, elapsed: 0, ease, onComplete });
  }

  // ========= Screen-Space Text (Overlay Layer) =========

  /** Create zoom-invariant text on the overlay layer (screen pixels) */
  ssCreateScreenText(text: string, x: number, y: number, opts?: {
    fontSize?: number;
    fill?: number;
    alpha?: number;
    fontWeight?: string;
    anchorX?: number;
    anchorY?: number;
  }): Text {
    const t = new Text({
      text,
      style: new TextStyle({
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: opts?.fontSize ?? 24,
        fontWeight: (opts?.fontWeight as any) ?? '600',
        fill: opts?.fill ?? 0xffffff,
        dropShadow: {
          alpha: 0.7,
          blur: 4,
          distance: 0,
          color: 0x000000,
        },
      }),
    });
    t.anchor.set(opts?.anchorX ?? 0.5, opts?.anchorY ?? 0.5);
    t.x = x;
    t.y = y;
    t.alpha = opts?.alpha ?? 0; // Start invisible — fade in via tween
    this.overlayLayer.addChild(t);
    return t;
  }

  /** Destroy a screen text */
  ssDestroyScreenText(text: Text | null): void {
    if (!text) return;
    text.removeFromParent();
    text.destroy();
  }

  /** Destroy all screen texts on the overlay layer */
  ssDestroyAllScreenTexts(): void {
    const children = [...this.overlayLayer.children];
    for (const child of children) {
      child.removeFromParent();
      child.destroy();
    }
  }

  // ========= Glow Halos =========

  /** Lazily create a soft glow texture (radial gradient circle) */
  private ensureGlowTexture(): void {
    if (this.glowTexture || !this.app) return;
    const size = 64;
    const g = new Graphics();
    // Draw concentric circles with decreasing alpha for soft glow
    for (let i = 10; i >= 0; i--) {
      const r = (size / 2) * (i / 10);
      const a = 0.08 * (1 - i / 10);
      g.circle(size / 2, size / 2, r);
      g.fill({ color: 0xffffff, alpha: a });
    }
    this.glowTexture = this.app.renderer.generateTexture(g);
    g.destroy();
  }

  /** Show a soft glow halo on a node */
  ssShowGlowHalo(nodeId: string | number, color: number, scale = 4): void {
    this.ensureGlowTexture();
    const gfx = this.nodeGfxMap.get(nodeId);
    if (!gfx || !this.glowTexture) return;

    // Remove existing glow
    if (gfx.glowSprite) {
      gfx.glowSprite.removeFromParent();
      gfx.glowSprite.destroy();
    }

    const sprite = new Sprite(this.glowTexture);
    sprite.anchor.set(0.5);
    sprite.tint = color;
    sprite.alpha = 0.7;
    sprite.blendMode = 'add';
    sprite.scale.set(scale);
    gfx.container.addChildAt(sprite, 0); // Behind everything
    gfx.glowSprite = sprite;
  }

  /** Hide a glow halo from a node */
  ssHideGlowHalo(nodeId: string | number): void {
    const gfx = this.nodeGfxMap.get(nodeId);
    if (!gfx?.glowSprite) return;
    gfx.glowSprite.removeFromParent();
    gfx.glowSprite.destroy();
    gfx.glowSprite = null;
  }

  /** Hide all glow halos */
  ssHideAllGlowHalos(): void {
    for (const [id] of this.nodeGfxMap) {
      this.ssHideGlowHalo(id);
    }
  }

  // ========= Animated Viewport =========

  /** Smooth animated zoom to a node */
  ssAnimatedZoomToNode(nodeId: string | number, zoomScale = 1.5, durationMs = 1200): void {
    if (!this.viewport) return;
    const node = this.nodeById.get(nodeId);
    if (!node || node.x == null || node.y == null) return;
    this.viewport.animate({
      position: { x: node.x, y: node.y },
      scale: zoomScale,
      time: durationMs,
      ease: 'easeInOutSine',
    });
  }

  // ========= GPU Hue Filter =========

  /** Apply hue rotation to the entire node layer via GPU ColorMatrixFilter */
  ssSetNodeLayerHue(degrees: number): void {
    if (!this.ssHueFilter) {
      this.ssHueFilter = new ColorMatrixFilter();
      this.nodeLayer.filters = [this.ssHueFilter];
    }
    this.ssHueFilter.hue(degrees, false);
  }

  /** Remove hue filter from node layer */
  ssClearNodeLayerFilter(): void {
    if (this.ssHueFilter) {
      this.nodeLayer.filters = [];
      this.ssHueFilter.destroy();
      this.ssHueFilter = null;
    }
  }

  // ========= Convenience Tween Wrappers =========

  /** Fade a single node's alpha with easing */
  ssFadeNodeAlpha(id: string | number, to: number, duration = 600): void {
    const gfx = this.nodeGfxMap.get(id);
    if (!gfx) return;
    this.ssTween(gfx.container, 'alpha', gfx.container.alpha, to, duration);
  }

  /** Fade all nodes' alpha with easing */
  ssFadeAllNodesAlpha(to: number, duration = 600): void {
    for (const [, gfx] of this.nodeGfxMap) {
      this.ssTween(gfx.container, 'alpha', gfx.container.alpha, to, duration);
    }
  }

  /** Tween a node's scale with easing */
  ssTweenNodeScale(id: string | number, to: number, duration = 600): void {
    const gfx = this.nodeGfxMap.get(id);
    if (!gfx) return;
    const cur = gfx.container.scale.x;
    // Tween both x and y via the container object directly
    this.ssTween(gfx.container.scale, 'x', cur, to, duration, easeInOutSine);
    this.ssTween(gfx.container.scale, 'y', cur, to, duration, easeInOutSine);
  }

  /** Fade a Text object's alpha */
  ssFadeText(text: Text | null, to: number, duration = 400, onComplete?: () => void): void {
    if (!text) return;
    this.ssTween(text, 'alpha', text.alpha, to, duration, easeOutCubic, onComplete);
  }

  // ========= Edge Layer Alpha =========

  /** Set edge layer alpha directly */
  ssSetEdgeLayerAlpha(alpha: number): void {
    this.edgeLayer.alpha = alpha;
  }

  /** Fade edge layer alpha with tween */
  ssFadeEdgeLayerAlpha(to: number, duration = 600): void {
    this.ssTween(this.edgeLayer, 'alpha', this.edgeLayer.alpha, to, duration);
  }

  /** Reset edge layer alpha to 1 */
  ssResetEdgeLayerAlpha(): void {
    this.edgeLayer.alpha = 1;
  }

  // ========= Coordinate Helpers =========

  /** Convert node world position to screen coordinates */
  ssNodeToScreen(nodeId: string | number): { x: number; y: number } | null {
    if (!this.viewport) return null;
    const node = this.nodeById.get(nodeId);
    if (!node || node.x == null || node.y == null) return null;
    const p = this.viewport.toScreen(node.x, node.y);
    return { x: p.x, y: p.y };
  }

  /** Get current screen dimensions */
  ssGetScreenSize(): { w: number; h: number } {
    if (!this.app) return { w: 800, h: 600 };
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  /** Get node world position (for beam drawing) */
  ssGetNodeWorldPos(nodeId: string | number): { x: number; y: number } | null {
    const node = this.nodeById.get(nodeId);
    if (!node || node.x == null || node.y == null) return null;
    return { x: node.x, y: node.y };
  }

  /** Draw an animated beam line from point A to B that fades out and self-destructs */
  ssDrawBeam(fromX: number, fromY: number, toX: number, toY: number, color: number, duration = 600): void {
    if (!this.viewport) return;
    const beam = new Graphics();
    beam.moveTo(fromX, fromY);
    beam.lineTo(toX, toY);
    beam.stroke({ width: 2, color, alpha: 0.8 });
    this.edgeLayer.addChild(beam);
    this.ssTween(beam, 'alpha', 0.8, 0, duration, easeOutCubic, () => {
      beam.removeFromParent();
      beam.destroy();
    });
  }
}
