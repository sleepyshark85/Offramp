// Offramp — engine invariants (docs/development-process.md §4).
//
// Asserted after every step() by the fuzz tests and by the harnesses in tools/. Returns an
// array of violation strings; empty means clean.

export function checkInvariants(state, prev) {
  const bad = [];
  const level = state.level;

  if (prev && state.tick !== prev.tick + 1 && state.phase === 'running') {
    bad.push('tick did not advance by exactly 1: ' + prev.tick + ' -> ' + state.tick);
  }

  // Cars: on exactly one edge, inside it, ids unique and strictly ascending.
  let lastId = -1;
  for (const car of state.cars) {
    if (car.id <= lastId) bad.push('car ids not strictly ascending at id ' + car.id);
    lastId = car.id;
    const edge = level.edges[car.edgeId];
    if (!edge) bad.push('car ' + car.id + ' on unknown edge ' + car.edgeId);
    else if (!(car.progress >= 0 && car.progress < edge.lengthMlu)) {
      bad.push('car ' + car.id + ' off its edge: progress=' + car.progress + ' len=' + edge.lengthMlu);
    }
    if (!Number.isInteger(car.progress) || !Number.isInteger(car.edgeId) || !Number.isInteger(car.colour)) {
      bad.push('car ' + car.id + ' holds a non-integer field');
    }
  }

  // Scalars.
  for (const k of ['tick', 'rng', 'nextSpawn', 'delivered', 'misrouted', 'lives', 'score', 'streak', 'bestStreak']) {
    if (!Number.isInteger(state[k])) bad.push('state.' + k + ' is not an integer: ' + state[k]);
  }
  if (state.score < 0) bad.push('score negative');
  if (state.lives < 0) bad.push('lives below zero');
  if (state.lives > 3) bad.push('lives above LIVES');
  if (prev) {
    if (state.score < prev.score) bad.push('score decreased');
    if (state.lives > prev.lives) bad.push('lives increased');
    if (state.delivered < prev.delivered) bad.push('delivered decreased');
    if (state.misrouted < prev.misrouted) bad.push('misrouted decreased');
  }

  // Car conservation: in flight === spawned - delivered - misrouted.
  const expected = state.nextSpawn - state.delivered - state.misrouted;
  if (state.cars.length !== expected) {
    bad.push('car count ' + state.cars.length + ' !== spawned-delivered-misrouted ' + expected);
  }

  // Junction states are 0 or 1.
  for (let j = 0; j < state.open.length; j += 1) {
    if (state.open[j] !== 0 && state.open[j] !== 1) bad.push('open[' + j + '] is ' + state.open[j]);
  }

  // Spawn slack (AC-123).
  if (state.nextSpawn >= level.spawns.length) bad.push('spawn schedule exhausted');

  return bad;
}

/**
 * Minimum separation in MLU between any two cars sharing an edge (AC-124). Returns
 * Infinity when no two cars share an edge this tick.
 */
export function minSharedEdgeSeparationMlu(state) {
  let min = Infinity;
  for (let i = 0; i < state.cars.length; i += 1) {
    for (let j = i + 1; j < state.cars.length; j += 1) {
      if (state.cars[i].edgeId === state.cars[j].edgeId) {
        const d = Math.abs(state.cars[i].progress - state.cars[j].progress);
        if (d < min) min = d;
      }
    }
  }
  return min;
}
