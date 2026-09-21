// Offramp — solver bots (generation.md §7.1).
//
// Harness code, not engine code. Two bots share one routing core:
//   * unconstrained — may tap any number of junctions on any tick. Proves solvability.
//   * constrained   — the attention model of generation.md §7.1, normative. Proves
//                     playability.
//
// §7.1 was rewritten after slice 1. The old bot constrained TIMING only — reaction latency,
// inter-tap gap, lockout, a lookahead window — and a bot with perfect topology knowledge,
// perfect memory of every car's colour and no cost to switching between cars cannot measure
// the difficulty of dividing attention, which is what Offramp is about. The bot below pays
// for attention: a bounded working set, a cost in ticks to glance, to acquire and to switch,
// memory that decays, and a safe-window check that ranges only over the cars it is currently
// holding. BOT_LOOKAHEAD_CARS is deleted.

import { CAR_SPEED, createState, reachableColourMasks, step } from '../../src/engine/index.js';
import { makeStream, mix32 } from '../../src/engine/rng.js';

// --- §7.1.3 constants ---------------------------------------------------------------------
// Motor and latency.
export const BOT_MIN_TAP_GAP = 11; // 180 ms between consecutive taps
export const BOT_MAX_TAPS_PER_TICK = 1; // one finger; a consequence of §7.1.5, not a rule
export const BOT_LOCKOUT_TICKS = 6; // 100 ms; scoped to the FOCUSED car
export const BOT_SAFE_WINDOW = 20; // 333 ms; ranges over the working set only

// Attention.
export const BOT_WORKING_SET = 3; // cars held at once
export const BOT_SCAN_TICKS = 6; // 100 ms per glance
export const BOT_ACQUIRE_TICKS = 15; // 250 ms to focus a car NOT held
export const BOT_SWITCH_TICKS = 4; // 67 ms to re-focus a car already held
export const BOT_MEMORY_TICKS = 120; // 2.00 s before an unrefreshed entry is dropped
export const BOT_URGENCY_TICKS = 90; // 1.50 s: a further-off car does not escalate
export const BOT_LAPSE_PCT = 3; // 3 % of glances land on nothing
export const BOT_SALT = 0x5bf03635;

/** The constants as a struct, so AC-240 can lift the attention ones without editing source. */
export const BOT_CONSTANTS = Object.freeze({
  minTapGap: BOT_MIN_TAP_GAP,
  lockout: BOT_LOCKOUT_TICKS,
  safeWindow: BOT_SAFE_WINDOW,
  workingSet: BOT_WORKING_SET,
  scan: BOT_SCAN_TICKS,
  acquire: BOT_ACQUIRE_TICKS,
  switchTicks: BOT_SWITCH_TICKS,
  memory: BOT_MEMORY_TICKS,
  urgency: BOT_URGENCY_TICKS,
  lapsePct: BOT_LAPSE_PCT,
});

/**
 * AC-240's injection: every ATTENTION constraint removed, every TIMING constraint kept.
 * Named here rather than built ad hoc in the harness so the two runs differ by exactly this.
 */
export const BOT_NO_ATTENTION = Object.freeze({
  workingSet: Infinity,
  acquire: 0,
  switchTicks: 0,
  memory: Infinity,
});

/**
 * §7.1.5 D3's sweep. `onset` is the normative rule: a car that has never been glanced at goes
 * next, exactly once, at full price. `roundrobin` is round 3's shipped sweep, kept only so
 * that AC-246 and AC-247 can inject the defect they exist to catch — it is NOT a bot constant
 * and nothing selects it except a fault injection (§8, AC-246's note).
 */
export const SWEEP_ONSET = 'onset';
export const SWEEP_ROUND_ROBIN = 'roundrobin';

/** Hard stop far beyond any legal run length, so a stall is a failure rather than a hang. */
const MAX_RUN_TICKS = 20000;

// --- §7.1.6 helper functions ---------------------------------------------------------------

/**
 * The next branch node this car will reach, following pass nodes (which offer no decision).
 * Returns null when the car is committed to a depot.
 */
