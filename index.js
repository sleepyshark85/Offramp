import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

// Skia on native initialises itself. On web it does not: CanvasKit is a WASM
// module that must be fetched and instantiated BEFORE any module that touches
// the Skia API is evaluated. So `./Root` is imported dynamically, after the
// load resolves — a static import would pull Skia in at module-evaluation time
// and throw "Cannot read properties of undefined (reading 'PictureRecorder')".
//
// This matters beyond web being a shipping target, which it is not. Tier-3
// verification (docs/development-process.md §4) runs the real app under
// Playwright at an iPhone viewport, and that runs on web. No CanvasKit, no
// tier 3.
if (Platform.OS === 'web') {
  const { LoadSkiaWeb } = require('@shopify/react-native-skia/lib/module/web');
  LoadSkiaWeb({ locateFile: (file) => `/${file}` })
    .then(() => {
      registerRootComponent(require('./Root').default);
    })
    .catch((err) => {
      // Nothing can render without CanvasKit, so fail loudly rather than blank.
      // eslint-disable-next-line no-console
      console.error('[offramp] CanvasKit failed to load:', err);
    });
} else {
  registerRootComponent(require('./Root').default);
}
