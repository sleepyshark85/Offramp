// Shared fixtures for the engine tests. Not a test file (the runner globs *.test.js).

import { MLU } from '../src/engine/constants.js';

/**
 * A hand-built two-depot level, so that rules can be exercised at exact ticks instead of
 * whatever a generated level happens to do.
 *
 *            entry (row -1, col 1) at (500, 60)
 *              |  edge 0, 100 LU, vertical
 *            branch j0 (row 0, col 1) at (500, 160)
 *           /                      \
 *   edge 1 'jogL' (360 LU)    edge 2 'jogR' (300 LU)
 *   depot col 0, colour 0     depot col 2, colour 1
 *   at (400, 420)             at (560, 400)
 *
 * A car spawned at tick s reaches the junction at tick s+33 and the depot at s+153 via
 * edge 1, or s+133 via edge 2.
 *
 * ROUND 8: the geometry is ORTHOGONAL and every length is `|Δx| + |Δy|` exactly, the same
 * identity generation.md §3.3 states and AC-207 asserts — 100 + 0, 100 + 260, 60 + 240. The
 * two arrival ticks are unchanged from the cubic-era fixture, which is deliberate: the tests
 * that pin them are about the RULES, and re-deriving their expected ticks alongside the
 * geometry would have hidden a rule change inside a geometry change.
 *
 * There is no `quota`: a level ends on the clock (gameplay.md §4.2). A fixture run therefore
 * stays `'running'` for 7,200 ticks unless three lives go first, and the tests that want a
 * terminal phase drive it there explicitly.
 */
export function twoDepotLevel({ spawns, speed = 3000 } = {}) {
  const list = (spawns || [{ index: 0, tick: 0, colour: 0 }]).slice();
  const node = (id, row, col, x, y, kind, out, junctionId = null, depotColour = null) => ({
    id, row, col, x, y, kind, out, junctionId, depotColour,
  });
  return {
    seed: 1,
    band: 1,
    C: 3, K: 2, R: 1,
    colW: 300, rowH: 400,
    nodes: [
      node(0, -1, 1, 500, 60, 'entry', [0]),
      node(1, 0, 1, 500, 160, 'branch', [1, 2], 0),
      node(2, 1, 0, 400, 420, 'depot', [], null, 0),
      node(3, 1, 2, 560, 400, 'depot', [], null, 1),
    ],
    edges: [
      { id: 0, from: 0, to: 1, lengthMlu: 100 * MLU, shape: 'entry' },
      { id: 1, from: 1, to: 2, lengthMlu: 360 * MLU, shape: 'jogL' },
      { id: 2, from: 1, to: 3, lengthMlu: 300 * MLU, shape: 'jogR' },
    ],
    junctions: [1],
    entryEdgeId: 0,
    speedMluPerTick: speed,
    interval: 156,
    jitter: 12,
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
