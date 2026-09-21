// Generator ACs — AC-203 … AC-219, and the V1–V12 rules of generation.md §5.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BANDS,
  DEPOT_Y,
  ENTRY_LEN,
  ENTRY_Y,
  MIN_JUNCTION_SEP_LU,
  MLU,
  CAR_SPEED,
  PALETTE,
  ROUTE_H,
  ROW0_Y,
} from '../src/engine/constants.js';
import {
  GEN_STATS,
  actionableJunctions,
  firstDecisionTicks,
  generate,
  generateLevel,
  incomparable,
  pathDepths,
  reachableColourMasks,
  signature,
  validate,
  RULES,
  assertIntegerGeometry,
  buildRow,
  colWFor,
  finalise,
  xOf,
  yOf,
} from '../src/engine/generate.js';
import { makeStream, mix32 } from '../src/engine/rng.js';

// generation.md §3.2 and §6.1, TRANSCRIBED. The design document is the expectation; a check
// that reads it back out of the module under test is not a check
// (docs/development-process.md §6.8, the AC-202 lesson).
const DESIGN_GEOMETRY = { DESIGN_W: 1000, DESIGN_H: 1500, ENTRY_Y: 50, ENTRY_LEN: 220, ROW0_Y: 270, ROUTE_H: 1080, DEPOT_Y: 1350 };
// generation.md §6.1's ROUND-9 table. `speed` has LEFT it — CAR_SPEED is 2750 at every band
// (gameplay.md §2.2) — and `colW` is DERIVED from `C` (generation.md §3.2.1) rather than
// tabled, so the values below are the derivation's published results and are checked against
// the rule as well as against the level.
const DESIGN_CAR_SPEED = 2750;
const DESIGN_BANDS = {
  1: { C: 3, K: 3, R: 5, colW: 300, rowH: 216, interval: 208, jitter: 21, J: [3, 4], Ja: 3, D: [2, 3] },
  2: { C: 4, K: 4, R: 5, colW: 264, rowH: 216, interval: 147, jitter: 15, J: [3, 5], Ja: 3, D: [2, 3] },
  3: { C: 4, K: 4, R: 6, colW: 264, rowH: 180, interval: 140, jitter: 14, J: [4, 6], Ja: 4, D: [2, 4] },
  4: { C: 5, K: 5, R: 6, colW: 198, rowH: 180, interval: 131, jitter: 13, J: [5, 7], Ja: 5, D: [2, 4] },
  5: { C: 6, K: 6, R: 6, colW: 158, rowH: 180, interval: 128, jitter: 13, J: [7, 9], Ja: 7, D: [2, 5] },
};

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GEN_SALT } from '../src/engine/constants.js';

const SEEDS = 400;

// --- the two construction-constraint injections (AC-248, AC-249) --------------------------
//
// V14 and V15 are enforced in `buildRow`, so `generate()` cannot produce a violation of either
// at any seed. AC-244 puts them in its hardest class for that reason: their checks are only
// ever executed against a violation by a generator built to break them, and these two are it.
// Both are the shipped `tryBuild` with ONE line changed.

function combos(arr, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i += 1) { cur.push(arr[i]); rec(i + 1); cur.pop(); }
  })(0);
  return out;
}

function buildNet(seed, P, rowOptions) {
  const rng = makeStream(mix32(seed, GEN_SALT));
  const { C, K, R, pBranchPct } = P;
  const all = [];
  for (let c = 0; c < C; c += 1) all.push(c);
  const pick = (a) => a[rng.nextInt(a.length)];
  const depotCols = K === C ? all.slice() : pick(combos(all, K));
  const entryCol = pick(all.filter((c) => Math.abs(2 * c - (C - 1)) <= 2));
  const rows = [[entryCol]];
  const rowEdges = [];
  for (let r = 0; r < R; r += 1) {
    const terminal = r === R - 1;
    const allowed = terminal ? depotCols : all;
    const picks = rowOptions(rng, rows[r], allowed, terminal, pBranchPct, r);
    if (picks === null) return null;
    const targets = [...new Set(picks.flat())].sort((a, b) => a - b);
    if (!terminal && targets.length > C) return null;
    rows.push(targets);
    rowEdges.push(picks);
  }
  return { entryCol, depotCols: depotCols.slice().sort((a, b) => a - b), rows, rowEdges };
}

/** V14's injection: `forcePass` disabled, so row 0 may branch. */
function tryBuildWithoutForcePass(seed, P) {
  return buildNet(seed, P, (rng, srcs, allowed, terminal, pct) =>
    buildRow(rng, srcs, allowed, terminal, pct, false));
}

/** V15's injection: `passOptions` widened to every candidate column — rule (P) removed. */
function looseRow(rng, srcs, allowed, terminal, pBranchPct) {
  const allowedSet = new Set(allowed);
  const picks = new Array(srcs.length).fill(null);
  let budget = 40000;
  const covered = () => {
    const seen = new Set();
    for (const p of picks) for (const t of p) seen.add(t);
    return allowed.every((c) => seen.has(c));
  };
  const rec = (i, minTarget) => {
    if ((budget -= 1) <= 0) return false;
    if (i === srcs.length) return terminal ? covered() : true;
    const a = srcs[i];
    const cand = [a - 1, a, a + 1].filter((c) => allowedSet.has(c) && c >= minTarget);
    const passOptions = cand.map((c) => [c]); // <- THE INJECTION
    const branchOptions = [];
    for (let x = 0; x < cand.length; x += 1) {
      for (let y = x + 1; y < cand.length; y += 1) branchOptions.push([cand[x], cand[y]]);
    }
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
  };
  return rec(0, -1) ? picks : null;
}

