#!/usr/bin/env node
// tools/converge.mjs — AC-513, the shared depot approach.
//
//   node tools/converge.mjs --seeds 1000
//   node tools/converge.mjs --seeds 200 --no-terrace   inject: remove the terrace cover
//
// WHAT THIS MEASURES AND WHY IT IS A RATE RATHER THAN A PASS.
//
// gameplay.md §4.5 proves that two cars never overlap on a road they both took — the route
// portion of the network is a tree, so two cars share an edge only if they took the identical
// path, and their separation is then exactly their spawn separation. §4.5b is the case that
// argument does not cover: two or three terminal edges may feed one depot (V2 lets terminal
// targets be non-decreasing), and under orthogonal routing they then share THE SAME VERTICAL
// ROAD for the whole of the last row. Those cars took different paths of different lengths, so
// nothing constrains their separation.
//
// The owner's orthogonal-roads direction bought this, and it is the one place in round 8 where
// the drawing got harder rather than easier. Two structural repairs were measured and rejected
// (gameplay.md §4.5b): equal path length to a shared depot takes generation to GEN_EXHAUSTED,
// and forbidding shared depots pins J at K - 1. What is left is the depot terrace, already at
// its maximum legal depth (AC-514), and a residual that is NOT ZERO and is not claimed to be.
//
// So this harness reports three things rather than ticking one:
//   * the rate at which two cars on a shared terminal approach come within CAR_L of each other;
//   * the share of those pairs in which BOTH centres are above the terrace — i.e. visible;
//   * the worst centre-to-centre distance among that visible share, with the seed and tick,
//     so the tester can screenshot it.
//
// The GEOMETRY half of AC-513 — terrace top at DEPOT_Y - mouthLu, leaving exactly
// rowH - mouthLu = 46 LU of shared approach visible at every band — IS a pass/fail, and it is
// checked against numbers transcribed from ui.md §7.6 rather than read out of the renderer.

import { DEPOT_Y, generate } from '../src/engine/index.js';
import { CAR_W, DEPOT_H, ROAD_W, buildLevelGeometry, carPose } from '../src/render/geometry.js';
import { playLevel } from './lib/solver.mjs';
import { arg, has, summary, table } from './lib/report.mjs';

// ui.md §4.1 and §7.6, TRANSCRIBED (development-process.md §6.8).
const CAR_L = 104;
const JUNCTION_MARK_R = 34;
const DESIGN_MOUTH_LU = { 1: 170, 2: 170, 3: 134, 4: 134, 5: 134 };
const DESIGN_ROW_H = { 1: 216, 2: 216, 3: 180, 4: 180, 5: 180 };
const DESIGN_VISIBLE_LU = 46; // rowH - mouthLu, the same at every band

/** Terminal edges grouped by the depot they feed, for depots fed by more than one edge. */
function convergingGroups(level) {
  const byDepot = new Map();
  for (const e of level.edges) {
    if (level.nodes[e.to].kind !== 'depot') continue;
    if (!byDepot.has(e.to)) byDepot.set(e.to, []);
    byDepot.get(e.to).push(e.id);
  }
  const groups = [];
  for (const [, edgeIds] of byDepot) if (edgeIds.length > 1) groups.push(new Set(edgeIds));
  return groups;
}

const seeds = Number(arg('seeds', 1000));
// Fault injection: pretend the terrace is not there. The VISIBLE share must then rise to
// 100 %, which is what proves the "both centres above the terrace" test is reading the
// terrace and not just counting pairs.
const noTerrace = has('no-terrace');

console.log(`# Converging cars on the shared depot approach — ${seeds} seeds per band (AC-513)` +
  (noTerrace ? '\n# INJECTING: the terrace is treated as absent' : '') + '\n');

const geomRows = [];
const rateRows = [];
const worstByBand = [];
let failures = 0;

/**
 * The depot row of one level, drawn at 2 LU a column, at the tick the worst overlap happened.
 * `#` is road, `=` the terrace's top edge, `A`/`B` the two overlapping cars, `[]` a depot.
 * Rebuilt by replaying the seed rather than by keeping a frame, so it costs nothing until a
 * worst case exists.
 */
