// Solver-bot ACs — AC-220, AC-232, AC-235, AC-236, AC-240, AC-813, AC-814.
//
// The large sweeps (1,000 seeds per band) live in tools/bot.mjs and tools/pacing.mjs; this
// suite holds the sample size that can run inside `npm test`, plus every structural property
// of generation.md §7.1's attention model that does not need a sweep to check.

import test from 'node:test';
import assert from 'node:assert/strict';

import { generate, reachableColourMasks } from '../src/engine/generate.js';
import { createState, step } from '../src/engine/step.js';
import { twoDepotLevel } from './helpers.js';
import {
  BOT_ACQUIRE_TICKS,
  BOT_CONSTANTS,
  BOT_LAPSE_PCT,
  BOT_LOCKOUT_TICKS,
  BOT_MAX_TAPS_PER_TICK,
  BOT_MEMORY_TICKS,
  BOT_MIN_TAP_GAP,
  BOT_NO_ATTENTION,
  BOT_SAFE_WINDOW,
  BOT_SALT,
  BOT_SCAN_TICKS,
  BOT_SWITCH_TICKS,
  BOT_URGENCY_TICKS,
  BOT_WORKING_SET,
  botTick,
  evaluate,
  makeBot,
  nextJunction,
  playLevel,
  replay,
  ticksToReach,
} from '../tools/lib/solver.mjs';

const SEEDS = 120;

test('§7.1.3 · the bot constants are the design values, and BOT_LOOKAHEAD_CARS is gone', async () => {
  assert.equal(BOT_MIN_TAP_GAP, 11);
  assert.equal(BOT_MAX_TAPS_PER_TICK, 1);
  assert.equal(BOT_LOCKOUT_TICKS, 6);
  assert.equal(BOT_WORKING_SET, 3);
  assert.equal(BOT_SCAN_TICKS, 6);
  assert.equal(BOT_ACQUIRE_TICKS, 15);
  assert.equal(BOT_SWITCH_TICKS, 4);
  assert.equal(BOT_MEMORY_TICKS, 120);
  assert.equal(BOT_URGENCY_TICKS, 90);
  assert.equal(BOT_LAPSE_PCT, 3);
  const mod = await import('../tools/lib/solver.mjs');
  assert.equal(mod.BOT_LOOKAHEAD_CARS, undefined, 'BOT_LOOKAHEAD_CARS is deleted by §7.1.3');
});

test('AC-220 · the unconstrained bot clears every band with zero misroutes', () => {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < SEEDS; seed += 1) {
      const r = playLevel(generate(seed, band), 'unconstrained');
      assert.equal(r.cleared, true, 'band ' + band + ' seed ' + seed + ' not cleared');
      assert.equal(r.misroutes, 0, 'band ' + band + ' seed ' + seed + ' misrouted');
      assert.ok(!r.stalled);
    }
  }
});

test('AC-814 · a bot that never taps clears 0 % at every band', () => {
  for (let band = 1; band <= 5; band += 1) {
    let cleared = 0;
    for (let seed = 0; seed < SEEDS; seed += 1) {
      if (playLevel(generate(seed, band), 'never').cleared) cleared += 1;
    }
    assert.equal(cleared, 0, 'band ' + band + ' cleared ' + cleared + ' levels without tapping');
  }
});

/**
 * Drive the §7.1.5 procedure by hand so that the bot's state can be read BEFORE and AFTER
 * every call. The bot's own bookkeeping is not evidence about the bot.
 */
