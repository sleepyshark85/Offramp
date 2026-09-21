// Offramp — audits of two render-facing claims that need a sweep to settle (ui.md §7.3, §8.3,
// §8.4; AC-140, AC-504).
//
// Harness code, shared by tools/render-audit.mjs (the full 1,000-levels-a-band sweep) and by
// test/render-geometry.test.js (a sample small enough to live inside `npm test`). One
// implementation, two callers — the alternative is two statistics that have to agree
// (docs/development-process.md §6.3).
//
// BOTH AUDITS TAKE AN INJECTION ARGUMENT, and that is the point of them. Each one exists to
// catch a defect that shipped in slice 2 and was found by looking rather than by a test, so
// each one is run against the defect before it is trusted against the fix (§6.2, §6.8). The
// expectation each audit is measured against comes from ui.md, never from the module under
// test.

import { LIVES, createState, generate, reachableColourMasks, step } from '../../src/engine/index.js';
import { buildLevelGeometry } from '../../src/render/geometry.js';

/**
 * ui.md §7.3 / AC-504. The floor is stated in the design; it is not read off a measurement.
 *
 * IT MOVED 30 -> 90 IN ROUND 8, and the restatement is EXACT rather than measured. The old
 * threshold was derived from `atan(colW / rowH)` — the angle between a straight branch and a
 * diagonal one under the cubic model — and measured out at 36.87 / 39.09 / 40.91 / 44.27° for
 * straight-against-diagonal. Orthogonal branches leave the node at right angles by
 * construction: a branch is {c, c±1} (one vertical, one horizontal -> 90°) or {c-1, c+1} (two
 * opposed horizontals -> 180°). There are no other cases and no measurement is needed.
 */
export const BLADE_SEPARATION_FLOOR_DEG = 90;

const DEG = 180 / Math.PI;
const MAX_RUN_TICKS = 20000;

/**
 * The blade's heading for one branch of one junction, in radians.
 *
 *   'first-segment' — production (src/render/geometry.js): the direction of the FIRST SEGMENT
 *                     of `out[k]` — down for a `straight`, left for a `jogL`, right for a
 *                     `jogR`. ui.md §7.3 is normative on this.
 *
 *   'wrong-branch'  — the blade drawn along the OTHER branch. This is the injection the ≥ 90°
 *                     clause is kept for: no construction prevents a renderer indexing `out`
 *                     with `1 - open`, and the separation goes to 0 at every junction.
 *
 *   'far-chord'     — the chord to the branch's FAR node, which is what slices 0–2 used and
 *                     what ui.md §7.3 said while roads were cubics. Under orthogonal routing
 *                     it is wrong: a jog's far node sits down AND across, so the chord reads
 *                     about 50° from vertical where the blade must read 90° or 180°. It is
 *                     included because "the rule that was right last round" is the most likely
 *                     way for this to regress.
 *
 * The slice-2 tangent defect — every cubic left its node vertically, so a tangent-derived
 * blade drew the identical vertical bar for both branches — is GONE BY CONSTRUCTION rather
 * than by discipline, because the tangent at the node now IS the first segment's direction.
 * There is therefore nothing left to inject for it, and that is an improvement rather than a
 * gap: the defect is unreachable, not merely unchecked.
 */
function bladeAngle(level, geom, j, k, mode) {
  if (mode === 'first-segment') return j.branches[k].angle;
  if (mode === 'wrong-branch') return j.branches[1 - k].angle;
  if (mode === 'far-chord') {
    const node = level.nodes[j.nodeId];
    const far = level.nodes[level.edges[j.branches[k].edgeId].to];
    return Math.atan2(far.y - node.y, far.x - node.x);
  }
  throw new Error('unknown blade mode: ' + mode);
}

