// Offramp — which level a run is on (gameplay.md §7).
//
// Level N's seed is `mix32(RUN_SEED ^ imul(N, 0x9E3779B1), GEN_SALT)`, which the engine
// already implements as `levelSeed`. RUN_SEED is a per-install constant; persisting it is
// slice 4, so slice 2 carries a fixed one and every install currently plays the same ladder.
// That is a deliberate stub, not an oversight: it makes a screenshot of level 3 the same
// picture on every machine, which is what tier 3 needs.

import { bandForLevel, generateLevel, levelSeed } from '../engine/index.js';

export const DEFAULT_RUN_SEED = 0x0ff2a4b1;

/** Build level `n` of the ladder rooted at `runSeed`. Pure. */
export function buildLevel(runSeed, n) {
  return generateLevel(levelSeed(runSeed, n), bandForLevel(n));
}

/**
 * Tier 3 drives the real app at an iPhone viewport and has to be able to name the level and
 * the ladder it is asserting against. On web only, `?level=` and `?seed=` select them; on a
 * device there is no query string and the defaults stand.
 */
export function runOptionsFromLocation() {
  const out = { runSeed: DEFAULT_RUN_SEED, level: 1, strict: true, autoplay: false };
  if (typeof globalThis === 'undefined' || !globalThis.location || !globalThis.location.search) {
    return out;
  }
  const q = new URLSearchParams(globalThis.location.search);
  // `Number(null)` is 0, and `Number.isInteger(0)` is true — so reading an ABSENT parameter
  // through Number() silently sets the run seed to 0 and the whole ladder changes. The
  // tier-3 suite caught this by regenerating level 1 in Node and finding the browser had
  // built a different network. Presence is checked before value, everywhere.
  if (q.has('level')) {
    const level = Number(q.get('level'));
    if (Number.isInteger(level) && level >= 1) out.level = level;
  }
  if (q.has('seed')) {
    const seed = Number(q.get('seed'));
    if (Number.isInteger(seed)) out.runSeed = seed >>> 0;
  }
  if (q.get('strict') === '0') out.strict = false;
  if (q.get('autoplay') === '1') out.autoplay = true;
  return out;
}
