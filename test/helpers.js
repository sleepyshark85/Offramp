// Shared fixtures for the engine tests. Not a test file (the runner globs *.test.js).

import { MLU } from '../src/engine/constants.js';

/**
 * A hand-built two-depot level, so that rules can be exercised at exact ticks instead of
 * whatever a generated level happens to do.
 *
 *            entry (row -1, col 1)
 *              |  edge 0, 100 LU
 *            branch j0 (row 0, col 1)
 *           /                      \
 *   edge 1 (360 LU)          edge 2 (300 LU)
 *   depot col 0, colour 0    depot col 2, colour 1
 *
 * A car spawned at tick s reaches the junction at tick s+33 and the depot at s+153 via
 * edge 1, or s+133 via edge 2.
 */
export function twoDepotLevel({ spawns, quota = 1, speed = 3000, slack = true } = {}) {
  // Real levels carry quota + 8 spawns of slack (gameplay.md §8.4); fixtures get the same
  // so that consuming the schedule is an error condition here too, not an artefact.
  const list = (spawns || [{ index: 0, tick: 0, colour: 0 }]).slice();
  if (slack) {
    for (let i = 0; i < 8; i += 1) list.push({ index: list.length, tick: 100000 + i * 156, colour: 0 });
  }
  const node = (id, row, col, kind, out, junctionId = null, depotColour = null) => ({
    id, row, col, x: 200 + col * 300, y: row < 0 ? 60 : 160 + row * 400,
    kind, out, junctionId, depotColour,
  });
  return {
    seed: 1,
    band: 1,
    C: 3, K: 2, R: 1,
    colW: 300, rowH: 400, diagLen: 521,
    nodes: [
      node(0, -1, 1, 'entry', [0]),
      node(1, 0, 1, 'branch', [1, 2], 0),
      node(2, 1, 0, 'depot', [], null, 0),
      node(3, 1, 2, 'depot', [], null, 1),
    ],
    edges: [
      { id: 0, from: 0, to: 1, lengthMlu: 100 * MLU, shape: 'entry' },
      { id: 1, from: 1, to: 2, lengthMlu: 360 * MLU, shape: 'diagL' },
      { id: 2, from: 1, to: 3, lengthMlu: 300 * MLU, shape: 'diagR' },
    ],
    junctions: [1],
    entryEdgeId: 0,
    speedMluPerTick: speed,
    interval: 156,
    jitter: 12,
    quota,
    spawns: list,
  };
}

/** Run to a terminal phase or a tick limit, with per-tick inputs from a map. */
export function drive(step, state, inputsByTick, untilTick) {
  let s = state;
  while (s.tick < untilTick && s.phase === 'running') {
    s = step(s, inputsByTick.get(s.tick) || []);
  }
  return s;
}
