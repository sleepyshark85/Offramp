// Simulation ACs — AC-101 … AC-135, AC-801, AC-808, AC-809, AC-810.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVES,
  MAX_CATCHUP_TICKS,
  SCORE_DELIVERY,
  SCORE_LIFE_BONUS,
  BANDS,
  inFlightMax,
  spawnSlack,
  transitMaxTicks,
  STREAK_CAP,
  TICK_HZ,
} from '../src/engine/constants.js';
import { createState, step, TRANSITION_STATS, resetTransitionStats } from '../src/engine/step.js';
import { generate } from '../src/engine/generate.js';
import { drive, twoDepotLevel } from './helpers.js';
import { playLevel } from '../tools/lib/solver.mjs';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');

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
  for (const k of ['tick', 'rng', 'nextSpawn', 'delivered', 'misrouted', 'lives', 'score', 'streak', 'bestStreak']) {
    assert.ok(Number.isInteger(s[k]), k + ' = ' + s[k]);
  }
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
  // transition on its spawn tick rests on ENTRY_LEN = 160,000 MLU being far longer than one
  // tick of travel at any band — 3,800 MLU at the fastest.
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(40 + band, band);
    assert.ok(level.edges[level.entryEdgeId].lengthMlu > 10 * level.speedMluPerTick);
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

test('AC-116/AC-117 · delivery scores, counts, and the streak cap', () => {
  const spawns = [];
  for (let i = 0; i < 14; i += 1) spawns.push({ index: i, tick: i * 60, colour: 0 });
  const level = twoDepotLevel({ spawns, quota: 14 });
  let s = createState(level);
  const increments = [];
  let prevScore = 0;
  let prevDelivered = 0;
  while (s.phase === 'running' && s.tick < 2000) {
    s = step(s, []);
    if (s.delivered !== prevDelivered) {
      increments.push(s.score - prevScore);
      prevScore = s.score;
      prevDelivered = s.delivered;
      assert.equal(s.streak, s.delivered);
      assert.equal(s.lives, LIVES);
    }
  }
  for (let n = 1; n <= 12; n += 1) {
    assert.equal(increments[n - 1], SCORE_DELIVERY + 10 * Math.min(n - 1, STREAK_CAP), 'delivery #' + n);
  }
  assert.equal(increments[9], 190);
  assert.equal(increments[11], 190);
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

test('AC-119 · a misroute costs a life, no points, and resets the streak', () => {
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 1 }], quota: 5 });
  let s = createState(level);
  let ev = null;
  while (s.tick < 200) {
    s = step(s, []);
    ev = s.events.find((e) => e.type === 'misrouted') || ev;
  }
  assert.equal(s.misrouted, 1);
  assert.equal(s.lives, LIVES - 1);
  assert.equal(s.score, 0);
  assert.equal(s.streak, 0);
  assert.ok(ev && ev.carColour === 1 && ev.depotColour === 0);
});

test('AC-122/AC-802 · quota and misroute on the same tick is a win', () => {
  // Car 0 (colour 0) takes the long branch to depot colour 0; car 1 (colour 0) takes the
  // short branch to depot colour 1. Both resolve on tick 153.
  const level = twoDepotLevel({
    spawns: [{ index: 0, tick: 0, colour: 0 }, { index: 1, tick: 20, colour: 0 }],
    quota: 1,
  });
  let s = createState(level);
  s.lives = 1;
  const inputs = new Map([[40, [{ tick: 40, junctionId: 0 }]]]); // flip after car 0 passes
  let arrivalTick = null;
  while (s.phase === 'running' && s.tick < 300) {
    s = step(s, inputs.get(s.tick) || []);
    if (s.events.some((e) => e.type === 'delivered')) arrivalTick = s.tick - 1;
  }
  assert.equal(arrivalTick, 153);
  assert.equal(s.delivered, 1);
  assert.equal(s.misrouted, 1, 'both cars resolved on the same tick');
  assert.equal(s.cars.length, 0, 'neither car was skipped by the removal pass');
  assert.equal(s.lives, 0);
  assert.equal(s.phase, 'won');
});

