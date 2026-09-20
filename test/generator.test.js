// Generator ACs — AC-203 … AC-219, and the V1–V12 rules of generation.md §5.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BANDS, MIN_JUNCTION_SEP_LU, PALETTE, SPAWN_SLACK } from '../src/engine/constants.js';
import {
  GEN_STATS,
  generate,
  generateLevel,
  pathDepths,
  reachableColourMasks,
  signature,
  validate,
} from '../src/engine/generate.js';

const SEEDS = 400;

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

test('AC-205/AC-206 · V2 and V3 — merge-free ordering and planarity', () => {
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
    // Planarity restated as the pairwise crossing test of §2.5.
    const byRow = new Map();
    for (const e of level.edges) {
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      if (!byRow.has(a.row)) byRow.set(a.row, []);
      byRow.get(a.row).push([a.col, b.col]);
    }
    for (const list of byRow.values()) {
      for (const [a, b] of list) {
        for (const [a2, b2] of list) {
          if (a < a2) assert.ok(!(b > b2), 'crossing ' + a + '->' + b + ' with ' + a2 + '->' + b2);
        }
      }
    }
  });
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
  // generation.md §6.2's measured distribution, +/- 5 percentage points (AC-211).
  const expected = {
    1: { 3: 100 },
    2: { 3: 17, 4: 38, 5: 44 },
    3: { 4: 20, 5: 37, 6: 43 },
    4: { 5: 11, 6: 32, 7: 57 },
    5: { 7: 29, 8: 71 },
  };
  for (const band of [1, 2, 3, 4, 5]) {
    for (const [j, pct] of Object.entries(expected[band])) {
      const got = (100 * (dist[band][j] || 0)) / N;
      assert.ok(Math.abs(got - pct) <= 5, `band ${band} J=${j}: ${got.toFixed(1)}% vs ${pct}%`);
    }
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
  // Point a second edge at a pass/branch node to create a merge.
  const target = v3.nodes.find((n) => n.row === 1);
  const donor = v3.edges.find((e) => v3.nodes[e.to].row === 1 && e.to !== target.id);
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
});

test('spawn schedules carry quota + 8 entries', () => {
  eachLevel((level) => assert.equal(level.spawns.length, level.quota + SPAWN_SLACK));
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
