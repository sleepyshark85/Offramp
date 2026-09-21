// Simulation ACs — AC-101 … AC-135, AC-801, AC-808, AC-809, AC-810.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVEL_TICKS,
  LIVES,
  MAX_CATCHUP_TICKS,
  SPAWN_LEAD,
  TICK_HZ,
  spawnCountMax,
  bandParams,
} from '../src/engine/constants.js';
import { createState, step, TRANSITION_STATS, resetTransitionStats } from '../src/engine/step.js';
import { assertScheduleReachesClock, generate } from '../src/engine/generate.js';
import { drive, twoDepotLevel } from './helpers.js';
import { playLevel } from '../tools/lib/solver.mjs';
import { lazyOptimal, lazyOptimalInputs } from '../tools/lib/oracle.mjs';
import { advanceFrame } from '../src/ui/loop.js';
import { reachableColourMasks } from '../src/engine/generate.js';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');

/**
 * generation.md §6.2's lazy-optimal oracle, per tick, used wherever a test needs a run that
 * REACHES THE BELL. A never-tapping run loses three lives long before tick 7,200 (AC-814), so
 * a test that wants to observe `phase === 'ended'` has to route the cars. The routing itself
 * lives in tools/lib/oracle.mjs and is not re-implemented here.
 */
const MASKS = new WeakMap();
function oracleInputs(level, state) {
  let masks = MASKS.get(level);
  if (!masks) { masks = reachableColourMasks(level); MASKS.set(level, masks); }
  return lazyOptimalInputs(level, masks, state);
}

test('AC-101 · TICK_HZ is the integer 60 and is defined once', () => {
  assert.equal(TICK_HZ, 60);
  assert.ok(Number.isInteger(TICK_HZ));
  let definitions = 0;
  for (const f of readdirSync(ENGINE_DIR)) {
    const src = readFileSync(join(ENGINE_DIR, f), 'utf8');
    definitions += (src.match(/TICK_HZ\s*=/g) || []).length;
  }
  assert.equal(definitions, 1);
});

test('AC-102 · one step is exactly one tick', () => {
  let s = createState(twoDepotLevel());
  for (let i = 0; i < 20; i += 1) {
    const t = s.tick;
    s = step(s, []);
    assert.equal(s.tick, t + 1);
  }
});

test('AC-103 · no floating point anywhere in the simulation after 10,000 ticks', () => {
  const level = generate(99, 3);
  let s = createState(level);
  const inputsAt = (t) => (t % 37 === 0 ? [{ tick: t, junctionId: t % level.junctions.length }] : []);
  for (let i = 0; i < 10000 && s.phase === 'running'; i += 1) s = step(s, inputsAt(s.tick));
  for (const k of ['tick', 'rng', 'nextSpawn', 'delivered', 'misrouted', 'lives', 'streak', 'bestStreak']) {
    assert.ok(Number.isInteger(s[k]), k + ' = ' + s[k]);
  }
  assert.ok(!('score' in s), 'there is no score field (AC-117)');
  for (const car of s.cars) {
    for (const k of ['id', 'colour', 'edgeId', 'progress']) assert.ok(Number.isInteger(car[k]));
  }
});

test('AC-104 · a car is always on exactly one existing edge, inside it', () => {
  const level = generate(5, 4);
  let s = createState(level);
  for (let i = 0; i < 3000 && s.phase === 'running'; i += 1) {
    s = step(s, []);
    for (const car of s.cars) {
      const edge = level.edges[car.edgeId];
      assert.ok(edge, 'edge exists');
      assert.ok(car.progress >= 0 && car.progress < edge.lengthMlu);
      assert.equal(Object.keys(car).length, 4);
    }
  }
});

test('AC-105 · a car not transitioning advances by exactly speedMluPerTick', () => {
  const level = twoDepotLevel();
  let s = createState(level);
  s = step(s, []); // spawn + first advance
  const before = s.cars[0].progress;
  s = step(s, []);
  assert.equal(s.cars[0].progress, before + level.speedMluPerTick);
});

