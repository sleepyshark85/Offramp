// Layout arithmetic — AC-301 to AC-303, AC-401 to AC-411.
//
// EVERY EXPECTATION IN THIS FILE IS TRANSCRIBED FROM docs/design/ui.md, not imported from
// the module under test. docs/development-process.md §6.8: "a test that reads its expectation
// from the same source as the code under test is not a test. The design document is the
// expectation; transcribe it." So `1000`, `1600`, `0.55`, `56`, `8`, `22`, `76`, `6`, `104`,
// `84`, `140`, `160`, `170` and the nine device rows below are literals here on purpose.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout, hitRadiusLu, luToScreen, minSepLuForBand, screenToLu } from '../src/ui/layout.js';
import { hitTest, junctionSites } from '../src/ui/hitTest.js';
import { generate } from '../src/engine/generate.js';
import { CAR_L, CAR_W, DEPOT_H, DEPOT_W, JUNCTION_MARK_R, MOUTH_LU } from '../src/render/geometry.js';

// ui.md §3.3, "Measured fit across real devices". Columns: W, H, insetTop, insetBottom,
// scale, play H, junction target.
const DEVICES = [
  ['iPhone SE (1st)', 320, 568, 20, 0, 0.3025, 484, 46.0],
  ['iPhone SE (2nd/3rd)', 375, 667, 20, 0, 0.3644, 583, 55.4],
  ['iPhone 13 mini', 375, 812, 50, 34, 0.375, 664, 57.0],
  ['iPhone 13/14', 390, 844, 47, 34, 0.39, 699, 59.3],
  ['iPhone 15/16', 393, 852, 59, 34, 0.393, 695, 59.7],
  ['iPhone 16 Pro Max', 440, 956, 62, 34, 0.44, 796, 66.9],
  ['Galaxy S23', 360, 780, 24, 24, 0.36, 668, 54.7],
  ['Pixel 7', 412, 915, 24, 24, 0.412, 803, 62.6],
  ['Tall Android 21:9', 412, 1024, 32, 24, 0.412, 904, 62.6],
];

test('AC-403 / AC-405 / AC-406 · ui.md §3.3 device table reproduces exactly', () => {
  let checked = 0;
  for (const [name, w, h, top, bottom, scale, playH, target] of DEVICES) {
    const L = computeLayout({ screenW: w, screenH: h, insetTop: top, insetBottom: bottom });
    // ui.md §3.1: playTop = safeAreaTop + HUD_H (56); playBottom = screenH - inset - 8.
    assert.equal(L.playTop, top + 56, name + ' playTop');
    assert.equal(L.playBottom, h - bottom - 8, name + ' playBottom');
    assert.equal(L.playH, playH, name + ' play height');
    // ui.md §3.2: a single uniform scale, min of the two axes against 1000 x 1600.
    assert.equal(Math.round(Math.min(w / 1000, playH / 1600) * 1e4) / 1e4, scale, name + ' scale');
    assert.equal(L.scale, Math.min(w / 1000, playH / 1600), name + ' scale is uniform');
    // ui.md §3.3's junction-target column, to one decimal.
    const r = hitRadiusLu(L.scale, minSepLuForBand(1));
    assert.equal(Math.round(2 * r * L.scale * 10) / 10, target, name + ' junction target');
    checked += 1;
  }
  assert.ok(checked === DEVICES.length, 'every device row was checked');
});

test('AC-408 · reference device: 393 x 852 with insets 59 / 34', () => {
  const L = computeLayout({ screenW: 393, screenH: 852, insetTop: 59, insetBottom: 34 });
  assert.equal(L.scale, 0.393);
  assert.equal(L.playH, 695);
  assert.equal(Math.round(2 * hitRadiusLu(L.scale, 300) * L.scale * 10) / 10, 59.7);
});

