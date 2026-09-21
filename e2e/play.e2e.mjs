// Offramp — tier 3. Playwright against the Expo web build at an iPhone viewport.
//
//   npm run test:e2e
//
// READ THIS BEFORE TRUSTING A GREEN RUN. Every assertion below against `window.__offramp`
// proves that input reached the simulation and that the simulation reached the renderer's
// geometry. **A state assertion does not prove the paint.** A canvas has no elements; if
// PlaySurface returned an empty Group, most of this file would still pass. That is why every
// test that matters also writes a screenshot to .e2e-shots/, and why tier 5 — the owner, on a
// real iPhone — is still the only tier that proves iOS.
//
// The autopilot in `play a level` is a real player: it reads the published state, decides
// which junction is set wrong for the car nearest to it, and CLICKS IT with a real pointer
// event. If routing, hit testing, the tick loop or the state layer were broken, it could not
// deliver a car.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CATCHUP_TICKS, reachableColourMasks } from '../src/engine/index.js';
import { DEFAULT_RUN_SEED, buildLevel } from '../src/ui/run.js';
import { openApp, shot, snap, snapWithHud, startPlaying, waitFor } from './harness.mjs';

const LEVEL = 1;

// --- the autopilot ------------------------------------------------------------------------

/** The first branch node a car will reach, and the LU it has to travel to get there. */
function nextBranch(level, car) {
  let nodeId = level.edges[car.edgeId].to;
  let lu = level.edges[car.edgeId].lengthMlu / 1000 - car.progress / 1000;
  for (let guard = 0; guard < 16; guard += 1) {
    const n = level.nodes[nodeId];
    if (n.kind === 'depot') return null;
    if (n.kind === 'branch') return { node: n, lu };
    const e = level.edges[n.out[0]];
    lu += e.lengthMlu / 1000;
    nodeId = e.to;
  }
  return null;
}

/** Which branch index leads to a depot of this colour, or -1 when it makes no difference. */
function requiredOpen(level, masks, node, colour) {
  const bit = 1 << colour;
  const a = (masks[level.edges[node.out[0]].to] & bit) !== 0;
  const b = (masks[level.edges[node.out[1]].to] & bit) !== 0;
  if (a && !b) return 0;
  if (b && !a) return 1;
  return -1;
}

/**
 * The junction most urgently set wrong, and what it should be.
 *
 * A junction belongs to THE CAR THAT WILL REACH IT FIRST, which is the same rule the engine
 * uses (gameplay.md §3.1). Without that, two cars wanting opposite settings on one junction
 * make the autopilot flip it back and forth every poll and neither car gets what it needs —
 * which is what the first run of this file did, at 31 taps for one delivery.
 */
function decide(level, masks, state) {
  const cands = [];
  for (const car of state.cars) {
    const nb = nextBranch(level, car);
    if (nb) cands.push({ j: nb.node.junctionId, node: nb.node, lu: nb.lu, colour: car.colour });
  }
  cands.sort((a, b) => a.lu - b.lu);
  const owned = new Set();
  for (const c of cands) {
    if (owned.has(c.j)) continue;
    const want = requiredOpen(level, masks, c.node, c.colour);
    if (want < 0) continue; // indifferent: leave the junction to a later car
    owned.add(c.j);
    if (state.open[c.j] !== want) return { junctionId: c.j, want };
  }
  return null;
}

function junctionScreen(s, junctionId) {
  const j = s.level.junctions.find((x) => x.junctionId === junctionId);
  return { x: s.layout.originX + j.x * s.layout.scale, y: s.layout.originY + j.y * s.layout.scale };
}

// --- the suite ------------------------------------------------------------------------------

