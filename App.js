// Offramp — the app shell. Screen routing, session settings, and nothing else.
//
// The play screen is keyed on `level:epoch`. A retry bumps the epoch, which REMOUNTS it —
// so a restart runs every cleanup in useGame and builds a fresh state at tick 0, rather than
// threading a reset path through a live loop. Retry rebuilds the level from the same seed,
// so retrying is retrying the same level (gameplay.md §6.3).

import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PlayScreen from './src/ui/PlayScreen.js';
import { LevelSelectScreen, SettingsScreen, TitleScreen } from './src/ui/screens.js';
import { runOptionsFromLocation } from './src/ui/run.js';
import { C } from './src/ui/theme.js';

const DEFAULT_SETTINGS = {
  // ui.md §11.2 defaults. Reduce motion should follow AccessibilityInfo; wiring that to the
  // OS is slice 3's accessibility pass, and the setting is honoured everywhere today.
  symbolLarge: false,
  reduceMotion: false,
  haptics: true,
  sound: true,
};

export default function App() {
  // Read once: the query string cannot change without a reload.
  const [opts] = useState(runOptionsFromLocation);
  const [screen, setScreen] = useState(opts.autoplay ? 'play' : 'title');
  const [levelNumber, setLevelNumber] = useState(opts.level);
  const [epoch, setEpoch] = useState(0);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const play = useCallback((n) => {
    setLevelNumber(n);
    setEpoch((e) => e + 1);
    setScreen('play');
  }, []);

  const restart = useCallback(() => setEpoch((e) => e + 1), []);
  const next = useCallback(() => {
    setLevelNumber((n) => n + 1);
    setEpoch((e) => e + 1);
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        {/* ui.md §5.3: the game is a night road and app.json declares userInterfaceStyle dark. */}
        <StatusBar style="light" backgroundColor={C.bg} />
        <View style={styles.root}>
          {screen === 'title' ? (
            <TitleScreen
              onPlay={() => play(opts.level)}
              onLevels={() => setScreen('levels')}
              onSettings={() => setScreen('settings')}
            />
          ) : null}

          {screen === 'levels' ? (
            <LevelSelectScreen onPick={play} onBack={() => setScreen('title')} />
          ) : null}

          {screen === 'settings' ? (
            <SettingsScreen settings={settings} onChange={setSettings} onBack={() => setScreen('title')} />
          ) : null}

          {screen === 'play' ? (
            <PlayScreen
              key={levelNumber + ':' + epoch}
              runSeed={opts.runSeed}
              levelNumber={levelNumber}
              settings={settings}
              onQuit={() => setScreen('title')}
              onNext={next}
              onRestart={restart}
            />
          ) : null}
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
});
