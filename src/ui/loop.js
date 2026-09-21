// Offramp — the ms -> tick loop, as pure functions (ui.md §10.2, gameplay.md §2.1, §6).
//
// The React layer owns the timer; this module owns what happens on a frame. Keeping it out
// of the hook is what makes AC-127, AC-128, AC-305, AC-306, AC-803, AC-805 and AC-806
// testable in bare Node with no renderer and no wall clock.
//
// Nothing here is scheduled, and nothing here is called from inside a setState updater.

import { advanceClock, step } from '../engine/index.js';

/**
 * How far back the renderer can still be showing an event. The longest play-surface
 * animation in ui.md §9 is the depot rejecting flash at 90 + 260 = 350 ms, which is 21 ticks
 * at TICK_HZ = 60; 24 covers it with margin.
 *
 * The engine clears `state.events` at the start of every step (gameplay.md §2.8), so a frame
 * that advanced three ticks would otherwise show only the third tick's events and the
 * renderer would drop animations on slow frames. This buffer is not a second source of
 * truth: it is the engine's own event stream, pruned by TICK — never by frame or by wall
 * clock — so a replay at any frame rate rebuilds it identically (AC-505).
 */
export const EVENT_WINDOW_TICKS = 24;

// AC-140 closed the event-payload gap this file used to work around. Through slice 2 a
// `withEdge()` helper re-attached the arriving edge to every `delivered` / `misrouted` event
// by snapshotting each car's `edgeId` at the START of the tick — sound, because one tick
// moves a car at most 3.8 LU against a terminal edge of at least 200 LU, but a second
// derivation of a fact the engine held in a local variable (docs/development-process.md:173).
// `resolveArrival` now puts `edgeId` on both events (gameplay.md §2.6), the cross-check in
// test/render-geometry.test.js and tools/render-audit.mjs shows the two agreed on every
// arrival over 1,000 levels a band, and the workaround is deleted rather than kept as a
// fallback.

/** Pure. Appends this step's events and drops anything older than the window. */
export function collectEvents(recent, state) {
  const cutoff = state.tick - EVENT_WINDOW_TICKS;
  const out = [];
  for (const e of recent) if (e.tick > cutoff) out.push(e);
  for (const e of state.events) if (e.tick > cutoff) out.push(e);
  return out;
}

/**
 * AC-305. A tap enqueues `{tick: nextTickToSimulate, junctionId}` — and `state.tick` *is*
 * the tick about to be simulated (gameplay.md §2.4), so no arithmetic is needed and there is
 * no off-by-one to get wrong.
 *
 * AC-306 / gameplay.md §3.5: every tap is enqueued. Nothing is coalesced, deduped, debounced
 * or dropped, and there is no cap on how many inputs may share a tick — two taps on the same
 * junction in the same tick are two toggles, and two taps on different junctions resolve by
 * ascending junction id inside `step()` (AC-110). The `MAX_POINTERS = 2` cap this function
 * used to apply was deleted in round 7 with the two-pointer input model it belonged to
 * (ui.md §10.3): Offramp is a one-pointer game, so a cap on simultaneous pointers was
 * protecting a queue property it could not express, and the queue property is the guarantee.
 */
export function enqueueTap(pending, state, junctionId) {
  return pending.concat([{ tick: state.tick, junctionId }]);
}

/**
 * One frame. Converts `deltaMs` to whole ticks through the engine's clock boundary and runs
 * `step()` that many times, handing each tick the inputs stamped for it.
 *
 * Returns a NEW result object; nothing here mutates its arguments. `ticksRun` is what
 * actually executed, which is not `ticks` once the level ends mid-frame.
 *
 * Inputs are taken with `p.tick <= s.tick` rather than `===` so that an input stamped for a
 * tick the catch-up cap discarded (AC-127) is still honoured on the next tick instead of
 * being stranded in the queue forever. The flip is never silently dropped (gameplay.md §3.4).
 */
export function advanceFrame(state, accTicks, deltaMs, pending, recent) {
  const clock = advanceClock(accTicks, deltaMs);
  let s = state;
  let queue = pending;
  let events = recent;
  let ticksRun = 0;

  for (let i = 0; i < clock.ticks; i += 1) {
    if (s.phase !== 'running') break;
    let forTick = null;
    if (queue.length) {
      const rest = [];
      forTick = [];
      for (const p of queue) {
        if (p.tick <= s.tick) forTick.push(p);
        else rest.push(p);
      }
      queue = rest;
    }
    s = step(s, forTick);
    events = collectEvents(events, s);
    ticksRun += 1;
  }

  // A frame that ran no ticks still prunes, so an animation ends on its own tick budget even
  // if the game ends and the clock stops.
  if (ticksRun === 0) events = collectEvents(events, { tick: s.tick, events: [] });

  return { state: s, accTicks: clock.accTicks, pending: queue, recent: events, ticksRun };
}