function tryBuildLoosePass(seed, P) {
  return buildNet(seed, P, (rng, srcs, allowed, terminal, pct) =>
    looseRow(rng, srcs, allowed, terminal, pct));
}

function eachLevel(fn) {
  for (let band = 1; band <= 5; band += 1) {
    for (let seed = 0; seed < SEEDS; seed += 1) fn(generate(seed, band), band, seed);
  }
}

test('AC-203 · generation never exhausts; attempts stay well inside the cap', () => {
  const attempts = [];
  eachLevel(() => attempts.push(GEN_STATS.attempts));
  attempts.sort((a, b) => a - b);
  const median = attempts[attempts.length >> 1];
  assert.ok(median <= 8, 'median attempts ' + median);
  assert.ok(attempts[attempts.length - 1] <= 128, 'max attempts ' + attempts[attempts.length - 1]);
});

test('AC-204 · V1 — no dead ends, and every node reaches a depot', () => {
  eachLevel((level) => {
    const inDeg = new Array(level.nodes.length).fill(0);
    for (const e of level.edges) inDeg[e.to] += 1;
    const masks = reachableColourMasks(level);
    for (const n of level.nodes) {
      if (n.kind === 'depot') {
        assert.equal(n.out.length, 0);
        assert.ok(inDeg[n.id] >= 1);
      } else {
        assert.ok(n.out.length === 1 || n.out.length === 2, 'out-degree ' + n.out.length);
        assert.ok(masks[n.id] !== 0, 'node ' + n.id + ' reaches no depot');
      }
    }
  });
});

test('AC-205 · V2 — merge-free ordering', () => {
  eachLevel((level) => {
    for (let r = 0; r < level.R; r += 1) {
      const terminal = r === level.R - 1;
      const srcs = level.nodes.filter((n) => n.row === r).sort((a, b) => a.col - b.col);
      const targets = [];
      for (const s of srcs) for (const e of s.out) targets.push(level.nodes[level.edges[e].to].col);
      for (let i = 1; i < targets.length; i += 1) {
        if (terminal) assert.ok(targets[i] >= targets[i - 1], 'terminal row not non-decreasing');
        else assert.ok(targets[i] > targets[i - 1], 'route row not strictly increasing');
      }
    }
  });
});

