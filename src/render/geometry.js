// Offramp — play-surface geometry in LU (ui.md §4.1, §7, generation.md §2.3, §3.4).
//
// Pure maths. No React, no Skia, no simulation logic. Floating point lives here on purpose:
// the simulation has already decided where a car is, in integers, and this turns
// (edgeId, progress) into a point so the canvas — and tools/ — can draw it
// (generation.md §3.4). NOTHING in src/engine/ holds a float any more.
//
// ROUND 8: every road is horizontal or vertical. The cubic Béziers, the 65-entry arc-length
// table per edge shape, `Math.hypot` in the length derivation and the per-band `diagLen`
// literal are all DELETED. An edge is a polyline of at most two segments, its length is
// `|Δx| + |Δy|` exactly, and a car is placed by walking those segments and consuming
// `progress` — at most two segments, no table, no binary search.
//
// Everything is built ONCE PER LEVEL. Nothing in this module is per-frame work except
// `carPose`, which is a walk over at most two segments.

import { MLU } from '../engine/index.js';

// --- ui.md §4.1, geometry constants (LU) ------------------------------------------------
// Round 8 shrank everything by roughly a fifth. The ratios that matter were preserved:
// CAR_W (66) is narrower than ROAD_W (84) leaving a 9 LU shoulder each side, and the junction
// marker's diameter (68) is now SMALLER than the road, so the marker sits inside its road
// rather than overhanging it (AC-503).
export const ROAD_W = 84;
export const ROAD_EDGE_W = 4;
/**
 * The centreline fillet a car follows through a corner. A third of the road width: large
 * enough to read as a turn rather than a mitre, small enough that the road's outer corner is
 * still square-shouldered. The largest deviation between the filleted path and the polyline is
 * `CORNER_R * (sqrt(2) - 1) ~ 11.6` LU, well inside the road's 42 LU half-width, so a car never
 * leaves the tarmac on a turn (ui.md §4.1).
 */
export const CORNER_R = 28;
export const CAR_L = 104;
/**
 * CAR_W = 66 is set by AC-402 and by nothing else: the smallest supported configuration
 * (playW 320, playH 460) scales at 0.30667, so `CAR_W >= 65.2`. 66 gives 20.24 pt. The car
 * cannot get smaller than this without raising the support floor or re-arguing AC-402.
 */
export const CAR_W = 66;
export const CAR_RADIUS = 12;
export const GLYPH_CAR = 42;
export const GLYPH_CAR_LARGE = 58;
export const GLYPH_DEPOT = 52;
export const GLYPH_DEPOT_LARGE = 72;
export const JUNCTION_MARK_R = 34;
export const DEPOT_W = 124;
export const DEPOT_H = 128;
export const COMMIT_PREVIEW = 200;
export const TERRACE_FADE = 28;

// ui.md §7.2 — lane dashes, 3 LU wide, 16 on / 22 off, drawn along the FILLETED centreline so
// a dash never lands on a corner as a wedge.
export const LANE_DASH_W = 3;
export const LANE_DASH_ON = 16;
export const LANE_DASH_OFF = 22;

// ui.md §7.3 — junction marker. Both blade dimensions are proportions of the marker and are
// specified there rather than left to the renderer: 30 LU from the centre of a 34 LU disc
// keeps the whole blade on the marker and leaves 4 LU of disc face between the blade's tip and
// the inside of the ring. 9 LU is a 3.3 : 1 bar — 9.6 x 2.9 pt at the smallest supported
// scale — the thinnest bar whose direction is still readable at that size.
export const JUNCTION_RING_W = 4;
export const BLADE_LEN = 30;
export const BLADE_W = 9;
const OPEN_BRANCH_LU = 120;
/**
 * ui.md §7.3. The open-branch overdraw is butt-capped at both ends — a round cap on an 84 LU
 * stroke would put a 42 LU lobe of brightened road ABOVE the junction node, reading as the
 * branch being open backwards — and the near butt end is hidden under the 34 LU marker disc.
 * The far end is hidden by nothing, so the overdraw's alpha ramps linearly to zero over its
 * final 28 LU: the shortest run over which a road-width stroke can end without showing an edge.
 */
