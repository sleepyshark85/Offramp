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
//   node tools/bot.mjs --lives-distribution --seeds 3000   generation.md §6.1.5, §7.4.2 item L
//
//   --roundrobin  on any of the above: inject round 3's shipped sweep (pure round-robin, no
//                 onset capture) in place of §7.1.5 D3. This is the fault AC-246 and AC-247
//                 exist to catch and it is the only thing that selects it.
//
// Reports the measured clear rate against §7.2's table AND against R2/R3's shape rules, the
// measured tap rate against AC-233, and the depot-mouth near-miss statistic slice 3 needs
// (docs/reports/slice-0-orchestrator-verification.md, finding 1).

import { CAR_SPEED, ENTRY_LEN, LEVEL_TICKS, TICK_HZ, generate, reachableColourMasks } from '../src/engine/index.js';
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
// §6.1.3 publishes `N` as a MEDIAN with a maximum beside it — 32/33, 45/46, 47/48, 50/51,
// 51/52 — and every threshold stated against `N` uses the median.
const N_BY_BAND = { 1: 32, 2: 45, 3: 47, 4: 50, 5: 51 };
// generation.md §7.3 / AC-226–AC-230 — the delivery band, a report with a sanity range.
// Band 1's upper edge moved 32 -> 33 in round 9: `N` at band 1 is a median of 32 with a
// maximum of 33, and a clean run delivers whatever arrived, so a band whose `N` can be 33
// cannot have a delivery ceiling of 32.
const DELIVERED_BAND = { 1: [28, 33], 2: [38, 46], 3: [40, 48], 4: [42, 51], 5: [42, 52] };
// AC-250 / generation.md §6.1 — cars in flight, the tick-weighted mean of state.cars.length.
// It is `transit / interval` and NEITHER TERM DEPENDS ON HOW WELL THE BOT PLAYS, so it is the
// FIRST number to read when a clear rate comes in wrong.
const CARS_IN_FLIGHT = { 1: 2.73, 2: 3.96, 3: 4.26, 4: 4.38, 5: 4.40 };
const CARS_IN_FLIGHT_TOL = 0.05; // AC-250

// generation.md §7.2.2 — the shape the design requires. `null` means "no bound".
const CLEAR_TARGET = { 1: [95, null], 2: [86, 97], 3: [76, 92], 4: [66, 85], 5: [55, 78] };
// generation.md §7.1.10 publishes TWO per-car windows and they have different jobs.
//
//   MODEL window  — `P(Bin(N, p) <= 2)` inverted at each end of the band's clear-rate target.
//                   It is the object §7.1.10 reasons about (window widths, ladder spans, the
//                   monotone-p search), because all of those compare the model with itself.
//
//   READING window — the model window minus 0.20 pp. IT IS THE ONLY ONE A MEASURED `p` MAY BE
//                   COMPARED AGAINST, and it is what AC-241 means.
//
// §7.1.10.0 is why. The binomial treats a level's `N` cars as independent trials and they are
// not, so at a given clear rate the measured `p` sits BELOW the model's inversion — always, at
// every band, by construction. A column that inverts the model and then compares the
// measurement to it MUST read "BELOW" whenever the clear rate is in band, and round 8's sweep
// duly reported exactly that at bands 2, 4 and 5. That was the table misreading itself, not
// the game. Measured over 222 points spanning clear rates from 27 % to 99 %, the gap is a
// near-constant 0.20 pp — additive, not a ratio.
//
// Both are TRANSCRIBED from AC-221–AC-225's round-9 table, and `checkWindows()` below
// re-derives them from `N` and §7.2.2's targets so that a transcription error fails loudly
// rather than becoming the expectation.
const P_WINDOW_MODEL = { 1: [0.00, 2.60], 2: [1.50, 2.88], 3: [2.15, 3.61], 4: [2.68, 4.12], 5: [3.18, 4.83] };
const P_WINDOW = { 1: [0.00, 2.40], 2: [1.30, 2.68], 3: [1.95, 3.41], 4: [2.48, 3.92], 5: [2.98, 4.63] };
const READING_OFFSET_PP = 0.20; // §7.1.10.0
const R2_MIN_DROP = 4; // pp, AC-237
const R3_MAX_DROP = 15; // pp, AC-238
const TAP_RATE_CEILING = 1.25; // /s, AC-233 — at EVERY band now, not only band 5
const AC240_MIN_RISE = 20; // pp
const AC240_HEADROOM_CEILING = 80; // pp — above this a 20 pp rise cannot be asked for
// AC-247's fourth clause. THE THRESHOLD MOVED 2 % -> 3 % AND ITS DIRECTION BECAME PART OF THE
// CRITERION. Round 8 measured drift of 1.95 % and 2.08 % at bands 4 and 5 against a `< 2 %`
// requirement — a miss of 0.08 pp at one band — and what the miss exposed is that the clause
// was TWO-SIDED when the rule it guards is ONE-SIDED. D3 says a car that has just appeared is
// glanced at NEXT rather than last; a reordered sweep that skips no one glances slightly MORE
// often, because a newly spawned car is glanced at on the tick it appears rather than up to a
// cursor-cycle later. Drift upward is the rule working. Drift DOWNWARD would mean captures are
// displacing ordinary glances — the free-attention repair §7.1.8 rejects twice — and that is
// what this clause exists to catch.
const AC247_MAX_GLANCE_DRIFT = 3; // %
const AC240_MIN_P_RATIO = 2.0; // x, AC-240's `p` form — primary in round 9

