// Geometry ACs — AC-202, AC-207, AC-218, and the §3.2 coordinate tables.
//
// AC-207 exists because Math.hypot and Math.cbrt are not required to be bit-identical across
// JavaScript engines: diagLen is a table literal in the engine, and this is the offline
// reference derivation that stops the table drifting from the drawing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BANDS, DEPOT_Y, DESIGN_H, ENTRY_LEN, GEN_SALT, K_CTRL_DEN, K_CTRL_NUM,
  MAX_ATTEMPTS, MLU, ROW0_Y,
} from '../src/engine/constants.js';
import {
  assertIntegerGeometry, colWFor, finalise, generate, rowHFor, signature, tryBuild, xOf, yOf,
} from '../src/engine/generate.js';
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
  // generation.md §3.2's row-y table, after slice 1b's 60 LU translation. Row 0 is ROW0_Y =
  // 220 and the depot row is DEPOT_Y = 1420; the SPACING between rows is untouched, which is
  // the whole point of translating rather than rescaling.
  assert.deepEqual([0, 1, 2, 3].map((r) => yOf(r, 400)), [220, 620, 1020, 1420]);
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => yOf(r, 300)), [220, 520, 820, 1120, 1420]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((r) => yOf(r, 240)), [220, 460, 700, 940, 1180, 1420]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((r) => yOf(r, 200)), [220, 420, 620, 820, 1020, 1220, 1420]);
  assert.equal(ROW0_Y, 220);
  assert.equal(DEPOT_Y, 1420);
  assert.equal(ENTRY_LEN, 160, 'gameplay.md §4.6b: the entry road holds a decision');
  assert.equal(DEPOT_Y - ROW0_Y, 1200, 'the route height did not move');
});

// generation.md §6.1, transcribed. AC-202 says the level's parameters must match ROW b OF THE
// DESIGN TABLE, and the loop below only ever compared the level against BANDS — so a band-table
// edit satisfied it by construction and the AC asserted nothing about the design. `interval` and
// `quota` are the two columns round 6 moved and they are the two a future lever pull will move
// again; this is what makes that edit a deliberate act rather than a silent one.
const DESIGN_6_1 = {
  1: { C: 3, K: 3, R: 3, pBranchPct: 85, Jmin: 3, Jmax: 3, Ja: 3, Dmin: 2, Dmax: 2, rowH: 400, colW: 300, diagLen: 521, speedMluPerTick: 3000, interval: 156, jitter: 12, quota: 16 },
  2: { C: 4, K: 3, R: 4, pBranchPct: 70, Jmin: 3, Jmax: 5, Ja: 3, Dmin: 2, Dmax: 3, rowH: 300, colW: 260, diagLen: 415, speedMluPerTick: 3200, interval: 108, jitter: 12, quota: 33 },
  3: { C: 4, K: 4, R: 4, pBranchPct: 80, Jmin: 4, Jmax: 6, Ja: 4, Dmin: 2, Dmax: 3, rowH: 300, colW: 260, diagLen: 415, speedMluPerTick: 3400, interval: 106, jitter: 18, quota: 41 },
  4: { C: 5, K: 4, R: 5, pBranchPct: 80, Jmin: 5, Jmax: 7, Ja: 5, Dmin: 2, Dmax: 4, rowH: 240, colW: 195, diagLen: 323, speedMluPerTick: 3600, interval: 110, jitter: 18, quota: 47 },
  5: { C: 5, K: 5, R: 6, pBranchPct: 88, Jmin: 7, Jmax: 8, Ja: 7, Dmin: 2, Dmax: 4, rowH: 200, colW: 195, diagLen: 293, speedMluPerTick: 3800, interval: 120, jitter: 18, quota: 51 },
};

