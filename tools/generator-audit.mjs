#!/usr/bin/env node
// tools/generator-audit.mjs — structural validity of generated networks (generation.md §8).
//
//   node tools/generator-audit.mjs --seeds 5000
//   node tools/generator-audit.mjs --seeds 200 --inject V2
//   node tools/generator-audit.mjs --rule-injection            AC-244
//   node tools/generator-audit.mjs --actionable --seeds 3000   AC-243
//   node tools/generator-audit.mjs --geometry --seeds 3000     AC-206, AC-207, §2.5
//   node tools/generator-audit.mjs --geometry --no-rule-p      the fault injection for it
//
// Every band x seed is generated and then checked TWICE: once with the engine's own
// validate() (the production rule set) and once with the independent re-implementation
// below, which shares no code with it. The second is not a duplicate statistic to keep in
// sync (development-process.md §6.3) — it is the check on the first, and --inject proves it
// can fail before it is trusted to pass (§6.2).

import {
  CAR_SPEED,
  BANDS,
  ENTRY_LEN,
  GEN_SALT,
  GEN_STATS,
  MIN_JUNCTION_SEP_LU,
  PALETTE,
  RULE_ORDER,
  RULES,
  actionableJunctions,
  finalise,
  firstDecisionTicks,
  generate,
  makeStream,
  mix32,
  pathDepths,
  signature,
  validate,
} from '../src/engine/index.js';
import { lazyOptimal } from './lib/oracle.mjs';
import { arg, has, percentile, summary, table } from './lib/report.mjs';

// AC-245, gameplay.md §4.6b. TRANSCRIBED from the design, not derived here.
//
// THE FLOOR WAS 40 AND IT WAS WRONG. Round 4 raised ENTRY_LEN 100 -> 160 LU, taking the band-5
// first decision to 717 ms, and this check certified it at 43 ticks against 40. The owner then
// played it and could not make the decision. The old floor was derived from the BOT'S OWN
// constants and priced one decision made in isolation; §7.1.7 had already established, in the
// same round, that the binding term is the LATENCY TO STARTING the decision, which grows with
// traffic. The new floor of 90 prices both terms, and it is met by V14 — a whole row — rather
// than by ENTRY_LEN (development-process.md §6.9).
const FIRST_DECISION_FLOOR = 90;
// The per-band minimum AC-245 requires exactly: ENTRY_LEN + rowH in ticks, because V14 makes
// rows[0] a pass and V15 makes a pass node's edge vertical, so rows[1] holds one node too.
//
// TRANSCRIBED FROM gameplay.md §4.6b's ROUND-9 TABLE — 159 / 159 / 146 / 146 / 146 — and NOT
// from AC-245's own sentence, which still quotes round 8's `159 / 151 / 132 / 125 / 120`.
// Those were computed with the per-band speed column that round 9 deleted: at one constant
// 2750 MLU/tick the window is `ceil((220 + rowH) * 1000 / 2750)`, which is 159 at rowH 216 and
// 146 at rowH 180, and §4.6b's whole point is that the WORST case rose from 2.00 s to 2.43 s.
// AC-245's numbers are the one place the criterion was not re-derived; §4.6b and §6.1.4 agree
// with each other and with this, and gameplay.md §4.8's table has the same stale row.
const FIRST_DECISION_MIN = { 1: 159, 2: 159, 3: 146, 4: 146, 5: 146 };
// generation.md §6.1, transcribed. The audit compares the level object against THESE, never
// against the code's own constants (development-process.md §6.8, the AC-202 lesson).
const BAND_TABLE = {
  1: { C: 3, K: 3, R: 5, colW: 300, rowH: 216, interval: 208, jitter: 21, Ja: 3 },
  2: { C: 4, K: 4, R: 5, colW: 264, rowH: 216, interval: 147, jitter: 15, Ja: 3 },
  3: { C: 4, K: 4, R: 6, colW: 264, rowH: 180, interval: 140, jitter: 14, Ja: 4 },
  4: { C: 5, K: 5, R: 6, colW: 198, rowH: 180, interval: 131, jitter: 13, Ja: 5 },
  5: { C: 6, K: 6, R: 6, colW: 158, rowH: 180, interval: 128, jitter: 13, Ja: 7 },
};
// gameplay.md §2.2 / generation.md §6.1 — speed left the band table in round 9 and is one
// constant at every band. Transcribed, like everything else here.
const DESIGN_CAR_SPEED = 2750;
// AC-234's variety floors, over 3,000 seeds per band.
const SIGNATURE_FLOOR = { 1: 160, 2: 250, 3: 360, 4: 490, 5: 1000 };

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

  // V2 / V4, plus the ordering rule §2.5's lemmas rest on.
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

  // V14 — the row-0 node is a pass. V15 — a pass or entry node's one edge has Δcol = 0.
  // Both are re-stated here from the design rather than shared with src/engine/.
  const row0 = nodes.filter((n) => n.row === 0);
  if (row0.length !== 1 || row0[0].kind !== 'pass') bad.push('V14');
  for (const n of nodes) {
    if (n.kind !== 'pass' && n.kind !== 'entry') continue;
    if (n.out.length !== 1 || nodes[edges[n.out[0]].to].col !== n.col) bad.push('V15');
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
    // Out-degree is V1's business, and a level whose kinds and out-degrees disagree is one
    // this loop must SKIP rather than crash on: `--inject V14` relabels a one-edge node as a
    // branch, and reading `n.out[1]` there threw a TypeError and took the whole audit with it.
    // An independent re-check that dies on a malformed level cannot report on one.
    if (n.kind !== 'branch' || n.out.length !== 2) continue;
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
    // The row has to hold MORE THAN ONE NODE, and under V14 + V15 rows 0 and 1 both hold
    // exactly one — row 0 is a pass by construction and a pass node's edge is vertical, so
    // row 1 cannot be wider. This used to hard-code row 1 and silently injected nothing.
    retargetToMerge(l);
  } else if (rule === 'V4') l.nodes[l.edges[1].to].col += 3;
  else if (rule === 'V14') l.nodes.find((n) => n.row === 0).kind = 'branch';
  else if (rule === 'V15') {
    const pass = l.nodes.find((n) => n.kind === 'pass' && n.out.length === 1);
    l.nodes[l.edges[pass.out[0]].to].col += 1;
  }
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
    const b = l.nodes.find((n) => n.row === 2);
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
  // V14 — a branch at row 0. `buildRow`'s forcePass makes this unreachable through generate()
  // by any amount of seed sweeping, so this fixture is the ONLY place the check is ever
  // executed against a violation (AC-248's second clause).
  V14: (l) => { l.nodes.find((n) => n.row === 0).kind = 'branch'; },
  // V15 — a pass node whose single edge changes column. Same class: `passOptions = [[a]]` is
  // the only place a pass option comes from, so no seed produces this (AC-249's third clause).
  V15: (l) => {
    const p = l.nodes.find((n) => n.kind === 'pass' && n.out.length === 1);
    l.nodes[l.edges[p.out[0]].to].col += 1;
  },
};

