// Offramp — the Skia play surface (ui.md §4.2 draw order, §7 component states).
//
// RENDERING IS REPLAY. This file reads simulation state and paints it. It owns no game
// logic: it never steps, never schedules, never writes to state and never decides anything
// the engine decides. Every animation phase comes from `currentTick - eventTick`
// (ui.md §9, AC-505), so a replay paints frame for frame what the live run painted.
//
// AC-517: a car is drawn complete on the first frame it exists — full body fill, full glyph,
// full stroke. There is no fade, ramp or scale-up on the car body anywhere on the entry
// edge. The onset is the transient; the entry flare (§7.5) is only what makes it findable
// peripherally, it carries no colour, and it is painted BENEATH the car layer.

import React, { useMemo } from 'react';
import {
  Canvas,
  Circle,
  ColorMatrix,
  DashPathEffect,
  Fill,
  Group,
  LinearGradient,
  Paint,
  Path,
  RoundedRect,
  Skia,
  vec,
} from '@shopify/react-native-skia';

import { MLU, TICK_HZ } from '../engine/index.js';
import { C, MS, OPACITY, CAR_COLOURS, lighten, withAlpha } from '../ui/theme.js';
import { glyphPath } from './glyphs.js';
import {
  ARMED_ARC_W,
  BLADE_LEN,
  CAR_L,
  CAR_RADIUS,
  CAR_SHADOW_DY,
  CAR_W,
  COMMIT_PREVIEW,
  DEPOT_FACE_BAND,
  DEPOT_HATCH_W,
  DEPOT_RADIUS,
  DEPOT_RECEIVING_SCALE,
  FLARE_R,
  FLARE_W,
  FLARE_SCALE_FROM,
  FLARE_SCALE_TO,
  GLASS_L,
  GLASS_OFFSET,
  GLASS_W,
  GLYPH_CAR,
  GLYPH_CAR_LARGE,
  GLYPH_DEPOT,
  GLYPH_DEPOT_LARGE,
  JUNCTION_MARK_R,
  JUNCTION_RING_W,
  LANE_DASH_OFF,
  LANE_DASH_ON,
  LANE_DASH_W,
  MOUTH_W,
  RIPPLE_R0,
  RIPPLE_R1,
  ROAD_EDGE_W,
  ROAD_W,
  armingDistanceLu,
  carPose,
} from './geometry.js';
import { easeOutCubic, easeOutQuad, jitter01, lerp, phase } from './motion.js';

// ui.md §7.3. The blade's length is specified (40 LU); its thickness is not, so it is stated
// here rather than buried in a draw call. Reported to the designer as an ui.md §7.3 gap.
const BLADE_W = 12;
// ui.md §8.4. The fragment size and scatter range are specified; the count is six.
const SHATTER_COUNT = 6;
const SHATTER_FRAG = 26;
const SHATTER_MIN = 60;
const SHATTER_MAX = 110;
// ui.md §8.4 — a 3 pt --alert screen-edge vignette flashing to 30 %.
const VIGNETTE_PT = 3;
const VIGNETTE_PEAK = 0.3;

function polyPath(points) {
  const p = Skia.Path.Make();
  if (!points.length) return p;
  p.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) p.lineTo(points[i][0], points[i][1]);
  return p;
}

/** One cubicTo per edge (generation.md §2.3): no polyline, no sampling in the draw call. */
function roadPath(geom) {
  const p = Skia.Path.Make();
  for (const c of geom.curves) {
    p.moveTo(c.p[0][0], c.p[0][1]);
    p.cubicTo(c.p[1][0], c.p[1][1], c.p[2][0], c.p[2][1], c.p[3][0], c.p[3][1]);
  }
  return p;
}

// --- 2, 3, 4 · road ----------------------------------------------------------------------

function Roads({ road }) {
  return (
    <Group>
      <Path path={road} style="stroke" strokeWidth={ROAD_W + 2 * ROAD_EDGE_W} strokeCap="round" strokeJoin="round" color={C.roadEdge} />
      <Path path={road} style="stroke" strokeWidth={ROAD_W} strokeCap="round" strokeJoin="round" color={C.road} />
      <Path
        path={road}
        style="stroke"
        strokeWidth={LANE_DASH_W}
        color={withAlpha(C.roadDash, OPACITY.roadDash)}
      >
        <DashPathEffect intervals={[LANE_DASH_ON, LANE_DASH_OFF]} />
      </Path>
    </Group>
  );
}

// --- 5 · junction markers, open branch and the armed arc ---------------------------------