export const OPEN_BRANCH_FADE = 28;
const ARMED_ARC_LU = 170;
export const ARMED_ARC_W = 3;
export const RIPPLE_R0 = 34;
export const RIPPLE_R1 = 62;

// ui.md §7.4 — depot (AC-518). Every number scaled with the depot's 0.78 shrink except the
// disc ratio, which is derived and does not scale.
export const DEPOT_RADIUS = 10;
export const DEPOT_FACE_BAND = 14;
export const DEPOT_HATCH_W = 5;
export const DEPOT_RECEIVING_SCALE = 1.04;
/**
 * The glyph disc's radius as a multiple of the glyph size — 39 LU at GLYPH_DEPOT = 52, 54 LU
 * at GLYPH_DEPOT_LARGE = 72. Derived, not picked: the widest glyph in ui.md §6.2 is a filled
 * square, whose corners sit at (sqrt(2)/2) * s = 0.707 s from the centre, so any radius below
 * 0.707 clips it. 0.75 is the next step up that leaves visible margin (2.2 LU at Standard,
 * 3.1 LU at Large) and the 108 LU disc at Large still clears DEPOT_W = 124 by 8 LU a side.
 * Do not take this below 0.72.
 */
export const DEPOT_DISC_RATIO = 0.75;
// The sill: three DEPOT_HATCH_W bars on an 8 LU pitch, inset 12 LU from each side of the
// body, with the lowest bar's bottom edge 6 LU above the body's. Bottom 21 LU of DEPOT_H.
export const DEPOT_SILL_BARS = 3;
export const DEPOT_SILL_PITCH = 8;
export const DEPOT_SILL_INSET = 12;
export const DEPOT_SILL_BOTTOM = 6;

// ui.md §7.5 — entry flare. Carries no colour: the car body is the only thing that says
// which colour arrived (AC-517).
export const FLARE_R = 28;
export const FLARE_W = 5;
export const FLARE_SCALE_FROM = 0.6;
export const FLARE_SCALE_TO = 1.4;

// ui.md §4.3 — the windscreen: 26 across the body, 36 along it, radius 6, offset 24 toward the
// nose, in `--text` at 22 %.
export const GLASS_W = 26;
export const GLASS_L = 36;
export const GLASS_RADIUS = 6;
export const GLASS_OFFSET = 24;
export const CAR_SHADOW_DY = 5;

/**
 * ui.md §7.6 — the depot terrace's depth, measured back from the depot node along the terminal
 * edge. `mouthLu = rowH - JUNCTION_MARK_R - 12`, taken at EQUALITY at every band: it is the
 * maximum legal value, not a taste value, and the constraint is that the terrace never reaches
 * the junction marker at the top of a terminal edge (AC-514). Indexed by band, 1-based.
 * Transcribed from ui.md §7.6; the assertion that it equals the formula is AC-514's.
 */
export const MOUTH_LU = [0, 170, 170, 134, 134, 134];

// --- edge polylines (generation.md §2.3) -------------------------------------------------

/**
 * generation.md §2.3. An edge from `(r, a)` to `(r+1, b)` is drawn as:
 *   b === a   one vertical segment
 *   b !== a   a horizontal run at the SOURCE row's y, then a vertical drop at the target's x
 * The horizontal run happens at the node itself, not part-way down, which is what makes a
 * branch node a corner or a T rather than a fork with a stem. §2.5 proves the run can never
 * land on another node.
 */
export function edgePolyline(level, edge) {
  const a = level.nodes[edge.from];
  const b = level.nodes[edge.to];
  if (a.x === b.x) return [[a.x, a.y], [b.x, b.y]];
  return [[a.x, a.y], [b.x, a.y], [b.x, b.y]];
}

function segmentsOf(points) {
  const segs = [];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const len = Math.abs(x1 - x0) + Math.abs(y1 - y0); // one of the two terms is zero
    // The car's heading, in the renderer's convention: 0 is "nose pointing down the screen".
    const angle = Math.atan2(y1 - y0, x1 - x0) - Math.PI / 2;
    segs.push({ x0, y0, x1, y1, len, angle, dx: Math.sign(x1 - x0), dy: Math.sign(y1 - y0) });
  }
  return segs;
}

