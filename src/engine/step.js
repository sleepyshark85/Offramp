// Offramp — the simulation (gameplay.md §2).
//
// Pure functions over plain data. No React, no timers, no wall clock, no ambient randomness
// and no floats.
// `step(state, inputs)` advances exactly one tick; `apply(state, action)` is step 2 of that
// tick and the only place a junction changes state.

import {
  LIVES,
  SCORE_DELIVERY,
  SCORE_LIFE_BONUS,
  SCORE_STREAK_STEP,
  SPAWN_SALT,
  STREAK_CAP,
} from './constants.js';
import { mix32 } from './rng.js';

/**
 * Instrumentation for AC-118. Not read by the simulation; the transition loop writes its
 * iteration count here so a test can observe that the loop is single-pass.
 */
export const TRANSITION_STATS = { maxPerCarTick: 0, transitions: 0 };

export function resetTransitionStats() {
  TRANSITION_STATS.maxPerCarTick = 0;
  TRANSITION_STATS.transitions = 0;
}

/** Fresh state at tick 0 for a generated level. */
export function createState(level) {
  return {
    tick: 0,
    phase: 'running',
    level,
    // The spawn schedule is materialised at level construction (gameplay.md §2.7), so the
    // spawn stream does not advance during play; the seed of that stream is carried so the
    // determinism contract can compare it (AC-125).
    rng: mix32(level.seed, SPAWN_SALT),
    cars: [],
    open: new Uint8Array(level.junctions.length),
    nextSpawn: 0,
    delivered: 0,
    misrouted: 0,
    lives: LIVES,
    score: 0,
    streak: 0,
    bestStreak: 0,
    events: [],
  };
}

function cloneState(s) {
  return {
    tick: s.tick,
    phase: s.phase,
    level: s.level,
    rng: s.rng,
    cars: s.cars.map((c) => ({ id: c.id, colour: c.colour, edgeId: c.edgeId, progress: c.progress })),
    open: Uint8Array.from(s.open),
    nextSpawn: s.nextSpawn,
    delivered: s.delivered,
    misrouted: s.misrouted,
    lives: s.lives,
    score: s.score,
    streak: s.streak,
    bestStreak: s.bestStreak,
    events: [],
  };
}

/**
 * Step 2 of a tick: toggle one junction. Mutates the working state and records the flip.
 * The flip is never blocked, queued, deferred or dropped (gameplay.md §3.4).
 */
export function apply(state, action) {
  const j = action.junctionId;
  if (!Number.isInteger(j) || j < 0 || j >= state.open.length) {
    throw new Error('BAD_JUNCTION: ' + j);
  }
  state.open[j] ^= 1;
  state.events.push({ type: 'flip', tick: state.tick, junctionId: j, open: state.open[j] });
  return state;
}

/**
 * resolveArrival — the single place scoring happens (gameplay.md §2.6).
 * The caller removes the car from the list; this function never mutates the list it is being
 * iterated over (docs/reports/slice-0-orchestrator-verification.md, finding 2).
 */
function resolveArrival(state, car, depotNode) {
  if (depotNode.depotColour === car.colour) {
    state.delivered += 1;
    state.streak += 1;
    if (state.streak > state.bestStreak) state.bestStreak = state.streak;
    state.score += SCORE_DELIVERY + SCORE_STREAK_STEP * Math.min(state.streak - 1, STREAK_CAP);
    state.events.push({
      type: 'delivered',
      tick: state.tick,
      carId: car.id,
      depotId: depotNode.id,
      colour: car.colour,
    });
  } else {
    state.misrouted += 1;
    state.streak = 0;
    // Floored at zero: two cars can arrive on the same tick, and AC-121 requires lives never
    // to go below 0 while AC-122 requires both arrivals to resolve.
    if (state.lives > 0) state.lives -= 1;
    state.events.push({
      type: 'misrouted',
      tick: state.tick,
      carId: car.id,
      depotId: depotNode.id,
      carColour: car.colour,
      depotColour: depotNode.depotColour,
    });
  }
}

/** Advance exactly one tick. Returns a new state; the input state is not modified. */
export function step(state, inputs) {
  if (state.phase !== 'running') return state;

  const next = cloneState(state);
  const level = next.level;
  const { nodes, edges, spawns } = level;

  // 2. APPLY INPUTS — ascending by junctionId, ties keep submitted order (stable sort).
  if (inputs && inputs.length) {
    const ordered = inputs.slice().sort((a, b) => a.junctionId - b.junctionId);
    for (const input of ordered) apply(next, input);
  }

  // 3. SPAWN
  while (next.nextSpawn < spawns.length && spawns[next.nextSpawn].tick === next.tick) {
    const s = spawns[next.nextSpawn];
    next.nextSpawn += 1;
    next.cars.push({ id: s.index, colour: s.colour, edgeId: level.entryEdgeId, progress: 0 });
    next.events.push({ type: 'spawn', tick: next.tick, carId: s.index, colour: s.colour });
    if (next.nextSpawn >= spawns.length) {
      // gameplay.md §2.7 / AC-808: the schedule carries quota + 8 cars and must never be
      // exhausted. Stalling silently would be worse than stopping.
      throw new Error('SPAWN_EXHAUSTED: seed=' + level.seed + ' band=' + level.band);
    }
  }

  // 4. ADVANCE — ascending id order. Arrivals are collected by rebuilding the list rather
  // than spliced out mid-iteration.
  const kept = [];
  for (const car of next.cars) {
    car.progress += level.speedMluPerTick;
    let edge = edges[car.edgeId];
    let arrived = false;
    let iterations = 0;
    while (car.progress >= edge.lengthMlu) {
      iterations += 1;
      car.progress -= edge.lengthMlu;
      const node = nodes[edge.to];
      if (node.kind === 'depot') {
        resolveArrival(next, car, node);
        arrived = true;
        break;
      }
      car.edgeId = node.kind === 'branch' ? node.out[next.open[node.junctionId]] : node.out[0];
      edge = edges[car.edgeId];
    }
    TRANSITION_STATS.transitions += iterations;
    if (iterations > TRANSITION_STATS.maxPerCarTick) TRANSITION_STATS.maxPerCarTick = iterations;
    if (!arrived) kept.push(car);
  }
  next.cars = kept;

  // 5. TERMINAL CHECK — quota first, so a tick that completes the quota and misroutes another
  // car is a win (gameplay.md §4.2).
  if (next.delivered >= level.quota) {
    next.phase = 'won';
    next.score += SCORE_LIFE_BONUS * next.lives;
  } else if (next.lives <= 0) {
    next.phase = 'lost';
  }

  // 6.
  next.tick = state.tick + 1;
  return next;
}
