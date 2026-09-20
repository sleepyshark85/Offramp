// Offramp — junction hit testing (ui.md §10.1).
//
// Pure. Hit circles never overlap (ui.md §4.4), so "nearest junction within HIT_R_LU" and
// "the unique junction containing the point" are the same answer and there is no tie-break
// to get wrong.

import { hitRadiusLu, minSepLuForBand, screenToLu } from './layout.js';

/** The junction centres of a level, in LU, indexed by junctionId. Built once per level. */
export function junctionSites(level) {
  return level.junctions.map((nodeId, junctionId) => {
    const n = level.nodes[nodeId];
    return { junctionId, nodeId, x: n.x, y: n.y };
  });
}

/**
 * AC-301 / AC-304. Returns the junctionId hit, or -1 when the tap landed on empty road —
 * which is ignored silently, because a miss is not an error.
 */
export function hitTest(layout, level, sites, sx, sy) {
  const r = hitRadiusLu(layout.scale, minSepLuForBand(level.band));
  const { x: lx, y: ly } = screenToLu(layout, sx, sy);
  const r2 = r * r;
  let best = -1;
  let bestD2 = Infinity;
  for (const s of sites) {
    const dx = lx - s.x;
    const dy = ly - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      bestD2 = d2;
      best = s.junctionId;
    }
  }
  return best;
}
