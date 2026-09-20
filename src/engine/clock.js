// Offramp — the wall-clock / tick boundary (gameplay.md §2.1).
//
// This is the ONLY place milliseconds are converted to ticks. It is a pure function so the
// rule can be tested without React and without a timer. The engine itself never sees a
// millisecond or a fraction of a tick: `step()` is called `ticks` times and nothing else
// crosses the boundary.

import { MAX_CATCHUP_TICKS, TICK_HZ } from './constants.js';

/**
 * @param accTicks fractional tick accumulator carried by the caller (starts at 0)
 * @param deltaMs  real elapsed milliseconds since the previous frame
 * @returns { ticks, accTicks } — whole ticks to run, and the accumulator to carry forward.
 *
 * Converting in tick units rather than dividing by a 16.666… ms constant keeps the common
 * frame times exact: 16.667 ms → 1, 50 ms → exactly 3.
 *
 * When more than MAX_CATCHUP_TICKS ticks are owed the surplus is DISCARDED and the
 * accumulator is reset to 0 (gameplay.md §2.1). World time runs slower than wall time on a
 * device that cannot keep up; it never teleports a car past a junction.
 */
export function advanceClock(accTicks, deltaMs) {
  const acc = accTicks + (deltaMs * TICK_HZ) / 1000;
  let ticks = Math.floor(acc);
  if (ticks < 0) return { ticks: 0, accTicks: 0 };
  if (ticks > MAX_CATCHUP_TICKS) return { ticks: MAX_CATCHUP_TICKS, accTicks: 0 };
  return { ticks, accTicks: acc - ticks };
}

/** Resume from background: no catch-up at all. A phone call is not 400 ticks. */
export function resetClock() {
  return 0;
}
