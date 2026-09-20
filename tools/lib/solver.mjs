// Offramp — solver bots (generation.md §7.1).
//
// Harness code, not engine code. Two bots share one routing core:
//   * unconstrained — may tap any number of junctions on any tick. Proves solvability.
//   * constrained   — held to the normative human limits below. Proves playability.
//
// The constraint constants are quoted from generation.md §7.1 and are normative: a bot that
// clears a level by doing something a person cannot do is not evidence.

import { createState, reachableColourMasks, step } from '../../src/engine/index.js';

export const BOT_REACTION_TICKS = 15;
export const BOT_MIN_TAP_GAP = 11;
export const BOT_MAX_TAPS_PER_TICK = 1;
export const BOT_LOCKOUT_TICKS = 6;
export const BOT_LOOKAHEAD_CARS = 4;
export const BOT_SAFE_WINDOW = 20;

/** Hard stop far beyond any legal run length, so a stall is a failure rather than a hang. */
export const MAX_RUN_TICKS = 20000;

/**
 * The next branch node a car will reach, the distance to it in MLU, and the ETA in ticks.
 * Pass nodes are followed because they offer no decision. Returns null if the car is
 * committed to a depot.
 */
export function nextJunction(level, car) {
  let edge = level.edges[car.edgeId];
  let dist = edge.lengthMlu - car.progress;
  let node = level.nodes[edge.to];
  while (node.kind === 'pass') {
    edge = level.edges[node.out[0]];
    dist += edge.lengthMlu;
    node = level.nodes[edge.to];
  }
  if (node.kind !== 'branch') return null;
  return { node, dist, eta: Math.ceil(dist / level.speedMluPerTick) };
}

/** Does branch k of this node lead to a depot of `colour`? */
function branchServes(level, masks, node, k, colour) {
  return (masks[level.edges[node.out[k]].to] >> colour) & 1;
}

/**
 * The branch this car needs. Prefers the branch already open when both work, so the bot
 * never taps for nothing. Returns null if neither branch reaches the car's colour, which
 * means an earlier decision already stranded it.
 */
export function desiredBranch(level, masks, node, colour, currentOpen) {
  if (branchServes(level, masks, node, currentOpen, colour)) return currentOpen;
  const other = currentOpen ^ 1;
  if (branchServes(level, masks, node, other, colour)) return other;
  return null;
}

/** Every car whose next junction is `junctionId`, with ETAs. */
function carsHeadingTo(level, state, junctionId) {
  const out = [];
  for (const car of state.cars) {
    const nj = nextJunction(level, car);
    if (nj && nj.node.junctionId === junctionId) out.push({ car, nj });
  }
  return out;
}

/** Unconstrained policy: every junction is set for whichever car reaches it soonest. */
function unconstrainedInputs(level, masks, state) {
  const want = new Map();
  for (const car of state.cars) {
    const nj = nextJunction(level, car);
    if (!nj) continue;
    const jid = nj.node.junctionId;
    const branch = desiredBranch(level, masks, nj.node, car.colour, state.open[jid]);
    if (branch === null) continue;
    const cur = want.get(jid);
    if (!cur || nj.eta < cur.eta || (nj.eta === cur.eta && car.id < cur.carId)) {
      want.set(jid, { eta: nj.eta, carId: car.id, branch });
    }
  }
  const inputs = [];
  for (const [jid, w] of want) {
    if (state.open[jid] !== w.branch) inputs.push({ tick: state.tick, junctionId: jid });
  }
  inputs.sort((a, b) => a.junctionId - b.junctionId);
  return inputs;
}

/**
 * Constrained policy — generation.md §7.1.
 *
 * §7.1's policy paragraph is ambiguous in one place that turns out to dominate the measured
 * clear rate, so the reading is selectable and every number this harness reports names its
 * policy. The constraint CONSTANTS above are normative and identical in all three.
 *
 *   'nearest' (default) — "the nearest actionable car": the lookahead window is walked in
 *       ETA order; cars the bot has not yet reacted to, and cars whose junction is already
 *       correct, are passed over; the first car whose junction is wrong and permitted is
 *       tapped. Keeps the blind spot §7.1 deliberately specifies — a flip made for a distant
 *       car outside the 20-tick safe window may misroute a nearer one.
 *   'literal'  — "If the junction is already correct, do nothing" read as ending the tick:
 *       the bot only ever acts on the single nearest actionable car.
 *   'patient'  — as 'nearest', but a car still inside its reaction latency ends the tick
 *       rather than being passed over: attention is serial.
 */
