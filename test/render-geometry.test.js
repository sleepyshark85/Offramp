// Play-surface geometry and motion — AC-501, AC-505, AC-515, AC-517.
//
// src/render/geometry.js and src/render/motion.js are pure and Skia-free precisely so that
// the parts of the drawing that are *claims* — where a car is, where the apron starts, what
// phase an animation is at on a given tick — can be checked here rather than only by looking
// at a screenshot. The paint itself is tiers 3 and 5.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MLU, TICK_HZ, createState, generate } from '../src/engine/index.js';
import { advanceFrame } from '../src/ui/loop.js';
import {
  MOUTH_FADE,
  MOUTH_LU,
  buildLevelGeometry,
  carPose,
  pointAtLu,
  subPathPoints,
} from '../src/render/geometry.js';
import { easeOutQuad, elapsedMs, jitter01, phase } from '../src/render/motion.js';

/** The AC-501 and AC-517 checks are claims about the source, so they read the source. */
function readFile(rel) {
  return readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
}

test('a car at progress 0 sits on the edge start, and at lengthMlu on the edge end', () => {
  const level = generate(31337, 3);
  const geom = buildLevelGeometry(level);
  let checked = 0;
  for (const e of level.edges) {
    const a = level.nodes[e.from];
    const b = level.nodes[e.to];
    const p0 = carPose(geom.curves, { edgeId: e.id, progress: 0 });
    const p1 = carPose(geom.curves, { edgeId: e.id, progress: e.lengthMlu });
    assert.ok(Math.hypot(p0.x - a.x, p0.y - a.y) < 0.5, 'edge ' + e.id + ' start');
    assert.ok(Math.hypot(p1.x - b.x, p1.y - b.y) < 0.5, 'edge ' + e.id + ' end');
    checked += 1;
  }
  assert.ok(checked > 0, 'edges were observed');
});

test('every edge leaves and arrives pointing down the screen, so the sprite never spins', () => {
  // generation.md §2.3 consequence 3: the tangent is always "downward-ish".
  const level = generate(555, 5);
  const geom = buildLevelGeometry(level);
  let worst = 0;
  let checked = 0;
  for (const e of level.edges) {
    for (let f = 0; f <= 1; f += 0.05) {
      const pose = carPose(geom.curves, { edgeId: e.id, progress: Math.round(e.lengthMlu * f) });
      worst = Math.max(worst, Math.abs(pose.angle));
      checked += 1;
    }
  }
  assert.ok(checked > 0);
  assert.ok(worst < Math.PI / 2, 'a car heading turned past horizontal: ' + worst);
});

test('AC-517 · nothing in the render path fades, ramps or scales a car in', () => {
  // The claim is about source, so the source is what is read. A fade on the car body would
  // have to be an opacity or a scale that depends on the spawn event or on progress along the
  // entry edge; neither appears in the car layer.
  const src = readFile('src/render/PlaySurface.js');
  const carBlock = src.slice(src.indexOf('function CarBody'), src.indexOf('// --- 8 ·'));
  assert.ok(carBlock.length > 200, 'the car layer was located in the source');
  assert.ok(!/opacity=\{(?!frozen)/.test(carBlock), 'the car layer sets no opacity but the frozen one');
  assert.ok(!carBlock.includes('spawn'), 'the car layer does not read the spawn event at all');
  assert.ok(!/scale/.test(carBlock), 'the car layer applies no scale');
  // And the flare, which is the transient that replaced the fade, carries no car colour.
  const flare = src.slice(src.indexOf('function Flares'), src.indexOf('// --- 7 ·'));
  assert.ok(flare.includes('C.textMute'), 'the flare is drawn in --text-mute');
  assert.ok(!flare.includes('CAR_COLOURS'), 'the flare carries none of the car palette');
  // Draw order: the flare is step 6 and the cars are step 7, so the flare is beneath them.
  assert.ok(src.indexOf('<Flares') < src.indexOf('<Cars'), 'the flare is painted beneath the cars');
});

test('AC-501 · the draw order in the source is ui.md §4.2, and cars are under the depot layer', () => {
  const src = readFile('src/render/PlaySurface.js');
  // ui.md §4.2 steps 2-4 (road), 5 (junctions), 6 (flares), 7 (cars), 8 (aprons),
  // 9 (depots), 10 (transient effects). Cars come BEFORE the depot layer: a car drives
  // under the mouth and under the building (ui.md §7.6).
  const order = ['Roads', 'Junction', 'Flares', 'Cars', 'Mouths', 'Depot', 'Shatter'];
  let last = -1;
  for (const token of order) {
    const at = src.search(new RegExp('<' + token + '[\\s/>]'));
    assert.ok(at > last, token + ' is out of draw order (found at ' + at + ', previous ' + last + ')');
    last = at;
  }
  assert.ok(last > 0, 'the draw order was actually read out of the file');
});

test('AC-515 · the mouth line is mouthLu back from the depot, not the depot node', () => {
  let observed = 0;
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(1000 + band, band);
    const geom = buildLevelGeometry(level);
    assert.ok(geom.mouths.length > 0, 'band ' + band + ' had terminal edges');
    for (const m of geom.mouths) {
      const depot = level.nodes[m.depotNodeId];
      const d = Math.hypot(m.mouthPoint[0] - depot.x, m.mouthPoint[1] - depot.y);
      assert.ok(d > 0.6 * MOUTH_LU[band], 'mouth line only ' + d.toFixed(1) + ' LU from the depot');
      assert.equal(m.mouthLu, MOUTH_LU[band]);
      // The core covers mouthLu - MOUTH_FADE and the fade covers MOUTH_FADE above it.
      const c = geom.curves[m.edgeId];
      const coreStart = pointAtLu(c, c.lengthLu - (MOUTH_LU[band] - MOUTH_FADE));
      assert.ok(Math.hypot(m.core[0][0] - coreStart[0], m.core[0][1] - coreStart[1]) < 1);
      assert.ok(Math.hypot(m.fade[m.fade.length - 1][0] - coreStart[0]) < 1);
      observed += 1;
    }
  }
  assert.ok(observed > 0, 'mouths were observed');
});

