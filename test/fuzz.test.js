// Seeded invariant fuzzing (docs/development-process.md §4) — AC-103, AC-118, AC-120,
// AC-121, AC-124, AC-130, AC-131.
//
// Drive the engine over thousands of seeded ticks with randomised taps and assert after
// every single step.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BANDS, CAR_SPEED, MLU } from '../src/engine/constants.js';
import { generate } from '../src/engine/generate.js';
import { createState, step } from '../src/engine/step.js';
import { checkInvariants, minSharedEdgeSeparationMlu } from '../src/engine/invariants.js';
import { makeStream } from '../src/engine/rng.js';

test('invariants hold after every step of 50,000 randomly-tapped ticks', () => {
  const rng = makeStream(0xfeed1234);
  let totalTicks = 0;
  let levels = 0;
  let band = 1;
  let seed = 0;
  while (totalTicks < 50000) {
    const level = generate(seed, band);
    let state = createState(level);
    let prev = null;
    while (state.phase === 'running' && totalTicks < 50000) {
      const inputs = [];
      if (rng.nextInt(8) === 0) {
        inputs.push({ tick: state.tick, junctionId: rng.nextInt(level.junctions.length) });
        if (rng.nextInt(20) === 0) {
          inputs.push({ tick: state.tick, junctionId: rng.nextInt(level.junctions.length) });
        }
      }
      prev = state;
      state = step(state, inputs);
      const bad = checkInvariants(state, prev);
      assert.deepEqual(bad, [], 'band ' + band + ' seed ' + seed + ' tick ' + state.tick + ': ' + bad.join('; '));
      totalTicks += 1;
    }
    levels += 1;
    seed += 1;
    band = (band % 5) + 1;
  }
  assert.ok(levels > 20, 'fuzz covered ' + levels + ' levels');
});

test('the invariant checker catches the faults it exists to catch', () => {
  // development-process.md §6.2: a check that cannot fail is not a check.
  const level = generate(3, 3);
  let s = createState(level);
  for (let i = 0; i < 200; i += 1) s = step(s, []);
  assert.deepEqual(checkInvariants(s, null), []);

  const offEdge = { ...s, cars: s.cars.map((c) => ({ ...c, progress: 99999999 })) };
  assert.ok(checkInvariants(offEdge, null).some((m) => m.includes('off its edge')));

  const dupIds = { ...s, cars: [{ ...s.cars[0] }, { ...s.cars[0] }] };
  assert.ok(checkInvariants(dupIds, null).some((m) => m.includes('ascending')));

  const floaty = { ...s, delivered: 1.5 };
  assert.ok(checkInvariants(floaty, null).some((m) => m.includes('not an integer')));

  // `delivered` IS the score (gameplay.md §4.3), so the non-decreasing invariant moved to it
  // and the `score` field itself is now a violation to carry at all (AC-117).
  assert.ok(checkInvariants({ ...s, delivered: 0 }, { ...s, delivered: 10 })
    .some((m) => m.includes('delivered decreased')));
  assert.ok(checkInvariants({ ...s, score: 0 }, null).some((m) => m.includes('`score` field')));
  assert.ok(checkInvariants({ ...s, lives: 3 }, { ...s, lives: 2 }).some((m) => m.includes('lives increased')));
  assert.ok(checkInvariants({ ...s, tick: s.tick + 5 }, s).some((m) => m.includes('tick did not advance')));
  assert.ok(checkInvariants({ ...s, delivered: s.delivered + 1 }, null).some((m) => m.includes('spawned-delivered-misrouted')));
  // The clock bound, which is new in round 8: nothing may hold a tick past LEVEL_TICKS.
  assert.ok(checkInvariants({ ...s, tick: 7201 }, null).some((m) => m.includes('past LEVEL_TICKS')));
  // ...and the schedule bound, which replaced "spawn schedule exhausted".
  assert.ok(checkInvariants({ ...s, nextSpawn: level.spawns.length + 1 }, null)
    .some((m) => m.includes('past spawns.length')));
});

/**
 * One pass over one seed, returning the closest two cars ever came on a shared edge and how
 * many ticks actually put two cars on one edge at all. `perturb` is the injection hook: a
 * check that has never been seen to fail is not a check (development-process.md §6.2).
 */
function sharedEdgeSweep(level, tapEvery, perturb) {
  let observedMinMlu = Infinity;
  let observations = 0;
  let s = createState(level);
  while (s.phase === 'running' && s.tick < 8000) {
    const inputs = tapEvery && s.tick % tapEvery === 0
      ? [{ tick: s.tick, junctionId: s.tick % level.junctions.length }]
      : [];
    s = step(s, inputs);
    const measured = perturb ? perturb(s) : s;
    const sep = minSharedEdgeSeparationMlu(measured);
    if (Number.isFinite(sep)) {
      observations += 1;
      if (sep < observedMinMlu) observedMinMlu = sep;
    }
  }
  return { observedMinMlu, observations };
}