/**
 * `P(Binomial(N, p) <= 2)` — the clear rate a per-car error of `p` implies under the model
 * (generation.md §7.1.10). Written out rather than summed so it is exact and cheap.
 */
function clearRateModel(N, p) {
  const q = 1 - p;
  return q ** N * (1 + (N * p) / q + ((N * (N - 1)) / 2) * (p / q) ** 2);
}

/** The inverse: the `p` at which the model clears at `S`. Bisection, 200 steps. */
function invertClearRate(N, S) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const m = (lo + hi) / 2;
    if (clearRateModel(N, m) > S) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/**
 * The transcribed windows are re-derived from `N` and §7.2.2's clear-rate targets, so that a
 * transcription error fails here instead of quietly becoming the expectation. It is the one
 * derivation in this file that is allowed to compute its own expectation, because both inputs
 * are design values and neither comes from the code under test.
 *
 * IT FINDS ONE DISAGREEMENT IN THE DESIGN AND REPORTS IT RATHER THAN PICKING A SIDE.
 * generation.md §7.1.10's table gives band 2 as `N = 46`, model `1.47 -> 2.82`; §6.1.3, §7.2.4
 * and AC-221–AC-225 all give band 2 as `N = 45`, whose inversion is `1.50 -> 2.88` and whose
 * reading window is `1.30 -> 2.68` — which is exactly what §7.2.4 and AC-225 print. So
 * §7.1.10's band-2 row is a round-8 leftover and the rest of the design is self-consistent at
 * `N = 45`.
 */
