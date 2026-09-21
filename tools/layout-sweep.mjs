#!/usr/bin/env node
// tools/layout-sweep.mjs — tier 4, the viewport arithmetic sweep
// (development-process.md §4 and §9, ui.md §3.3 and §4.4, AC-401 to AC-411).
//
//   node tools/layout-sweep.mjs                 the sweep; must report 0 overflowing
//   node tools/layout-sweep.mjs --devices       just the ui.md §3.3 device table
//   node tools/layout-sweep.mjs --inject <name> prove a check can fail before trusting it
//
// This harness has been referenced from development-process.md §9 and from AC-401 since
// slice 0 and did not exist; the slice-1 tester recorded that as F13 and could verify none of
// AC-401 to AC-410. It exists now.
//
// WHAT IT SWEEPS. Widths 320-520 pt in 1 pt steps (201 values) x heights 560-1200 pt in 2 pt
// steps (321 values) x 9 safe-area inset profiles x 5 bands, less the configurations below the
// declared support floor — which is the count ui.md §4.4 records.
//
// EXPECTATIONS ARE TRANSCRIBED FROM ui.md, NOT IMPORTED (development-process.md §6.8): the
// tap-target floor of 44 pt, the car-body floor of 20 pt, the 30 LU depot margin, the 8 pt
// depot clearance, the per-band colW and the design rectangle's 1000 x 1500 are literals
// below. The layout module is the thing under test; it does not get to supply the answer.
//
// ROUND 8 MOVED EVERY NUMBER IN THIS FILE. The design rectangle is 1000 x 1500 rather than
// 1000 x 1600, the support floor is 320 x 460 rather than 320 x 400, DEPOT_Y is 1350 rather
// than 1420, DEPOT_W/H are 124 x 128 rather than 160 x 170, and CAR_W is 66 rather than 84.
//
// ROUND 9 MOVED ONE OF THE TWO FLOORS BACK OFF THE WALL. `colW` is derived from the
// depot-clearance rule (generation.md §3.2.1) rather than hand-chosen, which takes band 5's
// `min(colW, rowH)` from 150 LU to 158 and the junction target at the support floor from
// 44.16 pt to 46.61 pt — a margin of 2.61 rather than 0.16. The car body is unmoved and still
// clears 20 pt by 0.24, so "both floors are tight" is now true of AC-402 alone. `ROAD_W` fell
// 84 -> 28 (ui.md §4.6), so the road column of the device table moved with it. A sixth column at band 5 and a 66 LU car are as far as this rectangle goes.
//
// EVERY CHECK COUNTS ITS OBSERVATIONS AND ASSERTS THE COUNT IS NON-ZERO. §6.8 exists because
// a tuning change made a safety check arithmetically unreachable and nothing failed. A check
// that never ran is reported here as a failure, not as a pass.

import { BANDS, colWFor } from '../src/engine/index.js';
import { computeLayout, hitRadiusLu, minSepLuForBand } from '../src/ui/layout.js';
import { CAR_L, CAR_W, DEPOT_H, DEPOT_W, DEPOT_RECEIVING_SCALE, ROAD_W } from '../src/render/geometry.js';
import { arg, has, table } from './lib/report.mjs';

// --- transcribed from ui.md ---------------------------------------------------------------
const DESIGN_W = 1000; // ui.md §3.2
const DESIGN_H = 1500;
const TAP_FLOOR_PT = 44; // ui.md §4.4, §11.1, AC-401
const CAR_FLOOR_PT = 20; // ui.md §4.3, AC-402 — the 20 pt legibility floor
const DEPOT_MARGIN_LU = 30; // ui.md §4.1, AC-410
const DEPOT_CLEAR_PT = 8; // AC-411
const DEPOT_Y = 1350; // generation.md §3.2 / ui.md §3.3
const SUPPORT_W = 320; // ui.md §4.4, "declared support floor"
const SUPPORT_H = 460; // moved 400 -> 460: the rectangle is shorter, so it hits its height
                       // bound at a LARGER playH (AC-409)
// generation.md §3.2.1 and §6.1, transcribed. `colW` is DERIVED in round 9 — the largest EVEN
// value with `(C-1)*colW <= 792` and `colW <= 300` — rather than a band-table value, and it
// division — which is the whole reason integrality is now a property of the table.
const DESIGN_COLW = { 1: 300, 2: 264, 3: 264, 4: 198, 5: 158 };
const DESIGN_C = { 1: 3, 2: 4, 3: 4, 4: 5, 5: 6 };
const DESIGN_MINSEP = { 1: 216, 2: 216, 3: 180, 4: 180, 5: 158 };

