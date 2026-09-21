// Offramp — oracle routers (generation.md §6.2, gameplay.md §2.7).
//
// Harness code. This is not a model of a player and no clear-rate target is read off it:
// it is a reference.
//
//   lazyOptimal  — generation.md §6.2's normative definition of an ACTIONABLE junction. At
//                  each tick, for every car that will transition onto a branch node during
//                  that tick's advance, if the open branch cannot reach that car's colour,
//                  flip it — and never otherwise. The junctions it never flips are the
//                  junctions the level never asked about (AC-243).
//

import { CAR_SPEED, createState, reachableColourMasks, step } from '../../src/engine/index.js';

const MAX_RUN_TICKS = 20000;

/** Does branch k of this branch node lead to a depot of `colour`? */
function reaches(level, masks, node, k, colour) {
  return ((masks[level.edges[node.out[k]].to] >> colour) & 1) === 1;
}

/**
 * The branch nodes a car will ENTER during this tick's advance, given `open` as it stands.
 * Edges are never shorter than 200 LU and a tick is never longer than 3.8 LU, so this list is
 * at most one long in every shipped band — it is written as a loop anyway, so that a band
 * table that broke that assumption would be handled rather than silently mis-measured.
 */
function branchesEnteredThisTick(level, open, car) {
  const out = [];
  let edge = level.edges[car.edgeId];
  let progress = car.progress + CAR_SPEED;
  while (progress >= edge.lengthMlu) {
    progress -= edge.lengthMlu;
    const node = level.nodes[edge.to];
    if (node.kind === 'depot') break;
    if (node.kind === 'branch') out.push(node);
    edge = level.edges[node.out[node.kind === 'branch' ? open[node.junctionId] : 0]];
  }
  return out;
}

/**
 * generation.md §6.2's lazy-optimal rule, for ONE tick: for every car that will transition
 * onto a branch node during this tick's advance, if the junction's currently open branch
 * cannot reach that car's colour, flip it — and never otherwise.
 *
 * Exported because the engine tests need a driver that REACHES THE BELL. A never-tapping run
 * loses three lives long before tick 7,200 (AC-814), so any test that wants to observe
 * `phase === 'ended'` has to route the cars, and re-implementing the routing in the test file
 * would be a second source of a fact this module already holds
 * (docs/development-process.md §6.3).
 */
export function lazyOptimalInputs(level, masks, state) {
  const inputs = [];
  for (const car of state.cars) {
    for (const node of branchesEnteredThisTick(level, state.open, car)) {
      if (reaches(level, masks, node, state.open[node.junctionId], car.colour)) continue;
      inputs.push({ tick: state.tick, junctionId: node.junctionId });
    }
  }
  return inputs;
}

/**
 * generation.md §6.2's lazy-optimal oracle. Returns the flip record for one level:
 * which junctions were flipped, and how often.
 */
export function lazyOptimal(level) {
  const masks = reachableColourMasks(level);
  const flips = new Map(); // junctionId -> count
  let state = createState(level);

  while (state.phase === 'running' && state.tick < MAX_RUN_TICKS) {
    const inputs = lazyOptimalInputs(level, masks, state);
    for (const i of inputs) flips.set(i.junctionId, (flips.get(i.junctionId) || 0) + 1);
    state = step(state, inputs);
  }

  const live = [...flips.keys()].sort((a, b) => a - b);
  return {
    state,
    cleared: state.phase === 'ended',
    misrouted: state.misrouted,
    live,
    liveCount: live.length,
    flippedTwicePlus: [...flips.values()].filter((n) => n >= 2).length,
    drawn: level.junctions.length,
  };
}

// `routeOracle` and `colourDistances` are DELETED. They existed to size the spawn schedule —
// perfect routing in a shortest-path and a longest-path variant, with the LIVES - 1 misroutes
// a winning run may contain injected, measuring how many spawns a run could consume against
// `quota + SPAWN_SLACK`. Under a clock the schedule is the exact list of cars that fit in two
// minutes (gameplay.md §2.7, §8.4), so there is no margin to measure and `tools/spawn-margin.mjs`
// is replaced by `tools/spawn-schedule.mjs`, which checks an identity.
