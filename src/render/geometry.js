// Offramp — play-surface geometry in LU (ui.md §4.1, §7, generation.md §2.3, §3.4).
//
// Pure maths. No React, no Skia, no simulation logic. Floating point lives here on purpose:
// the simulation has already decided where a car is, in integers, and this turns
// (edgeId, progress) into a point so the canvas — and tools/ — can draw it
// (generation.md §3.4).
//
// Everything is built ONCE PER LEVEL. Nothing in this module is per-frame work except
// `carPose`, which is a table lookup and a lerp.

import { K_CTRL_DEN, K_CTRL_NUM, MLU } from '../engine/index.js';

// --- ui.md §4.1, geometry constants (LU) ------------------------------------------------
export const ROAD_W = 104;
export const ROAD_EDGE_W = 4;
export const CAR_L = 140;
export const CAR_W = 84;
export const CAR_RADIUS = 16;
export const GLYPH_CAR = 48;
export const GLYPH_CAR_LARGE = 66;
export const GLYPH_DEPOT = 64;
export const GLYPH_DEPOT_LARGE = 88;
export const JUNCTION_MARK_R = 46;
export const DEPOT_W = 160;
export const DEPOT_H = 170;
export const COMMIT_PREVIEW = 260;
export const MOUTH_W = 176;
export const MOUTH_FADE = 36;

// ui.md §7.2 — lane dashes.
export const LANE_DASH_W = 3;
export const LANE_DASH_ON = 20;
export const LANE_DASH_OFF = 28;

// ui.md §7.3 — junction marker. Both blade dimensions are proportions of the marker and are
// specified there rather than left to the renderer: 40 LU from the centre of a 46 LU disc
// leaves 6 LU of disc face between the blade tip and the inside of the ring at every
// rotation, and 12 LU is three times the ring's 4 LU, a 3.3 : 1 bar that is still readable at
// the smallest supported scale (12.1 x 3.6 pt at 0.3025).
export const JUNCTION_RING_W = 4;
export const BLADE_LEN = 40;
export const BLADE_W = 12;
const OPEN_BRANCH_LU = 150;
/**
 * ui.md §7.3. The open-branch overdraw is butt-capped at both ends — a round cap on a 104 LU
 * stroke would put a 52 LU lobe of brightened road ABOVE the junction node, reading as the
 * branch being open backwards — and the near butt end is hidden under the marker disc. The
 * far end is hidden by nothing, and a butt cap there ends the brightening in a hard line
 * across the road that reads as a painted road marking this game does not have, so the
 * overdraw's alpha ramps linearly to zero over its final 36 LU. Same distance as §7.6's
 * apron fade, for the same reason: the shortest run over which a road-width stroke can end
 * without showing an edge.
 */
export const OPEN_BRANCH_FADE = 36;
const ARMED_ARC_LU = 220;
export const ARMED_ARC_W = 3;
export const RIPPLE_R0 = 46;
export const RIPPLE_R1 = 84;

// ui.md §7.4 — depot (AC-518).
export const DEPOT_RADIUS = 12;
export const DEPOT_FACE_BAND = 18;
export const DEPOT_HATCH_W = 6;
export const DEPOT_RECEIVING_SCALE = 1.04;
/**
 * The glyph disc's radius as a multiple of the glyph size — 48 LU at GLYPH_DEPOT = 64, 66 LU
 * at GLYPH_DEPOT_LARGE = 88. Derived, not picked: the widest glyph in ui.md §6.2 is a filled
 * square, whose corners sit at (sqrt(2)/2) * s = 0.707 s from the centre, so any radius below
 * 0.707 clips it. 0.75 is the next step up that leaves visible margin (2.75 LU at Standard,
 * 3.8 LU at Large) and the 132 LU disc at Large still clears DEPOT_W = 160 by 14 LU a side.
 * Do not take this below 0.72.
 */
export const DEPOT_DISC_RATIO = 0.75;
// The sill: three DEPOT_HATCH_W bars on a 10 LU pitch, inset 16 LU from each side of the
// body, with the lowest bar's bottom edge 8 LU above the body's. Bottom 26 LU of DEPOT_H.
export const DEPOT_SILL_BARS = 3;
export const DEPOT_SILL_PITCH = 10;
export const DEPOT_SILL_INSET = 16;
export const DEPOT_SILL_BOTTOM = 8;

