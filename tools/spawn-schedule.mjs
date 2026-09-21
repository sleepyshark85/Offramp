#!/usr/bin/env node
// tools/spawn-schedule.mjs — AC-139, AC-123, AC-114, AC-115, AC-808.
//
//   node tools/spawn-schedule.mjs --seeds 2000
//   node tools/spawn-schedule.mjs --seeds 200 --truncate 3   inject: cut the schedule short
//
// THIS REPLACES tools/spawn-margin.mjs, WHICH MEASURED A MARGIN THAT NO LONGER EXISTS.
// Under a quota the number of cars a level needed was a guess — it depended on how many the
// player misrouted and how many were still in flight when the quota-completing car landed —
// so `SPAWN_SLACK` was derived from three quantities and an oracle sweep over 2,000 seeds in
// two variants measured whether it had eroded. Slice 1 found it down to ONE car at band 5.
//
// Under a clock the count is not a guess. It is the exact list of cars that fit in two
// minutes (gameplay.md §2.7, §8.4), and what used to need an oracle is now an IDENTITY that
// a single generated level checks:
//
//   * every scheduled tick is < LEVEL_TICKS, and ticks strictly increase;
//   * spawns[i].index === i, with no `i` skipped for which the nominal slot fits;
//   * spawns.length is the closed form, or one fewer (the last nominal slot can be pushed
//     past the clock by its own jitter draw);
//   * in a run driven to the bell, `nextSpawn === spawns.length` — every scheduled car
//     entered (AC-123).
//
// EXPECTATIONS ARE TRANSCRIBED FROM THE DESIGN, not imported from the module under test
// (development-process.md §6.8).

import { LEVEL_TICKS, generate } from '../src/engine/index.js';
import { lazyOptimal } from './lib/oracle.mjs';
import { arg, table } from './lib/report.mjs';

// gameplay.md §2.1 and §2.7, transcribed.
const DESIGN_LEVEL_TICKS = 7200;
const DESIGN_SPAWN_LEAD = 90;
// generation.md §6.1 — interval, jitter. gameplay.md §2.7 — the SPAWN_COUNT upper bound.
const DESIGN = {
  1: { interval: 204, jitter: 26, countMax: 35, K: 3 },
  2: { interval: 150, jitter: 18, countMax: 48, K: 3 },
  3: { interval: 140, jitter: 18, countMax: 51, K: 4 },
  4: { interval: 132, jitter: 16, countMax: 54, K: 4 },
  5: { interval: 128, jitter: 16, countMax: 56, K: 5 },
};

const seeds = Number(arg('seeds', 2000));
// Fault injection (development-process.md:136): drop the last N entries and the closed-form
// check and the bell identity must both fail. Nothing else in this harness changes.
const truncate = Number(arg('truncate', 0));

if (LEVEL_TICKS !== DESIGN_LEVEL_TICKS) {
  console.log(`LEVEL_TICKS is ${LEVEL_TICKS}, the design says ${DESIGN_LEVEL_TICKS}`);
  process.exit(1);
}

console.log(`# Spawn schedule — ${seeds} seeds per band (AC-139, AC-123, AC-114, AC-115)` +
  (truncate ? `\n# INJECTING: last ${truncate} entries removed` : '') + '\n');

const rows = [];
let failures = 0;

