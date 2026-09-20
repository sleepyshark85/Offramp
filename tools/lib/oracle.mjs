// Offramp — oracle routers (generation.md §6.2, gameplay.md §2.7).
//
// Harness code. These are not models of a player and no clear-rate target is read off them:
// they are references. Two of them, for two different questions.
//
//   lazyOptimal  — generation.md §6.2's normative definition of an ACTIONABLE junction. At
//                  each tick, for every car that will transition onto a branch node during
//                  that tick's advance, if the open branch cannot reach that car's colour,
//                  flip it — and never otherwise. The junctions it never flips are the
//                  junctions the level never asked about (AC-243).
//
//   routeOracle  — perfect routing with unlimited taps, in a shortest-path and a longest-path
//                  variant, with the LIVES - 1 misroutes a winning run may contain injected at
//                  the first two opportunities. It exists to size the spawn schedule, not to
//                  play well (AC-139).

import { LIVES, createState, reachableColourMasks, step } from '../../src/engine/index.js';

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
  let progress = car.progress + level.speedMluPerTick;
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
 * generation.md §6.2's lazy-optimal oracle. Returns the flip record for one level:
 * which junctions were flipped, and how often.
 */
export function lazyOptimal(level) {
  const masks = reachableColourMasks(level);
  const flips = new Map(); // junctionId -> count
  let state = createState(level);

  while (state.phase === 'running' && state.tick < MAX_RUN_TICKS) {
    const inputs = [];
    for (const car of state.cars) {
      for (const node of branchesEnteredThisTick(level, state.open, car)) {
        if (reaches(level, masks, node, state.open[node.junctionId], car.colour)) continue;
        inputs.push({ tick: state.tick, junctionId: node.junctionId });
        flips.set(node.junctionId, (flips.get(node.junctionId) || 0) + 1);
      }
    }
    state = step(state, inputs);
  }

  const live = [...flips.keys()].sort((a, b) => a - b);
  return {
    state,
    cleared: state.phase === 'won',
    misrouted: state.misrouted,
    live,
    liveCount: live.length,
    flippedTwicePlus: [...flips.values()].filter((n) => n >= 2).length,
    drawn: level.junctions.length,
  };
}

/**
 * Per-node distance in MLU to the nearest (or furthest) depot of each colour. Infinity when
 * that colour is unreachable from the node, in both variants, so `Number.isFinite` is the
 * reachability test in either.
 */
function colourDistances(level, longest) {
  const K = level.K;
  const d = level.nodes.map(() => new Array(K).fill(Infinity));
  for (let i = level.nodes.length - 1; i >= 0; i -= 1) {
    const n = level.nodes[i];
    if (n.kind === 'depot') {
      d[i][n.depotColour] = 0;
      continue;
    }
    for (const eid of n.out) {
      const e = level.edges[eid];
      for (let c = 0; c < K; c += 1) {
        const via = d[e.to][c];
        if (!Number.isFinite(via)) continue;
        const cand = via + e.lengthMlu;
        const cur = d[i][c];
        if (!Number.isFinite(cur) || (longest ? cand > cur : cand < cur)) d[i][c] = cand;
      }
    }
  }
  return d;
}

/**
 * Perfect routing, unlimited taps. `variant` is 'shortest' | 'longest'. `misroutes` cars are
 * deliberately sent down a branch whose whole subtree cannot reach their colour — so the
 * misroute is guaranteed rather than hoped for, and no later flip can rescue them.
 *
 * Returns the maximum `nextSpawn` the run reached, which is what sizes the schedule.
 */
export function routeOracle(level, variant = 'shortest', misroutes = LIVES - 1) {
  const masks = reachableColourMasks(level);
  const dist = colourDistances(level, variant === 'longest');
  const sacrificed = new Set();
  let budget = misroutes;
  let state = createState(level);
  let maxNextSpawn = 0;

  while (state.phase === 'running' && state.tick < MAX_RUN_TICKS) {
    const inputs = [];
    for (const car of state.cars) {
      for (const node of branchesEnteredThisTick(level, state.open, car)) {
        const open = state.open[node.junctionId];
        if (sacrificed.has(car.id)) continue; // already doomed; never routed again

        const good = [0, 1].filter((k) => reaches(level, masks, node, k, car.colour));
        const bad = [0, 1].filter((k) => !reaches(level, masks, node, k, car.colour));
        let want;
        if (budget > 0 && bad.length > 0) {
          want = bad[0]; // the injected misroute, taken at the first opportunity
          budget -= 1;
          sacrificed.add(car.id);
        } else if (good.length === 0) {
          continue; // nothing to do for a car that cannot be saved
        } else if (good.length === 1) {
          want = good[0];
        } else {
          // Both branches reach the colour: the variant decides which way the car is sent,
          // and that is the whole point — it is what makes transit time an interval.
          const cost = (k) => level.edges[node.out[k]].lengthMlu + dist[level.edges[node.out[k]].to][car.colour];
          want = variant === 'longest'
            ? (cost(1) > cost(0) ? 1 : 0)
            : (cost(1) < cost(0) ? 1 : 0);
        }
        if (open !== want) inputs.push({ tick: state.tick, junctionId: node.junctionId });
      }
    }
    // Unlimited taps, but a junction toggled twice in one tick nets out (AC-111), so a tick's
    // inputs are deduplicated to the set of junctions that must change.
    const once = [...new Set(inputs.map((i) => i.junctionId))].map((junctionId) => ({ tick: state.tick, junctionId }));
    state = step(state, once);
    if (state.nextSpawn > maxNextSpawn) maxNextSpawn = state.nextSpawn;
  }

  return {
    state,
    cleared: state.phase === 'won',
    misrouted: state.misrouted,
    injected: misroutes - budget,
    maxNextSpawn,
    margin: level.spawns.length - maxNextSpawn,
    ticks: state.tick,
  };
}