function checkWindows() {
  const notes = [];
  for (let band = 1; band <= 5; band += 1) {
    const N = N_BY_BAND[band];
    const [lo, hi] = CLEAR_TARGET[band];
    const pEasy = hi === null ? 0 : 100 * invertClearRate(N, hi / 100);
    const pHard = 100 * invertClearRate(N, lo / 100);
    const model = P_WINDOW_MODEL[band];
    const reading = P_WINDOW[band];
    if (Math.abs(pEasy - model[0]) > 0.02 || Math.abs(pHard - model[1]) > 0.02) {
      notes.push(`band ${band}: model window re-derives as ${pEasy.toFixed(2)}–${pHard.toFixed(2)}, transcribed ${model[0].toFixed(2)}–${model[1].toFixed(2)}`);
    }
    const wantReading = [Math.max(0, model[0] - READING_OFFSET_PP), model[1] - READING_OFFSET_PP];
    if (Math.abs(wantReading[0] - reading[0]) > 0.02 || Math.abs(wantReading[1] - reading[1]) > 0.02) {
      notes.push(`band ${band}: reading window should be model - ${READING_OFFSET_PP} pp = ${wantReading[0].toFixed(2)}–${wantReading[1].toFixed(2)}, transcribed ${reading[0].toFixed(2)}–${reading[1].toFixed(2)}`);
    }
  }
  return notes;
}

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
  let lostOnTheBell = 0; // AC-122's tie: the third life spent on tick 7,199
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
    // AC-231's SECOND CLAUSE IS WRONG AND ROUND 9'S SWEEP IS WHERE IT WAS FOUND. It says
    // "every run that reaches `phase === 'lost'` has `state.tick < 7200`". A run that spends
    // its third life on tick 7,199 does not: step 5 checks `lives` BEFORE the clock
    // (gameplay.md §2.5), so the phase is 'lost', and step 6 still increments, so the final
    // tick is 7,200. That is precisely the tie AC-122 and AC-802 REQUIRE to resolve as a loss
    // — "resolving it as a clear would mean the last tick of the level is the one tick on
    // which a misroute is free" — so AC-231 forbids the outcome AC-122 mandates.
    //
    // Measured: band 5, seed 2900, over 3,000 seeds. It is unreachable at a band that rarely
    // loses, which is why round 8 never saw it: band 5 cleared 87.5 % then and clears 71.2 %
    // now, so there are more third misroutes for one of them to land on the bell.
    //
    // What is checked instead is the statement that is true at every band and still catches a
    // level that ran long: no run of either kind EXCEEDS 7,200 ticks, and a lost run reaching
    // exactly 7,200 is counted and reported rather than failed.
    if (!r.cleared && r.state.tick > LEVEL_TICKS) endedTickWrong += 1;
    if (!r.cleared && r.state.tick === LEVEL_TICKS) lostOnTheBell += 1;
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
    lostOnTheBell,
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
  console.log(`# Unconstrained bot — ${seeds} seeds per band (AC-220, AC-250)\n`);
  const rows = [];
  const inFlightsClean = {};
  for (const band of bands) {
    const r = runBand(band, seeds, 'unconstrained');
    const N = N_BY_BAND[band];
    const medianOk = Math.abs(r.delivered.median - N) <= 1;
    // AC-250 is asserted HERE and not in the constrained sweep, for the reason in the column
    // comment below: only an unconstrained run is guaranteed to contribute all 7,200 ticks.
    const cifOk = Math.abs(r.inFlight - CARS_IN_FLIGHT[r.band]) <= CARS_IN_FLIGHT_TOL;
    const ok = r.clearPct === 100 && r.misroutes === 0 && medianOk && r.overRunTicks === 0
      && r.endedTickWrong === 0 && r.spawnShortfall === 0 && cifOk;
    if (!ok) failures += 1;
    inFlightsClean[r.band] = r.inFlight;
    rows.push({
      band: r.band,
      'reached the bell': r.clearPct.toFixed(1) + '%',
      misroutes: r.misroutes,
      stalled: r.stalled,
      'delivered min/med/max': r.delivered.min + '/' + r.delivered.median + '/' + r.delivered.max,
      'N (§6.1)': N,
      // AC-250, measured where it is CLEAN. An unconstrained run always reaches the bell, so
      // every run contributes all 7,200 ticks; a constrained run that loses contributes only
      // its opening, which is the part of a level with the fewest cars on the board, so the
      // constrained figure is biased DOWNWARD by however often the bot loses. The design calls
      // cars in flight "a property of the geometry, not of the bot" — this is the column where
      // that is true without a caveat.
      'cars in flight': r.inFlight.toFixed(2),
      'AC-250 want': CARS_IN_FLIGHT[r.band].toFixed(2),
      'in flight at the bell': r.inFlightAtEnd.n ? r.inFlightAtEnd.min + '-' + r.inFlightAtEnd.max : '-',
      'tick !== 7200': r.endedTickWrong,
      'schedule unconsumed': r.spawnShortfall,
      'AC-250': cifOk ? 'PASS' : 'FAIL',
      'AC-220': ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  if (bands.length === 5) {
    const seq = bands.map((b) => inFlightsClean[b]);
    const monotone = seq.every((v, i) => i === 0 || v > seq[i - 1]);
    if (!monotone) failures += 1;
    console.log('\nAC-250 · cars in flight, strictly increasing across bands 1 -> 5: '
      + (monotone ? 'PASS' : 'FAIL') + '  [' + seq.map((v) => v.toFixed(2)).join(' / ') + ']');
    console.log('round 8 read 2.72 / 3.70 / 3.74 / 3.77 / 3.66 — flat from band 2 and FALLING from 4');
    console.log('to 5, which is why three of four R2 pairs failed (generation.md §6.1.1).');
  }
  console.log('\n"delivered" is per car: every car that ARRIVES is delivered, with zero misroutes.');
  console.log('Cars still in flight when the clock stops are discarded without scoring (AC-133),');
  console.log('which is why delivered is N and not the spawn count.');
} else if (has('ac240')) {
  // AC-240 — the fault injection required by development-process.md:136. Every ATTENTION
  // constraint removed, every TIMING constraint kept. If nothing moves when attention is made
  // free, the instrument is not measuring attention, whatever the constants are called.
  //
  // THE `p` FORM IS PRIMARY AND THE CLEAR-RATE FORM IS SECONDARY, AND ROUND 9 SWAPPED THEIR
  // ORDER. Under round 8's table the clear-rate form asserted at NO BAND — every band cleared
  // above the 80 % headroom ceiling — so a criterion whose whole job is to prove the instrument
  // is sensitive reported `n/a` five times out of five. `p` has no such ceiling: it is a
  // per-decision rate, it is not amplified by the binomial threshold, and it moves whether or
  // not the clear rate has room to.
  console.log(`# AC-240 — instrument sensitivity, ${seeds} seeds per band\n`);
  console.log('sweep: ' + sweepLabel);
  console.log('injected: workingSet=Infinity, acquire=0, switchTicks=0, memory=Infinity');
  console.log('kept:     minTapGap=11, lockout=6, safeWindow=20, scan=6, urgency=90, lapse=3%\n');
  const rows = [];
  const ratios = {};
  for (const band of bands) {
    const base = runBand(band, seeds, 'constrained', { sweepMode });
    const free = runBand(band, seeds, 'constrained', { attention: BOT_NO_ATTENTION, sweepMode });
    const rise = free.clearPct - base.clearPct;
    // The `p` form. Band 1 is excluded for the same reason it is excluded from the clear-rate
    // clause: at p = 0.30 % over 32 cars there is nothing to be sensitive to.
    const ratio = free.p > 0 ? base.p / free.p : Infinity;
    const pAsserts = band >= 2;
    const pOk = ratio >= AC240_MIN_P_RATIO;
    if (pAsserts && !pOk) failures += 1;
    if (pAsserts) ratios[band] = ratio;
    // The clear-rate form's headroom clause. A 20 pp rise needs 20 pp of headroom, so the test
    // is meaningless wherever the unmodified bot already clears above 80 % — that is a ceiling,
    // not insensitivity. Any band AT OR BELOW 80 % that does not rise 20 pp is a real failure.
    const hasHeadroom = base.clearPct <= AC240_HEADROOM_CEILING;
    const ok = rise >= AC240_MIN_RISE;
    if (hasHeadroom && !ok) failures += 1;
    rows.push({
      band,
      'bot §7.1 p': base.p.toFixed(2) + '%',
      'attention-free p': free.p.toFixed(2) + '%',
      'p ratio (PRIMARY, ≥ 2.0x)': Number.isFinite(ratio) ? ratio.toFixed(2) + 'x' : 'inf',
      'AC-240 p form': pAsserts ? (pOk ? 'PASS' : 'FAIL') : 'n/a (band 1)',
      'bot §7.1 clear': base.clearPct.toFixed(1) + '%',
      'attention free clear': free.clearPct.toFixed(1) + '%',
      rise: (rise >= 0 ? '+' : '') + rise.toFixed(1) + ' pp',
      'AC-240 clear form (≥20 pp)': hasHeadroom ? (ok ? 'PASS' : 'FAIL') : 'n/a (no headroom)',
    });
  }
  console.log(table(rows));
  // The `p` ratio must also be MONOTONE INCREASING across bands 2 to 5 — the instrument gets
  // more sensitive as the board fills, which is the shape the attention model predicts.
  const seq = bands.filter((b) => b >= 2).map((b) => ratios[b]);
  const monotone = seq.length < 2 || seq.every((v, i) => i === 0 || v > seq[i - 1]);
  if (!monotone) failures += 1;
  console.log('\n  p ratio across bands 2-5 : ' + seq.map((v) => v.toFixed(2)).join(' / '));
  console.log('  monotone increasing      : ' + (monotone ? 'PASS' : 'FAIL'));
  console.log('  §7.2.4 expects           : 1.40 / 2.89 / 4.18 / 6.52 / 7.11 x (bands 1-5)');
  console.log('  and clear-rate rises of  : -0.1 / +7.7 / +14.6 / +22.5 / +30.5 pp');
  console.log('');
  console.log(`A band whose unmodified rate is above ${AC240_HEADROOM_CEILING} % is reported n/a on the CLEAR-RATE`);
  console.log('form and is not a failure; any band at or below it that fails to rise 20 pp is. The');
  console.log('`p` form has no ceiling to hide behind and asserts at bands 2-5 unconditionally, which');
  console.log('is why round 9 made it the primary statement.');
} else if (has('lives-distribution')) {
  // generation.md §8 / §6.1.5. The reference game tightens lives with level — three early, two
  // at 11-12, one at 13 and up — and this design uses a flat three. That is the only axis in
  // it that had never been tried, so round 9 tried it.
  //
  // UNDER A PER-BAND LIFE COUNT THE GOVERNING MODEL STOPS BEING `P(Bin(N, p) <= 2)` AND
  // BECOMES `P(Bin(N, p) < lives)`. At one life it is `(1-p)^N`, which is a DIFFERENT CURVE,
  // not a shifted one. So the honest way to measure it is not to invert anything: run the bot
  // with the life cap removed, take the measured misroute DISTRIBUTION, and read the clear
  // rate at every life count straight off it.
  //
  // Nothing in the game changes. `LIVES` is 3 and stays 3 (gameplay.md §4.1); the harness
  // gives the run a life count no run can spend so that it always reaches the bell.
  console.log(`# Lives as a lever — ${seeds} seeds per band, life cap REMOVED (generation.md §6.1.5)\n`);
  console.log('LIVES is 3 and is not changed. The run is given a life count no run can spend, so');
  console.log('every run reaches the bell and `misrouted` is the honest count of what the bot did.\n');
  const rows = [];
  for (const band of bands) {
    const misroutes = [];
    let arrivals = 0;
    let misTotal = 0;
    for (let seed = 0; seed < seeds; seed += 1) {
      const level = generate(seed, band);
      const r = playLevel(level, 'constrained', { sweepMode, uncappedLives: true });
      misroutes.push(r.state.misrouted);
      misTotal += r.state.misrouted;
      arrivals += r.state.delivered + r.state.misrouted;
    }
    const clearAt = (lives) => (100 * misroutes.filter((m) => m < lives).length) / misroutes.length;
    const mean = misTotal / misroutes.length;
    rows.push({
      band,
      N: N_BY_BAND[band],
      'measured p': ((100 * misTotal) / (arrivals || 1)).toFixed(2) + '%',
      'mean misroutes': mean.toFixed(2),
      '@ 4 lives': clearAt(4).toFixed(1) + '%',
      '@ 3 lives (SHIPPED)': clearAt(3).toFixed(1) + '%',
      '@ 2 lives': clearAt(2).toFixed(1) + '%',
      '@ 1 life': clearAt(1).toFixed(1) + '%',
      'one life is worth': (clearAt(3) - clearAt(2)).toFixed(1) + ' pp',
    });
  }
  console.log(table(rows));
  console.log('\n§6.1.5 expects mean misroutes 0.09 / 0.90 / 1.36 / 1.57 / 1.87 and clear rates at');
  console.log('3 lives of 100.0 / 92.3 / 84.0 / 78.7 / 71.2 %.');
  console.log('');
  console.log('ONE LIFE IS WORTH 16 TO 26 PERCENTAGE POINTS OF CLEAR RATE AT THIS LADDER\'S `p`, and');
  console.log('R3 caps a band-to-band step at 15. So a life step on its own always breaks R3, at');
  console.log('every pair, and the only way to use it is to loosen the band\'s parameters by the same');
  console.log('16-26 pp in the other direction at the same time — which is a REDUCTION IN CARS ON');
  console.log('SCREEN, the thing the owner asked for more of. The two axes the owner named are in');
  console.log('direct conflict at the sizes the ladder admits, and round 9 takes density.');
  console.log('');
  console.log('This is generation.md §7.4.2 item L and it goes to the OWNER, not to the designer:');
  console.log('the priced alternative is a BAND 6 at levels 30+ with 2 lives and band 4\'s density —');
  console.log('an extra rung past band 5, not a re-tune of it, so R2/R3 between bands 1-5 are');
  console.log('untouched. "Does the ceiling feel like a ceiling" is not a question the bot can answer.');
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
    // SIGNED, because round 9's clause is one-sided. Positive = the capture arm glances MORE.
    const drift = (100 * (gOn - gRr)) / gRr;
    const c = r.cap;
    // AC-247's first clause, as reworded: the IDENTITY captures === distinct cars captured,
    // bounded above by the cars that spawned. `captures > 0` is the guard against the whole
    // column passing by measuring nothing.
    const oncePerCar = c.captures > 0 && c.captures <= c.spawned && c.multiPerTick === 0
      && c.captures === c.distinct && c.captures === c.glancedDistinct;
    const cursorHeld = c.cursorMoved === 0;
    const fullGlance = c.shortGlance === 0 && c.oddBusy === 0;
    // AC-247 clause 4, round 9: magnitude UNDER 3 %, AND the capture arm glancing no FEWER
    // times than the round-robin arm. Drift upward is the rule working — a reordered sweep
    // that skips no one glances slightly more often, because a newly spawned car is glanced at
    // on the tick it appears rather than up to a cursor-cycle later. Drift DOWNWARD would mean
    // captures are DISPLACING ordinary glances, which is the free-attention repair §7.1.8
    // rejects twice, and that is what this clause exists to catch. "The sign clause is what
    // actually carries the check."
    const budget = Math.abs(drift) < AC247_MAX_GLANCE_DRIFT && drift >= 0;
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
      'drift % (signed)': (drift >= 0 ? '+' : '') + drift.toFixed(2),
      '4. |drift| < 3 % AND >= 0': budget ? 'PASS' : 'FAIL' + (drift < 0 ? ' (NEGATIVE — captures are displacing glances)' : ' (over 3 %)'),
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
  console.log('4. the control is the same seeds under a pure round-robin sweep. The threshold moved');
  console.log('   2 % -> 3 % in round 9 and its DIRECTION became part of the criterion. Round 8');
  console.log('   measured 1.95 % and 2.08 % at bands 4 and 5 against a two-sided `< 2 %` — a miss of');
  console.log('   0.08 pp at one band — and what the miss exposed is that the clause was two-sided');
  console.log('   when the rule it guards is one-sided. 3 % is 1.5x the largest drift round 8');
  console.log('   produced; the sign clause is what actually carries the check.');
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
  console.log('');
  console.log('AC-246 IS A REGRESSION WITNESS WITH AN EXPECTATION OF PASSING, NOT A DISCRIMINATING');
  console.log('GUARD, and round 9 says so rather than leaving it looking sharp. The fault §8 names');
  console.log('for it — round 3\'s pure round-robin with no onset capture — PASSES AT EVERY BAND now.');
  console.log('That is not the guard catching something; it is V14 having removed the defect the');
  console.log('guard was guarding. With row 0 forced to a pass the cold first-decision deadline is');
  console.log('93-146 ticks against a round-robin scan cycle of 16-23, so a bot that looks at cars in');
  console.log('a fixed rotation still reaches every new car in time. The gap it used to open is');
  console.log('ARITHMETICALLY UNAVAILABLE.');
  console.log('');
  console.log('BOTH ARMS ARE THEREFORE RUN AT EVERY BAND AND BOTH ARE EXPECTED TO PASS. A FAILURE OF');
  console.log('EITHER IS THE FINDING. What the criterion is still for: it is the only check in the');
  console.log('design that can fail EARLY — the quantity is per-decision and unamplified — and it is');
  console.log('what would detect V14 being weakened or removed, deliberately or by accident, which is');
  console.log('a live risk precisely because the rule looks cosmetic from inside the generator.');
  console.log('');
  console.log('development-process.md:136 is satisfied ELSEWHERE for this sweep: the fault the');
  console.log('INSTRUMENT can still be made to fail is `firstDecisionTicks` being shortened, which');
  console.log('AC-245 injects (tools/generator-audit.mjs). This line is the record that the injection');
  console.log('named here no longer bites, so a green run is not read as evidence that it does.');
  console.log('');
  const rows = [];
  const ac246 = [];
  const altGaps = [];
  for (const band of bands) {
    const r = runBand(band, seeds, 'constrained', { sweepMode, measureDecisions: true });
    // The round-robin arm, run at EVERY band whatever `--roundrobin` says, because AC-246 is
    // now a two-arm regression witness rather than a guard with an injection behind it.
    const rr = sweepMode === SWEEP_ROUND_ROBIN
      ? r
      : runBand(band, seeds, 'constrained', { sweepMode: SWEEP_ROUND_ROBIN, measureDecisions: true });
    const lvl = generate(0, band);
    // The first-decision transit: ENTRY_LEN + rowH, in ticks. Computed from the level's own
    // geometry rather than tabled, and cross-checked against firstDecisionTicks() by
    // generator-audit, which is where AC-245's floor is asserted.
    const transit = Math.ceil(((ENTRY_LEN + lvl.rowH) * 1000) / CAR_SPEED);
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
    const e = rr.dec;
    const rrFirst = (100 * e.firstBad) / (e.firstN || 1);
    const rrLater = (100 * e.laterBad) / (e.laterN || 1);
    const rrGap = rrFirst - rrLater;
    const rrOk = e.firstN > 0 && e.laterN > 0 && rrGap <= ceiling;
    if (!rrOk) failures += 1;
    ac246.push({
      band,
      N: N_BY_BAND[band],
      'first decisions': d.firstN,
      p_first: pFirst.toFixed(2) + '%',
      'later decisions': d.laterN,
      p_later: pLater.toFixed(2) + '%',
      'gap pp': (gap >= 0 ? '+' : '') + gap.toFixed(2),
      'ceiling 0.25×(2/N)': ceiling.toFixed(2),
      'AC-246 (D3 arm)': ok ? 'PASS' : 'FAIL',
      'round-robin gap pp': (rrGap >= 0 ? '+' : '') + rrGap.toFixed(2),
      'AC-246 (round-robin arm)': rrOk ? 'PASS (expected)' : 'FAIL — THE FINDING',
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
  const windowNotes = checkWindows();
  if (windowNotes.length) {
    console.log('WINDOW SELF-CHECK — the transcribed windows disagree with their own derivation:');
    for (const n of windowNotes) console.log('  ' + n);
    console.log('');
  }
  const rows = [];
  const pcts = {};
  const inFlights = {};
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
    // AC-241 / §7.1.10.0: the measured `p` is judged against the READING window only. Reading
    // it against the model window is the single most likely way to get this model wrong, and
    // round 8's sweep did exactly that at three bands.
    const pVerdict = r.p < P_WINDOW[band][0] ? 'BELOW'
      : r.p > P_WINDOW[band][1] ? 'ABOVE' : 'in window';
    if (pVerdict !== 'in window') failures += 1;
    // AC-250 — the board's occupancy. `transit / interval`, and neither term depends on how
    // well the bot plays, so it is the FIRST thing to read when a clear rate is wrong.
    const cifOk = Math.abs(r.inFlight - CARS_IN_FLIGHT[band]) <= CARS_IN_FLIGHT_TOL;
    inFlights[band] = r.inFlight;
    rows.push({
      band: r.band,
      cleared: r.clearPct.toFixed(1) + '%',
      'target §7.2': targetText(band),
      verdict: ok ? 'in band' : r.clearPct < CLEAR_TARGET[band][0] ? 'BELOW' : 'ABOVE',
      'per-car p': r.p.toFixed(2) + '%',
      'reading window §7.1.10.0': P_WINDOW[band][0].toFixed(2) + '–' + P_WINDOW[band][1].toFixed(2) + '%',
      'p verdict': pVerdict,
      'model window (do not judge)': P_WINDOW_MODEL[band][0].toFixed(2) + '–' + P_WINDOW_MODEL[band][1].toFixed(2) + '%',
      'cars in flight': r.inFlight.toFixed(2),
      'AC-250 want ±0.05': CARS_IN_FLIGHT[band].toFixed(2),
      'AC-250 (report)': cifOk ? 'in band' : 'low — see below',
      'delivered med/p10': r.delivered.median + '/' + percentileOf(r.delivered, 0.1),
      'band §7.3': dlo + '–' + dhi,
      'AC-226…230': dOk ? 'PASS' : 'out',
      'taps/s': r.tapRate.mean.toFixed(2),
      'AC-233 (≤1.25)': tapOk ? 'PASS' : 'FAIL',
      'AC-231': clockOk ? 'PASS' : 'FAIL',
      'lost on the bell (AC-122 tie)': r.lostOnTheBell,
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

  if (bands.length === 5) {
    console.log('\n## AC-250 — cars in flight is what the ladder escalates\n');
    const seq = bands.map((b) => inFlights[b]);
    const monotone = seq.every((v, i) => i === 0 || v > seq[i - 1]);
    if (!monotone) failures += 1;
    console.log('  measured : ' + seq.map((v) => v.toFixed(2)).join(' / '));
    console.log('  §6.1     : ' + bands.map((b) => CARS_IN_FLIGHT[b].toFixed(2)).join(' / '));
    console.log('  round 8  : 2.72 / 3.70 / 3.74 / 3.77 / 3.66  — flat from band 2, FALLING 4 -> 5');
    console.log('  strictly increasing: ' + (monotone ? 'PASS' : 'FAIL'));
    console.log('');
    console.log('THE CONSTRAINED FIGURE IS BIASED LOW AND THE BIAS IS NOT NOISE. A run that loses');
    console.log('contributes only its opening — the part of a level with the fewest cars on the');
    console.log('board — so the tick-weighted mean is pulled down by however often the bot fails,');
    console.log('which is most at the hardest bands. AC-250 is therefore ASSERTED on the');
    console.log('unconstrained sweep (--unconstrained), where every run contributes all 7,200 ticks,');
    console.log('and reported here. The design calls this quantity "a property of the geometry, not');
    console.log('of the bot"; that is only literally true of the untruncated measurement.');
    console.log('');
    console.log('This is the quantity round 8 held constant without noticing, which is why three of');
    console.log('four R2 pairs failed. It is `transit / interval` and neither term depends on how well');
    console.log('the bot plays, so if it is right and the clear rate is not, the fault is in the bot or');
    console.log('the topology; if it is wrong, nothing downstream of it means anything.');
  }

  console.log('');
  console.log('Near-miss column: two cars on DIFFERENT terminal edges feeding the SAME depot,');
  console.log('measured centre-to-centre in LU from the real orthogonal geometry, against');
  console.log('CAR_L = 104. gameplay.md §4.5 does not cover this case; §4.5b and AC-513 do, and');
  console.log('tools/converge.mjs is where it is measured properly.');
}

process.exit(failures === 0 ? 0 : 1);