test('AC-106 · a transition carries the remainder', () => {
  const level = twoDepotLevel();
  let s = createState(level);
  let prev = null;
  while (s.cars.length === 0 || s.cars[0].edgeId === level.entryEdgeId) {
    prev = s;
    s = step(s, []);
  }
  const old = prev.cars[0];
  const now = s.cars[0];
  assert.equal(now.edgeId, 1); // open defaults to 0 -> out[0]
  assert.equal(now.progress, old.progress + level.speedMluPerTick - level.edges[0].lengthMlu);
});

test('AC-107/AC-109 · junction state is read at the transition, after this tick’s inputs', () => {
  const level = twoDepotLevel();
  // The car transitions during tick 33. A tap stamped at tick 33 must be honoured.
  const withTap = drive(step, createState(level), new Map([[33, [{ tick: 33, junctionId: 0 }]]]), 34);
  assert.equal(withTap.cars[0].edgeId, 2, 'took out[1] after the same-tick flip');
  const without = drive(step, createState(level), new Map(), 34);
  assert.equal(without.cars[0].edgeId, 1);
});

test('AC-108/AC-311 · a flip behind a car does not re-route it', () => {
  const level = twoDepotLevel();
  const late = drive(step, createState(level), new Map([[34, [{ tick: 34, junctionId: 0 }]]]), 160);
  assert.equal(late.delivered, 1, 'still arrived at depot colour 0');
  assert.equal(late.misrouted, 0);
  const never = drive(step, createState(level), new Map(), 160);
  assert.equal(never.delivered, 1);
});

test('AC-110 · two taps in one tick resolve by junction id, order-independently', () => {
  const level = generate(11, 3);
  assert.ok(level.junctions.length > 5);
  const a = step(createState(level), [{ tick: 0, junctionId: 5 }, { tick: 0, junctionId: 2 }]);
  const b = step(createState(level), [{ tick: 0, junctionId: 2 }, { tick: 0, junctionId: 5 }]);
  assert.deepEqual(a.open, b.open);
  assert.deepEqual(a.events.map((e) => e.junctionId), [2, 5]);
  assert.deepEqual(a, b);
});

test('AC-111 · duplicate taps on one junction net out and emit two flips', () => {
  const level = twoDepotLevel();
  const s = step(createState(level), [{ tick: 0, junctionId: 0 }, { tick: 0, junctionId: 0 }]);
  assert.equal(s.open[0], 0);
  assert.equal(s.events.filter((e) => e.type === 'flip').length, 2);
});

test('AC-112 · cars spawn on their scheduled tick', () => {
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: 7, colour: 1 }] });
  let s = createState(level);
  for (let i = 0; i < 7; i += 1) s = step(s, []);
  assert.equal(s.cars.length, 0, 'nothing before tick 7');
  const before = s;
  s = step(s, []);
  assert.equal(s.cars.length, 1);
  assert.equal(s.cars[0].id, 0);
  assert.equal(s.cars[0].colour, 1);
  assert.equal(s.cars[0].edgeId, level.entryEdgeId);
  assert.equal(before.cars.filter((c) => c.id === 0).length, 0, 'no car with that id a tick earlier');
  // progress is one tick of travel because spawn precedes advance within the tick. AC-112's
  // note: progress === 0 is not observable by any caller, it exists only between two
  // statements inside step().
  assert.equal(s.cars[0].progress, level.speedMluPerTick);
  const spawned = s.events.filter((e) => e.type === 'spawn');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0], { type: 'spawn', tick: 7, carId: 0, colour: 1 });
});

