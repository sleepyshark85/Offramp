// Offramp — the HUD (ui.md §7.1).
//
// 56 pt tall, 16 pt side padding, sitting directly below the safe-area top inset. Three
// groups: level + delivered on the left, the CLOCK BAR in the centre, lives and pause on the
// right. It is React Native views rather than Skia, deliberately: it is chrome, it is
// specified in pt, it needs system-font text, and — not least — it is the part of the play
// screen a screen reader and Playwright can both actually see (ui.md §11.3).
//
// THE CLOCK IS DRAWN FROM `state.tick` AND FROM NOTHING ELSE (AC-520). No Date.now(), no
// setInterval, no wall-clock accumulator. A `setInterval` counting seconds drifts from the
// simulation on any device that drops frames — where world time runs slower than wall time by
// design (gameplay.md §2.1) — and would show 0:00 while cars were still moving. Being a pure
// function of the tick is also what makes a paused game show a frozen clock (AC-128) and a
// replay show the same clock the run did (AC-505).

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LEVEL_TICKS, LIVES, TICK_HZ } from '../engine/index.js';
import { HUD_H } from './layout.js';
import { C, MS, RADIUS, SPACE, TYPE } from './theme.js';
import { useCountUp, usePulse } from './useCountUp.js';

const BAR_W = 180;
const BAR_H = 8;
const PIP = 10;
/** ui.md §7.1 — the last ten seconds. 600 ticks at TICK_HZ = 60. */
export const FINAL_TEN_TICKS = 10 * TICK_HZ;

/**
 * `m:ss` remaining, or whole seconds only inside the final ten (ui.md §7.1, AC-520). The
 * minute figure is `floor((LEVEL_TICKS - tick) / 3600)`, which is AC-520's own expression, so
 * the seconds figure floors too and the two never disagree by a rounding convention.
 */
export function clockCaption(tick) {
  const left = Math.max(0, LEVEL_TICKS - tick);
  const secs = Math.floor(left / TICK_HZ);
  if (left <= FINAL_TEN_TICKS) return String(secs);
  return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
}

/** The bar's fill width in pt: `180 * (LEVEL_TICKS - tick) / LEVEL_TICKS`. It DRAINS. */
export function clockFillPt(tick) {
  return (BAR_W * Math.max(0, LEVEL_TICKS - tick)) / LEVEL_TICKS;
}

export default function HUD({ top, width, level, state, onPause, reduceMotion }) {
  // ui.md §9 — the delivered count increments over 180 ms. It is chrome outside the canvas, so
  // wall-clock easing is permitted here; the CLOCK is not, and is not eased.
  const delivered = Math.round(useCountUp(state.delivered, MS.deliveredCount, reduceMotion));
  // ui.md §8.5 — the last-life pulse.
  const pipOpacity = usePulse(state.lives === 1, MS.lastLifePulse, 0.65, 1, reduceMotion);

  const final10 = state.tick >= LEVEL_TICKS - FINAL_TEN_TICKS;
  const fill = clockFillPt(state.tick);

  return (
    <View style={[styles.hud, { top, width }]} testID="hud" pointerEvents="box-none">
      <View style={styles.left}>
        <Text style={styles.levelLabel} testID="hud-level">{'LEVEL ' + String(level.number).padStart(2, '0')}</Text>
        <Text style={styles.score} testID="hud-delivered">{String(delivered)}</Text>
      </View>

      <View style={styles.centre}>
        <View style={styles.barTrack}>
          <View
            style={[styles.barFill, { width: fill }, final10 ? styles.barFillFinal : null]}
            testID="hud-clock-fill"
          />
        </View>
        <Text
          style={[styles.caption, final10 ? styles.captionFinal : null]}
          testID="hud-clock"
        >
          {clockCaption(state.tick)}
        </Text>
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
  // ui.md §7.1 / AC-520 — inside the last ten seconds the bar and the caption turn --alert,
  // with no pulse and no motion. It is a state change, not decoration: a routing decision in
  // the last ten seconds is worth nothing for any car that cannot reach a depot in time, and
  // the minimum transit is 389 ticks, which is most of the board.
  barFillFinal: { backgroundColor: C.alert },
  caption: { ...TYPE.caption, color: C.textDim, marginTop: SPACE.xs },
  captionFinal: { color: C.alert },
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
