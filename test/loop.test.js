// The React layer's frame loop, as pure functions — AC-127, AC-128, AC-305 to AC-309,
// AC-803, AC-805, AC-806, and the event window AC-505 depends on.
//
// These are tier 1 rather than tier 3 because src/ui/loop.js was deliberately written with
// no React in it: the rules about frames, pauses and backgrounding are arithmetic, and
// arithmetic should not need a browser to check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_CATCHUP_TICKS, MAX_POINTERS, TICK_HZ, createState, resetClock } from '../src/engine/index.js';
import { generate } from '../src/engine/generate.js';
import { EVENT_WINDOW_TICKS, advanceFrame, collectEvents, enqueueTap } from '../src/ui/loop.js';

function fresh(band = 2, seed = 4242) {
  const level = generate(seed, band);
  return { level, state: createState(level) };
}

/** Drive `frames` frames of `deltaMs` each, as the rAF loop does. */
function run(state, frames, deltaMs, pending = []) {
  let s = state;
  let acc = 0;
  let q = pending;
  let ev = [];
  let ticks = 0;
  for (let i = 0; i < frames; i += 1) {
    const r = advanceFrame(s, acc, deltaMs, q, ev);
    s = r.state;
    acc = r.accTicks;
    q = r.pending;
    ev = r.recent;
    ticks += r.ticksRun;
  }
  return { state: s, accTicks: acc, pending: q, recent: ev, ticks };
}

test('AC-805 · 60 frames of 16.667 ms advance exactly 60 ticks', () => {
  const { state } = fresh();
  const r = run(state, 60, 1000 / 60);
  assert.equal(r.ticks, 60);
  assert.equal(r.state.tick, 60);
});

test('AC-127 / AC-806 · a 2,000 ms frame runs at most 8 ticks and resets the accumulator', () => {
  const { state } = fresh();
  const r = advanceFrame(state, 0, 2000, [], []);
  assert.equal(r.ticksRun, MAX_CATCHUP_TICKS);
  assert.equal(r.ticksRun, 8);
  assert.equal(r.accTicks, 0, 'the surplus is discarded, not carried');
  assert.equal(r.state.tick, 8);
});

test('AC-128 · a paused game does not advance: the loop is simply not called', () => {
  const { state } = fresh();
  // Five seconds of wall time with the loop stopped. The engine has no concept of pause
  // (gameplay.md §6.1), so "paused" is the absence of these calls, and the assertion is that
  // nothing else advances the tick.
  const before = state.tick;
  assert.equal(before, 0);
  assert.equal(state.tick, before, 'state.tick is unchanged after 5 s of not calling the loop');
  // And the moment the loop resumes, it resumes from the same tick with no catch-up.
  const r = advanceFrame(state, resetClock(), 1000 / 60, [], []);
  assert.equal(r.state.tick, before + 1);
});

test('AC-803 · resetClock() on background means a 30 s gap is worth zero ticks', () => {
  const { state } = fresh();
  const warm = run(state, 120, 1000 / 60);
  const tickAtBackground = warm.state.tick;
  // Backgrounded: the React layer zeroes its accumulator (gameplay.md §6.2) and stops the
  // loop. Thirty seconds pass. On resume the first frame carries a zero delta.
  const acc = resetClock();
  assert.equal(acc, 0);
  const resumed = advanceFrame(warm.state, acc, 0, [], []);
  assert.equal(resumed.state.tick, tickAtBackground, 'a phone call is not 1,800 ticks');
  // Contrast: without the reset, a naive catch-up would still be capped at 8 — which is why
  // the cap alone is not the guarantee and resetClock has to exist.
  const naive = advanceFrame(warm.state, 0, 30000, [], []);
  assert.equal(naive.state.tick, tickAtBackground + MAX_CATCHUP_TICKS);
});

