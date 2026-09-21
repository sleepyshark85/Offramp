#!/usr/bin/env node
// tools/bot.mjs — solver bots over the generator (generation.md §7, §8).
//
//   node tools/bot.mjs --seeds 1000                  constrained, all bands (AC-221…225, 233,
//                                                    237, 238)
//   node tools/bot.mjs --seeds 1000 --band 5
//   node tools/bot.mjs --unconstrained --seeds 1000  AC-220
//   node tools/bot.mjs --attention-report --seeds 1000   AC-239
//   node tools/bot.mjs --ac240 --seeds 1000          AC-240, the sensitivity injection
//   node tools/bot.mjs --entry-window --seeds 1000   AC-246 + the row-0 junction deadline
//   node tools/bot.mjs --ac247 --seeds 1000          AC-247, onset capture is an ordering only
//
//   --roundrobin  on any of the above: inject round 3's shipped sweep (pure round-robin, no
//                 onset capture) in place of §7.1.5 D3. This is the fault AC-246 and AC-247
//                 exist to catch and it is the only thing that selects it.
//
// Reports the measured clear rate against §7.2's table AND against R2/R3's shape rules, the
// measured tap rate against AC-233, and the depot-mouth near-miss statistic slice 3 needs
// (docs/reports/slice-0-orchestrator-verification.md, finding 1).

import { ENTRY_LEN, LEVEL_TICKS, TICK_HZ, generate, reachableColourMasks } from '../src/engine/index.js';
import {
  BOT_ACQUIRE_TICKS,
  BOT_LOCKOUT_TICKS,
  BOT_NO_ATTENTION,
  BOT_SCAN_TICKS,
  BOT_SWITCH_TICKS,
  SWEEP_ONSET,
  SWEEP_ROUND_ROBIN,
  makeDecisionTracker,
  playLevel,
} from './lib/solver.mjs';
import { buildCurves, carPoint } from './lib/curve.mjs';
import { arg, has, summary, table } from './lib/report.mjs';

const CAR_L = 104; // ui.md §4.1, transcribed — NOT imported from the module under test

// generation.md §6.1 — `N`, the number of cars that ARRIVE inside the two-minute clock. It
// replaced `quota` and it is what AC-246's ceiling (0.25 x 2/N) and AC-220 are stated against.
// TRANSCRIBED from the design, never read back out of the level object: a check that reads its
// expectation from the source under test is not a check (development-process.md §6.8).
const N_BY_BAND = { 1: 32, 2: 44, 3: 47, 4: 50, 5: 52 };
// generation.md §7.3 / AC-226–AC-230 — the delivery band, a report with a sanity range.
const DELIVERED_BAND = { 1: [28, 32], 2: [38, 44], 3: [40, 47], 4: [42, 50], 5: [43, 52] };

// generation.md §7.2.2 — the shape the design requires. `null` means "no bound".
const CLEAR_TARGET = { 1: [95, null], 2: [86, 97], 3: [76, 92], 4: [66, 85], 5: [55, 78] };
// generation.md §7.1.10's feasible per-car windows, computed by inverting P(Bin(N, p) <= 2) at
// each end of the band's clear-rate target. TRANSCRIBED; this is the quantity §7.1.10.3 says a
// regression should be stated in, because it is the one that is not amplified.
const P_WINDOW = { 1: [0.00, 2.60], 2: [1.53, 2.95], 3: [2.15, 3.61], 4: [2.68, 4.12], 5: [3.11, 4.74] };
const R2_MIN_DROP = 4; // pp, AC-237
const R3_MAX_DROP = 15; // pp, AC-238
const TAP_RATE_CEILING = 1.25; // /s, AC-233 — at EVERY band now, not only band 5
const AC240_MIN_RISE = 20; // pp
const AC240_HEADROOM_CEILING = 80; // pp — above this a 20 pp rise cannot be asked for
const AC247_MAX_GLANCE_DRIFT = 2; // %, AC-247's fourth check

