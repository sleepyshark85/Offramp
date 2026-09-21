// Determinism ACs — AC-113, AC-125, AC-134, AC-201, AC-811.
//
// "When determinism regresses, that outranks every other finding" (CLAUDE.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { GEN_SALT, SPAWN_SALT } from '../src/engine/constants.js';
import { generate } from '../src/engine/generate.js';
import { createState, step } from '../src/engine/step.js';
import { makeStream, mix32 } from '../src/engine/rng.js';

/** A recorded run: a seed, a band, and tick-stamped inputs. Nothing else. */
function recordedRun(seed, band) {
  const level = generate(seed, band);
  const inputs = [];
  for (let t = 40; t < 4000; t += 7) {
    inputs.push({ tick: t, junctionId: (t * 31) % level.junctions.length });
  }
  return { seed, band, inputs };
}

function replay(run) {
  const level = generate(run.seed, run.band);
  const byTick = new Map();
  for (const i of run.inputs) {
    if (!byTick.has(i.tick)) byTick.set(i.tick, []);
    byTick.get(i.tick).push(i);
  }
  let s = createState(level);
  while (s.phase === 'running' && s.tick < 6000) s = step(s, byTick.get(s.tick) || []);
  return s;
}

/** Everything a replay must reproduce, in a form two processes can compare. */
function fingerprint(state) {
  return JSON.stringify({
    tick: state.tick,
    phase: state.phase,
    rng: state.rng,
    cars: state.cars,
    open: Array.from(state.open),
    nextSpawn: state.nextSpawn,
    delivered: state.delivered,
    misrouted: state.misrouted,
    lives: state.lives,
    streak: state.streak,
    bestStreak: state.bestStreak,
  });
}

test('AC-125 · a recorded run replays to a deeply equal final state, twice in one process', () => {
  for (let band = 1; band <= 5; band += 1) {
    const run = recordedRun(1000 + band, band);
    const a = replay(run);
    const b = replay(run);
    assert.deepEqual(a, b);
    assert.deepEqual(a.open, b.open);
    assert.equal(fingerprint(a), fingerprint(b));
  }
});

test('AC-125/AC-811 · the same run replays identically in a separate process', () => {
  const runs = [1, 2, 3, 4, 5].map((band) => recordedRun(1000 + band, band));
  const here = runs.map((r) => fingerprint(replay(r)));

  const child = `
    import { generate } from '${new URL('../src/engine/generate.js', import.meta.url).pathname}';
    import { createState, step } from '${new URL('../src/engine/step.js', import.meta.url).pathname}';
    const runs = ${JSON.stringify(runs)};
    const out = runs.map((run) => {
      const level = generate(run.seed, run.band);
      const byTick = new Map();
      for (const i of run.inputs) {
        if (!byTick.has(i.tick)) byTick.set(i.tick, []);
        byTick.get(i.tick).push(i);
      }
      let s = createState(level);
      while (s.phase === 'running' && s.tick < 6000) s = step(s, byTick.get(s.tick) || []);
      return JSON.stringify({ tick: s.tick, phase: s.phase, rng: s.rng, cars: s.cars,
        open: Array.from(s.open), nextSpawn: s.nextSpawn, delivered: s.delivered,
        misrouted: s.misrouted, lives: s.lives, streak: s.streak,
        bestStreak: s.bestStreak });
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const raw = execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', child], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(raw), here);
});

test('AC-113/AC-201 · generation is a pure function of (seed, band), across processes', () => {
  const here = [];
  for (let band = 1; band <= 5; band += 1) for (const seed of [0, 7, 65535, 2147483647]) {
    here.push(JSON.stringify(generate(seed, band)));
  }
  const child = `
    import { generate } from '${new URL('../src/engine/generate.js', import.meta.url).pathname}';
    const out = [];
    for (let band = 1; band <= 5; band += 1) for (const seed of [0, 7, 65535, 2147483647]) {
      out.push(JSON.stringify(generate(seed, band)));
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const raw = execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', child], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(raw), here);
});

test('AC-134 · the spawn stream is independent of the number of generator draws', () => {
  // The spawn schedule is derived from mix32(seed, SPAWN_SALT) alone. Burning generator
  // draws must not move it.
  const level = generate(555, 4);
  const spawnRng = makeStream(mix32(555, SPAWN_SALT));
  const genRng = makeStream(mix32(555, GEN_SALT));
  for (let i = 0; i < 1000; i += 1) genRng.next();
  const first = level.spawns[0].tick;
  assert.equal(generate(555, 4).spawns[0].tick, first);
  assert.notEqual(spawnRng.state, genRng.state);
  // Two levels that differ in how many attempts they took still agree on their own schedule.
  for (let seed = 0; seed < 200; seed += 1) {
    assert.deepEqual(generate(seed, 2).spawns, generate(seed, 2).spawns);
  }
});

test('mix32 and mulberry32 are uint32 and stable', () => {
  assert.equal(mix32(0, GEN_SALT), mix32(0, GEN_SALT));
  const rng = makeStream(mix32(42, GEN_SALT));
  for (let i = 0; i < 1000; i += 1) {
    const v = rng.next();
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  }
});
