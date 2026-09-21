// Offramp — play-area layout arithmetic (ui.md §3.1, §3.2, §4.4).
//
// Pure. No React, no react-native, no Skia: tools/layout-sweep.mjs imports this module in
// bare Node and sweeps millions of viewports through it, and test/layout.test.js checks it
// against numbers transcribed from ui.md rather than read back out of here
// (docs/development-process.md §6.8).
//
// Two units, never interchangeable: pt (React Native logical points) for chrome, LU (the
// engine's design space) for everything inside the canvas. `scale` is the single boundary
// between them and is applied once.

import { DESIGN_H, DESIGN_W, ROUTE_H, bandParams, colWFor } from '../engine/index.js';

// ui.md §3.1
export const HUD_H = 56;
const GUTTER_BOT = 8;

// ui.md §3.2 — the vertical slack is split 55 % above / 45 % below.
const SLACK_TOP_FRACTION = 0.55;

// ui.md §4.4 — the declared support floor. The height floor moved 400 -> 460 in round 8: the
// design rectangle is shorter (1500 rather than 1600 LU), so it reaches its height bound at a
// LARGER playH, and at playH = 460 the scale is 0.30667. AC-402's 20 pt car body clears there
// by 0.24 pt; AC-401's 44 pt tap target clears by 2.61 pt in round 9, where it cleared by
// 0.16 pt in round 8 — `colW` became derived and band 5's grid went 150 -> 158 LU.
// Below the floor, band 5's 44 pt target cannot be met (AC-409).
const MIN_PLAY_W = 320;
const MIN_PLAY_H = 460;

// ui.md §4.4 — `ceil(22 / scale)` is the radius in LU that yields exactly a 44 pt diameter.
const TAP_TARGET_PT = 44;
const HIT_R_LU_MIN = 76;
const HIT_CIRCLE_CLEARANCE_LU = 6;

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * ui.md §3.1 + §3.2. `insets` are the react-native-safe-area-context insets in pt.
 * Returns everything the canvas, the hit test and the sweep need, and nothing else.
 */
export function computeLayout({ screenW, screenH, insetTop, insetBottom }) {
  const playTop = insetTop + HUD_H;
  const playBottom = screenH - insetBottom - GUTTER_BOT;
  const playH = playBottom - playTop;
  const playW = screenW; // full bleed, no side gutter
  const scale = Math.min(playW / DESIGN_W, playH / DESIGN_H);
  const slackX = playW - DESIGN_W * scale;
  const slackY = playH - DESIGN_H * scale;
  return {
    screenW,
    screenH,
    insetTop,
    insetBottom,
    playTop,
    playBottom,
    playW,
    playH,
    scale,
    slackX,
    slackY,
    originX: slackX / 2,
    originY: playTop + slackY * SLACK_TOP_FRACTION,
    supported: playW >= MIN_PLAY_W && playH >= MIN_PLAY_H,
  };
}

/** ui.md §4.4. `minSep` is `min(colW, rowH)` for the band in play. */
export function hitRadiusLu(scale, minSepLu) {
  return clamp(
    Math.ceil(TAP_TARGET_PT / 2 / scale),
    HIT_R_LU_MIN,
    Math.floor((minSepLu - HIT_CIRCLE_CLEARANCE_LU) / 2),
  );
}

/**
 * `min(colW, rowH)` for a band — the minimum distance between two lattice sites, which is the
 * number the whole 44 pt tap-target arithmetic is built on (generation.md §3.2). `colW` is
 * DERIVED from `C` in round 9 (generation.md §3.2.1); `rowH` is `ROUTE_H / R`.
 * **216 / 216 / 180 / 180 / 158 LU by band.** Band 5 is still the binding case for the whole
 * design, but round 9 moves it 150 -> 158, which takes the junction target at the support
 * floor from 44.16 pt to 46.61 pt (AC-401).
 */
export function minSepLuForBand(band) {
  const p = bandParams(band);
  return Math.min(colWFor(p.C), ROUTE_H / p.R);
}

/** LU point -> screen pt. `screen = origin + design * scale` (ui.md §3.2). */
export function luToScreen(layout, x, y) {
  return { x: layout.originX + x * layout.scale, y: layout.originY + y * layout.scale };
}

/** The inverse, used for hit testing. AC-301: round, not floor or truncate. */
export function screenToLu(layout, sx, sy) {
  return {
    x: Math.round((sx - layout.originX) / layout.scale),
    y: Math.round((sy - layout.originY) / layout.scale),
  };
}
