// Offramp — S1 Title, S2 Level select, S7 Settings.
//
// ui.md §2: "S1, S2 and S7 can be stubs until slice 4, but their layout is specified here so
// they are not invented later." These are that — the specified layout, real controls, and no
// persistence: there is no store yet, so the level grid is the ladder rather than an unlock
// record and Settings live in memory for the session (gameplay.md §7 is slice 4).
//
// Settings is NOT decorative here. Symbol size drives GLYPH_CAR 48 -> 66 and GLYPH_DEPOT
// 64 -> 88 in the renderer (AC-604) and Reduce motion drives ui.md §11.2 throughout, so both
// are exercised in slice 2 rather than waiting for a slice that would find them broken.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, RADIUS, SPACE, TYPE } from './theme.js';

const VISIBLE_LEVELS = 24;

function Btn({ label, onPress, testID, primary, wide }) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.btn, wide ? styles.btnWide : null, primary ? styles.btnPrimary : null]}
    >
      <Text style={[styles.btnLabel, primary ? styles.btnLabelPrimary : null]}>{label}</Text>
    </Pressable>
  );
}

/** S1 — Title. */
export function TitleScreen({ onPlay, onLevels, onSettings }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="screen-title">
      <View style={styles.centre}>
        <Text style={styles.wordmark} testID="title-wordmark">OFFRAMP</Text>
        <Text style={styles.tagline}>Get every car to its colour.</Text>
        <View style={styles.stack}>
          <Btn label="PLAY" onPress={onPlay} testID="btn-play" primary wide />
          <Btn label="LEVELS" onPress={onLevels} testID="btn-levels-menu" wide />
          <Btn label="SETTINGS" onPress={onSettings} testID="btn-settings" wide />
        </View>
      </View>
    </View>
  );
}

/** S2 — Level select. A grid of levels; best scores arrive with persistence in slice 4. */
export function LevelSelectScreen({ onPick, onBack }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="screen-levels">
      <Text style={styles.screenTitle}>LEVELS</Text>
      <ScrollView contentContainerStyle={styles.grid}>
        {Array.from({ length: VISIBLE_LEVELS }, (_, i) => i + 1).map((n) => (
          <Pressable
            key={n}
            onPress={() => onPick(n)}
            testID={'level-tile-' + n}
            accessibilityRole="button"
            accessibilityLabel={'Level ' + n}
            style={styles.tile}
          >
            <Text style={styles.tileNumber}>{n}</Text>
            <Text style={styles.tileBest}>—</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Btn label="BACK" onPress={onBack} testID="btn-back" wide />
      </View>
    </View>
  );
}

/** S7 — Settings (ui.md §11.2). */
export function SettingsScreen({ settings, onChange, onBack }) {
  const insets = useSafeAreaInsets();
  const toggle = (key) => onChange({ ...settings, [key]: !settings[key] });
  const rows = [
    { key: 'symbolLarge', label: 'Symbol size', on: 'Large', off: 'Standard' },
    { key: 'reduceMotion', label: 'Reduce motion', on: 'On', off: 'Off' },
    { key: 'haptics', label: 'Haptics', on: 'On', off: 'Off' },
    { key: 'sound', label: 'Sound', on: 'On', off: 'Off' },
  ];
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="screen-settings">
      <Text style={styles.screenTitle}>SETTINGS</Text>
      <View style={styles.settings}>
        {rows.map((r) => (
          <Pressable
            key={r.key}
            onPress={() => toggle(r.key)}
            testID={'setting-' + r.key}
            accessibilityRole="switch"
            accessibilityLabel={r.label}
            accessibilityState={{ checked: !!settings[r.key] }}
            style={styles.settingRow}
          >
            <Text style={styles.settingLabel}>{r.label}</Text>
            <Text style={styles.settingValue} testID={'setting-' + r.key + '-value'}>
              {settings[r.key] ? r.on : r.off}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.footer}>
        <Btn label="BACK" onPress={onBack} testID="btn-back" wide />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingHorizontal: SPACE.lg },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  wordmark: { ...TYPE.display, color: C.text, letterSpacing: 4 },
  tagline: { ...TYPE.body, color: C.textDim, marginTop: SPACE.sm },
  stack: { marginTop: SPACE.xxxl, alignSelf: 'stretch', gap: SPACE.md, maxWidth: 340 },
  screenTitle: { ...TYPE.title, color: C.text, marginTop: SPACE.xl, marginBottom: SPACE.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md, paddingBottom: SPACE.lg },
  tile: {
    width: 72,
    height: 72,
    borderRadius: RADIUS.button,
    backgroundColor: C.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileNumber: { ...TYPE.hudNumeric, color: C.text },
  tileBest: { ...TYPE.caption, color: C.textMute },
  settings: { marginTop: SPACE.sm },
  settingRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACE.md,
  },
  settingLabel: { ...TYPE.body, color: C.text },
  settingValue: { ...TYPE.body, color: C.textDim },
  footer: { paddingVertical: SPACE.lg },
  btn: {
    height: 48,
    minWidth: 44,
    paddingHorizontal: SPACE.xl,
    borderRadius: RADIUS.button,
    backgroundColor: C.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnWide: { alignSelf: 'stretch' },
  btnPrimary: { backgroundColor: C.text },
  btnLabel: { ...TYPE.button, color: C.text },
  btnLabelPrimary: { color: C.bg },
});
