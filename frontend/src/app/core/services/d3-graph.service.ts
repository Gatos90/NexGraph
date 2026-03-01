import { Injectable, NgZone, inject } from '@angular/core';
import { Subject } from 'rxjs';
import * as d3 from 'd3';
import { GraphNode, GraphEdge, FilteredGraphData, LayoutMode } from '../models/graph.model';
import { NODE_COLORS, EDGE_COLORS, NODE_SIZES, FOCUS_COLORS, REPO_COLORS } from '../constants/colors';
import type { GitFileInfo, GitOverlayMode } from '../models/api.model';

export interface NodeEvent {
  node: GraphNode;
  event: MouseEvent;
}

@Injectable({ providedIn: 'root' })
export class D3GraphService {
  private zone = inject(NgZone);

  // Event subjects
  readonly nodeClicked$ = new Subject<NodeEvent>();
  readonly nodeHovered$ = new Subject<NodeEvent>();
  readonly nodeUnhovered$ = new Subject<void>();

  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private svgGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private simulation: d3.Simulation<GraphNode, GraphEdge> | null = null;
  private minimapSvg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private minimapTimer: ReturnType<typeof setTimeout> | null = null;
  private defsInitialized = false;
  private isInitialBuild = true;
  private lastLayoutMode: LayoutMode | null = null;

  initialize(svgEl: SVGSVGElement): void {
    this.svg = d3.select(svgEl);
  }

  setMinimapElement(el: SVGSVGElement | null): void {
    this.minimapSvg = el ? d3.select(el) : null;
  }