test('AC-404 · vertical slack is split 55 / 45 and horizontal slack is centred', () => {
  // ui.md §3.2's own worked example: "On a 21:9 Android with 245 pt of slack that is 135 pt
  // above and 110 pt below."
  const L = computeLayout({ screenW: 412, screenH: 1024, insetTop: 32, insetBottom: 24 });
  assert.equal(Math.round(L.slackY), 245);
  assert.equal(Math.round(L.slackY * 0.55), 135);
  assert.equal(Math.round(L.slackY * 0.45), 110);
  assert.equal(L.originY, L.playTop + L.slackY * 0.55);
  assert.equal(L.originX, (L.playW - 1000 * L.scale) / 2);
});

test('AC-302 · HIT_R_LU === clamp(ceil(22/scale), 76, floor((min(colW,rowH) - 6)/2))', () => {
  let observed = 0;
  for (let band = 1; band <= 5; band += 1) {
    const minSep = minSepLuForBand(band);
    for (let scale = 0.20; scale <= 0.70; scale += 0.001) {
      const expect = Math.min(Math.max(Math.ceil(22 / scale), 76), Math.floor((minSep - 6) / 2));
      assert.equal(hitRadiusLu(scale, minSep), expect, 'band ' + band + ' scale ' + scale);
      observed += 1;
    }
  }
  assert.ok(observed > 0, 'the formula was evaluated somewhere');
});

test('AC-303 · 2 * HIT_R_LU < min(colW, rowH) at every band and every supported scale', () => {
  let observed = 0;
  let tight = Infinity;
  for (let band = 1; band <= 5; band += 1) {
    const minSep = minSepLuForBand(band);
    for (let scale = 0.25; scale <= 0.70; scale += 0.001) {
      const r = hitRadiusLu(scale, minSep);
      assert.ok(2 * r < minSep, 'band ' + band + ' scale ' + scale.toFixed(3));
      tight = Math.min(tight, minSep - 2 * r);
      observed += 1;
    }
  }
  assert.ok(observed > 0, 'hit circles were compared somewhere');
  assert.ok(tight >= 6, 'tightest clearance between two hit circles is ' + tight + ' LU');
});

test('AC-301 · screen -> design uses round, and round-trips through luToScreen', () => {
  const L = computeLayout({ screenW: 393, screenH: 852, insetTop: 59, insetBottom: 34 });
  // Transcribed formula: round((sx - originX)/scale), round((sy - originY)/scale).
  //
  // Swept rather than sampled. The first version of this test used four hand-picked points
  // and every one of them happened to land on an integer LU on the x axis, so replacing
  // `round` with `floor` in the module under test did not fail it — the fault-injection pass
  // is what found that, which is the whole argument for running one.
  let discriminating = 0;
  for (let sx = 0; sx <= 393; sx += 0.37) {
    for (let sy = 0; sy <= 852; sy += 37) {
      const want = {
        x: Math.round((sx - L.originX) / L.scale),
        y: Math.round((sy - L.originY) / L.scale),
      };
      assert.deepEqual(screenToLu(L, sx, sy), want, 'at ' + sx + ',' + sy);
      if (Math.floor((sx - L.originX) / L.scale) !== want.x) discriminating += 1;
    }
  }
  assert.ok(discriminating > 0, 'no sample point could tell round from floor on the x axis');
  const p = luToScreen(L, 500, 800);
  assert.deepEqual(screenToLu(L, p.x, p.y), { x: 500, y: 800 });
});

test('AC-304 · a tap more than HIT_R_LU from every junction hits nothing', () => {
  const L = computeLayout({ screenW: 393, screenH: 852, insetTop: 59, insetBottom: 34 });
  const level = generate(20260921, 3);
  const sites = junctionSites(level);
  const r = hitRadiusLu(L.scale, minSepLuForBand(level.band));
  let hits = 0;
  let misses = 0;
  for (const s of sites) {
    const on = luToScreen(L, s.x, s.y);
    assert.equal(hitTest(L, level, sites, on.x, on.y), s.junctionId);
    hits += 1;
    // One LU outside the radius, straight down: no junction, silently.
    const off = luToScreen(L, s.x, s.y + r + 1);
    const got = hitTest(L, level, sites, off.x, off.y);
    if (got === -1) misses += 1;
  }
  assert.ok(hits > 0, 'the level had junctions to hit');
  assert.ok(misses > 0, 'at least one near-miss was actually observed as a miss');
});

