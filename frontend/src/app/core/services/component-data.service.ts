import { Injectable } from '@angular/core';
import { GraphNode, GraphEdge, FilteredGraphData } from '../models/graph.model';
import { SYMBOL_NODE_TYPES, COMPONENT_EDGE_TYPES } from '../constants/types';

@Injectable({ providedIn: 'root' })
export class ComponentDataService {
  buildComponentData(
    filteredData: FilteredGraphData,
    crossRepoNodes: GraphNode[],
    crossRepoEdges: GraphEdge[],
    showCrossRepo: boolean,
  ): FilteredGraphData {
    const { nodes: rawNodes, edges: rawEdges } = filteredData;

    // 1. Map each child symbol -> its parent File via DEFINES/CONTAINS edges
    const childToFile = new Map<string | number, string | number>();
    const fileNodes = new Map<string | number, GraphNode>();

    rawNodes.forEach(n => {
      if (n.label === 'File') fileNodes.set(n.id, n);
    });

    rawEdges.forEach(e => {
      if (e.rel !== 'DEFINES' && e.rel !== 'CONTAINS') return;
      const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
      const srcNode = rawNodes.find(n => n.id === srcId);
      const tgtNode = rawNodes.find(n => n.id === tgtId);
      if (srcNode && srcNode.label === 'File' && tgtNode && SYMBOL_NODE_TYPES.has(tgtNode.label)) {
        childToFile.set(tgtId, srcId);
      }
    });

    // 2. Build component nodes — one per File that has children
    const componentNodes: GraphNode[] = [];
    const fileChildCounts = new Map<string | number, Record<string, number>>();

    rawNodes.forEach(n => {
      if (!SYMBOL_NODE_TYPES.has(n.label)) return;
      const fileId = childToFile.get(n.id);
      if (fileId == null) return;
      if (!fileChildCounts.has(fileId)) fileChildCounts.set(fileId, {});
      const counts = fileChildCounts.get(fileId)!;
      counts[n.label] = (counts[n.label] || 0) + 1;
    });

    fileChildCounts.forEach((counts, fileId) => {
      const fileNode = fileNodes.get(fileId);
      if (!fileNode) return;
      const fileName = (fileNode.properties?.['name'] as string) || (fileNode.properties?.['path'] as string) || String(fileId);
      const parts: string[] = [];
      if (counts['RouteHandler']) parts.push(`${counts['RouteHandler']} Route${counts['RouteHandler'] > 1 ? 's' : ''}`);
      if (counts['Function']) parts.push(`${counts['Function']} Fn`);
      if (counts['Class']) parts.push(`${counts['Class']} Class`);
      if (counts['Interface']) parts.push(`${counts['Interface']} Iface`);
      if (counts['Method']) parts.push(`${counts['Method']} Method`);
      if (counts['CodeElement']) parts.push(`${counts['CodeElement']} Elem`);
      const summary = parts.join(', ');
      const totalChildren = Object.values(counts).reduce((a, b) => a + b, 0);

      componentNodes.push({
        id: `comp_${fileId}`,
        label: '_Component',
        _isComponent: true,
        _fileId: fileId,
        _childCount: totalChildren,
        _childCounts: counts,
        properties: {
          name: fileName,
          path: fileNode.properties?.['path'] || '',
          summary,
          childCount: totalChildren,
        },
      });
    });

    // Include Files with no children but that participate in IMPORTS edges
    fileNodes.forEach((fileNode, fileId) => {
      if (fileChildCounts.has(fileId)) return;
      const hasImports = rawEdges.some(e => {
        if (e.rel !== 'IMPORTS') return false;
        const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
        const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
        return srcId === fileId || tgtId === fileId;
      });
      if (hasImports) {
        const fileName = (fileNode.properties?.['name'] as string) || String(fileId);
        componentNodes.push({
          id: `comp_${fileId}`,
          label: '_Component',
          _isComponent: true,
          _fileId: fileId,
          _childCount: 0,
          _childCounts: {},
          properties: { name: fileName, path: fileNode.properties?.['path'] || '', summary: 'no symbols', childCount: 0 },
        });
      }
    });

    // 3. Build inter-component edges
    const nodeToComp = new Map<string | number, string>();
    componentNodes.forEach(cn => {
      nodeToComp.set(cn._fileId!, cn.id as string);
    });
    childToFile.forEach((fileId, childId) => {
      const compId = nodeToComp.get(fileId);
      if (compId) nodeToComp.set(childId, compId);
    });

    const compEdgeSet = new Set<string>();
    const compEdges: GraphEdge[] = [];

    rawEdges.forEach(e => {
      if (!COMPONENT_EDGE_TYPES.has(e.rel)) return;
      const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
      const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
      const srcComp = nodeToComp.get(srcId);
      const tgtComp = nodeToComp.get(tgtId);
      if (!srcComp || !tgtComp || srcComp === tgtComp) return;
      const key = `${srcComp}→${tgtComp}→${e.rel}`;
      if (compEdgeSet.has(key)) return;
      compEdgeSet.add(key);
      compEdges.push({
        source: srcComp,
        target: tgtComp,
        rel: e.rel,
        _isCrossRepo: false,
        _isHubLink: false,
      });
    });

    // 4. Include cross-repo nodes/edges if enabled
    if (showCrossRepo && crossRepoEdges.length) {
      const phantoms = crossRepoNodes.filter(n => n._isHub || n._isPhantom);
      const xEdges: GraphEdge[] = [];
      crossRepoEdges.forEach(e => {
        const srcId = typeof e.source === 'object' ? (e.source as GraphNode).id : e.source;
        const tgtId = typeof e.target === 'object' ? (e.target as GraphNode).id : e.target;
        const srcComp = nodeToComp.get(srcId) || srcId;
        const tgtComp = nodeToComp.get(tgtId) || tgtId;
        if (srcComp === tgtComp) return;
        xEdges.push({
          source: srcComp,
          target: tgtComp,
          rel: e.rel,
          _isCrossRepo: e._isCrossRepo || false,
          _isHubLink: e._isHubLink || false,
          _confidence: e._confidence,
        });
      });
      return {
        nodes: [...componentNodes, ...phantoms],
        edges: [...compEdges, ...xEdges],
      };
    }

    return { nodes: componentNodes, edges: compEdges };
  }
}