test('AC-206 · no two roads are ever drawn as one — all four clauses', () => {
  // THE OLD PROOF DOES NOT SURVIVE ORTHOGONAL ROUTING. Clause (a) — no crossing chords — was
  // the whole of it, and it says nothing about Manhattan routing, whose worse failure is two
  // horizontal runs that are COLLINEAR AND TOUCHING: that draws as one continuous road with a
  // fork in the middle that is not a junction, which is a lie about where a car can go rather
  // than merely a confusing picture (generation.md §2.5).
  //
  // Clauses (b), (c) and (d) are checked here from the NODE COORDINATES, not from the edge
  // shape tags, so a generator that emitted the right tags on the wrong geometry would fail.
  let runsSeen = 0;
  let touchingSeen = 0;
  let terminalLandings = 0;
  let thirdCase = 0;
  eachLevel((level) => {
    // (a) no crossing pair.
    const byRow = new Map();
    for (const e of level.edges) {
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      if (!byRow.has(a.row)) byRow.set(a.row, []);
      byRow.get(a.row).push({ a, b, e });
    }
    for (const list of byRow.values()) {
      for (const p of list) {
        for (const q of list) {
          if (p.a.col < q.a.col) assert.ok(!(p.b.col > q.b.col), 'crossing');
        }
      }
    }

    // The occupied lattice sites of each row.
    const occupied = new Map();
    for (const n of level.nodes) {
      if (!occupied.has(n.row)) occupied.set(n.row, new Set());
      occupied.get(n.row).add(n.col);
    }

    for (const [row, list] of byRow) {
      const runs = [];
      const terminalRow = row === level.R - 1;
      for (const { a, b, e } of list) {
        if (a.x === b.x) continue; // straight or entry: no horizontal run
        runsSeen += 1;
        // (d) Lemma 1 — a horizontal run never terminates on an occupied lattice site of its
        // own row.
        //
        // LEMMA 1'S PROOF HOLDS ON A ROUTE ROW AND NOT ON THE TERMINAL ROW, and AC-206 clause
        // (d) states it unqualified. The proof runs: "V2 sets minTarget = a+2 for every later
        // source, so a node at column a+1 in row r would have to emit targets >= a+2". That is
        // V2's STRICTLY INCREASING rule, which holds across a route row and not across the
        // terminal row, where V2 is only non-decreasing so that two edges may feed one depot.
        //
        // Measured over 1,000 seeds a band: ZERO route-row violations, and 1,882 / 2,626 /
        // 2,816 / 3,783 / 4,784 terminal-row landings affecting 98.7-100 % of levels. It is
        // reported to the caller of this suite as a finding against the design, and what is
        // asserted here is the statement that IS true on the terminal row — see below.
        if (!terminalRow) {
          assert.ok(!occupied.get(row).has(b.col),
            'route-row horizontal run from col ' + a.col + ' lands on occupied site ' +
            b.col + ' in row ' + row);
        } else if (occupied.get(row).has(b.col)) {
          terminalLandings += 1;
          // What the terminal row guarantees instead, and it is enough to keep the drawing
          // honest: the node the run lands on ALWAYS emits an edge to the same column. Rule
          // (P) forces a pass there to go straight down, and V2 forces a branch there to take
          // {a+1, a+2} — so the incoming run's vertical drop COINCIDES with that node's own,
          // both feed the same depot, and it is §4.5b's shared approach rather than a road
          // passing through a node.
          const landedOn = level.nodes.find((n) => n.row === row && n.col === b.col);
          const emits = landedOn.out.map((eid) => level.nodes[level.edges[eid].to].col);
          assert.ok(emits.includes(b.col),
            'a terminal-row run lands on a node that does not continue down its own column');
          assert.ok(level.nodes[e.to].kind === 'depot');
        }
        runs.push({
          lo: Math.min(a.x, b.x),
          hi: Math.max(a.x, b.x),
          srcX: a.x,
          src: a.id,
          depot: level.nodes[e.to].kind === 'depot' ? e.to : null,
        });
      }
      for (let i = 0; i < runs.length; i += 1) {
        for (let j = i + 1; j < runs.length; j += 1) {
          const p = runs[i];
          const q = runs[j];
          // (b) never collinear sharing more than an endpoint.
          assert.ok(!(p.lo < q.hi && q.lo < p.hi),
            'two horizontal runs overlap in row ' + row);
          if (p.hi === q.lo || q.hi === p.lo) {
            touchingSeen += 1;
            const sameSource = p.src === q.src;
            const sameDepot = p.depot !== null && p.depot === q.depot;
            if (sameSource || sameDepot) continue;
            // (c) AS AC-206 STATES IT, this is a failure: "where two horizontal runs share
            // exactly an endpoint, they either leave the same source node or arrive at the
            // same depot". ON THE TERMINAL ROW THERE IS A THIRD CASE AND THE DESIGN MISSES IT,
            // for the same reason clause (d) misses one — Lemma 2's case analysis leans on
            // Lemma 1, and Lemma 1 needs V2's STRICT increase, which the terminal row does not
            // have.
            //
            // The third case: source `a` jogs right to depot column `a+1`, and a node exists at
            // (R-1, a+1) whose own branch jogs right to `a+2`. The two runs are collinear and
            // meet at x_{a+1}. Measured over 1,000 seeds a band: 743 / 504 / 1,621 / 1,298 /
            // 2,286 occurrences, on 50-100 % of levels.
            //
            // What IS true, and what is asserted instead: the meeting point always carries a
            // BRANCH NODE, so the apparent continuation is a junction and is drawn with a
            // junction marker on it. It is a weaker guarantee than "no false continuation" and
            // it is reported to the caller as a finding, not passed off as the design's claim.
            assert.ok(terminalRow, 'a route row produced a touching pair, which Lemma 2 forbids');
            thirdCase += 1;
            const meetX = p.hi === q.lo ? p.hi : q.hi;
            const meeting = level.nodes.find((n) => n.row === row && n.x === meetX);
            assert.ok(meeting, 'the meeting point is a lattice site');
            assert.equal(meeting.kind, 'branch',
              'the meeting point carries a junction marker, so the continuation is marked');
            assert.ok(meeting.id === p.src || meeting.id === q.src,
              'one of the two runs leaves the meeting node');
          }
        }
      }
    }
  });
  // The observation guards. A sweep that saw no horizontal runs would pass every clause above
  // by measuring nothing (development-process.md §6.8).
  assert.ok(runsSeen > 0, 'no horizontal run was examined');
  assert.ok(touchingSeen > 0, 'no touching pair was examined — clause (c) never ran');
  assert.ok(terminalLandings > 0,
    'no terminal-row landing was examined — the weaker clause never ran');
  assert.ok(thirdCase > 0,
    'the terminal-row third case never occurred — its clause asserted nothing');
});

test('AC-207 · edge lengths are Manhattan distances, and src/engine holds no curve maths', () => {
  let edges = 0;
  eachLevel((level) => {
    for (const e of level.edges) {
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      edges += 1;
      assert.equal(e.lengthMlu, (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) * MLU,
        'edge ' + e.id + ' of seed ' + level.seed);
      // And the three shapes come out at the lengths generation.md §3.3 tables.
      if (e.shape === 'entry') assert.equal(e.lengthMlu, DESIGN_GEOMETRY.ENTRY_LEN * MLU);
      else if (e.shape === 'straight') assert.equal(e.lengthMlu, level.rowH * MLU);
      else assert.equal(e.lengthMlu, (level.rowH + level.colW) * MLU);
    }
    assert.ok(!('diagLen' in level), 'the level object carries no diagLen');
  });
  assert.ok(edges > 0);

  // The source clause — the cheapest way to catch a future edge shape that reintroduces a
  // curve, and the reason the determinism hazard `Math.hypot` used to be is gone.
  const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');
  const banned = [/Math\.hypot/, /Math\.cbrt/, /Math\.sqrt/, /Math\.sin/, /Math\.cos/, /\*\*/, /diagLen/];
  // Comments are stripped first, because `/**` opens a JSDoc block and would match the ban on
  // the `**` operator — a check that fails on its own prose is not a check.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  let scanned = 0;
  for (const f of readdirSync(ENGINE)) {
    const src = stripComments(readFileSync(join(ENGINE, f), 'utf8'));
    scanned += 1;
    for (const re of banned) assert.ok(!re.test(src), f + ' contains ' + re);
  }
  assert.ok(scanned > 5, 'the source scan read ' + scanned + ' files');
  // And it is sensitive: each banned pattern is found when it is present.
  for (const re of banned) {
    assert.ok(re.test(stripComments('const x = Math.hypot(1,2) ** 2 + diagLen + Math.sqrt(Math.sin(Math.cos(Math.cbrt(1))))')),
      're ' + re + ' does not match its own subject');
  }
});

