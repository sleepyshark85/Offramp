// Toolchain smoke test — replaced in slice 2 by the real app shell.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Canvas, Circle } from '@shopify/react-native-skia';

export default function App() {
  return (
    <View style={styles.root}>
      <Canvas style={styles.canvas}>
        <Circle cx={80} cy={80} r={40} color="#4DA3FF" />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#10151C' },
  canvas: { flex: 1 },
});
