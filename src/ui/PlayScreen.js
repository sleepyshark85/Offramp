// Offramp — S3, the play screen (ui.md §2, §3).
//
// The Skia canvas underneath, the HUD above it, and the overlays above that. This component
// holds no simulation state and owns no timer: `useGame` owns both, and a restart remounts
// this component through its `key` so every cleanup runs.

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import PlaySurface from '../render/PlaySurface.js';
import HUD, { clockCaption } from './HUD.js';
import { computeLayout } from './layout.js';
import { CompleteOverlay, CountdownOverlay, FailedOverlay, PauseOverlay } from './overlays.js';
import { C, MS, OPACITY } from './theme.js';
import { useFade } from './useCountUp.js';
import { MODE } from './appState.js';
import { useGame } from './useGame.js';

// ui.md §10.3 — the only gesture the game understands is a tap (AC-312).
const TAP_MAX_DURATION_MS = 400;
const TAP_MAX_DISTANCE_PT = 16;

function haptic(kind) {
  // Haptics are a device affordance; on web the module is a no-op and calling it is noise.
  if (Platform.OS === 'web') return;
  if (kind === 'flip') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  else if (kind === 'misrouted') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  else if (kind === 'ended') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export default function PlayScreen({ runSeed, levelNumber, settings, onQuit, onNext, onRestart }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = useMemo(
    () => computeLayout({ screenW: width, screenH: height, insetTop: insets.top, insetBottom: insets.bottom }),
    [width, height, insets.top, insets.bottom],
  );

  const game = useGame({ runSeed, levelNumber, layout, settings, screen: 'play' });
  const { state, events, geom, mode, countdown, endFade, tap, pause, resume } = game;

  // ui.md §10.1 — the gesture handler's view starts at `playTop`, so the touch y has to be
  // put back into screen space before it is mapped into design space.
  const onTap = useCallback((x, y) => tap(x, y + layout.playTop), [tap, layout.playTop]);

  /**
   * AC-313. The point that gets hit-tested is the gesture's FIRST pointer, captured at
   * begin — NOT the point `onEnd` reports.
   *
   * RNGH tracks the CENTROID of every live pointer. `TapGestureHandler` does not override
   * `transformNativeEvent`, so the `x`/`y` on its events are
   * `tracker.getRelativeCoordsAverage()`, and `onPointerAdd` folds the jump the centroid
   * takes into `offsetX`/`offsetY` so that `maxDistance` never rejects it. The result is that
   * a second finger anywhere on the canvas drags the reported point toward it, and two
   * fingers on two junctions report ONE tap at the midpoint — which usually hits neither
   * junction and occasionally hits a third.
   *
   * `onBegin` fires exactly once per gesture, on the transition out of UNDETERMINED, which
   * happens on the first pointer's DOWN and only then. At that instant the tracker holds one
   * pointer, so the "average" IS that pointer. Every later pointer is therefore ignored by
   * construction rather than by a count we would have to keep. AC-312 still holds: the
   * capture hangs off the one tap gesture that is already registered, not off a second
   * handler.
   *
   * ON WEB ONLY, the extra pointer does not just fail to move the tap — it cancels it, and
   * that is upstream rather than here.
   * `node_modules/react-native-gesture-handler/src/web/handlers/TapGestureHandler.ts:162`
   * reads `this.offsetY += this.lastY = this.startY;` — an assignment where every sibling
   * line subtracts — so lifting a secondary pointer adds an absolute screen coordinate to
   * `offsetY` and `shouldFail()` sees hundreds of points against a `maxDistance` of 16.
   * Repairing that one character in node_modules and rebuilding makes AC-313's full clause
   * pass against this code unchanged (verified, then reverted — a vendored patch is not
   * something this project ships). The native recognisers are different code and are not
   * affected; the clause is a tier-5 obligation there. See e2e/play.e2e.mjs.
   */
  const firstPointRef = useRef(null);
  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(TAP_MAX_DURATION_MS)
        .maxDistance(TAP_MAX_DISTANCE_PT)
        .runOnJS(true)
        .onBegin((e) => {
          firstPointRef.current = { x: e.x, y: e.y };
        })
        .onEnd((_event, success) => {
          const first = firstPointRef.current;
          if (success && first) onTap(first.x, first.y);
        }),
    [onTap],
  );

  // ui.md §8.2, §8.4, §11.2 — light impact on flip, error on misroute, success on clear.
  const hapticTickRef = useRef(-1);
  useEffect(() => {
    if (!settings.haptics) return;
    for (const e of events) {
      if (e.tick <= hapticTickRef.current) continue;
      if (e.type === 'flip') haptic('flip');
      else if (e.type === 'misrouted') haptic('misrouted');
    }
    hapticTickRef.current = state.tick;
  }, [events, state.tick, settings.haptics]);

  // gameplay.md §2.4 — 'ended' is the CLEAR: the clock ran out with a life left.
  useEffect(() => {
    if (settings.haptics && state.phase === 'ended') haptic('ended');
  }, [state.phase, settings.haptics]);

  const ended = state.phase !== 'running';
  // ui.md §8.8 — the pause overlay dims the play surface too, not just the end-of-level
  // panels, and it un-dims on resume rather than snapping back.
  const paused = (mode === MODE.PAUSED || mode === MODE.COUNTDOWN) && !ended;
  const pauseFade = useFade(paused, MS.dim, settings.reduceMotion);
  const dim = state.phase === 'ended' ? endFade : ended ? 0 : pauseFade;
  const desaturate = state.phase === 'lost' ? endFade : 0;

  return (
    <View style={styles.root} testID="screen-play">
      <PlaySurface
        geom={geom}
        state={state}
        events={events}
        layout={layout}
        symbolLarge={settings.symbolLarge}
        dim={dim}
        desaturate={desaturate}
      />

      {/* ui.md §11.3 — the canvas is exposed as ONE element with a live summary. Per-car
          announcement is explicitly out of scope and is not faked with labels that would be
          stale by the time they finished being read. */}
      <GestureDetector gesture={gesture}>
        <View
          style={[styles.touch, { top: layout.playTop }]}
          testID="play-surface"
          accessible
          accessibilityRole="image"
          accessibilityLabel={
            'Level ' + levelNumber + '. ' + state.delivered + ' delivered. ' +
            clockCaption(state.tick) + ' remaining. ' + state.lives + ' lives.'
          }
        />
      </GestureDetector>

      {/* ui.md §8.5 — a 2 pt --alert border at 24 % sits steady inside the screen edge while
          `lives === 1`, and persists until the level ends. */}
      {state.lives === 1 && !ended ? (
        <View pointerEvents="none" style={styles.lastLife} testID="last-life-border" />
      ) : null}

      <HUD
        top={insets.top}
        width={width}
        level={{ number: levelNumber }}
        state={state}
        onPause={pause}
        reduceMotion={settings.reduceMotion}
      />

      {mode === MODE.PAUSED && !ended ? (
        <PauseOverlay
          onResume={resume}
          onRestart={onRestart}
          onQuit={onQuit}
          reduceMotion={settings.reduceMotion}
        />
      ) : null}

      {mode === MODE.COUNTDOWN ? (
        <CountdownOverlay n={countdown} reduceMotion={settings.reduceMotion} />
      ) : null}

      {state.phase === 'ended' ? (
        <CompleteOverlay
          levelNumber={levelNumber}
          state={state}
          onRetry={onRestart}
          onNext={onNext}
          reduceMotion={settings.reduceMotion}
        />
      ) : null}

      {state.phase === 'lost' ? (
        <FailedOverlay
          state={state}
          onRetry={onRestart}
          onLevels={onQuit}
          reduceMotion={settings.reduceMotion}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  touch: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  lastLife: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: C.alert,
    opacity: OPACITY.lastLifeBorder,
  },
});