export function nextJunction(level, car) {
  let node = level.nodes[level.edges[car.edgeId].to];
  for (;;) {
    if (node.kind === 'depot') return null;
    if (node.kind === 'branch') return node;
    node = level.nodes[level.edges[node.out[0]].to];
  }
}

/**
 * Ticks until `car` reaches `junctionNode`, following the junctions that are open NOW.
 * Infinity if the car reaches a depot first.
 */
export function ticksToReach(level, open, car, junctionNode) {
  const first = level.edges[car.edgeId];
  let d = first.lengthMlu - car.progress;
  let node = level.nodes[first.to];
  while (node !== junctionNode) {
    if (node.kind === 'depot') return Infinity;
    const e = level.edges[node.out[node.kind === 'branch' ? open[node.junctionId] : 0]];
    d += e.lengthMlu;
    node = level.nodes[e.to];
  }
  return Math.ceil(d / CAR_SPEED);
}

/** Does branch k of this branch node lead to a depot of `colour`? */
function reaches(level, masks, node, k, colour) {
  return ((masks[level.edges[node.out[k]].to] >> colour) & 1) === 1;
}

/**
 * §7.1.6 evaluate. Returns the branch node to tap, or null for NOTHING.
 * `rememberedColour` rather than `car.colour`: the bot reads its memory, not the world.
 */
export function evaluate(level, masks, open, car, rememberedColour) {
  const j = nextJunction(level, car);
  if (j === null) return null;
  const k0 = reaches(level, masks, j, 0, rememberedColour);
  const k1 = reaches(level, masks, j, 1, rememberedColour);
  if (k0 === k1) return null; // both branches work, or neither does
  const want = k0 ? 0 : 1;
  if (open[j.junctionId] === want) return null;
  return j;
}

/**
 * §7.1.6 breaksHeldCar. Ranges over bot.mem and nothing else: a car the bot has forgotten
 * will be misrouted by this flip and it will never see it coming. That blindness is the
 * failure mode the game is made of.
 */
function breaksHeldCar(level, masks, sim, bot, junctionNode, focusedCarId, carById, K) {
  const jid = junctionNode.junctionId;
  const cur = sim.open[jid];
  for (const m of bot.mem) {
    if (m.carId === focusedCarId) continue;
    const o = carById.get(m.carId);
    if (o === undefined) continue;
    if (nextJunction(level, o) !== junctionNode) continue;
    if (ticksToReach(level, sim.open, o, junctionNode) > K.safeWindow) continue;
    if (reaches(level, masks, junctionNode, cur, m.colour) &&
        !reaches(level, masks, junctionNode, cur ^ 1, m.colour)) {
      return true;
    }
  }
  return false;
}

/** Is this car, on the switches as they stand now, on a path to a depot of its own colour? */
function routedCorrectly(level, open, car) {
  let node = level.nodes[level.edges[car.edgeId].to];
  for (;;) {
    if (node.kind === 'depot') return node.depotColour === car.colour;
    const k = node.kind === 'branch' ? open[node.junctionId] : 0;
    node = level.nodes[level.edges[node.out[k]].to];
  }
}

// --- §7.1.4 bot state ----------------------------------------------------------------------

export function makeBot(seed, overrides = {}) {
  // `sweepMode` is not one of §7.1.3's constants and must not reach `K`: the constants are the
  // instrument, the sweep is the procedure.
  const { sweepMode = SWEEP_ONSET, ...attention } = overrides;
  if (sweepMode !== SWEEP_ONSET && sweepMode !== SWEEP_ROUND_ROBIN) {
    throw new Error('BAD_SWEEP_MODE: ' + sweepMode);
  }
  return {
    K: { ...BOT_CONSTANTS, ...attention },
    sweepMode,
    rng: makeStream(mix32(seed, BOT_SALT)),
    busyUntil: 0,
    focus: null,
    mem: [],
    cursor: null,
    maxSeen: -1, // §7.1.4 — the highest id ever glanced at; how an un-glanced onset is found
    lastTapTick: -BOT_MIN_TAP_GAP,
    // Instrumentation (AC-235, AC-236, AC-239). Never read by the procedure.
    stats: {
      ticks: 0,
      glances: 0,
      draws: 0,
      lapses: 0,
      focusSwitch: 0,
      focusAcquire: 0,
      evictions: 0,
      expiries: 0,
      memSum: 0,
      memMax: 0,
      evaluations: 0,
      evaluatedNothing: 0,
      tapsBlockedByGap: 0,
      tapsBlockedByLockout: 0,
      tapsBlockedBySafeWindow: 0,
      taps: 0,
      captures: 0, // §7.1.5 D3 onset captures — AC-247
      capturedIds: new Set(), // distinct cars captured; size must equal `captures`
      glancedIds: new Set(), // distinct cars ever glanced at; size must equal `captures`
      tapCars: [], // { tick, junctionId, carId } — AC-232 / AC-235 evidence
      endangered: new Set(), // cars a flip for a held car put on a losing branch while unheld
      unseenMisroutes: 0,
    },
  };
}

