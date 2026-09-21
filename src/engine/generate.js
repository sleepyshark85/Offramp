// Offramp — track generator (generation.md §4, §5).
//
// A pure function of (seed, band). Integers only: no float reaches a level object, and the
// generator uses no floating point AT ALL — round 8's orthogonal roads removed the one place
// that needed it (generation.md §3.3). An edge's length is `|Δx| + |Δy|`, two subtractions and
// an addition, bit-identical on every JavaScript engine.

import {
  BUILD_BUDGET,
  CAR_SPEED,
  DEPOT_Y,
  ENTRY_LEN,
  ENTRY_Y,
  GEN_SALT,
  LEVEL_TICKS,
  MAX_ATTEMPTS,
  MIN_JUNCTION_SEP_LU,
  MLU,
  colWFor,
  PALETTE,
  ROUTE_H,
  ROW0_Y,
  SPAWN_LEAD,
  SPAWN_SALT,
  V12_MAX_REDERIVE,
  V12_SALT,
  bandParams,
} from './constants.js';
import { choose, makeStream, mix32, shuffle } from './rng.js';

// --- §3.2 site coordinates ---------------------------------------------------------------

/**
 * `rowH = ROUTE_H / R` is one of TWO divisions in §3.2, and it is why AC-218's construction
 * guard exists. `colW` is the other: slices 0–1 derived it as `min(300, LANE_SPAN / (C - 1))`,
 * round 8 made it a band-table literal, and round 9 derives it again — but from the
 * DEPOT-CLEARANCE rule of generation.md §3.2.1 rather than from a lane span, and rounded DOWN
 * to an even number, so `colW * (C - 1)` is even by construction and `x(c)` is an exact
 * integer. The band table no longer carries it.
 */
export function rowHFor(R) {
  return ROUTE_H / R;
}

export { colWFor };

export function xOf(c, C, colW) {
  return 500 + (2 * c - (C - 1)) * colW / 2;
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
 * running minTarget enforces the ordering rule that makes the row merge-free (V2) and
 * non-coincident (§2.5) at once.
 *
 * TWO CONSTRUCTION CONSTRAINTS LIVE HERE, and they are the whole of what round 8 cost the
 * generator:
 *
 *   RULE (P) / V15 — `passOptions` is `[[a]]` or nothing. A pass node's single outgoing edge
 *   goes straight down; only a branch may change column. Slices 0–1 offered a pass node every
 *   candidate column (`[[a-1], [a], [a+1]]`), so a road could drift sideways without
 *   branching. It cannot any more (generation.md §2.5, gameplay.md §8.9).
 *
 *   V14 — `forcePass` at row 0. The row-0 node is always a pass, so no car's first junction is
 *   one row below the entry. It is a CONSTRUCTION constraint rather than a rejection rule and
 *   that distinction is what makes it affordable: round 4 measured the rejection form reaching
 *   MAX_ATTEMPTS on 2 seeds per 1,000 at band 5; the construction form costs a median of 0
 *   extra attempts (generation.md §5.2, AC-248).
 *
 * Returns an array parallel to `srcs`, each entry the ascending target column list for that
 * source, or null if the row cannot be built (or the step budget is exhausted).
 */
export function buildRow(rng, srcs, allowed, terminal, pBranchPct, forcePass = false) {
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
    // RULE (P): a pass goes straight down, so the only pass option is `a` itself.
    const passOptions = cand.includes(a) ? [[a]] : [];
    const branchOptions = shuffle(rng, pairs(cand));
    const options = forcePass
      ? passOptions
      : rng.nextInt(100) < pBranchPct
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
    // V14 — the row-0 node is a pass, enforced in construction (generation.md §4.1).
    const picks = buildRow(rng, rows[r], allowed, terminal, pBranchPct, r === 0);
    if (picks === null) return null;
    const targets = [...new Set(picks.flat())].sort((a, b) => a - b);
    if (!terminal && targets.length > C) return null;
    rows.push(targets);
    rowEdges.push(picks);
  }
  return { entryCol, depotCols: depotCols.slice().sort((a, b) => a - b), rows, rowEdges };
}

// --- §4.3 finalise -----------------------------------------------------------------------

/**
 * gameplay.md §2.7. The whole schedule is materialised at level construction and is bounded by
 * the clock: every car that can enter inside two minutes is in the array, and no car that
 * cannot is. There is no slack, no `inFlightMax`, no reserve entry and no `SPAWN_EXHAUSTED`.
 */