/** The p-th percentile of an already-summarised sample, for the delivery band's p10. */
function percentileOf(sum, p) {
  return sum.sorted ? sum.sorted[Math.floor((sum.sorted.length - 1) * p)] : '-';
}

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
  const {
    measureNearMiss = false,
    attention = null,
    sweepMode = SWEEP_ONSET,
    measureDecisions = false,
    measureCapture = false,
  } = opts;
  const clears = [];
  const times = [];
  const allTimes = [];
  const taps = [];
  const tapRates = [];
  const delivered = [];
  let carTickSum = 0; // sum over ticks of cars on the board — §6.1's "cars in flight"
  let tickSum = 0;
  const deliveredCleared = [];
  const inFlightAtEnd = [];
  let overRunTicks = 0;
  let endedTickWrong = 0;
  let spawnShortfall = 0;
  const att = {
    glances: 0, lapses: 0, focusSwitch: 0, focusAcquire: 0, evictions: 0,
    expiries: 0, memMeanSum: 0, memMax: 0, evaluations: 0, evaluatedNothing: 0,
    blockedGap: 0, blockedLockout: 0, blockedSafe: 0, unseenMisroutes: 0, seconds: 0,
    captures: 0,
  };
  let misroutes = 0;
  let arrivals = 0; // delivered + misrouted, summed across runs — AC-246/§7.1.10's denominator
  let stalled = 0;
  let levelsWithConvergence = 0;
  let nearMissRuns = 0;
  let nearMissTicks = 0;
  let minDistLu = Infinity;
  let row0Branch = 0;
  let row0BranchCleared = 0;
  let row0PassCleared = 0;
  // AC-246 — summed over every level, because p is a per-decision rate and not a per-level one.
  const dec = {
    firstN: 0, firstBad: 0, laterN: 0, laterBad: 0,
    setsFirstN: 0, setsFirstBad: 0, setsLaterN: 0, setsLaterBad: 0,
    crossings: 0, walkFailures: 0,
  };
  // AC-247 — observed from OUTSIDE botTick: the bot's own bookkeeping is not evidence about
  // the bot, so the cursor and busyUntil are read before and after each call.
  const cap = {
    spawned: 0, captures: 0, distinct: 0, glancedDistinct: 0,
    multiPerTick: 0, cursorMoved: 0, shortGlance: 0, oddBusy: 0,
  };

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

    let onBotTick;
    if (measureCapture) {
      let prevCaptures = 0;
      let prevCursor = null;
      onBotTick = (bot, sim) => {
        if (bot.stats.captures > prevCaptures) {
          // Check 1 — once per car, not once per tick.
          if (bot.stats.captures !== prevCaptures + 1) cap.multiPerTick += 1;
          // Check 2 — the round-robin cursor is not moved by a capture.
          if (bot.cursor !== prevCursor) cap.cursorMoved += 1;
          // Check 3 — the glance costs a full BOT_SCAN_TICKS, and the focus a full acquire.
          const busy = bot.busyUntil - sim.tick;
          if (busy < BOT_SCAN_TICKS) cap.shortGlance += 1;
          if (busy !== BOT_SCAN_TICKS && busy !== BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS) {
            cap.oddBusy += 1;
          }
          prevCaptures = bot.stats.captures;
        }
        prevCursor = bot.cursor;
      };
    }
    const tracker = measureDecisions ? makeDecisionTracker(level, reachableColourMasks(level)) : null;

    const countCars = (state) => { carTickSum += state.cars.length; tickSum += 1; };
    const observe = onTick ? (state, before, inputs) => { countCars(state); onTick(state, before, inputs); }
      : countCars;
    const r = playLevel(level, mode, {
      onTick: observe, onBotTick, attention, sweepMode, decisions: tracker,
    });
    if (tracker) for (const k of Object.keys(dec)) dec[k] += tracker.totals[k];
    if (measureCapture) {
      cap.spawned += r.state.nextSpawn;
      cap.captures += r.attention.captures;
      cap.distinct += r.attention.capturedDistinct;
      cap.glancedDistinct += r.attention.glancedDistinct;
    }
    clears.push(r.cleared ? 1 : 0);
    delivered.push(r.delivered);
    if (r.cleared) deliveredCleared.push(r.delivered);
    // AC-231 — every level is the same two minutes, enforced identically at every band.
    if (r.state.tick > LEVEL_TICKS) overRunTicks += 1;
    if (r.cleared && r.state.tick !== LEVEL_TICKS) endedTickWrong += 1;
    if (!r.cleared && r.state.tick >= LEVEL_TICKS) endedTickWrong += 1;
    // AC-123 — a run that reaches the bell has consumed its whole schedule.
    if (r.cleared) {
      inFlightAtEnd.push(r.state.cars.length);
      if (r.state.nextSpawn !== level.spawns.length) spawnShortfall += 1;
    }
    misroutes += r.misroutes;
    arrivals += r.delivered + r.misroutes;
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
      att.captures += a.captures;
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
    delivered: summary(delivered),
    deliveredCleared: summary(deliveredCleared),
    inFlightAtEnd: summary(inFlightAtEnd),
    overRunTicks,
    endedTickWrong,
    spawnShortfall,
    misroutes,
    arrivals,
    // §6.1's "cars in flight": the mean number of cars on the board, measured rather than
    // computed from `transit / interval`.
    inFlight: tickSum ? carTickSum / tickSum : 0,
    // §7.1.10.3 — the per-car error rate, summed across all runs in the band and NOT averaged
    // per level. It is the unamplified quantity: a 1 pp change in it shows up as anywhere
    // between 0 and 60 points of clear rate depending on where the band sits, which is how an
    // 8 pp gap survived two rounds of measurement while looking like a difficulty result.
    p: arrivals ? (100 * misroutes) / arrivals : 0,
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
    dec,
    cap,
    att,
  };
}