test('two deliveries on the same tick both resolve (mutation-during-iteration guard)', () => {
  const level = twoDepotLevel({
    spawns: [{ index: 0, tick: 0, colour: 0 }, { index: 1, tick: 20, colour: 1 }],
    quota: 9,
  });
  let s = createState(level);
  const inputs = new Map([[40, [{ tick: 40, junctionId: 0 }]]]);
  while (s.phase === 'running' && s.tick < 300) s = step(s, inputs.get(s.tick) || []);
  assert.equal(s.delivered, 2);
  assert.equal(s.misrouted, 0);
  assert.equal(s.cars.length, 0);
});

test('AC-120/AC-121 · score non-decreasing, lives non-increasing and floored', () => {
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 7 + 1, band);
    let s = createState(level);
    let prev = s;
    for (let i = 0; i < 4000; i += 1) {
      const inputs = (i * 2654435761) % 11 === 0
        ? [{ tick: s.tick, junctionId: (i * 40503) % level.junctions.length }]
        : [];
      s = step(s, inputs);
      assert.ok(s.score >= prev.score && Number.isInteger(s.score) && s.score >= 0);
      assert.ok(s.lives <= prev.lives && s.lives >= 0);
      prev = s;
      if (s.phase !== 'running') { s = createState(level); prev = s; }
    }
  }
});

test('AC-123 · the spawn array carries quota + the DERIVED slack, and is never exhausted', () => {
  // gameplay.md §2.7's table: slack 8 / 9 / 9 / 9 / 10 and counts 24 / 35 / 45 / 57 / 74.
  // Band 2 is 9 rather than 8 because ENTRY_LEN 100 -> 160 pushed transitMax/interval across
  // an integer boundary — the silent walk the derivation exists to catch.
  const wantTransit = [null, 575, 569, 536, 494, 505];
  const wantInFlight = [null, 5, 6, 6, 6, 7];
  const wantSlack = [null, 8, 9, 9, 9, 10];
  const wantCount = [null, 24, 35, 45, 57, 74];
  for (let band = 1; band <= 5; band += 1) {
    // Every term of the derivation, not only its result — a lever move in §7.4 changes one of
    // these and the slack must follow it.
    assert.equal(transitMaxTicks(BANDS[band]), wantTransit[band], 'band ' + band + ' transitMax');
    assert.equal(inFlightMax(BANDS[band]), wantInFlight[band], 'band ' + band + ' inFlightMax');
    assert.equal(spawnSlack(band), wantSlack[band], 'band ' + band + ' slack');
    assert.ok(Number.isInteger(spawnSlack(band)));
    const level = generate(band, band);
    assert.equal(level.spawns.length, level.quota + spawnSlack(band));
    assert.equal(level.spawns.length, wantCount[band], 'band ' + band + ' SPAWN_COUNT');
  }
});

test('AC-123 · nextSpawn stays below spawns.length at EVERY tick, not only the last', () => {
  // "not only at the final tick" is the clause the old test did not cover: it compared two
  // array lengths and never ran a level.
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 25; seed += 1) {
      const level = generate(seed, band);
      const r = playLevel(level, 'constrained', {
        onTick: (state) => {
          assert.ok(state.nextSpawn < level.spawns.length,
            'band ' + band + ' seed ' + seed + ' tick ' + state.tick +
            ': nextSpawn ' + state.nextSpawn + ' of ' + level.spawns.length);
        },
      });
      assert.ok(!r.stalled);
    }
  }
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

test('AC-132 · the level-clear bonus is 50 per remaining life', () => {
  const spawns = [];
  for (let i = 0; i < 3; i += 1) spawns.push({ index: i, tick: i * 60, colour: 0 });
  const level = twoDepotLevel({ spawns, quota: 2 });
  const s = drive(step, createState(level), new Map(), 400);
  assert.equal(s.phase, 'won');
  assert.equal(s.lives, 3);
  assert.equal(s.score, 100 + 110 + SCORE_LIFE_BONUS * 3);
});

