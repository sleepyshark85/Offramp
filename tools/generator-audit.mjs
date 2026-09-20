#!/usr/bin/env node
// tools/generator-audit.mjs — structural validity of generated networks (generation.md §8).
//
//   node tools/generator-audit.mjs --seeds 5000
//   node tools/generator-audit.mjs --seeds 200 --inject V2
//   node tools/generator-audit.mjs --rule-injection            AC-244
//   node tools/generator-audit.mjs --actionable --seeds 3000   AC-243
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
  RULE_ORDER,
  RULES,
  actionableJunctions,
  firstDecisionTicks,
  generate,
  pathDepths,
  signature,
  validate,
} from '../src/engine/index.js';
import { lazyOptimal } from './lib/oracle.mjs';
import { arg, percentile, summary, table } from './lib/report.mjs';

const FIRST_DECISION_FLOOR = 40; // AC-245, gameplay.md §4.6b

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
  let actionable = 0;
  for (const n of nodes) {
    if (n.kind !== 'branch') continue;
    const L = reach[edges[n.out[0]].to];
    const R2 = reach[edges[n.out[1]].to];
    if ([...L].sort().join() === [...R2].sort().join()) bad.push('V6');
    // V13, stated as set containment rather than as a bitmask, so the two implementations
    // share nothing but the design.
    const lInR = [...L].every((c) => R2.has(c));
    const rInL = [...R2].every((c) => L.has(c));
    if (!lInR && !rInL) actionable += 1;
  }

  const P = BANDS[level.band];
  if (actionable < P.Ja) bad.push('V13');
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

/**
 * AC-244 — one fixture per rule, each built to violate THAT rule, with the rule's own check
 * invoked directly rather than through validate()'s ordered cascade.
 *
 * Eight of the twelve rules never reject anything tryBuild produces (generation.md §5.2), so
 * this is the only place their checks are ever executed against a violation. Running them
 * through the cascade does not do it: an earlier rule catches the fixture first, which is
 * exactly why slice 1's blind pass could not make V5 or V9 fire from any single-edge mutation
 * of 200 band-3 levels. Several fixtures below deliberately violate more than one rule; that
 * is harmless here and impossible to avoid, because the rules are not independent — what
 * matters is that the NAMED rule's own predicate returns true on its own fixture and false on
 * the pristine level.
 */
const RULE_FIXTURES = {
  // A depot with an outgoing edge. Depots are sinks; a car that leaves one never resolves.
  V1: (l) => {
    const depot = l.nodes.find((n) => n.kind === 'depot');
    l.edges.push({ id: l.edges.length, from: depot.id, to: 0, lengthMlu: 1000, shape: 'straight' });
    depot.out.push(l.edges.length - 1);
  },
  // Two sources on one route row pointing at the same target: the targets stop increasing.
  V2: (l) => retargetToMerge(l),
  // The same fixture seen as a merge: a non-depot node with in-degree 2.
  V3: (l) => retargetToMerge(l),
  // An edge that moves two columns in one row.
  V4: (l) => { l.nodes[l.edges[1].to].col += 3; },
  // Nothing is reachable from the entry, so no depot is.
  V5: (l) => { l.nodes[0].out = []; },
  // Every depot the same colour, so both branches of every junction reach the same set.
  V6: (l) => { for (const n of l.nodes) if (n.kind === 'depot') n.depotColour = 0; },
  // A level that draws no junctions at all is outside every band's J range.
  V7: (l) => { l.junctions = []; },
  // Every route node a branch, so every path is R junctions deep — past every band's Dmax.
  V8: (l) => {
    for (const n of l.nodes) if (n.kind === 'pass') n.kind = 'branch';
  },
  // Two nodes on one lattice site.
  V9: (l) => {
    const a = l.nodes.find((n) => n.row === 0);
    const b = l.nodes.find((n) => n.row === 1);
    b.row = a.row;
    b.col = a.col;
  },
  // A colour outside the band's first K palette entries.
  V10: (l) => { l.nodes.find((n) => n.kind === 'depot').depotColour = 4; },
  // Two junction centres on top of each other.
  V11: (l) => {
    const js = l.junctions.map((id) => l.nodes[id]);
    js[1].x = js[0].x;
    js[1].y = js[0].y;
  },
  // Every junction decorative: with one depot colour, no two branch sets are incomparable,
  // so the actionable count is 0 and every band's Ja floor is missed.
  V13: (l) => { for (const n of l.nodes) if (n.kind === 'depot') n.depotColour = 0; },
};

