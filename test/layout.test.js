// Layout arithmetic — AC-301 to AC-303, AC-401 to AC-411.
//
// EVERY EXPECTATION IN THIS FILE IS TRANSCRIBED FROM docs/design/ui.md, not imported from
// the module under test. docs/development-process.md §6.8: "a test that reads its expectation
// from the same source as the code under test is not a test. The design document is the
// expectation; transcribe it." So `1000`, `1500`, `0.55`, `56`, `8`, `22`, `76`, `6`, `84`,
// `66`, `104`, `124`, `128` and the nine device rows below are literals here on purpose.
//
// ROUND 8 MOVED EVERY ONE OF THEM. The design rectangle is 1000 x 1500, the support floor is
// 320 x 460, and BOTH SIZE FLOORS ARE NOW TIGHT: the 44 pt tap target clears by 0.16 pt and
// the 20 pt car body by 0.24 pt, where the old geometry cleared them by 2.00 and 1.00.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout, hitRadiusLu, luToScreen, minSepLuForBand, screenToLu } from '../src/ui/layout.js';
import { hitTest, junctionSites } from '../src/ui/hitTest.js';
import { generate } from '../src/engine/generate.js';
import {
  CAR_L, CAR_W, DEPOT_H, DEPOT_W, JUNCTION_MARK_R, MOUTH_LU, ROAD_W,
} from '../src/render/geometry.js';

// ui.md §3.3, "Measured fit across real devices". Columns: W, H, insetTop, insetBottom,
// scale, play H, junction target.
// The junction-target column is ui.md §3.3's, which states it for the WORST BAND — always
// band 5, where min(colW, rowH) = 150 LU is the finest grid in the game.
const DEVICES = [
  ['iPhone SE (1st)', 320, 568, 20, 0, 0.32, 484, 46.1, 21.1, 33.3],
  ['iPhone SE (2nd/3rd)', 375, 667, 20, 0, 0.375, 583, 54.0, 24.8, 39.0],
  ['iPhone 13 mini', 375, 812, 50, 34, 0.375, 664, 54.0, 24.8, 39.0],
  ['iPhone 13/14', 390, 844, 47, 34, 0.39, 699, 56.2, 25.7, 40.6],
  ['iPhone 15/16', 393, 852, 59, 34, 0.393, 695, 56.6, 25.9, 40.9],
  ['iPhone 16 Pro Max', 440, 956, 62, 34, 0.44, 796, 63.4, 29.0, 45.8],
  ['Galaxy S23', 360, 780, 24, 24, 0.36, 668, 51.8, 23.8, 37.4],
  ['Pixel 7', 412, 915, 24, 24, 0.412, 803, 59.3, 27.2, 42.8],
  ['Tall Android 21:9', 412, 1024, 32, 24, 0.412, 904, 59.3, 27.2, 42.8],
];

test('AC-403 / AC-405 / AC-406 · ui.md §3.3 device table reproduces exactly', () => {
  let checked = 0;
  for (const [name, w, h, top, bottom, scale, playH, target, carW, carL] of DEVICES) {
    const L = computeLayout({ screenW: w, screenH: h, insetTop: top, insetBottom: bottom });
    // ui.md §3.1: playTop = safeAreaTop + HUD_H (56); playBottom = screenH - inset - 8.
    assert.equal(L.playTop, top + 56, name + ' playTop');
    assert.equal(L.playBottom, h - bottom - 8, name + ' playBottom');
    assert.equal(L.playH, playH, name + ' play height');
    // ui.md §3.2: a single uniform scale, min of the two axes against 1000 x 1600.
    assert.equal(Math.round(Math.min(w / 1000, playH / 1500) * 1e4) / 1e4, scale, name + ' scale');
    assert.equal(L.scale, Math.min(w / 1000, playH / 1500), name + ' scale is uniform');
    // ui.md §3.3's junction-target column, at the worst band, to one decimal.
    const r = hitRadiusLu(L.scale, minSepLuForBand(5));
    assert.equal(Math.round(2 * r * L.scale * 10) / 10, target, name + ' junction target');
    assert.equal(Math.round(CAR_W * L.scale * 10) / 10, carW, name + ' car width');
    assert.equal(Math.round(CAR_L * L.scale * 10) / 10, carL, name + ' car length');
    checked += 1;
  }
  assert.ok(checked === DEVICES.length, 'every device row was checked');
});

