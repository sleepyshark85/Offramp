import React from 'react';

import App from './App';

// React 19 StrictMode, on deliberately: it double-invokes reducers, effects and
// lazy initialisers in development. If a tick ever double-resolves, this makes
// it fail loudly here rather than quietly on a player's phone.
export default function Root() {
  return (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
