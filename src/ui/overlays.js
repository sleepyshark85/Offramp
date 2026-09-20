// Offramp — the overlay screens (ui.md §2 S4, S5, S6, S8; §8.6, §8.7, §8.8).
//
// React Native views, not Skia: they are chrome, they are specified in pt, and ui.md §11.3
// requires every menu, overlay and settings control to be labelled and operable with
// VoiceOver and TalkBack — which a canvas cannot be.

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SCORE_LIFE_BONUS } from '../engine/index.js';
import { easeOutBack } from '../render/motion.js';
import { C, MS, RADIUS, SPACE, TYPE } from './theme.js';

/**
 * ui.md §8.6 — the panel rises 24 pt and fades in over 280 ms, `ease-out-back(1.08)`.
 * Reduce motion replaces the spring with a 120 ms fade (ui.md §11.2), so the hook still
 * returns a progress value and the panel still arrives; only the overshoot goes.
 */
function useRise(reduceMotion) {
  const [t, setT] = useState(reduceMotion ? 1 : 0);
  const duration = reduceMotion ? 120 : MS.panelRise;
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return undefined;
    startedRef.current = true;
    let cancelled = false;
    let raf = 0;
    let t0 = -1;
    const frame = (now) => {
      if (cancelled) return;
      if (t0 < 0) t0 = now;
      const p = Math.min(1, (now - t0) / duration);
      setT(p);
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [duration]);

  return reduceMotion ? { opacity: t, translateY: 0 } : { opacity: t, translateY: 24 * (1 - easeOutBack(t)) };
}

function Button({ label, onPress, testID, primary, grow }) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.button, grow ? styles.buttonGrow : null, primary ? styles.buttonPrimary : null]}
    >
      <Text style={[styles.buttonLabel, primary ? styles.buttonLabelPrimary : null]}>{label}</Text>
    </Pressable>
  );
}

function Panel({ title, testID, reduceMotion, children }) {
  const rise = useRise(reduceMotion);
  return (
    <View style={styles.scrim} testID={testID}>
      <View style={[styles.panel, { opacity: rise.opacity, transform: [{ translateY: rise.translateY }] }]}>
        <Text style={styles.title} testID={testID + '-title'}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

function Row({ label, value, note, testID }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        {note ? <Text style={styles.rowNote}>{note}</Text> : null}
        <Text style={styles.rowValue} testID={testID}>{value}</Text>
      </View>
    </View>
  );
}

/** S4 — ui.md §8.8. */
export function PauseOverlay({ onResume, onRestart, onQuit, reduceMotion }) {
  return (
    <Panel title="PAUSED" testID="overlay-pause" reduceMotion={reduceMotion}>
      <View style={styles.stack}>
        <Button label="RESUME" onPress={onResume} testID="btn-resume" primary />
        <Button label="RESTART" onPress={onRestart} testID="btn-restart" />
        <Button label="QUIT" onPress={onQuit} testID="btn-quit" />
      </View>
    </Panel>
  );
}

/** S5 — ui.md §8.6. */
export function CompleteOverlay({ levelNumber, state, quota, onRetry, onNext, reduceMotion }) {
  return (
    <Panel
      title={'LEVEL ' + String(levelNumber).padStart(2, '0') + ' CLEAR'}
      testID="overlay-complete"
      reduceMotion={reduceMotion}
    >
      <View style={styles.rule} />
      <Row label="Delivered" value={state.delivered + '/' + quota} testID="complete-delivered" />
      <Row label="Best streak" value={String(state.bestStreak)} testID="complete-streak" />
      <Row
        label="Lives remaining"
        value={'+' + state.lives * SCORE_LIFE_BONUS}
        note={state.lives + '   ×' + SCORE_LIFE_BONUS}
        testID="complete-lives"
      />
      <View style={styles.rule} />
      <View style={styles.row}>
        <Text style={styles.rowLabel}>SCORE</Text>
        <Text style={styles.display} testID="complete-score">{state.score.toLocaleString('en-US')}</Text>
      </View>
      {/* `Best` is a stored value and storage is slice 4 (gameplay.md §7); the row is kept so
          the layout is not invented later, and reads as unknown rather than as zero. */}
      <Row label="Best" value="—" testID="complete-best" />
      <View style={styles.buttons}>
        <Button label="RETRY" onPress={onRetry} testID="btn-retry" grow />
        <Button label="NEXT ▸" onPress={onNext} testID="btn-next" primary grow />
      </View>
    </Panel>
  );
}

/** S6 — ui.md §8.7. */
export function FailedOverlay({ state, quota, onRetry, onLevels, reduceMotion }) {
  return (
    <Panel title="OUT OF LIVES" testID="overlay-failed" reduceMotion={reduceMotion}>
      <View style={styles.rule} />
      <Row label="Delivered" value={state.delivered + '/' + quota} testID="failed-delivered" />
      <Row label="Score" value={state.score.toLocaleString('en-US')} testID="failed-score" />
      <View style={styles.buttons}>
        <Button label="RETRY" onPress={onRetry} testID="btn-retry" primary grow />
        <Button label="LEVELS" onPress={onLevels} testID="btn-levels" grow />
      </View>
    </Panel>
  );
}

/**
 * S8 — ui.md §8.8. Three 600 ms beats, numeral at Display size, scaling 1.3 -> 1.0 and
 * fading out each beat. No simulation ticks advance during it (AC-804); the countdown value
 * itself is owned by useGame, which is where the interval and its cleanup live.
 */
export function CountdownOverlay({ n, reduceMotion }) {
  const [beat, setBeat] = useState(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) {
      setBeat(1);
      return undefined;
    }
    let cancelled = false;
    let raf = 0;
    let t0 = -1;
    const frame = (now) => {
      if (cancelled) return;
      if (t0 < 0) t0 = now;
      const p = Math.min(1, (now - t0) / MS.countdownBeat);
      setBeat(p);
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [n, reduceMotion]);

  return (
    <View style={styles.scrim} testID="overlay-countdown" pointerEvents="none">
      <Text
        testID="countdown-numeral"
        style={[styles.countdown, { opacity: 1 - beat * 0.9, transform: [{ scale: 1.3 - 0.3 * beat }] }]}
      >
        {String(n)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  panel: {
    width: '100%',
    maxWidth: 340,
    marginHorizontal: SPACE.lg,
    padding: SPACE.xl,
    borderRadius: RADIUS.panel,
    backgroundColor: C.surface,
  },
  title: { ...TYPE.title, color: C.text, textAlign: 'center' },
  rule: { height: 1, backgroundColor: C.surfaceRaised, marginVertical: SPACE.lg },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: SPACE.xs },
  rowRight: { flexDirection: 'row', alignItems: 'center' },
  rowLabel: { ...TYPE.body, color: C.textDim },
  rowValue: { ...TYPE.body, color: C.text, fontVariant: ['tabular-nums'] },
  rowNote: { ...TYPE.caption, color: C.textMute, marginRight: SPACE.md },
  display: { ...TYPE.display, color: C.text, fontVariant: ['tabular-nums'] },
  stack: { marginTop: SPACE.lg, gap: SPACE.md },
  buttons: { flexDirection: 'row', marginTop: SPACE.lg, gap: SPACE.md },
  button: {
    height: 48,
    alignSelf: 'stretch',
    borderRadius: RADIUS.button,
    backgroundColor: C.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGrow: { flex: 1 },
  buttonPrimary: { backgroundColor: C.text },
  buttonLabel: { ...TYPE.button, color: C.text },
  buttonLabelPrimary: { color: C.bg },
  countdown: { ...TYPE.display, color: C.text },
});
