// Geometry — the design rectangle's vertical budget (AC-411), and the pin on the generated
// network population.
//
// AC-202, AC-207 and AC-218 moved to test/generator.test.js in round 8, because the three of
// them now read the same level objects that file already builds. What is left here is the
// arithmetic that is about the RECTANGLE rather than about a level, plus the digest that says
// no topology moved without someone meaning it to.
//
// THE 128-STEP CHORD-SUM REFERENCE DERIVATION IS DELETED. It existed because `Math.hypot` is
// not required to be bit-identical across JavaScript engines, so a per-band `diagLen` table
// literal was the only safe way to carry a cubic's arc length and this file was what stopped
// the table drifting from the drawing. Orthogonal roads removed the hazard: an edge's length
// is `|Δx| + |Δy|`, two subtractions and an addition, the same integer everywhere
// (generation.md §3.3). AC-207 asserts the identity directly now.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DEPOT_Y, DESIGN_H, DESIGN_W, ENTRY_LEN, ENTRY_Y, ROUTE_H, ROW0_Y,
} from '../src/engine/constants.js';
import { generate, signature } from '../src/engine/generate.js';

// ui.md §4.1's depot constants, TRANSCRIBED. They are render constants and deliberately do
// not live in src/engine — the engine does not draw — and AC-411 is arithmetic over them and
// the design rectangle.
const DEPOT_H = 128;
const DEPOT_RECEIVING_SCALE_NUM = 104; // ui.md §7.4: body scales 1.00 -> 1.04 -> 1.00
const DEPOT_RECEIVING_SCALE_DEN = 100;

test('generation.md §3.2 · the vertical budget adds up to DESIGN_H exactly', () => {
  // ENTRY_Y + ENTRY_LEN + ROUTE_H + DEPOT_H + margin = 50 + 220 + 1080 + 128 + 22 = 1500.
  assert.equal(DESIGN_W, 1000);
  assert.equal(DESIGN_H, 1500);
  assert.equal(ENTRY_Y, 50);
  assert.equal(ENTRY_LEN, 220);
  assert.equal(ROW0_Y, 270);
  assert.equal(ROUTE_H, 1080);
  assert.equal(DEPOT_Y, 1350);
  assert.equal(DEPOT_Y - ROW0_Y, ROUTE_H, 'ROUTE_H is the route height, the same at every band');
  assert.equal(ENTRY_Y + ENTRY_LEN + ROUTE_H + DEPOT_H + 22, DESIGN_H);
  // ROUTE_H must stay divisible by every R the band table uses, or AC-218 throws.
  for (const R of [5, 6]) assert.equal(ROUTE_H % R, 0, 'ROUTE_H is not divisible by R = ' + R);
  assert.equal(ROUTE_H / 5, 216);
  assert.equal(ROUTE_H / 6, 180);
});

test('AC-411 · the depot row stays inside the design rect, at rest and while receiving', () => {
  assert.equal(DEPOT_Y + DEPOT_H, 1478);
  assert.ok(DEPOT_Y + DEPOT_H <= DESIGN_H, 'depot body bottom ' + (DEPOT_Y + DEPOT_H));

  // The body scales about its own centre, so the receiving pulse reaches further than rest.
  const centre = DEPOT_Y + DEPOT_H / 2;
  const half = (DEPOT_H / 2) * (DEPOT_RECEIVING_SCALE_NUM / DEPOT_RECEIVING_SCALE_DEN);
  assert.equal(Number((centre + half).toFixed(1)), 1480.6, 'ui.md §7.4 states 1480.6');
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

  // The design margin is 22 LU. Slice 1b spent this down to 10 to buy 60 LU of ENTRY_LEN;
  // re-laying the rectangle in round 8 gave it back, and it is still not free twice.
  assert.equal(DESIGN_H - (DEPOT_Y + DEPOT_H), 22);
});

/**
 * A PIN ON THE GENERATED NETWORK POPULATION. Round 8 replaced the cubic edge model with
 * orthogonal routing, added rule (P) and V14, and moved every band's geometry, so every one of
 * these digests is new — the slice-1 values (`d73cb713…`, `2d656527…`, …) are gone and there is
 * no continuity to claim across the change.
 *
 * What the pin is for is the NEXT change. A digest that moves means a topology moved: either a
 * deliberate generator change, in which case these are re-measured and the reason recorded, or
 * a defect. It is the cheapest check in the suite and it is the only one that notices a
 * generator change nothing else is looking at.
 */
test('§4 · the generated network population is pinned', () => {
  const expected = [
    null,
    '936208e906a34322', // band 1 — C 3, R 5, rule (P) + V14
    '773bfb48a9ba2097', // band 2 — C 4, R 5
    'b59df50a69d00ae8', // band 3 — C 4, R 6
    '8faf828d80ae459d', // band 4 — C 5, R 6
    'c881f704d3c9abd1', // band 5 — C 6, R 6
  ];
  for (let band = 1; band <= 5; band += 1) {
    const h = createHash('sha256');
    for (let seed = 0; seed < 500; seed += 1) h.update(signature(generate(seed, band)) + '\n');
    assert.equal(h.digest('hex').slice(0, 16), expected[band], 'band ' + band + ' network population moved');
  }
});