function driveObserved(level, overrides = {}) {
  const masks = reachableColourMasks(level);
  const bot = makeBot(level.seed, overrides);
  let state = createState(level);
  const taps = [];
  const violations = [];
  let ticks = 0;
  let glances = 0;
  let lastDraws = 0;
  while (state.phase === 'running' && state.tick < 20000) {
    const focusBefore = bot.focus;
    const memBefore = bot.mem.map((m) => ({ ...m }));
    const inputs = botTick(level, masks, state, bot);

    if (bot.stats.draws > lastDraws) {
      if (bot.stats.draws !== lastDraws + 1) violations.push('more than one draw on tick ' + state.tick);
      glances += 1;
      lastDraws = bot.stats.draws;
    }
    if (bot.mem.length > (overrides.workingSet ?? BOT_WORKING_SET)) {
      violations.push('mem grew to ' + bot.mem.length + ' on tick ' + state.tick);
    }
    const memLimit = overrides.memory ?? BOT_MEMORY_TICKS;
    for (const m of bot.mem) {
      if (state.tick - m.seenTick >= memLimit) {
        violations.push('stale mem entry for car ' + m.carId + ' on tick ' + state.tick);
      }
    }
    if (inputs.length > BOT_MAX_TAPS_PER_TICK) violations.push('two taps on tick ' + state.tick);
    if (inputs.length) {
      if (focusBefore === null) violations.push('tap emitted with focus === null on tick ' + state.tick);
      const held = memBefore.find((m) => m.carId === focusBefore);
      if (!held) violations.push('tap emitted for a car not in mem on tick ' + state.tick);
      const rec = bot.stats.tapCars[bot.stats.tapCars.length - 1];
      if (!rec || rec.tick !== state.tick || rec.carId !== focusBefore) {
        violations.push('tap not attributed to the focused car on tick ' + state.tick);
      }
      const car = state.cars.find((c) => c.id === focusBefore);
      const j = level.nodes[level.junctions[inputs[0].junctionId]];
      const eta = ticksToReach(level, state.open, car, j);
      if (!(eta >= BOT_LOCKOUT_TICKS)) {
        violations.push('flip inside the lockout of its own car: eta ' + eta);
      }
      taps.push({ tick: state.tick, junctionId: inputs[0].junctionId, carId: focusBefore, eta });
    }
    state = step(state, inputs);
    ticks += 1;
  }
  return { state, bot, taps, violations, ticks, glances };
}

test('AC-235 · the bot never exceeds its own attention bounds', () => {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 20; seed += 1) {
      const r = driveObserved(generate(seed, band));
      assert.deepEqual(r.violations, [], 'band ' + band + ' seed ' + seed);
      assert.ok(r.bot.stats.memMax <= BOT_WORKING_SET);
    }
  }
});

test('AC-232 · the constrained bot obeys its motor constraints, re-simulated', () => {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 25; seed += 1) {
      const level = generate(seed, band);
      const r = driveObserved(level);
      assert.deepEqual(r.violations, []);

      for (let i = 1; i < r.taps.length; i += 1) {
        const gap = r.taps[i].tick - r.taps[i - 1].tick;
        assert.ok(gap >= BOT_MIN_TAP_GAP, 'tap gap ' + gap + ' at band ' + band);
      }
      const ticks = new Set(r.taps.map((t) => t.tick));
      assert.equal(ticks.size, r.taps.length, 'more than one tap in a tick');

      // The lockout is scoped to the FOCUSED car (AC-232's note); re-derived above from the
      // simulation state at the tap tick, not from the bot's own record.
      for (const t of r.taps) assert.ok(t.eta >= BOT_LOCKOUT_TICKS);
    }
  }
});

test('AC-236 · the bot is deterministic, and draws exactly once per glance', () => {
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(900 + band, band);
    const a = driveObserved(level);
    const b = driveObserved(generate(900 + band, band));
    assert.deepEqual(b.taps, a.taps, 'band ' + band + ' input stream differed between runs');
    assert.equal(b.state.score, a.state.score);
    assert.equal(b.state.tick, a.state.tick);

    assert.equal(a.bot.stats.draws, a.bot.stats.glances, 'one draw per glance, band ' + band);
    assert.equal(a.glances, a.bot.stats.glances, 'the observed draw count matches the counter');
    assert.ok(a.bot.stats.glances > 0);
  }
});