test('tier 3 · the game boots, plays, takes input, pauses, resumes and ends', async (t) => {
  const app = await openApp('?level=' + LEVEL);
  const level = buildLevel(DEFAULT_RUN_SEED, LEVEL);
  const masks = reachableColourMasks(level);

  try {
    await t.test('S1 · the title screen renders and PLAY starts a level', async () => {
      const first = await startPlaying(app.page);
      assert.equal(first.screen, 'play');
      assert.equal(first.level.number, LEVEL);
      assert.equal(first.state.phase, 'running');
      await shot(app.page, '01-play-start');
    });

    await t.test('the web bundle generates the SAME level as bare Node', async () => {
      // Determinism across the bundler, the browser's JS engine and this process. If a float
      // had crept into the generator, or a key-order dependency into the graph build, the
      // junction positions would differ here and nowhere else.
      const s = await snap(app.page);
      assert.equal(s.level.seed, level.seed);
      assert.equal(s.level.band, level.band);
      assert.equal(s.level.C, level.C);
      assert.equal(s.level.colW, level.colW);
      assert.equal(s.level.rowH, level.rowH);
      assert.deepEqual(
        s.level.junctions.map((j) => [j.junctionId, j.x, j.y]),
        level.junctions.map((nodeId, junctionId) => [junctionId, level.nodes[nodeId].x, level.nodes[nodeId].y]),
      );
      assert.ok(s.level.junctions.length > 0, 'the level has junctions to tap');
    });

    await t.test('AC-408 / AC-403 · the layout is ui.md §3.2 arithmetic at this viewport', async () => {
      const s = await snap(app.page);
      assert.equal(s.layout.screenW, 393);
      assert.equal(s.layout.screenH, 852);
      // Web has no env(safe-area-inset-*), so the insets are 0 and playH is taller than the
      // 695 pt of the real iPhone 15. `scale` is width-bound and therefore identical.
      assert.equal(s.layout.playTop, s.layout.insetTop + 56);
      assert.equal(s.layout.playH, 852 - 0 - 8 - 56);
      assert.equal(s.layout.scale, 0.393);
      assert.equal(s.layout.originX, (393 - 1000 * 0.393) / 2);
      assert.equal(s.layout.supported, true);
    });

    await t.test('AC-812 · exactly one animation-frame loop exists under StrictMode', async () => {
      const s = await snap(app.page);
      assert.equal(s.loops, 1, 'StrictMode double-mounting left ' + s.loops + ' live loops');
    });

    await t.test('the simulation advances, and a car appears and moves', async () => {
      const a = await waitFor(app.page, (s) => s.cars.length > 0, { label: 'the first car', timeout: 30000 });
      const car = a.cars[0];
      assert.ok(car.screen.x > 0 && car.screen.x < 393, 'car is on screen horizontally');
      assert.ok(car.screen.y > a.layout.playTop, 'car is below the HUD');
      // AC-517: a car exists at full strength on the frame it spawns. The snapshot cannot see
      // opacity, so what is asserted here is that the car is PRESENT on the first frame it
      // exists; the absence of a fade is asserted from the source in test/render-geometry.js
      // and is visible in the screenshot.
      const b = await waitFor(app.page, (s) => s.cars.length > 0 && s.cars[0].lu.y > car.lu.y + 20, {
        label: 'the car to move down the road',
      });
      assert.ok(b.state.tick > a.state.tick);
      await shot(app.page, '02-car-rolling');
    });

    await t.test('AC-304 · a tap on empty road changes nothing', async () => {
      const before = await snap(app.page);
      // The top-left of the play area is background, well outside every hit circle.
      await app.page.mouse.click(8, before.layout.playTop + 8);
      await app.page.waitForTimeout(150);
      const after = await snap(app.page);
      assert.deepEqual(after.state.open, before.state.open, 'a miss flipped something');
      assert.ok(
        !after.events.some((e) => e.type === 'flip' && e.tick >= before.state.tick),
        'a miss emitted a flip event',
      );
    });

    await t.test('AC-305 / AC-310 · a tap on a junction flips it, stamped to a real tick', async () => {
      const before = await snap(app.page);
      const target = 0;
      const p = junctionScreen(before, target);
      await app.page.mouse.click(p.x, p.y);
      const after = await waitFor(app.page, (s) => s.state.open[target] !== before.state.open[target], {
        label: 'the junction to flip',
        timeout: 5000,
      });
      const flip = after.events.filter((e) => e.type === 'flip' && e.junctionId === target).pop();
      assert.ok(flip, 'no flip event was published');
      assert.ok(flip.tick >= before.state.tick, 'the flip is stamped to a tick at or after the tap');
      assert.ok(flip.tick <= after.state.tick);
      await shot(app.page, '03-junction-flipped');
      // Put it back, so the autopilot below starts from the default board.
      await app.page.mouse.click(p.x, p.y);
      await waitFor(app.page, (s) => s.state.open[target] === before.state.open[target], {
        label: 'the junction to flip back',
        timeout: 5000,
      });
    });

    await t.test('AC-128 / AC-307 · pause freezes the tick and discards taps', async () => {
      await app.page.getByTestId('pause-button').click();
      const paused = await waitFor(app.page, (s) => s.mode === 'paused', { label: 'the pause overlay' });
      await app.page.getByTestId('overlay-pause').waitFor();
      await shot(app.page, '04-paused');
      const tickAtPause = paused.state.tick;
      const openAtPause = paused.state.open.slice();
      await app.page.waitForTimeout(1500);
      const still = await snap(app.page);
      assert.equal(still.state.tick, tickAtPause, 'the simulation advanced while paused');
      assert.equal(still.frames, paused.frames, 'the animation-frame loop is still running while paused');
      // A tap on a junction, while paused, must not be enqueued.
      //
      // THE JUNCTION HAS TO BE ONE THE PAUSE PANEL IS NOT COVERING. The panel is a centred
      // 340 pt card with RESUME / RESTART / QUIT in it, and under round 8's geometry junction 0
      // sits underneath it — so clicking there hit RESTART and the test failed with the tick
      // back at 10. That was the harness clicking a button, not a tap reaching the canvas, and
      // it proved nothing about AC-307 either way.
      const panel = await app.page.getByTestId('overlay-pause').locator('> *').first().boundingBox();
      const outside = still.level.junctions
        .map((j) => ({ j, p: junctionScreen(still, j.junctionId) }))
        .find(({ p: q }) => q.x < panel.x - 8 || q.x > panel.x + panel.width + 8
          || q.y < panel.y - 8 || q.y > panel.y + panel.height + 8);
      assert.ok(outside, 'every junction is under the pause panel, so AC-307 cannot be tested here');
      const p = outside.p;
      await app.page.mouse.click(p.x, p.y);
      await app.page.waitForTimeout(200);
      const after = await snap(app.page);
      assert.deepEqual(after.state.open, openAtPause, 'a tap landed while paused');
      assert.equal(after.state.tick, tickAtPause);

      await app.page.getByTestId('btn-resume').click();
      const resumed = await waitFor(app.page, (s) => s.mode === 'running' && s.state.tick > tickAtPause, {
        label: 'play to resume',
      });
      assert.ok(resumed.state.tick > tickAtPause);
    });

    await t.test('AC-803 · a visibilitychange does NOT pause the web build, and costs no ticks', async () => {
      // THIS TEST INVERTED IN ROUND 8, AND THE INVERSION IS THE FINDING IT NOW GUARDS.
      //
      // It used to assert that a `visibilitychange` pauses the game and resumes on a 3-2-1
      // countdown (AC-803, AC-804). That behaviour is CORRECT ON A PHONE — `AppState` leaving
      // 'active' there means the app is genuinely suspended and a phone call must not become
      // 400 ticks — and it is WRONG ON WEB, where `react-native-web` maps `AppState` onto
      // `visibilitychange`, which fires for switching tabs, losing window focus, an OS
      // notification or undocking devtools. The owner's first play session was interrupted by
      // exactly that.
      //
      // Tier 3 runs on web, so tier 3 asserts the web behaviour: no pause, no countdown, and
      // the simulation keeps running. The DEVICE behaviour is unchanged and is asserted in
      // test/loop.test.js against `backgroundAction('ios', …)` — the rule was extracted into a
      // pure function precisely so that the half this tier cannot see is still checked
      // somewhere.
      //
      // ONE THING IS LOST AND IT IS RECORDED RATHER THAN PAPERED OVER: the 3-2-1 resume
      // countdown (AC-804) is armed only by the background path, and the background path no
      // longer fires on web. `CountdownOverlay` is therefore NOT reachable at tier 3 any more.
      // It is live on a device, it is unchanged, and it becomes a tier-5 obligation. The pause
      // path below covers everything else the overlay path used to: the pause itself, AC-128's
      // frozen clock, and the resume not paying back the time.
      const running = await waitFor(app.page, (s) => s.mode === 'running', { label: 'a running game' });
      const tickAtBackground = await app.page.evaluate(() => {
        const t = window.__offramp.state.tick;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        return t;
      });
      assert.ok(tickAtBackground >= running.state.tick);
      await app.page.waitForTimeout(600);
      const after = await snap(app.page);
      assert.equal(after.mode, 'running', 'a visibilitychange paused the web build');
      assert.equal(after.state.phase, 'running');
      await app.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await app.page.waitForTimeout(300);
      const back = await snap(app.page);
      assert.equal(back.mode, 'running', 'returning to the tab ran a countdown');
      // The half of AC-803 that is NOT relaxed: the handler zeroes the tick accumulator, and
      // the catch-up clamp bounds anything it misses. Over the ~900 ms of this test the
      // simulation may not have advanced by more than that wall time allows.
      const advanced = back.state.tick - tickAtBackground;
      assert.ok(advanced >= 0 && advanced < 120,
        'the hidden interval produced ' + advanced + ' ticks, which is more than 900 ms of play');
    });

    await t.test('AC-128 · a paused game does not advance, and the clock does not run down', async () => {
      await waitFor(app.page, (s) => s.mode === 'running', { label: 'a running game' });
      await app.page.getByTestId('pause-button').click();
      const paused = await waitFor(app.page, (s) => s.mode === 'paused', { label: 'the pause overlay' });
      await app.page.getByTestId('overlay-pause').waitFor();
      // AC-128 · a paused game does not advance, and the clock does not run down.
      await app.page.waitForTimeout(250);
      const settled = await snap(app.page);
      const trailing = settled.state.tick - paused.state.tick;
      assert.ok(trailing >= 0 && trailing <= MAX_CATCHUP_TICKS,
        'the pause left ' + trailing + ' ticks trailing: the loop was not cancelled');
      const tickWhilePaused = settled.state.tick;
      const clockWhilePaused = await app.page.getByTestId('hud-clock').textContent();
      const barWhilePaused = await app.page.getByTestId('hud-clock-fill')
        .evaluate((el) => el.getBoundingClientRect().width);
      await app.page.waitForTimeout(2000);
      const stillPaused = await snap(app.page);
      assert.equal(stillPaused.state.tick, tickWhilePaused, '2 s paused advanced the simulation');
      assert.equal(await app.page.getByTestId('hud-clock').textContent(), clockWhilePaused,
        'AC-128/AC-520: the clock caption moved while paused');
      assert.equal(
        await app.page.getByTestId('hud-clock-fill').evaluate((el) => el.getBoundingClientRect().width),
        barWhilePaused,
        'AC-128/AC-520: the clock bar moved while paused',
      );
      await shot(app.page, '05-paused-clock');
      await app.page.getByTestId('btn-resume').click();
      const back = await waitFor(app.page, (s) => s.mode === 'running', { label: 'play to resume', timeout: 4000 });
      const resumeCost = back.state.tick - tickWhilePaused;
      assert.ok(resumeCost >= 0 && resumeCost < 27,
        'resuming cost ' + resumeCost + ' ticks; the pause must not be paid back');
    });

    await t.test('the game PLAYS: an autopilot routes cars and the clock bar drains', async () => {
      const start = await waitFor(app.page, (s) => s.mode === 'running', { label: 'a running game' });
      const deliveredAtStart = start.state.delivered;
      let clicks = 0;
      let shotTaken = false;
      const deadline = Date.now() + 90000;

      while (Date.now() < deadline) {
        const s = await snap(app.page);
        if (!s || s.state.phase !== 'running') break;
        if (s.state.delivered >= deliveredAtStart + 4) break;
        const plan = decide(level, masks, s.state);
        if (plan) {
          const p = junctionScreen(s, plan.junctionId);
          await app.page.mouse.click(p.x, p.y);
          clicks += 1;
          // Wait for the flip to land before deciding again, or the next poll reads a state
          // the tap has not reached yet and taps the same junction straight back.
          await waitFor(app.page, (x) => x.state.open[plan.junctionId] === plan.want || x.state.phase !== 'running', {
            label: 'junction ' + plan.junctionId + ' to reach ' + plan.want,
            timeout: 2000,
          });
        }
        if (!shotTaken && s.cars.length >= 2) {
          await shot(app.page, '06-mid-play');
          shotTaken = true;
        }
        await app.page.waitForTimeout(50);
      }

      const end = await snap(app.page);
      assert.ok(clicks > 0, 'the autopilot never needed to tap, so routing was never exercised');
      assert.ok(
        end.state.delivered >= deliveredAtStart + 4,
        'only ' + end.state.delivered + ' cars were delivered after ' + clicks + ' taps',
      );
      await shot(app.page, '07-after-deliveries');
      // The HUD is React Native views, so it IS queryable — and it is the one place a paint
      // can be read without a screenshot.
      //
      // gameplay.md §4.3: `delivered` IS the score. The big number on the left is the delivered
      // count and there is no points total beside it.
      //
      // THE STATE AND THE HUD ARE READ IN ONE EVALUATION, and that is load-bearing rather than
      // tidy. The caption is a pure function of `state.tick` (AC-520) and the game runs at
      // 60 Hz, so reading the tick in one round-trip and the caption in another compares two
      // different ticks — and a screenshot between them is worth a whole second, which is one
      // whole step of `m:ss`. The bar's ±2 pt tolerance absorbed 80 ticks of that; the caption
      // is exact and had nothing, so it failed on timing rather than on behaviour.
      const live = await snapWithHud(app.page, ['hud-delivered', 'hud-clock-fill', 'hud-clock']);
      const tick = live.snapshot.state.tick;
      assert.equal(
        Number(live.hud['hud-delivered'].text),
        live.snapshot.state.delivered,
        'the HUD number is not `delivered`',
      );
      assert.ok(live.snapshot.state.delivered > 0);

      // AC-520 · the clock bar DRAINS, and both it and its caption are pure functions of the
      // tick. The bar filled under the quota model, so this is the assertion that a
      // pre-round-8 build fails.
      const LEVEL_TICKS = 7200;
      const BAR_W = 180;
      const width = live.hud['hud-clock-fill'].width;
      const want = (BAR_W * (LEVEL_TICKS - tick)) / LEVEL_TICKS;
      assert.ok(Math.abs(width - want) < 2,
        'clock bar is ' + width.toFixed(1) + ' pt at tick ' + tick + ', want ' + want.toFixed(1));
      assert.ok(width < BAR_W, 'the clock bar has not drained at all after ' + tick + ' ticks');
      const left = Math.floor((LEVEL_TICKS - tick) / 60);
      assert.equal(
        live.hud['hud-clock'].text,
        Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'),
      );
    });

    assert.deepEqual(app.errors, [], 'the page logged errors');
  } finally {
    await app.close();
  }
});