function Junction({ j, open, armOpacity, flipTick, tick, paths }) {
  const openAngle = j.branches[open].angle;
  const shutAngle = j.branches[1 - open].angle;
  // ui.md §8.2 — the blade rotates to the new branch over 120 ms, ease-out-cubic.
  const rot = phase(tick, flipTick, MS.bladeRotate);
  const angle = rot === null ? openAngle : lerp(shutAngle, openAngle, easeOutCubic(rot));
  // ui.md §7.3 — the ripple ring, 46 -> 84 LU, --text 50 % -> 0 %, 160 ms.
  const rip = phase(tick, flipTick, MS.ripple);
  return (
    <Group>
      {/* Butt caps, not round: a round cap on a 104 LU stroke puts a 52 LU lobe ABOVE the
          junction node, so the "open" brightening spilled backwards up the incoming road. */}
      <Path path={paths.open[open]} style="stroke" strokeWidth={ROAD_W} strokeCap="butt" color={lighten(C.road, 0.16)} />
      {armOpacity > 0 ? (
        <Path
          path={paths.armed[open]}
          style="stroke"
          strokeWidth={ARMED_ARC_W}
          strokeCap="round"
          color={withAlpha(C.text, OPACITY.armedArc * armOpacity)}
        />
      ) : null}
      <Circle cx={j.x} cy={j.y} r={JUNCTION_MARK_R} color={C.surfaceRaised} />
      <Circle
        cx={j.x}
        cy={j.y}
        r={JUNCTION_MARK_R - JUNCTION_RING_W / 2}
        style="stroke"
        strokeWidth={JUNCTION_RING_W}
        color={C.roadEdge}
      />
      <Group transform={[{ translateX: j.x }, { translateY: j.y }, { rotate: angle }]}>
        <RoundedRect x={0} y={-BLADE_W / 2} width={BLADE_LEN} height={BLADE_W} r={BLADE_W / 2} color={withAlpha(C.text, OPACITY.blade)} />
      </Group>
      {rip !== null ? (
        <Circle
          cx={j.x}
          cy={j.y}
          r={lerp(RIPPLE_R0, RIPPLE_R1, easeOutQuad(rip))}
          style="stroke"
          strokeWidth={3}
          color={withAlpha(C.text, 0.5 * (1 - rip))}
        />
      ) : null}
    </Group>
  );
}

// --- 6 · entry flares --------------------------------------------------------------------

function Flares({ entry, spawns, tick }) {
  return (
    <Group>
      {spawns.map((e) => {
        const t = phase(tick, e.tick, MS.flare);
        if (t === null) return null;
        const k = easeOutQuad(t);
        const r = FLARE_R * lerp(FLARE_SCALE_FROM, FLARE_SCALE_TO, k);
        return (
          <Circle
            key={'flare' + e.carId}
            cx={entry.x}
            cy={entry.y}
            r={r}
            style="stroke"
            strokeWidth={FLARE_W}
            color={withAlpha(C.textMute, OPACITY.flare * (1 - k))}
          />
        );
      })}
    </Group>
  );
}

// --- 7 · cars ----------------------------------------------------------------------------

function CarBody({ pose, colour, glyphSize, glyphOpacity }) {
  return (
    <Group transform={[{ translateX: pose.x }, { translateY: pose.y }, { rotate: pose.angle }]}>
      <RoundedRect
        x={-CAR_W / 2}
        y={-CAR_L / 2}
        width={CAR_W}
        height={CAR_L}
        r={CAR_RADIUS}
        color={CAR_COLOURS[colour]}
      />
      <RoundedRect
        x={-GLASS_W / 2}
        y={GLASS_OFFSET - GLASS_L / 2}
        width={GLASS_W}
        height={GLASS_L}
        r={8}
        color={withAlpha(C.carGlass, OPACITY.glass)}
      />
      {/* ui.md §6.2 — counter-rotated so the glyph is always upright relative to the screen. */}
      <Group transform={[{ rotate: -pose.angle }]}>
        <Path path={glyphPath(colour, glyphSize)} color={withAlpha(C.ink, glyphOpacity)} />
      </Group>
    </Group>
  );
}

function Cars({ curves, cars, glyphSize, glyphOpacity, frozen }) {
  const poses = cars.map((car) => ({ car, pose: carPose(curves, car) }));
  return (
    <Group opacity={frozen ? OPACITY.frozenCar : 1}>
      {/* Shadows first, then bodies: AC-501 forbids a car being occluded by another car's
          shadow, which per-car ordering inside the layer would produce. */}
      {poses.map(({ car, pose }) => (
        <Group
          key={'sh' + car.id}
          transform={[{ translateX: pose.x }, { translateY: pose.y + CAR_SHADOW_DY }, { rotate: pose.angle }]}
        >
          <RoundedRect
            x={-CAR_W / 2}
            y={-CAR_L / 2}
            width={CAR_W}
            height={CAR_L}
            r={CAR_RADIUS}
            color={withAlpha('#000000', OPACITY.carShadow)}
          />
        </Group>
      ))}
      {poses.map(({ car, pose }) => (
        <CarBody key={car.id} pose={pose} colour={car.colour} glyphSize={glyphSize} glyphOpacity={glyphOpacity} />
      ))}
    </Group>
  );
}

