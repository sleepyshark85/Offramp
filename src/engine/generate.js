// Offramp — track generator (generation.md §4, §5).
//
// A pure function of (seed, band). Integers only: no float reaches a level object, and the
// only division performed is exact (asserted by test/geometry.test.js).

import {
  BUILD_BUDGET,
  COL_W_CAP,
  DEPOT_Y,
  ENTRY_LEN,
  ENTRY_Y,
  GEN_SALT,
  LANE_SPAN,
  MAX_ATTEMPTS,
  MIN_JUNCTION_SEP_LU,
  MLU,
  PALETTE,
  ROW0_Y,
  SPAWN_LEAD,
  SPAWN_SALT,
  V12_MAX_REDERIVE,
  V12_SALT,
  bandParams,
  spawnSlack,
} from './constants.js';
import { choose, makeStream, mix32, shuffle } from './rng.js';

// --- §3.2 site coordinates ---------------------------------------------------------------

export function colWFor(C) {
  return Math.min(COL_W_CAP, LANE_SPAN / (C - 1));
}

export function rowHFor(R) {
  return (DEPOT_Y - ROW0_Y) / R;
}

export function xOf(c, C, colW) {
  return 500 - (colW * (C - 1)) / 2 + c * colW;
}

export function yOf(r, rowH) {
  return ROW0_Y + r * rowH;
}

// --- helpers -----------------------------------------------------------------------------

function combinations(arr, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      cur.push(arr[i]);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

function pairs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = i + 1; j < arr.length; j += 1) out.push([arr[i], arr[j]]);
  }
  return out;
}

// --- §4.2 buildRow -----------------------------------------------------------------------

/**
 * Depth-first with backtracking over one row band. Sources are processed left to right and a
 * running minTarget enforces the ordering rule that makes the row merge-free (V2) and planar
 * (V3) at once.
 *
 * Returns an array parallel to `srcs`, each entry the ascending target column list for that
 * source, or null if the row cannot be built (or the step budget is exhausted).
 */
export function buildRow(rng, srcs, allowed, terminal, pBranchPct) {
  const allowedSet = new Set(allowed);
  const picks = new Array(srcs.length).fill(null);
  let budget = BUILD_BUDGET;
  let exhausted = false;

  function covered() {
    const seen = new Set();
    for (const p of picks) for (const t of p) seen.add(t);
    for (const c of allowed) if (!seen.has(c)) return false;
    return true;
  }

  function rec(i, minTarget) {
    budget -= 1;
    if (budget <= 0) {
      exhausted = true;
      return false;
    }
    if (i === srcs.length) return terminal ? covered() : true;

    const a = srcs[i];
    const cand = [a - 1, a, a + 1].filter((c) => allowedSet.has(c) && c >= minTarget);
    const branchOptions = shuffle(rng, pairs(cand));
    const passOptions = shuffle(rng, cand.map((c) => [c]));
    const options =
      rng.nextInt(100) < pBranchPct
        ? branchOptions.concat(passOptions)
        : passOptions.concat(branchOptions);

    for (const opt of options) {
      picks[i] = opt;
      const top = opt[opt.length - 1];
      const nextMin = terminal ? top : top + 1;
      if (rec(i + 1, nextMin)) return true;
      picks[i] = null;
      if (exhausted) return false;
    }
    return false;
  }

  const ok = rec(0, -1);
  return ok ? picks : null;
}

// --- §4.1 tryBuild -----------------------------------------------------------------------

export function tryBuild(rng, P) {
  const { C, K, R, pBranchPct } = P;
  const all = [];
  for (let c = 0; c < C; c += 1) all.push(c);

  const depotCols = K === C ? all.slice() : choose(rng, combinations(all, K));
  // |c - (C-1)/2| <= 1, stated as integers so no half-value comparison is needed.
  const entryCol = choose(rng, all.filter((c) => Math.abs(2 * c - (C - 1)) <= 2));

  const rows = [[entryCol]];
  const rowEdges = [];
  for (let r = 0; r < R; r += 1) {
    const terminal = r === R - 1;
    const allowed = terminal ? depotCols : all;
    const picks = buildRow(rng, rows[r], allowed, terminal, pBranchPct);
    if (picks === null) return null;
    const targets = [...new Set(picks.flat())].sort((a, b) => a - b);
    if (!terminal && targets.length > C) return null;
    rows.push(targets);
    rowEdges.push(picks);
  }
  return { entryCol, depotCols: depotCols.slice().sort((a, b) => a - b), rows, rowEdges };
}