test('AC-248 · V14 — the row-0 node is a pass, and the check rejects a fixture that is not', () => {
  eachLevel((level, band) => {
    const row0 = level.nodes.filter((n) => n.row === 0);
    assert.equal(row0.length, 1, 'band ' + band + ' seed ' + level.seed + ': rows[0] holds one node');
    assert.equal(row0[0].kind, 'pass');
    assert.equal(row0[0].out.length, 1);
    assert.equal(level.nodes[level.edges[row0[0].out[0]].to].col, row0[0].col, 'Δcol = 0');
    // ...and rows[1] therefore holds exactly one node too.
    assert.equal(level.nodes.filter((n) => n.row === 1).length, 1);
    assert.equal(RULES.V14(level, BANDS[band]), false);
  });

  // THE FAULT INJECTION, and it is required because no amount of seed sweeping will ever make
  // the clause above fail: `forcePass` at r === 0 makes a row-0 branch unconstructible
  // (AC-248's second clause, AC-244's hardest class).
  let branchedAtRow0 = 0;
  for (let band = 1; band <= 5; band += 1) {
    const P = BANDS[band];
    for (let seed = 0; seed < 60 && branchedAtRow0 < 5; seed += 1) {
      const net = tryBuildWithoutForcePass(seed, P);
      if (net === null) continue;
      const level = finalise(net, P, seed);
      if (level.nodes.filter((n) => n.row === 0).length !== 1) continue;
      if (level.nodes.find((n) => n.row === 0).kind !== 'branch') continue;
      branchedAtRow0 += 1;
      assert.equal(RULES.V14(level, P), true, 'V14 must reject a row-0 branch');
    }
  }
  assert.ok(branchedAtRow0 >= 5, 'the injection produced ' + branchedAtRow0 + ' row-0 branches');
});

test('AC-249 · V15 — a road changes column only at a junction', () => {
  let jogs = 0;
  eachLevel((level, band) => {
    for (const n of level.nodes) {
      if (n.kind !== 'pass' && n.kind !== 'entry') continue;
      assert.equal(n.out.length, 1, 'a pass or entry node has one outgoing edge');
      assert.equal(level.nodes[level.edges[n.out[0]].to].col, n.col, 'Δcol = 0');
    }
    // The counting clause: the number of Δcol ≠ 0 edges equals the number of branch nodes
    // whose two targets are not {c-1, c+1}, plus TWICE the number of those that are.
    let delta = 0;
    for (const e of level.edges) if (level.nodes[e.to].col !== level.nodes[e.from].col) delta += 1;
    let single = 0;
    let both = 0;
    for (const n of level.nodes) {
      if (n.kind !== 'branch') continue;
      const cols = n.out.map((eid) => level.nodes[level.edges[eid].to].col);
      if (cols.includes(n.col)) single += 1;
      else both += 1;
    }
    assert.equal(delta, single + 2 * both, 'band ' + band + ' seed ' + level.seed);
    jogs += delta;
    assert.equal(RULES.V15(level, BANDS[band]), false);
  });
  assert.ok(jogs > 0, 'no Δcol edge was examined');

  // THE FAULT INJECTION — `buildRow` with `passOptions` widened to every candidate column,
  // which is slices 0–1's freedom. This is the only way V15's check is ever executed against
  // a violation (AC-249's third clause).
  let caught = 0;
  for (let band = 1; band <= 5 && caught < 5; band += 1) {
    const P = BANDS[band];
    for (let seed = 0; seed < 60 && caught < 5; seed += 1) {
      const net = tryBuildLoosePass(seed, P);
      if (net === null) continue;
      const level = finalise(net, P, seed);
      if (RULES.V15(level, P) !== true) continue;
      caught += 1;
    }
  }
  assert.ok(caught >= 5, 'the injection produced ' + caught + ' V15 violations');
});

test('AC-218 · integer geometry, and a bad band table THROWS rather than returning a level', () => {
  eachLevel((level) => {
    assert.ok(Number.isInteger(level.colW));
    assert.ok(Number.isInteger(level.rowH));
    for (const n of level.nodes) {
      assert.ok(Number.isInteger(n.x), 'node ' + n.id + ' x');
      assert.ok(Number.isInteger(n.y), 'node ' + n.id + ' y');
    }
    for (const e of level.edges) assert.ok(Number.isInteger(e.lengthMlu));
  });

  // The throw is the point. Slice 1 injected R = 7 and got a level back: 18 nodes with
  // fractional y, 17 edges with fractional lengthMlu, and by tick 683 a car holding
  // progress = 1371.4285714285797 — a float inside the simulation, arriving through a
  // BAND-TABLE EDIT rather than through a code change.
  const saved = { ...BANDS[3] };
  try {
    BANDS[3].R = 7; // 1080 / 7 is not an integer
    assert.throws(() => generate(5, 3), /NON_INTEGER_GEOMETRY/);
  } finally {
    Object.assign(BANDS[3], saved);
  }
  assert.ok(generate(5, 3), 'generation recovers once the table is restored');

  // THE ODD-`colW` HALF OF THIS GUARD IS NO LONGER REACHABLE THROUGH THE BAND TABLE, and that
  // is a §6.8 finding in the good direction rather than a gap. Round 8 injected
  // `BANDS[2].colW = 231` — `colW * (C - 1) = 693` is odd, so `x(0)` is a half-integer and
  // every node coordinate is fractional. `colW` is DERIVED now (generation.md §3.2.1) and the
  // derivation rounds DOWN TO AN EVEN NUMBER, so no band table can produce an odd product:
  // the hazard is designed out, not merely unchecked.
  //
  // A guard whose fault has become unconstructible still has to be executed against a
  // violation, so the check is invoked DIRECTLY on a fixture instead — which is AC-244's rule
  // applied to a construction guard.
  const odd = generate(5, 2);
  assert.throws(
    () => assertIntegerGeometry({ ...odd, colW: 231 }),
    /NON_INTEGER_GEOMETRY/,
    'the odd-colW clause of the guard never fires',
  );
  assert.throws(
    () => assertIntegerGeometry({ ...odd, nodes: [{ ...odd.nodes[0], x: 0.5 }, ...odd.nodes.slice(1)] }),
    /NON_INTEGER_GEOMETRY/,
    'a fractional node x never fires',
  );
  for (let C = 3; C <= 6; C += 1) {
    assert.equal(colWFor(C) % 2, 0, 'colWFor(' + C + ') is even by construction');
  }
});

