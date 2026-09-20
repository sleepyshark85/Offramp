// Offramp — seeded PRNG (gameplay.md §2.7).
//
// 32-bit integer operations only, via Math.imul and >>> 0. No floats and no ambient
// randomness: every draw comes from a seed carried in the caller.

/** Seed mixer. Pure, uint32 in / uint32 out. */
export function mix32(x, salt) {
  let v = (x ^ salt) >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x21f0aaad) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x735a2d97) >>> 0;
  return (v ^ (v >>> 15)) >>> 0;
}

/**
 * mulberry32 advance. Takes the current state, returns [nextState, uint32 output].
 * Kept as a pure state transition so a stream's position can live inside game state
 * (state.rng) and survive serialisation.
 */
export function mulberry32(s) {
  const next = (s + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
  return [next, (t ^ (t >>> 14)) >>> 0];
}

/** A mutable cursor over one PRNG stream. Used by the generator and the spawn scheduler. */
export function makeStream(seed) {
  let s = seed >>> 0;
  const stream = {
    /** Raw uint32 draw. */
    next() {
      const [ns, out] = mulberry32(s);
      s = ns;
      return out;
    },
    /** Uniform-ish integer in [0, n). Modulo, not rejection: a variable draw count is a
     *  determinism hazard and the bias is 1 part in 2^32/n (gameplay.md §2.7). */
    nextInt(n) {
      return stream.next() % n;
    },
    get state() {
      return s;
    },
  };
  return stream;
}

/** Fisher-Yates, descending, using nextInt. Shuffles in place and returns the array. */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Uniform choice from a non-empty array. */
export function choose(rng, arr) {
  return arr[rng.nextInt(arr.length)];
}