// --- §4.3 finalise -----------------------------------------------------------------------

function spawnSchedule(seed, P) {
  const rng = makeStream(mix32(seed, SPAWN_SALT));
  const count = P.quota + spawnSlack(P.band);
  const spawns = [];
  let bag = [];
  for (let i = 0; i < count; i += 1) {
    const tick = SPAWN_LEAD + i * P.interval + rng.nextInt(2 * P.jitter + 1) - P.jitter;
    if (bag.length === 0) {
      bag = [];
      for (let k = 0; k < P.K; k += 1) bag.push(k);
      shuffle(rng, bag);
    }
    spawns.push({ index: i, tick, colour: bag.pop() });
  }
  return spawns;
}

/**
 * generation.md §3.2 states that colW and rowH are exact integers for every (C, R) the band
 * table uses, and AC-218 requires every node x/y and every edge lengthMlu to be integral.
 * Neither is enforced by the construction: §3.2 divides. A band-table edit that made R a
 * divisor of neither 1200 nor LANE_SPAN would produce a level generate() happily accepts,
 * with float node positions and float `progress` accumulating inside the simulation — the
 * exact thing docs/development-process.md and the fixed-point rule exist to prevent.
 *
 * This is a guard at level construction, not a validity rule: it rejects an impossible band
 * table rather than an unlucky candidate network, so it throws rather than returning a
 * rule id for validate() to retry on.
 */
export function assertIntegerGeometry(level) {
  const bad = [];
  if (!Number.isInteger(level.colW)) bad.push('colW=' + level.colW);
  if (!Number.isInteger(level.rowH)) bad.push('rowH=' + level.rowH);
  if (!Number.isInteger(level.diagLen)) bad.push('diagLen=' + level.diagLen);
  for (const n of level.nodes) {
    if (!Number.isInteger(n.x)) bad.push('node ' + n.id + ' x=' + n.x);
    if (!Number.isInteger(n.y)) bad.push('node ' + n.id + ' y=' + n.y);
  }
  for (const e of level.edges) {
    if (!Number.isInteger(e.lengthMlu)) bad.push('edge ' + e.id + ' lengthMlu=' + e.lengthMlu);
  }
  if (bad.length) {
    throw new Error(
      'NON_INTEGER_GEOMETRY: band=' + level.band + ' seed=' + level.seed + ' C=' + level.C +
        ' R=' + level.R + ' [' + bad.length + '] ' + bad.slice(0, 6).join(', '),
    );
  }
  return level;
}

