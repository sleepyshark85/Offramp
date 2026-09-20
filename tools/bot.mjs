#!/usr/bin/env node
// tools/bot.mjs — solver bots over the generator (generation.md §7, §8).
//
//   node tools/bot.mjs --seeds 1000                  constrained, all bands (AC-221…225, 233,
//                                                    237, 238)
//   node tools/bot.mjs --seeds 1000 --band 5
//   node tools/bot.mjs --unconstrained --seeds 1000  AC-220
//   node tools/bot.mjs --attention-report --seeds 1000   AC-239
//   node tools/bot.mjs --ac240 --seeds 1000          AC-240, the sensitivity injection
//   node tools/bot.mjs --entry-window --seeds 1000   diagnostic: the row-0 junction deadline
//
// Reports the measured clear rate against §7.2's table AND against R2/R3's shape rules, the
// measured tap rate against AC-233, and the depot-mouth near-miss statistic slice 3 needs
// (docs/reports/slice-0-orchestrator-verification.md, finding 1).

import { generate } from '../src/engine/index.js';
import {
  BOT_ACQUIRE_TICKS,
  BOT_LOCKOUT_TICKS,
  BOT_NO_ATTENTION,
  BOT_SCAN_TICKS,
  playLevel,
} from './lib/solver.mjs';
import { buildCurves, carPoint } from './lib/curve.mjs';
import { arg, has, summary, table } from './lib/report.mjs';

const CAR_L = 140; // ui.md §4.1

// generation.md §7.2.2 — the shape the design requires. `null` means "no bound".
const CLEAR_TARGET = { 1: [95, null], 2: [86, 97], 3: [76, 92], 4: [66, 85], 5: [55, 78] };
const R2_MIN_DROP = 4; // pp, AC-237
const R3_MAX_DROP = 15; // pp, AC-238
const AC240_MIN_RISE = 20; // pp

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

function runBand(band, seeds, mode, opts = {}) {
  const { measureNearMiss = false, attention = null } = opts;
  const clears = [];
  const times = [];
  const allTimes = [];
  const taps = [];
  const tapRates = [];
  const att = {
    glances: 0, lapses: 0, focusSwitch: 0, focusAcquire: 0, evictions: 0,
    expiries: 0, memMeanSum: 0, memMax: 0, evaluations: 0, evaluatedNothing: 0,
    blockedGap: 0, blockedLockout: 0, blockedSafe: 0, unseenMisroutes: 0, seconds: 0,
  };
  let misroutes = 0;
  let stalled = 0;
  let levelsWithConvergence = 0;
  let nearMissRuns = 0;
  let nearMissTicks = 0;
  let minDistLu = Infinity;
  let row0Branch = 0;
  let row0BranchCleared = 0;
  let row0PassCleared = 0;

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

    const r = playLevel(level, mode, { onTick, attention });
    clears.push(r.cleared ? 1 : 0);
    misroutes += r.misroutes;
    if (r.stalled) stalled += 1;
    allTimes.push(r.seconds);
    if (r.cleared) times.push(r.seconds);
    taps.push(r.taps);
    tapRates.push(r.tapsPerSecond);
    if (hits > 0) {
      nearMissRuns += 1;
      nearMissTicks += hits;
    }
    const isBranch = level.nodes.find((n) => n.row === 0).kind === 'branch';
    if (isBranch) {
      row0Branch += 1;
      if (r.cleared) row0BranchCleared += 1;
    } else if (r.cleared) {
      row0PassCleared += 1;
    }
    if (r.attention) {
      const a = r.attention;
      att.seconds += a.seconds;
      att.glances += a.glances;
      att.lapses += a.lapses;
      att.focusSwitch += a.focusSwitch;
      att.focusAcquire += a.focusAcquire;
      att.evictions += a.evictions;
      att.expiries += a.expiries;
      att.memMeanSum += a.memMean;
      if (a.memMax > att.memMax) att.memMax = a.memMax;
      att.evaluations += a.evaluations;
      att.evaluatedNothing += a.evaluatedNothing;
      att.blockedGap += a.tapsBlockedByGap;
      att.blockedLockout += a.tapsBlockedByLockout;
      att.blockedSafe += a.tapsBlockedBySafeWindow;
      att.unseenMisroutes += a.unseenMisroutes;
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
    allTime: summary(allTimes),
    tapRate: summary(tapRates),
    taps: summary(taps),
    levelsWithConvergence,
    nearMissRuns,
    nearMissTicks,
    minDistLu,
    row0Branch,
    row0BranchCleared,
    row0PassCleared,
    att,
  };
}