test('the glance sweep is a cyclic pass over car ids, not an urgency ordering', () => {
  // §7.1.5's note: the sweep runs from the car nearest the depots back up to the newest.
  const level = generate(4, 5);
  const masks = reachableColourMasks(level);
  const bot = makeBot(level.seed);
  let state = createState(level);
  const seen = [];
  while (state.phase === 'running' && state.tick < 3000) {
    const before = bot.cursor;
    const drawsBefore = bot.stats.draws;
    const inputs = botTick(level, masks, state, bot);
    if (bot.stats.draws > drawsBefore && state.cars.length > 1) {
      const ids = state.cars.map((c) => c.id);
      const expected = before === null ? ids[0] : (ids.find((i) => i > before) ?? ids[0]);
      seen.push([bot.cursor, expected]);
    }
    state = step(state, inputs);
  }
  assert.ok(seen.length > 50);
  for (const [got, want] of seen) assert.equal(got, want);
});

test('§7.1.5 C1 · a focus is released on every path, including when it can do nothing', () => {
  // The single rule that kills the three slice-1 readings: a car whose flip is currently
  // forbidden does not pin the bot. After any tick on which C1 ran, focus is null and the
  // bot is busy for exactly one tick.
  const level = generate(2, 4);
  const masks = reachableColourMasks(level);
  const bot = makeBot(level.seed);
  let state = createState(level);
  let evaluations = 0;
  while (state.phase === 'running' && state.tick < 4000) {
    const focusBefore = bot.focus;
    const wasBusy = state.tick < bot.busyUntil;
    botTick(level, masks, state, bot);
    if (!wasBusy && focusBefore !== null) {
      evaluations += 1;
      assert.equal(bot.focus, null, 'C1 left a focus held at tick ' + state.tick);
      assert.equal(bot.busyUntil, state.tick + 1, 'C1 cost more than one tick');
      assert.ok(
        bot.mem.some((m) => m.carId === focusBefore && m.seenTick === state.tick),
        'looking did not refresh the memory entry',
      );
    }
    state = step(state, []);
  }
  assert.ok(evaluations > 20, 'only ' + evaluations + ' evaluations observed');
});

test('§7.1.6 · breaksHeldCar ranges over the working set and nothing else', () => {
  // The blind spot is the point: a flip made for a held car misroutes a car the bot has
  // forgotten, and it never sees it coming. If that never happened, the bot would not be
  // modelling divided attention at all.
  // Named seeds, not a sample: these are the ones the blind spot actually shows up on.
  for (const [band, seed] of [[4, 90], [4, 240], [5, 160], [5, 197], [5, 202]]) {
    const r = playLevel(generate(seed, band), 'constrained');
    assert.ok(
      r.attention.unseenMisroutes > 0,
      'band ' + band + ' seed ' + seed + ': the flip the bot could not see coming stopped happening',
    );
  }
  // And it is not merely that every misroute is counted: most are not caused this way.
  let unseen = 0;
  let total = 0;
  for (let seed = 0; seed < 200; seed += 1) {
    const r = playLevel(generate(seed, 5), 'constrained');
    unseen += r.attention.unseenMisroutes;
    total += r.misroutes;
  }
  assert.ok(total > unseen && unseen > 0, unseen + ' of ' + total + ' misroutes were unseen');
});

test('AC-240 · removing the attention constraints raises the clear rate', () => {
  // The full 1,000-seed assertion is `node tools/bot.mjs --ac240`; this is the in-suite
  // sample, and it is the check that the constants named "attention" are load-bearing.
  for (const band of [1, 2, 3]) {
    let base = 0;
    let free = 0;
    for (let seed = 0; seed < 150; seed += 1) {
      const level = generate(seed, band);
      if (playLevel(level, 'constrained').cleared) base += 1;
      if (playLevel(level, 'constrained', { attention: BOT_NO_ATTENTION }).cleared) free += 1;
    }
    assert.ok(free - base >= 20 * 1.5, 'band ' + band + ' rise ' + (free - base) + '/150');
  }
});

test('AC-813 · the minimum-junction band is still winnable and still needs taps', () => {
  let cleared = 0;
  for (let seed = 0; seed < SEEDS; seed += 1) {
    const level = generate(seed, 1);
    assert.equal(level.junctions.length, 3);
    if (playLevel(level, 'constrained').cleared) cleared += 1;
  }
  // NOT ≥ 90 %: see docs/reports/slice-1b-developer.md. Band 1 measures 61.3 % over 1,000
  // seeds because a junction at row 0 is unreachable inside the entry edge. This asserts the
  // level is winnable at all and that the harness is running, not that AC-221 passes — that
  // is tools/bot.mjs's job and it currently reports BELOW.
  assert.ok(cleared > 0, 'band 1 constrained clear rate ' + cleared + '/' + SEEDS);
});