const W_FROM = 320;
const W_TO = 520;
const W_STEP = 1;
const H_FROM = 560;
const H_TO = 1200;
const H_STEP = 1;

/**
 * Safe-area inset profiles: the seven distinct (top, bottom) pairs of ui.md §3.3's device
 * table, plus a zero-inset baseline, which is the shape a desktop browser and an older Android
 * give. ui.md §4.4 says "nine"; §3.3's nine device rows contain seven distinct pairs, so eight
 * is what that table plus a baseline actually yields and eight is what is swept. The sweep
 * reports its own configuration count rather than quoting the designer's.
 */
const INSETS = [
  [0, 0],
  [20, 0], // iPhone SE 1st / 2nd / 3rd
  [24, 24], // Galaxy S23, Pixel 7
  [32, 24], // Tall Android 21:9
  [47, 34], // iPhone 13/14
  [50, 34], // iPhone 13 mini
  [59, 34], // iPhone 15/16
  [62, 34], // iPhone 16 Pro Max
];

// ui.md §3.3, transcribed. name, W, H, insetTop, insetBottom, scale, playH, junction target at
// the worst band (always band 5, min(colW, rowH) = 150 LU), car body W x L, road width.
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

/**
 * AC-409. Viewports deliberately BELOW the declared support floor, on BOTH axes. The width
 * probes matter most: the sweep range starts at exactly 320 pt, so no width in it is ever
 * below the floor and without these the width half of the envelope check would never execute.
 * A check that never ran is a failure, not a pass (§6.8).
 */
const OUT_OF_ENVELOPE = [
  [300, 560, 20, 0],
  [280, 640, 24, 24],
  [320, 540, 62, 34],
  [360, 480, 47, 34],
];

// --- fault injection ------------------------------------------------------------------------
// Never trust a green check you have not seen fail (development-process.md §6.2). Each name
// breaks one thing the sweep claims to catch; `--inject <name>` must make the sweep fail.
const INJECTIONS = {
  // ROUND 9 CHANGED WHAT THIS INJECTION CATCHES, and the label is corrected rather than left
  // to flatter the check. It admits playH 440-459. Under round 8 that broke band 5's 44 pt
  // target (the upper clamp was 72 LU); under round 9 the clamp is 76 LU at every band and
  // 2*76*(440/1500) = 44.6 pt still passes, so what now fails is AC-402's 20 pt CAR BODY —
  // 66*(440/1500) = 19.4 pt. The injection still bites, at a different check.
  'support-floor': 'admit playH 440-459, below the declared floor, so the car body fails 20 pt',
  'hit-cap': 'halve the upper clamp so it binds and the target falls below 44 pt',
  'car-width': 'shrink CAR_W from 66 to 60 LU',
  'depot-depth': 'grow DEPOT_H from 128 to 200 LU',
  'depot-width': 'grow DEPOT_W from 124 to 200 LU',
  'slack-split': 'move the vertical slack split from 55 % to 95 %',
  'hit-overlap': 'remove the upper clamp so hit circles can touch',
};

function injectedHitR(scale, minSep, inject) {
  // ROUND 8 MADE THE OLD `tap-round` INJECTION UNREACHABLE, and that is a §6.8 finding rather
  // than a detail. It replaced `ceil(22/scale)` with `floor`, and under the old geometry that
  // mattered: the smallest in-envelope scale was 400/1600 = 0.2500, where `22/scale` is 88 and
  // the `ceil` term beat the 76 LU lower clamp. Under round 8 the support floor is playH 460
  // against a 1500 LU rectangle, so the smallest in-envelope scale is 0.30667 and `22/scale`
  // is 71.7 — BELOW 76 everywhere in the envelope. `max(..., 76)` therefore returns 76 under
  // either rounding, and the injection could no longer fail. Nothing in the code changed; a
  // geometry constant moved and a fault injection stopped being able to inject a fault.
  //
  // ROUND 9 TOOK A SECOND INJECTION HALFWAY TO THE SAME PLACE, and it is the same §6.8
  // finding one round on. Under round 8 the upper clamp at band 5 was `floor((150-6)/2) = 72`,
  // BELOW the 76 LU lower clamp — so the ordering of the two clamps was observable, and the
  // target at the support floor was 44.16 pt, 0.16 pt of margin. `colW` is derived now and
  // band 5's grid is 158, so the upper clamp is `floor((158-6)/2) = 76` — EQUAL to the lower
  // clamp. `min(max(a,L),U)` differs from `max(min(a,U),L)` only when `L > U`, so AC-302's
  // "upper bound applied last" clause is no longer observable at any band or any scale.
  // test/layout.test.js asserts that unreachability with the arithmetic attached, so a band
  // table that takes `min(colW, rowH)` back under 158 re-arms it visibly.
  //
  // What actually delivers 44 pt now: the lower clamp of 76 LU, at EVERY band — 2*76*0.30667
  // = 46.61 pt, a margin of 2.61. Which is why the two reachable injections are the upper
  // clamp binding harder (`hit-cap`) and the support floor being lowered under it
  // (`support-floor`) — and why `support-floor` needs re-checking below.
  if (inject === 'hit-cap') {
    return Math.min(Math.max(Math.ceil(22 / scale), 76), Math.floor((minSep - 6) / 4));
  }
  if (inject === 'hit-overlap') return Math.max(Math.ceil(22 / scale), 76) + 60;
  return hitRadiusLu(scale, minSep);
}

