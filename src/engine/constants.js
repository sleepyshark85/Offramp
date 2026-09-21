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
/**
 * CAR_SPEED is ONE CONSTANT AT EVERY BAND — 2750 MLU/tick = 165 LU/s (gameplay.md §2.2, §5,
 * generation.md §6.1). It left the band table in round 9 on the owner's instruction, and the
 * measurement agrees with him: the board's occupancy is `transit / interval`, so round 8's
 * rising speed column was cancelling its falling interval column and the difficulty ladder was
 * flat (generation.md §6.1.1). Speed is a TRAFFIC lever with as much force as `interval`, and
 * because it is shared by every band it is never pulled for one (generation.md §7.4 lever 1).
 */
export const CAR_SPEED = 2750;

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

// --- colW is DERIVED, not tabled (generation.md §3.2.1) ---------------------------------
//
//   colW(C) = the largest EVEN value satisfying both
//               (C - 1) * colW <= DESIGN_W - DEPOT_W_LU - 2 * DEPOT_EDGE_CLEARANCE_LU = 792
//               colW           <= COL_W_MAX
//
// The first bound keeps the OUTERMOST DEPOT at least DEPOT_EDGE_CLEARANCE_LU inside the design
// rectangle; the second caps a horizontal run at 30 % of the design width, above which a jog
// stops reading as a jog and starts reading as a corridor. `C = 3` is the only C the cap binds
// at; every other band takes the clearance bound exactly, which is AC-410's 42 LU margin.
//
// Round 8 chose colW by hand and chose it too small at every C, which cost difficulty
// (`jogs * colW` is the only band-varying term in `transit`) and cost the tap target
// (`min(colW, rowH)` is what ui.md §4.4's 44 pt floor is computed from).
//
// DEPOT_EDGE_CLEARANCE_LU is 42 and it is written as its own number rather than as
// `ROAD_W / 2`. It was half a road width when the road was 84 LU wide; ROAD_W is now 28
// (ui.md §4.1) and the clearance did NOT follow it down — generation.md §3.2.1's formula still
// evaluates to 792 and AC-410 spells the constant `ROAD_W_OLD/2*2`. Tying it to the live
// ROAD_W would give 848 and move every colW in the table.
export const DEPOT_W_LU = 124;
export const DEPOT_EDGE_CLEARANCE_LU = 42;
export const COL_W_MAX = 300;

/** generation.md §3.2.1. Integer, even, and a pure function of `C`. */
export function colWFor(C) {
  const span = DESIGN_W - DEPOT_W_LU - 2 * DEPOT_EDGE_CLEARANCE_LU; // 792
  const fit = Math.floor(span / (C - 1));
  return Math.min(COL_W_MAX, fit - (fit % 2));
}

// --- Generator search (generation.md §4, §4.2) ------------------------------------------
export const MAX_ATTEMPTS = 256;
export const BUILD_BUDGET = 40000; // recursion steps per buildRow call
export const V12_SALT = 0xc2b2ae35;
export const V12_MAX_REDERIVE = 8;
export const MIN_JUNCTION_SEP_LU = 150; // V11

// --- Palette (ui.md §5.1) ---------------------------------------------------------------
// Colour index is the match key; the hex is render-only and lives here so that V10 can be
// checked against one list.
// Six colours in round 9. `K` is now `C` at every band and `C` caps at 6 (generation.md
// §3.2.1), so six is the most colour this design rectangle can carry. Lime was OPTIMISED
// rather than picked — the same constrained CIELCh search that produced the other five, at
// C* >= 45, >= 3.0 : 1 against `--road` and >= 4.5 : 1 against `--bg` (ui.md §5.1, AC-611).
export const PALETTE = ['#FF852A', '#89D9FF', '#FF5386', '#22C6AF', '#A879FF', '#B0F0A3'];

// --- Band table (generation.md §6.1) ----------------------------------------------------
// pBranchPct is generation.md's pBranch expressed as an exact integer percentage, so the
// branch-bias draw is `nextInt(100) < pBranchPct` and the generator holds no float at all.
//
// `quota`, `SPAWN_SLACK` and `diagLen` are GONE. A level ends on the clock, the spawn schedule
// is the exact list of cars that fit in two minutes, and an edge's length is computed from its
// endpoints (generation.md §3.3).
//
// TWO COLUMNS LEFT THE TABLE IN ROUND 9 and both departures are the round's content:
//
//   `speedMluPerTick` — now CAR_SPEED, one constant at every band. Round 8 raised it
//   2750 -> 3350 across the ladder, which exactly cancelled the falling `interval` column in
//   `carsInFlight = transit / interval` and flattened the difficulty ladder
//   (generation.md §6.1.1).
//
//   `colW` — now DERIVED by colWFor(C) above. It was a table value in round 8 and hand-chosen
//   too small at every C (generation.md §3.2.1).
//
// `K` is now `C` at every band: 3 / 4 / 4 / 5 / 6. Round 8 ran 3 / 3 / 4 / 4 / 5, so the first
// nine levels were chromatically identical and the ceiling was five colours (ui.md §5.1).
export const BANDS = [
  null, // bands are 1-indexed
  { band: 1, levels: [1, 4],   C: 3, K: 3, R: 5, pBranchPct: 85, Jmin: 3, Jmax: 4, Ja: 3, Dmin: 2, Dmax: 3, interval: 208, jitter: 21 },
  { band: 2, levels: [5, 9],   C: 4, K: 4, R: 5, pBranchPct: 80, Jmin: 3, Jmax: 5, Ja: 3, Dmin: 2, Dmax: 3, interval: 147, jitter: 15 },
  { band: 3, levels: [10, 15], C: 4, K: 4, R: 6, pBranchPct: 85, Jmin: 4, Jmax: 6, Ja: 4, Dmin: 2, Dmax: 4, interval: 140, jitter: 14 },
  { band: 4, levels: [16, 22], C: 5, K: 5, R: 6, pBranchPct: 85, Jmin: 5, Jmax: 7, Ja: 5, Dmin: 2, Dmax: 4, interval: 131, jitter: 13 },
  { band: 5, levels: [23, Infinity], C: 6, K: 6, R: 6, pBranchPct: 90, Jmin: 7, Jmax: 9, Ja: 7, Dmin: 2, Dmax: 5, interval: 128, jitter: 13 },
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