export function finalise(net, P, seed) {
  const { C, K, R } = P;
  const colW = colWFor(C);
  const rowH = rowHFor(R);

  // Nodes in (row, col) order. The entry sits one notional row above row 0.
  const nodes = [];
  const idAt = new Map(); // "row,col" -> node id
  const push = (row, col, y) => {
    const id = nodes.length;
    idAt.set(row + ',' + col, id);
    nodes.push({
      id,
      row,
      col,
      x: xOf(col, C, colW),
      y,
      kind: 'pass',
      out: [],
      junctionId: null,
      depotColour: null,
    });
    return id;
  };

  const entryId = push(-1, net.entryCol, ENTRY_Y);
  nodes[entryId].kind = 'entry';
  for (let r = 0; r < R; r += 1) for (const c of net.rows[r]) push(r, c, yOf(r, rowH));
  for (const c of net.depotCols) push(R, c, DEPOT_Y);

  // Edges, emitted in node-id order with each node's targets ascending, so that out[0] is
  // always the smaller column (gameplay.md §2.3).
  const edges = [];
  const addEdge = (fromId, toId, shape, lengthLu) => {
    const id = edges.length;
    edges.push({ id, from: fromId, to: toId, lengthMlu: lengthLu * MLU, shape });
    nodes[fromId].out.push(id);
    return id;
  };

  const entryEdgeId = addEdge(entryId, idAt.get('0,' + net.entryCol), 'entry', ENTRY_LEN);

  for (let r = 0; r < R; r += 1) {
    const srcs = net.rows[r];
    for (let i = 0; i < srcs.length; i += 1) {
      const fromId = idAt.get(r + ',' + srcs[i]);
      for (const t of net.rowEdges[r][i]) {
        const d = t - srcs[i];
        const shape = d === 0 ? 'straight' : d < 0 ? 'diagL' : 'diagR';
        const lengthLu = d === 0 ? rowH : P.diagLen;
        addEdge(fromId, idAt.get(r + 1 + ',' + t), shape, lengthLu);
      }
    }
  }

  // Kinds, junction ids.
  const junctions = [];
  for (const n of nodes) {
    if (n.row === R) {
      n.kind = 'depot';
    } else if (n.kind !== 'entry') {
      n.kind = n.out.length === 2 ? 'branch' : 'pass';
    }
    if (n.kind === 'branch') {
      n.junctionId = junctions.length;
      junctions.push(n.id);
    }
  }

  // Depot colours: a random permutation of the band's K colours over the K depot columns.
  const genRng = makeStream(mix32(seed, GEN_SALT ^ 0x1));
  const perm = [];
  for (let k = 0; k < K; k += 1) perm.push(k);
  shuffle(genRng, perm);
  let di = 0;
  for (const n of nodes) {
    if (n.kind === 'depot') {
      n.depotColour = perm[di];
      di += 1;
    }
  }

  return assertIntegerGeometry({
    seed,
    band: P.band,
    C,
    K,
    R,
    colW,
    rowH,
    diagLen: P.diagLen,
    nodes,
    edges,
    junctions,
    entryEdgeId,
    speedMluPerTick: P.speedMluPerTick,
    interval: P.interval,
    jitter: P.jitter,
    quota: P.quota,
    spawns: spawnSchedule(seed, P),
  });
}

// --- §5 validity rules --------------------------------------------------------------------

/** Per-node bitmask of reachable depot colours. Index is node id. */
export function reachableColourMasks(level) {
  const mask = new Array(level.nodes.length).fill(0);
  for (let i = level.nodes.length - 1; i >= 0; i -= 1) {
    const n = level.nodes[i];
    if (n.kind === 'depot') {
      mask[i] = 1 << n.depotColour;
    } else {
      let m = 0;
      for (const e of n.out) m |= mask[level.edges[e].to];
      mask[i] = m;
    }
  }
  return mask;
}

/** Junction depth (count of branch nodes) of every entry-to-depot path. */
export function pathDepths(level) {
  const depths = [];
  const walk = (nodeId, d) => {
    const n = level.nodes[nodeId];
    if (n.kind === 'depot') {
      depths.push(d);
      return;
    }
    const nd = d + (n.kind === 'branch' ? 1 : 0);
    for (const e of n.out) walk(level.edges[e].to, nd);
  };
  walk(0, 0);
  return depths;
}

/**
 * The mask pair of a branch node's two branches, as [out0, out1].
 */
function branchMasks(level, mask, node) {
  return [mask[level.edges[node.out[0]].to], mask[level.edges[node.out[1]].to]];
}

/**
 * V13's predicate. Two reachable-colour sets are INCOMPARABLE when neither contains the
 * other, which is what makes a junction actionable: whichever way it is left, some colour is
 * served that the other branch does not serve. Where one set contains the other, the superset
 * branch serves every colour the subset branch does and a perfect player never has to flip it
 * — the junction is decorative (AC-242).
 */
export function incomparable(a, b) {
  const both = a & b;
  return both !== a && both !== b;
}

/** The branch nodes whose two colour sets are incomparable. Ascending by junctionId. */
export function actionableJunctions(level) {
  const mask = reachableColourMasks(level);
  const out = [];
  for (const n of level.nodes) {
    if (n.kind !== 'branch' || n.out.length !== 2) continue;
    const [a, b] = branchMasks(level, mask, n);
    if (incomparable(a, b)) out.push(n.junctionId);
  }
  return out;
}

/**
 * gameplay.md §4.6b / AC-245. For every entry-to-depot path, the arc length from the entry
 * node to the FIRST branch node on that path, converted to ticks. Returns the minimum
 * over all paths — the window the player has to make a decision that cannot be prepared.
 * Paths with no branch at all are not decisions and do not contribute.
 */