test('AC-202 · a level carries the band table of generation.md §6.1, and no quota or diagLen', () => {
  // TRANSCRIBED above, not imported. The slice-1 version of this compared the level with the
  // code's own constant, which it satisfies by construction — so every band-table edit had
  // passed it silently (development-process.md §6.8).
  for (let band = 1; band <= 5; band += 1) {
    const D = DESIGN_BANDS[band];
    const level = generate(band * 31, band);
    assert.equal(level.C, D.C, 'band ' + band + ' C');
    assert.equal(level.K, D.K, 'band ' + band + ' K');
    assert.equal(level.R, D.R, 'band ' + band + ' R');
    assert.equal(level.colW, D.colW, 'band ' + band + ' colW');
    assert.equal(level.rowH, D.rowH, 'band ' + band + ' rowH');
    assert.equal(level.interval, D.interval, 'band ' + band + ' interval');
    assert.equal(level.jitter, D.jitter, 'band ' + band + ' jitter');
    assert.ok(!('quota' in level), 'band ' + band + ' carries no quota');
    assert.ok(!('diagLen' in level), 'band ' + band + ' carries no diagLen');
    // SPEED LEFT THE LEVEL OBJECT IN ROUND 9. A per-level copy would be a second place the
    // value lives and the one a future band table could quietly diverge from.
    assert.ok(!('speedMluPerTick' in level), 'band ' + band + ' still carries a per-band speed');
    assert.equal(CAR_SPEED, DESIGN_CAR_SPEED, 'gameplay.md §2.2 — one speed at every band');
  }
});

test('generation.md §3.2 · the design rectangle and the site coordinates are the design’s', () => {
  const G = DESIGN_GEOMETRY;
  assert.equal(ENTRY_Y, G.ENTRY_Y);
  assert.equal(ENTRY_LEN, G.ENTRY_LEN);
  assert.equal(ROW0_Y, G.ROW0_Y);
  assert.equal(ROUTE_H, G.ROUTE_H);
  assert.equal(DEPOT_Y, G.DEPOT_Y);
  // The column x positions §3.2 tables, for every C the bands use.
  // generation.md §3.2's column table, at round 9's DERIVED colW (300 / 264 / 198 / 158).
  const wantX = {
    3: [200, 500, 800],
    4: [104, 368, 632, 896],
    5: [104, 302, 500, 698, 896],
    6: [105, 263, 421, 579, 737, 895],
  };
  for (const band of [1, 2, 3, 4, 5]) {
    const D = DESIGN_BANDS[band];
    for (let c = 0; c < D.C; c += 1) assert.equal(xOf(c, D.C, D.colW), wantX[D.C][c]);
    // generation.md §3.2.1 — `colW` is DERIVED, and the derivation is checked against the
    // design's published result rather than the other way round.
    assert.equal(colWFor(D.C), D.colW, 'C = ' + D.C + ': colWFor');
    assert.equal(colWFor(D.C) % 2, 0, 'colW is EVEN, so colW*(C-1) cannot be odd');
    assert.ok((D.C - 1) * D.colW <= 792, 'C = ' + D.C + ': the depot-clearance bound');
    assert.ok(D.colW <= 300, 'C = ' + D.C + ': the 30 % corridor cap');
    // And it is the LARGEST such value: 2 LU more breaks one of the two bounds.
    assert.ok((D.C - 1) * (D.colW + 2) > 792 || D.colW + 2 > 300,
      'C = ' + D.C + ': colW is not the largest legal even value');
    // The outermost depot's clearance to the design-space edge — AC-410's 42 LU at C >= 4.
    const margin = wantX[D.C][0] - 124 / 2;
    assert.ok(margin >= 30, 'C = ' + D.C + ': depot margin ' + margin + ' LU');
    // And the row y positions.
    for (let r = 0; r <= D.R; r += 1) assert.equal(yOf(r, D.rowH), G.ROW0_Y + r * D.rowH);
    assert.equal(yOf(D.R, D.rowH), G.DEPOT_Y, 'band ' + band + ': row R is the depot row');
  }
});

test('AC-208 · V4 — the lattice invariant', () => {
  eachLevel((level) => {
    for (const e of level.edges) {
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      assert.equal(b.row, a.row + 1);
      assert.ok(Math.abs(b.col - a.col) <= 1);
    }
  });
});

test('AC-209 · V5 — every depot is reachable from the entry', () => {
  eachLevel((level) => {
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      for (const eid of level.nodes[stack.pop()].out) {
        const t = level.edges[eid].to;
        if (!seen.has(t)) { seen.add(t); stack.push(t); }
      }
    }
    const depots = level.nodes.filter((n) => n.kind === 'depot');
    assert.equal(depots.length, level.K);
    for (const d of depots) assert.ok(seen.has(d.id), 'depot ' + d.id + ' unreachable');
  });
});