function constrainedInputs(level, masks, state, mem, policy) {
  const T = state.tick;
  if (T - mem.lastTapTick < BOT_MIN_TAP_GAP) return [];

  const candidates = [];
  for (const car of state.cars) {
    const nj = nextJunction(level, car);
    if (nj) candidates.push({ car, nj });
  }
  candidates.sort((a, b) => a.nj.eta - b.nj.eta || a.car.id - b.car.id);

  const window = candidates.slice(0, BOT_LOOKAHEAD_CARS);
  for (const { car, nj } of window) {
    if (T < (mem.seenAt.get(car.id) ?? Infinity)) {
      if (policy === 'patient') break; // reaction latency, attention stays on this car
      continue;
    }
    const jid = nj.node.junctionId;
    const branch = desiredBranch(level, masks, nj.node, car.colour, state.open[jid]);
    if (branch === null) continue; // already stranded; nothing this junction can do
    if (state.open[jid] === branch) {
      if (policy === 'literal') break; // "if the junction is already correct, do nothing"
      continue;
    }

    const heading = carsHeadingTo(level, state, jid);

    // Lockout: no flip inside the last 100 ms before ANY car reaches that junction (AC-232).
    let locked = false;
    for (const h of heading) if (h.nj.eta <= BOT_LOCKOUT_TICKS) locked = true;
    if (locked) continue;

    // Safe window: do not flip if it would misroute another car arriving within 20 ticks.
    let unsafe = false;
    for (const h of heading) {
      if (h.car.id === car.id) continue;
      if (h.nj.eta <= BOT_SAFE_WINDOW && !branchServes(level, masks, nj.node, branch, h.car.colour)) {
        unsafe = true;
      }
    }
    if (unsafe) continue;

    mem.lastTapTick = T;
    return [{ tick: T, junctionId: jid }];
  }
  return [];
}

/** Track reaction latency: a car becomes actionable 15 ticks after it appears or after it
 *  transitions at a junction. */
function updateReaction(level, state, mem) {
  const live = new Set();
  for (const car of state.cars) {
    live.add(car.id);
    const prevEdge = mem.lastEdge.get(car.id);
    if (prevEdge === undefined) {
      mem.seenAt.set(car.id, state.tick + BOT_REACTION_TICKS);
    } else if (prevEdge !== car.edgeId) {
      const fromNode = level.nodes[level.edges[car.edgeId].from];
      if (fromNode.kind === 'branch') mem.seenAt.set(car.id, state.tick + BOT_REACTION_TICKS);
    }
    mem.lastEdge.set(car.id, car.edgeId);
  }
  for (const id of mem.lastEdge.keys()) if (!live.has(id)) mem.lastEdge.delete(id);
}

/**
 * Play one level to a terminal phase.
 * mode: 'constrained' | 'unconstrained' | 'never'
 * opts.policy: 'nearest' | 'literal' | 'patient' (constrained mode only)
 * Returns the run record plus the measurements the targets are stated against.
 */
export function playLevel(level, mode = 'constrained', opts = {}) {
  const policy = opts.policy || 'nearest';
  const masks = reachableColourMasks(level);
  const mem = { lastTapTick: -1000, seenAt: new Map(), lastEdge: new Map() };
  let state = createState(level);
  const inputs = [];
  const onTick = opts.onTick;

  while (state.phase === 'running' && state.tick < MAX_RUN_TICKS) {
    updateReaction(level, state, mem);
    let tickInputs;
    if (mode === 'never') tickInputs = [];
    else if (mode === 'unconstrained') tickInputs = unconstrainedInputs(level, masks, state);
    else tickInputs = constrainedInputs(level, masks, state, mem, policy);

    for (const i of tickInputs) inputs.push(i);
    const before = state;
    state = step(state, tickInputs);
    if (onTick) onTick(state, before, tickInputs);
  }

  return {
    level,
    state,
    inputs,
    cleared: state.phase === 'won',
    stalled: state.phase === 'running',
    ticks: state.tick,
    seconds: state.tick / 60,
    taps: inputs.length,
    tapsPerSecond: inputs.length / (state.tick / 60),
    misroutes: state.misrouted,
    delivered: state.delivered,
    score: state.score,
  };
}

/** Replay a recorded run: seed + band + tick-stamped inputs, nothing else. */
export function replay(level, inputs) {
  const byTick = new Map();
  for (const i of inputs) {
    if (!byTick.has(i.tick)) byTick.set(i.tick, []);
    byTick.get(i.tick).push(i);
  }
  let state = createState(level);
  while (state.phase === 'running' && state.tick < MAX_RUN_TICKS) {
    state = step(state, byTick.get(state.tick) || []);
  }
  return state;
}
