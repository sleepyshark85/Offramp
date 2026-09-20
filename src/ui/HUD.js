// Offramp — the HUD (ui.md §7.1).
//
// 56 pt tall, 16 pt side padding, sitting directly below the safe-area top inset. Three
// groups: level + score on the left, the quota bar in the centre, lives and pause on the
// right. It is React Native views rather than Skia, deliberately: it is chrome, it is
// specified in pt, it needs system-font text, and — not least — it is the part of the play
// screen a screen reader and Playwright can both actually see (ui.md §11.3).

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LIVES } from '../engine/index.js';
import { HUD_H } from './layout.js';
import { C, MS, RADIUS, SPACE, TYPE } from './theme.js';
import { useCountUp, usePulse } from './useCountUp.js';

const BAR_W = 180;
const BAR_H = 8;
const PIP = 10;

export default function HUD({ top, width, level, state, onPause, reduceMotion }) {
  const score = Math.round(useCountUp(state.score, MS.scoreCount, reduceMotion));
  const filled = useCountUp(
    Math.min(1, state.delivered / level.quota),
    MS.quotaFill,
    reduceMotion,
  );
  // ui.md §8.5 — the last-life pulse.
  const pipOpacity = usePulse(state.lives === 1, MS.lastLifePulse, 0.65, 1, reduceMotion);

  return (
    <View style={[styles.hud, { top, width }]} testID="hud" pointerEvents="box-none">
      <View style={styles.left}>
        <Text style={styles.levelLabel} testID="hud-level">{'LEVEL ' + String(level.number).padStart(2, '0')}</Text>
        <Text style={styles.score} testID="hud-score">{score.toLocaleString('en-US')}</Text>
      </View>

      <View style={styles.centre}>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: BAR_W * Math.max(0, Math.min(1, filled)) }]} testID="hud-quota-fill" />
        </View>
        <Text style={styles.caption} testID="hud-quota">{state.delivered + ' / ' + level.quota}</Text>
      </View>

      <View style={styles.right}>
        <View style={[styles.pips, { opacity: pipOpacity }]} testID="hud-lives">
          {Array.from({ length: LIVES }, (_, i) => (
            <View
              key={i}
              testID={'hud-pip-' + i}
              style={[styles.pip, i < state.lives ? styles.pipHeld : styles.pipLost]}
            />
          ))}
        </View>
        <Pressable
          onPress={onPause}
          style={styles.pause}
          testID="pause-button"
          accessibilityRole="button"
          accessibilityLabel="Pause"
        >
          <View style={styles.pauseBar} />
          <View style={styles.pauseBar} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hud: {
    position: 'absolute',
    left: 0,
    height: HUD_H,
    paddingHorizontal: SPACE.lg,
    flexDirection: 'row',
    alignItems: 'center',
  },
  left: { flex: 1, justifyContent: 'center' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  right: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  levelLabel: { ...TYPE.label, color: C.textDim },
  score: { ...TYPE.hudNumeric, color: C.text, fontVariant: ['tabular-nums'] },
  barTrack: {
    width: BAR_W,
    height: BAR_H,
    borderRadius: RADIUS.bar,
    backgroundColor: C.surfaceRaised,
    overflow: 'hidden',
  },
  barFill: { height: BAR_H, borderRadius: RADIUS.bar, backgroundColor: C.text },
  caption: { ...TYPE.caption, color: C.textDim, marginTop: SPACE.xs },
  pips: { flexDirection: 'row', alignItems: 'center', marginRight: SPACE.sm },
  pip: { width: PIP, height: PIP, borderRadius: PIP / 2, marginLeft: SPACE.sm },
  pipHeld: { backgroundColor: C.text },
  pipLost: { borderWidth: 1, borderColor: C.textMute },
  pause: {
    width: 44,
    height: 44,
    marginRight: -SPACE.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  pauseBar: { width: 5, height: 16, marginHorizontal: 2, backgroundColor: C.textDim, borderRadius: 1 },
});
