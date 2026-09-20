// Offramp — edge geometry for the harnesses (generation.md §2.3, §3.4).
//
// Floating point lives here on purpose: the simulation has already decided where a car is,
// in integers. This turns (edgeId, progress) into a point so a harness can measure what the
// screen will show. It is the same 65-entry arc-length table the renderer will build.

import { K_CTRL_DEN, K_CTRL_NUM, MLU } from '../../src/engine/index.js';

const K = K_CTRL_NUM / K_CTRL_DEN;
const SAMPLES = 64;

function controlPoints(level, edge) {
  const a = level.nodes[edge.from];
  const b = level.nodes[edge.to];
  const dy = b.y - a.y;
  return [
    [a.x, a.y],
    [a.x, a.y + K * dy],
    [b.x, b.y - K * dy],
    [b.x, b.y],
  ];
}

function evalCubic(p, t) {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  let x = 0;
  let y = 0;
  for (let i = 0; i < 4; i += 1) {
    x += w[i] * p[i][0];
    y += w[i] * p[i][1];
  }
  return [x, y];
}

/** Per-edge distance -> t table, built once per level. */
export function buildCurves(level) {
  return level.edges.map((edge) => {
    const p = controlPoints(level, edge);
    const dist = [0];
    const pts = [evalCubic(p, 0)];
    for (let i = 1; i <= SAMPLES; i += 1) {
      const q = evalCubic(p, i / SAMPLES);
      dist.push(dist[i - 1] + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]));
      pts.push(q);
    }
    return { p, dist, pts, total: dist[SAMPLES], lengthLu: edge.lengthMlu / MLU };
  });
}

/** Screen-space point (in LU) of a car, from its integer (edgeId, progress). */
export function carPoint(curves, car) {
  const c = curves[car.edgeId];
  // The engine's edge length is the rounded table literal; the sampled curve is a hair
  // shorter. Scale so that progress === lengthMlu lands exactly on the end point.
  const want = (car.progress / MLU) * (c.total / c.lengthLu);
  let i = 1;
  while (i < SAMPLES && c.dist[i] < want) i += 1;
  const lo = c.dist[i - 1];
  const hi = c.dist[i];
  const f = hi > lo ? (want - lo) / (hi - lo) : 0;
  const a = c.pts[i - 1];
  const b = c.pts[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