test('AC-112 · every scheduled car of a real level arrives exactly once, on its tick', () => {
  // On the shipped geometry rather than the fixture, because AC-112's claim that a car cannot
  // transition on its spawn tick rests on ENTRY_LEN = 220,000 MLU being far longer than one
  // tick of travel at any band — 3,350 MLU at the fastest, so sixty times over.
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(40 + band, band);
    assert.ok(level.edges[level.entryEdgeId].lengthMlu > 60 * level.speedMluPerTick);
    const wanted = new Map(level.spawns.map((sp) => [sp.tick, sp]));
    const seenIds = new Set();
    let prev = createState(level);
    let s = prev;
    while (s.phase === 'running' && s.tick < 4000) {
      prev = s;
      s = step(s, []);
      const tickOfStep = s.tick - 1;
      const sp = wanted.get(tickOfStep);
      const events = s.events.filter((e) => e.type === 'spawn');
      if (!sp) {
        assert.equal(events.length, 0, 'unscheduled spawn at tick ' + tickOfStep);
        continue;
      }
      assert.equal(events.length, 1, 'band ' + band + ' tick ' + tickOfStep);
      assert.deepEqual(events[0], { type: 'spawn', tick: sp.tick, carId: sp.index, colour: sp.colour });
      assert.equal(prev.cars.filter((c) => c.id === sp.index).length, 0);
      const car = s.cars.find((c) => c.id === sp.index);
      assert.ok(car, 'car ' + sp.index + ' not present after its spawn tick');
      assert.equal(car.colour, sp.colour);
      assert.equal(car.edgeId, level.entryEdgeId);
      assert.equal(car.progress, level.speedMluPerTick);
      assert.ok(!seenIds.has(sp.index), 'car id ' + sp.index + ' spawned twice');
      seenIds.add(sp.index);
    }
    assert.ok(seenIds.size > 3, 'band ' + band + ' saw only ' + seenIds.size + ' spawns');
  }
});

test('AC-114 · spawn ticks strictly increase, gap >= interval - 2*jitter', () => {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 250; seed += 1) {
      const level = generate(seed, band);
      for (let i = 1; i < level.spawns.length; i += 1) {
        const gap = level.spawns[i].tick - level.spawns[i - 1].tick;
        assert.ok(gap > 0, 'strictly increasing');
        assert.ok(gap >= level.interval - 2 * level.jitter, 'gap ' + gap);
      }
    }
  }
});

test('AC-115 · the colour bag never produces three in a row, and balances WITHIN a level', () => {
  // The aggregate-over-seeds reading is withdrawn (AC-115's note): the leftover of the last
  // bag is a fresh uniform draw, so an aggregate spread of 34 or 43 is ordinary multinomial
  // noise and no tolerance over it is a check. The per-level reading is a theorem about the
  // bag, so it holds at EVERY seed with tolerance 1, and fails the moment the bag is replaced
  // by independent draws.
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 300; seed += 1) {
      const level = generate(seed, band);
      const cs = level.spawns.map((sp) => sp.colour);
      for (let i = 2; i < cs.length; i += 1) {
        assert.ok(!(cs[i] === cs[i - 1] && cs[i] === cs[i - 2]), 'three in a row, band ' + band);
      }
      const counts = new Array(level.K).fill(0);
      for (const c of cs) counts[c] += 1;
      const spread = Math.max(...counts) - Math.min(...counts);
      const want = cs.length % level.K === 0 ? 0 : 1;
      assert.equal(spread, want,
        'band ' + band + ' seed ' + seed + ': ' + cs.length + ' spawns over K=' + level.K +
        ' gave counts ' + counts.join(',') );
    }
  }
});

test('AC-116/AC-117 · delivery counts, and the points system is GONE', () => {
  const spawns = [];
  for (let i = 0; i < 14; i += 1) spawns.push({ index: i, tick: i * 60, colour: 0 });
  const level = twoDepotLevel({ spawns });
  let s = createState(level);
  let prevDelivered = 0;
  const deliveries = [];
  while (s.phase === 'running' && s.tick < 2000) {
    s = step(s, []);
    if (s.delivered !== prevDelivered) {
      assert.equal(s.delivered, prevDelivered + 1, 'delivered rises by exactly one');
      prevDelivered = s.delivered;
      assert.equal(s.streak, s.delivered, 'streak tracks an unbroken run');
      assert.equal(s.bestStreak, s.streak);
      assert.equal(s.lives, LIVES);
      deliveries.push(s.tick);
      const ev = s.events.find((e) => e.type === 'delivered');
      assert.ok(ev && Number.isInteger(ev.edgeId), 'the event carries edgeId (AC-140)');
    }
  }
  assert.equal(s.delivered, 14);
  assert.equal(s.bestStreak, 14, 'no cap: the streak runs to 14');
});

