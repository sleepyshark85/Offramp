// Solver-bot ACs — AC-220, AC-232, AC-813, AC-814.
//
// The large sweeps (1,000 seeds per band) live in tools/bot.mjs and tools/pacing.mjs; this
// suite holds the sample size that can run inside `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { generate } from '../src/engine/generate.js';
import { createState, step } from '../src/engine/step.js';
import {
  BOT_LOCKOUT_TICKS,
  BOT_MIN_TAP_GAP,
  nextJunction,
  playLevel,
  replay,
} from '../tools/lib/solver.mjs';

const SEEDS = 120;

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

test('AC-813 · the minimum-junction band is still winnable and still needs taps', () => {
  let cleared = 0;
  for (let seed = 0; seed < SEEDS; seed += 1) {
    const level = generate(seed, 1);
    assert.equal(level.junctions.length, 3);
    if (playLevel(level, 'constrained').cleared) cleared += 1;
  }
  assert.ok(cleared > SEEDS * 0.9, 'band 1 constrained clear rate ' + (cleared / SEEDS));
});

test('AC-232 · the constrained bot obeys its own constraints', () => {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 25; seed += 1) {
      const level = generate(seed, band);
      const run = playLevel(level, 'constrained');

      // One tap per tick, and at least BOT_MIN_TAP_GAP ticks between taps.
      for (let i = 1; i < run.inputs.length; i += 1) {
        const gap = run.inputs[i].tick - run.inputs[i - 1].tick;
        assert.ok(gap >= BOT_MIN_TAP_GAP, 'tap gap ' + gap + ' at band ' + band);
      }
      const ticks = new Set(run.inputs.map((i) => i.tick));
      assert.equal(ticks.size, run.inputs.length, 'more than one tap in a tick');

      // No tap inside the lockout window of the junction it targets. Re-simulated rather
      // than trusted: the bot's own bookkeeping is not evidence about the bot.
      const byTick = new Map();
      for (const i of run.inputs) byTick.set(i.tick, i);
      let s = createState(level);
      while (s.phase === 'running' && s.tick < 20000) {
        const tap = byTick.get(s.tick);
        if (tap) {
          for (const car of s.cars) {
            const nj = nextJunction(level, car);
            if (nj && nj.node.junctionId === tap.junctionId) {
              assert.ok(nj.eta > BOT_LOCKOUT_TICKS, 'flip within lockout: eta ' + nj.eta);
            }
          }
        }
        s = step(s, tap ? [tap] : []);
      }
    }
  }
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
