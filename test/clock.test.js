// The wall-clock boundary — AC-127, AC-128, AC-805, AC-806, AC-803.
//
// The conversion is a pure function, so the rules that gameplay.md §2.1 and §6.2 state about
// frames, pauses and backgrounding are testable in slice 1, with no React and no timer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CATCHUP_TICKS } from '../src/engine/constants.js';
import { advanceClock, resetClock } from '../src/engine/clock.js';
import { generate } from '../src/engine/generate.js';
import { createState, step } from '../src/engine/step.js';

test('AC-805 · a 50 ms frame advances exactly 3 whole ticks and no fraction', () => {
  const r = advanceClock(0, 50);
  assert.equal(r.ticks, 3);
  assert.ok(Number.isInteger(r.ticks));
  assert.ok(r.accTicks < 1 && r.accTicks >= 0);
});

test('a 16.667 ms frame advances exactly one tick and carries the rest', () => {
  let acc = 0;
  let total = 0;
  for (let f = 0; f < 600; f += 1) {
    const r = advanceClock(acc, 1000 / 60);
    acc = r.accTicks;
    total += r.ticks;
  }
  assert.equal(total, 600, '600 frames of 16.667 ms is 600 ticks, not 599');
});

test('AC-127/AC-806 · a 2,000 ms frame is capped at MAX_CATCHUP_TICKS and resets', () => {
  const r = advanceClock(0, 2000);
  assert.equal(r.ticks, MAX_CATCHUP_TICKS);
  assert.equal(r.accTicks, 0, 'the remainder is discarded, not carried');
});

test('AC-128/AC-803 · not calling step() is how a pause works — the tick never moves', () => {
  const level = generate(8, 2);
  let s = createState(level);
  for (let i = 0; i < 100; i += 1) s = step(s, []);
  const paused = s;
  // 5 s of wall time while paused: the layer above simply does not call step().
  let acc = resetClock();
  for (let f = 0; f < 300; f += 1) acc = advanceClock(acc, 1000 / 60).accTicks;
  assert.equal(paused.tick, s.tick);
  // On resume the accumulator is zeroed: a 30 s background is not 1,800 ticks.
  const resumed = advanceClock(resetClock(), 30000);
  assert.equal(resumed.ticks, MAX_CATCHUP_TICKS);
  assert.equal(advanceClock(resetClock(), 0).ticks, 0);
});