/** Smallest angle between two headings, in degrees, in [0, 180]. */
export function angularSeparationDeg(a, b) {
  let d = Math.abs(a - b) * DEG;
  d %= 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * AC-504's second clause. For every junction of every level in the sweep, the angle the blade
 * is drawn at with `open === 0` against the angle with `open === 1`.
 *
 * Returns the floor, the distinct values seen (rounded to 0.01°, because the clause is about
 * whether the eight values the lattice can produce are all above the threshold), and the count
 * of junctions below `BLADE_SEPARATION_FLOOR_DEG`.
 */
export function auditBladeSeparation({ bands = [1, 2, 3, 4, 5], levels = 100, seedBase = 700000, mode = 'first-segment' } = {}) {
  let junctions = 0;
  let below = 0;
  let floor = Infinity;
  const distinct = new Map();
  const worst = { deg: Infinity, seed: 0, band: 0, junctionId: -1 };

  for (const band of bands) {
    for (let i = 0; i < levels; i += 1) {
      const seed = seedBase + band * 1000003 + i;
      const level = generate(seed, band);
      const geom = buildLevelGeometry(level);
      for (const j of geom.junctions) {
        const deg = angularSeparationDeg(
          bladeAngle(level, geom, j, 0, mode),
          bladeAngle(level, geom, j, 1, mode),
        );
        junctions += 1;
        if (deg < BLADE_SEPARATION_FLOOR_DEG) below += 1;
        if (deg < floor) floor = deg;
        if (deg < worst.deg) {
          worst.deg = deg;
          worst.seed = seed;
          worst.band = band;
          worst.junctionId = j.junctionId;
        }
        const key = deg.toFixed(2);
        distinct.set(key, (distinct.get(key) || 0) + 1);
      }
    }
  }

  return {
    junctions,
    below,
    floorDeg: floor,
    worst,
    distinct: [...distinct.entries()].map(([deg, n]) => ({ deg: Number(deg), n })).sort((a, b) => a.deg - b.deg),
  };
}

/**
 * AC-504's FIRST clause, and the one that actually catches a blade drawn along the wrong
 * branch. The expected heading is re-derived from the edge's `shape` tag using ui.md §7.3's
 * own words — "down for a `straight`, left for a `jogL`, right for a `jogR`" — which shares
 * nothing with src/render/geometry.js's derivation from the polyline.
 *
 * THIS EXISTS BECAUSE THE SECOND CLAUSE CANNOT DO IT. ui.md §7.3 and AC-504 both say the ≥ 90°
 * separation check "also catches a blade drawn along the wrong branch". It does not: drawing
 * branch k's blade along `out[1 - k]` SWAPS the two angles, and the separation between a
 * swapped pair is the separation between the original pair. Measured: the `wrong-branch`
 * injection leaves the separation histogram bit-identical. The separation clause catches a
 * blade that is wrong in DIRECTION; only this clause catches one that is wrong in CHOICE.
 */
export function auditBladeDirection({ bands = [1, 2, 3, 4, 5], levels = 100, seedBase = 700000, mode = 'first-segment' } = {}) {
  // ui.md §7.3, transcribed. Angles in the blade's own convention: 0 points right along +x.
  const EXPECTED = { straight: Math.PI / 2, jogL: Math.PI, jogR: 0, entry: Math.PI / 2 };
  let checked = 0;
  let wrong = 0;
  const worst = { deg: 0, seed: 0, band: 0, junctionId: -1, shape: null };
  for (const band of bands) {
    for (let i = 0; i < levels; i += 1) {
      const seed = seedBase + band * 1000003 + i;
      const level = generate(seed, band);
      const geom = buildLevelGeometry(level);
      for (const j of geom.junctions) {
        for (let k = 0; k < 2; k += 1) {
          const shape = level.edges[j.branches[k].edgeId].shape;
          const want = EXPECTED[shape];
          const got = bladeAngle(level, geom, j, k, mode);
          const off = angularSeparationDeg(want, got);
          checked += 1;
          if (off > 1e-9) {
            wrong += 1;
            if (off > worst.deg) Object.assign(worst, { deg: off, seed, band, junctionId: j.junctionId, shape });
          }
        }
      }
    }
  }
  return { checked, wrong, worst };
}

// --- AC-140 -------------------------------------------------------------------------------

/** Does branch k of this branch node lead to a depot of `colour`? */
function reaches(level, masks, node, k, colour) {
  return ((masks[level.edges[node.out[k]].to] >> colour) & 1) === 1;
}

/** The branch nodes a car will ENTER during this tick's advance, given `open` as it stands. */
function branchesEnteredThisTick(level, open, car) {
  const out = [];
  let edge = level.edges[car.edgeId];
  let progress = car.progress + level.speedMluPerTick;
  while (progress >= edge.lengthMlu) {
    progress -= edge.lengthMlu;
    const node = level.nodes[edge.to];
    if (node.kind === 'depot') break;
    if (node.kind === 'branch') out.push(node);
    edge = level.edges[node.out[node.kind === 'branch' ? open[node.junctionId] : 0]];
  }
  return out;
}

/**
 * AC-140's third clause, for one level.
 *
 * Runs the level with a router that routes perfectly except for the first `LIVES - 1` cars,
 * which are sent deliberately into a subtree that cannot reach their colour. Both `delivered`
 * and `misrouted` are therefore exercised on every run, and the run still reaches the BELL
 * rather than being cut short at zero lives — which is what makes an average level contribute
 * `N + 2` arrivals instead of twelve. On every tick it records each car's
 * `edgeId` BEFORE `step()` — which is exactly the previous-tick inference the renderer used
 * through slice 2 (`withEdge()` in src/ui/loop.js, now deleted) — and compares it with the
 * `edgeId` the engine puts on the arrival event.
 *
 *   inject 'depot-first' — replaces the engine's value with the first terminal edge feeding
 *                          the arriving depot. That is the shape of the slice-2 defect in
 *                          AC-515 and AC-519: "some mouth of this depot" instead of "the
 *                          mouth this car came down". It must make this audit fail.
 */
export function auditArrivalEdgesForLevel(level, { misrouteBudget = LIVES - 1, inject = null } = {}) {
  const masks = reachableColourMasks(level);
  const terminalByDepot = new Map();
  for (const e of level.edges) {
    if (level.nodes[e.to].kind !== 'depot') continue;
    if (!terminalByDepot.has(e.to)) terminalByDepot.set(e.to, []);
    terminalByDepot.get(e.to).push(e.id);
  }

  const sacrificed = new Set();
  let budget = misrouteBudget;
  let state = createState(level);
  let seen = 0;
  let delivered = 0;
  let misrouted = 0;
  let disagreements = 0;
  let notTerminal = 0;
  let wrongDepot = 0;
  let sharedMouth = 0; // arrivals at a depot fed by more than one terminal edge
  const examples = [];

  while (state.phase === 'running' && state.tick < MAX_RUN_TICKS) {
    const inputs = [];
    for (const car of state.cars) {
      for (const node of branchesEnteredThisTick(level, state.open, car)) {
        if (sacrificed.has(car.id)) continue;
        const good = [0, 1].filter((k) => reaches(level, masks, node, k, car.colour));
        const bad = [0, 1].filter((k) => !reaches(level, masks, node, k, car.colour));
        let want;
        if (budget > 0 && bad.length > 0) {
          want = bad[0];
          budget -= 1;
          sacrificed.add(car.id);
        } else if (good.length === 0) {
          continue;
        } else if (good.length === 1) {
          want = good[0];
        } else {
          want = state.open[node.junctionId];
        }
        if (state.open[node.junctionId] !== want) inputs.push({ tick: state.tick, junctionId: node.junctionId });
      }
    }
    const once = [...new Set(inputs.map((i) => i.junctionId))].map((junctionId) => ({ tick: state.tick, junctionId }));

    // The previous-tick inference, taken before the step that may produce the arrival.
    const edgeOf = new Map();
    for (const c of state.cars) edgeOf.set(c.id, c.edgeId);

    state = step(state, once);

    for (const e of state.events) {
      if (e.type !== 'delivered' && e.type !== 'misrouted') continue;
      seen += 1;
      if (e.type === 'delivered') delivered += 1;
      else misrouted += 1;

      const fromDepot = terminalByDepot.get(e.depotId) || [];
      if (fromDepot.length > 1) sharedMouth += 1;

      const engineEdge = inject === 'depot-first' ? fromDepot[0] : e.edgeId;
      const inferred = edgeOf.get(e.carId);

      if (!Number.isInteger(engineEdge)) {
        disagreements += 1;
        examples.push({ tick: state.tick, carId: e.carId, engineEdge, inferred, why: 'no edgeId on the event' });
        continue;
      }
      // AC-140's second clause, checked against the LEVEL and not against the renderer.
      if (level.edges[engineEdge].to !== e.depotId) wrongDepot += 1;
      if (level.nodes[level.edges[engineEdge].to].kind !== 'depot') notTerminal += 1;
      // AC-140's third clause: the engine's value and the renderer's old inference agree.
      if (engineEdge !== inferred) {
        disagreements += 1;
        if (examples.length < 5) {
          examples.push({ tick: state.tick, carId: e.carId, engineEdge, inferred, depotId: e.depotId });
        }
      }
    }
  }

  return { seen, delivered, misrouted, sharedMouth, disagreements, notTerminal, wrongDepot, examples, phase: state.phase };
}

/** The same audit over a sweep. */
export function auditArrivalEdges({ bands = [1, 2, 3, 4, 5], levels = 100, seedBase = 400000, inject = null } = {}) {
  const perBand = [];
  let seen = 0;
  let delivered = 0;
  let misrouted = 0;
  let sharedMouth = 0;
  let disagreements = 0;
  let notTerminal = 0;
  let wrongDepot = 0;
  const examples = [];

  for (const band of bands) {
    let bandSeen = 0;
    let bandShared = 0;
    let bandBad = 0;
    for (let i = 0; i < levels; i += 1) {
      const level = generate(seedBase + band * 1000003 + i, band);
      const r = auditArrivalEdgesForLevel(level, { inject });
      bandSeen += r.seen;
      bandShared += r.sharedMouth;
      bandBad += r.disagreements;
      seen += r.seen;
      delivered += r.delivered;
      misrouted += r.misrouted;
      sharedMouth += r.sharedMouth;
      disagreements += r.disagreements;
      notTerminal += r.notTerminal;
      wrongDepot += r.wrongDepot;
      for (const ex of r.examples) if (examples.length < 5) examples.push({ band, ...ex });
    }
    perBand.push({ band, levels, arrivals: bandSeen, sharedMouth: bandShared, disagreements: bandBad });
  }

  return { perBand, seen, delivered, misrouted, sharedMouth, disagreements, notTerminal, wrongDepot, examples };
}