/**
 * Per-edge geometry, built once per level. `lengthLu` is the engine's own edge length, which
 * is `|Δx| + |Δy|` by construction (generation.md §3.3) and therefore equals the sum of the
 * segment lengths EXACTLY — there is no scale factor and no residue, which is the whole of
 * what orthogonal roads bought the renderer.
 */
export function buildCurves(level) {
  return level.edges.map((edge) => {
    const points = edgePolyline(level, edge);
    const segs = segmentsOf(points);
    return {
      edgeId: edge.id,
      shape: edge.shape,
      points,
      segs,
      lengthLu: edge.lengthMlu / MLU,
      cornerAt: segs.length === 2 ? segs[0].len : null,
    };
  });
}

/** Linear interpolation along one segment. */
function pointOnSeg(seg, d) {
  const f = seg.len === 0 ? 0 : d / seg.len;
  return [seg.x0 + (seg.x1 - seg.x0) * f, seg.y0 + (seg.y1 - seg.y0) * f];
}

/** A quadratic Bézier, which is exactly the shape of a circular-ish corner fillet. */
function quad(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

/**
 * generation.md §3.4 — placing a car, renderer only. Walk the edge's segments in order and
 * consume `lu`: at most two segments, no table, no arc-length parameterisation, no binary
 * search. Where the walk lands within CORNER_R of the corner, interpolate onto the fillet and
 * rotate the sprite through the 90°, LINEAR IN ARC LENGTH and not eased — easing would make
 * the car appear to hesitate at a junction, which is the one place in the game where
 * hesitation means something (ui.md §4.3).
 *
 * Returns { x, y, angle } in LU, with angle 0 meaning "nose pointing down the screen".
 */
export function poseAtLu(curve, lu) {
  const segs = curve.segs;
  const d = Math.max(0, Math.min(curve.lengthLu, lu));

  if (segs.length === 1) {
    const [x, y] = pointOnSeg(segs[0], d);
    return { x, y, angle: segs[0].angle };
  }

  const L1 = segs[0].len;
  const r = Math.min(CORNER_R, L1, segs[1].len);
  if (d <= L1 - r) {
    const [x, y] = pointOnSeg(segs[0], d);
    return { x, y, angle: segs[0].angle };
  }
  if (d >= L1 + r) {
    const [x, y] = pointOnSeg(segs[1], d - L1);
    return { x, y, angle: segs[1].angle };
  }
  const t = (d - (L1 - r)) / (2 * r);
  const p0 = pointOnSeg(segs[0], L1 - r);
  const p1 = [segs[0].x1, segs[0].y1];
  const p2 = pointOnSeg(segs[1], r);
  const [x, y] = quad(p0, p1, p2, t);
  // The two headings always differ by exactly 90° (a horizontal run into a vertical drop), so
  // the shortest-arc interpolation is unambiguous and needs no wrapping.
  let a0 = segs[0].angle;
  const a1 = segs[1].angle;
  if (a1 - a0 > Math.PI) a0 += 2 * Math.PI;
  else if (a0 - a1 > Math.PI) a0 -= 2 * Math.PI;
  return { x, y, angle: a0 + (a1 - a0) * t };
}

/** Point at `lu` LU along the edge, measured from its start. */
export function pointAtLu(curve, lu) {
  const p = poseAtLu(curve, lu);
  return [p.x, p.y];
}

/** Screen-space point (in LU) of a car, from its integer (edgeId, progress). */
export function carPoint(curves, car) {
  const p = poseAtLu(curves[car.edgeId], car.progress / MLU);
  return [p.x, p.y];
}

/** A car's pose: centre in LU plus the heading of the road under it, in radians. */
export function carPose(curves, car) {
  return poseAtLu(curves[car.edgeId], car.progress / MLU);
}

/**
 * A polyline along the edge from `fromLu` to `toLu`, following the fillet. Used for the
 * open-branch overdraw, the armed bar and the mouth glow — all of which are sub-stretches of
 * an edge and all of which are stroked wide enough that a sampled fillet and an exact one are
 * the same picture.
 */
export function subPathPoints(curve, fromLu, toLu, stepLu = 8) {
  const a = Math.max(0, Math.min(fromLu, toLu));
  const b = Math.min(curve.lengthLu, Math.max(fromLu, toLu));
  const n = Math.max(1, Math.ceil((b - a) / stepLu));
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push(pointAtLu(curve, a + ((b - a) * i) / n));
  return out;
}

/**
 * The filleted centreline of one edge, as a path description the caller turns into a Skia
 * path: `{ start, corner: { before, control, after } | null, end }`. The lane dashes follow
 * this so a dash turns the corner instead of meeting it at a point (ui.md §7.2).
 */
export function filletedCentreline(curve) {
  const segs = curve.segs;
  if (segs.length === 1) {
    return { start: [segs[0].x0, segs[0].y0], corner: null, end: [segs[0].x1, segs[0].y1] };
  }
  const r = Math.min(CORNER_R, segs[0].len, segs[1].len);
  return {
    start: [segs[0].x0, segs[0].y0],
    corner: {
      before: pointOnSeg(segs[0], segs[0].len - r),
      control: [segs[0].x1, segs[0].y1],
      after: pointOnSeg(segs[1], r),
    },
    end: [segs[1].x1, segs[1].y1],
  };
}

// --- ui.md §7.6, the depot terrace --------------------------------------------------------

/** Every edge whose far end is a depot — the terminal edges the terrace is laid over. */
function terminalEdges(level) {
  return level.edges.filter((e) => level.nodes[e.to].kind === 'depot');
}

/**
 * ui.md §7.6. ONE rounded rectangle across the depot row, not `K` aprons: under orthogonal
 * routing every terminal edge ends in a vertical drop at a depot column, so the region to
 * cover is a single horizontal band. One rect with one gradient along its top edge covers it,
 * cannot stack alpha with itself, and is built once per level — which is how AC-516 went from
 * carefully satisfied (a `saveLayer` and a per-edge apron stroke) to trivially satisfied.
 */
export function buildTerrace(level, depotY) {
  const mouthLu = MOUTH_LU[level.band];
  const xs = level.nodes.filter((n) => n.kind === 'depot').map((n) => n.x);
  const left = Math.min(...xs) - DEPOT_W / 2 - 12;
  const right = Math.max(...xs) + DEPOT_W / 2 + 12;
  const top = depotY - mouthLu;
  const bottom = depotY + DEPOT_H;
  return { mouthLu, x: left, y: top, w: right - left, h: bottom - top, fade: TERRACE_FADE };
}

/**
 * Per terminal edge: the terrace LINE — the last point at which a car on this edge was
 * visible — and the sub-path of its last `mouthLu`, which the delivery glow lights and the
 * misroute shatter is thrown from (ui.md §8.3, §8.4, AC-515, AC-519).
 */
function buildMouths(level, curves) {
  const mouthLu = MOUTH_LU[level.band];
  return terminalEdges(level).map((e) => {
    const c = curves[e.id];
    const L = c.lengthLu;
    return {
      edgeId: e.id,
      depotNodeId: e.to,
      mouthLu,
      mouthPoint: pointAtLu(c, Math.max(0, L - mouthLu)),
      glow: subPathPoints(c, Math.max(0, L - mouthLu), L),
    };
  });
}

/**
 * ui.md §7.3. For every junction: the centre, the blade's heading for each branch, and the
 * sub-paths the open-branch overdraw and the armed bar follow.
 *
 * THE BLADE POINTS ALONG THE FIRST SEGMENT OF THE OPEN BRANCH, and under orthogonal roads
 * that is unambiguous: a `straight` edge's first segment is vertical (down), a `jogL`'s is
 * horizontal (left), a `jogR`'s is horizontal (right). So the blade has exactly three possible
 * headings and the two branches of any junction differ by 90° or 180° (AC-504).
 *
 * Under the cubic model every edge left its node vertically, so a tangent-derived blade drew
 * the identical vertical bar for both branches and the junction silently stopped showing its
 * state; that shipped in slice 2 and was caught by looking at a screenshot. It is gone by
 * CONSTRUCTION now, not by discipline — the tangent at the node IS the first segment's
 * direction.
 */
function buildJunctionGeometry(level, curves) {
  return level.junctions.map((nodeId, junctionId) => {
    const n = level.nodes[nodeId];
    const branches = n.out.map((edgeId) => {
      const c = curves[edgeId];
      const openTo = Math.min(OPEN_BRANCH_LU, c.lengthLu);
      const fadeFrom = Math.max(0, openTo - OPEN_BRANCH_FADE);
      return {
        edgeId,
        // The first segment's direction, in the blade's own convention: the angle the bar is
        // rotated by, with 0 pointing right along +x.
        angle: c.segs[0].angle + Math.PI / 2,
        open: subPathPoints(c, 0, fadeFrom),
        openFade: subPathPoints(c, fadeFrom, openTo),
        armed: subPathPoints(c, 0, Math.min(ARMED_ARC_LU, c.lengthLu)),
      };
    });
    return { junctionId, nodeId, x: n.x, y: n.y, branches };
  });
}

/**
 * ui.md §7.4 / AC-518 — the sill: DEPOT_SILL_BARS rounded bars, each DEPOT_HATCH_W tall on a
 * DEPOT_SILL_PITCH pitch, inset DEPOT_SILL_INSET from each side of the body, with the LOWEST
 * bar's bottom edge DEPOT_SILL_BOTTOM above the body's bottom edge.
 */
function depotSill(x, y, w, h) {
  const bars = [];
  for (let i = 0; i < DEPOT_SILL_BARS; i += 1) {
    bars.push({
      x: x + DEPOT_SILL_INSET,
      y: y + h - DEPOT_SILL_BOTTOM - DEPOT_HATCH_W - (DEPOT_SILL_BARS - 1 - i) * DEPOT_SILL_PITCH,
      w: w - 2 * DEPOT_SILL_INSET,
      h: DEPOT_HATCH_W,
    });
  }
  return bars;
}

/** The depots, with the body rect and the sill the renderer draws (ui.md §7.4). */
function buildDepots(level) {
  return level.nodes
    .filter((n) => n.kind === 'depot')
    .map((n) => ({
      nodeId: n.id,
      colour: n.depotColour,
      cx: n.x,
      cy: n.y + DEPOT_H / 2,
      x: n.x - DEPOT_W / 2,
      y: n.y,
      w: DEPOT_W,
      h: DEPOT_H,
      sill: depotSill(n.x - DEPOT_W / 2, n.y, DEPOT_W, DEPOT_H),
    }));
}

/** The entry node, where the flare is drawn (ui.md §7.5). */
function entryNode(level) {
  return level.nodes[level.edges[level.entryEdgeId].from];
}

/**
 * Everything the play surface needs that does not change during a level. Built once, at
 * level load. Nothing here is per-frame work and nothing here reads simulation state.
 */
export function buildLevelGeometry(level) {
  const curves = buildCurves(level);
  const depotY = level.nodes.find((n) => n.kind === 'depot').y;
  return {
    level,
    curves,
    mouths: buildMouths(level, curves),
    terrace: buildTerrace(level, depotY),
    junctions: buildJunctionGeometry(level, curves),
    depots: buildDepots(level),
    entry: entryNode(level),
  };
}

/**
 * AC-506 / ui.md §7.3. The junction is "armed" when the nearest car approaching it along an
 * incoming edge is within COMMIT_PREVIEW LU of the node. Returns the remaining distance in
 * LU, or Infinity when no car is approaching.
 */
export function armingDistanceLu(level, curves, cars, nodeId) {
  let best = Infinity;
  for (const car of cars) {
    const e = level.edges[car.edgeId];
    if (e.to !== nodeId) continue;
    const remaining = curves[car.edgeId].lengthLu - car.progress / MLU;
    if (remaining < best) best = remaining;
  }
  return best;
}