test('AC-117 · the score constants do not exist anywhere in src/', () => {
  // The criterion is the DELETION, which is the check that catches a build keeping the old
  // code path alive behind an unused field (AC-117's round-8 note). A grep over src/ is the
  // only thing that can see that.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const banned = ['SCORE_DELIVERY', 'SCORE_STREAK_STEP', 'STREAK_CAP', 'SCORE_LIFE_BONUS'];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) { walk(full); continue; }
      if (!name.name.endsWith('.js')) continue;
      const src = readFileSync(full, 'utf8');
      for (const b of banned) if (src.includes(b)) hits.push(full + ' -> ' + b);
      if (/\bstate\.score\b/.test(src)) hits.push(full + ' -> state.score');
    }
  };
  walk(SRC);
  assert.deepEqual(hits, []);
  // And the check is sensitive: it finds the strings when they are there.
  assert.ok(banned.every((b) => 'const ' + b + ' = 1'.includes(b)));
});

test('AC-117 · streak resets on a misroute and multiplies nothing', () => {
  const level = twoDepotLevel({
    spawns: [
      { index: 0, tick: 0, colour: 0 },
      { index: 1, tick: 200, colour: 1 },
      { index: 2, tick: 400, colour: 0 },
    ],
  });
  let s = drive(step, createState(level), new Map(), 700);
  assert.equal(s.delivered, 2, 'two cars matched depot colour 0');
  assert.equal(s.misrouted, 1);
  assert.equal(s.streak, 1, 'the misroute broke the streak and the last car rebuilt it');
  assert.equal(s.bestStreak, 1);
  assert.equal(s.lives, LIVES - 1);
});

test('AC-118 · the transition loop is single-pass over 20,000 ticks at every band', () => {
  resetTransitionStats();
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 13, band);
    let s = createState(level);
    let n = 0;
    while (n < 20000) {
      s = step(s, s.tick % 23 === 0 ? [{ tick: s.tick, junctionId: s.tick % level.junctions.length }] : []);
      n += 1;
      if (s.phase !== 'running') s = createState(level); // keep stepping, fresh run
    }
  }
  assert.ok(TRANSITION_STATS.transitions > 0, 'the instrument observed transitions');
  assert.equal(TRANSITION_STATS.maxPerCarTick, 1);
});

test('AC-119 · a misroute costs a life, delivers nothing, and resets the streak', () => {
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 1 }] });
  let s = createState(level);
  let ev = null;
  while (s.tick < 200) {
    s = step(s, []);
    ev = s.events.find((e) => e.type === 'misrouted') || ev;
  }
  assert.equal(s.misrouted, 1);
  assert.equal(s.lives, LIVES - 1);
  assert.equal(s.delivered, 0);
  assert.equal(s.streak, 0);
  assert.ok(ev && ev.carColour === 1 && ev.depotColour === 0);
  assert.ok(Number.isInteger(ev.edgeId), 'the event carries edgeId (AC-140)');
});

test('AC-122/AC-802 · the clock and the third misroute on the same tick is a LOSS', () => {
  // THE ORDER REVERSED IN ROUND 8. Under a quota the tie resolved as a win, because the player
  // had completed the job. Under a clock there is no job to have finished — every run reaches
  // the bell — so resolving the tie in the player's favour would make tick 7,199 the one tick
  // on which a misroute is free (gameplay.md §2.5).
  //
  // The construction: a car whose arrival lands on tick LEVEL_TICKS - 1 into the WRONG depot,
  // with one life left. Step 4 resolves it, step 5 checks `lives` BEFORE the clock, so the
  // phase is 'lost' even though the clock also expired on that tick.
  const arrive = LEVEL_TICKS - 1;
  const spawnTick = arrive - 153; // the fixture's jogL journey is 153 ticks
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: spawnTick, colour: 1 }] });
  let s = createState(level);
  s.lives = 1;
  while (s.phase === 'running') s = step(s, []);
  assert.equal(s.tick, LEVEL_TICKS, 'the run is exactly 7,200 ticks long');
  assert.equal(s.misrouted, 1);
  assert.equal(s.lives, 0);
  assert.equal(s.phase, 'lost', 'lives are checked BEFORE the clock');

  // The control: the same tick, the same clock expiry, but the car matches its depot. Now the
  // clock decides and the phase is 'ended'. Without this the assertion above could be passing
  // for the wrong reason.
  const ok = twoDepotLevel({ spawns: [{ index: 0, tick: spawnTick, colour: 0 }] });
  let t = createState(ok);
  t.lives = 1;
  while (t.phase === 'running') t = step(t, []);
  assert.equal(t.tick, LEVEL_TICKS);
  assert.equal(t.delivered, 1);
  assert.equal(t.lives, 1);
  assert.equal(t.phase, 'ended');
});

