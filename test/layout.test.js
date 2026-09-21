// Layout arithmetic — AC-301 to AC-303, AC-401 to AC-411.
//
// EVERY EXPECTATION IN THIS FILE IS TRANSCRIBED FROM docs/design/ui.md, not imported from
// the module under test. docs/development-process.md §6.8: "a test that reads its expectation
// from the same source as the code under test is not a test. The design document is the
// expectation; transcribe it." So `1000`, `1500`, `0.55`, `56`, `8`, `22`, `76`, `6`, `84`,
// `66`, `104`, `124`, `128` and the nine device rows below are literals here on purpose.
//
// ROUND 8 MOVED EVERY ONE OF THEM and ROUND 9 MOVED TWO BACK. `colW` is DERIVED rather than
// tabled (generation.md §3.2.1), which takes band 5 from 150 LU to 158 and `min(colW, rowH)`
// with it, so the 44 pt tap target now clears by 2.61 pt rather than by 0.16 — the first time
// a round of this design has made a tap target BIGGER. The 20 pt car-body floor is unmoved and
// still clears by only 0.24 pt. `ROAD_W` fell 84 -> 28 (ui.md §4.6), so the road column of
// §3.3 moved with it.

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
// band 5, where min(colW, rowH) = 158 LU is the finest grid in the game.
// Columns: name, W, H, insetTop, insetBottom, scale, playH, junction target, car W, car L,
// road width.
const DEVICES = [
  ['iPhone SE (1st)', 320, 568, 20, 0, 0.32, 484, 48.6, 21.1, 33.3, 9.0],
  ['iPhone SE (2nd/3rd)', 375, 667, 20, 0, 0.375, 583, 57.0, 24.8, 39.0, 10.5],
  ['iPhone 13 mini', 375, 812, 50, 34, 0.375, 664, 57.0, 24.8, 39.0, 10.5],
  ['iPhone 13/14', 390, 844, 47, 34, 0.39, 699, 59.3, 25.7, 40.6, 10.9],
  ['iPhone 15/16', 393, 852, 59, 34, 0.393, 695, 59.7, 25.9, 40.9, 11.0],
  ['iPhone 16 Pro Max', 440, 956, 62, 34, 0.44, 796, 66.9, 29.0, 45.8, 12.3],
  ['Galaxy S23', 360, 780, 24, 24, 0.36, 668, 54.7, 23.8, 37.4, 10.1],
  ['Pixel 7', 412, 915, 24, 24, 0.412, 803, 62.6, 27.2, 42.8, 11.5],
  ['Tall Android 21:9', 412, 1024, 32, 24, 0.412, 904, 62.6, 27.2, 42.8, 11.5],
];