// --- 8 · depot-mouth aprons --------------------------------------------------------------

function Mouths({ geom, corePath, glows, tick }) {
  return (
    <Group>
      {/* Cores: ALL of a level's cores in ONE path, filled once, so overlapping lobes cannot
          stack (ui.md §7.6). */}
      <Path path={corePath} style="stroke" strokeWidth={MOUTH_W} strokeCap="round" strokeJoin="round" color={C.depot} />
      {/* Fades: one saveLayer, `lighten` inside it, so where two fade segments overlap the
          alpha takes the larger rather than accumulating into a visible lens. */}
      <Group layer>
        {geom.mouths.map((m) => {
          const a = m.fade[0];
          const b = m.fade[m.fade.length - 1];
          return (
            <Path
              key={'fade' + m.edgeId}
              path={polyPath(m.fade)}
              style="stroke"
              strokeWidth={MOUTH_W}
              strokeCap="butt"
              blendMode="lighten"
            >
              <LinearGradient
                start={vec(a[0], a[1])}
                end={vec(b[0], b[1])}
                colors={[withAlpha(C.depot, 0), C.depot]}
              />
            </Path>
          );
        })}
      </Group>
      {/* ui.md §8.3 — the mouth glow: the apron core redrawn in the car's colour at 55 %,
          90 ms in, 130 ms out. The car is already beneath the apron, so this is what says
          "banked, and in which colour". */}
      {glows.map((g) => (
        <Path
          key={'glow' + g.key}
          path={g.path}
          style="stroke"
          strokeWidth={MOUTH_W}
          strokeCap="round"
          strokeJoin="round"
          color={withAlpha(CAR_COLOURS[g.colour], OPACITY.mouthGlow * g.alpha)}
        />
      ))}
    </Group>
  );
}

// --- 9 · depot bodies --------------------------------------------------------------------

function Depot({ d, glyphSize, receiving, rejecting }) {
  // ui.md §7.4 — receiving: face band +18 % brightness, body 1.00 -> 1.04 -> 1.00 over 220 ms.
  const s = receiving === null ? 1 : lerp(1, DEPOT_RECEIVING_SCALE, Math.sin(Math.PI * receiving));
  const faceLift = receiving === null ? 0 : 0.18 * Math.sin(Math.PI * receiving);
  // ui.md §7.4 — rejecting: face band flashes --alert for 90 ms, then the whole depot
  // desaturates to --text-mute and returns over 260 ms.
  const flashFrac = MS.depotRejectFlash / (MS.depotRejectFlash + MS.depotRejectReturn);
  const flashing = rejecting !== null && rejecting < flashFrac;
  const desat =
    rejecting === null ? 0 : flashing ? 1 : 1 - easeOutCubic((rejecting - flashFrac) / (1 - flashFrac));
  const colour = CAR_COLOURS[d.colour];
  // "the whole depot desaturates to --text-mute and returns over 260 ms" (ui.md §7.4) — the
  // face band is part of the whole depot, so it desaturates with the glyph disc and the hatch.
  const accent = desat > 0 ? C.textMute : colour;
  const face = flashing ? C.alert : desat > 0 ? C.textMute : lighten(colour, faceLift);
  const body = desat > 0 ? lighten(C.depot, 0.1 * desat) : C.depot;
  return (
    <Group transform={[{ translateX: d.cx }, { translateY: d.cy }, { scale: s }, { translateX: -d.cx }, { translateY: -d.cy }]}>
      <RoundedRect x={d.x} y={d.y} width={d.w} height={d.h} r={DEPOT_RADIUS} color={body} />
      <RoundedRect x={d.x} y={d.y} width={d.w} height={DEPOT_FACE_BAND} r={DEPOT_RADIUS / 3} color={face} />
      <Circle cx={d.cx} cy={d.cy} r={glyphSize * 0.75} color={accent} />
      <Group transform={[{ translateX: d.cx }, { translateY: d.cy }]}>
        <Path path={glyphPath(d.colour, glyphSize)} color={C.ink} />
      </Group>
      {[0, 1, 2].map((i) => (
        <RoundedRect
          key={i}
          x={d.x + 16}
          y={d.y + d.h - 34 + i * 10}
          width={d.w - 32}
          height={DEPOT_HATCH_W}
          r={DEPOT_HATCH_W / 2}
          color={withAlpha(accent, OPACITY.depotHatch)}
        />
      ))}
    </Group>
  );
}