// ui.md §7.5 — entry flare. Carries no colour: the car body is the only thing that says
// which colour arrived (AC-517).
export const FLARE_R = 34;
export const FLARE_W = 6;
export const FLARE_SCALE_FROM = 0.6;
export const FLARE_SCALE_TO = 1.4;

// ui.md §4.3 — the windscreen.
export const GLASS_W = 40;
export const GLASS_L = 60;
export const GLASS_OFFSET = 28;
export const CAR_SHADOW_DY = 6;

/**
 * ui.md §7.6 — LU of arc length, measured back from the depot node, that the apron covers.
 * Transcribed from the band table there; it is a render value and the engine does not hold
 * it. Indexed by band, 1-based.
 */
export const MOUTH_LU = [0, 180, 160, 160, 150, 140];

const K_CTRL = K_CTRL_NUM / K_CTRL_DEN;
const SAMPLES = 64; // a 65-entry distance -> t table (generation.md §3.4)

/**
 * generation.md §2.3. The document writes the control offset as `K_CTRL * rowH`; every row
 * edge has `dy === rowH` by construction (yOf is ROW0_Y + r*rowH and the depot row sits at
 * ROW0_Y + R*rowH), so the two agree everywhere they are both defined. `dy` is used because
 * the ENTRY edge is 160 LU rather than rowH, and `K_CTRL * rowH` there would put P1 BELOW
 * P3 — a non-monotonic parameterisation on the one edge whose arc length the entry-window
 * arithmetic of gameplay.md §4.8 depends on.
 */
function controlPoints(level, edge) {
  const a = level.nodes[edge.from];
  const b = level.nodes[edge.to];
  const dy = b.y - a.y;
  return [
    [a.x, a.y],
    [a.x, a.y + K_CTRL * dy],
    [b.x, b.y - K_CTRL * dy],
    [b.x, b.y],
  ];
}

function evalCubic(p, t) {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  let x = 0;
  let y = 0;
  for (let i = 0; i < 4; i += 1) {
    x += w[i] * p[i][0];
    y += w[i] * p[i][1];
  }
  return [x, y];
}

/** Per-edge arc-length table, built once per level (generation.md §3.4). */
export function buildCurves(level) {
  return level.edges.map((edge) => {
    const p = controlPoints(level, edge);
    const dist = [0];
    const pts = [evalCubic(p, 0)];
    for (let i = 1; i <= SAMPLES; i += 1) {
      const q = evalCubic(p, i / SAMPLES);
      dist.push(dist[i - 1] + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]));
      pts.push(q);
    }
    return { p, dist, pts, total: dist[SAMPLES], lengthLu: edge.lengthMlu / MLU };
  });
}

/**
 * Point at `lu` LU along the curve, measured from its start. The engine's edge length is the
 * rounded table literal and the sampled curve is a hair shorter, so the distance is scaled to
 * land `lengthLu` exactly on the end point.
 */
export function pointAtLu(curve, lu) {
  const want = lu * (curve.total / curve.lengthLu);
  let i = 1;
  while (i < SAMPLES && curve.dist[i] < want) i += 1;
  const lo = curve.dist[i - 1];
  const hi = curve.dist[i];
  const f = hi > lo ? (want - lo) / (hi - lo) : 0;
  const a = curve.pts[i - 1];
  const b = curve.pts[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, i];
}

/** Screen-space point (in LU) of a car, from its integer (edgeId, progress). */
export function carPoint(curves, car) {
  const q = pointAtLu(curves[car.edgeId], car.progress / MLU);
  return [q[0], q[1]];
}

/**
 * A car's pose: centre in LU plus the heading of the road under it, in radians, measured so
 * that 0 is "nose pointing down the screen" — which every edge is at both endpoints, because
 * the cubics leave and arrive vertically (generation.md §2.3). The sprite never spins.
 */
