import React from 'react';

import App from './App';
import { runOptionsFromLocation } from './src/ui/run.js';

// React 19 StrictMode, on deliberately: it double-invokes reducers, effects and
// lazy initialisers in development. If a tick ever double-resolves, this makes
// it fail loudly here rather than quietly on a player's phone.
//
// AC-812 asks for a comparison — "the simulation advances the same number of
// ticks per second as it does with StrictMode off" — and a comparison needs
// both arms. `?strict=0` is that second arm, on web only, for the E2E suite.
// There is no way to reach it from the app and no device build has a query
// string, so StrictMode is unconditionally on everywhere a player runs.
export default function Root() {
  const { strict } = runOptionsFromLocation();
  if (!strict) return <App />;
  return (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
