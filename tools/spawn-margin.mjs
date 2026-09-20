#!/usr/bin/env node
// tools/spawn-margin.mjs — AC-139, the margin the spawn schedule keeps.
//
//   node tools/spawn-margin.mjs --seeds 2000
//   node tools/spawn-margin.mjs --seeds 200 --shrink 3   inject: cut the slack and watch it fail
//
// gameplay.md §2.7 derives SPAWN_SLACK rather than choosing it, because every lever in
// generation.md §7.4 moves a term in the derivation and a lever pull that walks through the
// margin does not fail anything by itself — slice 1 shipped a flat 8 that had eroded to a
// margin of ONE car at band 5, with 30 of 5,000 band-5 seeds one spawn interval from an
// uncaught SPAWN_EXHAUSTED in the middle of a level the player was winning.
//
// The reference here is an oracle router — perfect routing, unlimited taps — in both its
// shortest-path and its longest-path variant, with the LIVES - 1 = 2 misroutes a winning run
// is allowed injected at the first two opportunities. The margin must be at least 2 in EVERY
// run at EVERY band. Re-run after every §7.4 lever move.

import { BANDS, generate, spawnSlack } from '../src/engine/index.js';
import { routeOracle } from './lib/oracle.mjs';
import { arg, table } from './lib/report.mjs';

const MIN_MARGIN = 2;
const VARIANTS = ['shortest', 'longest'];

const seeds = Number(arg('seeds', 2000));
// Fault injection (development-process.md:136): shrink the schedule by N cars and the margin
// must fail. Nothing else in this harness changes.
const shrink = Number(arg('shrink', 0));

console.log(`# Spawn margin — ${seeds} seeds per band, both oracle variants, ` +
  `${2} misroutes injected (AC-139)` + (shrink ? `\n# INJECTING: schedule shortened by ${shrink}` : '') + '\n');

const rows = [];
let failures = 0;
let worstAnywhere = { margin: Infinity };

for (let band = 1; band <= 5; band += 1) {
  const P = BANDS[band];
  let worst = { margin: Infinity };
  let maxSpawnUsed = 0;
  let notCleared = 0;
  let injectedShort = 0;
  const marginCounts = new Map();

  for (let seed = 0; seed < seeds; seed += 1) {
    for (const variant of VARIANTS) {
      const level = generate(seed, band);
      if (shrink) level.spawns = level.spawns.slice(0, level.spawns.length - shrink);
      let r;
      try {
        r = routeOracle(level, variant);
      } catch (e) {
        // A SPAWN_EXHAUSTED throw is the failure this margin exists to keep at bay; count it
        // as a margin of 0 rather than letting the harness die on it.
        failures += 1;
        console.log(`  band ${band} seed ${seed} ${variant}: ${String(e.message).slice(0, 120)}`);
        continue;
      }
      if (!r.cleared) notCleared += 1;
      if (r.injected < 2) injectedShort += 1;
      if (r.maxNextSpawn > maxSpawnUsed) maxSpawnUsed = r.maxNextSpawn;
      marginCounts.set(r.margin, (marginCounts.get(r.margin) || 0) + 1);
      if (r.margin < worst.margin) worst = { ...r, seed, variant };
    }
  }

  const ok = worst.margin >= MIN_MARGIN;
  if (!ok) failures += 1;
  if (worst.margin < worstAnywhere.margin) worstAnywhere = { ...worst, band };

  rows.push({
    band,
    'SPAWN_COUNT': P.quota + spawnSlack(band),
    'slack': spawnSlack(band),
    'worst max(nextSpawn)': maxSpawnUsed,
    'worst margin': worst.margin,
    'at': `seed ${worst.seed} ${worst.variant}`,
    'margin distribution': [...marginCounts.entries()].sort((a, b) => a[0] - b[0])
      .map(([m, n]) => m + ':' + n).join(' '),
    'runs not cleared': notCleared,
    'runs <2 misroutes injected': injectedShort,
    'AC-139 (>= 2)': ok ? 'PASS' : 'FAIL',
  });
}

console.log(table(rows));
console.log(`\nworst margin anywhere: ${worstAnywhere.margin} ` +
  `(band ${worstAnywhere.band}, seed ${worstAnywhere.seed}, ${worstAnywhere.variant} variant)`);
console.log(failures === 0 ? 'SPAWN MARGIN: PASS' : `SPAWN MARGIN: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