export function carPose(curves, car) {
  const curve = curves[car.edgeId];
  const lu = car.progress / MLU;
  const [x, y, i] = pointAtLu(curve, lu);
  const a = curve.pts[Math.max(0, i - 1)];
  const b = curve.pts[Math.min(SAMPLES, i)];
  const tx = b[0] - a[0];
  const ty = b[1] - a[1];
  const angle = tx === 0 && ty === 0 ? 0 : Math.atan2(ty, tx) - Math.PI / 2;
  return { x, y, angle };
}

/**
 * A polyline along the curve from `fromLu` to `toLu`, resampled at `stepLu`. Used for the
 * apron, the open-branch overdraw and the armed arc — all of which are sub-stretches of an
 * edge and all of which are stroked wide enough that a polyline and the cubic are the same
 * picture. Roads themselves are drawn as one `cubicTo` and are never resampled.
 */
export function subPathPoints(curve, fromLu, toLu, stepLu = 8) {
  const a = Math.max(0, Math.min(fromLu, toLu));
  const b = Math.min(curve.lengthLu, Math.max(fromLu, toLu));
  const n = Math.max(1, Math.ceil((b - a) / stepLu));
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const q = pointAtLu(curve, a + ((b - a) * i) / n);
    out.push([q[0], q[1]]);
  }
  return out;
}

/** Every edge whose far end is a depot — the terminal edges the apron is laid over. */
function terminalEdges(level) {
  return level.edges.filter((e) => level.nodes[e.to].kind === 'depot');
}

/**
 * ui.md §7.6. For each terminal edge: the opaque core (the last `mouthLu - MOUTH_FADE` LU)
 * and the fade stretch immediately above it. Built once per level; reads no simulation
 * state.
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
      // The mouth LINE — the last point at which a car on this edge was visible. AC-515
      // originates the shatter here rather than at the depot node.
      mouthPoint: pointAtLu(c, Math.max(0, L - mouthLu)).slice(0, 2),
      core: subPathPoints(c, Math.max(0, L - (mouthLu - MOUTH_FADE)), L),
      fade: subPathPoints(c, Math.max(0, L - mouthLu), Math.max(0, L - (mouthLu - MOUTH_FADE))),
    };
  });
}

/**
 * ui.md §7.3. For every junction: the centre, the blade's heading for each branch, and the
 * sub-paths the open-branch overdraw and the armed arc follow.
 *
 * THE BLADE'S HEADING IS THE CHORD TO THE BRANCH'S FAR NODE, not the tangent 40 LU along it.
 * Every edge leaves its node VERTICALLY (generation.md §2.3, and that is what makes roads
 * join without a kink), so 40 LU down both branches the road is still pointing straight down
 * and a tangent-derived blade is identical on both — it draws the same vertical bar whichever
 * way the switch is set. The first screenshot of this renderer showed exactly that, and
 * ui.md §7.3 is explicit that "the blade IS the state: where it points is where the next car
 * goes". The chord points at the column the branch actually reaches: straight down for a
 * straight branch, and clearly down-left or down-right for a diagonal.
 */
function buildJunctionGeometry(level, curves) {
  return level.junctions.map((nodeId, junctionId) => {
    const n = level.nodes[nodeId];
    const branches = n.out.map((edgeId) => {
      const c = curves[edgeId];
      const far = level.nodes[level.edges[edgeId].to];
      const openTo = Math.min(OPEN_BRANCH_LU, c.lengthLu);
      const fadeFrom = Math.max(0, openTo - OPEN_BRANCH_FADE);
      return {
        edgeId,
        angle: Math.atan2(far.y - n.y, far.x - n.x),
        // Two sub-paths, not one: the solid overdraw, then the stretch its alpha ramps to
        // zero across (OPEN_BRANCH_FADE). They abut at `fadeFrom` with both at full alpha,
        // and both are butt-capped, so the seam is invisible and nothing is drawn twice.
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
 * bar's bottom edge DEPOT_SILL_BOTTOM above the body's bottom edge. Built once per level with
 * the rest of the depot, so the renderer maps a list rather than doing arithmetic per frame.
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
 * level load (ui.md §7.6: "Nothing here is per-frame work and nothing here reads simulation
 * state").
 */
export function buildLevelGeometry(level) {
  const curves = buildCurves(level);
  return {
    level,
    curves,
    mouths: buildMouths(level, curves),
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