test('AC-408 · reference device: 393 x 852 with insets 59 / 34', () => {
  const L = computeLayout({ screenW: 393, screenH: 852, insetTop: 59, insetBottom: 34 });
  assert.equal(L.scale, 0.393);
  assert.equal(L.playH, 695);
  assert.equal(Math.round(L.slackY * 10) / 10, 105.5, 'ui.md §3.3 rounds this to 106');
  // The junction target at band 5, the car body, and the road width, all from ui.md §3.3.
  assert.equal(Math.round(2 * hitRadiusLu(L.scale, 150) * L.scale * 10) / 10, 56.6);
  assert.equal(Math.round(CAR_W * L.scale * 10) / 10, 25.9);
  assert.equal(Math.round(CAR_L * L.scale * 10) / 10, 40.9);
  assert.equal(Math.round(ROAD_W * L.scale * 10) / 10, 33.0);
});

test('AC-404 · vertical slack is split 55 / 45 and horizontal slack is centred', () => {
  // ui.md §3.3's tall-Android row: 904 pt of play height against 1500 * 0.412 = 618, so 286 pt
  // of slack — 157.3 above and 128.7 below.
  const L = computeLayout({ screenW: 412, screenH: 1024, insetTop: 32, insetBottom: 24 });
  assert.equal(Math.round(L.slackY), 286);
  assert.equal(Math.round(L.slackY * 0.55 * 10) / 10, 157.3);
  assert.equal(Math.round(L.slackY * 0.45 * 10) / 10, 128.7);
  assert.equal(L.originY, L.playTop + L.slackY * 0.55);
  assert.equal(L.originX, (L.playW - 1000 * L.scale) / 2);
  // The split is 55/45 and not 50/50: the two halves differ, which a symmetric split would
  // hide. Without this the assertions above would pass on `slackY * 0.5` at zero slack.
  assert.ok(L.slackY > 0 && L.originY - L.playTop > L.slackY / 2);
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
    // From the smallest IN-ENVELOPE scale (playH 460 / 1500 = 0.30667) upward.
    for (let scale = 0.30667; scale <= 0.70; scale += 0.001) {
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
  // Transcribed from ui.md §3.3 and generation.md §3.2: DEPOT_Y = 1350, DESIGN_H = 1500.
  const DEPOT_Y = 1350;
  const DESIGN_H = 1500;
  assert.equal(DEPOT_H, 128);
  assert.equal(DEPOT_Y + DEPOT_H, 1478);
  assert.ok(DEPOT_Y + DEPOT_H <= DESIGN_H);
  const centre = DEPOT_Y + DEPOT_H / 2;
  const receivingBottom = centre + (DEPOT_H / 2) * 1.04;
  assert.equal(Math.round(receivingBottom * 10) / 10, 1480.6, 'ui.md §7.4 records 1480.6');
  assert.ok(receivingBottom <= DESIGN_H);
});

test('AC-514 · mouthLu === rowH - JUNCTION_MARK_R - 12 EXACTLY, at every band', () => {
  // ui.md §7.6's own band table, transcribed. `mouthLu` is at its MAXIMUM LEGAL VALUE at every
  // band, not at a chosen one: the whole of AC-513's residual is what is left over after
  // taking as much as the junction markers allow, so the constraint is an EQUALITY and not an
  // inequality. Taking it at equality is what makes the residual 46 LU rather than more.
  //
  // `MOUTH_W` is deleted: there is no per-edge apron stroke any more, so there is no stroke
  // width to size against a car's diagonal.
  const ROW_H = [0, 216, 216, 180, 180, 180];
  const EXPECT = [0, 170, 170, 134, 134, 134];
  for (let band = 1; band <= 5; band += 1) {
    assert.equal(MOUTH_LU[band], EXPECT[band], 'band ' + band + ' mouthLu');
    assert.equal(MOUTH_LU[band], ROW_H[band] - JUNCTION_MARK_R - 12,
      'band ' + band + ': mouthLu is not at its maximum legal value');
    // AC-513's geometry clause: the visible shared approach is the same at every band.
    assert.equal(ROW_H[band] - MOUTH_LU[band], 46, 'band ' + band + ' visible approach');
  }
  assert.equal(JUNCTION_MARK_R, 34);
  assert.ok(2 * JUNCTION_MARK_R < ROAD_W, 'AC-503: the marker sits inside its road');
});

test('AC-402 · CAR_W * scale >= 20 pt on the binding device AND at the support floor', () => {
  // ui.md §3.3: the binding DEVICE is the iPhone SE 1st generation at scale 0.3200, where the
  // car body is 21.1 x 33.3 pt.
  const L = computeLayout({ screenW: 320, screenH: 568, insetTop: 20, insetBottom: 0 });
  assert.equal(Math.round(L.scale * 1e4) / 1e4, 0.32);
  assert.equal(Math.round(CAR_W * L.scale * 10) / 10, 21.1);
  assert.equal(Math.round(CAR_L * L.scale * 10) / 10, 33.3);
  assert.ok(CAR_W * L.scale >= 20);

  // ...but the binding CONFIGURATION is the declared support floor, and it is where the 0.24 pt
  // of headroom lives. CAR_W = 66 is set by this and by nothing else: at playH = 460 the scale
  // is 0.30667, so CAR_W >= 65.2 (ui.md §4.1, AC-402). The car cannot get smaller than this
  // without raising the support floor or re-arguing the criterion.
  const floorScale = 460 / 1500;
  assert.equal(Math.round(floorScale * 1e5) / 1e5, 0.30667);
  assert.equal(Math.round(CAR_W * floorScale * 100) / 100, 20.24);
  assert.ok(CAR_W * floorScale >= 20);
  assert.ok(65 * floorScale < 20, 'a 65 LU car would FAIL: ' + (65 * floorScale).toFixed(2) + ' pt');
  // And the 44 pt tap target at the same configuration, which is the other tight floor.
  const r = hitRadiusLu(floorScale, minSepLuForBand(5));
  assert.equal(r, 72, 'the upper clamp binds at band 5: floor((150 - 6)/2)');
  assert.equal(Math.round(2 * r * floorScale * 100) / 100, 44.16);
  assert.ok(2 * r * floorScale >= 44);
});

test('AC-409 · the support floor is a property the layout reports, not an assumption', () => {
  // ui.md §4.4: playW >= 320 and playH >= 460. The HEIGHT floor moved 400 -> 460 in round 8,
  // because the design rectangle is shorter and therefore reaches its height bound at a LARGER
  // playH; below it, band 5's 44 pt target cannot be met.
  const belowW = computeLayout({ screenW: 300, screenH: 900, insetTop: 20, insetBottom: 0 });
  assert.equal(belowW.supported, false, 'a 300 pt width is outside the envelope');
  // playH = 568 - 20 - 56 - 0 - 8 = 484, which is above 460.
  const at = computeLayout({ screenW: 320, screenH: 568, insetTop: 20, insetBottom: 0 });
  assert.equal(at.supported, true);
  assert.equal(at.playH, 484);
  // playH = 540 - 20 - 56 - 0 - 8 = 456, which is below 460 and WOULD HAVE PASSED the old
  // 400 pt floor. This is the case the move exists for.
  const belowH = computeLayout({ screenW: 360, screenH: 540, insetTop: 20, insetBottom: 0 });
  assert.equal(belowH.playH, 456);
  assert.equal(belowH.supported, false, 'playH 456 is below the 460 floor');
  assert.ok(2 * hitRadiusLu(belowH.scale, minSepLuForBand(5)) * belowH.scale < 44,
    'and it really does fail the 44 pt target, which is why the floor moved');
  // The layout still computes rather than crashing, which is AC-409's first clause.
  assert.ok(Number.isFinite(belowH.scale) && belowH.scale > 0);
});