test('AC-124 · cars sharing an edge are never closer than the spawn gap allows', () => {
  // The previous form ran ONE seed per band (band*101) behind an `if (observedMin !== Infinity)`
  // guard. On seeds 303, 404 and 505 no two cars ever share an edge, so bands 3, 4 and 5
  // asserted nothing at all and reported green — development-process.md §6.2 exactly. Every
  // band now sweeps ten seeds in both a no-tap and a tapped pass, and the observation count is
  // itself asserted, so a band that stops exercising the rule fails instead of passing.
  //
  // ROUND 8 MOVED THE REACHABILITY AGAIN, AND IN THE OTHER DIRECTION. Round 6's lever pull had
  // made band 5 arithmetically unreachable — the floor was 319.2 LU against a longest edge of
  // 293 — so the band was asserted the other way, at exactly zero observations. Round 8's
  // geometry made the longest edge 330 LU against a floor of 321.6: reachable again, but the
  // window was 8.4 LU of a 330 LU edge and ten seeds found nothing.
  //
  // ROUND 9 OPENS IT PROPERLY, at both ends and without anyone aiming at it. The floor FELL —
  // `(interval - 2*jitter) * CAR_SPEED / 1000` with a constant 2750 rather than a per-band
  // 3350 — and the longest edge ROSE, because `colW` is derived and larger at every `C`. Band
  // 5's window goes from 8.4 LU of a 330 LU edge to 57.5 LU of a 338 LU edge.
  //
  // TWO DESIGN NUMBERS ARE STALE HERE AND THE TEST HOLDS THE FORMULA, NOT THE ROW.
  // AC-124 and gameplay.md §4.5's table both still print `418 / 331 / 317 / 320 / 322 LU`,
  // "never less than 317 LU — three times CAR_L = 104". Those are round 8's, computed with the
  // per-band speed column round 9 deleted. generation.md §6.1.4's "min car separation" row has
  // the round-9 values — 457 / 322 / 308 / 289 / 281 — and they are what the formula produces.
  // The "three times CAR_L" clause does NOT survive: band 5's floor is 280.5 LU, which is 2.70
  // car lengths. It is still 2.7x a car and the guarantee is unharmed; the multiple in the
  // sentence is not.
  const SEEDS_FOR_BAND = [null, 20, 20, 20, 20, 20];
  for (let band = 1; band <= 5; band += 1) {
    const P = BANDS[band];
    const floorLu = ((P.interval - 2 * P.jitter) * CAR_SPEED) / MLU;
    // generation.md §6.1.4, transcribed.
    const WANT_FLOOR = [null, 456.5, 321.75, 308, 288.75, 280.5];
    assert.equal(Number(floorLu.toFixed(2)), WANT_FLOOR[band], 'band ' + band + ' separation floor');
    assert.ok(floorLu >= 280, 'band ' + band + ' separation floor ' + floorLu);
    let observedMinMlu = Infinity;
    let observations = 0;
    let longestEdgeLu = 0;
    for (let seed = 0; seed < SEEDS_FOR_BAND[band]; seed += 1) {
      const level = generate(seed, band);
      for (const e of level.edges) {
        if (e.lengthMlu / MLU > longestEdgeLu) longestEdgeLu = e.lengthMlu / MLU;
      }
      for (const tapEvery of [0, 13]) {
        const r = sharedEdgeSweep(level, tapEvery, null);
        observations += r.observations;
        if (r.observedMinMlu < observedMinMlu) observedMinMlu = r.observedMinMlu;
      }
    }
    if (floorLu > longestEdgeLu) {
      // Unreachable by arithmetic: no edge is long enough to hold two cars at the floor.
      assert.equal(
        observations, 0,
        'band ' + band + ' shared an edge although the floor (' + floorLu + ' LU) exceeds its'
          + ' longest edge (' + longestEdgeLu + ' LU) — that is a separation violation',
      );
      continue;
    }
    assert.ok(
      observations > 0,
      'band ' + band + ' never put two cars on one edge, so the assertion below never ran',
    );
    assert.ok(
      observedMinMlu / MLU >= floorLu,
      'band ' + band + ' observed ' + observedMinMlu / MLU + ' LU < floor ' + floorLu + ' LU',
    );
    // AC-124's "three times CAR_L" is round 8's multiple and band 5 is at 2.70 now. The
    // durable statement is the FLOOR above; this keeps a second, weaker bound so that a future
    // table which halves the separation is caught by something other than the formula agreeing
    // with itself.
    assert.ok(observedMinMlu / MLU > 2.5 * 104,
      'band ' + band + ' closer than 2.5 car lengths: ' + observedMinMlu / MLU);
  }
});

test('the AC-124 sweep fails when a separation violation is injected', () => {
  // A second car planted one third of a spawn gap behind a real one, on the same edge.
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(0, band);
    const floorLu = ((level.interval - 2 * level.jitter) * CAR_SPEED) / MLU;
    const gapMlu = Math.floor((floorLu * MLU) / 3);
    const tailgate = (s) => {
      const lead = s.cars.find((c) => c.progress >= gapMlu);
      if (!lead) return s;
      const clone = { id: lead.id + 1000, colour: lead.colour, edgeId: lead.edgeId, progress: lead.progress - gapMlu };
      return { ...s, cars: [...s.cars, clone] };
    };
    const r = sharedEdgeSweep(level, 0, tailgate);
    assert.ok(r.observations > 0, 'band ' + band + ' injection was never observed');
    assert.ok(
      r.observedMinMlu / MLU < floorLu,
      'band ' + band + ' injected violation slipped past the measurement',
    );
  }
});
