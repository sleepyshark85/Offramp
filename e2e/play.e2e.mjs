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

import { reachableColourMasks } from '../src/engine/index.js';
import { DEFAULT_RUN_SEED, buildLevel } from '../src/ui/run.js';
import { openApp, shot, snap, startPlaying, waitFor } from './harness.mjs';

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
      assert.equal(s.level.quota, level.quota);
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
      const p = junctionScreen(still, 0);
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

    await t.test('AC-803 / AC-804 · backgrounding costs zero ticks and resumes on a 3-2-1', async () => {
      await waitFor(app.page, (s) => s.mode === 'running', { label: 'a running game' });
      // Read the tick and background the page in ONE round trip. Reading it from Node first
      // would measure this harness's own latency rather than the app's, and the first version
      // of this test failed on exactly that.
      const tickAtBackground = await app.page.evaluate(() => {
        const t = window.__offramp.state.tick;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        return t;
      });
      const hidden = await waitFor(app.page, (s) => s.mode === 'paused', { label: 'the app to pause on background' });
      const tickWhileHidden = hidden.state.tick;
      await app.page.waitForTimeout(2000);
      const stillHidden = await snap(app.page);
      assert.equal(stillHidden.state.tick, tickWhileHidden, '2 s in the background advanced the simulation');
      assert.ok(
        tickWhileHidden - tickAtBackground <= 8,
        'the pause was ' + (tickWhileHidden - tickAtBackground) + ' ticks late; more than one frame of catch-up ran',
      );

      await app.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const counting = await waitFor(app.page, (s) => s.mode === 'countdown', { label: 'the resume countdown' });
      assert.equal(counting.countdown, 3);
      assert.equal(counting.state.tick, tickWhileHidden, 'a tick ran during the countdown');
      await app.page.getByTestId('overlay-countdown').waitFor();
      await shot(app.page, '05-resume-countdown');

      // Three 600 ms beats, and NO tick until they are done. The numerals are collected as
      // they appear rather than sampled at a fixed instant: sampling at 900 ms tests this
      // machine's scheduler, not the app, and it is what made the first version of this test
      // flaky one run in five.
      const seen = [];
      const t0 = Date.now();
      for (;;) {
        const s = await snap(app.page);
        if (s.mode !== 'countdown') break;
        if (seen[seen.length - 1] !== s.countdown) seen.push(s.countdown);
        assert.equal(s.state.tick, tickWhileHidden, 'a tick ran during the countdown');
        if (Date.now() - t0 > 5000) break;
        await app.page.waitForTimeout(30);
      }
      const elapsed = Date.now() - t0;
      assert.deepEqual(seen, [3, 2, 1], 'the countdown did not run 3-2-1, it ran ' + JSON.stringify(seen));
      assert.ok(elapsed > 1500 && elapsed < 2600, '3 x 600 ms took ' + elapsed + ' ms');

      const back = await waitFor(app.page, (s) => s.mode === 'running', { label: 'play to resume', timeout: 4000 });
      assert.equal(back.state.tick, tickWhileHidden, 'the countdown itself advanced the simulation');
    });

    await t.test('the game PLAYS: an autopilot routes cars and the quota bar moves', async () => {
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
      assert.ok(end.state.score > 0, 'score did not move');
      await shot(app.page, '07-after-deliveries');
      // The HUD is React Native views, so it IS queryable — and it is the one place a paint
      // can be read without a screenshot.
      const quota = await app.page.getByTestId('hud-quota').textContent();
      assert.equal(quota, end.state.delivered + ' / ' + end.level.quota);
      const width = await app.page.getByTestId('hud-quota-fill').evaluate((el) => el.getBoundingClientRect().width);
      assert.ok(width > 0, 'the quota bar has no fill after ' + end.state.delivered + ' deliveries');
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
    assert.equal(delivered, lost.state.delivered + '/' + lost.level.quota);
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
