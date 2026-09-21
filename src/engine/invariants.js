import { LEVEL_TICKS } from './constants.js';

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

  // Scalars. There is no `score`: `delivered` IS the score (gameplay.md §4.3, AC-117).
  for (const k of ['tick', 'rng', 'nextSpawn', 'delivered', 'misrouted', 'lives', 'streak', 'bestStreak']) {
    if (!Number.isInteger(state[k])) bad.push('state.' + k + ' is not an integer: ' + state[k]);
  }
  if ('score' in state) bad.push('state carries a `score` field, which round 8 deleted');
  if (state.delivered < 0) bad.push('delivered negative');
  if (state.lives < 0) bad.push('lives below zero');
  if (state.lives > 3) bad.push('lives above LIVES');
  if (state.tick > LEVEL_TICKS) bad.push('tick past LEVEL_TICKS: ' + state.tick);
  if (prev) {
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

  // AC-123 — the schedule is exactly consumed and never over-consumed. Under a clock the
  // schedule holds exactly the cars that fit in two minutes, so the failure to catch is a
  // schedule that stops short of the clock or an engine that over-runs it; the equality
  // `nextSpawn === spawns.length` at the bell is checked by the caller, which is the only
  // place the bell is observable.
  if (state.nextSpawn > level.spawns.length) {
    bad.push('nextSpawn ' + state.nextSpawn + ' past spawns.length ' + level.spawns.length);
  }

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
