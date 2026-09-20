#!/usr/bin/env node
// tools/generator-audit.mjs — structural validity of generated networks (generation.md §8).
//
//   node tools/generator-audit.mjs --seeds 5000
//   node tools/generator-audit.mjs --seeds 200 --inject V2
//
// Every band x seed is generated and then checked TWICE: once with the engine's own
// validate() (the production rule set) and once with the independent re-implementation
// below, which shares no code with it. The second is not a duplicate statistic to keep in
// sync (development-process.md §6.3) — it is the check on the first, and --inject proves it
// can fail before it is trusted to pass (§6.2).

import {
  BANDS,
  GEN_STATS,
  MIN_JUNCTION_SEP_LU,
  PALETTE,
  generate,
  pathDepths,
  signature,
  validate,
} from '../src/engine/index.js';
import { arg, percentile, table } from './lib/report.mjs';

/** Independent structural re-check. Returns a list of rule ids it believes are violated. */
function independentCheck(level) {
  const bad = [];
  const { nodes, edges, R, C, K } = level;
  const inDeg = new Array(nodes.length).fill(0);
  const outDeg = new Array(nodes.length).fill(0);
  for (const e of edges) {
    inDeg[e.to] += 1;
    outDeg[e.from] += 1;
  }

  for (const n of nodes) {
    if (n.kind === 'depot') {
      if (outDeg[n.id] !== 0 || inDeg[n.id] < 1) bad.push('V1');
    } else if (outDeg[n.id] < 1 || outDeg[n.id] > 2) bad.push('V1');
    if (n.kind !== 'depot' && inDeg[n.id] > 1) bad.push('V3');
    if (n.kind === 'branch' && outDeg[n.id] !== 2) bad.push('V1');
  }

  // V2 / V4, plus planarity stated as the crossing test of §2.5.
  const rowEdges = new Map();
  for (const e of edges) {
    const a = nodes[e.from];
    const b = nodes[e.to];
    if (b.row !== a.row + 1 || Math.abs(b.col - a.col) > 1) bad.push('V4');
    if (!rowEdges.has(a.row)) rowEdges.set(a.row, []);
    rowEdges.get(a.row).push([a.col, b.col]);
  }
  for (const [row, list] of rowEdges) {
    for (const [a, b] of list) for (const [a2, b2] of list) if (a < a2 && b > b2) bad.push('V2');
    if (row < 0) continue;
    const ordered = list.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]).map((p) => p[1]);
    const terminal = row === R - 1;
    for (let i = 1; i < ordered.length; i += 1) {
      if (terminal ? ordered[i] < ordered[i - 1] : ordered[i] <= ordered[i - 1]) bad.push('V2');
    }
  }

  // V5 reachability.
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    for (const eid of nodes[stack.pop()].out) {
      const t = edges[eid].to;
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  const depots = nodes.filter((n) => n.kind === 'depot');
  if (depots.length !== K) bad.push('V5');
  for (const d of depots) if (!seen.has(d.id)) bad.push('V5');

  // V6 decisiveness, from an independently computed colour set.
  const reach = nodes.map(() => new Set());
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i];
    if (n.kind === 'depot') reach[i].add(n.depotColour);
    else for (const eid of n.out) for (const c of reach[edges[eid].to]) reach[i].add(c);
  }
  for (const n of nodes) {
    if (n.kind !== 'branch') continue;
    const l = [...reach[edges[n.out[0]].to]].sort().join();
    const r = [...reach[edges[n.out[1]].to]].sort().join();
    if (l === r) bad.push('V6');
  }

  const P = BANDS[level.band];
  const J = nodes.filter((n) => n.kind === 'branch').length;
  if (J !== level.junctions.length) bad.push('V7');
  if (J < P.Jmin || J > P.Jmax) bad.push('V7');
  for (const d of pathDepths(level)) if (d < P.Dmin || d > P.Dmax) bad.push('V8');

  const sites = new Set();
  const perRow = new Map();
  for (const n of nodes) {
    const key = n.row + '/' + n.col;
    if (sites.has(key)) bad.push('V9');
    sites.add(key);
    perRow.set(n.row, (perRow.get(n.row) || 0) + 1);
  }
  for (const [row, count] of perRow) if (row >= 0 && count > C) bad.push('V9');

  const colours = depots.map((n) => n.depotColour).sort((a, b) => a - b);
  if (colours.join() !== [...Array(K).keys()].join()) bad.push('V10');
  if (K > PALETTE.length) bad.push('V10');

  const js = nodes.filter((n) => n.kind === 'branch');
  for (let i = 0; i < js.length; i += 1) {
    for (let j = i + 1; j < js.length; j += 1) {
      const d = Math.hypot(js[i].x - js[j].x, js[i].y - js[j].y);
      if (d < MIN_JUNCTION_SEP_LU) bad.push('V11');
    }
  }
  return [...new Set(bad)];
}

