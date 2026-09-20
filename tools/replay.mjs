#!/usr/bin/env node
// tools/replay.mjs — run a seed headless, print it as ASCII, and prove it replays.
//
//   node tools/replay.mjs --seed 42 [--band 3] [--frames 8]
//
// A run is {seed, band, inputs:[{tick,junctionId}]} and nothing else (CLAUDE.md §3). This
// harness replays one twice in this process and once in a freshly spawned process, and deep
// -compares all three. A mismatch exits non-zero: determinism outranks every other finding.

import { execFileSync } from 'node:child_process';
import { deepStrictEqual } from 'node:assert';

import { PALETTE, createState, generate, step } from '../src/engine/index.js';
import { playLevel } from './lib/solver.mjs';
import { buildCurves, carPoint } from './lib/curve.mjs';
import { arg, has } from './lib/report.mjs';

const GLYPH = ['E', 'S', 'R', 'T', 'I']; // Ember, Sky, Rose, Teal, Iris

function fingerprint(s) {
  return JSON.stringify({
    tick: s.tick, phase: s.phase, rng: s.rng, cars: s.cars, open: Array.from(s.open),
    nextSpawn: s.nextSpawn, delivered: s.delivered, misrouted: s.misrouted,
    lives: s.lives, score: s.score, streak: s.streak, bestStreak: s.bestStreak,
  });
}

/** Replay a recorded run, optionally capturing frames. */
function replayRun(run, capture) {
  const level = generate(run.seed, run.band);
  const byTick = new Map();
  for (const i of run.inputs) {
    if (!byTick.has(i.tick)) byTick.set(i.tick, []);
    byTick.get(i.tick).push(i);
  }
  let s = createState(level);
  const frames = [];
  while (s.phase === 'running' && s.tick < 20000) {
    s = step(s, byTick.get(s.tick) || []);
    if (capture && capture.has(s.tick)) frames.push({ tick: s.tick, state: s });
  }
  return { level, state: s, frames };
}

// --- ASCII -------------------------------------------------------------------------------

const W = 61;
const H = 33;

function ascii(level, state) {
  const grid = Array.from({ length: H }, () => new Array(W).fill(' '));
  const px = (x) => Math.round((x / 1000) * (W - 1));
  const py = (y) => Math.round((y / 1600) * (H - 1));
  const put = (x, y, ch, force) => {
    const c = px(x);
    const r = py(y);
    if (r < 0 || r >= H || c < 0 || c >= W) return;
    if (force || grid[r][c] === ' ') grid[r][c] = ch;
  };

  const curves = buildCurves(level);
  for (const e of level.edges) {
    for (let i = 0; i <= 64; i += 1) {
      const pt = carPoint(curves, { edgeId: e.id, progress: Math.round((i / 64) * e.lengthMlu) });
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      put(pt[0], pt[1], b.col === a.col ? '|' : b.col > a.col ? '\\' : '/');
    }
  }
  for (const n of level.nodes) {
    if (n.kind === 'branch') put(n.x, n.y, state.open[n.junctionId] ? '>' : '<', true);
    else if (n.kind === 'depot') put(n.x, n.y, GLYPH[n.depotColour].toLowerCase(), true);
    else if (n.kind === 'entry') put(n.x, n.y, '#', true);
  }
  for (const car of state.cars) {
    const pt = carPoint(curves, car);
    put(pt[0], pt[1], GLYPH[car.colour], true);
  }
  const lines = grid.map((row) => row.join('').replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// --- child mode --------------------------------------------------------------------------

if (has('emit')) {
  const run = JSON.parse(process.argv[process.argv.indexOf('--emit') + 1]);
  process.stdout.write(fingerprint(replayRun(run).state));
  process.exit(0);
}

// --- main --------------------------------------------------------------------------------

const seed = Number(arg('seed', 42));
const band = Number(arg('band', 3));
const frameCount = Number(arg('frames', 6));

const level = generate(seed, band);
const bot = playLevel(level, 'constrained');
const run = { seed, band, inputs: bot.inputs };

const capture = new Set();
for (let i = 1; i <= frameCount; i += 1) {
  capture.add(Math.max(1, Math.round((bot.ticks * i) / (frameCount + 1))));
}

const a = replayRun(run, capture);
const b = replayRun(run);
const childOut = execFileSync(
  process.execPath,
  ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', new URL(import.meta.url).pathname, '--emit', JSON.stringify(run)],
  { encoding: 'utf8' },
);

console.log(`Offramp replay — seed ${seed}, band ${band}`);
console.log(`network: ${level.nodes.length} nodes, ${level.edges.length} edges, ` +
  `${level.junctions.length} junctions, ${level.K} colours, quota ${level.quota}`);
console.log(`run: ${run.inputs.length} taps over ${bot.ticks} ticks (${bot.seconds.toFixed(2)} s)`);
console.log('legend: # entry, < / > junction (open branch), UPPER-case car, lower-case depot,');
console.log('        ' + PALETTE.map((hex, i) => GLYPH[i] + '=' + hex).join(' ') + '\n');

for (const f of a.frames) {
  console.log(`--- tick ${f.tick}  (${(f.tick / 60).toFixed(2)} s)  ` +
    `delivered ${f.state.delivered}/${level.quota}  lives ${f.state.lives}  score ${f.state.score}`);
  console.log(ascii(level, f.state));
  console.log('');
}

console.log(`--- final: ${a.state.phase} at tick ${a.state.tick}, score ${a.state.score}, ` +
  `delivered ${a.state.delivered}, misrouted ${a.state.misrouted}, lives ${a.state.lives}`);
console.log(ascii(level, a.state));

let ok = true;
try {
  deepStrictEqual(a.state, b.state);
  console.log('\nreplay 1 vs replay 2 (same process): identical');
} catch (e) {
  ok = false;
  console.log('\nreplay 1 vs replay 2 (same process): DIFFERENT\n' + e.message);
}
if (childOut === fingerprint(a.state)) {
  console.log('replay 1 vs replay 3 (separate node process): identical');
} else {
  ok = false;
  console.log('replay 1 vs replay 3 (separate node process): DIFFERENT');
  console.log('  here : ' + fingerprint(a.state).slice(0, 300));
  console.log('  child: ' + childOut.slice(0, 300));
}
console.log(ok ? '\nDETERMINISM: PASS' : '\nDETERMINISM: FAIL');
process.exit(ok ? 0 : 1);