test('AC-122/AC-136 · two misroutes on one tick with one life: both resolve, lives floor at 0', () => {
  // Car 0 (colour 1) takes the long branch to depot colour 0; car 1 (colour 0) takes the short
  // branch to depot colour 1. Both misroute, and both resolve on the same tick.
  const level = twoDepotLevel({
    spawns: [{ index: 0, tick: 0, colour: 1 }, { index: 1, tick: 20, colour: 0 }],
  });
  let s = createState(level);
  s.lives = 1;
  const inputs = new Map([[40, [{ tick: 40, junctionId: 0 }]]]); // flip after car 0 passes
  let arrivalTick = null;
  while (s.phase === 'running' && s.tick < 300) {
    s = step(s, inputs.get(s.tick) || []);
    if (s.events.some((e) => e.type === 'misrouted')) arrivalTick = s.tick - 1;
  }
  assert.equal(arrivalTick, 153, 'both arrivals land on tick 153');
  assert.equal(s.misrouted, 2, 'misrouted counts BOTH, unconditionally');
  assert.equal(s.events.filter((e) => e.type === 'misrouted').length, 2);
  assert.equal(s.delivered, 0);
  assert.equal(s.cars.length, 0, 'neither car was skipped by the removal pass');
  assert.equal(s.lives, 0, 'floored, not -1');
  assert.equal(s.phase, 'lost');
});

test('two deliveries on the same tick both resolve (mutation-during-iteration guard)', () => {
  const level = twoDepotLevel({
    spawns: [{ index: 0, tick: 0, colour: 0 }, { index: 1, tick: 20, colour: 1 }],
  });
  let s = createState(level);
  const inputs = new Map([[40, [{ tick: 40, junctionId: 0 }]]]);
  while (s.phase === 'running' && s.tick < 300) s = step(s, inputs.get(s.tick) || []);
  assert.equal(s.delivered, 2);
  assert.equal(s.misrouted, 0);
  assert.equal(s.cars.length, 0);
});

test('AC-120/AC-121 · delivered non-decreasing, lives non-increasing and floored', () => {
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 7 + 1, band);
    let s = createState(level);
    let prev = s;
    for (let i = 0; i < 4000; i += 1) {
      const inputs = (i * 2654435761) % 11 === 0
        ? [{ tick: s.tick, junctionId: (i * 40503) % level.junctions.length }]
        : [];
      s = step(s, inputs);
      assert.ok(s.delivered >= prev.delivered && Number.isInteger(s.delivered) && s.delivered >= 0);
      if (s.delivered > prev.delivered) {
        assert.ok(s.events.some((e) => e.type === 'delivered'),
          'delivered rose only on a tick that emitted a delivered event');
      }
      assert.ok(s.lives <= prev.lives && s.lives >= 0);
      prev = s;
      if (s.phase !== 'running') { s = createState(level); prev = s; }
    }
  }
});

test('AC-139 · the spawn schedule matches its closed form', () => {
  // gameplay.md §2.7 / AC-139. TRANSCRIBED, not imported: the closed form is
  // floor((LEVEL_TICKS - 1 - SPAWN_LEAD + JITTER) / INTERVAL) + 1 and it comes out at
  // 35 / 48 / 51 / 54 / 56. `SPAWN_SLACK`, `inFlightMax` and `transitMax` are deleted — under a
  // clock the schedule is not a guess about how many cars a level will need, it is the list of
  // cars that fit in two minutes.
  const wantCount = [null, 35, 48, 51, 54, 56];
  for (let band = 1; band <= 5; band += 1) {
    assert.equal(spawnCountMax(bandParams(band)), wantCount[band], 'band ' + band + ' closed form');
    for (let seed = 0; seed < 40; seed += 1) {
      const level = generate(seed, band);
      const sp = level.spawns;
      assert.ok(sp.length === wantCount[band] || sp.length === wantCount[band] - 1,
        'band ' + band + ' seed ' + seed + ' length ' + sp.length);
      for (let i = 0; i < sp.length; i += 1) {
        assert.equal(sp[i].index, i);
        assert.ok(sp[i].tick < LEVEL_TICKS, 'every scheduled tick is inside the clock');
      }
      assert.ok(Math.abs(sp[0].tick - SPAWN_LEAD) <= level.jitter);
    }
  }
});

