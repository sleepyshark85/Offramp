// Offramp — what an `AppState` change means, as pure functions (AC-803, AC-804).
//
// THIS MODULE HAS NO REACT IN IT, deliberately: the backgrounding rule is the one place where
// the game deviates between platforms, and a rule that can only be checked on a device is a
// rule nobody checks. `src/ui/useGame.js` owns the listener and the timers; this owns the
// decision, and `test/loop.test.js` drives it in bare Node.

export const MODE = { RUNNING: 'running', PAUSED: 'paused', COUNTDOWN: 'countdown' };

/**
 * What an `AppState` change means, as a pure function, so that both halves of it can be
 * tested without a browser and without a device (AC-803, AC-804).
 *
 * ON A DEVICE THIS IS STRICT, and the reason is the rule itself: a phone call is not 400 ticks
 * (CLAUDE.md, gameplay.md §6.2). `AppState` leaving 'active' on iOS or Android means the app is
 * genuinely suspended — the frame callback stops being serviced, and whatever wall time passes
 * must not become simulation time. The accumulator is zeroed, the game pauses, and resuming
 * costs a 3-2-1 countdown that advances no ticks.
 *
 * ON WEB IT IS LENIENT, AND WEB ONLY. `react-native-web` maps `AppState` onto the document's
 * `visibilitychange`, which fires for things a phone call is not: switching browser tabs, a
 * window losing focus, an OS notification, a devtools undock. The owner's first play session
 * was interrupted by exactly that. Web is a development harness and a tier-3 target, not a
 * shipping platform (development-process.md §4), so there the handler zeroes the accumulator —
 * which is the part that protects the simulation, and which is NOT relaxed — and leaves the
 * game running rather than forcing a pause and a countdown.
 *
 * The accumulator reset is not the whole protection on web either, and it does not need to be:
 * a hidden tab does not service `requestAnimationFrame`, so the first frame after it returns
 * carries a delta of seconds, which `advanceClock` clamps to MAX_CATCHUP_TICKS = 8 and then
 * discards the rest of (AC-127). Eight ticks is 133 ms of world time for any length of absence.
 *
 * The two halves are one branch and the NATIVE PATH IS THE DEFAULT: a future platform lands in
 * the strict branch unless someone deliberately adds it to the lenient one.
 */
export function backgroundAction(platformOS, nextAppState, wasBackgrounded) {
  const lenient = platformOS === 'web';
  if (nextAppState !== 'active') {
    if (lenient) return { resetClock: true };
    return { resetClock: true, markBackgrounded: true, mode: MODE.PAUSED };
  }
  if (!wasBackgrounded) return { resetClock: false };
  return { resetClock: true, markBackgrounded: false, mode: MODE.COUNTDOWN };
}