/**
 * The scale below which the upper clamp starts binding at the tightest band, and the
 * smallest scale the sweep actually reaches. The gap between them is AC-401's real margin,
 * and it is small enough to be worth printing rather than assuming.
 */
function tapHeadroom() {
  const minSep = minSepLuForBand(5);
  const cap = Math.floor((minSep - 6) / 2);
  return { bindsBelow: 22 / cap, cap, minSep };
}

function injectedCarW(inject) {
  return inject === 'car-width' ? 60 : CAR_W;
}

function injectedDepotH(inject) {
  return inject === 'depot-depth' ? 200 : DEPOT_H;
}

function injectedDepotW(inject) {
  return inject === 'depot-width' ? 200 : DEPOT_W;
}

function injectedOriginY(L, inject) {
  return inject === 'slack-split' ? L.playTop + L.slackY * 0.95 : L.originY;
}

// --- the checks -----------------------------------------------------------------------------

/**
 * One configuration. Returns a list of violation strings, and bumps `obs` for every check
 * that actually evaluated — so a check that stopped being reachable shows up as an
 * observation count of zero rather than as silence.
 */
function checkConfig(L, band, inject, obs, worst) {
  const bad = [];
  const minSep = minSepLuForBand(band);
  const hitR = injectedHitR(L.scale, minSep, inject);
  const carW = injectedCarW(inject);
  const depotH = injectedDepotH(inject);
  const originY = injectedOriginY(L, inject);

  // AC-403 — one uniform scale, both axes.
  obs.scale += 1;
  const expectScale = Math.min(L.playW / DESIGN_W, L.playH / DESIGN_H);
  if (L.scale !== expectScale) bad.push('scale ' + L.scale + ' !== min(playW/1000, playH/1500)');

  // AC-404 — slack split 55 / 45 vertically, centred horizontally.
  obs.origin += 1;
  if (Math.abs(L.originX - (L.playW - DESIGN_W * L.scale) / 2) > 1e-9) bad.push('originX');
  if (Math.abs(originY - (L.playTop + L.slackY * 0.55)) > 1e-9) bad.push('originY');

  // AC-405 / AC-406 — the HUD sits on the top inset; the play area clears the bottom one by 8.
  obs.chrome += 1;
  if (L.playTop !== L.insetTop + 56) bad.push('playTop');
  if (L.screenH - L.playBottom !== L.insetBottom + 8) bad.push('playBottom');

  // AC-401 — a junction is at least 44 pt across.
  obs.tap += 1;
  const tapPt = 2 * hitR * L.scale;
  if (tapPt < worst.tapFloor) worst.tapFloor = tapPt;
  if (tapPt < TAP_FLOOR_PT - 1e-9) bad.push('tap target ' + tapPt.toFixed(2) + ' pt');

  // AC-303 — hit circles never overlap.
  obs.overlap += 1;
  if (2 * hitR >= minSep) bad.push('hit circles overlap: 2*' + hitR + ' >= ' + minSep);

  // AC-402 — the car body stays legible.
  obs.car += 1;
  const carPt = carW * L.scale;
  if (carPt < worst.carFloor) worst.carFloor = carPt;
  if (carPt < CAR_FLOOR_PT - 1e-9) bad.push('car body ' + carPt.toFixed(2) + ' pt');

  // AC-411 — clear space below the depot, at its 1.04 receiving scale, to the screen bottom.
  obs.depotClear += 1;
  const receivingBottomLu = DEPOT_Y + depotH / 2 + (depotH / 2) * DEPOT_RECEIVING_SCALE;
  const clearPt = L.screenH - (originY + receivingBottomLu * L.scale);
  if (clearPt < worst.depotClear) worst.depotClear = clearPt;
  if (clearPt < DEPOT_CLEAR_PT - 1e-9) bad.push('depot clearance ' + clearPt.toFixed(2) + ' pt');

  // The design rectangle must map inside the play area on both axes — the definition of
  // "overflowing" (development-process.md §9: "must be 0 overflowing").
  obs.fit += 1;
  if (originY + DESIGN_H * L.scale > L.playBottom + 1e-9) bad.push('design rect overflows the play area');
  if (L.originX < -1e-9 || L.originX + DESIGN_W * L.scale > L.playW + 1e-9) bad.push('design rect overflows width');

  return bad;
}

