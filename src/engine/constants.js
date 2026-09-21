// Offramp — engine constants.
//
// Every SCREAMING_SNAKE literal named in docs/design/gameplay.md and docs/design/generation.md
// lives here and nowhere else (gameplay.md:11). No module defines a second copy.

// --- Tick rate and the level clock (gameplay.md §2.1) -----------------------------------
export const TICK_HZ = 60;
export const MAX_CATCHUP_TICKS = 8;
export const LEVEL_SECONDS = 120;
/**
 * A level is exactly two minutes of ticks, compared against `state.tick` and never against a
 * wall clock (gameplay.md §2.1, AC-141). Step 5 of the tick tests `tick + 1 >= LEVEL_TICKS`
 * and step 6 increments, so the last tick simulated is 7,199 and a run contains exactly 7,200.
 */
export const LEVEL_TICKS = TICK_HZ * LEVEL_SECONDS; // 7200

// --- Fixed point (gameplay.md §2.2) -----------------------------------------------------
export const MLU = 1000; // milli-layout-units per LU

// --- Lives (gameplay.md §4.1) -----------------------------------------------------------
export const LIVES = 3;
// There is no points system. `delivered` IS the score (gameplay.md §4.3, AC-117): the four
// slice-0 scoring constants — the per-delivery value, the streak step, the streak cap and the
// per-life bonus — are deleted, and so is the `score` field on the state. Under a quota
// `delivered` ran to a known target and could not be a score; under a clock it is throughput
// over a fixed window, which is the interesting number, and a points total laid on top of it
// would be a second quantity that has to agree with the first.
//
// AC-117 is checked by grepping src/ for those four names, so they are deliberately not
// written here: a comment naming them would make the check fail, which is the correct
// behaviour for a check whose subject is a deletion.

// --- Spawn schedule (gameplay.md §2.7) --------------------------------------------------
export const SPAWN_LEAD = 90; // ticks of grace before the first car enters

// --- PRNG salts (gameplay.md §2.7) ------------------------------------------------------
export const GEN_SALT = 0x9e3779b1;
export const SPAWN_SALT = 0x85ebca6b;

// --- Design space (generation.md §3.1, §3.2) --------------------------------------------
//
// DESIGN_H moved 1600 -> 1500 in round 8. LU is a ratio unit, so only the ASPECT matters:
// the binding device is the iPhone SE 1st generation, whose play area is 320 x 484 pt — an
// aspect of 0.661 against the old rectangle's 0.625, so the old rectangle was height-bound
// there and wasted 17.5 pt of width. At 1000 x 1500 the SE fits both ways at 0.3200 rather
// than 0.3025 (ui.md §3.2).
export const DESIGN_W = 1000;
export const DESIGN_H = 1500;
export const ENTRY_Y = 50;
export const ENTRY_LEN = 220;
export const ROW0_Y = ENTRY_Y + ENTRY_LEN; // 270
export const ROUTE_H = 1080; // DEPOT_Y - ROW0_Y, the same at every band
export const DEPOT_Y = ROW0_Y + ROUTE_H; // 1350
// 50 + 220 + 1080 + DEPOT_H(128) + 22 margin = 1500 exactly (generation.md §3.2, AC-411).

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
//
// `quota`, `SPAWN_SLACK` and `diagLen` are GONE. A level ends on the clock, the spawn schedule
// is the exact list of cars that fit in two minutes, and an edge's length is computed from its
// endpoints (generation.md §3.3). `colW` is now a table value rather than
// `min(300, LANE_SPAN / (C - 1))`, which makes integrality a property of the table rather than
// an accident of which C a band happens to use (generation.md §3.2).
export const BANDS = [
  null, // bands are 1-indexed
  { band: 1, levels: [1, 4],   C: 3, K: 3, R: 5, pBranchPct: 85, Jmin: 3, Jmax: 4, Ja: 3, Dmin: 2, Dmax: 3, colW: 260, speedMluPerTick: 2750, interval: 204, jitter: 26 },
  { band: 2, levels: [5, 9],   C: 4, K: 3, R: 5, pBranchPct: 80, Jmin: 3, Jmax: 5, Ja: 3, Dmin: 2, Dmax: 3, colW: 230, speedMluPerTick: 2900, interval: 150, jitter: 18 },
  { band: 3, levels: [10, 15], C: 4, K: 4, R: 6, pBranchPct: 85, Jmin: 4, Jmax: 6, Ja: 4, Dmin: 2, Dmax: 4, colW: 230, speedMluPerTick: 3050, interval: 140, jitter: 18 },
  { band: 4, levels: [16, 22], C: 5, K: 4, R: 6, pBranchPct: 85, Jmin: 5, Jmax: 7, Ja: 5, Dmin: 2, Dmax: 4, colW: 180, speedMluPerTick: 3200, interval: 132, jitter: 16 },
  { band: 5, levels: [23, Infinity], C: 6, K: 5, R: 6, pBranchPct: 90, Jmin: 7, Jmax: 9, Ja: 7, Dmin: 2, Dmax: 5, colW: 150, speedMluPerTick: 3350, interval: 128, jitter: 16 },
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

/**
 * The upper bound on the spawn count, from gameplay.md §2.7's schedule loop: the last `i` for
 * which `SPAWN_LEAD + i*interval - jitter < LEVEL_TICKS`. 35 / 48 / 51 / 54 / 56 by band
 * (AC-139). The actual count for a seed is that or one fewer, because the last nominal slot
 * may be pushed past the clock by its own jitter draw.
 */
export function spawnCountMax(P) {
  return Math.floor((LEVEL_TICKS - 1 - SPAWN_LEAD + P.jitter) / P.interval) + 1;
}