/** `nextCarId` — the fixed cyclic sweep of §7.1.5. `cars` is ascending by id. */
function nextCarId(cars, cursor) {
  if (cursor !== null) {
    for (const c of cars) if (c.id > cursor) return c.id;
  }
  return cars[0].id;
}

/**
 * §7.1.5 — the per-tick procedure, normative. Runs BEFORE step() for tick T and returns that
 * tick's input array: either [] or exactly one input. Every branch returns.
 */
export function botTick(level, masks, sim, bot) {
  const K = bot.K;
  const T = sim.tick;
  const st = bot.stats;

  const carById = new Map();
  for (const c of sim.cars) carById.set(c.id, c);

  // ── A. HOUSEKEEPING. Free, and it happens on every tick including busy ones.
  const kept = [];
  for (const m of bot.mem) {
    if (T - m.seenTick >= K.memory) {
      st.expiries += 1; // A1
    } else if (!carById.has(m.carId)) {
      // A2 — the car is gone; not an expiry
    } else {
      kept.push(m);
    }
  }
  bot.mem = kept;
  if (bot.focus !== null && !carById.has(bot.focus)) bot.focus = null; // A3
  if (bot.focus !== null && !bot.mem.some((m) => m.carId === bot.focus)) bot.focus = null; // A4

  st.ticks += 1;
  st.memSum += bot.mem.length;
  if (bot.mem.length > st.memMax) st.memMax = bot.mem.length;

  // ── B. BUSY.
  if (T < bot.busyUntil) return [];

  // ── C. ACT. A ready focus is evaluated and then released, whatever the outcome.
  if (bot.focus !== null) {
    const c = carById.get(bot.focus);
    const m = bot.mem.find((e) => e.carId === bot.focus);
    const j = evaluate(level, masks, sim.open, c, m.colour);
    m.seenTick = T; // looking refreshes, either way
    bot.focus = null;
    bot.busyUntil = T + 1;
    st.evaluations += 1;
    if (j === null) {
      st.evaluatedNothing += 1;
      return [];
    }
    const jid = j.junctionId;
    if (T - bot.lastTapTick < K.minTapGap) {
      st.tapsBlockedByGap += 1;
      return [];
    }
    if (ticksToReach(level, sim.open, c, j) < K.lockout) {
      st.tapsBlockedByLockout += 1;
      return [];
    }
    if (breaksHeldCar(level, masks, sim, bot, j, c.id, carById, K)) {
      st.tapsBlockedBySafeWindow += 1;
      return [];
    }
    bot.lastTapTick = T;
    st.taps += 1;
    st.tapCars.push({ tick: T, junctionId: jid, carId: c.id });
    recordEndangered(level, masks, sim, bot, j, c.id);
    return [{ tick: T, junctionId: jid }];
  }

  // ── D. GLANCE.
  bot.busyUntil = T + K.scan; // D1
  if (sim.cars.length === 0) return []; // D2

  // D3 — onset capture, then the round-robin sweep. A car that has never been glanced at goes
  // next, EXACTLY ONCE (`maxSeen` is monotone), and the cursor is NOT moved: clobbering it
  // restarted the sweep at the newest car every spawn and starved everything older, which is
  // the defect in one of §7.1.8's rejected variants. This buys an ORDERING and nothing else —
  // the glance below still costs K.scan and the focus still costs K.acquire in full.
  let glanceAt = null;
  if (bot.sweepMode === SWEEP_ONSET) {
    // sim.cars is ascending by id (gameplay.md §2.4), so the first match is the smallest.
    for (const car of sim.cars) {
      if (car.id > bot.maxSeen) {
        glanceAt = car.id;
        break;
      }
    }
  }
  if (glanceAt !== null) {
    bot.maxSeen = glanceAt;
    st.captures += 1;
    st.capturedIds.add(glanceAt);
  } else {
    bot.cursor = nextCarId(sim.cars, bot.cursor);
    glanceAt = bot.cursor;
    if (glanceAt > bot.maxSeen) bot.maxSeen = glanceAt;
  }
  st.glancedIds.add(glanceAt);

  const r = bot.rng.next(); // D4 — the one and only draw
  st.draws += 1;
  st.glances += 1;
  if (r % 100 < K.lapsePct) {
    st.lapses += 1;
    return [];
  }
  const c = carById.get(glanceAt); // D5
  const j = nextJunction(level, c);
  if (j === null) {
    const i = bot.mem.findIndex((e) => e.carId === c.id);
    if (i !== -1) bot.mem.splice(i, 1);
    return [];
  }
  if (ticksToReach(level, sim.open, c, j) > K.urgency) return [];

  // ── E. ESCALATE TO FOCUS.
  const held = bot.mem.find((e) => e.carId === c.id);
  if (held) {
    held.seenTick = T;
    bot.focus = c.id;
    bot.busyUntil = T + K.scan + K.switchTicks;
    st.focusSwitch += 1;
    return [];
  }
  if (bot.mem.length >= K.workingSet) {
    bot.mem.shift(); // eviction removes mem[0] — insertion order, not recency of use
    st.evictions += 1;
  }
  bot.mem.push({ carId: c.id, colour: c.colour, seenTick: T });
  bot.focus = c.id;
  bot.busyUntil = T + K.scan + K.acquire;
  st.focusAcquire += 1;
  return [];
}