/**
 * Point a second edge at a route-row node, which is simultaneously V2's "targets stopped
 * increasing" and V3's "a non-depot node with in-degree 2".
 *
 * The row it does this on has to hold MORE THAN ONE NODE, and under V14 + V15 rows 0 and 1
 * both hold exactly one: row 0 is a pass by construction, and a pass node's edge is vertical,
 * so row 1 cannot be wider than row 0. This used to hard-code row 1 and it now finds the first
 * row that can take the fixture.
 */
function retargetToMerge(l) {
  const rows = [...new Set(l.nodes.filter((n) => n.row > 0 && n.row < l.R).map((n) => n.row))]
    .sort((a, b) => a - b);
  for (const row of rows) {
    const srcs = l.nodes.filter((n) => n.row === row).sort((a, b) => a.col - b.col);
    if (srcs.length < 2) continue;
    const target = srcs[0];
    const donor = l.edges.find((e) => l.nodes[e.to].row === row && e.to !== target.id);
    if (!donor) continue;
    donor.to = target.id;
    return;
  }
  throw new Error('fixture needs a route row with two nodes; rows ' + rows.join(','));
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
    const belowMinusOnePct = (100 * belowJaMinusOne) / seeds;
    // AC-243, ROUND 9: live >= Ja - 1 in at least 99.5 % of runs, and >= Ja in at least 95 %.
    //
    // THE FIRST FLOOR MOVED FROM 100 % TO 99.5 % AND THAT IS A CORRECTION, NOT A RELAXATION.
    // Round 8 measured a miss at band 5 of about 3 runs in 3,000. A criterion stated at 100 %
    // over 3,000 seeds is one that fails on a one-in-a-thousand tail — and this AC's own note
    // already explains why such a tail exists and why no static rule removes it: a junction
    // can be structurally actionable and still not be exercised by one particular colour
    // sequence. A 100 % floor on a quantity whose residue is acknowledged to be irreducible
    // is a floor that will fail on a large enough sample and say nothing when it does.
    // 99.5 % over 3,000 seeds still fails on 16 runs, five times the observed residue.
    const ok = belowMinusOnePct <= 0.5 && belowPct <= 5 && notCleared === 0 && misrouted === 0;
    if (!ok) bad += 1;
    rows.push({
      band,
      Ja: P.Ja,
      'drawn J mean': D.mean.toFixed(2),
      'static actionable mean/min': S.mean.toFixed(2) + '/' + S.min,
      'live mean/min': L.mean.toFixed(2) + '/' + L.min,
      'flipped 2x+ mean/min': T.mean.toFixed(2) + '/' + T.min,
      'below Ja': belowPct.toFixed(1) + '%',
      'below Ja-1 (<= 0.5 %)': belowMinusOnePct.toFixed(2) + '%',
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
  console.log('');
  console.log('AC-243\'s "live >= Ja - 1" floor is 99.5 %, not 100 %: over 3,000 seeds that still fails');
  console.log('on 16 runs, which is five times the residue round 8 observed and well inside anything a');
  console.log('real defect would produce. The ">= Ja in 95 %" clause is unchanged and carries the');
  console.log('actual requirement.');
  console.log(bad === 0 ? 'ACTIONABLE: PASS' : `ACTIONABLE: FAIL (${bad} band(s))`);
  process.exit(bad === 0 ? 0 : 1);
}

/**
 * generation.md §8 `--geometry` (AC-206, AC-207). Three claims, all of which §2.5 proves by
 * CONSTRUCTION rather than by a geometric test — which is exactly why they need a sweep that
 * can fail:
 *
 *   1. every edge's lengthMlu is `(|Δx| + |Δy|) * 1000` (AC-207);
 *   2. AC-206 (b)/(c) — no two horizontal runs in a row band are collinear and share more than
 *      an endpoint, and where two share exactly an endpoint they leave the same source (the
 *      branch's own T) or arrive at the same depot (the shared approach) — Lemma 2;
 *   3. AC-206 (d) — WHERE A HORIZONTAL RUN TERMINATES ON AN OCCUPIED LATTICE SITE, THAT SITE
 *      IS EITHER A DEPOT OR A BRANCH NODE CARRYING A JUNCTION MARKER. On a route row it holds
 *      vacuously by Lemma 1 (the site is empty); on the terminal row the site is a depot, by
 *      LEMMA 1T. Round 8's wording — "no horizontal run terminates on an occupied lattice
 *      site" — cannot pass, because on the terminal row they almost always do.
 *
 * AC-206's reporting clause is the last two columns: the route-row and terminal-row landing
 * counts are reported SEPARATELY, so that a route-row landing appearing at any rate is visible
 * as a real defect instead of being hidden inside a terminal-row figure near 100 %.
 *
 * The fault to inject is a generator with rule (P) removed — a pass node allowed to change
 * column — which must fail (2) and (3). `--no-rule-p` builds that generator here, from the
 * same `tryBuild`/`finalise` the shipped one uses, so the two differ by exactly the rule.
 */
function geometryReport(seedCount, noRuleP) {
  console.log(`# Geometry — ${seedCount} seeds per band` +
    (noRuleP ? ', INJECTING: rule (P) removed (a pass node may change column)' : '') + '\n');
  const rows = [];
  let bad = 0;
  for (let band = 1; band <= 5; band += 1) {
    let lengths = 0;
    let lengthBad = 0;
    let runs = 0;
    let collinear = 0;
    let onSite = 0;
    let levelsBad = 0;
    let v15Bad = 0;
    // The terminal row is counted separately and REPORTED rather than failed. See below.
    let termLanding = 0;
    let termTouching = 0;
    let termUnmarked = 0;
    for (let seed = 0; seed < seedCount; seed += 1) {
      const level = noRuleP ? buildWithoutRuleP(seed, band) : generate(seed, band);
      if (level === null) continue;
      let dirty = false;

      // (1) AC-207 — the Manhattan identity, against the node coordinates.
      for (const e of level.edges) {
        const a = level.nodes[e.from];
        const b = level.nodes[e.to];
        lengths += 1;
        if (e.lengthMlu !== (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) * 1000) {
          lengthBad += 1;
          dirty = true;
        }
      }

      // Occupied lattice sites, per row.
      const occupied = new Map();
      for (const n of level.nodes) {
        if (!occupied.has(n.row)) occupied.set(n.row, new Map());
        occupied.get(n.row).set(n.col, n.id);
      }

      // Every horizontal run, per SOURCE row: [xmin, xmax] at y = y_r.
      const byRow = new Map();
      for (const e of level.edges) {
        const a = level.nodes[e.from];
        const b = level.nodes[e.to];
        if (a.x === b.x) continue; // a straight or the entry: no horizontal run
        runs += 1;
        if (!byRow.has(a.row)) byRow.set(a.row, []);
        byRow.get(a.row).push({
          lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x),
          src: a.id, depot: level.nodes[e.to].kind === 'depot' ? e.to : null,
          targetCol: b.col, row: a.row,
        });
        // (3) Lemma 1 — the run's far end must be an EMPTY lattice site in the SOURCE row.
        //
        // LEMMA 1 HOLDS ON A ROUTE ROW AND NOT ON THE TERMINAL ROW. Its proof is "V2 sets
        // minTarget = a+2 for every later source", which is V2's STRICTLY INCREASING rule —
        // and the terminal row is only non-decreasing, so that two edges may feed one depot
        // (generation.md §2.5, §5 V2). AC-206 clause (d) states it unqualified and cannot
        // pass on the terminal row.
        //
        // What IS true there: the node the run lands on always emits an edge to the SAME
        // column, because rule (P) forces a pass to go straight down and V2 forces a branch
        // to take {a+1, a+2}. So the two verticals coincide, both feed the same depot, and it
        // is §4.5b's shared approach rather than a road passing through a node.
        if (occupied.get(a.row).has(b.col)) {
          if (a.row !== level.R - 1) {
            onSite += 1;
            dirty = true;
          } else {
            termLanding += 1;
            const landed = level.nodes.find((n) => n.row === a.row && n.col === b.col);
            const emits = landed.out.map((eid) => level.nodes[level.edges[eid].to].col);
            if (!emits.includes(b.col)) {
              onSite += 1;
              dirty = true;
            }
          }
        }
      }

      // (2) Lemma 2 — two horizontal runs overlap, or touch without sharing a source or a
      // depot. Overlap is `lo < other.hi && other.lo < hi`; touching is an endpoint in common.
      for (const [, list] of byRow) {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const p = list[i];
            const q = list[j];
            const overlaps = p.lo < q.hi && q.lo < p.hi;
            const touches = p.hi === q.lo || q.hi === p.lo;
            if (!overlaps && !touches) continue;
            const sameSource = p.src === q.src;
            const sameDepot = p.depot !== null && p.depot === q.depot;
            if (overlaps) {
              collinear += 1;
              dirty = true;
              continue;
            }
            if (sameSource || sameDepot) continue;
            // The same terminal-row exception as clause (d), from the other side: source `a`
            // jogs right to depot column a+1 and the node at (R-1, a+1) jogs right to a+2, so
            // the two runs are collinear and meet at x_{a+1}. AC-206 clause (c) states that
            // this cannot happen. It does, on the terminal row, and what the drawing
            // guarantees instead is that the meeting point carries a BRANCH NODE — so the
            // apparent continuation is a junction and is drawn with a marker on it.
            if (p.row !== level.R - 1) {
              collinear += 1;
              dirty = true;
              continue;
            }
            termTouching += 1;
            const meetX = p.hi === q.lo ? p.hi : q.hi;
            const meeting = level.nodes.find((n) => n.row === p.row && n.x === meetX);
            if (!meeting || meeting.kind !== 'branch') {
              termUnmarked += 1;
              dirty = true;
            }
          }
        }
      }

      // V15 restated: every edge with Δcol ≠ 0 leaves a BRANCH node.
      for (const e of level.edges) {
        const a = level.nodes[e.from];
        if (level.nodes[e.to].col !== a.col && a.kind !== 'branch') {
          v15Bad += 1;
          dirty = true;
        }
      }
      if (dirty) levelsBad += 1;
    }
    const ok = lengthBad === 0 && collinear === 0 && onSite === 0 && v15Bad === 0
      && termUnmarked === 0;
    // A check that observed nothing is a failure, not a pass (development-process.md §6.8).
    const reachable = lengths > 0 && runs > 0 && termLanding > 0 && termTouching > 0;
    if (!ok || !reachable) bad += 1;
    rows.push({
      band,
      'edges measured': lengths,
      'AC-207 length ≠ |Δx|+|Δy|': lengthBad,
      'horizontal runs': runs,
      'route-row Lemma 2 faults': collinear,
      'route-row Lemma 1 faults': onSite,
      'terminal-row landings (reported)': termLanding,
      'terminal-row touching runs (reported)': termTouching,
      'of those, NOT on a junction': termUnmarked,
      'Δcol edge from a non-branch (V15)': v15Bad,
      'levels with any fault': levelsBad,
      verdict: !reachable ? 'VACUOUS' : ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  if (noRuleP) {
    const caught = bad > 0;
    console.log('\nINJECTION "rule (P) removed": ' +
      (caught ? 'CAUGHT — the sweep fails, so these checks can fail.'
              : 'NOT CAUGHT — these checks cannot fail and are worthless.'));
    process.exit(caught ? 0 : 1);
  }
  console.log('\nAll three claims are properties of the CONSTRUCTION (generation.md §2.5), not of a');
  console.log('geometric test the generator runs. This sweep is the only thing that can falsify them,');
  console.log('and --no-rule-p is the fault it was written against.');
  console.log('');
  console.log('THE TWO "reported" COLUMNS ARE AC-206\'s REPORTING CLAUSE, and round 9 is where the');
  console.log('criterion caught up with them. §2.5\'s Lemma 1 is proved from V2\'s STRICTLY INCREASING');
  console.log('rule, which holds across a route row and NOT across the terminal row, where V2 is only');
  console.log('non-decreasing so that two edges may feed one depot. Round 8\'s clause (d) — "no');
  console.log('horizontal run terminates on an occupied lattice site" — therefore could not pass.');
  console.log('LEMMA 1T states the terminal-row case and proves it safe for a different reason: a');
  console.log('depot emits no edge, so a run that lands on one ends at a building rather than');
  console.log('continuing into a road, and a false continuation needs an outgoing edge to exist.');
  console.log('Route-row landings must be ZERO; terminal-row landings are reported, and every one of');
  console.log('them is asserted to continue down its own column with a junction marker on it.');
  console.log(bad === 0 ? 'GEOMETRY: PASS' : `GEOMETRY: FAIL (${bad} band(s))`);
  process.exit(bad === 0 ? 0 : 1);
}

/**
 * The injected generator: identical to generate() except that `buildRow` offers a pass node
 * EVERY candidate column, which is slices 0–1's freedom and what rule (P) removed. Returns
 * null when no candidate validates within MAX_ATTEMPTS — which is common, because V15 rejects
 * most of what this produces, so the sweep deliberately reads V15 off the level rather than
 * through validate().
 */
function buildWithoutRuleP(seed, band) {
  const P = BANDS[band];
  const rng = makeStream(mix32(seed, GEN_SALT));
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const net = tryBuildLoose(rng, P);
    if (net === null) continue;
    const level = finalise(net, P, seed);
    // Everything EXCEPT V14/V15, so a level that only breaks rule (P) survives to be measured.
    const others = RULE_ORDER.filter((id) => id !== 'V14' && id !== 'V15' && id !== 'V2');
    if (others.some((id) => RULES[id](level, P))) continue;
    return level;
  }
  return null;
}

function tryBuildLoose(rng, P) {
  const { C, K, R, pBranchPct } = P;
  const all = [];
  for (let c = 0; c < C; c += 1) all.push(c);
  const depotCols = K === C ? all.slice() : chooseFrom(rng, combinationsOf(all, K));
  const entryCol = chooseFrom(rng, all.filter((c) => Math.abs(2 * c - (C - 1)) <= 2));
  const rows = [[entryCol]];
  const rowEdges = [];
  for (let r = 0; r < R; r += 1) {
    const terminal = r === R - 1;
    const allowed = terminal ? depotCols : all;
    const picks = looseRow(rng, rows[r], allowed, terminal, pBranchPct);
    if (picks === null) return null;
    const targets = [...new Set(picks.flat())].sort((a, b) => a - b);
    if (!terminal && targets.length > C) return null;
    rows.push(targets);
    rowEdges.push(picks);
  }
  return { entryCol, depotCols: depotCols.slice().sort((a, b) => a - b), rows, rowEdges };
}

/** buildRow with `passOptions` widened to every candidate column: rule (P) removed. */
function looseRow(rng, srcs, allowed, terminal, pBranchPct) {
  const allowedSet = new Set(allowed);
  const picks = new Array(srcs.length).fill(null);
  let budget = 40000;
  function covered() {
    const seen = new Set();
    for (const p of picks) for (const t of p) seen.add(t);
    for (const c of allowed) if (!seen.has(c)) return false;
    return true;
  }
  function rec(i, minTarget) {
    if ((budget -= 1) <= 0) return false;
    if (i === srcs.length) return terminal ? covered() : true;
    const a = srcs[i];
    const cand = [a - 1, a, a + 1].filter((c) => allowedSet.has(c) && c >= minTarget);
    const passOptions = cand.map((c) => [c]); // <- THE INJECTION
    const branchOptions = shuffleWith(rng, pairsOf(cand));
    const options = rng.nextInt(100) < pBranchPct
      ? branchOptions.concat(passOptions)
      : passOptions.concat(branchOptions);
    for (const opt of options) {
      picks[i] = opt;
      const top = opt[opt.length - 1];
      if (rec(i + 1, terminal ? top : top + 1)) return true;
      picks[i] = null;
    }
    return false;
  }
  return rec(0, -1) ? picks : null;
}

function combinationsOf(arr, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i += 1) { cur.push(arr[i]); rec(i + 1); cur.pop(); }
  })(0);
  return out;
}
function pairsOf(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 1) for (let j = i + 1; j < arr.length; j += 1) out.push([arr[i], arr[j]]);
  return out;
}
function shuffleWith(rng, arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function chooseFrom(rng, arr) { return arr[rng.nextInt(arr.length)]; }

const seeds = Number(arg('seeds', 5000));
const injectRule = arg('inject', null);

if (process.argv.includes('--rule-injection')) ruleInjection();
if (process.argv.includes('--actionable')) actionableReport(seeds);
if (process.argv.includes('--geometry')) geometryReport(seeds, has('no-rule-p'));

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
  let bandTableMismatch = 0;
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

    // AC-202 — the level's parameters against generation.md §6.1, TRANSCRIBED above. The
    // slice-1 version of this compared the level with the code's own constant, which it
    // satisfies by construction: every band-table edit had passed it silently (§6.8).
    const T = BAND_TABLE[band];
    if (level.C !== T.C || level.K !== T.K || level.R !== T.R || level.colW !== T.colW ||
        level.rowH !== T.rowH || level.interval !== T.interval || level.jitter !== T.jitter ||
        CAR_SPEED !== DESIGN_CAR_SPEED ||
        'quota' in level || 'diagLen' in level || 'speedMluPerTick' in level) {
      bandTableMismatch += 1;
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
  const distinctOk = seeds < 3000 || sigs.size >= SIGNATURE_FLOOR[band];
  const attemptsOk = percentile(attempts, 0.5) <= 8 && attempts[attempts.length - 1] <= 128;
  // AC-245: the cheapest possible check on the quantity that went unmeasured through two
  // slices, and the one a human then falsified (development-process.md §6.9). Two clauses: the
  // 90-tick floor, and the EXACT minimum, which V14 + V15 pin at ENTRY_LEN + rowH in ticks.
  const fdOk = minFirstDecision >= FIRST_DECISION_FLOOR
    && minFirstDecision === FIRST_DECISION_MIN[band];
  if (!injectRule && (exhausted || violationText !== 'none' || !distinctOk || !attemptsOk
      || !fdOk || bandTableMismatch)) failures += 1;

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
    'AC-245 want': FIRST_DECISION_MIN[band] + ' (floor ' + FIRST_DECISION_FLOOR + ')',
    'AC-245': fdOk ? 'PASS' : 'FAIL',
    'AC-202 band-table mismatches': bandTableMismatch,
    'AC-234 signature floor': SIGNATURE_FLOOR[band],
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

console.log('checks: AC-202 (band table, transcribed), AC-203 (no exhaustion, median attempts');
console.log('        <= 8, max <= 128), AC-211, AC-212, AC-234 signature floor (only asserted at');
console.log('        --seeds 3000 or more; reported always), AC-242 (V13, via both rule sets),');
console.log('        AC-245 (>= ' + FIRST_DECISION_FLOOR + ' ticks AND exactly ENTRY_LEN(' + ENTRY_LEN + ') + rowH), AC-248/AC-249 (V14/V15).');
console.log('see also: --rule-injection (AC-244), --actionable (AC-243), --geometry (AC-206/207).');
console.log(failures === 0 && disagreements === 0 ? 'GENERATOR AUDIT: PASS' : 'GENERATOR AUDIT: FAIL');
process.exit(failures === 0 && disagreements === 0 ? 0 : 1);
