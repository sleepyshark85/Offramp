#!/usr/bin/env node
// tools/bot.mjs — solver bots over the generator (generation.md §7, §8).
//
//   node tools/bot.mjs --seeds 1000                 constrained, all bands
//   node tools/bot.mjs --seeds 1000 --band 5
//   node tools/bot.mjs --unconstrained --seeds 1000 AC-220
//   node tools/bot.mjs --seeds 200 --all-policies   every reading of §7.1 side by side
//
// Reports the measured clear rate against §7.2, the measured tap rate against AC-233, and
// the depot-mouth near-miss statistic that slice 3 needs
// (docs/reports/slice-0-orchestrator-verification.md, finding 1).

import { generate } from '../src/engine/index.js';
import { playLevel } from './lib/solver.mjs';
import { buildCurves, carPoint } from './lib/curve.mjs';
import { arg, has, summary, table } from './lib/report.mjs';

const CAR_L = 140; // ui.md §4.1

// generation.md §7.2 — the designer's judgement, which this harness exists to measure.
const CLEAR_TARGET = { 1: [92, 100], 2: [88, 99], 3: [80, 96], 4: [72, 90], 5: [62, 84] };

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

function runBand(band, seeds, mode, policy, measureNearMiss) {
  const clears = [];
  const times = [];
  const taps = [];
  const tapRates = [];
  let misroutes = 0;
  let stalled = 0;
  let levelsWithConvergence = 0;
  let nearMissRuns = 0;
  let nearMissTicks = 0;
  let minDistLu = Infinity;

  for (let seed = 0; seed < seeds; seed += 1) {
    const level = generate(seed, band);
    let onTick;
    let groups = null;
    let curves = null;
    let hits = 0;
    if (measureNearMiss) {
      groups = convergingGroups(level);
      if (groups.length) {
        levelsWithConvergence += 1;
        curves = buildCurves(level);
        onTick = (state) => {
          for (const group of groups) {
            const here = state.cars.filter((c) => group.has(c.edgeId));
            for (let i = 0; i < here.length; i += 1) {
              for (let j = i + 1; j < here.length; j += 1) {
                if (here[i].edgeId === here[j].edgeId) continue; // same edge: §4.5 covers it
                const a = carPoint(curves, here[i]);
                const b = carPoint(curves, here[j]);
                const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
                if (d < minDistLu) minDistLu = d;
                if (d < CAR_L) hits += 1;
              }
            }
          }
        };
      }
    }

    const r = playLevel(level, mode, { policy, onTick });
    clears.push(r.cleared ? 1 : 0);
    misroutes += r.misroutes;
    if (r.stalled) stalled += 1;
    if (r.cleared) times.push(r.seconds);
    taps.push(r.taps);
    tapRates.push(r.tapsPerSecond);
    if (hits > 0) {
      nearMissRuns += 1;
      nearMissTicks += hits;
    }
  }

  const cleared = clears.reduce((a, b) => a + b, 0);
  return {
    band,
    seeds,
    clearPct: (100 * cleared) / seeds,
    misroutes,
    stalled,
    time: summary(times),
    tapRate: summary(tapRates),
    taps: summary(taps),
    levelsWithConvergence,
    nearMissRuns,
    nearMissTicks,
    minDistLu,
  };
}

const seeds = Number(arg('seeds', 1000));
const onlyBand = arg('band', null);
const bands = onlyBand ? [Number(onlyBand)] : [1, 2, 3, 4, 5];
const unconstrained = has('unconstrained');
const policies = has('all-policies') ? ['nearest', 'literal', 'patient'] : [String(arg('policy', 'nearest'))];

let failures = 0;

if (unconstrained) {
  console.log(`# Unconstrained bot — ${seeds} seeds per band (AC-220)\n`);
  const rows = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'unconstrained', 'nearest', false);
    const ok = r.clearPct === 100 && r.misroutes === 0;
    if (!ok) failures += 1;
    rows.push({
      band: r.band,
      cleared: r.clearPct.toFixed(1) + '%',
      misroutes: r.misroutes,
      stalled: r.stalled,
      'median s': r.time.n ? r.time.median.toFixed(1) : '-',
      'max s': r.time.n ? r.time.max.toFixed(1) : '-',
      'AC-220': ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
} else {
  for (const policy of policies) {
    console.log(`# Constrained bot — ${seeds} seeds per band, policy '${policy}' (generation.md §7.1)\n`);
    const rows = [];
    for (const band of bands) {
      const r = runBand(band, seeds, 'constrained', policy, true);
      const [lo, hi] = CLEAR_TARGET[band];
      const inBand = r.clearPct >= lo && r.clearPct <= hi;
      if (policy === 'nearest' && !inBand) failures += 1;
      rows.push({
        band: r.band,
        cleared: r.clearPct.toFixed(1) + '%',
        'target §7.2': lo + '–' + hi + '%',
        verdict: inBand ? 'in band' : r.clearPct < lo ? 'BELOW' : 'ABOVE',
        'median s': r.time.n ? r.time.median.toFixed(1) : '-',
        'taps/s': r.tapRate.mean.toFixed(2),
        'AC-233': band === 5 ? (r.tapRate.mean <= 1.25 ? 'PASS' : 'FAIL') : '-',
        stalled: r.stalled,
        'depots fed by 2+ edges': r.levelsWithConvergence + '/' + seeds,
        'runs with <140 LU gap': r.nearMissRuns,
        'near-miss ticks': r.nearMissTicks,
        'min gap LU': Number.isFinite(r.minDistLu) ? r.minDistLu.toFixed(0) : '-',
      });
      if (band === 5 && policy === 'nearest' && r.tapRate.mean > 1.25) failures += 1;
    }
    console.log(table(rows));
    console.log('');
  }
  console.log('Near-miss column: two cars on DIFFERENT terminal edges feeding the SAME depot,');
  console.log('measured centre-to-centre in LU from the real Bezier geometry, against CAR_L = 140.');
  console.log('gameplay.md §4.5 does not cover this case (slice-0 verification, finding 1).');
}

process.exit(failures === 0 ? 0 : 1);
