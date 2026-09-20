// Offramp — the serialized frame snapshot tier-3 verification asserts against.
//
// WHY THIS EXISTS, stated plainly because it is easy to mistake for debug scaffolding.
// The play surface is a single Skia canvas. Playwright cannot query it the way it could
// query views — there are no elements inside a canvas (docs/development-process.md §4). So
// the state layer publishes what it handed the renderer, and the E2E suite asserts against
// that plus screenshots.
//
// WHAT IT PROVES AND WHAT IT DOES NOT. A passing assertion against `window.__offramp`
// proves the simulation reached the renderer's own geometry. It does NOT prove a pixel was
// drawn. Only the screenshots and tier 5 speak to the paint. Every E2E test that asserts on
// this object is paired with a screenshot for that reason.
//
// The car positions here are produced by `src/render/geometry.js` — the same module that
// places the car on the canvas — rather than recomputed. Two implementations that have to
// agree is the bug shape (docs/development-process.md §6.3).

import { serialiseState } from '../engine/index.js';
import { carPose } from '../render/geometry.js';
import { luToScreen } from './layout.js';

const SNAPSHOT_KEY = '__offramp';

/**
 * True on web (where tier 3 runs) and false on a device, where nothing reads it. React
 * Native defines `global.window`, so `window` alone is not the test — `document` is. Without
 * this the snapshot would be built and serialised sixty times a second on a phone for a
 * consumer that does not exist.
 */
export function snapshotAvailable() {
  return typeof document !== 'undefined' && typeof globalThis.window !== 'undefined';
}

/** The parts of a level that never change during play. Serialised once per level. */
export function levelSnapshot(geom, levelNumber) {
  const { level } = geom;
  return {
    number: levelNumber,
    seed: level.seed,
    band: level.band,
    quota: level.quota,
    C: level.C,
    K: level.K,
    R: level.R,
    colW: level.colW,
    rowH: level.rowH,
    junctions: geom.junctions.map((j) => ({ junctionId: j.junctionId, nodeId: j.nodeId, x: j.x, y: j.y })),
    depots: geom.depots.map((d) => ({ nodeId: d.nodeId, colour: d.colour, x: d.cx, y: d.y })),
    entry: { x: geom.entry.x, y: geom.entry.y },
    mouths: geom.mouths.map((m) => ({ edgeId: m.edgeId, depotNodeId: m.depotNodeId, mouthLu: m.mouthLu })),
  };
}

/**
 * One frame's snapshot. `frames` counts painted frames so a test can tell a stopped loop
 * from a stalled one: a paused game still renders, so `frames` rises while `state.tick`
 * does not — which is exactly the distinction AC-128 and AC-803 turn on.
 */
export function buildSnapshot({ screen, mode, countdown, layout, level, geom, state, events, frames, loops, settings }) {
  return {
    v: 1,
    screen,
    mode,
    countdown,
    frames,
    loops,
    settings,
    layout: {
      screenW: layout.screenW,
      screenH: layout.screenH,
      insetTop: layout.insetTop,
      insetBottom: layout.insetBottom,
      playTop: layout.playTop,
      playBottom: layout.playBottom,
      playW: layout.playW,
      playH: layout.playH,
      scale: layout.scale,
      originX: layout.originX,
      originY: layout.originY,
      supported: layout.supported,
    },
    level,
    state: state ? serialiseState(state, { level: false }) : null,
    cars: state
      ? state.cars.map((car) => {
          const pose = carPose(geom.curves, car);
          const s = luToScreen(layout, pose.x, pose.y);
          return {
            id: car.id,
            colour: car.colour,
            edgeId: car.edgeId,
            progress: car.progress,
            lu: { x: pose.x, y: pose.y },
            screen: { x: s.x, y: s.y },
            angle: pose.angle,
          };
        })
      : [],
    events,
  };
}

export function publishSnapshot(snapshot) {
  if (!snapshotAvailable()) return;
  globalThis.window[SNAPSHOT_KEY] = snapshot;
}
