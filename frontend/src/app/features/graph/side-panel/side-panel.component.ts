import { Component, inject, signal, effect, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { D3GraphService } from '../../../core/services/d3-graph.service';
import { PixiGraphService } from '../../../core/services/pixi-graph.service';
import { ApiService } from '../../../core/services/api.service';
import { GraphNode, NodeDetail, RelationshipEntry, GraphEdge } from '../../../core/models/graph.model';
import { NODE_COLORS, EDGE_COLORS } from '../../../core/constants/colors';

interface EdgeItem {
  nodeId: string | number;
  nodeName: string;
  nodeColor: string;
  edgeLabel: string;
  edgeColor: string;
  direction: 'incoming' | 'outgoing';
  confidence?: number;
}

@Component({
  selector: 'app-side-panel',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './side-panel.component.html',
  styleUrl: './side-panel.component.scss',
})
export class SidePanelComponent {
  readonly navigateToNode = output<string | number>();

  private state = inject(GraphStateService);
  private d3Graph = inject(D3GraphService);
  private pixiGraph = inject(PixiGraphService);
  private api = inject(ApiService);

  private get activeRenderer(): D3GraphService | PixiGraphService {
    return this.state.rendererMode() === 'webgl' ? this.pixiGraph : this.d3Graph;
  }

  readonly isOpen = this.state.sidePanelOpen;
  readonly selectedNode = signal<GraphNode | null>(null);
  readonly nodeLabel = signal('');
  readonly nodeName = signal('');
  readonly nodeColor = signal('#888');
  readonly nodeRepoBadge = signal('');
  readonly nodeRepoColor = signal('');
  readonly properties = signal<Array<{ key: string; value: string }>>([]);
  readonly incomingEdges = signal<EdgeItem[]>([]);
  readonly outgoingEdges = signal<EdgeItem[]>([]);
  readonly crossRepoLinks = signal<EdgeItem[]>([]);
  readonly componentChildren = signal<Array<{ type: string; count: number; color: string }>>([]);
  readonly hubPhantoms = signal<Array<{ id: string; name: string }>>([]);
  readonly loading = signal(false);

  constructor() {
    effect(() => {
      const nodeId = this.state.selectedNodeId();
      if (nodeId == null) {
        this.selectedNode.set(null);
        return;
      }
      this.loadNodeData(nodeId);
    });
  }

  close(): void {
    this.state.closeSidePanel();
  }

  onEdgeClick(item: EdgeItem): void {
    this.navigateToNode.emit(item.nodeId);
  }

  onPhantomClick(id: string): void {
    this.navigateToNode.emit(id);
  }

  private async loadNodeData(nodeId: string | number): Promise<void> {
    // Find node in state — check local, cross-repo, expanded repos, and rendered nodes (components view)
    let node = this.state.allNodes().find(n => n.id === nodeId);
    if (!node) node = this.state.crossRepoNodes().find(n => n.id === nodeId);
    if (!node) {
      for (const [, data] of this.state.expandedRepos()) {
        node = data.nodes.find(n => n.id === nodeId);
        if (node) break;
      }
    }
    // Check rendered nodes (covers component nodes in components layout)
    if (!node) node = this.activeRenderer.getRenderedNodeData().find(n => n.id === nodeId);
    if (!node) return;

    this.selectedNode.set(node);
    const color = NODE_COLORS[node.label]?.fill || '#888';
    this.nodeColor.set(color);
    this.nodeLabel.set(node._isPhantom && !node._isHub ? 'Cross-Repo' : node.label);
    this.nodeName.set(this.getNodeName(node));
    this.nodeRepoBadge.set(node._isExpandedRepo ? (node._repoName || '') : '');
    this.nodeRepoColor.set(node._isExpandedRepo ? (node._repoColor || '') : '');

    // Clear previous
    this.properties.set([]);
    this.incomingEdges.set([]);
    this.outgoingEdges.set([]);
    this.crossRepoLinks.set([]);
    this.componentChildren.set([]);
    this.hubPhantoms.set([]);

    if (node._isComponent) {
      this.loadComponentData(node);
    } else if (node._isHub) {
      this.loadHubData(node);
    } else if (node._isPhantom) {
      this.loadPhantomData(node);
    } else {
      await this.loadRegularNodeData(node);
    }
  }

  private loadComponentData(node: GraphNode): void {
    const counts = node._childCounts || {};
    const children: Array<{ type: string; count: number; color: string }> = [];
    Object.entries(counts).forEach(([type, count]) => {
      children.push({ type, count, color: NODE_COLORS[type]?.fill || '#888' });
    });
    this.componentChildren.set(children);

    this.properties.set([
      { key: 'File', value: (node.properties?.['path'] as string) || (node.properties?.['name'] as string) || '' },
      { key: 'Symbols', value: (node.properties?.['summary'] as string) || '' },
    ]);

    // Find inter-component edges from current rendered edges
    const renderedEdges = this.activeRenderer.getRenderedEdgeData();
    const incoming = this.buildEdgeItems(renderedEdges, node.id, 'incoming');
    const outgoing = this.buildEdgeItems(renderedEdges, node.id, 'outgoing');
    this.incomingEdges.set(incoming);
    this.outgoingEdges.set(outgoing);
  }

  private loadHubData(node: GraphNode): void {
    this.properties.set([
      { key: 'Name', value: (node.properties?.['name'] as string) || '' },
      { key: 'URL', value: (node.properties?.['url'] as string) || '' },
      { key: 'Connections', value: (node.properties?.['conn_types'] as string) || '' },
      { key: 'Linked Symbols', value: String(node.properties?.['phantom_count'] || 0) },
      { key: 'Total Edges', value: String(node.properties?.['edge_count'] || 0) },
    ].filter(p => p.value));

    const phantoms = this.state.crossRepoNodes()
      .filter(n => n._repoId === node._repoId && !n._isHub)
      .map(n => ({ id: n.id as string, name: (n.properties?.['name'] as string) || String(n.id) }));
    this.hubPhantoms.set(phantoms);
  }

  private loadPhantomData(node: GraphNode): void {
    const props = node.properties || {};
    this.properties.set(
      Object.entries(props)
        .filter(([k]) => k !== 'content_hash')
        .map(([k, v]) => ({ key: k, value: this.truncate(String(v), 40) })),
    );
    this.loadCrossRepoLinksForNode(node);
  }

  private async loadRegularNodeData(node: GraphNode): Promise<void> {
    // Always show node properties as baseline
    this.properties.set(
      Object.entries(node.properties || {})
        .filter(([k]) => k !== 'content_hash')
        .map(([k, v]) => ({ key: k, value: this.truncate(String(v), 40) })),
    );

    // Use the node's own repoId for expanded-repo nodes, stripping the prefix from the ID
    let apiRepoId = this.state.repoId();
    let apiNodeId: string | number = node.id;

    if (node._isExpandedRepo && node._repoId) {
      apiRepoId = node._repoId;
      // Strip the `repo_{repoId}_` prefix to get the original node ID
      const prefix = `repo_${node._repoId}_`;
      const idStr = String(node.id);
      apiNodeId = idStr.startsWith(prefix) ? idStr.slice(prefix.length) : node.id;
    }

    if (apiRepoId) {
      this.loading.set(true);
      try {
        const detail = await this.api.getNodeDetail(apiRepoId, apiNodeId).toPromise();
        if (detail) {
          this.renderNodeDetail(detail, node);
        }
      } catch {
        // Keep baseline properties already set above
      } finally {
        this.loading.set(false);
      }
    }

    this.loadCrossRepoLinksForNode(node);
  }

  private renderNodeDetail(detail: NodeDetail, originalNode: GraphNode): void {
    const props = detail.node.properties || {};
    this.properties.set(
      Object.entries(props)
        .filter(([k]) => k !== 'content_hash')
        .map(([k, v]) => ({ key: k, value: this.truncate(String(v), 40) })),
    );

    const incoming: EdgeItem[] = (detail.relationships?.incoming || []).map(rel => ({
      nodeId: rel.source.id,
      nodeName: (rel.source.properties?.['name'] as string) || (rel.source.properties?.['path'] as string) || `#${rel.source.id}`,
      nodeColor: NODE_COLORS[rel.source.label]?.fill || '#888',
      edgeLabel: rel.edge.label,
      edgeColor: EDGE_COLORS[rel.edge.label] || '#888',
      direction: 'incoming' as const,
    }));

    const outgoing: EdgeItem[] = (detail.relationships?.outgoing || []).map(rel => ({
      nodeId: rel.target.id,
      nodeName: (rel.target.properties?.['name'] as string) || (rel.target.properties?.['path'] as string) || `#${rel.target.id}`,
      nodeColor: NODE_COLORS[rel.target.label]?.fill || '#888',
      edgeLabel: rel.edge.label,
      edgeColor: EDGE_COLORS[rel.edge.label] || '#888',
      direction: 'outgoing' as const,
    }));

    this.incomingEdges.set(incoming);
    this.outgoingEdges.set(outgoing);
  }

  private loadCrossRepoLinksForNode(node: GraphNode): void {
    const crossEdges = this.state.crossRepoEdges();
    const crossNodes = this.state.crossRepoNodes();

    const xLinks = crossEdges.filter(e => {
      const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
      return srcId === node.id || tgtId === node.id;
    });

    if (xLinks.length) {
      const items: EdgeItem[] = xLinks.map(link => {
        const srcId = typeof link.source === 'object' ? (link.source as GraphNode).id : link.source;
        const tgtId = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target;
        const isOutgoing = srcId === node.id;
        const remoteId = isOutgoing ? tgtId : srcId;
        const remoteNode = crossNodes.find(n => n.id === remoteId);
        const remoteName = (remoteNode?.properties?.['name'] as string) || String(remoteId);
        return {
          nodeId: remoteId,
          nodeName: `${isOutgoing ? '→' : '←'} ${remoteName}`,
          nodeColor: '#ff4080',
          edgeLabel: link.rel,
          edgeColor: '#ff4080',
          direction: isOutgoing ? 'outgoing' as const : 'incoming' as const,
          confidence: link._confidence,
        };
      });
      this.crossRepoLinks.set(items);
    }
  }

  private buildEdgeItems(
    edges: GraphEdge[],
    nodeId: string | number,
    direction: 'incoming' | 'outgoing',
  ): EdgeItem[] {
    const filtered = direction === 'incoming'
      ? edges.filter(e => {
          const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
          return tgtId === nodeId;
        })
      : edges.filter(e => {
          const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
          return srcId === nodeId;
        });

    const expandedNodes: GraphNode[] = [];
    for (const [, data] of this.state.expandedRepos()) {
      expandedNodes.push(...data.nodes);
    }
    const allRenderedNodes = [...this.state.allNodes(), ...this.state.crossRepoNodes(), ...expandedNodes];

    return filtered.map(e => {
      const otherId = direction === 'incoming'
        ? (typeof e.source === 'object' ? (e.source as GraphNode).id : e.source)
        : (typeof e.target === 'object' ? (e.target as GraphNode).id : e.target);
      const otherNode = allRenderedNodes.find(n => n.id === otherId);
      return {
        nodeId: otherId,
        nodeName: (otherNode?.properties?.['name'] as string) || String(otherId),
        nodeColor: NODE_COLORS[otherNode?.label || '']?.fill || '#888',
        edgeLabel: e.rel,
        edgeColor: EDGE_COLORS[e.rel] || '#888',
        direction,
      };
    });
  }

  private getNodeName(d: GraphNode): string {
    const p = d.properties;
    if (d.label === 'RouteHandler') {
      return `${p?.['http_method'] || '?'} ${p?.['url_pattern'] || p?.['name'] || ''}`;
    }
    return (p?.['name'] as string) || (p?.['path'] as string) || `node-${d.id}`;
  }

  private truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max - 2) + '...' : str;
  }
}