test('AC-123 · a run that reaches the bell has consumed its whole schedule', () => {
  // The identity that replaced the old margin, and it has to be measured on runs that REACH
  // the bell: a never-tapping run loses three lives long before tick 7,200 (AC-814), so
  // driving with no inputs would observe nothing and report green. The lazy-optimal oracle
  // delivers every car, so its runs always reach it.
  let observed = 0;
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 3; seed += 1) {
      const level = generate(seed, band);
      const r = lazyOptimal(level);
      assert.equal(r.state.phase, 'ended', 'band ' + band + ' seed ' + seed);
      assert.equal(r.state.tick, LEVEL_TICKS);
      assert.equal(r.state.nextSpawn, level.spawns.length,
        'band ' + band + ' seed ' + seed + ': every scheduled car entered');
      observed += 1;
    }
  }
  assert.ok(observed > 0, 'the identity was actually evaluated');
});

test('AC-123 · nextSpawn never runs past spawns.length at any tick', () => {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 15; seed += 1) {
      const level = generate(seed, band);
      const r = playLevel(level, 'constrained', {
        onTick: (state) => {
          assert.ok(state.nextSpawn <= level.spawns.length,
            'band ' + band + ' seed ' + seed + ' tick ' + state.tick +
            ': nextSpawn ' + state.nextSpawn + ' of ' + level.spawns.length);
        },
      });
      assert.ok(!r.stalled);
    }
  }
});

test('AC-141 · a level is exactly 7,200 ticks, and the off-by-one is checked hardest', () => {
  // The criterion the fixed clock rests on. Step 5 tests `tick + 1 >= LEVEL_TICKS` and step 6
  // increments, so a level that runs 7,201 or 7,199 ticks passes every other AC in the
  // document. Driven with the lazy-optimal oracle so no life is lost.
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 3, band);
    let state = createState(level);
    let steps = 0;
    let lastSimulated = -1;
    while (state.phase === 'running') {
      lastSimulated = state.tick;
      state = step(state, oracleInputs(level, state));
      steps += 1;
      assert.ok(steps <= LEVEL_TICKS + 1, 'band ' + band + ' ran past the clock');
    }
    assert.equal(steps, LEVEL_TICKS, 'band ' + band + ': exactly 7,200 step() calls');
    assert.equal(lastSimulated, LEVEL_TICKS - 1, 'the last tick simulated is 7,199');
    assert.equal(state.tick, LEVEL_TICKS);
    assert.equal(state.phase, 'ended');
    assert.ok(state.lives >= 1);
  }
});

test('AC-141 · the level is the same length in ticks however long it took in seconds', () => {
  // The second clause: the SAME run, replayed at a deliberately degraded frame rate that
  // triggers MAX_CATCHUP_TICKS clamping, must reach a deeply equal final state. The clamp
  // lives in the React layer, so this drives the recorded tick stream through `advanceFrame`
  // with 500 ms frames — 30 ticks owed, 8 run, the remainder discarded (AC-127).
  //
  // Both runs are driven by the oracle, because a never-tapping run loses at tick ~1,100 and
  // would make the comparison a statement about two short runs rather than about the clock.
  const level = generate(7, 2);
  const recorded = [];
  const live = (() => {
    let s0 = createState(level);
    while (s0.phase === 'running') {
      const inputs = oracleInputs(level, s0);
      for (const i of inputs) recorded.push(i);
      s0 = step(s0, inputs);
    }
    return s0;
  })();
  assert.equal(live.phase, 'ended');
  assert.equal(live.tick, LEVEL_TICKS);
  assert.ok(recorded.length > 20, 'the run actually tapped: ' + recorded.length);

  let r = { state: createState(level), accTicks: 0, pending: recorded.slice(), recent: [] };
  let frames = 0;
  while (r.state.phase === 'running' && frames < 4000) {
    r = advanceFrame(r.state, r.accTicks, 500, r.pending, r.recent);
    frames += 1;
  }
  assert.equal(r.state.tick, LEVEL_TICKS, 'the same number of ticks');
  assert.equal(r.state.phase, 'ended');
  assert.deepEqual(
    { ...r.state, level: null, events: [] },
    { ...live, level: null, events: [] },
  );
  // 500 ms a frame clamps to 8 ticks, so the run needs at least 900 frames — i.e. the clamp
  // really did bite, and this is not a 60 fps run wearing a slow hat.
  assert.ok(frames >= LEVEL_TICKS / MAX_CATCHUP_TICKS, 'the clamp bit: ' + frames + ' frames');
});