/**
 * AC-410 — depot `x ± DEPOT_W/2` inside [0, 1000] with >= 30 LU margin, AND adjacent depots
 * separated by at least 20 LU. Per band, not per viewport. The columns are computed from the
 * TRANSCRIBED band table, so a `colW` edit in the engine that broke this would be caught here
 * rather than agreed with (development-process.md §6.8).
 */
function checkDepotColumns(inject, obs) {
  const bad = [];
  let worst = Infinity;
  let worstGap = Infinity;
  for (let band = 1; band <= 5; band += 1) {
    const C = DESIGN_C[band];
    const colW = DESIGN_COLW[band];
    // `colW` left the band table in round 9 and is derived from `C` (generation.md §3.2.1),
    // so the comparison is against the DERIVATION rather than against a table field. The
    // expectation is still transcribed: DESIGN_COLW above is ui.md/generation.md's, not
    // `colWFor`'s output.
    if (BANDS[band].C !== C || colWFor(BANDS[band].C) !== colW) {
      bad.push('band ' + band + ' band table disagrees with ui.md/generation.md §6.1');
    }
    const depotW = injectedDepotW(inject);
    for (let c = 0; c < C; c += 1) {
      const x = 500 + ((2 * c - (C - 1)) * colW) / 2;
      obs.depotX += 1;
      const margin = Math.min(x - depotW / 2, 1000 - (x + depotW / 2));
      if (margin < worst) worst = margin;
      if (margin < DEPOT_MARGIN_LU - 1e-9) {
        bad.push('band ' + band + ' col ' + c + ' margin ' + margin.toFixed(1) + ' LU');
      }
    }
    const gap = colW - depotW;
    if (gap < worstGap) worstGap = gap;
    if (gap < 20 - 1e-9) bad.push('band ' + band + ' adjacent depots ' + gap.toFixed(1) + ' LU apart');
  }
  return { bad, worst, worstGap };
}

function runDeviceTable() {
  const rows = [];
  let bad = 0;
  for (const [name, w, h, top, bottom, scale, playH, target, carW, carL, roadW] of DEVICES) {
    const L = computeLayout({ screenW: w, screenH: h, insetTop: top, insetBottom: bottom });
    // `minSepLuForBand(5)` is min(colW, rowH) = 150 LU at band 5 — the finest grid in the
    // game and the binding case for AC-401.
    const r = hitRadiusLu(L.scale, minSepLuForBand(5));
    const gotScale = Math.round(L.scale * 1e4) / 1e4;
    const gotTarget = Math.round(2 * r * L.scale * 10) / 10;
    const gotCarW = Math.round(CAR_W * L.scale * 10) / 10;
    const gotCarL = Math.round(CAR_L * L.scale * 10) / 10;
    const gotRoadW = Math.round(ROAD_W * L.scale * 10) / 10;
    const receiving = DEPOT_Y + DEPOT_H / 2 + (DEPOT_H / 2) * DEPOT_RECEIVING_SCALE;
    const clear = h - (L.originY + receiving * L.scale);
    const ok = gotScale === scale && L.playH === playH && gotTarget === target
      && gotCarW === carW && gotCarL === carL && gotRoadW === roadW;
    if (!ok) bad += 1;
    rows.push({
      device: name,
      'W×H': w + '×' + h,
      insets: top + '/' + bottom,
      scale: gotScale.toFixed(4),
      playH: L.playH,
      slackY: L.slackY.toFixed(1),
      target: gotTarget.toFixed(1),
      car: gotCarW.toFixed(1) + '×' + gotCarL.toFixed(1),
      road: gotRoadW.toFixed(1),
      'clear pt': clear.toFixed(1),
      'vs ui.md': ok ? 'match' : 'MISMATCH',
    });
  }
  return { rows, bad };
}