export function spawnSchedule(seed, P) {
  const rng = makeStream(mix32(seed, SPAWN_SALT));
  const spawns = [];
  let bag = [];
  for (let i = 0; ; i += 1) {
    const nominal = SPAWN_LEAD + i * P.interval;
    if (nominal - P.jitter >= LEVEL_TICKS) break;
    const tick = nominal + rng.nextInt(2 * P.jitter + 1) - P.jitter;
    if (bag.length === 0) {
      bag = [];
      for (let k = 0; k < P.K; k += 1) bag.push(k);
      shuffle(rng, bag);
    }
    const colour = bag.pop();
    if (tick < LEVEL_TICKS) spawns.push({ index: spawns.length, tick, colour });
  }
  return spawns;
}

/**
 * AC-808. A schedule that stops short of the clock is a BUILD ERROR, not a level.
 *
 * This is the failure that replaced `SPAWN_EXHAUSTED`. Under a quota the danger was a schedule
 * too short for an unknown number of cars, and the guard fired when a further spawn was needed
 * and unavailable. Under a clock the schedule is exactly as long as the clock, so running out
 * is impossible and STOPPING EARLY is the harder fault: the level still plays, still ends on
 * the bell, and simply has fewer cars in it than the difficulty model says — which moves `N`,
 * and with it every window in generation.md §7.1.10, with nothing visibly wrong.
 */
export function assertScheduleReachesClock(level) {
  const sp = level.spawns;
  // AC-808's bound is `interval + 2 * jitter` and NOT `interval + jitter`, and round 9 found
  // that by tripping it. gameplay.md §2.7's loop considers every nominal slot with
  // `nominal - jitter < LEVEL_TICKS` and keeps it only if the JITTERED tick is under the
  // clock, so the last KEPT slot can be preceded by a DROPPED one whose draw was positive
  // while its own draw was negative. The worst gap the loop can construct is therefore one
  // whole `jitter` wider than the old guard allowed, and the guard was throwing on legal
  // schedules at a rate that depends on where `SPAWN_LEAD + i * interval` lands relative to
  // 7,200. Round 8's table never hit it; round 9's lever sweep hit it at 145/14, 142/14,
  // 134/13, 100/18 and 96/16 while leaving 143/14 and 140/14 clean.
  //
  // This is gameplay.md §8.4's lesson arriving from the other direction: the constant WAS
  // written as a function of the lever, and the function was wrong by a term — which is worse
  // than a constant, because it looks correct and only fires for some values.
  const reach = level.interval + 2 * level.jitter;
  if (sp.length === 0 || LEVEL_TICKS - sp[sp.length - 1].tick > reach) {
    throw new Error(
      'SHORT_SCHEDULE: band=' + level.band + ' seed=' + level.seed +
        ' last=' + (sp.length ? sp[sp.length - 1].tick : 'none') +
        ' of ' + LEVEL_TICKS + ' (interval+2*jitter=' + reach + ')',
    );
  }
  return level;
}

/**
 * generation.md §3.2 states that colW and rowH are exact integers for every (C, R) the band
 * table uses, and AC-218 requires every node x/y and every edge lengthMlu to be integral.
 * Neither is enforced by the construction: §3.2 divides `ROUTE_H` by `R` and halves
 * `colW * (C - 1)`. A band-table edit picking an `R` that does not divide 1080, or a `colW`
 * with `colW * (C - 1)` odd, would produce a level generate() happily accepts, with float node
 * positions and float `progress` accumulating inside the simulation — the exact thing the
 * fixed-point rule of gameplay.md §2.2 exists to prevent. Slice 1 injected `R = 7` and got a
 * level back, with a car holding `progress = 1371.4285714285797` by tick 683.
 *
 * This is a guard at level construction, not a validity rule: it rejects an impossible band
 * table rather than an unlucky candidate network, so it throws rather than returning a rule id
 * for validate() to retry on.
 */
