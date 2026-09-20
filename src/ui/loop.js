// Offramp — the ms -> tick loop, as pure functions (ui.md §10.2, gameplay.md §2.1, §6).
//
// The React layer owns the timer; this module owns what happens on a frame. Keeping it out
// of the hook is what makes AC-127, AC-128, AC-305, AC-306, AC-803, AC-805 and AC-806
// testable in bare Node with no renderer and no wall clock.
//
// Nothing here is scheduled, and nothing here is called from inside a setState updater.

import { MAX_POINTERS, advanceClock, step } from '../engine/index.js';

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

/**
 * AC-515 requires the misroute shatter to originate at the mouth line of THE TERMINAL EDGE
 * THE CAR CAME DOWN, and `delivered` / `misrouted` carry `carId` and `depotId` but not the
 * edge. A depot has in-degree up to 3 (gameplay.md §4.5b), so the depot does not determine
 * the edge and the renderer cannot satisfy AC-515 from the event alone.
 *
 * The edge is recovered here rather than by changing the engine: the car's edge at the START
 * of the tick it arrives on IS the terminal edge, because one tick moves a car at most
 * 3.8 LU and the shortest terminal edge is 200 LU. This is a render hint derived from engine
 * state, not a second source of truth — and it is reported to the designer as an event-payload
 * gap, because recovering it outside the engine is a workaround, not a fix.
 */
function withEdge(events, edgeOf) {
  let touched = false;
  const out = events.map((e) => {
    if (e.type !== 'delivered' && e.type !== 'misrouted') return e;
    if (!edgeOf.has(e.carId)) return e;
    touched = true;
    return { ...e, edgeId: edgeOf.get(e.carId) };
  });
  return touched ? out : events;
}

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
 * AC-306 / ui.md §10.3: at most MAX_POINTERS inputs are accepted for any one tick. Two taps
 * on the same junction in the same tick are both kept — two toggles is two toggles
 * (gameplay.md §3.5) — so this never dedupes.
 */
export function enqueueTap(pending, state, junctionId) {
  const tick = state.tick;
  let sameTick = 0;
  for (const p of pending) if (p.tick === tick) sameTick += 1;
  if (sameTick >= MAX_POINTERS) return pending;
  return pending.concat([{ tick, junctionId }]);
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
    const edgeOf = new Map();
    for (const c of s.cars) edgeOf.set(c.id, c.edgeId);
    s = step(s, forTick);
    events = collectEvents(events, { tick: s.tick, events: withEdge(s.events, edgeOf) });
    ticksRun += 1;
  }

  // A frame that ran no ticks still prunes, so an animation ends on its own tick budget even
  // if the game ends and the clock stops.
  if (ticksRun === 0) events = collectEvents(events, { tick: s.tick, events: [] });

  return { state: s, accTicks: clock.accTicks, pending: queue, recent: events, ticksRun };
}