for (let band = 1; band <= 5; band += 1) {
  const D = DESIGN[band];
  let lengthBad = 0;
  let orderBad = 0;
  let pastClock = 0;
  let indexBad = 0;
  let skipped = 0;
  let minGap = Infinity;
  let leadBad = 0;
  let bellShortfall = 0;
  let bellRuns = 0;
  let colourRunBad = 0;
  let colourSpreadBad = 0;
  let minLen = Infinity;
  let maxLen = 0;

  for (let seed = 0; seed < seeds; seed += 1) {
    const level = generate(seed, band);
    if (truncate) level.spawns = level.spawns.slice(0, level.spawns.length - truncate);
    const sp = level.spawns;
    minLen = Math.min(minLen, sp.length);
    maxLen = Math.max(maxLen, sp.length);

    // AC-139 clause 3 — the closed form, or one fewer.
    if (sp.length !== D.countMax && sp.length !== D.countMax - 1) lengthBad += 1;

    // The first car enters at SPAWN_LEAD, jittered (gameplay.md §2.7).
    if (Math.abs(sp[0].tick - DESIGN_SPAWN_LEAD) > D.jitter) leadBad += 1;

    for (let i = 0; i < sp.length; i += 1) {
      if (sp[i].index !== i) indexBad += 1;
      if (sp[i].tick >= DESIGN_LEVEL_TICKS) pastClock += 1;
      if (i > 0) {
        const gap = sp[i].tick - sp[i - 1].tick;
        if (gap <= 0) orderBad += 1;
        if (gap < minGap) minGap = gap;
      }
    }

    // AC-139 clause 4 — no `i` skipped for which the nominal slot fits inside the clock. The
    // schedule's ticks are jittered, so the check is on the COUNT of slots the loop should
    // have offered, which is the closed form; a skipped `i` shows up as a short array with the
    // last tick well inside the clock, which the length clause above catches. What this adds
    // is the one-sided statement the length clause cannot make: the last entry must sit within
    // one interval-plus-jitter of the bell (AC-808's shape).
    const last = sp[sp.length - 1];
    if (DESIGN_LEVEL_TICKS - last.tick > D.interval + 2 * D.jitter) skipped += 1;

    // AC-115 — no three consecutive entries share a colour, and within one level the
    // most-used colour's count exceeds the least-used by at most 1.
    for (let i = 2; i < sp.length; i += 1) {
      if (sp[i].colour === sp[i - 1].colour && sp[i].colour === sp[i - 2].colour) colourRunBad += 1;
    }
    const counts = new Array(D.K).fill(0);
    for (const s of sp) counts[s.colour] += 1;
    if (Math.max(...counts) - Math.min(...counts) > 1) colourSpreadBad += 1;

    // AC-123 — in a run that REACHES THE BELL, every scheduled car entered. It has to be a
    // run that reaches it: a never-tapping run loses three lives long before 7,200 ticks
    // (AC-814), so driving the level with no inputs would make this clause observe nothing and
    // report green — the §6.8 trap exactly. The lazy-optimal oracle delivers every car, so its
    // runs always reach the bell. Only the first few seeds per band: 7,200 steps each.
    if (seed < 20) {
      const r = lazyOptimal(level);
      if (r.state.phase !== 'ended') continue;
      bellRuns += 1;
      if (r.state.nextSpawn !== level.spawns.length) bellShortfall += 1;
    }
  }

  // `bellRuns > 0` is the observation guard: a clause that never ran is a failure, not a pass.
  const ok = lengthBad === 0 && orderBad === 0 && pastClock === 0 && indexBad === 0
    && leadBad === 0
    && skipped === 0 && bellRuns > 0 && bellShortfall === 0 && colourRunBad === 0
    && colourSpreadBad === 0 && minGap >= D.interval - 2 * D.jitter;
  if (!ok) failures += 1;
  rows.push({
    band,
    'closed form': D.countMax,
    'measured length': minLen === maxLen ? String(minLen) : minLen + '-' + maxLen,
    'length ≠ form or form-1': lengthBad,
    'index ≠ i': indexBad,
    'tick >= 7200': pastClock,
    'non-increasing': orderBad,
    'first tick ≠ 90±jitter': leadBad,
    'min gap': minGap,
    'AC-114 floor': D.interval - 2 * D.jitter,
    'stops short of the bell': skipped,
    'runs that reached the bell': bellRuns,
    'schedule unconsumed (AC-123)': bellShortfall,
    'AC-115 runs of 3': colourRunBad,
    'AC-115 spread > 1': colourSpreadBad,
    verdict: ok ? 'PASS' : 'FAIL',
  });
}

console.log(table(rows));
console.log('\nThe "closed form" is floor((7200 - 1 - 90 + jitter) / interval) + 1 from');
console.log('gameplay.md §2.7, transcribed. A seed measures that or one fewer, because the last');
console.log('nominal slot can be pushed past the clock by its own jitter draw.');

if (truncate) {
  const caught = failures > 0;
  console.log('\nINJECTION "truncate ' + truncate + '": ' +
    (caught ? 'CAUGHT — the harness fails, so these checks can fail.'
            : 'NOT CAUGHT — these checks cannot fail and are worthless.'));
  process.exit(caught ? 0 : 1);
}

console.log(failures === 0 ? 'SPAWN SCHEDULE: PASS' : `SPAWN SCHEDULE: FAIL (${failures} band(s))`);
process.exit(failures === 0 ? 0 : 1);