  buildGraph(
    data: FilteredGraphData,
    layoutMode: LayoutMode,
    dimensions: { width: number; height: number },
    positions?: Record<string, { x: number; y: number }>,
  ): void {
    if (!this.svg) return;
    const { width, height } = dimensions;

    this.zone.runOutsideAngular(() => {
      this.initDefs();

      // Determine if we should preserve the current zoom (filter change, not a layout switch or first load)
      const layoutChanged = this.lastLayoutMode !== null && this.lastLayoutMode !== layoutMode;
      const shouldFit = this.isInitialBuild || layoutChanged;

      // Save current zoom transform before destroying the old graph
      const svgNode = this.svg!.node()!;
      const savedTransform = this.zoomBehavior ? d3.zoomTransform(svgNode) : null;

      if (this.svgGroup) this.svgGroup.remove();
      this.svgGroup = this.svg!.append('g').attr('class', 'nxg-graph-group');

      // Zoom — throttled minimap + label visibility
      this.zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 5])
        .on('zoom', (event) => {
          this.svgGroup!.attr('transform', event.transform);
          const k = event.transform.k;
          // Hide labels when zoomed out to reduce paint cost
          this.svgGroup!.selectAll('.nxg-node-label').attr('display', k < 0.5 ? 'none' : null);
          // Throttle minimap updates (500ms)
          if (!this.minimapTimer) {
            this.minimapTimer = setTimeout(() => {
              this.minimapTimer = null;
              this.updateMinimap(data.nodes);
            }, 500);
          }
        });

      this.svg!.call(this.zoomBehavior);

      // Restore saved zoom transform for non-initial, same-layout rebuilds
      if (!shouldFit && savedTransform && savedTransform.k !== 1) {
        this.svg!.call(this.zoomBehavior.transform, savedTransform);
      }

      const { nodes, edges } = data;
      const nodeById = new Map(nodes.map(n => [n.id, n]));

      const validEdges = edges.filter(e => {
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

      // Links
      const linkGroup = this.svgGroup.append('g').attr('class', 'nxg-links');
      const link = linkGroup.selectAll('line')
        .data(validEdges)
        .enter()
        .append('line')
        .attr('data-source', (d: any) => typeof d.source === 'object' ? d.source.id : d.source)
        .attr('data-target', (d: any) => typeof d.target === 'object' ? d.target.id : d.target)
        .attr('stroke', (d: any) => d._isHubLink ? '#ff408030' : (d._isCrossRepo ? '#ff4080' : (EDGE_COLORS[d.rel] || '#333')))
        .attr('stroke-width', (d: any) => d._isHubLink ? 0.5 : (d._isCrossRepo ? 2.0 : (d.rel === 'IMPORTS' || d.rel === 'CALLS' ? 1.5 : 0.8)))
        .attr('stroke-opacity', (d: any) => {
          if (d._isHubLink) return 0.2;
          if (d._isExpandedRepoEdge) return 0.25;
          if (d._isCrossRepo) return 0.8;
          return (d.rel === 'IMPORTS' || d.rel === 'CALLS') ? 0.7 : 0.3;
        })
        .attr('stroke-dasharray', (d: any) => d._isHubLink ? '2,4' : (d._isCrossRepo ? '6,3' : null))
        .attr('marker-end', (d: any) => d._isHubLink ? null : `url(#arrow-${d._isCrossRepo ? 'CROSS_REPO' : d.rel})`);

      // Nodes
      const nodeGroup = this.svgGroup.append('g').attr('class', 'nxg-nodes');
      const node = nodeGroup.selectAll<SVGGElement, GraphNode>('g')
        .data(nodes, (d: GraphNode) => d.id as any)
        .enter()
        .append('g')
        .attr('class', 'nxg-node-group')
        .style('cursor', 'pointer');

      // Drag behavior
      const drag = d3.drag<SVGGElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) this.simulation?.alphaTarget(0.1).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) this.simulation?.alphaTarget(0);
          if (layoutMode === 'flow' || layoutMode === 'components') {
            d.fx = d.x;
            d.fy = d.y;
          } else {
            d.fx = null;
            d.fy = null;
          }
        });

      node.call(drag);

      // Hub nodes
      this.renderHubNodes(node);

      // Component nodes
      this.renderComponentNodes(node);

      // Regular nodes
      this.renderRegularNodes(node);

      // Interactions
      this.setupInteractions(node);

      // Background click to deselect
      this.svg!.on('click', () => {
        this.zone.run(() => {
          this.nodeClicked$.next({ node: null as any, event: null as any });
        });
      });

      // Simulation — optimized with faster convergence and throttled DOM writes
      let tickCount = 0;
      const tickSkip = nodes.length > 5000 ? 3 : (nodes.length > 1000 ? 2 : 1);
      const alphaDecay = nodes.length > 5000 ? 0.04 : 0.0228; // faster convergence for large graphs

      this.simulation = d3.forceSimulation<GraphNode>(nodes)
        .alphaDecay(alphaDecay)
        .velocityDecay(0.4)
        .force('link', d3.forceLink(validEdges)
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
          // Skip DOM writes on intermediate ticks for large graphs
          tickCount++;
          if (tickCount % tickSkip !== 0) return;

          link
            .attr('x1', (d: any) => d.source.x)
            .attr('y1', (d: any) => d.source.y)
            .attr('x2', (d: any) => d.target.x)
            .attr('y2', (d: any) => d.target.y);

          node.attr('transform', (d: GraphNode) => `translate(${d.x},${d.y})`);
        });

      // Only auto-fit on initial build or layout change; otherwise preserve user zoom
      const fitOnEnd = shouldFit;

      this.simulation.on('end', () => {
        if (fitOnEnd) this.fitGraph();
        this.updateMinimap(nodes);
      });

      // Flow / Components layout: apply dagre positions
      if ((layoutMode === 'flow' || layoutMode === 'components') && positions) {
        nodes.forEach(n => {
          const pos = positions[String(n.id)];
          if (pos) {
            n.x = n.fx = pos.x;
            n.y = n.fy = pos.y;
          }
        });
        this.simulation.alpha(0).stop();
        link
          .attr('x1', (d: any) => d.source.x)
          .attr('y1', (d: any) => d.source.y)
          .attr('x2', (d: any) => d.target.x)
          .attr('y2', (d: any) => d.target.y);
        node.attr('transform', (d: GraphNode) => `translate(${d.x},${d.y})`);
        setTimeout(() => {
          if (fitOnEnd) this.fitGraph();
          this.updateMinimap(nodes);
        }, 50);
      } else {
        nodes.forEach(n => {
          n.fx = null;
          n.fy = null;
        });
        setTimeout(() => this.updateMinimap(nodes), 500);
      }

      // Update tracking state
      this.isInitialBuild = false;
      this.lastLayoutMode = layoutMode;
    });
  }

  applyFocus(
    focusNodeId: string | number | null,
    neighborIds: Set<string | number>,
    focusMode: boolean,
  ): void {
    if (!this.svgGroup) return;

    this.zone.runOutsideAngular(() => {
      const group = this.svgGroup!;

      if (!focusMode || !focusNodeId) {
        // Remove focus-active class — CSS transitions handle the restore
        group.classed('focus-active', false);
        group.selectAll('.nxg-node-group').classed('focus-in', false);
        group.selectAll('.nxg-links line').classed('focus-in', false)
          .attr('stroke', (d: any) => d._isHubLink ? '#ff408030' : (d._isCrossRepo ? '#ff4080' : (EDGE_COLORS[d.rel] || '#333')))
          .attr('stroke-width', (d: any) => d._isHubLink ? 0.5 : (d._isCrossRepo ? 2.0 : (d.rel === 'IMPORTS' || d.rel === 'CALLS' ? 1.5 : 0.8)))
          .attr('marker-end', (d: any) => d._isHubLink ? null : `url(#arrow-${d._isCrossRepo ? 'CROSS_REPO' : d.rel})`);
        return;
      }

      // Toggle CSS class on group — CSS dims everything not marked .focus-in
      group.classed('focus-active', true);

      // Mark neighbor nodes (O(n) pass, but only toggles a class — no transitions)
      group.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
        .classed('focus-in', (d: any) => neighborIds.has(d.id));

      // Mark neighbor edges and restyle only the visible ones
      group.selectAll<SVGLineElement, any>('.nxg-links line')
        .each(function (d: any) {
          const srcId = typeof d.source === 'object' ? d.source.id : d.source;
          const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
          const isVisible = neighborIds.has(srcId) && neighborIds.has(tgtId);
          const el = d3.select(this);
          el.classed('focus-in', isVisible);

          if (isVisible) {
            // Only restyle visible edges (small subset)
            const isDirect = srcId === focusNodeId || tgtId === focusNodeId;
            if (srcId === focusNodeId) {
              el.attr('stroke', FOCUS_COLORS.outgoing)
                .attr('stroke-width', 2.5)
                .attr('marker-end', 'url(#arrow-focus-outgoing)');
            } else if (tgtId === focusNodeId) {
              el.attr('stroke', FOCUS_COLORS.incoming)
                .attr('stroke-width', 2.5)
                .attr('marker-end', 'url(#arrow-focus-incoming)');
            } else {
              el.attr('stroke', d._isCrossRepo ? '#ff4080' : (EDGE_COLORS[d.rel] || '#555'))
                .attr('stroke-width', d._isCrossRepo ? 2.0 : 1.0)
                .attr('marker-end', d._isHubLink ? null : `url(#arrow-${d._isCrossRepo ? 'CROSS_REPO' : d.rel})`);
            }
          }
        });
    });
  }

  fitGraph(): void {
    if (!this.svg || !this.svgGroup || !this.zoomBehavior) return;
    const svgEl = this.svg.node();
    if (!svgEl) return;
    const width = svgEl.clientWidth;
    const height = svgEl.clientHeight;
    const group = this.svgGroup.node();
    if (!group) return;
    const bbox = group.getBBox();
    if (bbox.width === 0 || bbox.height === 0) return;
    const padding = 60;
    const scale = Math.min(
      (width - padding * 2) / bbox.width,
      (height - padding * 2) / bbox.height,
      1.5,
    );
    const tx = width / 2 - (bbox.x + bbox.width / 2) * scale;
    const ty = height / 2 - (bbox.y + bbox.height / 2) * scale;
    this.svg.transition().duration(500)
      .call(this.zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  zoomIn(): void {
    if (!this.svg || !this.zoomBehavior) return;
    this.svg.transition().duration(300).call(this.zoomBehavior.scaleBy, 1.3);
  }

  zoomOut(): void {
    if (!this.svg || !this.zoomBehavior) return;
    this.svg.transition().duration(300).call(this.zoomBehavior.scaleBy, 0.7);
  }

  zoomToNode(nodeId: string | number): void {
    if (!this.svg || !this.svgGroup || !this.zoomBehavior) return;
    const nodeData = this.svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
      .data()
      .find(d => d.id === nodeId);
    if (nodeData && nodeData.x != null && nodeData.y != null) {
      this.svg.transition().duration(500)
        .call(this.zoomBehavior.translateTo, nodeData.x, nodeData.y);
    }
  }

  applyCommunityOverlay(
    enabled: boolean,
    communityMap: Map<string | number, string>,
    communityColors: Map<string, string>,
    activeCommunityId: string | null,
  ): void {
    if (!this.svgGroup) return;

    this.zone.runOutsideAngular(() => {
      if (!enabled) {
        this.svgGroup!.selectAll('.nxg-node-group')
          .style('opacity', null);
        this.svgGroup!.selectAll('.nxg-node-group .nxg-community-halo').remove();
        this.svgGroup!.selectAll('.nxg-links line')
          .style('opacity', null);
        return;
      }

      this.svgGroup!.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
        .each(function (d: GraphNode) {
          const group = d3.select(this);
          const communityId = communityMap.get(d.id);
          const color = communityId ? communityColors.get(communityId) : undefined;

          group.selectAll('.nxg-community-halo').remove();

          if (activeCommunityId) {
            if (communityId === activeCommunityId && color) {
              group.style('opacity', 1);
              const circle = group.select('circle');
              if (!circle.empty()) {
                const r = parseFloat(circle.attr('r')) || 5;
                group.insert('circle', ':first-child')
                  .attr('class', 'nxg-community-halo')
                  .attr('r', r + 5)
                  .attr('fill', 'none')
                  .attr('stroke', color)
                  .attr('stroke-width', 3)
                  .attr('opacity', 0.6);
              }
            } else {
              group.style('opacity', 0.15);
            }
          } else {
            if (color) {
              group.style('opacity', 1);
              const circle = group.select('circle');
              if (!circle.empty()) {
                const r = parseFloat(circle.attr('r')) || 5;
                group.insert('circle', ':first-child')
                  .attr('class', 'nxg-community-halo')
                  .attr('r', r + 4)
                  .attr('fill', 'none')
                  .attr('stroke', color)
                  .attr('stroke-width', 2.5)
                  .attr('opacity', 0.5);
              }
            } else {
              group.style('opacity', 0.15);
            }
          }
        });
    });
  }

  highlightProcess(
    processId: string | null,
    stepIds: (string | number)[],
  ): void {
    if (!this.svgGroup) return;

    this.zone.runOutsideAngular(() => {
      if (!processId || stepIds.length === 0) {
        this.svgGroup!.selectAll('.nxg-node-group')
          .style('opacity', null);
        this.svgGroup!.selectAll('.nxg-node-group .nxg-process-halo').remove();
        this.svgGroup!.selectAll('.nxg-links line')
          .style('opacity', null)
          .style('stroke-width', null)
          .style('stroke', null);
        return;
      }

      const stepSet = new Set(stepIds.map(String));
      const stepOrder = new Map<string, number>();
      stepIds.forEach((id, i) => stepOrder.set(String(id), i));
      const totalSteps = stepIds.length;
      const colorScale = d3.interpolateRgb('#22c55e', '#3b82f6');

      this.svgGroup!.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
        .each(function (d: GraphNode) {
          const group = d3.select(this);
          group.selectAll('.nxg-process-halo').remove();

          const nodeIdStr = String(d.id);
          if (stepSet.has(nodeIdStr)) {
            const idx = stepOrder.get(nodeIdStr) ?? 0;
            const t = totalSteps > 1 ? idx / (totalSteps - 1) : 0;
            const color = colorScale(t);

            group.style('opacity', 1);
            const circle = group.select('circle');
            if (!circle.empty()) {
              const r = parseFloat(circle.attr('r')) || 5;
              group.insert('circle', ':first-child')
                .attr('class', 'nxg-process-halo')
                .attr('r', r + 5)
                .attr('fill', 'none')
                .attr('stroke', color)
                .attr('stroke-width', 3)
                .attr('opacity', 0.7);
            }
          } else {
            group.style('opacity', 0.06);
          }
        });

      this.svgGroup!.selectAll<SVGLineElement, { source: unknown; target: unknown }>('.nxg-links line')
        .each(function () {
          const line = d3.select(this);
          const srcId = line.attr('data-source');
          const tgtId = line.attr('data-target');
          if (srcId && tgtId && stepSet.has(srcId) && stepSet.has(tgtId)) {
            line.style('opacity', 1)
              .style('stroke-width', '3px')
              .style('stroke', '#34d399');
          } else {
            line.style('opacity', 0.06);
          }
        });
    });
  }

  highlightDiffImpact(
    active: boolean,
    directIds: Set<string | number>,
    impactedIds: Set<string | number>,
  ): void {
    if (!this.svgGroup) return;

    this.zone.runOutsideAngular(() => {
      if (!active || (directIds.size === 0 && impactedIds.size === 0)) {
        this.svgGroup!.selectAll('.nxg-node-group')
          .style('opacity', null);
        this.svgGroup!.selectAll('.nxg-node-group .nxg-diff-halo').remove();
        this.svgGroup!.selectAll('.nxg-links line')
          .style('opacity', null);
        return;
      }

      const directSet = new Set([...directIds].map(String));
      const impactedSet = new Set([...impactedIds].map(String));

      this.svgGroup!.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
        .each(function (d: GraphNode) {
          const group = d3.select(this);
          group.selectAll('.nxg-diff-halo').remove();

          const nodeIdStr = String(d.id);
          const isDirect = directSet.has(nodeIdStr);
          const isImpacted = impactedSet.has(nodeIdStr);

          if (isDirect || isImpacted) {
            const color = isDirect ? '#ef4444' : '#f97316';
            group.style('opacity', 1);
            const circle = group.select('circle');
            if (!circle.empty()) {
              const r = parseFloat(circle.attr('r')) || 5;
              group.insert('circle', ':first-child')
                .attr('class', 'nxg-diff-halo')
                .attr('r', r + 5)
                .attr('fill', 'none')
                .attr('stroke', color)
                .attr('stroke-width', 3)
                .attr('opacity', 0.8);
            }
          } else {
            group.style('opacity', 0.08);
          }
        });

      this.svgGroup!.selectAll<SVGLineElement, unknown>('.nxg-links line')
        .each(function () {
          const line = d3.select(this);
          const srcId = line.attr('data-source');
          const tgtId = line.attr('data-target');
          const srcAffected = srcId && (directSet.has(srcId) || impactedSet.has(srcId));
          const tgtAffected = tgtId && (directSet.has(tgtId) || impactedSet.has(tgtId));
          line.style('opacity', (srcAffected && tgtAffected) ? 0.6 : 0.08);
        });
    });
  }

  applyGitOverlay(
    mode: GitOverlayMode,
    fileData: Map<string, GitFileInfo>,
    authorColors: Map<string, string>,
  ): void {
    if (!this.svgGroup) return;

    this.zone.runOutsideAngular(() => {
      // Clean up previous git overlay
      this.svgGroup!.selectAll('.nxg-node-group .nxg-git-halo').remove();

      if (mode === 'none' || fileData.size === 0) {
        this.svgGroup!.selectAll('.nxg-node-group')
          .style('opacity', null);
        this.svgGroup!.selectAll('.nxg-links line')
          .style('opacity', null);
        return;
      }

      const now = Date.now();

      this.svgGroup!.selectAll<SVGGElement, GraphNode>('.nxg-node-group')
        .each(function (d: GraphNode) {
          const group = d3.select(this);
          group.selectAll('.nxg-git-halo').remove();

          // Only File nodes have git data
          if (d.label !== 'File') {
            group.style('opacity', 0.1);
            return;
          }

          const filePath = (d.properties?.['path'] as string) || '';
          const info = fileData.get(filePath);

          if (!info) {
            group.style('opacity', 0.1);
            return;
          }

          group.style('opacity', 1);
          const circle = group.select('circle');
          if (circle.empty()) return;
          const baseR = parseFloat(circle.attr('r')) || 5;

          if (mode === 'freshness') {
            // Color by age: green (fresh) → yellow → orange → red (stale)
            const daysSince = (now - new Date(info.last_commit_date).getTime()) / 86400000;
            let color: string;
            if (daysSince < 7) color = '#22c55e';
            else if (daysSince < 30) color = '#eab308';
            else if (daysSince < 90) color = '#f97316';
            else color = '#ef4444';

            circle.style('fill', color);
            group.insert('circle', ':first-child')
              .attr('class', 'nxg-git-halo')
              .attr('r', baseR + 4)
              .attr('fill', 'none')
              .attr('stroke', color)
              .attr('stroke-width', 2)
              .attr('opacity', 0.6);
          } else if (mode === 'hotspots') {
            // Scale size and brightness by commit count
            const scaledR = baseR + Math.min(Math.log2(info.commit_count + 1) * 2, 12);
            const intensity = Math.min(info.commit_count / 30, 1);
            const color = d3.interpolateRgb('#3b82f6', '#ef4444')(intensity);

            circle.attr('r', scaledR).style('fill', color);
            group.insert('circle', ':first-child')
              .attr('class', 'nxg-git-halo')
              .attr('r', scaledR + 4)
              .attr('fill', 'none')
              .attr('stroke', color)
              .attr('stroke-width', 2 + intensity * 2)
              .attr('opacity', 0.5 + intensity * 0.3);
          } else if (mode === 'authors') {
            // Color by most recent author
            const authorColor = authorColors.get(info.last_author_email) || '#888';
            circle.style('fill', authorColor);
            group.insert('circle', ':first-child')
              .attr('class', 'nxg-git-halo')
              .attr('r', baseR + 4)
              .attr('fill', 'none')
              .attr('stroke', authorColor)
              .attr('stroke-width', 2)
              .attr('opacity', 0.6);
          }
        });

      // Dim edges
      this.svgGroup!.selectAll<SVGLineElement, unknown>('.nxg-links line')
        .style('opacity', 0.08);
    });
  }

  destroy(): void {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    if (this.svgGroup) {
      this.svgGroup.remove();
      this.svgGroup = null;
    }
    if (this.svg) {
      this.svg.on('.zoom', null);
      this.svg.on('click', null);
    }
    this.defsInitialized = false;
    this.isInitialBuild = true;
    this.lastLayoutMode = null;
  }

  getRenderedEdgeData(): GraphEdge[] {
    if (!this.svgGroup) return [];
    return this.svgGroup.selectAll<SVGLineElement, GraphEdge>('.nxg-links line').data();
  }

  getRenderedNodeData(): GraphNode[] {
    if (!this.svgGroup) return [];
    return this.svgGroup.selectAll<SVGGElement, GraphNode>('.nxg-nodes .nxg-node-group').data();
  }

  // --- Screensaver helpers ---

  getSvgGroup(): d3.Selection<SVGGElement, unknown, null, undefined> | null {
    return this.svgGroup;
  }

  getZoomTransform(): d3.ZoomTransform | null {
    if (!this.svg) return null;
    const node = this.svg.node();
    return node ? d3.zoomTransform(node) : null;
  }

  setZoomTransform(transform: d3.ZoomTransform, duration = 500): void {
    if (!this.svg || !this.zoomBehavior) return;
    if (duration > 0) {
      this.svg.transition().duration(duration)
        .call(this.zoomBehavior.transform, transform);
    } else {
      this.svg.call(this.zoomBehavior.transform, transform);
    }
  }

  interruptAll(): void {
    this.svg?.interrupt();
    this.svgGroup?.interrupt();
    this.svgGroup?.selectAll('*').interrupt();
  }

  private createRepoClusterForce(
    nodes: GraphNode[],
    width: number,
    height: number,
  ): (alpha: number) => void {
    // Group expanded-repo nodes by repoId and compute cluster targets
    const repoNodes = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      if (n._isExpandedRepo && n._repoId) {
        if (!repoNodes.has(n._repoId)) repoNodes.set(n._repoId, []);
        repoNodes.get(n._repoId)!.push(n);
      }
    }
    if (repoNodes.size === 0) return () => {};

    // Assign initial target positions around the center (spread repos out)
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

  private initDefs(): void {
    if (this.defsInitialized || !this.svg) return;
    const defs = this.svg.append('defs');

    // SVG glow filters removed — CSS drop-shadow used instead (much faster)

    // Arrow markers for each edge type
    const allMarkerColors: Record<string, string> = { ...EDGE_COLORS, CROSS_REPO: '#ff4080' };
    Object.entries(allMarkerColors).forEach(([type, color]) => {
      defs.append('marker')
        .attr('id', `arrow-${type}`)
        .attr('viewBox', '0 -3 6 6')
        .attr('refX', 12).attr('refY', 0)
        .attr('markerWidth', 5).attr('markerHeight', 5)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-3L6,0L0,3')
        .attr('fill', color)
        .attr('opacity', 0.6);
    });

    // Directional focus arrows
    const focusArrows: [string, string][] = [
      ['focus-outgoing', FOCUS_COLORS.outgoing],
      ['focus-incoming', FOCUS_COLORS.incoming],
    ];
    focusArrows.forEach(([name, color]) => {
      defs.append('marker')
        .attr('id', `arrow-${name}`)
        .attr('viewBox', '0 -3 6 6')
        .attr('refX', 12).attr('refY', 0)
        .attr('markerWidth', 6).attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-3L6,0L0,3')
        .attr('fill', color)
        .attr('opacity', 0.9);
    });

    this.defsInitialized = true;
  }

  private renderHubNodes(
    node: d3.Selection<SVGGElement, GraphNode, SVGGElement, unknown>,
  ): void {
    const hubs = node.filter((d: GraphNode) => !!d._isHub);

    hubs.append('rect')
      .attr('x', -60).attr('y', -20)
      .attr('width', 120).attr('height', 40)
      .attr('rx', 10).attr('ry', 10)
      .attr('fill', '#ff408018')
      .attr('stroke', '#ff4080')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '8,4');

    hubs.append('text')
      .text((d: GraphNode) => (d.properties?.['name'] as string) || '')
      .attr('text-anchor', 'middle')
      .attr('dy', -2)
      .attr('fill', '#ff4080')
      .attr('font-family', "'JetBrains Mono', monospace")
      .attr('font-size', '11px')
      .attr('font-weight', '700')
      .attr('pointer-events', 'none');

    hubs.append('text')
      .text((d: GraphNode) => `${d.properties?.['edge_count'] || 0} connections`)
      .attr('text-anchor', 'middle')
      .attr('dy', 13)
      .attr('fill', '#ff408090')
      .attr('font-family', "'DM Sans', sans-serif")
      .attr('font-size', '9px')
      .attr('pointer-events', 'none');
  }

  private renderComponentNodes(
    node: d3.Selection<SVGGElement, GraphNode, SVGGElement, unknown>,
  ): void {
    const compNodes = node.filter((d: GraphNode) => !!d._isComponent);

    const getCompColor = (d: GraphNode): { fill: string; stroke: string } => {
      const c = d._childCounts || {};
      if (c['RouteHandler']) return { fill: '#ff904018', stroke: '#ff9040' };
      if (c['Class']) return { fill: '#ff609018', stroke: '#ff6090' };
      if (c['Interface']) return { fill: '#60d0ff18', stroke: '#60d0ff' };
      return { fill: '#4a9eff18', stroke: '#4a9eff' };
    };

    compNodes.append('rect')
      .attr('x', (d: GraphNode) => {
        const w = Math.min(Math.max(((d.properties?.['name'] as string) || '').length * 7 + 20, 100), 200);
        return -w / 2;
      })
      .attr('y', -22)
      .attr('width', (d: GraphNode) => Math.min(Math.max(((d.properties?.['name'] as string) || '').length * 7 + 20, 100), 200))
      .attr('height', 44)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', (d: GraphNode) => getCompColor(d).fill)
      .attr('stroke', (d: GraphNode) => getCompColor(d).stroke)
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.95);

    compNodes.append('text')
      .text((d: GraphNode) => {
        const name = (d.properties?.['name'] as string) || '';
        return name.length > 26 ? name.slice(0, 24) + '...' : name;
      })
      .attr('text-anchor', 'middle')
      .attr('dy', -5)
      .attr('fill', (d: GraphNode) => getCompColor(d).stroke)
      .attr('font-family', "'JetBrains Mono', monospace")
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .attr('pointer-events', 'none');

    compNodes.append('text')
      .text((d: GraphNode) => (d.properties?.['summary'] as string) || 'empty')
      .attr('text-anchor', 'middle')
      .attr('dy', 10)
      .attr('fill', 'var(--text-dim)')
      .attr('font-family', "'DM Sans', sans-serif")
      .attr('font-size', '8px')
      .attr('pointer-events', 'none');
  }

  private renderRegularNodes(
    node: d3.Selection<SVGGElement, GraphNode, SVGGElement, unknown>,
  ): void {
    const regular = node.filter((d: GraphNode) => !d._isHub && !d._isComponent);

    // Colored outer ring for expanded-repo nodes
    regular.filter((d: GraphNode) => !!d._isExpandedRepo)
      .append('circle')
      .attr('class', 'nxg-repo-ring')
      .attr('r', (d: GraphNode) => (NODE_SIZES[d.label] || 5) + 3)
      .attr('fill', 'none')
      .attr('stroke', (d: GraphNode) => d._repoColor || '#888')
      .attr('stroke-width', 2)
      .attr('opacity', 0.7);

    regular.append('circle')
      .attr('r', (d: GraphNode) => NODE_SIZES[d.label] || 5)
      .attr('fill', (d: GraphNode) => d._isPhantom ? 'transparent' : (NODE_COLORS[d.label]?.fill || '#666'))
      .attr('stroke', (d: GraphNode) => NODE_COLORS[d.label]?.stroke || '#444')
      .attr('stroke-width', (d: GraphNode) => d._isPhantom ? 2 : 1.5)
      .attr('stroke-dasharray', (d: GraphNode) => d._isPhantom ? '3,2' : null)
      .attr('opacity', 0.9);

    regular.append('text')
      .attr('class', 'nxg-node-label')
      .text((d: GraphNode) => {
        const name = this.getNodeName(d);
        return name.length > 20 ? name.slice(0, 18) + '...' : name;
      })
      .attr('dx', (d: GraphNode) => (NODE_SIZES[d.label] || 5) + 4)
      .attr('dy', 3)
      .attr('fill', (d: GraphNode) => NODE_COLORS[d.label]?.fill || '#888')
      .attr('font-family', "'JetBrains Mono', monospace")
      .attr('font-size', (d: GraphNode) => d.label === 'Folder' ? '9px' : '8px')
      .attr('font-weight', (d: GraphNode) => d.label === 'Folder' ? '600' : '400')
      .attr('opacity', 0.85)
      .attr('pointer-events', 'none');
  }

  private setupInteractions(
    node: d3.Selection<SVGGElement, GraphNode, SVGGElement, unknown>,
  ): void {
    node
      .on('mouseover', (event: MouseEvent, d: GraphNode) => {
        // CSS class handles the visual effect (drop-shadow) — no SVG filters or transitions
        d3.select(event.currentTarget as SVGGElement).classed('nxg-hovered', true);
        this.zone.run(() => this.nodeHovered$.next({ node: d, event }));
      })
      .on('mousemove', (event: MouseEvent, d: GraphNode) => {
        this.zone.run(() => this.nodeHovered$.next({ node: d, event }));
      })
      .on('mouseout', (event: MouseEvent, d: GraphNode) => {
        d3.select(event.currentTarget as SVGGElement).classed('nxg-hovered', false);
        this.zone.run(() => this.nodeUnhovered$.next());
      })
      .on('click', (event: MouseEvent, d: GraphNode) => {
        event.stopPropagation();
        this.zone.run(() => this.nodeClicked$.next({ node: d, event }));
      });
  }

  private updateMinimap(nodes: GraphNode[]): void {
    if (!this.minimapSvg || !nodes.length) {
      this.minimapSvg?.selectAll('circle').remove();
      return;
    }

    const filtered = nodes.filter(n => n.x != null && n.y != null);
    if (!filtered.length) {
      this.minimapSvg.selectAll('circle').remove();
      return;
    }

    const xs = filtered.map(n => n.x || 0);
    const ys = filtered.map(n => n.y || 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rangeX = (maxX - minX) || 1;
    const rangeY = (maxY - minY) || 1;
    const pad = 10;
    const mw = 160 - pad * 2;
    const mh = 120 - pad * 2;
    const scale = Math.min(mw / rangeX, mh / rangeY);

    const circles = this.minimapSvg.selectAll<SVGCircleElement, GraphNode>('circle')
      .data(filtered, (d: GraphNode) => d.id as any);
    circles.exit().remove();
    circles.enter().append('circle')
      .attr('r', 1.5)
      .attr('opacity', 0.8)
      .merge(circles)
      .attr('cx', (d: GraphNode) => pad + ((d.x || 0) - minX) * scale)
      .attr('cy', (d: GraphNode) => pad + ((d.y || 0) - minY) * scale)
      .attr('fill', (d: GraphNode) => d._isExpandedRepo && d._repoColor ? d._repoColor : (NODE_COLORS[d.label]?.fill || '#666'));
  }

  private getNodeName(d: GraphNode): string {
    const p = d.properties;
    if (d.label === 'RouteHandler') {
      return `${p?.['http_method'] || '?'} ${p?.['url_pattern'] || p?.['name'] || ''}`;
    }
    return (p?.['name'] as string) || (p?.['path'] as string) || `node-${d.id}`;
  }
}