const seeds = Number(arg('seeds', 1000));
const onlyBand = arg('band', null);
const bands = onlyBand ? [Number(onlyBand)] : [1, 2, 3, 4, 5];
// The fault injection §8 names for --entry-window: round 3's shipped sweep, which is a pure
// round-robin with no onset capture. Nothing else selects it.
const sweepMode = has('roundrobin') ? SWEEP_ROUND_ROBIN : SWEEP_ONSET;
const sweepLabel = sweepMode === SWEEP_ONSET
  ? '§7.1.5 D3 (onset capture)'
  : 'INJECTED FAULT: pure round-robin, no onset capture';

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
  // AC-220 — stated per CAR rather than per level. Under a clock every level "completes": an
  // unconstrained bot cannot fail to reach the bell, so "clears 100 %" would be vacuous. What
  // is not vacuous is that it never misroutes, and that `delivered` equals §6.1's `N` to
  // within one car.
  console.log(`# Unconstrained bot — ${seeds} seeds per band (AC-220)\n`);
  const rows = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'unconstrained');
    const N = N_BY_BAND[band];
    const medianOk = Math.abs(r.delivered.median - N) <= 1;
    const ok = r.clearPct === 100 && r.misroutes === 0 && medianOk && r.overRunTicks === 0
      && r.endedTickWrong === 0 && r.spawnShortfall === 0;
    if (!ok) failures += 1;
    rows.push({
      band: r.band,
      'reached the bell': r.clearPct.toFixed(1) + '%',
      misroutes: r.misroutes,
      stalled: r.stalled,
      'delivered min/med/max': r.delivered.min + '/' + r.delivered.median + '/' + r.delivered.max,
      'N (§6.1)': N,
      'in flight at the bell': r.inFlightAtEnd.n ? r.inFlightAtEnd.min + '-' + r.inFlightAtEnd.max : '-',
      'tick !== 7200': r.endedTickWrong,
      'schedule unconsumed': r.spawnShortfall,
      'AC-220': ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  console.log('\n"delivered" is per car: every car that ARRIVES is delivered, with zero misroutes.');
  console.log('Cars still in flight when the clock stops are discarded without scoring (AC-133),');
  console.log('which is why delivered is N and not the spawn count.');
} else if (has('ac240')) {
  // AC-240 — the fault injection required by development-process.md:136. Every ATTENTION
  // constraint removed, every TIMING constraint kept. If the clear rate does not rise, the
  // instrument is not measuring attention, whatever the constants are called.
  console.log(`# AC-240 — instrument sensitivity, ${seeds} seeds per band\n`);
  console.log('sweep: ' + sweepLabel);
  console.log('injected: workingSet=Infinity, acquire=0, switchTicks=0, memory=Infinity');
  console.log('kept:     minTapGap=11, lockout=6, safeWindow=20, scan=6, urgency=90, lapse=3%\n');
  const rows = [];
  for (const band of bands) {
    const base = runBand(band, seeds, 'constrained', { sweepMode });
    const free = runBand(band, seeds, 'constrained', { attention: BOT_NO_ATTENTION, sweepMode });
    const rise = free.clearPct - base.clearPct;
    // AC-240's headroom clause. A 20 pp rise needs 20 pp of headroom, so the test is
    // meaningless wherever the unmodified bot already clears above 80 % — that is a ceiling,
    // not insensitivity, and reporting it as a failure would be reporting the arithmetic.
    // Any band AT OR BELOW 80 % that does not rise 20 pp is a real failure, at every band and
    // not only at band 5: the failure this AC is for looked like slice 1b's bands 4 and 5
    // rising +2.0 and +7.4 pp from 19.7 % and 2.3 %, with plenty of headroom and nothing
    // moving.
    const hasHeadroom = base.clearPct <= AC240_HEADROOM_CEILING;
    const ok = rise >= AC240_MIN_RISE;
    if (hasHeadroom && !ok) failures += 1;
    rows.push({
      band,
      'bot §7.1': base.clearPct.toFixed(1) + '%',
      'attention free': free.clearPct.toFixed(1) + '%',
      rise: (rise >= 0 ? '+' : '') + rise.toFixed(1) + ' pp',
      'AC-240 (≥20 pp)': hasHeadroom ? (ok ? 'PASS' : 'FAIL') : 'n/a (no headroom)',
    });
  }
  console.log(table(rows));
  console.log(`\nA band whose unmodified rate is above ${AC240_HEADROOM_CEILING} % is reported n/a and is not a failure;`);
  console.log('any band at or below it that fails to rise 20 pp is.');
} else if (has('attention-report')) {
  console.log(`# Attention report — ${seeds} seeds per band (AC-239)\n`);
  console.log('sweep: ' + sweepLabel + '\n');
  const rows = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained', { sweepMode });
    const a = r.att;
    const s = a.seconds || 1;
    const focuses = a.focusSwitch + a.focusAcquire;
    rows.push({
      band,
      'clear %': r.clearPct.toFixed(1),
      'glances/s': (a.glances / s).toFixed(2),
      // §7.1.5 D3 / AC-247. A capture is a glance taken out of the same budget, so it is
      // reported both as a rate and as a share of glances: if the share grows without the
      // rate of glances moving, the reallocation is what the design claims it is.
      'captures/s': (a.captures / s).toFixed(3),
      'captures % of glances': a.glances ? ((100 * a.captures) / a.glances).toFixed(1) : '-',
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
  console.log('\nspawn rate per band, for the captures/s column (AC-247): '
    + bands.map((b) => (60 / generate(0, b).interval).toFixed(3)).join(' / '));
  console.log('\n"unseen misroutes": a car the bot was NOT holding was put onto a branch that');
  console.log('cannot reach its colour by a flip the bot made for a car it WAS holding, was never');
  console.log('rescued, and misrouted. breaksHeldCar (§7.1.6) cannot see these by construction.');
} else if (has('ac247')) {
  // AC-247 — four separate ways for §7.1.5 D3 to decay into the free-attention repair that
  // §7.1.8 rejects twice. Everything except the last column is observed from outside botTick.
  console.log(`# AC-247 — onset capture is an ordering and nothing more, ${seeds} seeds per band\n`);
  const rows = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained', { measureCapture: true });
    const ctl = runBand(band, seeds, 'constrained', { sweepMode: SWEEP_ROUND_ROBIN });
    const gOn = r.att.glances / (r.att.seconds || 1);
    const gRr = ctl.att.glances / (ctl.att.seconds || 1);
    const drift = (100 * Math.abs(gOn - gRr)) / gRr;
    const c = r.cap;
    // AC-247's first clause, as reworded: the IDENTITY captures === distinct cars captured,
    // bounded above by the cars that spawned. `captures > 0` is the guard against the whole
    // column passing by measuring nothing.
    const oncePerCar = c.captures > 0 && c.captures <= c.spawned && c.multiPerTick === 0
      && c.captures === c.distinct && c.captures === c.glancedDistinct;
    const cursorHeld = c.cursorMoved === 0;
    const fullGlance = c.shortGlance === 0 && c.oddBusy === 0;
    const budget = drift < AC247_MAX_GLANCE_DRIFT;
    const ok = oncePerCar && cursorHeld && fullGlance && budget;
    if (!ok) failures += 1;
    rows.push({
      band,
      'cars spawned': c.spawned,
      captures: c.captures,
      'distinct cars captured': c.distinct,
      'captures/car': (c.captures / c.spawned).toFixed(3),
      '1. once per car': oncePerCar ? 'PASS' : 'FAIL',
      '2. cursor untouched': cursorHeld ? 'PASS' : 'FAIL (' + c.cursorMoved + ')',
      '3. full scan paid': fullGlance ? 'PASS' : 'FAIL (' + c.shortGlance + '/' + c.oddBusy + ')',
      'glances/s': gOn.toFixed(2),
      'round-robin glances/s': gRr.toFixed(2),
      'drift %': drift.toFixed(2),
      '4. within 2 %': budget ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  console.log('\n1. captures === distinct cars captured, captures <= cars spawned, and never more');
  console.log('   than one capture per tick. captures/car < 1 because a car still in flight when');
  console.log('   the level ends was never glanced at, which is why AC-247 states the identity and');
  console.log('   a one-sided bound rather than "exactly the number of cars that spawned".');
  console.log('2. the cursor read after botTick equals the cursor read before it, on every capture tick.');
  console.log('3. busyUntil - T on a capture tick is BOT_SCAN_TICKS (' + BOT_SCAN_TICKS + ') when the');
  console.log('   glance does not escalate and BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS ('
    + (BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS) + ') when it does. A captured car has never been');
  console.log('   glanced at, so it is never in mem and E1\'s cheap switch is unreachable for it.');
  console.log('4. the control is the same seeds under a pure round-robin sweep.');
} else if (has('entry-window')) {
  // AC-246 — the first decision is as reliable as every other decision — plus §7.1.7's
  // deadline table.
  //
  // A car's colour cannot be known before it spawns, so nothing about its first junction can
  // be prepared: the whole decision has to fit inside the time the car takes to reach that
  // junction (gameplay.md §4.6b). Under V14 the row-0 node is always a pass, so that time is
  // `ENTRY_LEN + rowH` and not `ENTRY_LEN`.
  //
  // THE PER-ARM SPLIT IS GONE. This sweep used to report the clear rate separately for levels
  // whose row-0 node was a branch and levels whose was not — the largest structural variable
  // in the game. V14 means no level has a row-0 branch, so there is only one arm (AC-246).
  console.log(`# Entry window — ${seeds} seeds per band (AC-246, generation.md §7.1.7)\n`);
  console.log(`ENTRY_LEN = ${ENTRY_LEN} LU; row 0 is a pass at every band (V14)`);
  console.log('sweep: ' + sweepLabel + '\n');
  const rows = [];
  const ac246 = [];
  const altGaps = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained', { sweepMode, measureDecisions: true });
    const lvl = generate(0, band);
    // The first-decision transit: ENTRY_LEN + rowH, in ticks. Computed from the level's own
    // geometry rather than tabled, and cross-checked against firstDecisionTicks() by
    // generator-audit, which is where AC-245's floor is asserted.
    const transit = Math.ceil(((ENTRY_LEN + lvl.rowH) * 1000) / lvl.speedMluPerTick);
    // A glance that lands when the car is `a` ticks old escalates (E2), and C1 emits the tap
    // BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS ticks later when the car is cold, or
    // BOT_SCAN_TICKS + BOT_SWITCH_TICKS later when it is already held. The lockout then needs
    // the car to be BOT_LOCKOUT_TICKS or more from the junction at that moment.
    const cold = BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS + BOT_LOCKOUT_TICKS;
    const warm = BOT_SCAN_TICKS + BOT_SWITCH_TICKS + BOT_LOCKOUT_TICKS;
    // §7.1.7's other column: the LATENCY TO STARTING the decision, which grows with traffic.
    // A pure round-robin reaches a new car only after every older one, at BOT_SCAN_TICKS each,
    // so the cycle is `BOT_SCAN_TICKS x cars in flight` — and cars in flight is MEASURED off
    // the runs rather than taken from §6.1's computed column.
    const inFlight = r.inFlight;
    rows.push({
      band,
      'row0 branches': r.row0Branch + '/' + r.seeds,
      'ENTRY_LEN + rowH': ENTRY_LEN + lvl.rowH,
      'first decision ticks': transit,
      'as ms': Math.round((1000 * transit) / TICK_HZ),
      'cold glance→tap+lockout': cold,
      'cold deadline (car age)': transit - cold,
      'held deadline (car age)': transit - warm,
      'cars in flight (measured)': inFlight.toFixed(2),
      'scan cycle 6×inFlight': (BOT_SCAN_TICKS * inFlight).toFixed(0),
      'deadline wins by': (transit - cold - BOT_SCAN_TICKS * inFlight).toFixed(0),
    });

    // AC-246. The ceiling is a quarter of the band's per-car error budget, and the budget is
    // 2/N because a level clears on at most LIVES - 1 = 2 misroutes across the N cars that
    // arrive inside the clock. `N` is TRANSCRIBED from generation.md §6.1: reading it back out
    // of the level object would make the check satisfy itself (development-process.md §6.8).
    const d = r.dec;
    const pFirst = (100 * d.firstBad) / (d.firstN || 1);
    const pLater = (100 * d.laterBad) / (d.laterN || 1);
    const gap = pFirst - pLater;
    const ceiling = (100 * 0.25 * 2) / N_BY_BAND[band];
    const ok = d.firstN > 0 && d.laterN > 0 && d.walkFailures === 0 && gap <= ceiling;
    if (!ok) failures += 1;
    ac246.push({
      band,
      N: N_BY_BAND[band],
      'first decisions': d.firstN,
      p_first: pFirst.toFixed(2) + '%',
      'later decisions': d.laterN,
      p_later: pLater.toFixed(2) + '%',
      'gap pp': (gap >= 0 ? '+' : '') + gap.toFixed(2),
      'ceiling 0.25×(2/N)': ceiling.toFixed(2),
      'AC-246': ok ? 'PASS' : 'FAIL',
      'walk failures': d.walkFailures,
    });

    const aFirst = (100 * d.setsFirstBad) / (d.setsFirstN || 1);
    const aLater = (100 * d.setsLaterBad) / (d.setsLaterN || 1);
    altGaps.push((aFirst - aLater).toFixed(2));
  }
  console.log(table(rows));
  console.log('\n## AC-246 — the first decision against every other decision\n');
  console.log(table(ac246));
  console.log('\nA decision is a branch node the car actually crossed whose two branches differ in');
  console.log('whether they reach THAT car\'s colour — §7.1.6 evaluate\'s own test. Under the other');
  console.log('reading of AC-246\'s parenthesis, branches differing in their reachable-colour SETS,');
  console.log('the gaps are ' + altGaps.join(' / ') + ' pp; the verdict is taken on the first.');
  console.log('\n"row0 branches" must be 0/N at every band: V14 is a construction constraint, so a');
  console.log('non-zero count is a generator regression and not a statistic.');
} else {
  console.log(`# Constrained bot — ${seeds} seeds per band (generation.md §7.1 attention model)\n`);
  console.log('sweep: ' + sweepLabel + '\n');
  const rows = [];
  const pcts = {};
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained', { measureNearMiss: true, sweepMode });
    pcts[band] = r.clearPct;
    const ok = inTarget(band, r.clearPct);
    if (!ok) failures += 1;
    // AC-233's ceiling now applies at EVERY band, because the rate is sustained for exactly
    // 120 s at every band and band 1 is no longer the short one (gameplay.md §8.6).
    const tapOk = r.tapRate.mean <= TAP_RATE_CEILING;
    if (!tapOk) failures += 1;
    // AC-226–AC-230, the delivery band: a REPORT with a sanity range, not a constraint.
    const [dlo, dhi] = DELIVERED_BAND[band];
    const dOk = r.delivered.median >= dlo && r.delivered.median <= dhi;
    // AC-231 — every run is the same two minutes or shorter, at every band.
    const clockOk = r.overRunTicks === 0 && r.endedTickWrong === 0 && r.spawnShortfall === 0;
    if (!clockOk) failures += 1;
    rows.push({
      band: r.band,
      cleared: r.clearPct.toFixed(1) + '%',
      'target §7.2': targetText(band),
      verdict: ok ? 'in band' : r.clearPct < CLEAR_TARGET[band][0] ? 'BELOW' : 'ABOVE',
      'per-car p': r.p.toFixed(2) + '%',
      '§7.1.10 window': P_WINDOW[band][0].toFixed(2) + '–' + P_WINDOW[band][1].toFixed(2) + '%',
      'p verdict': r.p < P_WINDOW[band][0] ? 'BELOW' : r.p > P_WINDOW[band][1] ? 'ABOVE' : 'in window',
      'delivered med/p10': r.delivered.median + '/' + percentileOf(r.delivered, 0.1),
      'band §7.3': dlo + '–' + dhi,
      'AC-226…230': dOk ? 'PASS' : 'out',
      'taps/s': r.tapRate.mean.toFixed(2),
      'AC-233 (≤1.25)': tapOk ? 'PASS' : 'FAIL',
      'AC-231': clockOk ? 'PASS' : 'FAIL',
      stalled: r.stalled,
      'depots fed by 2+ edges': r.levelsWithConvergence + '/' + seeds,
      'runs with <104 LU gap': r.nearMissRuns,
      'min gap LU': Number.isFinite(r.minDistLu) ? r.minDistLu.toFixed(0) : '-',
    });
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
  console.log('measured centre-to-centre in LU from the real orthogonal geometry, against');
  console.log('CAR_L = 104. gameplay.md §4.5 does not cover this case; §4.5b and AC-513 do, and');
  console.log('tools/converge.mjs is where it is measured properly.');
}

process.exit(failures === 0 ? 0 : 1);