test('a bot run replays from its input log alone', () => {
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(500 + band, band);
    const run = playLevel(level, 'constrained');
    const again = replay(generate(500 + band, band), run.inputs);
    assert.deepEqual(again.cars, run.state.cars);
    assert.equal(again.score, run.state.score);
    assert.equal(again.tick, run.state.tick);
    assert.equal(again.phase, run.state.phase);
  }
});

test('nextJunction and ticksToReach agree with the simulation', () => {
  // Walk a real run and check, for every car on every tick, that the predicted arrival tick
  // at its next junction is the tick the engine actually moves it onto a branch of that node.
  const level = generate(6, 3);
  let state = createState(level);
  const predicted = new Map(); // carId -> { junctionId, arriveBy }
  let checked = 0;
  while (state.phase === 'running' && state.tick < 3000) {
    for (const car of state.cars) {
      const j = nextJunction(level, car);
      if (!j) continue;
      const eta = ticksToReach(level, state.open, car, j);
      const prev = predicted.get(car.id);
      if (prev && prev.junctionId === j.junctionId) {
        assert.ok(eta <= prev.eta, 'eta to junction ' + j.junctionId + ' did not decrease');
        checked += 1;
      }
      predicted.set(car.id, { junctionId: j.junctionId, eta });
    }
    state = step(state, []);
  }
  assert.ok(checked > 500);
});

test('§7.1.6 evaluate · NOTHING when both branches work, when neither does, and when set', () => {
  // A junction whose two branches reach {0} and {1}.
  const split = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 0 }] });
  const splitMasks = reachableColourMasks(split);
  const car = (colour) => ({ id: 0, colour, edgeId: split.entryEdgeId, progress: 0 });
  const open0 = Uint8Array.from([0]);
  const open1 = Uint8Array.from([1]);

  assert.equal(evaluate(split, splitMasks, open0, car(0), 0), null, 'already set for colour 0');
  assert.equal(evaluate(split, splitMasks, open1, car(0), 0).junctionId, 0, 'set wrong for colour 0');
  assert.equal(evaluate(split, splitMasks, open1, car(1), 1), null, 'already set for colour 1');
  assert.equal(evaluate(split, splitMasks, open0, car(1), 1).junctionId, 0, 'set wrong for colour 1');
  assert.equal(evaluate(split, splitMasks, open0, car(0), 4), null, 'neither branch reaches colour 4');

  // Both branches reaching the same colour is also NOTHING: the flip would change nothing.
  const same = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 0 }] });
  same.nodes = same.nodes.map((n) => (n.kind === 'depot' ? { ...n, depotColour: 0 } : n));
  const sameMasks = reachableColourMasks(same);
  assert.equal(evaluate(same, sameMasks, open0, car(0), 0), null);
  assert.equal(evaluate(same, sameMasks, open1, car(0), 0), null);

  // evaluate reads the REMEMBERED colour, not the car's. A car remembered as the wrong colour
  // is routed to the wrong depot — the hook §7.1.6 keeps open for a mis-remembering model.
  assert.equal(evaluate(split, splitMasks, open0, car(0), 1).junctionId, 0);
});

test('§7.1.3 · the safe window and the bot salt are the design values', () => {
  assert.equal(BOT_SAFE_WINDOW, 20);
  assert.equal(BOT_SALT, 0x5bf03635);
  assert.deepEqual(BOT_CONSTANTS, {
    minTapGap: 11, lockout: 6, safeWindow: 20, workingSet: 3, scan: 6,
    acquire: 15, switchTicks: 4, memory: 120, urgency: 90, lapsePct: 3,
  });
  assert.deepEqual(BOT_NO_ATTENTION, {
    workingSet: Infinity, acquire: 0, switchTicks: 0, memory: Infinity,
  });
});