export function firstDecisionTicks(level) {
  // Accumulated in MLU and divided exactly once, so no partial length is ever held as a
  // fraction of an LU.
  let min = Infinity;
  const walk = (nodeId, mlu) => {
    const n = level.nodes[nodeId];
    if (n.kind === 'depot') return;
    if (n.kind === 'branch') {
      const t = Math.ceil(mlu / level.speedMluPerTick);
      if (t < min) min = t;
      return; // the FIRST branch on this path; everything past it is not a first decision
    }
    for (const e of n.out) walk(level.edges[e].to, mlu + level.edges[e].lengthMlu);
  };
  walk(0, 0);
  return min;
}

/**
 * The validity rules of generation.md §5, each as its own predicate over a finalised level.
 *
 * They are separate functions rather than branches of one cascade because eight of the twelve
 * never reject anything `tryBuild` produces (§5.2) — they are structural tripwires, and the
 * only way their checks are ever executed against a violation is to invoke them DIRECTLY on a
 * fixture built to break them. Run through validate()'s ordered cascade an earlier rule always
 * catches the fixture first, which is how slice 1's blind pass left V5 and V9 never once
 * executed against a violation (AC-244).
 *
 * Each returns true when the rule is VIOLATED.
 */
export const RULES = {
  /** V1 — no dead ends. */
  V1(level) {
    const inDeg = inDegrees(level);
    for (const n of level.nodes) {
      if (n.kind === 'depot') {
        if (n.out.length !== 0 || inDeg[n.id] < 1) return true;
      } else if (n.kind === 'entry') {
        if (n.out.length !== 1) return true;
      } else if (n.out.length !== 1 && n.out.length !== 2) {
        return true;
      }
    }
    return false;
  },

  /** V2 — targets across a route row strictly increasing; terminal row non-decreasing. */
  V2(level) {
    const { nodes, edges, R } = level;
    for (let r = 0; r < R; r += 1) {
      const terminal = r === R - 1;
      const srcs = nodes.filter((n) => n.row === r).sort((a, b) => a.col - b.col);
      let prev = -1;
      let first = true;
      for (const s of srcs) {
        for (const eid of s.out) {
          const t = nodes[edges[eid].to].col;
          if (!first && (terminal ? t < prev : t <= prev)) return true;
          prev = t;
          first = false;
        }
      }
    }
    return false;
  },

  /** V3 — merge-free. */
  V3(level) {
    const inDeg = inDegrees(level);
    for (const n of level.nodes) if (n.kind !== 'depot' && inDeg[n.id] > 1) return true;
    return false;
  },

  /** V4 — the lattice invariant. */
  V4(level) {
    for (const e of level.edges) {
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      if (b.row !== a.row + 1) return true;
      if (Math.abs(b.col - a.col) > 1) return true;
    }
    return false;
  },

  /** V5 — every depot reachable from the entry, and there are exactly K of them. */
  V5(level) {
    const { nodes, edges } = level;
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      const n = nodes[stack.pop()];
      for (const eid of n.out) {
        const t = edges[eid].to;
        if (!seen.has(t)) {
          seen.add(t);
          stack.push(t);
        }
      }
    }
    let depotCount = 0;
    for (const n of nodes) {
      if (n.kind === 'depot') {
        depotCount += 1;
        if (!seen.has(n.id)) return true;
      }
    }
    return depotCount !== level.K;
  },

  /** V6 — every junction is decisive: its two branches differ in what they reach. */
  V6(level) {
    const mask = reachableColourMasks(level);
    for (const n of level.nodes) {
      if (n.kind !== 'branch' || n.out.length !== 2) continue; // out-degree is V1's business
      const [a, b] = branchMasks(level, mask, n);
      if (a === b) return true;
    }
    return false;
  },

  /** V7 — junction count in the band's range. */
  V7(level, P) {
    return level.junctions.length < P.Jmin || level.junctions.length > P.Jmax;
  },

  /** V8 — every entry-to-depot path has junction depth in the band's range. */
  V8(level, P) {
    for (const d of pathDepths(level)) if (d < P.Dmin || d > P.Dmax) return true;
    return false;
  },

  /** V9 — one node per lattice site, no row wider than C. */
  V9(level) {
    const sites = new Set();
    const perRow = new Map();
    for (const n of level.nodes) {
      const key = n.row + ',' + n.col;
      if (sites.has(key)) return true;
      sites.add(key);
      perRow.set(n.row, (perRow.get(n.row) || 0) + 1);
    }
    for (const [row, count] of perRow) if (row >= 0 && count > level.C) return true;
    return false;
  },

  /** V10 — the depot colours are exactly the band's first K palette entries, each once. */
  V10(level) {
    const colours = level.nodes.filter((n) => n.kind === 'depot').map((n) => n.depotColour);
    const want = [];
    for (let k = 0; k < level.K; k += 1) want.push(k);
    if (colours.slice().sort((a, b) => a - b).join(',') !== want.join(',')) return true;
    return level.K > PALETTE.length;
  },

  /** V11 — junction separation, squared so the check stays integer. */
  V11(level) {
    const js = level.junctions.map((id) => level.nodes[id]);
    for (let i = 0; i < js.length; i += 1) {
      for (let j = i + 1; j < js.length; j += 1) {
        const dx = js[i].x - js[j].x;
        const dy = js[i].y - js[j].y;
        if (dx * dx + dy * dy < MIN_JUNCTION_SEP_LU * MIN_JUNCTION_SEP_LU) return true;
      }
    }
    return false;
  },

  /**
   * V13 — the actionable-junction floor. At least `Ja` branch nodes must have INCOMPARABLE
   * colour sets. V6 forbids the outright no-op junction; this forbids a level whose drawn `J`
   * is a difficulty claim its topology does not honour. There is no V12 here: V12 is the
   * cross-level rule and lives in generateLevel().
   */
  V13(level, P) {
    return actionableJunctions(level).length < P.Ja;
  },
};

