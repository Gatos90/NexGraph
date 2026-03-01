import { Injectable } from '@angular/core';
import { GraphNode, GraphEdge } from '../models/graph.model';
import { FLOW_EDGE_TYPES } from '../constants/types';
import * as dagre from 'dagre';

@Injectable({ providedIn: 'root' })
export class LayoutService {
  computeFlowLayout(
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): Record<string, { x: number; y: number }> {
    const g = new dagre.graphlib.Graph({ compound: true });
    g.setGraph({
      rankdir: 'LR',
      nodesep: 20,
      ranksep: 100,
      marginx: 40,
      marginy: 40,
      ranker: 'tight-tree',
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Build file->children map for compound grouping
    const nodeById = new Map(nodes.map(n => [String(n.id), n]));
    const fileChildren = new Map<string, string[]>();

    edges.forEach(e => {
      if (e.rel !== 'DEFINES' && e.rel !== 'CONTAINS') return;
      const srcId = String(typeof e.source === 'object' ? (e.source as GraphNode).id : e.source);
      const tgtId = String(typeof e.target === 'object' ? (e.target as GraphNode).id : e.target);
      const srcNode = nodeById.get(srcId);
      if (srcNode && (srcNode.label === 'File' || srcNode.label === 'Folder')) {
        if (!fileChildren.has(srcId)) fileChildren.set(srcId, []);
        fileChildren.get(srcId)!.push(tgtId);
      }
    });

    // Add nodes with appropriate sizes
    nodes.forEach(n => {
      const id = String(n.id);
      if (n._isComponent) {
        const nameLen = ((n.properties?.['name'] as string) || '').length;
        g.setNode(id, { width: Math.min(Math.max(nameLen * 7 + 20, 100), 200), height: 44 });
      } else if (n._isHub) {
        g.setNode(id, { width: 120, height: 40 });
      } else if (n.label === 'File' || n.label === 'Folder') {
        g.setNode(id, { width: 100, height: 30 });
      } else {
        const nameLen = this.getNodeName(n).length;
        g.setNode(id, { width: Math.min(nameLen * 5.5 + 20, 140), height: 22 });
      }
    });

    // Add only flow edges for ranking
    const nodeIdSet = new Set(nodes.map(n => String(n.id)));
    let flowEdgeCount = 0;
    edges.forEach(e => {
      if (!FLOW_EDGE_TYPES.has(e.rel)) return;
      const srcId = String(typeof e.source === 'object' ? (e.source as GraphNode).id : e.source);
      const tgtId = String(typeof e.target === 'object' ? (e.target as GraphNode).id : e.target);
      if (nodeIdSet.has(srcId) && nodeIdSet.has(tgtId) && srcId !== tgtId) {
        g.setEdge(srcId, tgtId);
        flowEdgeCount++;
      }
    });

    // If very few flow edges, also add DEFINES to give structure
    if (flowEdgeCount < 5) {
      edges.forEach(e => {
        if (e.rel !== 'DEFINES') return;
        const srcId = String(typeof e.source === 'object' ? (e.source as GraphNode).id : e.source);
        const tgtId = String(typeof e.target === 'object' ? (e.target as GraphNode).id : e.target);
        if (nodeIdSet.has(srcId) && nodeIdSet.has(tgtId) && srcId !== tgtId) {
          g.setEdge(srcId, tgtId);
        }
      });
    }

    dagre.layout(g);

    const positions: Record<string, { x: number; y: number }> = {};
    g.nodes().forEach(id => {
      const node = g.node(id);
      if (node) positions[id] = { x: node.x, y: node.y };
    });
    return positions;
  }

  private getNodeName(d: GraphNode): string {
    const p = d.properties;
    if (d.label === 'RouteHandler') {
      return `${p?.['http_method'] || '?'} ${p?.['url_pattern'] || p?.['name'] || ''}`;
    }
    return (p?.['name'] as string) || (p?.['path'] as string) || `node-${d.id}`;
  }
}