// --- 10 · transient effects --------------------------------------------------------------

function Shatter({ frags }) {
  return (
    <Group>
      {frags.map((f) => (
        <RoundedRect
          key={f.key}
          x={f.x - SHATTER_FRAG / 2}
          y={f.y - SHATTER_FRAG / 2}
          width={SHATTER_FRAG}
          height={SHATTER_FRAG}
          r={4}
          color={withAlpha(CAR_COLOURS[f.colour], f.alpha)}
        />
      ))}
    </Group>
  );
}

// --- the surface -------------------------------------------------------------------------

/**
 * @param geom      buildLevelGeometry(level) — built once per level, never per frame
 * @param state     the engine state for the tick being painted
 * @param events    the React layer's rolling window of recent engine events (src/ui/loop.js)
 * @param layout    computeLayout(...) — the single pt/LU boundary
 * @param symbolLarge  ui.md §11.2 Symbol size
 * @param dim       0..1. At 1 the play surface reads at 40 % (ui.md §8.6, §8.8 — the pause
 *                  overlay and the level-complete panel both dim it).
 * @param desaturate 0..1. At 1 the play surface is greyscale (ui.md §8.7 — on a loss the
 *                  colours going out IS the message, so it desaturates rather than dims).
 *
 * Both are wall-clock ramps, and that is correct here and only here: the simulation is
 * stopped or paused for all three states, so a tick-derived phase would be frozen at zero.
 */
