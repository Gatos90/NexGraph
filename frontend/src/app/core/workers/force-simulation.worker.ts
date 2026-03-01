/**
 * Web Worker for d3-force simulation.
 * Runs physics off the main thread and posts back position arrays (transferable).
 *
 * Message protocol:
 *   Main → Worker:
 *     { type: 'start', nodes, edges, config }  — Init & run simulation
 *     { type: 'pin', nodeIndex, x, y }         — Fix a node position (drag)
 *     { type: 'unpin', nodeIndex }              — Release a node
 *     { type: 'reheat' }                        — alphaTarget(0.1).restart()
 *     { type: 'cool' }                          — alphaTarget(0)
 *     { type: 'stop' }                          — Stop simulation
 *
 *   Worker → Main:
 *     { type: 'tick', positions: Float64Array }  — [x0,y0,x1,y1,...] (transferable)
 *     { type: 'end' }                            — Simulation cooled to zero
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

// ---- Types for serialized data ----

interface WorkerNode extends SimulationNodeDatum {
  id: string | number;
  label: string;
  _isHub?: boolean;
  _isComponent?: boolean;
  _isPhantom?: boolean;
  _isExpandedRepo?: boolean;
  _repoId?: string;
}

interface WorkerEdge extends SimulationLinkDatum<WorkerNode> {
  source: string | number;
  target: string | number;
  rel: string;
  _isCrossRepo?: boolean;
  _isHubLink?: boolean;
  _isExpandedRepoEdge?: boolean;
}

interface ForceConfig {
  width: number;
  height: number;
  nodeSizes: Record<string, number>;
  tickSkip: number;
  alphaDecay: number;
}

// ---- Simulation state ----

let simulation: Simulation<WorkerNode, WorkerEdge> | null = null;
let nodes: WorkerNode[] = [];
let tickCount = 0;
let tickSkip = 1;

// ---- Repo cluster custom force ----

function createRepoClusterForce(
  nodes: WorkerNode[],
  width: number,
  height: number,
): (alpha: number) => void {
  const repoNodes = new Map<string, WorkerNode[]>();
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

// ---- Build positions array (transferable) ----

function buildPositions(): Float64Array {
  const buf = new Float64Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    buf[i * 2] = nodes[i].x ?? 0;
    buf[i * 2 + 1] = nodes[i].y ?? 0;
  }
  return buf;
}

// ---- Message handler ----

addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'start': {
      // Clean up previous simulation
      if (simulation) {
        simulation.stop();
        simulation = null;
      }

      nodes = msg.nodes as WorkerNode[];
      const edges = msg.edges as WorkerEdge[];
      const config = msg.config as ForceConfig;
      const { width, height, nodeSizes } = config;

      tickCount = 0;
      tickSkip = config.tickSkip;

      simulation = forceSimulation<WorkerNode>(nodes)
        .alphaDecay(config.alphaDecay)
        .velocityDecay(0.4)
        .force('link', forceLink<WorkerNode, WorkerEdge>(edges)
          .id((d) => d.id)
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
        .force('charge', forceManyBody<WorkerNode>().strength((d) => {
          if (d._isHub) return -500;
          if (d._isComponent) return -400;
          if (d._isPhantom) return -120;
          if (d._isExpandedRepo) return -60;
          return d.label === 'Folder' ? -200 : -80;
        }))
        .force('center', forceCenter(width / 2, height / 2))
        .force('collision', forceCollide<WorkerNode>().radius((d) => {
          if (d._isHub) return 70;
          if (d._isComponent) return 60;
          return (nodeSizes[d.label] || 5) + 8;
        }))
        .force('x', forceX<WorkerNode>(width / 2).strength(0.03))
        .force('y', forceY<WorkerNode>(height / 2).strength(0.03))
        .force('repoCluster', createRepoClusterForce(nodes, width, height))
        .on('tick', () => {
          tickCount++;
          if (tickCount % tickSkip !== 0) return;
          const positions = buildPositions();
          postMessage({ type: 'tick', positions }, [positions.buffer] as any);
        })
        .on('end', () => {
          // Send final positions
          const positions = buildPositions();
          postMessage({ type: 'tick', positions }, [positions.buffer] as any);
          postMessage({ type: 'end' });
        });

      break;
    }

    case 'pin': {
      const idx = msg.nodeIndex as number;
      if (nodes[idx]) {
        nodes[idx].fx = msg.x;
        nodes[idx].fy = msg.y;
      }
      break;
    }

    case 'unpin': {
      const idx = msg.nodeIndex as number;
      if (nodes[idx]) {
        nodes[idx].fx = null;
        nodes[idx].fy = null;
      }
      break;
    }

    case 'reheat': {
      if (simulation) simulation.alphaTarget(0.1).restart();
      break;
    }

    case 'cool': {
      if (simulation) simulation.alphaTarget(0);
      break;
    }

    case 'stop': {
      if (simulation) {
        simulation.stop();
        simulation = null;
      }
      break;
    }
  }
});
