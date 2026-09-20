// State serialisation — AC-219's companion for the *state*, not just the level.
//
// `JSON.stringify(state)` does not round-trip, and it fails in the worst possible way: the
// parse succeeds, `open` comes back as a plain object with no length, and the TypeError
// arrives one tick later inside step(). Slice-4 persistence and slice 2's tier-3
// `window.__offramp` snapshot both cross this boundary.

import test from 'node:test';
import assert from 'node:assert/strict';

import { generate } from '../src/engine/generate.js';
import { createState, step } from '../src/engine/step.js';
import { deserialiseState, serialiseState } from '../src/engine/serialise.js';

/** Advance a real level far enough that every field is non-trivial. */
function midRunState(seed, band, ticks) {
  const level = generate(seed, band);
  let s = createState(level);
  for (let i = 0; i < ticks && s.phase === 'running'; i += 1) {
    s = step(s, i % 29 === 0 ? [{ tick: s.tick, junctionId: i % level.junctions.length }] : []);
  }
  return s;
}

test('the naive JSON.stringify(state) round-trip is broken — this is the fault being fixed', () => {
  const s = midRunState(7, 3, 600);
  assert.ok(s.open.length > 0);
  const naive = JSON.parse(JSON.stringify(s));
  assert.equal(naive.open.length, undefined, 'a Uint8Array serialises to an index-keyed object');
  assert.equal(Uint8Array.from(Object.values(naive.open)).length > 0, true);
  // And the rehydrated state breaks the very next transition.
  assert.throws(() => {
    let t = naive;
    for (let i = 0; i < 2000; i += 1) t = step(t, []);
  }, TypeError);
});

test('serialiseState / deserialiseState round-trip through JSON exactly', () => {
  for (const [seed, band, ticks] of [[7, 3, 600], [0, 1, 200], [42, 5, 1500], [3, 4, 0]]) {
    const s = midRunState(seed, band, ticks);
    const back = deserialiseState(JSON.parse(JSON.stringify(serialiseState(s))));
    assert.deepEqual(back, s, 'band ' + band + ' seed ' + seed);
    assert.ok(back.open instanceof Uint8Array);
  }
});

test('a rehydrated state steps identically to the one it was written from', () => {
  const s = midRunState(11, 4, 900);
  const back = deserialiseState(JSON.parse(JSON.stringify(serialiseState(s))));
  let a = s;
  let b = back;
  for (let i = 0; i < 400 && a.phase === 'running'; i += 1) {
    const inputs = i % 17 === 0 ? [{ tick: a.tick, junctionId: i % s.level.junctions.length }] : [];
    a = step(a, inputs);
    b = step(b, inputs.map((x) => ({ ...x })));
  }
  assert.deepEqual({ ...b, level: null }, { ...a, level: null });
  assert.equal(b.score, a.score);
  assert.equal(b.tick, a.tick);
});

test('a snapshot written without the level rehydrates against a regenerated one', () => {
  const s = midRunState(19, 2, 700);
  const payload = JSON.parse(JSON.stringify(serialiseState(s, { level: false })));
  assert.equal(payload.level, undefined);
  assert.throws(() => deserialiseState(payload), /no level/);
  const back = deserialiseState(payload, generate(payload.seed, payload.band));
  assert.deepEqual(back, s);
});

test('a malformed snapshot is rejected at the boundary, not one tick later', () => {
  const s = midRunState(5, 3, 300);
  const good = serialiseState(s);
  assert.throws(() => deserialiseState(null), /BAD_SNAPSHOT/);
  assert.throws(() => deserialiseState({ ...good, v: 2 }), /unknown version/);
  assert.throws(() => deserialiseState({ ...good, open: { 0: 1 } }), /open is not an array/);
  assert.throws(() => deserialiseState({ ...good, open: [] }), /junctions/);
});