test('AC-133 · cars in flight at level end are kept, unscored', () => {
  const spawns = [{ index: 0, tick: 0, colour: 0 }, { index: 1, tick: 100, colour: 0 }];
  const level = twoDepotLevel({ spawns, quota: 1 });
  const s = drive(step, createState(level), new Map(), 400);
  assert.equal(s.phase, 'won');
  assert.equal(s.cars.length, 1, 'the second car is frozen in place');
  assert.equal(s.delivered, 1);
  assert.equal(s.misrouted, 0);
});

test('AC-801 · the last misroute ends the level on that tick', () => {
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 1 }], quota: 9 });
  let s = createState(level);
  s.lives = 1;
  s = drive(step, s, new Map(), 400);
  assert.equal(s.phase, 'lost');
  assert.equal(s.lives, 0);
  assert.equal(s.tick, 154, 'ended on the arrival tick, not later');
});

test('AC-808 · spawn exhaustion throws rather than stalling', () => {
  // A schedule that genuinely cannot reach the quota: one car, quota 99, nothing left to
  // spawn. delivered + in-flight can never reach 99, so the run would stall silently.
  const level = twoDepotLevel({ spawns: [{ index: 0, tick: 0, colour: 0 }], quota: 99, slack: false });
  assert.throws(() => step(createState(level), []), /SPAWN_EXHAUSTED/);
});

test('AC-808 · consuming the LAST scheduled car is not exhaustion', () => {
  // The canary used to test `nextSpawn >= spawns.length` immediately after the increment, so
  // spawning the final car of a perfectly valid schedule threw. That made the usable schedule
  // `quota + SPAWN_SLACK - 1`; under the flat slack of 8, band 5 seed 160 consumed 71 of its
  // 72 cars, one short of the throw. The derived slack makes band 5's schedule 74 and the
  // oracle's worst consumption 71, a margin of 3 (AC-139) — but the canary's shape is what
  // this test is about, and nothing in the design says the last car is unusable.
  const spawns = [
    { index: 0, tick: 0, colour: 1 },
    { index: 1, tick: 20, colour: 1 },
    { index: 2, tick: 40, colour: 1 },
  ];
  const level = twoDepotLevel({ spawns, quota: 2, slack: false });
  const flip = new Map([[0, [{ tick: 0, junctionId: 0 }]]]); // send every car to depot colour 1
  let s;
  assert.doesNotThrow(() => { s = drive(step, createState(level), flip, 400); });
  assert.equal(s.nextSpawn, 3, 'all three scheduled cars were consumed');
  assert.equal(s.phase, 'won');
  assert.equal(s.delivered, 2);
});

test('AC-808 · the canary still fires once the run can no longer reach its quota', () => {
  // Same schedule, quota raised past what the three cars can deliver: the moment the last one
  // has spawned and the arithmetic says the quota is unreachable, the engine stops.
  const spawns = [
    { index: 0, tick: 0, colour: 1 },
    { index: 1, tick: 20, colour: 1 },
    { index: 2, tick: 40, colour: 1 },
  ];
  const level = twoDepotLevel({ spawns, quota: 4, slack: false });
  const flip = new Map([[0, [{ tick: 0, junctionId: 0 }]]]);
  assert.throws(() => drive(step, createState(level), flip, 400), /SPAWN_EXHAUSTED/);
});

test('AC-809 · an empty input array advances the tick and changes no junction', () => {
  const level = generate(2, 2);
  const s0 = createState(level);
  const s1 = step(s0, []);
  assert.equal(s1.tick, 1);
  assert.deepEqual(s1.open, s0.open);
});

test('AC-810 · step() after a terminal state returns a deeply equal state', () => {
  const spawns = [{ index: 0, tick: 0, colour: 0 }];
  const level = twoDepotLevel({ spawns, quota: 1 });
  const done = drive(step, createState(level), new Map(), 400);
  assert.notEqual(done.phase, 'running');

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
  assert.throws(() => assert.deepEqual({ ...expected, score: expected.score + 1 }, expected));
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
