// Offramp — the React state layer.
//
// THIS FILE OWNS EVERY TIMER IN THE GAME, and every one of them has explicit cleanup.
//
// The rules it is written to, from CLAUDE.md:
//   * Nothing is scheduled from inside a setState updater. The only updater here is
//     `setCountdown(n => n - 1)`, which is a pure decrement — React 19 StrictMode
//     double-invokes it in development and a pure decrement survives that unchanged.
//   * The engine advances whole ticks only. `advanceClock` in src/engine/clock.js is the
//     ms -> tick boundary and this layer never does that arithmetic itself.
//   * Backgrounding does not advance the simulation. `resetClock()` is called when the app
//     leaves 'active', when a pause begins, and when play resumes. A phone call is not 400
//     ticks (AC-803).
//   * Rendering is replay. Nothing here decides anything the engine decides.
//
// A restart REMOUNTS the play screen (see PlayScreen's `key`), so there is no reset path to
// get wrong: unmount runs every cleanup, and mount builds a fresh state at tick 0.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { createState, resetClock } from '../engine/index.js';
import { buildLevelGeometry } from '../render/geometry.js';
import { junctionSites, hitTest } from './hitTest.js';
import { advanceFrame, enqueueTap } from './loop.js';
import { buildLevel } from './run.js';
import { buildSnapshot, levelSnapshot, publishSnapshot, snapshotAvailable } from './snapshot.js';
import { MS } from './theme.js';

/**
 * AC-812. A module-level count of live animation-frame loops. React 19 StrictMode mounts,
 * unmounts and remounts every effect in development; if the cleanup below were missing or
 * wrong, two loops would run and the simulation would advance at twice the rate. The E2E
 * suite asserts this is exactly 1 and that the tick rate matches a StrictMode-off run.
 */
const LIVE_LOOPS = { count: 0 };

export const MODE = { RUNNING: 'running', PAUSED: 'paused', COUNTDOWN: 'countdown' };

export function useGame({ runSeed, levelNumber, layout, settings, screen }) {
  const level = useMemo(() => buildLevel(runSeed, levelNumber), [runSeed, levelNumber]);
  const geom = useMemo(() => buildLevelGeometry(level), [level]);
  const sites = useMemo(() => junctionSites(level), [level]);
  const levelSnap = useMemo(() => levelSnapshot(geom, levelNumber), [geom, levelNumber]);

  const [view, setView] = useState(() => ({ state: createState(level), events: [] }));
  const [mode, setMode] = useState(MODE.RUNNING);
  const [countdown, setCountdown] = useState(0);
  const [endFade, setEndFade] = useState(0);

  // The authoritative simulation. Held in a ref because it is advanced from a frame callback
  // sixty times a second and must not depend on a render having committed in between.
  const simRef = useRef(null);
  if (simRef.current === null) {
    simRef.current = { state: view.state, acc: 0, pending: [], events: [], frames: 0 };
  }
  const backgroundedRef = useRef(false);

  const phase = view.state.phase;
  const running = mode === MODE.RUNNING && phase === 'running';

  // --- timer 1: the simulation loop ------------------------------------------------------
  useEffect(() => {
    if (!running) return undefined;
    const sim = simRef.current;
    let cancelled = false;
    let raf = 0;
    let last = -1;
    // No catch-up across a start or a resume (gameplay.md §6.2). The first frame's delta is
    // zero by construction rather than by a NaN that advanceClock would have to absorb.
    sim.acc = resetClock();
    LIVE_LOOPS.count += 1;

    const frame = (now) => {
      if (cancelled) return;
      const deltaMs = last < 0 ? 0 : now - last;
      last = now;
      const before = sim.events.length;
      const r = advanceFrame(sim.state, sim.acc, deltaMs, sim.pending, sim.events);
      sim.state = r.state;
      sim.acc = r.accTicks;
      sim.pending = r.pending;
      sim.events = r.recent;
      sim.frames += 1;
      if (r.ticksRun > 0 || r.recent.length !== before) {
        // A plain value, never an updater: nothing is scheduled from inside setState.
        setView({ state: r.state, events: r.recent });
      }
      if (r.state.phase === 'running') raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      LIVE_LOOPS.count -= 1;
    };
  }, [running]);

  // --- timer 2: the resume countdown (AC-804) --------------------------------------------
  useEffect(() => {
    if (mode !== MODE.COUNTDOWN) return undefined;
    const id = setInterval(() => setCountdown((n) => n - 1), MS.countdownBeat);
    return () => clearInterval(id);
  }, [mode]);

  useEffect(() => {
    if (mode === MODE.COUNTDOWN && countdown <= 0) {
      simRef.current.acc = resetClock();
      setMode(MODE.RUNNING);
    }
  }, [mode, countdown]);

  // --- timer 3: the end-of-level dim / desaturate (ui.md §8.6, §8.7) ---------------------
  // Wall clock is correct here and only here: the simulation has stopped, so a tick-derived
  // phase would be frozen at zero for as long as the panel is up.
  useEffect(() => {
    if (phase === 'running') return undefined;
    const duration = phase === 'lost' ? MS.desaturate : MS.dim;
    let cancelled = false;
    let raf = 0;
    let t0 = -1;
    const fade = (now) => {
      if (cancelled) return;
      if (t0 < 0) t0 = now;
      const p = Math.min(1, (now - t0) / duration);
      setEndFade(p);
      if (p < 1) raf = requestAnimationFrame(fade);
    };
    raf = requestAnimationFrame(fade);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [phase]);

  // --- backgrounding (AC-803) ------------------------------------------------------------
  useEffect(() => {
    const onChange = (next) => {
      if (next !== 'active') {
        simRef.current.acc = resetClock();
        backgroundedRef.current = true;
        setMode(MODE.PAUSED);
      } else if (backgroundedRef.current) {
        backgroundedRef.current = false;
        simRef.current.acc = resetClock();
        setCountdown(3);
        setMode(MODE.COUNTDOWN);
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  // --- the tier-3 snapshot ---------------------------------------------------------------
  // Published after every commit, so a paused or finished game publishes too. `frames`
  // counts ANIMATION FRAMES, so it stops rising the moment the loop stops — which is how a
  // test tells a paused game from a live one without looking inside the canvas.
  useEffect(() => {
    if (!snapshotAvailable()) return;
    publishSnapshot(
      buildSnapshot({
        screen,
        mode,
        countdown,
        layout,
        level: levelSnap,
        geom,
        state: view.state,
        events: view.events,
        frames: simRef.current.frames,
        loops: LIVE_LOOPS.count,
        settings,
      }),
    );
  });

  // --- player actions --------------------------------------------------------------------

  const tap = useCallback(
    (sx, sy) => {
      // AC-307 / AC-308: taps are discarded while paused, during the resume countdown, and
      // once the level has ended.
      if (mode !== MODE.RUNNING) return;
      const sim = simRef.current;
      if (sim.state.phase !== 'running') return;
      const junctionId = hitTest(layout, level, sites, sx, sy);
      // AC-304: a tap on empty road is ignored silently. No event, no feedback.
      if (junctionId < 0) return;
      sim.pending = enqueueTap(sim.pending, sim.state, junctionId);
    },
    [mode, layout, level, sites],
  );

  const pause = useCallback(() => {
    simRef.current.acc = resetClock();
    setMode(MODE.PAUSED);
  }, []);

  const resume = useCallback(() => {
    simRef.current.acc = resetClock();
    setMode(MODE.RUNNING);
  }, []);

  return { level, geom, state: view.state, events: view.events, mode, countdown, endFade, tap, pause, resume };
}
