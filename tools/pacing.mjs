#!/usr/bin/env node
// tools/pacing.mjs — completion-time distribution per difficulty band.
//
//   node tools/pacing.mjs [--seeds 1000] [--policy nearest]
//
// Measures what generation.md §7.3 and gameplay.md §5.3 assert: the median and p95 of the
// constrained bot's simulated duration per band, and the 130 s absolute ceiling of AC-231,
// which applies to every run at every band, cleared or not.

import { generate } from '../src/engine/index.js';
import { playLevel } from './lib/solver.mjs';
import { arg, summary, table } from './lib/report.mjs';

// generation.md §7.3
const TARGET = {
  1: { nominal: 49.1, lo: 42, hi: 62, p95: 68 },
  2: { nominal: 67.0, lo: 58, hi: 78, p95: 86 },
  3: { nominal: 79.0, lo: 70, hi: 92, p95: 100 },
  4: { nominal: 92.9, lo: 84, hi: 106, p95: 114 },
  5: { nominal: 108.8, lo: 98, hi: 122, p95: 126 },
};
const CEILING = 130;

const seeds = Number(arg('seeds', 1000));
const policy = String(arg('policy', 'nearest'));

console.log(`# Completion time — ${seeds} seeds per band, constrained bot, policy '${policy}'\n`);

const rows = [];
let failures = 0;
let worst = 0;
let worstWhere = '';

for (let band = 1; band <= 5; band += 1) {
  const cleared = [];
  const all = [];
  for (let seed = 0; seed < seeds; seed += 1) {
    const r = playLevel(generate(seed, band), 'constrained', { policy });
    all.push(r.seconds);
    if (r.cleared) cleared.push(r.seconds);
    if (r.seconds > worst) { worst = r.seconds; worstWhere = `band ${band} seed ${seed}`; }
  }
  const t = TARGET[band];
  const s = summary(cleared);
  const inBand = s.median >= t.lo && s.median <= t.hi;
  const p95ok = s.p95 <= t.p95;
  const ceilingOk = Math.max(...all) <= CEILING;
  if (!inBand || !p95ok || !ceilingOk) failures += 1;
  rows.push({
    band,
    'cleared runs': s.n,
    nominal: t.nominal.toFixed(1),
    median: s.median.toFixed(1),
    'median band': t.lo + '–' + t.hi,
    median_ok: inBand ? 'PASS' : 'FAIL',
    p95: s.p95.toFixed(1),
    'p95 ceiling': t.p95,
    p95_ok: p95ok ? 'PASS' : 'FAIL',
    'max, any run': Math.max(...all).toFixed(1),
    'AC-231 (130 s)': ceilingOk ? 'PASS' : 'FAIL',
  });
}

console.log(table(rows));
console.log(`\nslowest run anywhere: ${worst.toFixed(1)} s (${worstWhere}), ceiling ${CEILING} s`);
console.log(failures === 0 ? 'PACING: PASS' : `PACING: FAIL (${failures} band(s) outside §7.3)`);
process.exit(failures === 0 ? 0 : 1);