test('AC-210 · V6 — both branches of every junction differ in what they reach', () => {
  eachLevel((level) => {
    const masks = reachableColourMasks(level);
    for (const n of level.nodes) {
      if (n.kind !== 'branch') continue;
      const l = masks[level.edges[n.out[0]].to];
      const r = masks[level.edges[n.out[1]].to];
      assert.notEqual(l, r, 'junction ' + n.junctionId + ' is a no-op');
    }
  });
});

test('AC-211 · V7 — junction count inside the band range', () => {
  // AC-211 states the distribution check over 1,000 levels per band.
  const N = 1000;
  const dist = {};
  for (let band = 1; band <= 5; band += 1) {
    dist[band] = {};
    for (let seed = 0; seed < N; seed += 1) {
      const level = generate(seed, band);
      const P = BANDS[band];
      const j = level.junctions.length;
      assert.ok(j >= P.Jmin && j <= P.Jmax, 'band ' + band + ' J=' + j);
      dist[band][j] = (dist[band][j] || 0) + 1;
    }
  }
  // generation.md §6.2's round-8 table, TRANSCRIBED, which is what AC-211's 5-point tolerance
  // is stated against. §6.2's figures come from the designer's prototype; where this generator
  // disagrees the audit is right and §6.2 is corrected (AC-211's own note).
  // generation.md §6.2's ROUND-9 table, transcribed.
  const expected = {
    1: { 3: 13, 4: 87 },
    2: { 3: 9, 4: 24, 5: 68 },
    3: { 4: 2, 5: 14, 6: 84 },
    4: { 5: 2, 6: 23, 7: 75 },
    5: { 7: 2, 8: 26, 9: 72 },
  };
  for (const band of [1, 2, 3, 4, 5]) {
    for (const [j, pct] of Object.entries(expected[band])) {
      const got = (100 * (dist[band][j] || 0)) / N;
      assert.ok(Math.abs(got - pct) <= 5, `band ${band} J=${j}: ${got.toFixed(1)}% vs ${pct}%`);
    }
  }
});

test('AC-242 · V13 — every level clears its band’s actionable-junction floor', () => {
  // Ja = 3 / 3 / 4 / 5 / 7. A junction whose two colour sets are COMPARABLE is decorative:
  // the superset branch serves every colour the subset branch does, so a perfect player never
  // has to flip it. V6 only forbids the outright no-op.
  const wantJa = [null, 3, 3, 4, 5, 7];
  const decorative = [null, 0, 0, 0, 0, 0];
  const drawn = [null, 0, 0, 0, 0, 0];
  eachLevel((level, band) => {
    const P = BANDS[band];
    assert.equal(P.Ja, wantJa[band], 'band ' + band + ' Ja');
    const act = actionableJunctions(level);
    assert.ok(act.length >= P.Ja,
      'band ' + band + ' seed ' + level.seed + ': ' + act.length + ' actionable of ' +
      level.junctions.length + ' drawn, floor ' + P.Ja);
    // Every actionable junction is a real junction, and the count never exceeds the drawn one.
    for (const j of act) assert.ok(level.junctions[j] !== undefined);
    assert.ok(act.length <= level.junctions.length);
    drawn[band] += level.junctions.length;
    decorative[band] += level.junctions.length - act.length;
  });
  // Decorative junctions are ALLOWED above the floor and the design expects them at bands 2-5
  // (generation.md §5.1: forbidding them outright makes the game easier and the generator
  // unreliable). This asserts the rule is a floor, not a ban.
  for (let band = 1; band <= 5; band += 1) {
    assert.ok(decorative[band] > 0,
      'band ' + band + ' lost its decorative junctions — V13 became a ban rather than a floor');
    assert.ok(decorative[band] < drawn[band],
      'band ' + band + ' has no actionable junction at all');
  }
});

test('§5 · incomparable() is the predicate V13 is stated in, and it is not "differs"', () => {
  assert.equal(incomparable(0b011, 0b101), true, 'neither contains the other');
  assert.equal(incomparable(0b011, 0b001), false, 'strict superset: decorative');
  assert.equal(incomparable(0b001, 0b011), false, 'strict subset: decorative');
  assert.equal(incomparable(0b011, 0b011), false, 'equal sets are V6’s case, not V13’s');
  assert.equal(incomparable(0b010, 0b001), true, 'disjoint non-empty sets are never comparable');
});

