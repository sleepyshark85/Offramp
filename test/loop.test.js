// The React layer's frame loop, as pure functions — AC-127, AC-128, AC-305 to AC-309,
// AC-803, AC-805, AC-806, and the event window AC-505 depends on.
//
// These are tier 1 rather than tier 3 because src/ui/loop.js was deliberately written with
// no React in it: the rules about frames, pauses and backgrounding are arithmetic, and
// arithmetic should not need a browser to check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_CATCHUP_TICKS, TICK_HZ, advanceClock, createState, resetClock } from '../src/engine/index.js';
import { generate } from '../src/engine/generate.js';
import { EVENT_WINDOW_TICKS, advanceFrame, collectEvents, enqueueTap } from '../src/ui/loop.js';
import { MODE, backgroundAction } from '../src/ui/appState.js';

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

test('AC-803 · backgrounding is STRICT on a device and lenient on web, and web only', () => {
  // The playtest finding: `react-native-web` maps `AppState` onto `visibilitychange`, which
  // fires for switching tabs, losing window focus, an OS notification or undocking devtools.
  // The owner's first play session was interrupted by exactly that. Web is a development
  // harness and a tier-3 target, not a shipping platform.
  //
  // The decision is a pure function so both halves can be checked here rather than only on a
  // device, and the ASYMMETRY is what is asserted: the accumulator reset happens on every
  // platform, and only the pause and the countdown are relaxed.
  for (const os of ['ios', 'android', 'macos', 'windows', undefined]) {
    const leaving = backgroundAction(os, 'background', false);
    assert.equal(leaving.resetClock, true, os + ': the accumulator must be zeroed');
    assert.equal(leaving.mode, MODE.PAUSED, os + ': a device MUST pause — a phone call is not 400 ticks');
    assert.equal(leaving.markBackgrounded, true);
    const returning = backgroundAction(os, 'active', true);
    assert.equal(returning.resetClock, true);
    assert.equal(returning.mode, MODE.COUNTDOWN, os + ': resuming costs a 3-2-1 (AC-804)');
    assert.equal(returning.markBackgrounded, false);
    // 'inactive' is the iOS notification-shade / app-switcher state and is also not 'active'.
    assert.equal(backgroundAction(os, 'inactive', false).mode, MODE.PAUSED);
  }

  // Web: the accumulator is STILL zeroed — that is the half that protects the simulation and
  // it is not relaxed — but the game keeps running.
  const webAway = backgroundAction('web', 'background', false);
  assert.equal(webAway.resetClock, true, 'web must still zero the accumulator');
  assert.equal(webAway.mode, undefined, 'web must not pause');
  assert.equal(webAway.markBackgrounded, undefined, 'web must not arm the countdown');
  const webBack = backgroundAction('web', 'active', false);
  assert.equal(webBack.mode, undefined, 'web must not run a countdown it never armed');

  // And the second half of the web protection, which does not depend on the handler at all: a
  // hidden tab does not service requestAnimationFrame, so the first frame back carries a delta
  // of seconds — and `advanceClock` clamps it to MAX_CATCHUP_TICKS and discards the rest.
  // Eight ticks is 133 ms of world time for any length of absence (AC-127).
  for (const gapMs of [2000, 30000, 600000]) {
    const r = advanceClock(0, gapMs);
    assert.equal(r.ticks, MAX_CATCHUP_TICKS, gapMs + ' ms resumed at ' + r.ticks + ' ticks');
    assert.equal(r.accTicks, 0);
  }
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

test('AC-306 · two taps in one frame are two inputs on one tick, ordered by junction id', () => {
  // Round 7 rewrote AC-306 from "two simultaneous pointers" to a property of the input QUEUE,
  // because Offramp is a one-pointer game (ui.md §10.3) and two taps landing between the same
  // pair of step() calls is reachable with one finger: the window is 16.7 ms at 60 fps,
  // 33 ms at 30, and longer under a catch-up frame.
  const { state } = fresh(3);
  const warm = run(state, 30, 1000 / 60);
  // Submitted in DESCENDING order, so an implementation that honoured arrival order would
  // produce [2, 1] and fail.
  let q = enqueueTap([], warm.state, 2);
  q = enqueueTap(q, warm.state, 1);
  assert.equal(q.length, 2, 'neither tap was coalesced or dropped');
  assert.equal(q[0].tick, q[1].tick, 'both stamped to the same tick');
  const before = [warm.state.open[1], warm.state.open[2]];
  const r = advanceFrame(warm.state, 0, 1000 / 60, q, []);
  const flips = r.state.events.filter((e) => e.type === 'flip').map((e) => e.junctionId);
  assert.deepEqual(flips, [1, 2], 'ascending by junction id, not by arrival order');
  assert.equal(r.state.open[1], before[0] ^ 1, 'junction 1 actually flipped');
  assert.equal(r.state.open[2], before[1] ^ 1, 'junction 2 actually flipped');
  assert.equal(r.pending.length, 0, 'both were consumed by that one step()');
});

test('AC-306 · nothing caps how many inputs may share a tick — MAX_POINTERS is deleted', () => {
  // The deleted cap silently discarded the third and later input stamped to one tick. Under a
  // MAX_CATCHUP_TICKS catch-up frame a player can legitimately queue more than two, and
  // gameplay.md §3.5 says there is no debounce and no coalescing.
  const { state } = fresh(4);
  const warm = run(state, 30, 1000 / 60);
  const ids = [3, 0, 2, 1, 0];
  let q = [];
  for (const id of ids) q = enqueueTap(q, warm.state, id);
  assert.equal(q.length, ids.length, 'an input was dropped: ' + JSON.stringify(q));
  assert.ok(q.every((p) => p.tick === warm.state.tick));
  const r = advanceFrame(warm.state, 0, 1000 / 60, q, []);
  const flips = r.state.events.filter((e) => e.type === 'flip').map((e) => e.junctionId);
  assert.deepEqual(flips, [0, 0, 1, 2, 3], 'every input reached step(), in junction order');
  // Junction 0 was tapped twice on one tick: two toggles net to no change (AC-111).
  assert.equal(r.state.open[0], warm.state.open[0]);
  // And the engine module no longer exports the constant at all.
  const engine = readFileSync(new URL('../src/engine/constants.js', import.meta.url), 'utf8');
  assert.ok(!engine.includes('MAX_POINTERS'), 'MAX_POINTERS is still in the engine constants');
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
  for (const banned of ['Pan', 'LongPress', 'Fling', 'Pinch', 'Rotation', 'Manual', 'numberOfTaps']) {
    assert.ok(!src.includes(banned), 'PlayScreen mentions ' + banned);
  }
  // ui.md §10.3's two configured limits, transcribed.
  assert.ok(/maxDuration\(TAP_MAX_DURATION_MS\)/.test(src) && src.includes('TAP_MAX_DURATION_MS = 400'));
  assert.ok(/maxDistance\(TAP_MAX_DISTANCE_PT\)/.test(src) && src.includes('TAP_MAX_DISTANCE_PT = 16'));
});

test('AC-313 · the hit-tested point is captured at begin, not read off the end event', () => {
  // The behavioural check is tier 3 (e2e/play.e2e.mjs), where two real touch points are
  // dispatched at two junctions. This is the source-level half: RNGH's default is the
  // centroid, so the defect is the ABSENCE of a capture rather than the presence of anything,
  // and a grep is the only tier-1 instrument that can see an absence.
  const src = readFileSync(new URL('../src/ui/PlayScreen.js', import.meta.url), 'utf8');
  assert.ok(/\.onBegin\(/.test(src), 'nothing captures the gesture-begin point');
  const onEnd = src.slice(src.indexOf('.onEnd('), src.indexOf('.onEnd(') + 300);
  assert.ok(!/onTap\(e\.x/.test(onEnd), 'onEnd still hit-tests the event point, which is the centroid');
  assert.ok(/onTap\(first\.x, first\.y\)/.test(onEnd), 'onEnd does not hit-test the captured first point');
  // AC-312 is unchanged by this: the capture is on the one Tap gesture, not a second handler.
  assert.equal([...src.matchAll(/Gesture\.(\w+)\(/g)].length, 1);
});
