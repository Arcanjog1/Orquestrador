import type { ExecutionNode } from './execution-graph.js';

export const MISSION_NODE_WIDTH = 176;
export const MISSION_NODE_HEIGHT = 108;
const COLUMN_GAP = 212;
const LANE_GAP = 130;

/** A winding trail uses the height of the map without inventing dependencies.
 * Nodes in the same dependency wave always keep separate, centered tracks. */
export function missionLayout(nodes: readonly ExecutionNode[], columns = 3) {
  columns = Math.max(1, Math.floor(columns));
  const ranks = [...new Set(nodes.map(n => n.row))].sort((a,b) => a-b);
  const waves = ranks.map(rank => nodes.filter(n => n.row === rank));
  const offsets: number[] = [];
  let y = 0;
  for (let band = 0; band < Math.ceil(waves.length / columns); band++) {
    offsets.push(y);
    y += Math.max(...waves.slice(band*columns,(band+1)*columns).map(w => w.length)) * LANE_GAP + 30;
  }
  return nodes.map(node => {
    const rank = ranks.indexOf(node.row), band = Math.floor(rank/columns);
    const wave = waves[rank]!;
    const bandLanes = Math.max(...waves.slice(band*columns,(band+1)*columns).map(w => w.length));
    const column = band % 2 ? columns-1-rank%columns : rank%columns;
    return {...node, x: column*COLUMN_GAP,
      y: offsets[band]! + (wave.indexOf(node)+(bandLanes-wave.length)/2)*LANE_GAP};
  });
}