test('AC-305 · a tap is stamped to the next tick to be simulated and consumed by it', () => {
  const { level, state } = fresh();
  const warm = run(state, 30, 1000 / 60);
  const T = warm.state.tick;
  const q = enqueueTap([], warm.state, 0);
  assert.deepEqual(q, [{ tick: T, junctionId: 0 }]);
  const r = advanceFrame(warm.state, 0, 1000 / 60, q, []);
  assert.equal(r.pending.length, 0, 'consumed');
  assert.equal(r.state.open[0], 1);
  const flip = r.state.events.find((e) => e.type === 'flip');
  assert.equal(flip.tick, T, 'the flip is recorded on the tick it was stamped for');
  assert.ok(level.junctions.length > 0);
});

test('AC-306 · two taps in one frame are stamped to the same tick and resolve by junction id', () => {
  const { state } = fresh(3);
  const warm = run(state, 30, 1000 / 60);
  let q = enqueueTap([], warm.state, 2);
  q = enqueueTap(q, warm.state, 1);
  assert.equal(q.length, 2);
  assert.equal(q[0].tick, q[1].tick);
  const r = advanceFrame(warm.state, 0, 1000 / 60, q, []);
  const flips = r.state.events.filter((e) => e.type === 'flip').map((e) => e.junctionId);
  assert.deepEqual(flips, [1, 2], 'ascending by junction id, not by arrival order');
});

test('ui.md §10.3 · at most MAX_POINTERS inputs are accepted for one tick', () => {
  const { state } = fresh(4);
  let q = [];
  for (let i = 0; i < 5; i += 1) q = enqueueTap(q, state, i % 3);
  assert.equal(q.length, MAX_POINTERS);
  assert.equal(MAX_POINTERS, 2);
});

test('AC-309 · no debounce: two taps 20 ms apart land on consecutive ticks and net to zero', () => {
  const { state } = fresh();
  const warm = run(state, 30, 1000 / 60);
  const before = warm.state.open[0];
  // 20 ms is longer than a frame, so the taps fall in different frames and different ticks.
  let s = warm.state;
  let acc = warm.accTicks;
  const ticks = [];
  for (let i = 0; i < 2; i += 1) {
    const q = enqueueTap([], s, 0);
    ticks.push(q[0].tick);
    const r = advanceFrame(s, acc, 20, q, []);
    s = r.state;
    acc = r.accTicks;
  }
  assert.equal(ticks[1], ticks[0] + 1, 'consecutive ticks');
  assert.equal(s.open[0], before, 'two toggles net to no change');
});

test('an input stamped for a tick the catch-up cap discarded is honoured, not stranded', () => {
  const { state } = fresh();
  const warm = run(state, 30, 1000 / 60);
  const q = enqueueTap([], warm.state, 0);
  // A 2 s stall: the clock caps at 8 ticks and drops the rest. The input's stamp is now in
  // the past relative to nothing — it is consumed by the first tick of the frame.
  const r = advanceFrame(warm.state, 0, 2000, q, []);
  assert.equal(r.pending.length, 0);
  assert.equal(r.state.open[0], 1);
});

test('AC-505 · the event window is pruned by TICK, so it is identical at any frame rate', () => {
  const { level, state } = fresh(1, 99);
  // Stop a few ticks AFTER the first car appears, or the window would be empty and the
  // deepEqual below would compare two empty arrays and pass while asserting nothing
  // (docs/development-process.md §6.8). The assert at the end of this test is what caught
  // exactly that on the first run of it.
  const T = 3 * Math.ceil((level.spawns[0].tick + 5) / 3);
  const slow = run(state, T / 3, 50); // 3 ticks a frame
  const fast = run(state, T, 1000 / 60); // 1 tick a frame
  assert.equal(slow.state.tick, T);
  assert.equal(fast.state.tick, T);
  assert.deepEqual(
    slow.recent.map((e) => e.type + '@' + e.tick),
    fast.recent.map((e) => e.type + '@' + e.tick),
    'the same 120 ticks produce the same event window however they were framed',
  );
  assert.ok(slow.recent.length > 0, 'events were actually observed in the window');
});

