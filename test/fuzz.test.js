// Seeded invariant fuzzing (docs/development-process.md §4) — AC-103, AC-118, AC-120,
// AC-121, AC-124, AC-130, AC-131.
//
// Drive the engine over thousands of seeded ticks with randomised taps and assert after
// every single step.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MLU } from '../src/engine/constants.js';
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

  const floaty = { ...s, score: 1.5 };
  assert.ok(checkInvariants(floaty, null).some((m) => m.includes('not an integer')));

  assert.ok(checkInvariants({ ...s, score: 0 }, { ...s, score: 10 }).some((m) => m.includes('score decreased')));
  assert.ok(checkInvariants({ ...s, lives: 3 }, { ...s, lives: 2 }).some((m) => m.includes('lives increased')));
  assert.ok(checkInvariants({ ...s, tick: s.tick + 5 }, s).some((m) => m.includes('tick did not advance')));
  assert.ok(checkInvariants({ ...s, delivered: s.delivered + 1 }, null).some((m) => m.includes('spawned-delivered-misrouted')));
});

test('AC-124 · cars sharing an edge are never closer than the spawn gap allows', () => {
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 101, band);
    const floorLu = ((level.interval - 2 * level.jitter) * level.speedMluPerTick) / MLU;
    assert.ok(floorLu >= 228, 'band ' + band + ' separation floor ' + floorLu);
    let observedMin = Infinity;
    let s = createState(level);
    while (s.phase === 'running' && s.tick < 8000) {
      s = step(s, s.tick % 13 === 0 ? [{ tick: s.tick, junctionId: s.tick % level.junctions.length }] : []);
      const sep = minSharedEdgeSeparationMlu(s);
      if (sep < observedMin) observedMin = sep;
    }
    if (observedMin !== Infinity) {
      assert.ok(observedMin / MLU >= floorLu, 'band ' + band + ' observed ' + observedMin / MLU + ' < ' + floorLu);
      assert.ok(observedMin / MLU > 140, 'closer than one car length');
    }
  }
});