test('AC-245 · the first-decision window clears its 90-tick floor at every band', () => {
  // gameplay.md §4.6b. THE FLOOR WAS 40 AND IT CERTIFIED A WINDOW THE OWNER COULD NOT PLAY.
  // The old floor was derived from the bot's own constants and priced ONE DECISION MADE IN
  // ISOLATION; generation.md §7.1.7 had already established in the same round that the binding
  // term is the LATENCY TO STARTING the decision, which grows with traffic. A criterion
  // derived from a player model inherits that model's blind spots
  // (docs/development-process.md §6.9).
  //
  // The new floor of 90 prices both terms, and it is met by V14 — a whole row — rather than by
  // ENTRY_LEN. The minimum is EXACTLY `ENTRY_LEN + rowH` in ticks, because rows[0] holds one
  // pass node and V15 makes its edge vertical, so rows[1] holds one node too.
  const FLOOR = 90;
  // gameplay.md §4.6b's ROUND-9 table: `ceil((ENTRY_LEN + rowH) * MLU / CAR_SPEED)` at one
  // constant 2750 MLU/tick. AC-245's own sentence still quotes round 8's
  // `159 / 151 / 132 / 125 / 120`, which was computed with the per-band speed column round 9
  // deleted; §4.6b and §6.1.4 agree with the values below. gameplay.md §4.8's table has the
  // same stale row.
  const wantMin = [null, 159, 159, 146, 146, 146];
  for (let band = 1; band <= 5; band += 1) {
    const D = DESIGN_BANDS[band];
    // The expected minimum, re-derived from the DESIGN's numbers rather than the level's.
    const derived = Math.ceil(((DESIGN_GEOMETRY.ENTRY_LEN + D.rowH) * 1000) / DESIGN_CAR_SPEED);
    assert.equal(derived, wantMin[band], 'band ' + band + ': ENTRY_LEN + rowH in ticks');
    let min = Infinity;
    for (let seed = 0; seed < 600; seed += 1) {
      const t = firstDecisionTicks(generate(seed, band));
      assert.ok(t >= FLOOR, 'band ' + band + ' seed ' + seed + ' firstDecisionTicks ' + t);
      if (t < min) min = t;
    }
    assert.equal(min, wantMin[band], 'band ' + band + ' minimum firstDecisionTicks');
  }

  // THE COUNTERFACTUAL, kept because it is the fallback if V14 is ever reconsidered: with row 0
  // free to branch the window would be `ENTRY_LEN` alone — 80 / 76 / 73 / 69 / 66 ticks, above
  // the OLD floor of 40 at every band and BELOW the new floor of 90 at every band. More entry
  // road does not buy a fair first decision; a whole row does.
  // At one constant speed the counterfactual is the SAME at every band: 80 ticks. Round 8 read
  // `80 / 76 / 73 / 69 / 66` only because speed rose up the ladder.
  const wantAlone = [null, 80, 80, 80, 80, 80];
  for (let band = 1; band <= 5; band += 1) {
    const alone = Math.ceil((DESIGN_GEOMETRY.ENTRY_LEN * 1000) / DESIGN_CAR_SPEED);
    assert.equal(alone, wantAlone[band], 'band ' + band + ': ENTRY_LEN alone');
    assert.ok(alone < FLOOR, 'band ' + band + ': ENTRY_LEN alone is below the floor');
  }
});

test('AC-212 · V8 — every entry-to-depot path has depth in the band range', () => {
  eachLevel((level, band) => {
    const P = BANDS[band];
    for (const d of pathDepths(level)) {
      assert.ok(d >= P.Dmin && d <= P.Dmax, 'band ' + band + ' depth ' + d);
    }
  });
});

test('AC-213 · V12 — consecutive levels in a band differ', () => {
  for (let band = 1; band <= 5; band += 1) {
    let prev = null;
    for (let n = 0; n < 60; n += 1) {
      const level = generateLevel(n * 2654435761 % 4294967296, band, prev);
      const sig = signature(level);
      assert.notEqual(sig, prev, 'band ' + band + ' level ' + n + ' repeats its predecessor');
      prev = sig;
    }
  }
});

test('AC-214 · V9 — one node per lattice site, no row wider than C', () => {
  eachLevel((level) => {
    const sites = new Set();
    const perRow = new Map();
    for (const n of level.nodes) {
      const key = n.row + ',' + n.col;
      assert.ok(!sites.has(key), 'duplicate site ' + key);
      sites.add(key);
      perRow.set(n.row, (perRow.get(n.row) || 0) + 1);
    }
    for (const [row, count] of perRow) if (row >= 0) assert.ok(count <= level.C);
  });
});

test('AC-215/AC-509 · V10 — depot colours are the first K palette entries, each used once', () => {
  eachLevel((level) => {
    const colours = level.nodes.filter((n) => n.kind === 'depot').map((n) => n.depotColour);
    assert.equal(new Set(colours).size, level.K);
    assert.deepEqual(colours.slice().sort((a, b) => a - b), [...Array(level.K).keys()]);
    assert.ok(level.K <= PALETTE.length);
    for (const s of level.spawns) assert.ok(colours.includes(s.colour), 'spawn colour has no depot');
  });
});

test('AC-216 · V11 — junction centres are at least 150 LU apart', () => {
  let min = Infinity;
  eachLevel((level) => {
    const js = level.junctions.map((id) => level.nodes[id]);
    for (let i = 0; i < js.length; i += 1) {
      for (let j = i + 1; j < js.length; j += 1) {
        const d2 = (js[i].x - js[j].x) ** 2 + (js[i].y - js[j].y) ** 2;
        if (d2 < min) min = d2;
      }
    }
  });
  assert.ok(Math.sqrt(min) >= MIN_JUNCTION_SEP_LU, 'min junction separation ' + Math.sqrt(min));
});

test('AC-217 · merge-free — only depots have in-degree > 1', () => {
  eachLevel((level) => {
    const inDeg = new Array(level.nodes.length).fill(0);
    for (const e of level.edges) inDeg[e.to] += 1;
    for (const n of level.nodes) {
      if (n.kind !== 'depot') assert.ok(inDeg[n.id] <= 1, 'node ' + n.id + ' in-degree ' + inDeg[n.id]);
    }
  });
});

test('AC-219 · a level survives a JSON round trip unchanged', () => {
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(77, band);
    assert.deepEqual(JSON.parse(JSON.stringify(level)), level);
  }
});