test('AC-515 · a misrouted event carries the terminal edge the car came down', () => {
  // Drive real levels until a misroute happens and check the edge the renderer will use is
  // a terminal edge feeding the depot that rejected the car.
  let misroutes = 0;
  for (let seed = 1; seed <= 40 && misroutes < 3; seed += 1) {
    const level = generate(seed * 131 + 5, 2);
    const geom = buildLevelGeometry(level);
    let s = createState(level);
    let acc = 0;
    let ev = [];
    while (s.phase === 'running' && s.tick < 60 * 200) {
      const r = advanceFrame(s, acc, 1000 / 60, [], ev);
      s = r.state;
      acc = r.accTicks;
      ev = r.recent;
      for (const e of ev) {
        if (e.type !== 'misrouted' || e.seen) continue;
        e.seen = true;
        assert.ok(Number.isInteger(e.edgeId), 'misrouted event has no edgeId');
        const edge = level.edges[e.edgeId];
        assert.equal(edge.to, e.depotId, 'the edge does not feed the rejecting depot');
        assert.ok(geom.mouths.some((m) => m.edgeId === e.edgeId), 'the edge is not a terminal edge');
        misroutes += 1;
      }
    }
  }
  assert.ok(misroutes > 0, 'no misroute was ever observed, so nothing above was checked');
});

test('AC-505 · an animation phase is a pure function of (currentTick, eventTick)', () => {
  assert.equal(elapsedMs(60, 0), 1000);
  assert.equal(elapsedMs(1, 0), 1000 / TICK_HZ);
  assert.equal(phase(0, 0, 180), 0);
  assert.equal(phase(10, 0, 180), (10 * 1000) / 60 / 180);
  assert.equal(phase(10, 0, 180) < 1, true);
  assert.equal(phase(11, 0, 180), null, '180 ms is 10.8 ticks, so tick 11 is already over');
  assert.equal(phase(-1, 0, 180), null);
  // Deterministic scatter: the same event and index give the same value, every run.
  assert.equal(jitter01(7, 3), jitter01(7, 3));
  assert.notEqual(jitter01(7, 3), jitter01(7, 4));
  assert.ok(jitter01(7, 3) >= 0 && jitter01(7, 3) < 1);
  assert.equal(easeOutQuad(0), 0);
  assert.equal(easeOutQuad(1), 1);
});

test('subPathPoints stays on the curve and respects its bounds', () => {
  const level = generate(2024, 4);
  const geom = buildLevelGeometry(level);
  const c = geom.curves[level.entryEdgeId];
  const pts = subPathPoints(c, 0, 100, 8);
  assert.ok(pts.length >= 13);
  const first = pointAtLu(c, 0);
  const last = pointAtLu(c, 100);
  assert.ok(Math.hypot(pts[0][0] - first[0], pts[0][1] - first[1]) < 1e-6);
  assert.ok(Math.hypot(pts[pts.length - 1][0] - last[0], pts[pts.length - 1][1] - last[1]) < 1e-6);
  // Clamped, never extrapolated.
  const clamped = subPathPoints(c, -50, c.lengthLu + 500, 8);
  assert.ok(clamped[0][1] >= first[1] - 1e-6);
});

test('progress is integer MLU and the pose is derived, never accumulated', () => {
  const level = generate(11, 1);
  const geom = buildLevelGeometry(level);
  const a = carPose(geom.curves, { edgeId: 0, progress: 40 * MLU });
  const b = carPose(geom.curves, { edgeId: 0, progress: 40 * MLU });
  assert.deepEqual(a, b, 'the same integer position paints in the same place, always');
});