test('AC-202 · the band table IS generation.md §6.1, and reaches the level unchanged', () => {
  let checked = 0;
  for (let band = 1; band <= 5; band += 1) {
    const P = BANDS[band];
    for (const [k, v] of Object.entries(DESIGN_6_1[band])) {
      assert.equal(P[k], v, 'BANDS[' + band + '].' + k + ' is not generation.md §6.1\'s value');
      checked += 1;
    }
    const level = generate(1234 + band, band);
    for (const k of ['C', 'K', 'R', 'colW', 'rowH', 'diagLen', 'speedMluPerTick', 'interval', 'jitter', 'quota']) {
      assert.equal(level[k], P[k], 'band ' + band + ' ' + k);
    }
    assert.equal(level.band, band);
  }
  assert.equal(checked, 80, 'a column was dropped from the §6.1 transcription');
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

// ui.md §4.1's depot constants. They are RENDER constants and deliberately do not live in
// src/engine — the engine does not draw. They are restated here because AC-411 is arithmetic
// over them and the design rectangle, and that arithmetic is checkable now; they move to
// src/render/ when slice 2 builds it.
const DEPOT_H = 170;
const DEPOT_RECEIVING_SCALE_NUM = 104; // ui.md §7.4: body scales 1.00 -> 1.04 -> 1.00
const DEPOT_RECEIVING_SCALE_DEN = 100;

test('AC-411 · the depot row stays inside the design rect, at rest and while receiving', () => {
  // The 60 LU that AC-245 needed came out of the blank margin below the depot row, which was
  // 70 LU and is now 10. This is the check that makes the next attempt to spend it fail.
  assert.equal(DEPOT_Y + DEPOT_H, 1590);
  assert.ok(DEPOT_Y + DEPOT_H <= DESIGN_H, 'depot body bottom ' + (DEPOT_Y + DEPOT_H));

  // The body scales about its own centre, so the receiving pulse reaches further than rest.
  const centre = DEPOT_Y + DEPOT_H / 2;
  const half = (DEPOT_H / 2) * (DEPOT_RECEIVING_SCALE_NUM / DEPOT_RECEIVING_SCALE_DEN);
  assert.equal(Number((centre + half).toFixed(1)), 1593.4, 'ui.md §3.3 states 1593.4');
  assert.ok(centre - half >= 0 && centre + half <= DESIGN_H, 'receiving pulse leaves the rect');

  // Every band's depot row is the same y, so this holds for all five; assert it rather than
  // reason about it, because the depot row is the one row a band cannot move.
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(band * 7, band);
    for (const n of level.nodes) {
      if (n.kind !== 'depot') continue;
      assert.equal(n.y, DEPOT_Y, 'band ' + band + ' depot y');
      assert.ok(n.y + DEPOT_H <= DESIGN_H);
    }
  }

  // The clearance is 10 LU and nothing but a layout change may spend it again.
  assert.equal(DESIGN_H - (DEPOT_Y + DEPOT_H), 10);
});

/**
 * generation.md §3.2 claims the 60 LU translation leaves every generated topology alone:
 * "the same 2,500 seeds produce byte-identical network signatures before and after". That is
 * a claim about code that no longer exists, so it is pinned here as a digest instead of being
 * assumed. Measured at commit 556eb62 (ROW0_Y = 160, DEPOT_Y = 1360, no V13) over the same
 * 2,500 levels, the five digests were:
 *
 *   d73cb7133440fdd1 2d656527b6c70ad4 4b135fbc4586d517 47edaaec9f31b315 4d3c04cede465a26
 *
 * Bands 1 and 2 below are those values unchanged, across BOTH the translation and V13 —
 * which is generation.md §6.2's "bands 1 and 2 come out bit-identical" made executable, and
 * it is the band with the smallest network space in the game (37 edge topologies) that a
 * stricter rule would have broken first. Bands 3, 4 and 5 differ from the list above for one
 * reason only: V13 rejects candidates the old generator accepted. The translation itself was
 * separately measured to change nothing at any band — all 2,500 levels compare deeply equal
 * once `y` is shifted back 60 and the entry edge back to 100 LU.
 *
 * A change here means a topology moved. That is either a deliberate generator change, in
 * which case these are re-measured and the reason recorded, or a defect.
 */
test('§3.2 · the 60 LU translation and V13 change no topology that is not V13’s', () => {
  const expected = [
    null,
    'd73cb7133440fdd1', // band 1 — unchanged since before the translation
    '2d656527b6c70ad4', // band 2 — unchanged since before the translation
    '4300e3e1ddc08016', // band 3 — V13 only
    '865231bacfa6cf2d', // band 4 — V13 only
    'd95529a640a80a0c', // band 5 — V13 only
  ];
  for (let band = 1; band <= 5; band += 1) {
    const h = createHash('sha256');
    for (let seed = 0; seed < 500; seed += 1) h.update(signature(generate(seed, band)) + '\n');
    assert.equal(h.digest('hex').slice(0, 16), expected[band], 'band ' + band + ' network population moved');
  }
});
