// Offramp — chrome animation outside the canvas (ui.md §9).
//
// ui.md §9: "UI chrome outside the canvas — panels, countdown, score count-up — may use
// wall-clock time, because it is not part of the replayable world." These hooks are that,
// and like everything else in src/ui/ they clean up.

import { useEffect, useRef, useState } from 'react';

import { easeOutCubic, easeInOutSine } from '../render/motion.js';

/**
 * Eases a displayed number toward `target` over `durationMs`. Reduce motion makes it
 * instant (ui.md §11.2) — which removes the animation, never the information.
 */
export function useCountUp(target, durationMs, reduceMotion) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);

  useEffect(() => {
    const from = fromRef.current;
    if (reduceMotion || from === target) {
      fromRef.current = target;
      setValue(target);
      return undefined;
    }
    let cancelled = false;
    let raf = 0;
    let t0 = -1;
    const frame = (now) => {
      if (cancelled) return;
      if (t0 < 0) t0 = now;
      const p = Math.min(1, (now - t0) / durationMs);
      setValue(from + (target - from) * easeOutCubic(p));
      if (p < 1) raf = requestAnimationFrame(frame);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      fromRef.current = target;
    };
  }, [target, durationMs, reduceMotion]);

  return value;
}

/**
 * A one-way wall-clock ramp, 0 -> 1 while `active` and 1 -> 0 when it clears. ui.md §9 gives
 * the play-surface dim 240 ms and the failure desaturate 320 ms, and neither can be derived
 * from ticks: the simulation is stopped for both.
 */
export function useFade(active, durationMs, reduceMotion) {
  const [value, setValue] = useState(active ? 1 : 0);
  // The value the ramp is starting FROM, so a reversal mid-ramp is continuous. It lives in a
  // ref written only from the frame callback; reading it inside a setState updater would put
  // a side effect in an updater, which React 19 StrictMode double-invokes and which is the
  // one thing CLAUDE.md names as the predecessor project's defining defect.
  const currentRef = useRef(active ? 1 : 0);

  useEffect(() => {
    const to = active ? 1 : 0;
    const from = currentRef.current;
    if (reduceMotion || from === to) {
      currentRef.current = to;
      setValue(to);
      return undefined;
    }
    let cancelled = false;
    let raf = 0;
    let t0 = -1;
    const frame = (now) => {
      if (cancelled) return;
      if (t0 < 0) t0 = now;
      const p = Math.min(1, (now - t0) / durationMs);
      const v = from + (to - from) * easeOutCubic(p);
      currentRef.current = v;
      setValue(v);
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [active, durationMs, reduceMotion]);

  return value;
}

/**
 * ui.md §8.5 — the last-life pulse: 1.6 s ease-in-out-sine between 1.00 and 0.65, sustained
 * jeopardy without a startle that would cost the player the car they are tracking. Reduce
 * motion replaces it with the static border, so the hook returns a constant and registers no
 * timer at all.
 */
export function usePulse(active, periodMs, lo, hi, reduceMotion) {
  const [value, setValue] = useState(hi);

  useEffect(() => {
    if (!active || reduceMotion) {
      setValue(hi);
      return undefined;
    }
    let cancelled = false;
    let raf = 0;
    let t0 = -1;
    const frame = (now) => {
      if (cancelled) return;
      if (t0 < 0) t0 = now;
      const p = ((now - t0) % periodMs) / periodMs;
      setValue(lo + (hi - lo) * easeInOutSine(p < 0.5 ? p * 2 : 2 - p * 2));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [active, periodMs, lo, hi, reduceMotion]);

  return value;
}
