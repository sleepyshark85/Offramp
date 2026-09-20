// Geometry ACs — AC-202, AC-207, AC-218, and the §3.2 coordinate tables.
//
// AC-207 exists because Math.hypot and Math.cbrt are not required to be bit-identical across
// JavaScript engines: diagLen is a table literal in the engine, and this is the offline
// reference derivation that stops the table drifting from the drawing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BANDS, GEN_SALT, K_CTRL_DEN, K_CTRL_NUM, MAX_ATTEMPTS, MLU, ENTRY_LEN } from '../src/engine/constants.js';
import { assertIntegerGeometry, colWFor, finalise, generate, rowHFor, tryBuild, xOf, yOf } from '../src/engine/generate.js';
import { makeStream, mix32 } from '../src/engine/rng.js';

/** generation.md §3.3 reference derivation: 128-step chord sum of the cubic, rounded. */
function referenceDiagLen(colW, rowH, steps = 128) {
  const k = K_CTRL_NUM / K_CTRL_DEN;
  const px = [0, 0, colW, colW];
  const py = [0, k * rowH, rowH - k * rowH, rowH];
  const at = (t) => {
    const u = 1 - t;
    const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    let x = 0;
    let y = 0;
    for (let i = 0; i < 4; i += 1) { x += b[i] * px[i]; y += b[i] * py[i]; }
    return [x, y];
  };
  let sum = 0;
  let prev = at(0);
  for (let i = 1; i <= steps; i += 1) {
    const cur = at(i / steps);
    sum += Math.sqrt((cur[0] - prev[0]) ** 2 + (cur[1] - prev[1]) ** 2);
    prev = cur;
  }
  return Math.round(sum);
}

test('AC-207 · the diagLen table reproduces the reference derivation', () => {
  const expected = [null, 521, 415, 415, 323, 293];
  for (let band = 1; band <= 5; band += 1) {
    const P = BANDS[band];
    assert.equal(referenceDiagLen(P.colW, P.rowH), expected[band], 'band ' + band);
    assert.equal(P.diagLen, expected[band], 'band ' + band + ' table literal');
  }
  // The derivation is stable under refinement, so 128 steps is not an accident of sampling.
  for (let band = 1; band <= 5; band += 1) {
    const P = BANDS[band];
    assert.equal(referenceDiagLen(P.colW, P.rowH, 4096), expected[band]);
  }
});

test('AC-207 · every edge length is 1000x its shape’s table value', () => {
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 31, band);
    for (const e of level.edges) {
      const want = e.shape === 'entry' ? ENTRY_LEN : e.shape === 'straight' ? level.rowH : level.diagLen;
      assert.equal(e.lengthMlu, want * MLU, 'band ' + band + ' shape ' + e.shape);
    }
  }
});

test('§3.2 · colW, rowH and the coordinate tables are exact integers', () => {
  assert.equal(colWFor(3), 300);
  assert.equal(colWFor(4), 260);
  assert.equal(colWFor(5), 195);
  assert.equal(rowHFor(3), 400);
  assert.equal(rowHFor(4), 300);
  assert.equal(rowHFor(5), 240);
  assert.equal(rowHFor(6), 200);
  assert.deepEqual([0, 1, 2].map((c) => xOf(c, 3, 300)), [200, 500, 800]);
  assert.deepEqual([0, 1, 2, 3].map((c) => xOf(c, 4, 260)), [110, 370, 630, 890]);
  assert.deepEqual([0, 1, 2, 3, 4].map((c) => xOf(c, 5, 195)), [110, 305, 500, 695, 890]);
  assert.deepEqual([0, 1, 2, 3].map((r) => yOf(r, 400)), [160, 560, 960, 1360]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((r) => yOf(r, 200)), [160, 360, 560, 760, 960, 1160, 1360]);
});

test('AC-202 · band parameters reach the level object unchanged', () => {
  for (let band = 1; band <= 5; band += 1) {
    const P = BANDS[band];
    const level = generate(1234 + band, band);
    for (const k of ['C', 'K', 'R', 'colW', 'rowH', 'diagLen', 'speedMluPerTick', 'interval', 'jitter', 'quota']) {
      assert.equal(level[k], P[k], 'band ' + band + ' ' + k);
    }
    assert.equal(level.band, band);
  }
});

test('AC-218 · every coordinate and length is an integer', () => {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < 50; seed += 1) {
      const level = generate(seed, band);
      for (const n of level.nodes) {
        assert.ok(Number.isInteger(n.x) && Number.isInteger(n.y), 'node ' + n.id);
      }
      for (const e of level.edges) assert.ok(Number.isInteger(e.lengthMlu));
      for (const s of level.spawns) assert.ok(Number.isInteger(s.tick) && Number.isInteger(s.colour));
    }
  }
});

test('AC-218 · a band table that divides unevenly is REJECTED at level construction', () => {
  // development-process.md §6.2: AC-218 above cannot fail, because §3.2's divisions happen to
  // be exact for every (C, R) in today's table. Nothing asserted that they stay exact. With
  // R = 7, `rowH = 1200 / 7` is 171.43 and generate() used to return a level with float node
  // y values, float lengthMlu and a car carrying a float `progress` into the simulation.
  const P = { ...BANDS[1], R: 7, Jmin: 0, Jmax: 99, Dmin: 0, Dmax: 99 };
  const rng = makeStream(mix32(7, GEN_SALT));
  let net = null;
  for (let i = 0; i < MAX_ATTEMPTS && net === null; i += 1) net = tryBuild(rng, P);
  assert.ok(net, 'the R=7 candidate builder produced a network to finalise');
  assert.throws(() => finalise(net, P, 7), /NON_INTEGER_GEOMETRY/);

  // And the guard is not vacuous: the real band table passes it.
  for (let band = 1; band <= 5; band += 1) assertIntegerGeometry(generate(band, band));
});
