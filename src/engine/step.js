// Offramp — the simulation (gameplay.md §2).
//
// Pure functions over plain data. No React, no timers, no wall clock, no ambient randomness
// and no floats.
// `step(state, inputs)` advances exactly one tick; `apply(state, action)` is step 2 of that
// tick and the only place a junction changes state.

import { CAR_SPEED, LEVEL_TICKS, LIVES, SPAWN_SALT } from './constants.js';
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
    // Two terminal phases and they are not the same outcome (gameplay.md §2.4). 'ended' means
    // the clock ran out with a life left — the level is CLEARED. 'lost' means the third life
    // went first. There is no 'won': finishing is what winning is.
    phase: 'running',
    level,
    // The spawn schedule is materialised at level construction (gameplay.md §2.7), so the
    // spawn stream does not advance during play; the seed of that stream is carried so the
    // determinism contract can compare it (AC-125).
    rng: mix32(level.seed, SPAWN_SALT),
    cars: [],
    // AC-138 — normative, not an allocation default: every junction starts pointing at
    // node.out[0], the lower-column branch, so an untouched network sends every car to the
    // leftmost depot it can reach (gameplay.md §4.8).
    open: new Uint8Array(level.junctions.length),
    nextSpawn: 0,
    delivered: 0, // THE SCORE (gameplay.md §4.3)
    misrouted: 0,
    lives: LIVES,
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
 *
 * `delivered` IS the score. There is no points total and no `score` field: the four slice-0
 * scoring constants are deleted (gameplay.md §4.3, AC-117), and they are not named here
 * because AC-117's check is a grep over src/ for exactly those names. `streak` and
 * `bestStreak` survive as reported statistics and multiply nothing.
 *
 * `edgeId` is the TERMINAL EDGE the car was on when it reached the depot (gameplay.md §2.6,
 * AC-140). It exists because a depot has an in-degree of up to 3 (§4.5b), so `depotId` does
 * not identify the road the car came down, and ui.md §8.3 / §8.4 anchor the delivery glow and
 * the misroute shatter to that road's terrace line. It is RENDER-ONLY, like the rest of the
 * event (§2.9): nothing in the engine reads it back, and no counter, phase or invariant
 * depends on it.
 */
function resolveArrival(state, car, depotNode, edgeId) {
  if (depotNode.depotColour === car.colour) {
    state.delivered += 1;
    state.streak += 1;
    if (state.streak > state.bestStreak) state.bestStreak = state.streak;
    state.events.push({
      type: 'delivered',
      tick: state.tick,
      carId: car.id,
      depotId: depotNode.id,
      edgeId,
      colour: car.colour,
    });
  } else {
    state.misrouted += 1;
    state.streak = 0;
    // Floored at zero: two cars can arrive on the same tick, and AC-121 requires lives never
    // to go below 0 while AC-122/AC-136 require both arrivals to resolve and both to count.
    if (state.lives > 0) state.lives -= 1;
    state.events.push({
      type: 'misrouted',
      tick: state.tick,
      carId: car.id,
      depotId: depotNode.id,
      edgeId,
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
  }

  // 4. ADVANCE — ascending id order. Arrivals are collected by rebuilding the list rather
  // than spliced out mid-iteration.
  const kept = [];
  for (const car of next.cars) {
    car.progress += CAR_SPEED; // gameplay.md §2.2 — one constant at every band (AC-105)
    let edge = edges[car.edgeId];
    let arrived = false;
    let iterations = 0;
    while (car.progress >= edge.lengthMlu) {
      iterations += 1;
      car.progress -= edge.lengthMlu;
      const node = nodes[edge.to];
      if (node.kind === 'depot') {
        resolveArrival(next, car, node, edge.id);
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

  // 5. TERMINAL CHECK — LIVES FIRST, then the clock (gameplay.md §2.5, AC-122, AC-802).
  //
  // A tick in which the third life is lost AND the clock expires is a LOSS. This is the
  // opposite of the old quota rule, which resolved the tie in the player's favour, and the
  // reversal is deliberate: under a quota the tie was "you finished the job and also made a
  // mistake", and the job was the point. Under a clock there is no job to have finished —
  // every run reaches the bell — so resolving it as a clear would make tick 7,199 the one tick
  // on which a misroute is free.
  //
  // The clock is checked against `tick + 1`, the tick that has just finished, and step 6
  // increments afterwards: so the last tick simulated is LEVEL_TICKS - 1 and a run contains
  // exactly LEVEL_TICKS ticks numbered 0 … 7199 (AC-141).
  if (next.lives <= 0) {
    next.phase = 'lost';
  } else if (next.tick + 1 >= LEVEL_TICKS) {
    next.phase = 'ended';
  }

  // 6.
  next.tick = state.tick + 1;
  return next;
}