test('AC-138 · every junction starts on branch 0', () => {
  // gameplay.md §4.8: a rule, not an allocation default. A build that seeded `open` from the
  // level seed would pass every other AC in the document and change how every level opens.
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 100; seed += 1) {
      const level = generate(seed, band);
      const s = createState(level);
      assert.equal(s.open.length, level.junctions.length, 'band ' + band + ' open length');
      assert.ok(level.junctions.length > 0);
      for (let j = 0; j < s.open.length; j += 1) {
        assert.equal(s.open[j], 0, 'band ' + band + ' seed ' + seed + ' junction ' + j);
      }
      // out[0] is the LOWER-column branch, so an untouched network sends every car to the
      // leftmost depot it can reach.
      for (const id of level.junctions) {
        const n = level.nodes[id];
        assert.ok(level.nodes[level.edges[n.out[0]].to].col < level.nodes[level.edges[n.out[1]].to].col);
      }
    }
  }
});

test('AC-126 · events do not accumulate', () => {
  const level = generate(3, 2);
  let s = createState(level);
  for (let i = 0; i < 400; i += 1) {
    s = step(s, i === 10 ? [{ tick: s.tick, junctionId: 0 }] : []);
    for (const e of s.events) assert.equal(e.tick, s.tick - 1);
  }
});

test('AC-129 · the engine has no clock, no randomness and no React', () => {
  const banned = [/Date\.now/, /performance\.now/, /Math\.random/, /setTimeout/, /setInterval/, /from ['"]react/];
  for (const f of readdirSync(ENGINE_DIR)) {
    const src = readFileSync(join(ENGINE_DIR, f), 'utf8');
    for (const re of banned) assert.ok(!re.test(src), f + ' contains ' + re);
  }
});

test('AC-130/AC-131 · ids strictly ascending, no car on two edges, conservation holds', () => {
  const level = generate(21, 5);
  let s = createState(level);
  for (let i = 0; i < 6000 && s.phase === 'running'; i += 1) {
    s = step(s, i % 17 === 0 ? [{ tick: s.tick, junctionId: i % level.junctions.length }] : []);
    let last = -1;
    for (const c of s.cars) { assert.ok(c.id > last); last = c.id; }
    assert.equal(s.cars.length, s.nextSpawn - s.delivered - s.misrouted);
  }
});

test('AC-132 · clearing a level is surviving it, and there is no third phase', () => {
  // 'ended' iff the run reached LEVEL_TICKS with lives >= 1; 'lost' iff lives reached 0.
  // There is no 'won'.
  const seen = new Set();
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 6; seed += 1) {
      const level = generate(seed, band);
      // Two drivers, so both terminal phases are observed: the oracle always survives, the
      // never-tapping bot always loses.
      for (const inputs of [oracleInputs, () => []]) {
        let s = createState(level);
        while (s.phase === 'running') s = step(s, inputs(level, s));
        seen.add(s.phase);
        assert.ok(s.phase === 'ended' || s.phase === 'lost', 'phase ' + s.phase);
        if (s.phase === 'ended') {
          assert.equal(s.tick, LEVEL_TICKS);
          assert.ok(s.lives >= 1);
        } else {
          assert.equal(s.lives, 0);
          assert.ok(s.tick < LEVEL_TICKS);
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['ended', 'lost'], 'both phases were reached');
});

test('AC-133 · cars in flight at the bell are kept, unscored, and number 2 to 5', () => {
  // Which is EVERY level: the clock does not wait for the board to drain.
  for (let band = 1; band <= 5; band += 1) {
    const counts = [];
    for (let seed = 0; seed < 25; seed += 1) {
      const level = generate(seed, band);
      const r = lazyOptimal(level);
      assert.equal(r.state.phase, 'ended');
      counts.push(r.state.cars.length);
      // Unscored: every spawned car is either delivered, misrouted or still on the board.
      assert.equal(
        r.state.delivered + r.state.misrouted + r.state.cars.length,
        r.state.nextSpawn,
      );
    }
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    assert.ok(min >= 2 && max <= 5, 'band ' + band + ' in flight at the bell: ' + min + '-' + max);
  }
});

test('AC-801 · the last misroute ends the level on that tick', () => {
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 1 }] });
  let s = createState(level);
  s.lives = 1;
  s = drive(step, s, new Map(), 400);
  assert.equal(s.phase, 'lost');
  assert.equal(s.lives, 0);
  assert.equal(s.tick, 154, 'ended on the arrival tick, not later');
  assert.ok(s.tick < LEVEL_TICKS);
});

