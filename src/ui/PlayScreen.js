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
import HUD from './HUD.js';
import { computeLayout } from './layout.js';
import { CompleteOverlay, CountdownOverlay, FailedOverlay, PauseOverlay } from './overlays.js';
import { C, MS, OPACITY } from './theme.js';
import { useFade } from './useCountUp.js';
import { MODE, useGame } from './useGame.js';

// ui.md §10.3 — the only gesture the game understands is a tap (AC-312).
const TAP_MAX_DURATION_MS = 400;
const TAP_MAX_DISTANCE_PT = 16;

function haptic(kind) {
  // Haptics are a device affordance; on web the module is a no-op and calling it is noise.
  if (Platform.OS === 'web') return;
  if (kind === 'flip') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  else if (kind === 'misrouted') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  else if (kind === 'won') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(TAP_MAX_DURATION_MS)
        .maxDistance(TAP_MAX_DISTANCE_PT)
        .runOnJS(true)
        .onEnd((e, success) => {
          if (success) onTap(e.x, e.y);
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

  useEffect(() => {
    if (settings.haptics && state.phase === 'won') haptic('won');
  }, [state.phase, settings.haptics]);

  const ended = state.phase !== 'running';
  // ui.md §8.8 — the pause overlay dims the play surface too, not just the end-of-level
  // panels, and it un-dims on resume rather than snapping back.
  const paused = (mode === MODE.PAUSED || mode === MODE.COUNTDOWN) && !ended;
  const pauseFade = useFade(paused, MS.dim, settings.reduceMotion);
  const dim = state.phase === 'won' ? endFade : ended ? 0 : pauseFade;
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
            'Level ' + levelNumber + '. ' + state.delivered + ' of ' + geom.level.quota +
            ' delivered. ' + state.lives + ' lives.'
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
        level={{ number: levelNumber, quota: geom.level.quota }}
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

      {state.phase === 'won' ? (
        <CompleteOverlay
          levelNumber={levelNumber}
          state={state}
          quota={geom.level.quota}
          onRetry={onRestart}
          onNext={onNext}
          reduceMotion={settings.reduceMotion}
        />
      ) : null}

      {state.phase === 'lost' ? (
        <FailedOverlay
          state={state}
          quota={geom.level.quota}
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