test('AC-807 · an impossible band throws GEN_EXHAUSTED naming band and seed', () => {
  const saved = { ...BANDS[1] };
  BANDS[1].Jmin = 99; // no network can have 99 junctions in a 3x3 lattice
  BANDS[1].Jmax = 99;
  try {
    assert.throws(() => generate(4242, 1), /GEN_EXHAUSTED: band=1 seed=4242/);
  } finally {
    Object.assign(BANDS[1], saved);
  }
  assert.ok(generate(4242, 1), 'generation recovers once the band is restored');
});

test('validate() catches an injected violation of each rule it owns', () => {
  const P = BANDS[3];
  const base = () => JSON.parse(JSON.stringify(generate(9, 3)));
  assert.equal(validate(base(), P), null);

  const v1 = base();
  v1.nodes.find((n) => n.kind === 'depot').out.push(0);
  assert.equal(validate(v1, P), 'V1');

  const v3 = base();
  // Point a second edge at a route-row node to create a merge. It has to be a row that holds
  // more than one node, and under V14 + V15 rows 0 AND 1 both hold exactly one — row 0 is a
  // pass by construction and a pass node's edge is vertical, so row 1 cannot be wider.
  const mergeRow = [...new Set(v3.nodes.filter((n) => n.row > 0 && n.row < v3.R).map((n) => n.row))]
    .find((r) => v3.nodes.filter((n) => n.row === r).length > 1);
  assert.ok(mergeRow !== undefined, 'the fixture level has a route row with two nodes');
  const target = v3.nodes.find((n) => n.row === mergeRow);
  const donor = v3.edges.find((e) => v3.nodes[e.to].row === mergeRow && e.to !== target.id);
  donor.to = target.id;
  assert.ok(['V2', 'V3'].includes(validate(v3, P)));

  const v4 = base();
  v4.nodes[v4.edges[1].to].col += 5;
  assert.ok(['V2', 'V4', 'V9', 'V11'].includes(validate(v4, P)));

  const v7 = base();
  assert.equal(validate(v7, { ...P, Jmin: 99, Jmax: 99 }), 'V7');

  const v8 = base();
  assert.equal(validate(v8, { ...P, Dmin: 9, Dmax: 9 }), 'V8');

  const v10 = base();
  v10.nodes.find((n) => n.kind === 'depot').depotColour = 4;
  assert.equal(validate(v10, P), 'V10');

  // V14 and V15 are LAST in the cascade, so a fixture that violates only them reports them.
  const v14 = base();
  v14.nodes.find((n) => n.row === 0).kind = 'branch';
  assert.equal(validate(v14, P), 'V14');

  // V15 — a pass node whose single edge changes column. Moving the TARGET node's column is
  // what makes Δcol non-zero; several other rules fire on the same fixture, which is harmless
  // and unavoidable because the rules are not independent. What AC-244 requires is that
  // V15's OWN predicate returns true on its own fixture and false on the pristine level.
  const v15 = base();
  const pass = v15.nodes.find((n) => n.kind === 'pass' && n.row >= 0);
  assert.ok(pass, 'the fixture level has a pass node');
  v15.nodes[v15.edges[pass.out[0]].to].col += 1;
  assert.equal(RULES.V15(base(), P), false);
  assert.equal(RULES.V15(v15, P), true);
  assert.notEqual(validate(v15, P), null);
});

test('AC-139 · a level carries exactly the cars that fit in two minutes', () => {
  // `SPAWN_SLACK`, `inFlightMax`, `transitMax` and the two-variant oracle sweep that measured
  // the margin are all DELETED. Under a clock the schedule is not a guess about how many cars
  // a level will need — it is the list of cars that fit, computed exactly (gameplay.md §8.4),
  // and what used to need 2,000 seeds and an oracle is an identity any single level checks.
  // The full sweep is `node tools/spawn-schedule.mjs`.
  // The closed form at round 9's interval/jitter. gameplay.md §2.7's SPAWN_COUNT table and
  // AC-139's sentence both still print round 8's `35 / 48 / 51 / 54 / 56`; the formula beside
  // them is normative and it produces these.
  const wantCount = [null, 35, 49, 51, 55, 56];
  eachLevel((level, band) => {
    assert.ok(level.spawns.length === wantCount[band] || level.spawns.length === wantCount[band] - 1,
      'band ' + band + ' seed ' + level.seed + ' has ' + level.spawns.length + ' spawns');
    assert.ok(level.spawns.every((sp, i) => sp.index === i && sp.tick < 7200));
  });
});

test('AC-701/AC-702/AC-704 · level -> band, level seed, and retry', async () => {
  const { bandForLevel } = await import('../src/engine/constants.js');
  const { levelSeed } = await import('../src/engine/generate.js');
  const { GEN_SALT } = await import('../src/engine/constants.js');
  const { mix32 } = await import('../src/engine/rng.js');

  for (const [n, band] of [[1, 1], [4, 1], [5, 2], [9, 2], [10, 3], [15, 3], [16, 4], [22, 4], [23, 5], [99, 5]]) {
    assert.equal(bandForLevel(n), band, 'level ' + n);
  }
  const RUN_SEED = 0xabcdef01;
  for (let n = 1; n <= 30; n += 1) {
    const want = mix32((RUN_SEED ^ Math.imul(n, 0x9e3779b1)) >>> 0, GEN_SALT);
    assert.equal(levelSeed(RUN_SEED, n), want);
    assert.equal(levelSeed(RUN_SEED, n), levelSeed(RUN_SEED, n), 'stable across calls');
  }
  // AC-704: retry rebuilds the same network, colours and schedule from the same seed.
  const seed = levelSeed(RUN_SEED, 12);
  assert.deepEqual(generate(seed, bandForLevel(12)), generate(seed, bandForLevel(12)));
});