/**
 * AC-239's last column. After a tap made for the focused car, any car the bot is NOT holding
 * that this flip has just put onto a branch that cannot reach its colour is marked. The mark
 * is cleared as soon as the car is on a correct path again, so a car that is rescued is not
 * counted; what remains at the misroute event is a misroute the bot could not see coming.
 */
function recordEndangered(level, masks, sim, bot, junctionNode, focusedCarId) {
  const jid = junctionNode.junctionId;
  const after = sim.open[jid] ^ 1;
  const before = sim.open[jid];
  for (const o of sim.cars) {
    if (o.id === focusedCarId) continue;
    if (bot.mem.some((m) => m.carId === o.id)) continue;
    if (nextJunction(level, o) !== junctionNode) continue;
    if (reaches(level, masks, junctionNode, before, o.colour) &&
        !reaches(level, masks, junctionNode, after, o.colour)) {
      bot.stats.endangered.add(o.id);
    }
  }
}

// --- AC-246: first-decision reliability ------------------------------------------------------

/** Does `edgeId` lead, eventually, to a depot of `colour`? */
function edgeReaches(level, masks, edgeId, colour) {
  return ((masks[level.edges[edgeId].to] >> colour) & 1) === 1;
}

/**
 * AC-246, measured rather than inferred. Every junction a car ACTUALLY CROSSES is classified
 * as that car's **first** decision or as a **later** one, and `p_first` / `p_later` are the
 * shares of each class the car left on a branch that cannot reach its colour.
 *
 * The crossings are recovered from the simulation rather than predicted: between two ticks a
 * car's `edgeId` changes, and the path from the end of its previous edge to the start of its
 * current one under `state.open` — which is the junction state this tick's movement actually
 * used, because inputs are applied at step 2 and cars advance at step 4 — is unique. Nothing
 * here re-implements the bot's intent; it reads where cars went.
 *
 * "Decision" has two defensible readings in AC-246's parenthesis and this measures both:
 *   - `colour` (primary): the two branches differ in whether they reach THIS car's colour.
 *     This is `evaluate`'s own test (§7.1.6, `k0 === k1` is NOTHING), so it counts exactly the
 *     junctions that are a question for the car crossing them.
 *   - `sets` (reported alongside): the two branches differ in their reachable-colour SETS,
 *     the literal reading of "differ in which depot colours they reach", which also counts
 *     junctions that are a decision for some other colour but not for this car.
 * The verdict is taken on `colour`; `sets` is printed so the reading cannot change the answer
 * without that being visible.
 */
