// Offramp — engine constants.
//
// Every SCREAMING_SNAKE literal named in docs/design/gameplay.md and docs/design/generation.md
// lives here and nowhere else (gameplay.md:11). No module defines a second copy.

// --- Tick rate (gameplay.md §2.1) -------------------------------------------------------
export const TICK_HZ = 60;
export const MAX_CATCHUP_TICKS = 8;

// --- Fixed point (gameplay.md §2.2) -----------------------------------------------------
export const MLU = 1000; // milli-layout-units per LU

// --- Lives and scoring (gameplay.md §4.1, §4.3) -----------------------------------------
export const LIVES = 3;
export const SCORE_DELIVERY = 100;
export const SCORE_STREAK_STEP = 10;
export const STREAK_CAP = 9;
export const SCORE_LIFE_BONUS = 50;

// --- Spawn schedule (gameplay.md §2.7) --------------------------------------------------
export const SPAWN_LEAD = 90; // ticks of grace before the first car enters
export const SPAWN_SLACK = 8; // SPAWN_COUNT = quota + SPAWN_SLACK

// --- PRNG salts (gameplay.md §2.7) ------------------------------------------------------
export const GEN_SALT = 0x9e3779b1;
export const SPAWN_SALT = 0x85ebca6b;

// --- Input model (gameplay.md §3.5) -----------------------------------------------------
export const MAX_POINTERS = 2;

// --- Design space (generation.md §3.1, §3.2) --------------------------------------------
export const DESIGN_W = 1000;
export const DESIGN_H = 1600;
export const LANE_SPAN = 780;
export const ENTRY_Y = 60;
export const ROW0_Y = 160;
export const DEPOT_Y = 1360;
export const ENTRY_LEN = ROW0_Y - ENTRY_Y; // 100 LU
export const COL_W_CAP = 300;

// Bezier control-point fraction (generation.md §2.3). Held as an exact rational so that the
// offline arc-length derivation in test/ and the renderer agree on one value, and so that no
// float literal is needed to state it.
export const K_CTRL_NUM = 45;
export const K_CTRL_DEN = 100;

// --- Generator search (generation.md §4, §4.2) ------------------------------------------
export const MAX_ATTEMPTS = 256;
export const BUILD_BUDGET = 40000; // recursion steps per buildRow call
export const V12_SALT = 0xc2b2ae35;
export const V12_MAX_REDERIVE = 8;
export const MIN_JUNCTION_SEP_LU = 150; // V11

// --- Palette (ui.md §5.1) ---------------------------------------------------------------
// Colour index is the match key; the hex is render-only and lives here so that V10 can be
// checked against one list.
export const PALETTE = ['#FF852A', '#89D9FF', '#FF5386', '#22C6AF', '#A879FF'];

// --- Band table (generation.md §6.1) ----------------------------------------------------
// pBranchPct is generation.md's pBranch expressed as an exact integer percentage, so the
// branch-bias draw is `nextInt(100) < pBranchPct` and the generator holds no float at all.
export const BANDS = [
  null, // bands are 1-indexed
  { band: 1, levels: [1, 4],   C: 3, K: 3, R: 3, pBranchPct: 85, Jmin: 3, Jmax: 3, Dmin: 2, Dmax: 2, rowH: 400, colW: 300, diagLen: 521, speedMluPerTick: 3000, interval: 156, jitter: 12, quota: 16 },
  { band: 2, levels: [5, 9],   C: 4, K: 3, R: 4, pBranchPct: 70, Jmin: 3, Jmax: 5, Dmin: 2, Dmax: 3, rowH: 300, colW: 260, diagLen: 415, speedMluPerTick: 3200, interval: 138, jitter: 12, quota: 26 },
  { band: 3, levels: [10, 15], C: 4, K: 4, R: 4, pBranchPct: 80, Jmin: 4, Jmax: 6, Dmin: 2, Dmax: 3, rowH: 300, colW: 260, diagLen: 415, speedMluPerTick: 3400, interval: 120, jitter: 18, quota: 36 },
  { band: 4, levels: [16, 22], C: 5, K: 4, R: 5, pBranchPct: 80, Jmin: 5, Jmax: 7, Dmin: 2, Dmax: 4, rowH: 240, colW: 195, diagLen: 323, speedMluPerTick: 3600, interval: 108, jitter: 18, quota: 48 },
  { band: 5, levels: [23, Infinity], C: 5, K: 5, R: 6, pBranchPct: 88, Jmin: 7, Jmax: 8, Dmin: 2, Dmax: 4, rowH: 200, colW: 195, diagLen: 293, speedMluPerTick: 3800, interval: 96, jitter: 18, quota: 64 },
];

/** Level number -> band index (gameplay.md §5, AC-701). */
export function bandForLevel(n) {
  if (n <= 4) return 1;
  if (n <= 9) return 2;
  if (n <= 15) return 3;
  if (n <= 22) return 4;
  return 5;
}

export function bandParams(band) {
  const p = BANDS[band];
  if (!p) throw new Error('UNKNOWN_BAND: ' + band);
  return p;
}
