// Offramp — animation phase and easing for the play surface (ui.md §9).
//
// THE DETERMINISM RULE FOR MOTION. Anything drawn inside the Skia play surface derives its
// phase from `(currentTick - eventTick) / TICK_HZ`, taking `eventTick` from `state.events`.
// No `Date.now()`, no frame counter, no wall clock. A replay therefore paints identically,
// frame for frame, to the live run (AC-505).
//
// Pure. Imported by the renderer and by test/motion.test.js.

import { TICK_HZ, mix32 } from '../engine/index.js';

/** Elapsed milliseconds since `eventTick`, in whole-tick quanta. */
export function elapsedMs(currentTick, eventTick) {
  return ((currentTick - eventTick) * 1000) / TICK_HZ;
}

/**
 * Normalised progress through an animation of `durationMs`, clamped to [0, 1]. Returns null
 * when the animation has not started or has finished, so a caller can skip the draw entirely
 * rather than paint a zero-opacity shape every frame.
 */
export function phase(currentTick, eventTick, durationMs) {
  const t = elapsedMs(currentTick, eventTick) / durationMs;
  if (t < 0 || t >= 1) return null;
  return t;
}

// ui.md §9 easings.
export function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

export function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

export function easeInOutSine(t) {
  return 0.5 - Math.cos(Math.PI * t) / 2;
}

/** `ease-out-back(1.08)` — the overshoot used by the overlay panel rise (ui.md §8.6). */
export function easeOutBack(t, s = 1.08) {
  const c3 = s + 1;
  return 1 + c3 * (t - 1) ** 3 + s * (t - 1) ** 2;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * A deterministic pseudo-random unit value for effect `i` of event `key`. The misroute
 * shatter scatters six fragments (ui.md §8.4) and a replay has to scatter them the same way,
 * so the draw draws from the engine's own integer mixer rather than from Math.random —
 * which is banned in the engine and is no more acceptable in a render path that AC-505
 * requires to be reproducible.
 */
export function jitter01(key, i) {
  return mix32(key, 0x9e3779b1 ^ (i * 0x85ebca6b)) / 4294967296;
}
