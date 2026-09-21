// Offramp — colour separation and contrast maths (ui.md §5.1, §5.2; AC-606, AC-611).
//
// Harness code. It exists because round 9 adds a SIXTH car colour and brightens `--road`, and
// a sixth colour is exactly the kind of change that quietly erodes an optimisation nobody
// re-runs (AC-611). The palette is a constrained optimisation, so the constraints have to be
// executable.
//
// Everything here is standard published maths — sRGB luminance (WCAG 2.x), CIELAB/CIELCh,
// CIEDE2000 (Sharma, Wu & Dalal 2005), and the Machado, Oliveira & Fernandes (2009)
// severity-1.0 dichromacy matrices. ui.md §5.2 records that this round's implementation reads
// the K = 4 and K = 5 CVD figures 0.3–0.5 ΔE below slice 0's, from a different variant of the
// Machado matrices, and that the shipped numbers are now this round's.

// --- sRGB, luminance, contrast ------------------------------------------------------------

export function rgbOf(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

export function hexOf([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** sRGB 0–255 -> linear 0–1. */
const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
/** linear 0–1 -> sRGB 0–255. */
const gam = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

export function luminance(hex) {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, always >= 1. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `tint` composited over `base` at `alpha`, in sRGB space — which is what Skia draws. */
export function composite(base, tint, alpha) {
  const A = rgbOf(base);
  const B = rgbOf(tint);
  return hexOf(A.map((v, i) => v * (1 - alpha) + B[i] * alpha));
}

// --- CIELAB / CIELCh ------------------------------------------------------------------------

const D65 = [95.047, 100.0, 108.883];

export function lab(hex) {
  const [r, g, b] = rgbOf(hex).map(lin);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) * 100;
  const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) * 100;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) * 100;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x / D65[0]);
  const fy = f(y / D65[1]);
  const fz = f(z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** C* — chroma. ui.md §5.1's search kept only candidates with `C* >= 45`. */
export function chroma(hex) {
  const [, a, b] = lab(hex);
  return Math.sqrt(a * a + b * b);
}

export function lightness(hex) {
  return lab(hex)[0];
}

// --- CIEDE2000 (Sharma, Wu & Dalal 2005) ---------------------------------------------------

export function deltaE2000(hexA, hexB) {
  const [L1, a1, b1] = lab(hexA);
  const [L2, a2, b2] = lab(hexB);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hp = (b, ap) => {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) / rad;
    return h >= 0 ? h : h + 360;
  };
  const hp1 = hp(b1, ap1);
  const hp2 = hp(b2, ap2);
  const dLp = L2 - L1;
  const dCp = Cp2 - Cp1;
  let dhp;
  if (Cp1 * Cp2 === 0) dhp = 0;
  else if (Math.abs(hp2 - hp1) <= 180) dhp = hp2 - hp1;
  else if (hp2 - hp1 > 180) dhp = hp2 - hp1 - 360;
  else dhp = hp2 - hp1 + 360;
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * rad);
  const Lbar = (L1 + L2) / 2;
  const Cbarp = (Cp1 + Cp2) / 2;
  let hbarp;
  if (Cp1 * Cp2 === 0) hbarp = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hbarp = (hp1 + hp2) / 2;
  else if (hp1 + hp2 < 360) hbarp = (hp1 + hp2 + 360) / 2;
  else hbarp = (hp1 + hp2 - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

// --- Machado, Oliveira & Fernandes (2009), severity 1.0 ------------------------------------

const MACHADO = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

export const VISION_TYPES = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];

/**
 * The hex as a dichromat sees it. `normal` is the identity.
 *
 * THE MATRIX IS APPLIED IN LINEAR RGB, and that is the whole of the disagreement ui.md §5.2
 * records. Machado's matrices are defined on linear-light RGB; applying them to the
 * gamma-encoded bytes — which many published implementations do, because it is one fewer step
 * — moves this palette's deuteranopic minimum from 17.0 to 15.1 and its protanopic minimum
 * from 22.3 to 19.5, i.e. it would put bands 2–5 under AC-611's floor of 16 on an
 * implementation detail. The linear form reproduces slice 0's recorded `22.3 / 17.0` EXACTLY
 * and ui.md §5.2's round-9 figures to within 0.5 ΔE, which is the gap §5.2 itself flags.
 */
export function simulate(hex, type) {
  if (type === 'normal') return hex;
  const M = MACHADO[type];
  if (!M) throw new Error('unknown vision type: ' + type);
  const c = rgbOf(hex).map(lin);
  return hexOf(M.map((row) => gam(row[0] * c[0] + row[1] * c[1] + row[2] * c[2])));
}

/** The minimum pairwise CIEDE2000 within a colour set, under one vision type. */
export function minPairwiseDeltaE(hexes, type = 'normal') {
  let min = Infinity;
  let pair = null;
  const sim = hexes.map((h) => simulate(h, type));
  for (let i = 0; i < sim.length; i += 1) {
    for (let j = i + 1; j < sim.length; j += 1) {
      const d = deltaE2000(sim[i], sim[j]);
      if (d < min) {
        min = d;
        pair = [i, j];
      }
    }
  }
  return { min, pair };
}

/** Every pair, ascending by separation — ui.md §5.2's "worst / second / third" table. */
export function pairsByDeltaE(hexes, type = 'normal') {
  const sim = hexes.map((h) => simulate(h, type));
  const out = [];
  for (let i = 0; i < sim.length; i += 1) {
    for (let j = i + 1; j < sim.length; j += 1) out.push({ i, j, deltaE: deltaE2000(sim[i], sim[j]) });
  }
  return out.sort((a, b) => a.deltaE - b.deltaE);
}