export function makeDecisionTracker(level, masks) {
  const prevEdge = new Map();
  const hadFirstColour = new Set();
  const hadFirstSets = new Set();
  const t = {
    firstN: 0, firstBad: 0, laterN: 0, laterBad: 0,
    setsFirstN: 0, setsFirstBad: 0, setsLaterN: 0, setsLaterBad: 0,
    crossings: 0, walkFailures: 0,
  };

  function record(car, node, tookEdgeId) {
    t.crossings += 1;
    const bad = !edgeReaches(level, masks, tookEdgeId, car.colour) ? 1 : 0;
    const k0 = edgeReaches(level, masks, node.out[0], car.colour);
    const k1 = edgeReaches(level, masks, node.out[1], car.colour);
    if (k0 !== k1) {
      if (hadFirstColour.has(car.id)) {
        t.laterN += 1;
        t.laterBad += bad;
      } else {
        hadFirstColour.add(car.id);
        t.firstN += 1;
        t.firstBad += bad;
      }
    }
    if (masks[level.edges[node.out[0]].to] !== masks[level.edges[node.out[1]].to]) {
      if (hadFirstSets.has(car.id)) {
        t.setsLaterN += 1;
        t.setsLaterBad += bad;
      } else {
        hadFirstSets.add(car.id);
        t.setsFirstN += 1;
        t.setsFirstBad += bad;
      }
    }
  }

  return {
    totals: t,
    observe(state) {
      for (const car of state.cars) {
        const prev = prevEdge.get(car.id);
        prevEdge.set(car.id, car.edgeId);
        if (prev === undefined || prev === car.edgeId) continue;
        let edgeId = prev;
        let guard = 0;
        while (edgeId !== car.edgeId) {
          if ((guard += 1) > 64) {
            t.walkFailures += 1;
            break;
          }
          const node = level.nodes[level.edges[edgeId].to];
          if (node.kind === 'depot') {
            t.walkFailures += 1;
            break;
          }
          const took = node.out[node.kind === 'branch' ? state.open[node.junctionId] : 0];
          if (node.kind === 'branch') record(car, node, took);
          edgeId = took;
        }
      }
    },
  };
}

// --- unconstrained ---------------------------------------------------------------------------

/** Every junction set for whichever car reaches it soonest. No limits at all. */
function unconstrainedInputs(level, masks, state) {
  const want = new Map();
  for (const car of state.cars) {
    const j = nextJunction(level, car);
    if (!j) continue;
    const jid = j.junctionId;
    const cur = state.open[jid];
    let branch;
    if (reaches(level, masks, j, cur, car.colour)) branch = cur;
    else if (reaches(level, masks, j, cur ^ 1, car.colour)) branch = cur ^ 1;
    else continue;
    const eta = ticksToReach(level, state.open, car, j);
    const prev = want.get(jid);
    if (!prev || eta < prev.eta || (eta === prev.eta && car.id < prev.carId)) {
      want.set(jid, { eta, carId: car.id, branch });
    }
  }
  const inputs = [];
  for (const [jid, w] of want) {
    if (state.open[jid] !== w.branch) inputs.push({ tick: state.tick, junctionId: jid });
  }
  inputs.sort((a, b) => a.junctionId - b.junctionId);
  return inputs;
}

// --- running a level ---------------------------------------------------------------------------

/**
 * Play one level to a terminal phase.
 * mode: 'constrained' | 'unconstrained' | 'never'
 * opts.attention: overrides for the §7.1.3 constants (AC-240 only).
 * opts.sweepMode: SWEEP_ONSET (default) or SWEEP_ROUND_ROBIN (AC-246/AC-247 injection only).
 * opts.onTick(state, before, inputs): per-tick observer, used by the near-miss measurement.
 * opts.onBotTick(bot, sim, inputs): per-tick observer of the BOT's own state (AC-235).
 * opts.decisions: a tracker from makeDecisionTracker(), fed the post-step state (AC-246).
 */