export default function PlaySurface({ geom, state, events, layout, symbolLarge, dim, desaturate }) {
  const road = useMemo(() => roadPath(geom), [geom]);
  const corePath = useMemo(() => {
    const p = Skia.Path.Make();
    for (const m of geom.mouths) p.addPath(polyPath(m.core));
    return p;
  }, [geom]);
  const junctionPaths = useMemo(
    () =>
      geom.junctions.map((j) => ({
        open: j.branches.map((b) => polyPath(b.open)),
        armed: j.branches.map((b) => polyPath(b.armed)),
      })),
    [geom],
  );
  const mouthByDepot = useMemo(() => {
    const m = new Map();
    for (const mo of geom.mouths) {
      if (!m.has(mo.depotNodeId)) m.set(mo.depotNodeId, []);
      m.get(mo.depotNodeId).push(mo);
    }
    return m;
  }, [geom]);
  const corePathByDepot = useMemo(() => {
    const m = new Map();
    for (const [depotNodeId, list] of mouthByDepot) {
      const p = Skia.Path.Make();
      for (const mo of list) p.addPath(polyPath(mo.core));
      m.set(depotNodeId, p);
    }
    return m;
  }, [mouthByDepot]);

  const { level, curves } = geom;
  const tick = state.tick;
  const glyphCar = symbolLarge ? GLYPH_CAR_LARGE : GLYPH_CAR;
  const glyphDepot = symbolLarge ? GLYPH_DEPOT_LARGE : GLYPH_DEPOT;
  const glyphOpacity = symbolLarge ? OPACITY.carGlyphLarge : OPACITY.carGlyph;
  const frozen = state.phase !== 'running';

  const spawns = events.filter((e) => e.type === 'spawn');
  const flips = new Map();
  for (const e of events) if (e.type === 'flip') flips.set(e.junctionId, e.tick);

  // ui.md §7.3 — armed when the nearest approaching car is within COMMIT_PREVIEW. The fade-in
  // is expressed as distance travelled rather than as an event, because arming is a
  // continuous property of the state and a distance is replay-identical by construction.
  const armFadeLu = (level.speedMluPerTick / MLU) * (MS.armFade / 1000) * TICK_HZ;
  const arm = geom.junctions.map((j) => {
    const d = armingDistanceLu(level, curves, state.cars, j.nodeId);
    if (!(d <= COMMIT_PREVIEW)) return 0;
    return Math.max(0, Math.min(1, (COMMIT_PREVIEW - d) / armFadeLu));
  });

  const glows = [];
  for (const e of events) {
    if (e.type !== 'delivered') continue;
    const inMs = MS.mouthGlowIn;
    const total = MS.mouthGlowIn + MS.mouthGlowOut;
    const t = phase(tick, e.tick, total);
    if (t === null) continue;
    const ms = t * total;
    const alpha = ms < inMs ? easeOutCubic(ms / inMs) : 1 - easeOutCubic((ms - inMs) / MS.mouthGlowOut);
    const p = corePathByDepot.get(e.depotId);
    if (p) glows.push({ key: e.carId, path: p, colour: e.colour, alpha });
  }

  const frags = [];
  let vignette = 0;
  for (const e of events) {
    if (e.type !== 'misrouted') continue;
    const v = phase(tick, e.tick, MS.vignette);
    if (v !== null) vignette = Math.max(vignette, VIGNETTE_PEAK * Math.sin(Math.PI * v));
    const t = phase(tick, e.tick, MS.shatter);
    if (t === null) continue;
    // AC-515: the fragments come from the MOUTH LINE of the terminal edge the car came down
    // — the last point at which the car was visible — not from the depot node.
    const list = mouthByDepot.get(e.depotId) || [];
    const m = list.find((x) => x.edgeId === e.edgeId) || list[0];
    if (!m) continue;
    const k = easeOutQuad(t);
    for (let i = 0; i < SHATTER_COUNT; i += 1) {
      const r = lerp(SHATTER_MIN, SHATTER_MAX, jitter01(e.carId, i));
      // Biased upward and outward along the edge tangent: the spread straddles straight up.
      const a = -Math.PI / 2 + (jitter01(e.carId, i + 32) - 0.5) * Math.PI;
      frags.push({
        key: e.carId + ':' + i,
        colour: e.carColour,
        x: m.mouthPoint[0] + Math.cos(a) * r * k,
        y: m.mouthPoint[1] + Math.sin(a) * r * k,
        alpha: 1 - k,
      });
    }
  }

  const receiving = new Map();
  const rejecting = new Map();
  for (const e of events) {
    if (e.type === 'delivered') {
      const t = phase(tick, e.tick, MS.depotReceiving);
      if (t !== null) receiving.set(e.depotId, t);
    } else if (e.type === 'misrouted') {
      const t = phase(tick, e.tick, MS.depotRejectFlash + MS.depotRejectReturn);
      if (t !== null) rejecting.set(e.depotId, t);
    }
  }

  // ui.md §8.6 / §8.7 / §8.8 — dim to 40 % on a pause or a clear, desaturate on a loss.
  const dimAlpha = (1 - OPACITY.dim) * dim;
  const sat = 1 - desaturate;
  const satMatrix = [
    0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat, 0, 0,
    0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat, 0, 0,
    0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat, 0, 0,
    0, 0, 0, 1, 0,
  ];

  return (
    <Canvas style={{ position: 'absolute', left: 0, top: 0, width: layout.screenW, height: layout.screenH }}>
      <Fill color={C.bg} />
      <Group
        layer={
          sat < 1 ? (
            <Paint>
              <ColorMatrix matrix={satMatrix} />
            </Paint>
          ) : undefined
        }
      >
        <Group
          transform={[{ translateX: layout.originX }, { translateY: layout.originY }, { scale: layout.scale }]}
        >
          <Roads road={road} />
          {geom.junctions.map((j, i) => (
            <Junction
              key={j.junctionId}
              j={j}
              open={state.open[j.junctionId]}
              armOpacity={arm[i]}
              flipTick={flips.has(j.junctionId) ? flips.get(j.junctionId) : -1e9}
              tick={tick}
              paths={junctionPaths[i]}
            />
          ))}
          <Flares entry={geom.entry} spawns={spawns} tick={tick} />
          <Cars
            curves={curves}
            cars={state.cars}
            glyphSize={glyphCar}
            glyphOpacity={glyphOpacity}
            frozen={frozen}
          />
          <Mouths geom={geom} corePath={corePath} glows={glows} tick={tick} />
          {geom.depots.map((d) => (
            <Depot
              key={d.nodeId}
              d={d}
              glyphSize={glyphDepot}
              receiving={receiving.has(d.nodeId) ? receiving.get(d.nodeId) : null}
              rejecting={rejecting.has(d.nodeId) ? rejecting.get(d.nodeId) : null}
            />
          ))}
          <Shatter frags={frags} />
        </Group>
      </Group>
      {dimAlpha > 0 ? <Fill color={withAlpha(C.bg, dimAlpha)} /> : null}
      {vignette > 0 ? (
        <RoundedRect
          x={VIGNETTE_PT / 2}
          y={VIGNETTE_PT / 2}
          width={layout.screenW - VIGNETTE_PT}
          height={layout.screenH - VIGNETTE_PT}
          r={0}
          style="stroke"
          strokeWidth={VIGNETTE_PT}
          color={withAlpha(C.alert, vignette)}
        />
      ) : null}
    </Canvas>
  );
}