export function assertIntegerGeometry(level) {
  const bad = [];
  if (ROUTE_H % level.R !== 0) bad.push('ROUTE_H ' + ROUTE_H + ' is not divisible by R=' + level.R);
  if ((level.colW * (level.C - 1)) % 2 !== 0) {
    bad.push('colW*(C-1) is odd: ' + level.colW + '*' + (level.C - 1));
  }
  if (!Number.isInteger(level.colW)) bad.push('colW=' + level.colW);
  if (!Number.isInteger(level.rowH)) bad.push('rowH=' + level.rowH);
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
  const colW = colWFor(C); // generation.md §3.2.1 — derived, not tabled
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
  //
  // generation.md §3.3 — the length is Manhattan and exact: |Δx| + |Δy|, computed from the
  // endpoints rather than read from a per-band table. `diagLen`, its offline 128-step chord
  // derivation and the unit test that guarded it against drift are all deleted (AC-207).
  const edges = [];
  const addEdge = (fromId, toId, shape) => {
    const a = nodes[fromId];
    const b = nodes[toId];
    const lengthLu = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const id = edges.length;
    edges.push({ id, from: fromId, to: toId, lengthMlu: lengthLu * MLU, shape });
    nodes[fromId].out.push(id);
    return id;
  };

  const entryEdgeId = addEdge(entryId, idAt.get('0,' + net.entryCol), 'entry');

  for (let r = 0; r < R; r += 1) {
    const srcs = net.rows[r];
    for (let i = 0; i < srcs.length; i += 1) {
      const fromId = idAt.get(r + ',' + srcs[i]);
      for (const t of net.rowEdges[r][i]) {
        const d = t - srcs[i];
        const shape = d === 0 ? 'straight' : d < 0 ? 'jogL' : 'jogR';
        addEdge(fromId, idAt.get(r + 1 + ',' + t), shape);
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

  return assertScheduleReachesClock(assertIntegerGeometry({
    seed,
    band: P.band,
    C,
    K,
    R,
    colW,
    rowH,
    nodes,
    edges,
    junctions,
    entryEdgeId,
    // Speed is CAR_SPEED, a constant, and is deliberately NOT a field on the level
    // (generation.md §1, §6.1). A per-level copy would be a second place the value lives and
    // the one a future band table could quietly diverge from.
    interval: P.interval,
    jitter: P.jitter,
    spawns: spawnSchedule(seed, P),
  }));
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
 * gameplay.md §4.6b / AC-245. For every entry-to-depot path, the path length from the entry
 * node to the FIRST branch node on that path, converted to ticks. Returns the minimum over all
 * paths — the window the player has to make a decision that cannot be prepared. Paths with no
 * branch at all are not decisions and do not contribute.
 *
 * With V14 in force the minimum is `ENTRY_LEN + rowH` in ticks at every band —
 * 159 / 151 / 132 / 125 / 120 — because rows[0] holds one pass node and V15 makes its edge
 * vertical, so rows[1] holds one node too.
 */
export function firstDecisionTicks(level) {
  // Accumulated in MLU and divided exactly once, so no partial length is ever held as a
  // fraction of an LU.
  let min = Infinity;
  const walk = (nodeId, mlu) => {
    const n = level.nodes[nodeId];
    if (n.kind === 'depot') return;
    if (n.kind === 'branch') {
      const t = Math.ceil(mlu / CAR_SPEED);
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
 * They are separate functions rather than branches of one cascade because eleven of the
 * fourteen never reject anything `tryBuild` produces (§5.2) — they are structural tripwires,
 * and the only way their checks are ever executed against a violation is to invoke them
 * DIRECTLY on a fixture built to break them. Run through validate()'s ordered cascade an
 * earlier rule always catches the fixture first, which is how slice 1's blind pass left V5 and
 * V9 never once executed against a violation (AC-244).
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

  /**
   * V14 — the row-0 node is a PASS (gameplay.md §4.6b, AC-248). `buildRow`'s `forcePass`
   * argument makes this true by construction, so this predicate never rejects a candidate the
   * shipped generator produces. It is numbered because it is one of the two rules a future
   * generator change is most likely to break without noticing, and its failure — an unfair
   * first decision — does not show up in a clear rate.
   */
  V14(level) {
    const row0 = level.nodes.filter((n) => n.row === 0);
    if (row0.length !== 1) return true;
    return row0[0].kind !== 'pass';
  },

  /**
   * V15 — a road changes column only at a junction (generation.md §2.5 rule (P), AC-249).
   * Every `pass` and `entry` node has exactly one outgoing edge and that edge has Δcol = 0.
   * This is the single rule §2.5's entire non-coincidence proof rests on: it is what makes
   * "every corner in the network is a junction corner" a theorem rather than a hope.
   */
  V15(level) {
    for (const n of level.nodes) {
      if (n.kind !== 'pass' && n.kind !== 'entry') continue;
      if (n.out.length !== 1) return true;
      if (level.nodes[level.edges[n.out[0]].to].col !== n.col) return true;
    }
    return false;
  },
};

/** The order generation.md §5 checks the rules in; the id is what an audit failure reports. */
export const RULE_ORDER = [
  'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V13', 'V14', 'V15',
];

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