test('tier 3 · a level that is left alone ends, and the failure overlay is real', async (t) => {
  // Every junction starts pointing left (gameplay.md §4.8). Leave them there and cars arrive
  // at the wrong depots until the lives run out. That reaches S6 without playing well, and it
  // is the cheapest honest way to exercise the end-of-level path end to end.
  const app = await openApp('?level=' + LEVEL);
  try {
    await startPlaying(app.page);
    const lost = await waitFor(app.page, (s) => s.state.phase !== 'running', {
      label: 'the level to end',
      timeout: 120000,
    });
    assert.equal(lost.state.phase, 'lost');
    assert.equal(lost.state.lives, 0);
    assert.ok(lost.state.misrouted >= 3);
    await app.page.getByTestId('overlay-failed').waitFor();
    const title = await app.page.getByTestId('overlay-failed-title').textContent();
    assert.equal(title, 'OUT OF LIVES');
    const delivered = await app.page.getByTestId('failed-delivered').textContent();
    assert.equal(delivered, String(lost.state.delivered));
    // ui.md §8.7 — `Time survived` is on THIS panel and not on the clear panel, because it is
    // the only place it carries information: a cleared run survived 2:00 by definition.
    const survived = await app.page.getByTestId('failed-time').textContent();
    const secs = Math.floor(lost.state.tick / 60);
    assert.equal(survived, Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0'));
    await shot(app.page, '08-level-failed');

    // AC-308 · taps are discarded once the level has ended.
    const openAtEnd = lost.state.open.slice();
    const tickAtEnd = lost.state.tick;
    const j = lost.level.junctions[0];
    await app.page.mouse.click(
      lost.layout.originX + j.x * lost.layout.scale,
      lost.layout.originY + j.y * lost.layout.scale,
    );
    await app.page.waitForTimeout(300);
    const after = await snap(app.page);
    assert.deepEqual(after.state.open, openAtEnd, 'a tap landed after the level ended');
    assert.equal(after.state.tick, tickAtEnd, 'the simulation advanced after the level ended');

    // RETRY rebuilds the same level from the same seed and starts at tick 0 (gameplay.md §6.3).
    await app.page.getByTestId('btn-retry').click();
    const retried = await waitFor(app.page, (s) => s.state.phase === 'running' && s.state.tick < 30, {
      label: 'a fresh state after retry',
    });
    assert.equal(retried.level.seed, lost.level.seed, 'retry re-rolled the level');
    assert.equal(retried.state.delivered, 0);
    assert.equal(retried.state.lives, 3);
    assert.equal(retried.loops, 1, 'retry left an extra animation-frame loop behind');
    await shot(app.page, '09-after-retry');
    assert.deepEqual(app.errors, [], 'the page logged errors');
  } finally {
    await app.close();
  }
});

test('AC-812 · the tick rate is the same with StrictMode on and off', async () => {
  const measure = async (query) => {
    const app = await openApp(query);
    try {
      await startPlaying(app.page);
      const a = await waitFor(app.page, (s) => s.state.tick > 30, { label: 'the loop to warm up' });
      const t0 = Date.now();
      await app.page.waitForTimeout(3000);
      const b = await snap(app.page);
      return {
        ticksPerSecond: ((b.state.tick - a.state.tick) * 1000) / (Date.now() - t0),
        loops: b.loops,
        errors: app.errors.slice(),
      };
    } finally {
      await app.close();
    }
  };

  const on = await measure('?level=1');
  const off = await measure('?level=1&strict=0');

  assert.equal(on.loops, 1, 'StrictMode left ' + on.loops + ' loops running');
  assert.equal(off.loops, 1);
  assert.deepEqual(on.errors, []);
  assert.deepEqual(off.errors, []);
  assert.ok(on.ticksPerSecond > 45, 'StrictMode on ran at only ' + on.ticksPerSecond.toFixed(1) + ' ticks/s');
  const ratio = on.ticksPerSecond / off.ticksPerSecond;
  assert.ok(
    ratio > 0.9 && ratio < 1.1,
    'StrictMode changed the tick rate: ' + on.ticksPerSecond.toFixed(1) + ' vs ' + off.ticksPerSecond.toFixed(1),
  );
});

test('tier 3 · S1, S2 and S7 are operable stubs, and Symbol size reaches the canvas', async (t) => {
  // ui.md §2: "S1, S2 and S7 can be stubs until slice 4, but their layout is specified here
  // so they are not invented later." Stub or not, they are screens a player has to get
  // through, so they are driven here rather than assumed.
  const app = await openApp();
  try {
    await t.test('S1 · the title screen’s buttons are CENTRED under the wordmark', async () => {
      // OWNER-REPORTED. The button column was `alignSelf: 'stretch'` with `maxWidth: 340`, and
      // stretch wins over the parent's `alignItems: 'center'` — so the column was laid out from
      // the LEFT edge at 340 pt wide while the wordmark stayed centred. Above about 372 pt of
      // screen width (340 plus two 16 pt gutters) the two visibly disagreed, and every device
      // in ui.md §3.3 except the 320 pt iPhone SE is above that.
      //
      // Measured at THREE widths, because the defect is width-dependent: it is invisible below
      // 372 and grows with the screen.
      await app.page.getByTestId('title-wordmark').waitFor({ timeout: 30000 });
      for (const width of [360, 393, 520]) {
        await app.page.setViewportSize({ width, height: 852 });
        await app.page.waitForTimeout(120);
        const word = await app.page.getByTestId('title-wordmark').boundingBox();
        for (const id of ['btn-play', 'btn-levels-menu', 'btn-settings']) {
          const b = await app.page.getByTestId(id).boundingBox();
          const buttonCentre = b.x + b.width / 2;
          assert.ok(Math.abs(buttonCentre - width / 2) <= 1,
            'at ' + width + ' pt, ' + id + ' is centred on ' + buttonCentre.toFixed(1)
            + ' rather than ' + (width / 2));
          assert.ok(Math.abs(buttonCentre - (word.x + word.width / 2)) <= 1,
            'at ' + width + ' pt, ' + id + ' does not line up with the wordmark');
          // ui.md §12 / §11.1: the column is capped at 340 pt and every control clears 44 pt.
          assert.ok(b.width <= 340 + 0.5, 'at ' + width + ' pt, ' + id + ' is ' + b.width + ' pt wide');
          assert.ok(b.height >= 44, id + ' is ' + b.height + ' pt tall');
        }
      }
      await app.page.setViewportSize({ width: 393, height: 852 });
      await app.page.waitForTimeout(120);
    });

    await t.test('S1 -> S2 -> a level, by tapping', async () => {
      await app.page.getByTestId('title-wordmark').waitFor({ timeout: 30000 });
      await shot(app.page, '10-title');
      await app.page.getByTestId('btn-levels-menu').click();
      await app.page.getByTestId('screen-levels').waitFor();
      await shot(app.page, '11-levels');
      await app.page.getByTestId('level-tile-3').click();
      const s = await waitFor(app.page, (x) => x.screen === 'play', { label: 'level 3' });
      assert.equal(s.level.number, 3);
      assert.equal(s.level.band, 1, 'gameplay.md §5: levels 1-4 are band 1');
    });

    await t.test('S7 · Symbol size is a real setting the renderer reads (AC-604)', async () => {
      await app.page.getByTestId('pause-button').click();
      await app.page.getByTestId('btn-quit').click();
      await app.page.getByTestId('btn-settings').click();
      await app.page.getByTestId('screen-settings').waitFor();
      assert.equal(await app.page.getByTestId('setting-symbolLarge-value').textContent(), 'Standard');
      await app.page.getByTestId('setting-symbolLarge').click();
      assert.equal(await app.page.getByTestId('setting-symbolLarge-value').textContent(), 'Large');
      await shot(app.page, '12-settings');
      await app.page.getByTestId('btn-back').click();
      await app.page.getByTestId('btn-play').click();
      const s = await waitFor(app.page, (x) => x.screen === 'play' && x.cars.length > 0, {
        label: 'a car with the Large symbol setting',
        timeout: 30000,
      });
      assert.equal(s.settings.symbolLarge, true, 'the setting did not reach the play screen');
      await shot(app.page, '13-large-symbols');
    });

    assert.deepEqual(app.errors, [], 'the page logged errors');
  } finally {
    await app.close();
  }
});

test('AC-313 · a second finger never moves the tap onto another junction', async () => {
  // WHAT THIS PROVES, AND WHAT IT CANNOT.
  //
  // The defect AC-313 exists for is real: `Gesture.Tap()` does not override RNGH's
  // `transformNativeEvent`, so the x/y on its events are `tracker.getAbsoluteCoordsAverage()`
  // — the CENTROID of every live pointer — and `onPointerAdd` folds the jump the centroid
  // takes into `offsetX`/`offsetY`, so `maxDistance` never rejects it. src/ui/PlayScreen.js
  // therefore hit-tests the point captured in `onBegin`, which is the first pointer.
  //
  // AC-313 says that is verifiable here with two CDP touch points. On this stack it is NOT,
  // and the reason is an upstream defect rather than anything in this repo:
  // node_modules/react-native-gesture-handler/src/web/handlers/TapGestureHandler.ts:162 reads
  //
  //     this.offsetY += this.lastY = this.startY;        // an assignment, not a subtraction
  //
  // inside `onPointerRemove`. Lifting a SECOND pointer therefore adds an absolute screen
  // coordinate to `offsetY`, `shouldFail()` sees a distance of several hundred points against
  // `maxDistance` 16, and the gesture FAILS. On web a second finger does not move the tap —
  // it cancels it, whatever the app does. Patching that one character in node_modules and
  // rebuilding makes the full AC-313 clause pass against this file unchanged (verified, then
  // reverted — a vendored patch is not something this project ships). The "resolves to the
  // first pointer's junction" and "is not cancelled" clauses are consequently a tier-5
  // obligation on a real iPhone, where the recogniser is different code.
  //
  // What is asserted below is the half that IS reachable and that is the actual harm: a
  // second finger must never cause a DIFFERENT junction to flip. Plus a single-touch control,
  // without which a green run here would only mean that CDP touches never arrived.
  const app = await openApp('?level=' + LEVEL);
  const cdp = await app.page.context().newCDPSession(app.page);
  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ ...p, id: i })) });

  try {
    const start = await startPlaying(app.page);
    assert.ok(start.level.junctions.length >= 2, 'the level has two junctions to touch');

    // The two junctions furthest apart, so the midpoint of the pair is outside both hit
    // circles — the hit radius is at most half the minimum junction separation (ui.md §4.4).
    let a = start.level.junctions[0];
    let b = start.level.junctions[1];
    let best = -1;
    for (const p of start.level.junctions) {
      for (const q of start.level.junctions) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d > best) {
          best = d;
          a = p;
          b = q;
        }
      }
    }
    const A = junctionScreen(start, a.junctionId);
    const B = junctionScreen(start, b.junctionId);
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };

    // CONTROL: one finger on B alone flips B, so CDP touches do reach the recogniser.
    const before0 = await snap(app.page);
    await touch('touchStart', [{ x: B.x, y: B.y }]);
    await touch('touchEnd', []);
    const control = await waitFor(
      app.page,
      (s) => s.state.open[b.junctionId] !== before0.state.open[b.junctionId],
      { label: 'the control single touch to flip junction ' + b.junctionId, timeout: 5000 },
    );
    await shot(app.page, '14-single-touch');

    // Two fingers, on two junctions, at the same time.
    const openBefore = control.state.open.slice();
    const tickBefore = control.state.tick;
    await touch('touchStart', [{ x: A.x, y: A.y }]);
    await touch('touchStart', [{ x: A.x, y: A.y }, { x: B.x, y: B.y }]);
    await touch('touchEnd', []);
    await app.page.waitForTimeout(600);
    const after = await snap(app.page);
    await shot(app.page, '15-two-touches');

    const flips = after.events.filter((e) => e.type === 'flip' && e.tick >= tickBefore);
    const ids = flips.map((e) => e.junctionId);
    // Never a junction other than the first pointer's — not the second's, and not a third.
    assert.ok(
      ids.every((id) => id === a.junctionId),
      'two fingers flipped ' + JSON.stringify(ids) + '; only junction ' + a.junctionId +
        ' (the first pointer) may flip',
    );
    assert.ok(ids.length <= 1, 'two fingers enqueued ' + ids.length + ' inputs');
    assert.equal(
      after.state.open[b.junctionId],
      openBefore[b.junctionId],
      'the second pointer\'s junction flipped',
    );
    // And the midpoint is not on either junction, which is what makes the assertion above
    // discriminating on a stack where the gesture does resolve.
    for (const p of [a, b]) {
      const s = junctionScreen(after, p.junctionId);
      assert.ok(
        Math.hypot(mid.x - s.x, mid.y - s.y) > 44,
        'the centroid lands within 44 pt of junction ' + p.junctionId,
      );
    }

    assert.deepEqual(app.errors, [], 'the page logged errors');
  } finally {
    await app.close();
  }
});