function retargetToMerge(l) {
  const row = l.nodes.filter((n) => n.row === 0 || n.row === 1);
  const srcs = l.nodes.filter((n) => n.row === 1).sort((a, b) => a.col - b.col);
  const target = srcs[0];
  const donor = l.edges.find((e) => l.nodes[e.to].row === 1 && e.to !== target.id);
  if (!donor) throw new Error('fixture needs a row-1 node to retarget; row size ' + row.length);
  donor.to = target.id;
}

function ruleInjection() {
  console.log('# AC-244 — every validity rule proven able to fire, invoked directly\n');
  const rows = [];
  let bad = 0;
  for (const id of RULE_ORDER) {
    // Band 4: five columns and five rows, so every fixture below has the nodes it needs.
    const P = BANDS[4];
    const pristine = JSON.parse(JSON.stringify(generate(11, 4)));
    const clean = RULES[id](pristine, P);
    const broken = JSON.parse(JSON.stringify(pristine));
    RULE_FIXTURES[id](broken);
    const fires = RULES[id](broken, P);
    // What validate() says about the same fixture, to show which rule the cascade reaches
    // first — the reason the direct invocation is required rather than merely tidier.
    const cascade = validate(broken, P);
    const ok = clean === false && fires === true;
    if (!ok) bad += 1;
    rows.push({
      rule: id,
      'on a valid level': clean === false ? 'accepts' : 'REJECTS',
      'on its own fixture': fires === true ? 'rejects' : 'ACCEPTS',
      'validate() cascade reports': cascade === null ? '(nothing)' : cascade,
      verdict: ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  const viaCascade = rows.filter((r) => r['validate() cascade reports'] === r.rule).length;
  console.log(`\n${viaCascade} of ${rows.length} fixtures are ALSO caught by validate() under the`);
  console.log('rule they were built for; the rest are caught by an earlier rule first, which is');
  console.log('why AC-244 requires the direct invocation.');
  console.log(bad === 0 ? 'RULE INJECTION: PASS' : `RULE INJECTION: FAIL (${bad} rule(s))`);
  process.exit(bad === 0 ? 0 : 1);
}

/**
 * AC-243 — actionable J measured per run rather than assumed from the band table, using
 * generation.md §6.2's lazy-optimal oracle. The junctions the oracle never flips are the
 * junctions the level never asked about.
 */
function actionableReport(seeds) {
  console.log(`# Actionable junctions — ${seeds} seeds per band, lazy-optimal oracle (AC-243)\n`);
  const rows = [];
  let bad = 0;
  for (let band = 1; band <= 5; band += 1) {
    const P = BANDS[band];
    const live = [];
    const drawn = [];
    const twice = [];
    const staticJa = [];
    let belowJa = 0;
    let belowJaMinusOne = 0;
    let notCleared = 0;
    let misrouted = 0;
    for (let seed = 0; seed < seeds; seed += 1) {
      const level = generate(seed, band);
      const r = lazyOptimal(level);
      if (!r.cleared) notCleared += 1;
      misrouted += r.misrouted;
      live.push(r.liveCount);
      drawn.push(r.drawn);
      twice.push(r.flippedTwicePlus);
      staticJa.push(actionableJunctions(level).length);
      if (r.liveCount < P.Ja) belowJa += 1;
      if (r.liveCount < P.Ja - 1) belowJaMinusOne += 1;
    }
    const L = summary(live);
    const D = summary(drawn);
    const T = summary(twice);
    const S = summary(staticJa);
    const belowPct = (100 * belowJa) / seeds;
    // AC-243: live >= Ja - 1 in 100 % of runs, and >= Ja in at least 95 %.
    const ok = belowJaMinusOne === 0 && belowPct <= 5 && notCleared === 0 && misrouted === 0;
    if (!ok) bad += 1;
    rows.push({
      band,
      Ja: P.Ja,
      'drawn J mean': D.mean.toFixed(2),
      'static actionable mean/min': S.mean.toFixed(2) + '/' + S.min,
      'live mean/min': L.mean.toFixed(2) + '/' + L.min,
      'flipped 2x+ mean/min': T.mean.toFixed(2) + '/' + T.min,
      'below Ja': belowPct.toFixed(1) + '%',
      'below Ja-1': ((100 * belowJaMinusOne) / seeds).toFixed(1) + '%',
      'decorative % of drawn': (100 * (1 - S.mean / D.mean)).toFixed(1) + '%',
      'oracle misroutes': misrouted,
      'AC-243': ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  console.log('\n"static actionable" is V13/AC-242 — the count of junctions whose two colour sets are');
  console.log('incomparable. "live" is AC-243 — the count the lazy-optimal oracle actually flipped on');
  console.log('this seed\'s spawn order. live < static is a SPAWN-ORDER effect, not a topology one: a');
  console.log('junction can be structurally actionable and still never be exercised, and no static');
  console.log('rule removes that residue. It is bounded, and reporting it is what keeps it visible.');
  console.log(bad === 0 ? 'ACTIONABLE: PASS' : `ACTIONABLE: FAIL (${bad} band(s))`);
  process.exit(bad === 0 ? 0 : 1);
}

const seeds = Number(arg('seeds', 5000));
const injectRule = arg('inject', null);

if (process.argv.includes('--rule-injection')) ruleInjection();
if (process.argv.includes('--actionable')) actionableReport(seeds);

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
  let minFirstDecision = Infinity;
  const jaDist = Object.create(null);

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

    const fdt = firstDecisionTicks(level);
    if (fdt < minFirstDecision) minFirstDecision = fdt;
    const ja = actionableJunctions(level).length;
    jaDist[ja] = (jaDist[ja] || 0) + 1;

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
  // AC-245: the cheapest possible check on the quantity that went unmeasured through two
  // slices. The minimum is the entry-edge transit, because rows[0] holds one node.
  const fdOk = minFirstDecision >= FIRST_DECISION_FLOOR;
  if (!injectRule && (exhausted || violationText !== 'none' || !distinctOk || !attemptsOk || !fdOk)) failures += 1;

  rows.push({
    band,
    generated: seeds - exhausted,
    GEN_EXHAUSTED: exhausted,
    'attempts med/p95/max': `${percentile(attempts, 0.5)}/${percentile(attempts, 0.95)}/${attempts[attempts.length - 1]}`,
    'distinct networks': topo.size,
    'with colours': sigs.size,
    'J dist': Object.entries(jDist).map(([k, v]) => `${k}:${Math.round((100 * v) / seeds)}%`).join(' '),
    'Ja dist': Object.entries(jaDist).map(([k, v]) => `${k}:${Math.round((100 * v) / seeds)}%`).join(' '),
    'min firstDecision': minFirstDecision,
    'AC-245 (>= 40)': fdOk ? 'PASS' : 'FAIL',
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
console.log('        AC-234 variety (only asserted at --seeds 3000 or more; reported always),');
console.log('        AC-242 (V13, via both rule sets), AC-245 (first-decision floor of 40 ticks).');
console.log('see also: --rule-injection (AC-244) and --actionable (AC-243).');
console.log(failures === 0 && disagreements === 0 ? 'GENERATOR AUDIT: PASS' : 'GENERATOR AUDIT: FAIL');
process.exit(failures === 0 && disagreements === 0 ? 0 : 1);