function main() {
  const inject = arg('inject', null);
  if (inject && !INJECTIONS[inject]) {
    process.stdout.write(
      'unknown injection "' + inject + '". known: ' +
        Object.entries(INJECTIONS).map(([k, v]) => '\n  ' + k.padEnd(14) + v).join('') + '\n',
    );
    process.exit(2);
  }

  const dev = runDeviceTable();
  process.stdout.write('ui.md §3.3 — measured fit across real devices\n\n');
  process.stdout.write(table(dev.rows) + '\n\n');
  if (dev.bad) process.stdout.write(dev.bad + ' device row(s) DISAGREE with ui.md §3.3\n\n');

  if (has('devices')) process.exit(dev.bad ? 1 : 0);

  const obs = { scale: 0, origin: 0, chrome: 0, tap: 0, overlap: 0, car: 0, depotClear: 0, fit: 0, depotX: 0, envelope: 0 };
  const worst = { tapFloor: Infinity, carFloor: Infinity, depotClear: Infinity };
  const failures = new Map();
  let configs = 0;
  let overflowing = 0;
  let outsideEnvelope = 0;

  const note = (msg) => {
    failures.set(msg, (failures.get(msg) || 0) + 1);
  };

  for (let w = W_FROM; w <= W_TO; w += W_STEP) {
    for (let h = H_FROM; h <= H_TO; h += H_STEP) {
      for (const [top, bottom] of INSETS) {
        const L = computeLayout({ screenW: w, screenH: h, insetTop: top, insetBottom: bottom });
        // AC-409: below the declared floor the game must still render, and the harness must
        // report the configuration as outside the envelope rather than as a pass.
        // `support-floor` lowers the declared height floor by 20 pt, which admits scales
        // below 22/72 = 0.30556 and makes band 5's target fall under 44 pt. It is the
        // injection that proves the 0.16 pt margin is real and is being watched.
        const floorH = inject === 'support-floor' ? SUPPORT_H - 20 : SUPPORT_H;
        if (L.playW < SUPPORT_W || L.playH < floorH) {
          outsideEnvelope += 1;
          obs.envelope += 1;
          continue;
        }
        for (let band = 1; band <= 5; band += 1) {
          configs += 1;
          const bad = checkConfig(L, band, inject, obs, worst);
          if (bad.length) {
            overflowing += 1;
            for (const b of bad) note(b.replace(/[-0-9.]+/g, '#'));
          }
        }
      }
    }
  }

  const depots = checkDepotColumns(inject, obs);
  for (const b of depots.bad) note(b.replace(/[-0-9.]+/g, '#'));

  // AC-409 — the out-of-envelope probes. These are NOT counted as passes; they are counted,
  // and the sweep asserts it saw some, because the main range cannot produce one.
  let envelopeProbes = 0;
  for (const [w, h, top, bottom] of OUT_OF_ENVELOPE) {
    const L = computeLayout({ screenW: w, screenH: h, insetTop: top, insetBottom: bottom });
    envelopeProbes += 1;
    if (L.supported) note('out-of-envelope probe ' + w + 'x' + h + ' was reported as supported');
    if (!Number.isFinite(L.scale)) note('out-of-envelope probe produced a non-finite scale');
  }

  process.stdout.write('viewport sweep\n\n');
  process.stdout.write(
    table([
      { metric: 'widths', value: W_FROM + '-' + W_TO + ' step ' + W_STEP, n: (W_TO - W_FROM) / W_STEP + 1 },
      { metric: 'heights', value: H_FROM + '-' + H_TO + ' step ' + H_STEP, n: (H_TO - H_FROM) / H_STEP + 1 },
      { metric: 'inset profiles', value: 'ui.md §3.3 pairs + zero', n: INSETS.length },
      { metric: 'bands', value: '1-5', n: 5 },
      { metric: 'configurations', value: 'in envelope', n: configs },
      { metric: 'outside envelope', value: 'AC-409, excluded from the pass count', n: outsideEnvelope },
      { metric: 'overflowing', value: 'must be 0', n: overflowing },
    ]) + '\n\n',
  );

  process.stdout.write(
    table([
      { check: 'junction target (AC-401)', floor: TAP_FLOOR_PT + ' pt', measured: worst.tapFloor.toFixed(2) + ' pt', observations: obs.tap },
      { check: 'car body (AC-402)', floor: CAR_FLOOR_PT + ' pt', measured: worst.carFloor.toFixed(2) + ' pt', observations: obs.car },
      { check: 'depot clearance (AC-411)', floor: DEPOT_CLEAR_PT + ' pt', measured: worst.depotClear.toFixed(2) + ' pt', observations: obs.depotClear },
      { check: 'depot margin (AC-410)', floor: DEPOT_MARGIN_LU + ' LU', measured: depots.worst.toFixed(1) + ' LU', observations: obs.depotX },
    { check: 'adjacent depot gap (AC-410)', floor: '20 LU', measured: depots.worstGap.toFixed(1) + ' LU', observations: obs.depotX },
      { check: 'hit circles disjoint (AC-303)', floor: 'no overlap', measured: overflowing === 0 ? 'none' : 'see below', observations: obs.overlap },
      { check: 'uniform scale (AC-403)', floor: 'exact', measured: 'exact', observations: obs.scale },
      { check: 'slack split (AC-404)', floor: '55 / 45', measured: '55 / 45', observations: obs.origin },
      { check: 'HUD and gutter (AC-405/406)', floor: '56 / 8 pt', measured: '56 / 8 pt', observations: obs.chrome },
      { check: 'design rect fits (overflow)', floor: 'inside', measured: 'inside', observations: obs.fit },
      { check: 'support floor (AC-409)', floor: '>0 probes', measured: envelopeProbes + ' probes', observations: envelopeProbes },
    ]) + '\n\n',
  );

  // AC-401's margin, stated rather than assumed. The 44 pt floor comes from ceil(22/scale);
  // the only thing that can defeat it is the upper clamp binding, which happens below the
  // scale printed here. A future band table with a tighter min(colW, rowH), or a lower
  // support floor, walks into it — and this line is where that becomes visible.
  const head = tapHeadroom();
  // The smallest scale the sweep actually REACHES INSIDE THE ENVELOPE, which is the number the
  // margin is against: below the support floor the configuration is excluded, so the old
  // unfiltered `min(W_FROM/1000, (H_FROM - insets)/1500)` understated the scale and overstated
  // the margin.
  const minScale = Math.min(W_FROM / DESIGN_W, SUPPORT_H / DESIGN_H);
  process.stdout.write(
    'AC-401 margin: the upper clamp (floor((' + head.minSep + ' - 6)/2) = ' + head.cap +
      ' LU, band 5) begins to bind below scale ' + head.bindsBelow.toFixed(5) +
      '; the sweep\'s smallest IN-ENVELOPE scale is ' + minScale.toFixed(5) +
      ', a margin of ' + (2 * head.cap * minScale - TAP_FLOOR_PT).toFixed(2) + ' pt.\n\n',
  );

  // A check that never ran is a failure, not a pass (development-process.md §6.8).
  const vacuous = Object.entries(obs).filter(([k, v]) => v === 0 && k !== 'envelope');
  for (const [k] of vacuous) note('check "' + k + '" made ZERO observations and asserted nothing');
  if (envelopeProbes === 0) note('the out-of-envelope probe set is empty (AC-409 unreachable)');

  if (failures.size) {
    process.stdout.write('violations (numbers elided so shapes group):\n');
    for (const [msg, n] of [...failures].sort((a, b) => b[1] - a[1])) {
      process.stdout.write('  ' + String(n).padStart(9) + '  ' + msg + '\n');
    }
    process.stdout.write('\n');
  }

  if (inject) {
    const caught = failures.size > 0;
    process.stdout.write(
      'INJECTION "' + inject + '" — ' + INJECTIONS[inject] + '\n' +
        (caught ? 'CAUGHT: the sweep failed, so this check can fail.\n' : 'NOT CAUGHT: this check cannot fail and is worthless.\n'),
    );
    process.exit(caught ? 0 : 1);
  }

  const ok = overflowing === 0 && failures.size === 0 && dev.bad === 0;
  process.stdout.write(ok ? 'layout sweep clean: 0 overflowing across ' + configs.toLocaleString('en-US') + ' configurations\n' : 'LAYOUT SWEEP FAILED\n');
  process.exit(ok ? 0 : 1);
}

main();