const seeds = Number(arg('seeds', 1000));
const onlyBand = arg('band', null);
const bands = onlyBand ? [Number(onlyBand)] : [1, 2, 3, 4, 5];

let failures = 0;

function targetText(band) {
  const [lo, hi] = CLEAR_TARGET[band];
  return hi === null ? '≥ ' + lo + '%' : lo + '–' + hi + '%';
}

function inTarget(band, pct) {
  const [lo, hi] = CLEAR_TARGET[band];
  return pct >= lo && (hi === null || pct <= hi);
}

if (has('unconstrained')) {
  console.log(`# Unconstrained bot — ${seeds} seeds per band (AC-220)\n`);
  const rows = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'unconstrained');
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
} else if (has('ac240')) {
  // AC-240 — the fault injection required by development-process.md:136. Every ATTENTION
  // constraint removed, every TIMING constraint kept. If the clear rate does not rise, the
  // instrument is not measuring attention, whatever the constants are called.
  console.log(`# AC-240 — instrument sensitivity, ${seeds} seeds per band\n`);
  console.log('injected: workingSet=Infinity, acquire=0, switchTicks=0, memory=Infinity');
  console.log('kept:     minTapGap=11, lockout=6, safeWindow=20, scan=6, urgency=90, lapse=3%\n');
  const rows = [];
  for (const band of bands) {
    const base = runBand(band, seeds, 'constrained');
    const free = runBand(band, seeds, 'constrained', { attention: BOT_NO_ATTENTION });
    const rise = free.clearPct - base.clearPct;
    const ok = rise >= AC240_MIN_RISE;
    if (band === 5 && !ok) failures += 1;
    rows.push({
      band,
      'bot §7.1': base.clearPct.toFixed(1) + '%',
      'attention free': free.clearPct.toFixed(1) + '%',
      rise: (rise >= 0 ? '+' : '') + rise.toFixed(1) + ' pp',
      'AC-240 (≥20 pp)': ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  console.log('\nAC-240 is asserted at band 5; the other bands are reported for context.');
} else if (has('attention-report')) {
  console.log(`# Attention report — ${seeds} seeds per band (AC-239)\n`);
  const rows = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained');
    const a = r.att;
    const s = a.seconds || 1;
    const focuses = a.focusSwitch + a.focusAcquire;
    rows.push({
      band,
      'clear %': r.clearPct.toFixed(1),
      'glances/s': (a.glances / s).toFixed(2),
      'focus/s': (focuses / s).toFixed(2),
      'switch %': focuses ? ((100 * a.focusSwitch) / focuses).toFixed(0) : '-',
      'acquire %': focuses ? ((100 * a.focusAcquire) / focuses).toFixed(0) : '-',
      'mean mem': (a.memMeanSum / r.seeds).toFixed(2),
      'max mem': a.memMax,
      'evict/s': (a.evictions / s).toFixed(3),
      'expiry/s': (a.expiries / s).toFixed(3),
      'lapse/s': (a.lapses / s).toFixed(3),
      'eval NOTHING %': a.evaluations ? ((100 * a.evaluatedNothing) / a.evaluations).toFixed(0) : '-',
      'blocked gap/lock/safe': a.blockedGap + '/' + a.blockedLockout + '/' + a.blockedSafe,
      'unseen misroutes': a.unseenMisroutes,
    });
  }
  console.log(table(rows));
  console.log('\n"unseen misroutes": a car the bot was NOT holding was put onto a branch that');
  console.log('cannot reach its colour by a flip the bot made for a car it WAS holding, was never');
  console.log('rescued, and misrouted. breaksHeldCar (§7.1.6) cannot see these by construction.');
} else if (has('entry-window')) {
  // Diagnostic, not an AC. The first junction sits ENTRY_LEN = 100 LU after the spawn point,
  // which is fewer ticks than the bot's cheapest cold focus at every band above 1.
  console.log(`# Entry-window diagnostic — ${seeds} seeds per band\n`);
  const rows = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained');
    const lvl = generate(0, band);
    const transit = Math.ceil(100 * 1000 / lvl.speedMluPerTick);
    // A glance that lands when the car is `a` ticks old escalates (E2), and C1 emits the tap
    // `BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS` ticks later. The lockout then needs the car to be
    // BOT_LOCKOUT_TICKS or more from the junction at that moment.
    const glanceToTap = BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS;
    rows.push({
      band,
      'entry transit ticks': transit,
      'glance → tap': glanceToTap,
      '+ lockout': glanceToTap + BOT_LOCKOUT_TICKS,
      'glance must land by car age': transit - glanceToTap - BOT_LOCKOUT_TICKS,
      'levels with branch at row 0': r.row0Branch + '/' + r.seeds,
      'cleared, row0 = branch': r.row0BranchCleared + '/' + r.row0Branch,
      'cleared, row0 = pass': r.row0PassCleared + '/' + (r.seeds - r.row0Branch),
    });
  }
  console.log(table(rows));
} else {
  console.log(`# Constrained bot — ${seeds} seeds per band (generation.md §7.1 attention model)\n`);
  const rows = [];
  const pcts = {};
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained', { measureNearMiss: true });
    pcts[band] = r.clearPct;
    const ok = inTarget(band, r.clearPct);
    if (!ok) failures += 1;
    rows.push({
      band: r.band,
      cleared: r.clearPct.toFixed(1) + '%',
      'target §7.2': targetText(band),
      verdict: ok ? 'in band' : r.clearPct < CLEAR_TARGET[band][0] ? 'BELOW' : 'ABOVE',
      'median s': r.time.n ? r.time.median.toFixed(1) : '-',
      'taps/s': r.tapRate.mean.toFixed(2),
      'AC-233': band === 5 ? (r.tapRate.mean <= 1.25 ? 'PASS' : 'FAIL') : '-',
      stalled: r.stalled,
      'depots fed by 2+ edges': r.levelsWithConvergence + '/' + seeds,
      'runs with <140 LU gap': r.nearMissRuns,
      'min gap LU': Number.isFinite(r.minDistLu) ? r.minDistLu.toFixed(0) : '-',
    });
    if (band === 5 && r.tapRate.mean > 1.25) failures += 1;
  }
  console.log(table(rows));

  if (bands.length === 5) {
    console.log('\n## Gradient — the shape §7.2 requires, measured separately (AC-237, AC-238)\n');
    const grad = [];
    for (let b = 2; b <= 5; b += 1) {
      const drop = pcts[b - 1] - pcts[b];
      const r2 = drop >= R2_MIN_DROP;
      const r3 = drop <= R3_MAX_DROP;
      if (!r2 || !r3) failures += 1;
      grad.push({
        pair: b - 1 + ' → ' + b,
        'drop pp': drop.toFixed(1),
        'AC-237 R2 (≥ 4 pp)': r2 ? 'PASS' : 'FAIL',
        'AC-238 R3 (≤ 15 pp)': r3 ? 'PASS' : 'FAIL',
      });
    }
    console.log(table(grad));
  }

  console.log('');
  console.log('Near-miss column: two cars on DIFFERENT terminal edges feeding the SAME depot,');
  console.log('measured centre-to-centre in LU from the real Bezier geometry, against CAR_L = 140.');
  console.log('gameplay.md §4.5 does not cover this case (slice-0 verification, finding 1).');
}

process.exit(failures === 0 ? 0 : 1);