test('the event window holds the whole of the longest animation in ui.md §9', () => {
  // ui.md §9: the longest play-surface animation is the depot rejecting flash, 90 + 260 ms.
  const longestMs = 90 + 260;
  assert.ok(
    (EVENT_WINDOW_TICKS * 1000) / TICK_HZ >= longestMs,
    EVENT_WINDOW_TICKS + ' ticks is ' + (EVENT_WINDOW_TICKS * 1000) / TICK_HZ + ' ms, short of ' + longestMs,
  );
});

test('events older than the window are dropped, and the window is not unbounded', () => {
  const fake = { tick: 100, events: [{ type: 'spawn', tick: 100, carId: 1 }] };
  const old = [
    { type: 'spawn', tick: 100 - EVENT_WINDOW_TICKS - 1, carId: 0 },
    { type: 'spawn', tick: 100 - EVENT_WINDOW_TICKS + 1, carId: 2 },
  ];
  const out = collectEvents(old, fake);
  assert.deepEqual(out.map((e) => e.carId), [2, 1]);
});

test('advanceFrame stops the moment the level ends, mid-frame', () => {
  const level = generate(7, 1);
  const state = createState(level);
  // Win the level by hand: drive to a phase change and confirm no tick runs past it.
  let s = state;
  let acc = 0;
  let ev = [];
  let frames = 0;
  while (s.phase === 'running' && frames < 60 * 300) {
    const r = advanceFrame(s, acc, 100, [], ev); // 6 ticks a frame
    s = r.state;
    acc = r.accTicks;
    ev = r.recent;
    frames += 1;
  }
  assert.notEqual(s.phase, 'running', 'the level ended');
  const after = advanceFrame(s, acc, 100, [], ev);
  assert.equal(after.ticksRun, 0);
  assert.equal(after.state.tick, s.tick);
});

test('AC-806 · a 2 s stall moves no car more than 8 * speed LU', () => {
  const level = generate(8181, 5);
  let s = createState(level);
  let acc = 0;
  let ev = [];
  // Warm up until several cars are rolling, then stall for two seconds.
  while (s.cars.length < 3 && s.tick < 60 * 60) {
    const r = advanceFrame(s, acc, 1000 / 60, [], ev);
    s = r.state;
    acc = r.accTicks;
    ev = r.recent;
  }
  assert.ok(s.cars.length >= 3, 'no cars were on the road, so nothing was measured');
  const before = new Map(s.cars.map((c) => [c.id, { edgeId: c.edgeId, progress: c.progress }]));
  const stalled = advanceFrame(s, acc, 2000, [], ev);
  let moved = 0;
  let observed = 0;
  for (const c of stalled.state.cars) {
    const was = before.get(c.id);
    if (!was || was.edgeId !== c.edgeId) continue; // crossed a node; measured below instead
    moved = Math.max(moved, (c.progress - was.progress) / 1000);
    observed += 1;
  }
  assert.ok(observed > 0, 'every car crossed a node, so no in-edge displacement was measured');
  const cap = (8 * level.speedMluPerTick) / 1000;
  assert.ok(moved <= cap, 'a car jumped ' + moved + ' LU against a cap of ' + cap);
  assert.equal(stalled.state.tick, s.tick + 8);
});

test('AC-312 · tap is the only gesture the play screen registers', () => {
  const src = readFileSync(new URL('../src/ui/PlayScreen.js', import.meta.url), 'utf8');
  const gestures = [...src.matchAll(/Gesture\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(gestures, ['Tap'], 'gestures registered: ' + JSON.stringify(gestures));
  for (const banned of ['Pan', 'LongPress', 'Fling', 'Pinch', 'Rotation', 'numberOfTaps']) {
    assert.ok(!src.includes(banned), 'PlayScreen mentions ' + banned);
  }
  // ui.md §10.3's two configured limits, transcribed.
  assert.ok(/maxDuration\(TAP_MAX_DURATION_MS\)/.test(src) && src.includes('TAP_MAX_DURATION_MS = 400'));
  assert.ok(/maxDistance\(TAP_MAX_DISTANCE_PT\)/.test(src) && src.includes('TAP_MAX_DISTANCE_PT = 16'));
});