function asciiFrame(w) {
  const level = generate(w.seed, w.band);
  const geom = buildLevelGeometry(level);
  let frame = null;
  playLevel(level, 'constrained', {
    onTick(state) {
      if (state.tick === w.tick) frame = state.cars.map((c) => ({ ...c }));
    },
  });
  if (!frame) return '  (the run did not reproduce — the bot is not deterministic, which is AC-236)';

  // Cropped to the depot row and to a window around the overlap itself: the whole 1000 LU
  // rectangle at a readable scale is 500 columns wide and nobody reads that.
  const here0 = frame.filter((c) => level.nodes[level.edges[c.edgeId].to].kind === 'depot');
  const focusX = here0.length ? carPose(geom.curves, here0[0]).x : 500;
  const COL = 4; // LU per character
  const ROW = 10; // LU per line
  const left = Math.max(0, focusX - 200);
  const right = Math.min(1000, focusX + 200);
  const top = geom.terrace.y - Math.round(level.rowH / 2);
  const bottom = DEPOT_Y + DEPOT_H;
  const W = Math.ceil((right - left) / COL);
  const H = Math.ceil((bottom - top) / ROW);
  const grid = Array.from({ length: H }, () => new Array(W).fill(' '));
  const put = (x, y, ch, force) => {
    const c = Math.round((x - left) / COL);
    const r = Math.round((y - top) / ROW);
    if (r < 0 || r >= H || c < 0 || c >= W) return;
    if (force || grid[r][c] === ' ') grid[r][c] = ch;
  };

  for (const c of geom.curves) {
    for (const seg of c.segs) {
      const n = Math.max(1, Math.ceil(seg.len / 2));
      for (let i = 0; i <= n; i += 1) {
        put(seg.x0 + ((seg.x1 - seg.x0) * i) / n, seg.y0 + ((seg.y1 - seg.y0) * i) / n,
          seg.dx === 0 ? '|' : '-');
      }
    }
  }
  for (let x = Math.max(left, geom.terrace.x); x <= Math.min(right, geom.terrace.x + geom.terrace.w); x += COL) {
    put(x, geom.terrace.y, '=', true);
  }
  for (const d of geom.depots) {
    put(d.x, d.y + DEPOT_H / 2, '[', true);
    put(d.x + d.w, d.y + DEPOT_H / 2, ']', true);
  }
  // The two cars of the worst pair, drawn at their real half-width so the overlap is visible.
  const poses = here0.map((c) => ({ c, p: carPose(geom.curves, c) }));
  let pair = null;
  for (let i = 0; i < poses.length; i += 1) {
    for (let j = i + 1; j < poses.length; j += 1) {
      if (poses[i].c.edgeId === poses[j].c.edgeId) continue;
      const d = Math.hypot(poses[i].p.x - poses[j].p.x, poses[i].p.y - poses[j].p.y);
      if (!pair || d < pair.d) pair = { d, a: poses[i], b: poses[j] };
    }
  }
  if (pair) {
    for (const [mark, q] of [['A', pair.a], ['B', pair.b]]) {
      for (let dx = -CAR_W / 2; dx <= CAR_W / 2; dx += COL) put(q.p.x + dx, q.p.y, mark, true);
    }
  }
  const lines = grid.map((row) => row.join('').replace(/\s+$/, ''));
  return lines.join('\n')
    + '\n  ' + COL + ' LU a column, ' + ROW + ' LU a line, x from ' + left + ' to ' + right + ' LU.'
    + '\n  legend: | and - road (' + ROAD_W + ' LU wide), = the terrace top edge,'
    + ' [ ] a depot, A and B the two cars ('
    + CAR_W + ' LU across). A pixel screenshot is still owed and is a tier-3 obligation.';
}