test('tier 3 · band 5 PAINTS: six colours, six depots, and a canvas that is not blank', async () => {
  // THIS TEST EXISTS BECAUSE ROUND 9 SHIPPED A BLANK BAND-5 BOARD AND EVERY OTHER CHECK WAS
  // GREEN. `K` rose to 6 (generation.md §6.1) and `glyphPath` had five cases, so drawing a
  // Lime car threw inside the Skia element tree — which takes the WHOLE CANVAS down. The HUD
  // is React Native views, so it kept drawing; `window.__offramp` is published by the state
  // layer, so the snapshot kept reporting four cars in flight; and the throw produced NO page
  // error and NO console error, so `app.errors` was empty. 159 unit tests, 19 tier-3 cases,
  // the layout sweep, the generator audit and the bot sweeps were all green over a play
  // surface that painted nothing.
  //
  // The gap was that tier 3 only ever played LEVEL 1, which is band 1 and three colours. The
  // band the owner actually plays was never rendered.
  //
  // The check has to be about PIXELS, because every queryable surface lied. CanvasKit renders
  // through WebGL without `preserveDrawingBuffer`, so `drawImage` into a 2D canvas returns a
  // blank copy — measured, it reports one distinct colour over 31,000 samples on a board that
  // is visibly painted. What does work is the SCREENSHOT: a PNG of a painted board compresses
  // far worse than a PNG of a flat one, and the two arms are five times apart.
  const app = await openApp('?level=25&autoplay=1');
  try {
    await waitFor(app.page, (s) => s.screen === 'play' && s.state !== null, { label: 'band 5 play' });
    const started = await waitFor(app.page, (s) => s.cars.length >= 3, {
      label: 'three cars in flight at band 5', timeout: 40000,
    });
    // Level 25 is band 5 (AC-701), which is where `K = 6` and the sixth glyph live.
    assert.equal(started.level.K, 6, 'level 25 is not a six-colour level');
    assert.equal(started.level.C, 6);
    assert.equal(started.level.depots.length, 6, 'six depots');
    assert.deepEqual(
      started.level.depots.map((d) => d.colour).sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5],
      'every palette index 0..5 has a depot, so every glyph must exist',
    );

    // A flat region of the play area against a region that must be full of road, cars and
    // depots. `bytes / pixel` because the two clips are different sizes.
    const board = await app.page.screenshot({ clip: { x: 0, y: 200, width: 393, height: 600 } });
    const flat = await app.page.screenshot({ clip: { x: 0, y: 60, width: 393, height: 60 } });
    const boardDensity = board.length / (393 * 600);
    const flatDensity = flat.length / (393 * 60);
    // Measured: 0.2483 painted, 0.0464 flat. The threshold sits between them with room on
    // both sides, and the ratio clause is what makes it a comparison rather than a constant.
    assert.ok(
      boardDensity > 0.12,
      'the band-5 play surface is blank or near-blank: ' + boardDensity.toFixed(4) + ' bytes/px',
    );
    assert.ok(
      boardDensity > 3 * flatDensity,
      'the board compresses like an empty strip: ' + boardDensity.toFixed(4) + ' vs ' + flatDensity.toFixed(4),
    );
    await shot(app.page, '16-band5-six-colours');

    // generation.md §7.4.2 items R and P want this picture in front of the OWNER: whether the
    // road recedes enough (ui.md §4.6) and whether the palette is still bleak (ui.md §5). A
    // bot cannot settle either.
    assert.deepEqual(app.errors, [], 'the page logged errors');
  } finally {
    await app.close();
  }
});