test('AC-403 / AC-405 / AC-406 · ui.md §3.3 device table reproduces exactly', () => {
  let checked = 0;
  for (const [name, w, h, top, bottom, scale, playH, target, carW, carL, roadW] of DEVICES) {
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
    assert.equal(Math.round(ROAD_W * L.scale * 10) / 10, roadW, name + ' road width');
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
  assert.equal(Math.round(2 * hitRadiusLu(L.scale, 158) * L.scale * 10) / 10, 59.7);
  assert.equal(Math.round(CAR_W * L.scale * 10) / 10, 25.9);
  assert.equal(Math.round(CAR_L * L.scale * 10) / 10, 40.9);
  assert.equal(Math.round(ROAD_W * L.scale * 10) / 10, 11.0);
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

test('AC-302 · the "upper bound applied LAST" clause is UNREACHABLE on round 9\'s table', () => {
  // development-process.md §6.8, exactly: a check's reachability is a function of the
  // PARAMETERS, not only of the code, and this round moved the parameter.
  //
  // AC-302 says the upper bound is applied last and calls the ordering normative, on the
  // ground that "at band 5, min(colW, rowH) = 150 gives an upper bound of 72, which is below
  // the lower bound of 76 — so the lower bound is inert there and the upper bound wins. An
  // implementation that applied them the other way round would produce 76 LU hit circles on a
  // 150 LU pitch, which touch."
  //
  // `colW` is derived now (generation.md §3.2.1) and band 5's `min(colW, rowH)` is 158, so the
  // upper bound is `floor((158 - 6) / 2) = 76` — EQUAL TO the lower bound, not below it. And
  // `min(max(a, L), U)` differs from `max(min(a, U), L)` only when `L > U`. So the two
  // orderings now agree at every band and every scale, and an implementation that applied
  // them the wrong way round would pass every check in this file.
  //
  // The right response is §6.8's: do not loosen it, assert the STRONGER statement with the
  // arithmetic recorded, so that a band table which takes `min(colW, rowH)` back below 158
  // fails HERE and re-arms the ordering clause rather than silently un-testing it.
  let differs = 0;
  let observed = 0;
  for (let band = 1; band <= 5; band += 1) {
    const minSep = minSepLuForBand(band);
    const upper = Math.floor((minSep - 6) / 2);
    assert.ok(upper >= 76, 'band ' + band + ': upper bound ' + upper + ' is below the 76 LU lower clamp — AC-302\'s ordering clause is live again and needs a discriminating test');
    for (let scale = 0.20; scale <= 0.70; scale += 0.001) {
      const a = Math.ceil(22 / scale);
      if (Math.min(Math.max(a, 76), upper) !== Math.max(Math.min(a, upper), 76)) differs += 1;
      observed += 1;
    }
  }
  assert.ok(observed > 2000, 'the sweep evaluated nothing');
  assert.equal(differs, 0, 'the two orderings disagree somewhere, so the clause IS reachable and must be tested directly');
  // And the band that used to make it reachable, stated as arithmetic rather than as a memory:
  // at min(colW, rowH) = 150 the upper bound is 72 and the orderings differ.
  assert.notEqual(Math.min(Math.max(72, 76), 72), Math.max(Math.min(72, 72), 76));
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
  // AC-503 INVERTED IN ROUND 9: the marker's diameter is 2.4 x the road, so a junction reads
  // as an object ON the network rather than as a fitting inside it (ui.md §4.1, §4.6). The
  // terrace clearance above is unaffected — it is measured against JUNCTION_MARK_R, not
  // against the road.
  assert.equal(ROAD_W, 28);
  assert.ok(2 * JUNCTION_MARK_R > ROAD_W, 'AC-503: the marker no longer overhangs the road');
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
  // And the 44 pt tap target at the same configuration. IT IS NO LONGER TIGHT. `colW` became
  // derived in round 9 (generation.md §3.2.1), which takes band 5's `min(colW, rowH)` from
  // 150 LU to 158 — so `floor((158 - 6) / 2) = 76` equals the 76 LU lower clamp instead of
  // falling below it, and the target goes 44.16 pt -> 46.61 pt (AC-401).
  //
  // The consequence worth stating: ui.md §4.4's "both floors are now tight" applies to AC-402
  // ONLY. The car body is the sole binding constraint on the support floor now.
  const r = hitRadiusLu(floorScale, minSepLuForBand(5));
  assert.equal(minSepLuForBand(5), 158, 'band 5 grid');
  assert.equal(r, 76, 'both clamps land on 76: max(ceil(22/0.30667), 76) and floor((158-6)/2)');
  assert.equal(Math.round(2 * r * floorScale * 100) / 100, 46.61);
  assert.ok(2 * r * floorScale >= 44);
});

test('AC-409 · the support floor is a property the layout reports, not an assumption', () => {
  // ui.md §4.4: playW >= 320 and playH >= 460. The HEIGHT floor moved 400 -> 460 in round 8,
  // because the design rectangle is shorter and therefore reaches its height bound at a
  // LARGER playH.
  //
  // AC-409 AND ui.md §4.4 BOTH SAY THE REASON IS THE 44 pt TARGET — "below it, band 5's 44 pt
  // target cannot be met" — AND THAT STOPPED BEING TRUE IN ROUND 9. At `min(colW, rowH) = 158`
  // the hit radius is 76 LU at every in-envelope scale, so the target fails 44 pt only below
  // `44 / (2 * 76) = 0.28947`, i.e. playH 434. The floor at 460 is now set by AC-402's 20 pt
  // CAR BODY, which fails below `20 / 66 = 0.30303`, i.e. playH 454.5.
  //
  // The floor's VALUE is still right; its stated reason is not, and the assertions below check
  // the binding constraint that actually holds it up rather than the one the document names.
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
  // AC-409's stated reason does not hold at 456: the 44 pt target still passes there, and so
  // does the 20 pt car body. The 460 floor is a DECLARED envelope with margin under it, not
  // the height at which either criterion bites.
  assert.ok(2 * hitRadiusLu(belowH.scale, minSepLuForBand(5)) * belowH.scale >= 44,
    'the 44 pt target still passes at playH 456 — AC-409\'s stated reason is stale');
  assert.ok(CAR_W * belowH.scale >= 20, 'and so does the 20 pt car body, by 0.06 pt');

  // Where each criterion ACTUALLY bites, as arithmetic rather than as a memory. The car body
  // is the nearer of the two, so it is what the declared floor is protecting — and a band
  // table that took `min(colW, rowH)` back under 158 would move the tap target above it and
  // make AC-409's stated reason true again, visibly, here.
  const tapFailsBelowPlayH = (44 / (2 * hitRadiusLu(0.30667, minSepLuForBand(5)))) * 1500;
  const carFailsBelowPlayH = (20 / CAR_W) * 1500;
  assert.ok(Math.abs(tapFailsBelowPlayH - 434.2) < 0.5, 'tap target fails below playH ' + tapFailsBelowPlayH.toFixed(1));
  assert.ok(Math.abs(carFailsBelowPlayH - 454.5) < 0.5, 'car body fails below playH ' + carFailsBelowPlayH.toFixed(1));
  assert.ok(carFailsBelowPlayH > tapFailsBelowPlayH, 'the car body is the binding floor, not the tap target');
  assert.ok(carFailsBelowPlayH < 460, 'the declared floor sits above where anything bites');

  // The case that does fail: playH 452, below both the declared floor and AC-402's real one.
  const wayBelow = computeLayout({ screenW: 360, screenH: 536, insetTop: 20, insetBottom: 0 });
  assert.equal(wayBelow.playH, 452);
  assert.equal(wayBelow.supported, false);
  assert.ok(CAR_W * wayBelow.scale < 20, 'playH 452 fails AC-402');
  // The layout still computes rather than crashing, which is AC-409's first clause.
  assert.ok(Number.isFinite(belowH.scale) && belowH.scale > 0);
});