for (let band = 1; band <= 5; band += 1) {
  // --- the geometry half: a pass/fail, against ui.md §7.6's transcribed table ------------
  const probe = generate(0, band);
  const g = buildLevelGeometry(probe);
  const wantMouth = DESIGN_MOUTH_LU[band];
  const formula = DESIGN_ROW_H[band] - JUNCTION_MARK_R - 12;
  const terraceTop = DEPOT_Y - wantMouth;
  const geomOk = g.terrace.mouthLu === wantMouth
    && wantMouth === formula
    && Math.abs(g.terrace.y - terraceTop) < 1e-9
    && DESIGN_ROW_H[band] - wantMouth === DESIGN_VISIBLE_LU
    && probe.rowH === DESIGN_ROW_H[band];
  if (!geomOk) failures += 1;
  geomRows.push({
    band,
    rowH: probe.rowH,
    mouthLu: g.terrace.mouthLu,
    'rowH - MARK_R - 12': formula,
    'terrace top': g.terrace.y,
    'DEPOT_Y - mouthLu': terraceTop,
    'visible approach LU': DESIGN_ROW_H[band] - wantMouth,
    'AC-513 geometry': geomOk ? 'PASS' : 'FAIL',
    'AC-514': g.terrace.mouthLu === formula ? 'PASS' : 'FAIL',
  });

  // --- the rate half: a REPORT ------------------------------------------------------------
  let levelsWithConvergence = 0;
  let pairsExamined = 0;
  let closePairs = 0;
  let visibleClosePairs = 0;
  let runsWithClose = 0;
  let runsWithVisibleClose = 0;
  let worst = { d: Infinity, seed: -1, tick: -1, band };
  const closestPerRun = [];

  for (let seed = 0; seed < seeds; seed += 1) {
    const level = generate(seed, band);
    const groups = convergingGroups(level);
    if (!groups.length) continue;
    levelsWithConvergence += 1;
    const geom = buildLevelGeometry(level);
    const yCut = noTerrace ? Infinity : geom.terrace.y;
    let close = 0;
    let visible = 0;
    let closestHere = Infinity;

    playLevel(level, 'constrained', {
      onTick(state) {
        for (const group of groups) {
          const here = state.cars.filter((c) => group.has(c.edgeId));
          for (let i = 0; i < here.length; i += 1) {
            for (let j = i + 1; j < here.length; j += 1) {
              // Two cars on the SAME terminal edge are covered by §4.5's spawn-separation
              // guarantee; this is about two cars on DIFFERENT edges feeding one depot.
              if (here[i].edgeId === here[j].edgeId) continue;
              pairsExamined += 1;
              const a = carPose(geom.curves, here[i]);
              const b = carPose(geom.curves, here[j]);
              const d = Math.hypot(a.x - b.x, a.y - b.y);
              if (d < closestHere) closestHere = d;
              if (d >= CAR_L) continue;
              close += 1;
              // "Both centres above the terrace" — i.e. both cars still drawn.
              if (a.y < yCut && b.y < yCut) {
                visible += 1;
                if (d < worst.d) worst = { d, seed, tick: state.tick, band };
              }
            }
          }
        }
      },
    });

    if (Number.isFinite(closestHere)) closestPerRun.push(closestHere);
    closePairs += close;
    visibleClosePairs += visible;
    if (close > 0) runsWithClose += 1;
    if (visible > 0) runsWithVisibleClose += 1;
  }

  // The observation guard. A rate measured over zero pairs is not a rate.
  if (pairsExamined === 0) {
    failures += 1;
  }
  const closest = summary(closestPerRun);
  worstByBand.push(worst);
  rateRows.push({
    band,
    'levels with a shared depot': levelsWithConvergence + '/' + seeds,
    'converging pairs examined': pairsExamined,
    'pairs within CAR_L': closePairs,
    'runs with one, per 1,000': ((1000 * runsWithClose) / seeds).toFixed(0),
    'of those, both above the terrace': visibleClosePairs,
    'runs with a VISIBLE one, per 1,000': ((1000 * runsWithVisibleClose) / seeds).toFixed(0),
    'closest visible LU': Number.isFinite(worst.d) ? worst.d.toFixed(1) : '-',
    'at': Number.isFinite(worst.d) ? 'seed ' + worst.seed + ' tick ' + worst.tick : '-',
    'median closest per run': closest.n ? closest.median.toFixed(0) : '-',
  });
}

console.log('## The geometry — a pass, and it is the only pass in this harness\n');
console.log(table(geomRows));
console.log('\n## The rate — a REPORT. AC-513 bounds the geometry and reports this.\n');
console.log(table(rateRows));
// AC-513 asks for "a captured frame of the worst case". A headless harness has no Skia, so
// what it can produce is the GEOMETRY of that frame, drawn: the depot row at 2 LU a column,
// with the terrace line marked and the two overlapping cars on it. That is enough to see the
// shape of the thing and to decide whether it matters. THE PIXEL SCREENSHOT IS STILL OWED and
// it is a tier-3 obligation: the seed, band and tick below are what to point the browser at.
for (const w of worstByBand) {
  if (!Number.isFinite(w.d)) continue;
  console.log('\n## Worst visible overlap at band ' + w.band + ' — seed ' + w.seed + ', tick ' + w.tick
    + ', centres ' + w.d.toFixed(1) + ' LU apart\n');
  console.log(asciiFrame(w));
}

console.log('\n"both above the terrace" is the residual the terrace does NOT cover: two cars whose');
console.log('centres are both inside the top ' + DESIGN_VISIBLE_LU + ' LU of the shared approach. Each is then more');
console.log('than half under the building, but they do overlap, and a full geometric guarantee is');
console.log('not available and is not claimed (ui.md §7.6). THE TESTER SHOULD LOOK AT A SCREENSHOT');
console.log('of the "at" column rather than only at the number.');

if (noTerrace) {
  // With the terrace gone every close pair is visible. If that does NOT happen, the visible
  // test is not reading the terrace and the number it reports means nothing.
  const allVisible = rateRows.every((r) => r['pairs within CAR_L'] === r['of those, both above the terrace']);
  console.log('\nINJECTION "no-terrace": ' + (allVisible
    ? 'CAUGHT — with the terrace absent every close pair is visible, so the visible test is reading the terrace.'
    : 'NOT CAUGHT — the visible test does not depend on the terrace and its number is meaningless.'));
  process.exit(allVisible ? 0 : 1);
}

console.log(failures === 0 ? 'CONVERGE: geometry PASS, rate reported'
  : `CONVERGE: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