export function playLevel(level, mode = 'constrained', opts = {}) {
  const masks = reachableColourMasks(level);
  const overrides = { ...(opts.attention || {}) };
  if (opts.sweepMode) overrides.sweepMode = opts.sweepMode;
  const bot = makeBot(level.seed, overrides);
  let state = createState(level);
  const inputs = [];
  const { onTick, onBotTick, decisions, uncappedLives } = opts;

  // generation.md §8 `--lives-distribution` / §6.1.5. To measure LIVES as a lever without
  // changing a rule of the game, the run is given a life count no run can spend, so it always
  // reaches the bell and `misrouted` is the honest count of what the player did. The clear
  // rate at 1, 2, 3 and 4 lives is then read straight OFF that distribution rather than
  // inverted from anything — which matters, because at one life the governing model is
  // `(1-p)^N`, a different curve and not a shifted one.
  //
  // `lives` is an integer here as everywhere: Infinity would be a non-integer in a state the
  // fuzzer's invariants also read. LIVES itself is untouched (gameplay.md §4.1).
  if (uncappedLives) state = { ...state, lives: 1e9 };

  while (state.phase === 'running' && state.tick < MAX_RUN_TICKS) {
    let tickInputs;
    if (mode === 'never') tickInputs = [];
    else if (mode === 'unconstrained') tickInputs = unconstrainedInputs(level, masks, state);
    else tickInputs = botTick(level, masks, state, bot);

    if (onBotTick) onBotTick(bot, state, tickInputs);
    for (const i of tickInputs) inputs.push(i);
    const before = state;
    state = step(state, tickInputs);

    if (mode === 'constrained' && bot.stats.endangered.size) {
      for (const e of state.events) {
        if (e.type === 'misrouted' && bot.stats.endangered.has(e.carId)) {
          bot.stats.unseenMisroutes += 1;
          bot.stats.endangered.delete(e.carId);
        }
      }
      for (const car of state.cars) {
        if (bot.stats.endangered.has(car.id) && routedCorrectly(level, state.open, car)) {
          bot.stats.endangered.delete(car.id);
        }
      }
      for (const id of bot.stats.endangered) {
        if (!state.cars.some((c) => c.id === id)) bot.stats.endangered.delete(id);
      }
    }
    if (decisions) decisions.observe(state);
    if (onTick) onTick(state, before, tickInputs);
  }

  return {
    level,
    state,
    bot,
    inputs,
    // A level is CLEARED by surviving its two minutes (gameplay.md §4.2, AC-221–AC-225).
    cleared: state.phase === 'ended',
    stalled: state.phase === 'running',
    ticks: state.tick,
    seconds: state.tick / 60,
    taps: inputs.length,
    tapsPerSecond: inputs.length / (state.tick / 60),
    misroutes: state.misrouted,
    delivered: state.delivered,
    attention: mode === 'constrained' ? summariseAttention(bot, state.tick) : null,
  };
}

function summariseAttention(bot, ticks) {
  const s = bot.stats;
  const secs = ticks / 60 || 1;
  return {
    seconds: secs,
    glances: s.glances,
    draws: s.draws,
    lapses: s.lapses,
    captures: s.captures,
    capturedDistinct: s.capturedIds.size,
    glancedDistinct: s.glancedIds.size,
    focusSwitch: s.focusSwitch,
    focusAcquire: s.focusAcquire,
    evictions: s.evictions,
    expiries: s.expiries,
    memMean: s.memSum / (s.ticks || 1),
    memMax: s.memMax,
    evaluations: s.evaluations,
    evaluatedNothing: s.evaluatedNothing,
    tapsBlockedByGap: s.tapsBlockedByGap,
    tapsBlockedByLockout: s.tapsBlockedByLockout,
    tapsBlockedBySafeWindow: s.tapsBlockedBySafeWindow,
    unseenMisroutes: s.unseenMisroutes,
    tapCars: s.tapCars,
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