/** The order generation.md §5 checks the rules in; the id is what an audit failure reports. */
export const RULE_ORDER = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V13'];

function inDegrees(level) {
  const inDeg = new Array(level.nodes.length).fill(0);
  for (const e of level.edges) inDeg[e.to] += 1;
  return inDeg;
}

/**
 * Returns the id of the first violated rule, or null. Rules are checked in the order of
 * generation.md §5.
 */
export function validate(level, P) {
  for (const id of RULE_ORDER) if (RULES[id](level, P)) return id;
  return null;
}

// --- §4 generate ---------------------------------------------------------------------------

/** The network signature used by V12 (generation.md §6.2). */
export function signature(level) {
  const es = level.edges
    .map((e) => {
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      return a.row + ':' + a.col + '>' + b.col;
    })
    .sort()
    .join(',');
  const cols = level.nodes
    .filter((n) => n.kind === 'depot')
    .map((n) => n.col + '=' + n.depotColour)
    .join(',');
  return es + '|e' + level.nodes[0].col + '|' + cols;
}

/** Attempt statistics of the last generate() call, for tools/generator-audit.mjs. */
export const GEN_STATS = { attempts: 0, rejects: Object.create(null) };

export function generate(seed, band) {
  const P = bandParams(band);
  const rng = makeStream(mix32(seed, GEN_SALT));
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const net = tryBuild(rng, P);
    if (net === null) {
      GEN_STATS.rejects.BUILD = (GEN_STATS.rejects.BUILD || 0) + 1;
      continue;
    }
    const level = finalise(net, P, seed);
    const bad = validate(level, P);
    if (bad !== null) {
      GEN_STATS.rejects[bad] = (GEN_STATS.rejects[bad] || 0) + 1;
      continue;
    }
    GEN_STATS.attempts = attempt + 1;
    return level;
  }
  throw new Error('GEN_EXHAUSTED: band=' + band + ' seed=' + seed);
}

/**
 * Level N's seed (gameplay.md §7, AC-702). RUN_SEED is a per-install constant, so every
 * install gets a different ladder and every device replays its own ladder identically.
 */
export function levelSeed(runSeed, n) {
  return mix32((runSeed ^ Math.imul(n, 0x9e3779b1)) >>> 0, GEN_SALT);
}

/**
 * V12 — a level's network signature must differ from the immediately preceding level's.
 * Re-derives the seed up to V12_MAX_REDERIVE times.
 */
export function generateLevel(seed, band, prevSignature) {
  let s = seed >>> 0;
  let level = generate(s, band);
  for (let i = 0; i < V12_MAX_REDERIVE && prevSignature && signature(level) === prevSignature; i += 1) {
    s = mix32(s, V12_SALT);
    level = generate(s, band);
  }
  return level;
}