/** Corrupt a level so the audit has to catch it (development-process.md §6.2). */
function inject(rule, level) {
  const l = JSON.parse(JSON.stringify(level));
  if (rule === 'V1') {
    // Give a depot an outgoing edge: depots must have out-degree 0.
    const depot = l.nodes.find((n) => n.kind === 'depot');
    l.edges.push({ id: l.edges.length, from: depot.id, to: 0, lengthMlu: 1000, shape: 'straight' });
  }
  else if (rule === 'V2' || rule === 'V3') {
    const target = l.nodes.find((n) => n.row === 1);
    const donor = l.edges.find((e) => l.nodes[e.to].row === 1 && e.to !== target.id);
    if (donor) donor.to = target.id;
  } else if (rule === 'V4') l.nodes[l.edges[1].to].col += 3;
  else if (rule === 'V5') l.K += 1; // claims a colour that has no depot
  else if (rule === 'V10') l.nodes.find((n) => n.kind === 'depot').depotColour = 4;
  else throw new Error('no injection for ' + rule);
  // out lists must follow the edge list for the check to see the same graph.
  for (const n of l.nodes) n.out = l.edges.filter((e) => e.from === n.id).map((e) => e.id);
  return l;
}

const seeds = Number(arg('seeds', 5000));
const injectRule = arg('inject', null);

console.log(`# Generator audit — ${seeds} seeds x 5 bands` +
  (injectRule ? `, INJECTING ${injectRule}` : '') + '\n');

const rows = [];
let failures = 0;
let disagreements = 0;
let caught = 0;

for (let band = 1; band <= 5; band += 1) {
  const P = BANDS[band];
  const attempts = [];
  const sigs = new Set();
  const topo = new Set();
  const violations = Object.create(null);
  const jDist = Object.create(null);
  let exhausted = 0;
  let depths = [Infinity, -Infinity];
  let sharedDepotLevels = 0;
  let maxDepotInDegree = 0;

  for (let seed = 0; seed < seeds; seed += 1) {
    let level;
    try {
      level = generate(seed, band);
    } catch (e) {
      exhausted += 1;
      continue;
    }
    attempts.push(GEN_STATS.attempts);
    if (injectRule) level = inject(String(injectRule), level);

    const engineSays = validate(level, P);
    const auditSays = independentCheck(level);
    if ((engineSays === null) !== (auditSays.length === 0)) disagreements += 1;
    if (engineSays !== null || auditSays.length) {
      caught += 1;
      const id = engineSays || auditSays[0];
      violations[id] = (violations[id] || 0) + 1;
    }

    sigs.add(signature(level));
    topo.add(signature(level).split('|').slice(0, 2).join('|'));
    const J = level.junctions.length;
    jDist[J] = (jDist[J] || 0) + 1;
    for (const d of pathDepths(level)) {
      depths[0] = Math.min(depths[0], d);
      depths[1] = Math.max(depths[1], d);
    }
    const inDeg = new Map();
    for (const e of level.edges) {
      if (level.nodes[e.to].kind === 'depot') inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }
    const maxIn = Math.max(...inDeg.values());
    if (maxIn > 1) sharedDepotLevels += 1;
    if (maxIn > maxDepotInDegree) maxDepotInDegree = maxIn;
  }

  attempts.sort((a, b) => a - b);
  const violationText = Object.keys(violations).length
    ? Object.entries(violations).map(([k, v]) => k + ':' + v).join(' ')
    : 'none';
  // AC-234 states the variety floor over 3,000 levels per band; below that the sample, not
  // the generator, would be the limit, so it is reported but not failed.
  const distinctOk = seeds < 3000 || (band === 1 ? topo.size >= 30 : topo.size >= 500);
  const attemptsOk = percentile(attempts, 0.5) <= 8 && attempts[attempts.length - 1] <= 128;
  if (!injectRule && (exhausted || violationText !== 'none' || !distinctOk || !attemptsOk)) failures += 1;

  rows.push({
    band,
    generated: seeds - exhausted,
    GEN_EXHAUSTED: exhausted,
    'attempts med/p95/max': `${percentile(attempts, 0.5)}/${percentile(attempts, 0.95)}/${attempts[attempts.length - 1]}`,
    'distinct networks': topo.size,
    'with colours': sigs.size,
    'J dist': Object.entries(jDist).map(([k, v]) => `${k}:${Math.round((100 * v) / seeds)}%`).join(' '),
    D: depths[0] + '–' + depths[1],
    violations: violationText,
    'levels w/ shared depot': `${Math.round((100 * sharedDepotLevels) / seeds)}%`,
    'max depot in-degree': maxDepotInDegree,
  });
}

console.log(table(rows));
console.log('');
console.log(`engine validate() vs independent re-check: ${disagreements} disagreement(s)`);

if (injectRule) {
  const ok = caught > 0 && disagreements === 0;
  console.log(`injected ${injectRule}: ${caught} level(s) rejected`);
  console.log(ok ? 'INJECTION TEST: PASS (the audit fails when it should)' : 'INJECTION TEST: FAIL');
  process.exit(ok ? 0 : 1);
}

console.log('checks: AC-203 (no exhaustion, median attempts <= 8, max <= 128), AC-211, AC-212,');
console.log('        AC-234 variety (only asserted at --seeds 3000 or more; reported always)');
console.log(failures === 0 && disagreements === 0 ? 'GENERATOR AUDIT: PASS' : 'GENERATOR AUDIT: FAIL');
process.exit(failures === 0 && disagreements === 0 ? 0 : 1);