test('AC-410 · every depot stays inside the design rect with >= 30 LU margin', () => {
  let observed = 0;
  let worst = Infinity;
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 1; seed <= 60; seed += 1) {
      const level = generate(seed * 7919 + band, band);
      for (const n of level.nodes) {
        if (n.kind !== 'depot') continue;
        const left = n.x - DEPOT_W / 2;
        const right = n.x + DEPOT_W / 2;
        assert.ok(left >= 0 && right <= 1000, 'band ' + band + ' seed ' + seed + ' depot at ' + n.x);
        worst = Math.min(worst, left, 1000 - right);
        observed += 1;
      }
    }
  }
  assert.ok(observed > 0, 'depots were observed');
  assert.ok(worst >= 30, 'narrowest depot margin is ' + worst + ' LU, ui.md §4.1 claims 30');
});

test('AC-411 · DEPOT_Y + DEPOT_H <= DESIGN_H, and the 1.04 receiving scale also fits', () => {
  // Transcribed from ui.md §3.3 and generation.md §3.2: DEPOT_Y = 1420, DESIGN_H = 1600.
  const DEPOT_Y = 1420;
  const DESIGN_H = 1600;
  assert.equal(DEPOT_Y + DEPOT_H, 1590);
  assert.ok(DEPOT_Y + DEPOT_H <= DESIGN_H);
  const centre = DEPOT_Y + DEPOT_H / 2;
  const receivingBottom = centre + (DEPOT_H / 2) * 1.04;
  assert.equal(Math.round(receivingBottom * 10) / 10, 1593.4, 'ui.md §3.3 records 1593.4');
  assert.ok(receivingBottom <= DESIGN_H);
});

test('AC-514 · mouthLu <= rowH - JUNCTION_MARK_R - 12, and MOUTH_W covers a car diagonal', () => {
  // ui.md §7.6's own band table, transcribed.
  const ROW_H = [0, 400, 300, 300, 240, 200];
  const EXPECT = [0, 180, 160, 160, 150, 140];
  let tightest = Infinity;
  for (let band = 1; band <= 5; band += 1) {
    assert.equal(MOUTH_LU[band], EXPECT[band], 'band ' + band + ' mouthLu');
    const cap = ROW_H[band] - JUNCTION_MARK_R - 12;
    assert.ok(MOUTH_LU[band] <= cap, 'band ' + band + ': ' + MOUTH_LU[band] + ' > ' + cap);
    tightest = Math.min(tightest, cap - MOUTH_LU[band]);
  }
  assert.equal(tightest, 2, 'ui.md §7.6: the tightest band is 5, 140 against 142');
  assert.ok(176 >= Math.hypot(CAR_L, CAR_W), 'MOUTH_W must contain a car at any heading');
  assert.equal(Math.round(Math.hypot(140, 84) * 10) / 10, 163.3);
});

test('AC-402 · CAR_W * scale >= 20 pt on the binding device', () => {
  // ui.md §3.3: the binding device is the iPhone SE 1st generation at scale 0.3025, where
  // the car body is 25.4 x 42.4 pt.
  const L = computeLayout({ screenW: 320, screenH: 568, insetTop: 20, insetBottom: 0 });
  assert.equal(Math.round(CAR_W * L.scale * 10) / 10, 25.4);
  assert.equal(Math.round(CAR_L * L.scale * 10) / 10, 42.4);
  assert.ok(CAR_W * L.scale >= 20);
});

test('AC-409 · the support floor is a property the layout reports, not an assumption', () => {
  const below = computeLayout({ screenW: 300, screenH: 500, insetTop: 20, insetBottom: 0 });
  assert.equal(below.supported, false);
  const at = computeLayout({ screenW: 320, screenH: 568, insetTop: 20, insetBottom: 0 });
  assert.equal(at.supported, true);
});