test('AC-808 · a schedule that stops short of the clock is a build error', () => {
  // The failure that replaced SPAWN_EXHAUSTED, and it is the harder of the two: a silently
  // short schedule still plays, still ends on the bell, and simply has fewer cars in it than
  // the difficulty model says.
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band, band);
    assert.doesNotThrow(() => assertScheduleReachesClock(level));
    const short = { ...level, spawns: level.spawns.slice(0, -4) };
    assert.throws(() => assertScheduleReachesClock(short), /SHORT_SCHEDULE/);
    assert.throws(() => assertScheduleReachesClock({ ...level, spawns: [] }), /SHORT_SCHEDULE/);
  }
});

test('AC-808 · consuming the LAST scheduled car is not an error', () => {
  // Nothing in the design says the last car is unusable, and the old canary made the usable
  // schedule one shorter than the real one.
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 11, band);
    let s;
    assert.doesNotThrow(() => {
      s = createState(level);
      while (s.phase === 'running') s = step(s, oracleInputs(level, s));
    });
    assert.equal(s.nextSpawn, level.spawns.length);
    assert.equal(s.phase, 'ended');
  }
});

test('AC-809 · an empty input array advances the tick and changes no junction', () => {
  const level = generate(2, 2);
  const s0 = createState(level);
  const s1 = step(s0, []);
  assert.equal(s1.tick, 1);
  assert.deepEqual(s1.open, s0.open);
});

test('AC-810 · step() after a terminal state returns a deeply equal state', () => {
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 1 }] });
  let start = createState(level);
  start.lives = 1;
  const done = drive(step, start, new Map(), 400);
  assert.equal(done.phase, 'lost');

  // The expectation is built BEFORE the call and is an independent object graph. Comparing
  // the return value against `done` itself could not fail: step() returns the very same
  // reference at src/engine/step.js:122, so `assert.deepEqual(again, done)` was comparing an
  // object with itself (development-process.md §6.2).
  const expected = structuredClone({ ...done, level: done.level });
  const again = step(done, [{ tick: done.tick, junctionId: 0 }]);
  assert.deepEqual(again, expected);

  // And the comparison is sensitive: any of the fields a broken early-return would move is
  // caught by it.
  assert.throws(() => assert.deepEqual({ ...expected, tick: expected.tick + 1 }, expected));
  assert.throws(() => assert.deepEqual({ ...expected, delivered: expected.delivered + 1 }, expected));
  const flipped = structuredClone(expected);
  flipped.open[0] ^= 1;
  assert.throws(() => assert.deepEqual(flipped, expected));
});

test('step() does not mutate the state it was given', () => {
  const level = generate(4, 3);
  const s0 = createState(level);
  const snapshot = JSON.stringify({ ...s0, open: Array.from(s0.open), level: null });
  step(s0, [{ tick: 0, junctionId: 0 }]);
  assert.equal(JSON.stringify({ ...s0, open: Array.from(s0.open), level: null }), snapshot);
});

test('MAX_CATCHUP_TICKS is the design value', () => {
  assert.equal(MAX_CATCHUP_TICKS, 8);
});

test('AC-135 · the engine entry point imports and runs in bare Node', async () => {
  const engine = await import('../src/engine/index.js');
  for (const name of ['step', 'apply', 'createState', 'generate', 'validate', 'advanceClock', 'mix32', 'checkInvariants']) {
    assert.equal(typeof engine[name], 'function', 'index.js exports ' + name);
  }
  const s = engine.step(engine.createState(engine.generate(1, 1)), []);
  assert.equal(s.tick, 1);
});
