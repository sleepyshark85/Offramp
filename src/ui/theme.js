// Offramp — colour tokens and type scale (ui.md §5.3, §12).
//
// Transcribed from ui.md. No colour is computed, blended or "close enough": the contrast
// ratios in §5.2 are measured against these exact values.

// ui.md §5.1 — the five car colours. They are the match key and are used for nothing else.
// The engine carries the same list in PALETTE (constants.js) because V10 validates against
// it; this re-export keeps one source rather than a second copy that has to be kept in sync.
export { PALETTE as CAR_COLOURS } from '../engine/index.js';

// ui.md §5.3 — surface and chrome.
export const C = {
  bg: '#0B0E13',
  surface: '#151A22',
  surfaceRaised: '#1F2630',
  road: '#2B323C',
  roadEdge: '#434C59',
  roadDash: '#5A6472',
  depot: '#1B222C',
  ink: '#0B0E13',
  text: '#E8ECF2',
  textDim: '#96A0B0',
  textMute: '#6B7688',
  alert: '#FF2D55',
  ok: '#E8ECF2',
  // DEVIATION, reported rather than resolved silently: ui.md §4.3 draws the windscreen in
  // `--car-glass` at 22 % opacity, but §5.3's token table does not define `--car-glass`.
  // `--ink` is used here — a dark panel on a bright body reads as glass seen from above at
  // night, where a light one would read as a highlight — and the gap is in the slice-2
  // report for the designer to close.
  carGlass: '#0B0E13',
};

export const OPACITY = {
  roadDash: 0.4, // ui.md §4.2 step 4
  carGlyph: 0.78, // ui.md §6.2, Standard symbol size
  carGlyphLarge: 1.0, // ui.md §6.2, Large
  carShadow: 0.32, // ui.md §4.3
  blade: 0.92, // ui.md §7.3
  armedArc: 0.6, // ui.md §7.3
  flare: 0.6, // ui.md §7.5
  depotHatch: 0.18, // ui.md §7.4
  glass: 0.22, // ui.md §4.3
  mouthGlow: 0.55, // ui.md §8.3
  frozenCar: 0.45, // ui.md §7.5
  dim: 0.4, // ui.md §8.6 — play surface dims to 40 %
  lastLifeBorder: 0.24, // ui.md §8.5
};

// ui.md §12 — type scale. size / line, weight, tracking.
export const TYPE = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.4 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.2 },
  hudNumeric: { fontSize: 20, lineHeight: 24, fontWeight: '600', letterSpacing: 0 },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400', letterSpacing: 0 },
  button: { fontSize: 16, lineHeight: 20, fontWeight: '600', letterSpacing: 0.4 },
  label: { fontSize: 13, lineHeight: 16, fontWeight: '600', letterSpacing: 0.6 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0.2 },
};

// ui.md §12 — spacing scale and radii. Nothing uses a value off these.
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const RADIUS = { bar: 4, pill: 8, depot: 12, button: 16, panel: 20 };

// ui.md §9 — durations in ms. In-canvas motion converts these to ticks and derives its phase
// from (currentTick - eventTick); chrome outside the canvas may use wall time.
export const MS = {
  flare: 180,
  bladeRotate: 120,
  ripple: 160,
  armFade: 180,
  mouthGlowIn: 90,
  mouthGlowOut: 130,
  depotReceiving: 220,
  shatter: 320,
  depotRejectFlash: 90,
  depotRejectReturn: 260,
  lifeDrain: 240,
  vignette: 180,
  lastLifePulse: 1600,
  quotaFill: 180,
  scoreCount: 300,
  dim: 240,
  desaturate: 320,
  panelRise: 280,
  countdownBeat: 600,
};

// --- colour helpers ----------------------------------------------------------------------
// The only two operations ui.md asks for on a token: an alpha, and "lightened 16 %" for the
// open branch (§7.3). Nothing else composes a colour at runtime.

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hex2(v) {
  return clamp255(v).toString(16).padStart(2, '0');
}

function rgbOf(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** `#RRGGBBAA`. Skia parses eight-digit hex directly. */
export function withAlpha(hex, a) {
  return hex.slice(0, 7) + hex2(Math.max(0, Math.min(1, a)) * 255);
}

/** Mix toward white by `f`. ui.md §7.3's "`--road` lightened 16 %" is `lighten(C.road, 0.16)`. */
export function lighten(hex, f) {
  const [r, g, b] = rgbOf(hex);
  return '#' + hex2(r + (255 - r) * f) + hex2(g + (255 - g) * f) + hex2(b + (255 - b) * f);
}
