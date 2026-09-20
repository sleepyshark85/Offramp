// Offramp — explicit state serialisation.
//
// `JSON.stringify(state)` does NOT round-trip. `state.open` is a Uint8Array, and
// `JSON.stringify` renders a typed array as an object keyed by index
// (`{"0":0,"1":1}`), which `JSON.parse` returns as a plain object with no `length`.
// The rehydrated state then has `open.length === 0`, every junction read returns
// `undefined`, and the first transition throws `TypeError: Cannot read properties of
// undefined`. It fails silently at the boundary and loudly one tick later, which is the
// worst possible ordering.
//
// Slice-4 persistence and the tier-3 `window.__offramp` snapshot slice 2 depends on both
// cross that boundary, so the conversion is written down once, here, with a round-trip test
// rather than left to a caller to remember.

/**
 * A JSON-safe plain object that is deeply equal to `state` in every field, with `open`
 * widened to a plain array. The level is included by default so the snapshot is
 * self-contained; pass `{ level: false }` to omit it when the consumer regenerates the
 * level from `(seed, band)` instead of storing it.
 */
export function serialiseState(state, opts = {}) {
  const out = {
    v: 1,
    tick: state.tick,
    phase: state.phase,
    rng: state.rng,
    cars: state.cars.map((c) => ({
      id: c.id,
      colour: c.colour,
      edgeId: c.edgeId,
      progress: c.progress,
    })),
    open: Array.from(state.open),
    nextSpawn: state.nextSpawn,
    delivered: state.delivered,
    misrouted: state.misrouted,
    lives: state.lives,
    score: state.score,
    streak: state.streak,
    bestStreak: state.bestStreak,
    events: state.events.map((e) => ({ ...e })),
  };
  if (opts.level !== false) {
    out.level = state.level;
    out.seed = state.level.seed;
    out.band = state.level.band;
  } else {
    out.seed = state.level.seed;
    out.band = state.level.band;
  }
  return out;
}

/**
 * The inverse. `level` is required when the payload was written with `{ level: false }`;
 * when given it overrides the embedded copy, so a caller that regenerates the level from
 * `(seed, band)` shares one object graph instead of two.
 */
export function deserialiseState(obj, level) {
  if (!obj || typeof obj !== 'object') throw new Error('BAD_SNAPSHOT: not an object');
  if (obj.v !== 1) throw new Error('BAD_SNAPSHOT: unknown version ' + obj.v);
  const lvl = level || obj.level;
  if (!lvl) throw new Error('BAD_SNAPSHOT: no level, and none supplied');
  if (!Array.isArray(obj.open)) throw new Error('BAD_SNAPSHOT: open is not an array');
  if (obj.open.length !== lvl.junctions.length) {
    throw new Error(
      'BAD_SNAPSHOT: open has ' + obj.open.length + ' entries, level has ' +
        lvl.junctions.length + ' junctions',
    );
  }
  return {
    tick: obj.tick,
    phase: obj.phase,
    level: lvl,
    rng: obj.rng,
    cars: obj.cars.map((c) => ({
      id: c.id,
      colour: c.colour,
      edgeId: c.edgeId,
      progress: c.progress,
    })),
    open: Uint8Array.from(obj.open),
    nextSpawn: obj.nextSpawn,
    delivered: obj.delivered,
    misrouted: obj.misrouted,
    lives: obj.lives,
    score: obj.score,
    streak: obj.streak,
    bestStreak: obj.bestStreak,
    events: obj.events.map((e) => ({ ...e })),
  };
}
