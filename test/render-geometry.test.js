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
  BLADE_LEN,
  BLADE_W,
  CAR_L,
  CAR_RADIUS,
  CAR_W,
  CORNER_R,
  DEPOT_DISC_RATIO,
  DEPOT_H,
  DEPOT_HATCH_W,
  DEPOT_RADIUS,
  DEPOT_SILL_BARS,
  DEPOT_SILL_BOTTOM,
  DEPOT_SILL_INSET,
  DEPOT_SILL_PITCH,
  DEPOT_W,
  GLASS_L,
  GLASS_OFFSET,
  GLASS_RADIUS,
  GLASS_W,
  GLYPH_CAR,
  GLYPH_DEPOT,
  GLYPH_DEPOT_LARGE,
  JUNCTION_MARK_R,
  JUNCTION_RING_W,
  MOUTH_LU,
  OPEN_BRANCH_FADE,
  ROAD_W,
  TERRACE_FADE,
  buildLevelGeometry,
  carPose,
  edgePolyline,
  filletedCentreline,
  pointAtLu,
  subPathPoints,
} from '../src/render/geometry.js';
import {
  BLADE_SEPARATION_FLOOR_DEG,
  auditArrivalEdges,
  auditBladeDirection,
  auditBladeSeparation,
} from '../tools/lib/render-audit.mjs';
import { CAR_COLOURS, C, OPACITY } from '../src/ui/theme.js';
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

test('generation.md §2.3 · every road is horizontal or vertical, and a corner is 90 deg', () => {
  // ROUND 8 REPLACED THE CLAIM THIS TEST USED TO MAKE. Under the cubic model every edge left
  // and arrived pointing down the screen, so the sprite never turned past horizontal. Under
  // orthogonal routing a car's heading is one of FOUR values — down, left, right, and the 90°
  // sweep between them — and the sweep is what the test has to pin.
  const DOWN = 0;
  const LEFT = Math.PI / 2;
  const RIGHT = -Math.PI / 2;
  let segments = 0;
  let corners = 0;
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(555 + band, band);
    const geom = buildLevelGeometry(level);
    for (const e of level.edges) {
      const pts = edgePolyline(level, e);
      // Every segment is axis-aligned: one of its two deltas is exactly zero.
      for (let i = 1; i < pts.length; i += 1) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dy = pts[i][1] - pts[i - 1][1];
        assert.ok((dx === 0) !== (dy === 0), 'edge ' + e.id + ' segment ' + i + ' is diagonal');
        segments += 1;
      }
      const c = geom.curves[e.id];
      // The last segment is always a vertical DROP, so a car enters a node heading down and a
      // depot is entered from directly above (ui.md §7.4).
      const endPose = carPose(geom.curves, { edgeId: e.id, progress: e.lengthMlu });
      assert.ok(Math.abs(endPose.angle - DOWN) < 1e-9, 'edge ' + e.id + ' does not arrive vertically');
      const startPose = carPose(geom.curves, { edgeId: e.id, progress: 0 });
      const startAngle = startPose.angle;
      assert.ok([DOWN, LEFT, RIGHT].some((a) => Math.abs(startAngle - a) < 1e-9),
        'edge ' + e.id + ' leaves at ' + startAngle);
      if (c.segs.length === 1) {
        assert.equal(e.shape === 'straight' || e.shape === 'entry', true);
        continue;
      }
      corners += 1;
      // The 90° sweep occupies exactly 2 * CORNER_R of centreline and is LINEAR in arc length
      // — not eased, because easing would make the car appear to hesitate at a junction.
      const L1 = c.segs[0].len;
      const before = carPose(geom.curves, { edgeId: e.id, progress: Math.round((L1 - CORNER_R) * MLU) });
      const after = carPose(geom.curves, { edgeId: e.id, progress: Math.round((L1 + CORNER_R) * MLU) });
      assert.ok(Math.abs(Math.abs(before.angle - after.angle) - Math.PI / 2) < 1e-6,
        'the corner sweep is ' + ((before.angle - after.angle) * 180 / Math.PI).toFixed(2) + ' deg');
      const mid = carPose(geom.curves, { edgeId: e.id, progress: Math.round(L1 * MLU) });
      assert.ok(Math.abs(mid.angle - (before.angle + after.angle) / 2) < 1e-6,
        'the rotation is not linear in arc length at the mid-point');
      // And the car never leaves the tarmac: the fillet's worst deviation from the polyline is
      // CORNER_R * (sqrt(2) - 1) ~ 11.6 LU, inside the road's 42 LU half-width.
      const corner = [c.segs[0].x1, c.segs[0].y1];
      const dev = Math.hypot(mid.x - corner[0], mid.y - corner[1]);
      assert.ok(dev <= CORNER_R * (Math.SQRT2 - 1) + 1e-6, 'fillet deviation ' + dev.toFixed(2));
      assert.ok(dev < ROAD_W / 2, 'the car left the tarmac on a turn');
    }
  }
  assert.ok(segments > 100 && corners > 20, segments + ' segments, ' + corners + ' corners');
  assert.equal(CORNER_R, 28, 'ui.md §4.1: a third of the road width');
  assert.equal(CORNER_R * 3, ROAD_W, 'CORNER_R is a third of ROAD_W');
});

test('generation.md §3.4 · the filleted centreline abuts the polyline it is built from', () => {
  // The lane dashes follow this so a dash turns the corner instead of meeting it at a point
  // (ui.md §7.2). Its two ends must be the edge's two ends, and its control point the corner.
  let checked = 0;
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(77 + band, band);
    const geom = buildLevelGeometry(level);
    for (const e of level.edges) {
      const c = geom.curves[e.id];
      const f = filletedCentreline(c);
      const a = level.nodes[e.from];
      const b = level.nodes[e.to];
      assert.deepEqual(f.start, [a.x, a.y]);
      assert.deepEqual(f.end, [b.x, b.y]);
      if (c.segs.length === 1) {
        assert.equal(f.corner, null, 'a straight edge has no corner');
      } else {
        assert.deepEqual(f.corner.control, [c.segs[0].x1, c.segs[0].y1]);
        const r = Math.min(CORNER_R, c.segs[0].len, c.segs[1].len);
        assert.ok(Math.abs(Math.hypot(
          f.corner.before[0] - f.corner.control[0],
          f.corner.before[1] - f.corner.control[1],
        ) - r) < 1e-9);
        assert.ok(Math.abs(Math.hypot(
          f.corner.after[0] - f.corner.control[0],
          f.corner.after[1] - f.corner.control[1],
        ) - r) < 1e-9);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 50, 'only ' + checked + ' edges were checked');
});

test('AC-517 · nothing in the render path fades, ramps or scales a car in', () => {
  // The claim is about source, so the source is what is read. A fade on the car body would
  // have to be an opacity or a scale that depends on the spawn event or on progress along the
  // entry edge; neither appears in the car layer.
  const src = readFile('src/render/PlaySurface.js');
  const carBlock = src.slice(src.indexOf('function CarBody'), src.indexOf('// --- 9 ·'));
  assert.ok(carBlock.length > 200, 'the car layer was located in the source');
  assert.ok(!/opacity=\{(?!frozen)/.test(carBlock), 'the car layer sets no opacity but the frozen one');
  assert.ok(!carBlock.includes('spawn'), 'the car layer does not read the spawn event at all');
  assert.ok(!/scale/.test(carBlock), 'the car layer applies no scale');
  // And the flare, which is the transient that replaced the fade, carries no car colour.
  const flare = src.slice(src.indexOf('function Flares'), src.indexOf('// --- 7, 8 ·'));
  assert.ok(flare.includes('C.textMute'), 'the flare is drawn in --text-mute');
  assert.ok(!flare.includes('CAR_COLOURS'), 'the flare carries none of the car palette');
  // Draw order: the flare is step 6 and the cars are step 7, so the flare is beneath them.
  assert.ok(src.indexOf('<Flares') < src.indexOf('<Cars'), 'the flare is painted beneath the cars');
});

test('AC-501 · the draw order in the source is ui.md §4.2, and cars are under the depot layer', () => {
  const src = readFile('src/render/PlaySurface.js');
  // ui.md §4.2 steps 2-4 (road), 5 (junctions), 6 (flares), 7 (car shadows), 8 (car bodies),
  // 9 (the depot terrace), 10 (depots), 11 (transient effects). Cars come BEFORE the depot
  // layer: a car drives UNDER the terrace and under the building (ui.md §7.6).
  const order = ['Roads', 'Junction', 'Flares', 'Cars', 'Terrace', 'Depot', 'Shatter'];
  let last = -1;
  for (const token of order) {
    const at = src.search(new RegExp('<' + token + '[\\s/>]'));
    assert.ok(at > last, token + ' is out of draw order (found at ' + at + ', previous ' + last + ')');
    last = at;
  }
  assert.ok(last > 0, 'the draw order was actually read out of the file');

  // Steps 7 and 8 are TWO passes over the car list, not one. Through slice 2 ui.md §4.2 said
  // "cars, ascending by id, each with body, roof glyph and shadow", which draws car n+1's
  // shadow over car n's body and contradicts this AC's own third clause; round 7 split the
  // step. The case is reachable at a shared depot mouth (gameplay.md §4.5b).
  const cars = src.slice(src.indexOf('function Cars('), src.indexOf('// --- 9 ·'));
  assert.ok(cars.length > 200, 'the car layer was located');
  const passes = [...cars.matchAll(/poses\.map\(/g)];
  assert.equal(passes.length, 2, 'the car list is traversed ' + passes.length + ' time(s), not 2');
  const shadowAt = cars.indexOf('OPACITY.carShadow');
  const bodyAt = cars.indexOf('<CarBody');
  assert.ok(shadowAt > 0 && bodyAt > 0);
  assert.ok(shadowAt < bodyAt, 'a car body is painted before a car shadow');
  // And the shadow pass contains no body, so the two passes really are separated.
  assert.ok(cars.slice(0, bodyAt).indexOf('CAR_COLOURS') === -1, 'the shadow pass fills a body colour');
});

test('AC-513/AC-515 · the terrace line is mouthLu back from the depot, and the terrace covers it', () => {
  // ui.md §7.6, transcribed: mouthLu = rowH - JUNCTION_MARK_R - 12, at EQUALITY, so the
  // terrace top is DEPOT_Y - mouthLu and exactly `rowH - mouthLu = 46` LU of shared approach
  // is left visible at every band. The 46 is AC-513's residual and it is the same at all five
  // bands, which is a consequence of mouthLu being at its maximum legal value.
  let observed = 0;
  for (let band = 1; band <= 5; band += 1) {
    const level = generate(1000 + band, band);
    const geom = buildLevelGeometry(level);
    assert.ok(geom.mouths.length > 0, 'band ' + band + ' had terminal edges');
    assert.equal(geom.terrace.mouthLu, MOUTH_LU[band]);
    assert.equal(geom.terrace.fade, TERRACE_FADE);
    assert.equal(level.rowH - MOUTH_LU[band], 46, 'band ' + band + ' visible shared approach');
    // The terrace's top edge, and the depot row it has to reach.
    const depotY = level.nodes.find((n) => n.kind === 'depot').y;
    assert.equal(geom.terrace.y, depotY - MOUTH_LU[band]);
    assert.equal(geom.terrace.y + geom.terrace.h, depotY + DEPOT_H);
    // It spans from x(0) - DEPOT_W/2 - 12 to x(C-1) + DEPOT_W/2 + 12 (AC-514's second clause),
    // which contains every terminal edge's horizontal run and both ends of every depot body.
    const xs = level.nodes.filter((n) => n.kind === 'depot').map((n) => n.x);
    assert.equal(geom.terrace.x, Math.min(...xs) - DEPOT_W / 2 - 12);
    assert.equal(geom.terrace.x + geom.terrace.w, Math.max(...xs) + DEPOT_W / 2 + 12);
    for (const e of level.edges) {
      if (level.nodes[e.to].kind !== 'depot') continue;
      for (const p of edgePolyline(level, e)) {
        assert.ok(p[0] >= geom.terrace.x - 1e-9 && p[0] <= geom.terrace.x + geom.terrace.w + 1e-9,
          'a terminal edge leaves the terrace horizontally');
      }
    }
    for (const m of geom.mouths) {
      const depot = level.nodes[m.depotNodeId];
      // The terrace LINE is mouthLu of arc length back from the depot, and under orthogonal
      // routing the last mouthLu is entirely within the vertical drop, so it is also mouthLu
      // straight up.
      assert.equal(m.mouthLu, MOUTH_LU[band]);
      assert.ok(Math.abs(m.mouthPoint[0] - depot.x) < 1e-9, 'the terrace line is not in the depot column');
      assert.ok(Math.abs((depot.y - m.mouthPoint[1]) - MOUTH_LU[band]) < 1e-6,
        'terrace line ' + (depot.y - m.mouthPoint[1]).toFixed(1) + ' LU above the depot');
      // The line is exactly on the terrace's top edge: that is what makes it "the last point
      // at which the car was visible" (AC-515).
      assert.ok(Math.abs(m.mouthPoint[1] - geom.terrace.y) < 1e-6);
      // The glow sub-path runs from the line to the depot and nowhere else.
      const c = geom.curves[m.edgeId];
      const start = pointAtLu(c, c.lengthLu - MOUTH_LU[band]);
      assert.ok(Math.hypot(m.glow[0][0] - start[0], m.glow[0][1] - start[1]) < 1e-6);
      const end = m.glow[m.glow.length - 1];
      assert.ok(Math.hypot(end[0] - depot.x, end[1] - depot.y) < 1e-6);
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

// --- round 7 ------------------------------------------------------------------------------
//
// Five of the checks below guard defects that SHIPPED in slice 2 and that everything this
// project had at the time was blind to. Each one therefore carries its own positive control:
// the audit is run against the defect in the same test, and the test fails if the defect is
// NOT caught. A check whose green has never been paired with a red proves nothing
// (docs/development-process.md §6.2, §6.8).

test('AC-140 · an arrival event names the edge the car came down, over a seeded sweep', () => {
  // The full clause is 1,000 levels a band and lives in tools/render-audit.mjs. This is the
  // sample that fits inside `npm test`; both call the same audit.
  const r = auditArrivalEdges({ levels: 8 });
  assert.ok(r.seen > 500, 'only ' + r.seen + ' arrivals were observed, so little was checked');
  assert.ok(r.delivered > 0 && r.misrouted > 0, 'both event types must be exercised');
  // The clause only bites where a depot has more than one mouth, so the sweep has to reach
  // that case — gameplay.md §4.5b says every level at every band has one.
  assert.ok(r.sharedMouth > 0.3 * r.seen, 'too few arrivals at a shared mouth: ' + r.sharedMouth);
  assert.equal(r.notTerminal, 0, 'an edgeId was not a terminal edge');
  assert.equal(r.wrongDepot, 0, 'level.edges[edgeId].to !== depotId');
  assert.equal(r.disagreements, 0, 'engine vs previous-tick inference: ' + JSON.stringify(r.examples));

  // POSITIVE CONTROL. `depot-first` is the slice-2 defect: "some mouth of this depot" instead
  // of "the mouth this car came down". If the audit cannot see that, it cannot see anything.
  const injected = auditArrivalEdges({ levels: 8, inject: 'depot-first' });
  assert.ok(injected.disagreements > 0, 'the audit did not catch the depot-first inference');
});

test('AC-504 · the blade points along the first segment, and the two states differ by >= 90 deg', () => {
  const r = auditBladeSeparation({ levels: 8 });
  assert.equal(BLADE_SEPARATION_FLOOR_DEG, 90, 'the floor is ui.md §7.3\'s, not a measurement');
  assert.ok(r.junctions > 200, 'only ' + r.junctions + ' junctions were measured');
  assert.equal(r.below, 0, r.below + ' junctions below the floor, worst ' + JSON.stringify(r.worst));
  // THE RESTATEMENT IS EXACT RATHER THAN MEASURED. A branch is {c, c±1} — one vertical, one
  // horizontal, 90° — or {c-1, c+1} — two opposed horizontals, 180°. There are no other
  // cases, so the histogram has exactly two entries and no third value is possible.
  assert.deepEqual(r.distinct.map((d) => d.deg), [90, 180], 'unexpected separation values');
  assert.equal(r.floorDeg, 90);

  // CLAUSE 1, and it is the one that actually catches a blade on the wrong branch.
  const dir = auditBladeDirection({ levels: 8 });
  assert.ok(dir.checked > 400, 'only ' + dir.checked + ' branch headings were checked');
  assert.equal(dir.wrong, 0, JSON.stringify(dir.worst));

  // POSITIVE CONTROLS.
  //
  // `far-chord` is the rule that was RIGHT LAST ROUND — the chord to the branch's far node —
  // and under orthogonal routing it is wrong, because a jog's far node sits down AND across.
  // It must fail both clauses.
  const chord = auditBladeSeparation({ levels: 8, mode: 'far-chord' });
  assert.ok(chord.below > 0, 'the far-chord blade went undetected by the separation clause');
  assert.ok(auditBladeDirection({ levels: 8, mode: 'far-chord' }).wrong > 0);

  // `wrong-branch` — the blade drawn along `out[1 - k]` — must fail clause 1, AND IT DOES NOT
  // FAIL CLAUSE 2. ui.md §7.3 and AC-504 both say the >= 90° separation check "also catches a
  // blade drawn along the wrong branch"; it cannot, because swapping the two blades swaps the
  // two angles and the separation between a swapped pair is the separation between the
  // original pair. That is asserted here rather than left as a comment, because a claim in a
  // document is a claim and not a fact, and this one is false.
  const swapped = auditBladeSeparation({ levels: 8, mode: 'wrong-branch' });
  assert.equal(swapped.below, 0, 'the separation clause caught the swap after all');
  assert.deepEqual(swapped.distinct, r.distinct, 'the swap left the histogram bit-identical');
  assert.ok(auditBladeDirection({ levels: 8, mode: 'wrong-branch' }).wrong > 0,
    'clause 1 did not catch the swapped blade either, so nothing does');
});

test('AC-504 / ui.md §7.3 · the blade fits the marker, and the open branch fades out', () => {
  // The two blade dimensions, proportions of the marker, shrunk with it in round 8.
  assert.equal(JUNCTION_MARK_R, 34);
  assert.equal(BLADE_LEN, 30);
  assert.equal(BLADE_W, 9);
  assert.equal(JUNCTION_MARK_R - BLADE_LEN, 4, 'ui.md §7.3: 4 LU of disc face past the blade tip');
  assert.ok(BLADE_LEN / BLADE_W > 3.3 && BLADE_LEN / BLADE_W < 3.4, 'a 3.3 : 1 bar');
  // AC-503: the marker's DIAMETER is now smaller than the road, so it sits inside its road
  // rather than overhanging it. The old 92 LU marker on a 104 LU road did not.
  assert.equal(2 * JUNCTION_MARK_R, 68);
  assert.ok(2 * JUNCTION_MARK_R < ROAD_W, 'the marker overhangs the road');
  assert.equal(JUNCTION_RING_W, 4);

  // The open-branch overdraw: solid, then a ramp to zero over its final 28 LU. Both stretches
  // together are the specified 120 LU, they abut exactly, and neither is drawn twice.
  assert.equal(OPEN_BRANCH_FADE, 28);
  assert.equal(OPEN_BRANCH_FADE, TERRACE_FADE, 'the same distance as the terrace fade, ui.md §7.3');
  let checked = 0;
  for (let band = 1; band <= 5; band += 1) {
    const geom = buildLevelGeometry(generate(8800 + band, band));
    for (const j of geom.junctions) {
      for (const b of j.branches) {
        const core = b.open;
        const fade = b.openFade;
        assert.ok(core.length >= 2 && fade.length >= 2, 'an empty open-branch stretch');
        const seam = core[core.length - 1];
        assert.ok(
          Math.hypot(seam[0] - fade[0][0], seam[1] - fade[0][1]) < 1e-6,
          'the solid stretch and the fade do not abut',
        );
        // Arc length of the fade stretch, measured off the polyline it is stroked along.
        let lu = 0;
        for (let i = 1; i < fade.length; i += 1) {
          lu += Math.hypot(fade[i][0] - fade[i - 1][0], fade[i][1] - fade[i - 1][1]);
        }
        assert.ok(Math.abs(lu - OPEN_BRANCH_FADE) < 1.5, 'fade stretch is ' + lu.toFixed(2) + ' LU');
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'no junction branches were observed');
});

test('AC-502 · the windscreen and glyph cover under 35 % of the car body', () => {
  // ui.md §4.3, measured by RASTERISING the exact shapes at 0.25 LU, which is what AC-502
  // specifies. The share rose from the old car's 31.5 % because the body's area fell 42 %
  // while GLYPH_CAR fell only 13 % — it has to stay legible at 13.4 pt on the binding device —
  // so the windscreen gave up the difference. THE 1.0 pp OF HEADROOM IS WHAT SAYS THE CAR IS
  // AS SMALL AS THE CURRENT GLYPH SIZES ALLOW.
  assert.equal(CAR_L, 104);
  assert.equal(CAR_W, 66);
  assert.equal(CAR_RADIUS, 12);
  assert.equal(GLYPH_CAR, 42);
  assert.deepEqual([GLASS_W, GLASS_L, GLASS_RADIUS, GLASS_OFFSET], [26, 36, 6, 24]);
  assert.equal(CAR_W + 2 * 9, ROAD_W, 'AC-503: a 9 LU shoulder each side of the car');

  const step = 0.25;
  const inRoundRect = (x, y, w, h, r) => {
    const hx = w / 2;
    const hy = h / 2;
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    if (ax > hx || ay > hy) return false;
    const dx = ax - (hx - r);
    const dy = ay - (hy - r);
    if (dx <= 0 || dy <= 0) return true;
    return dx * dx + dy * dy <= r * r;
  };
  let body = 0;
  let cover = 0;
  for (let x = -CAR_W / 2; x < CAR_W / 2; x += step) {
    for (let y = -CAR_L / 2; y < CAR_L / 2; y += step) {
      const px = x + step / 2;
      const py = y + step / 2;
      if (!inRoundRect(px, py, CAR_W, CAR_L, CAR_RADIUS)) continue;
      body += 1;
      // The windscreen, offset toward the NOSE, which is +y in the car's own frame.
      const glass = inRoundRect(px, py - GLASS_OFFSET, GLASS_W, GLASS_L, GLASS_RADIUS);
      // The widest glyph is Rose's filled square, GLYPH_CAR on a side, centred. Overlap with
      // the windscreen is counted once, which is what AC-502 says.
      const glyph = Math.abs(px) <= GLYPH_CAR / 2 && Math.abs(py) <= GLYPH_CAR / 2;
      if (glass || glyph) cover += 1;
    }
  }
  const areaLu2 = body * step * step;
  const pct = (100 * cover) / body;
  assert.equal(Math.round(areaLu2), 6740, 'ui.md §4.3 measures the body at 6,740 LU²');
  assert.equal(Number(pct.toFixed(1)), 34.0, 'ui.md §4.3 measures 34.0 %');
  assert.ok(pct < 35, 'AC-502 ceiling');
  // The windscreen sits entirely on the body, and forward of centre.
  assert.ok(GLASS_OFFSET + GLASS_L / 2 < CAR_L / 2, 'the windscreen overhangs the nose');
});

test('AC-518 · the depot glyph disc and sill bars are ui.md §7.4\'s geometry', () => {
  // The disc ratio is derived: the widest glyph is a filled square, whose corners sit at
  // sqrt(2)/2 = 0.7071 of the glyph size from the centre.
  assert.equal(DEPOT_DISC_RATIO, 0.75);
  assert.ok(DEPOT_DISC_RATIO > Math.SQRT1_2, 'the disc would clip the square glyph');
  assert.ok(DEPOT_DISC_RATIO >= 0.72, 'ui.md §7.4: do not take this below 0.72');
  assert.equal(GLYPH_DEPOT, 52);
  assert.equal(GLYPH_DEPOT_LARGE, 72);
  assert.equal(DEPOT_DISC_RATIO * GLYPH_DEPOT, 39);
  assert.equal(DEPOT_DISC_RATIO * GLYPH_DEPOT_LARGE, 54);
  assert.equal(DEPOT_W / 2 - DEPOT_DISC_RATIO * GLYPH_DEPOT_LARGE, 8,
    'ui.md §7.4: the Large disc clears DEPOT_W by 8 LU a side');

  assert.equal(DEPOT_W, 124);
  assert.equal(DEPOT_H, 128);
  assert.equal(DEPOT_RADIUS, 10);
  assert.equal(DEPOT_SILL_BARS, 3);
  assert.equal(DEPOT_HATCH_W, 5);
  assert.equal(DEPOT_SILL_PITCH, 8);
  assert.equal(DEPOT_SILL_INSET, 12);
  assert.equal(DEPOT_SILL_BOTTOM, 6);
  assert.equal(OPACITY.depotHatch, 0.18);

  const geom = buildLevelGeometry(generate(4711, 3));
  assert.ok(geom.depots.length >= 2);
  for (const d of geom.depots) {
    assert.equal(d.sill.length, DEPOT_SILL_BARS);
    for (const bar of d.sill) {
      assert.equal(bar.h, DEPOT_HATCH_W);
      assert.equal(bar.x - d.x, DEPOT_SILL_INSET);
      assert.equal(d.x + d.w - (bar.x + bar.w), DEPOT_SILL_INSET);
      assert.equal(bar.w, DEPOT_W - 2 * DEPOT_SILL_INSET, 'the bars are 100 LU wide');
    }
    for (let i = 1; i < d.sill.length; i += 1) {
      assert.equal(d.sill[i].y - d.sill[i - 1].y, DEPOT_SILL_PITCH, 'an 8 LU pitch');
    }
    const lowest = d.sill[d.sill.length - 1];
    assert.equal(d.y + d.h - (lowest.y + lowest.h), DEPOT_SILL_BOTTOM, 'lowest bar 6 LU up');
    const band = lowest.y + lowest.h - d.sill[0].y;
    assert.equal(band, 21, 'the sill occupies the bottom 21 LU');
    assert.ok(band / DEPOT_H < 0.2, 'ui.md §7.4: 16 % of the body, not a third — got ' + (band / DEPOT_H));
  }
});

test('AC-519 · a delivery glows the arriving mouth, not every mouth of its depot', () => {
  // First: the case is reachable. gameplay.md §4.5b says every level at every band has a
  // depot fed by two or three terminal edges, so the union-of-cores defect fires constantly.
  for (let band = 1; band <= 5; band += 1) {
    let shared = 0;
    for (let i = 0; i < 20; i += 1) {
      const geom = buildLevelGeometry(generate(5500 + band * 977 + i, band));
      const byDepot = new Map();
      for (const m of geom.mouths) byDepot.set(m.depotNodeId, (byDepot.get(m.depotNodeId) || 0) + 1);
      if ([...byDepot.values()].some((n) => n > 1)) shared += 1;
    }
    assert.equal(shared, 20, 'band ' + band + ': only ' + shared + '/20 levels have a shared depot');
  }

  // Then: the renderer keys the glow and the shatter by EDGE. Slice 2 unioned every core of a
  // depot into one path and glowed all of them, and keyed the shatter by depot with a
  // "first mouth of the depot" fallback. Both lookups are checked, and the injection below
  // shows this assertion is not vacuous.
  const src = readFile('src/render/PlaySurface.js');
  const surface = src.slice(src.indexOf('export default function PlaySurface'));
  assert.ok(!/glowPathByDepot|mouthByDepot/.test(surface), 'a mouth lookup is still keyed by depot');
  assert.ok(/glowPathByEdge\.get\(e\.edgeId\)/.test(surface), 'the glow does not read e.edgeId');
  assert.ok(/mouthByEdge\.get\(e\.edgeId\)/.test(surface), 'the shatter does not read e.edgeId');
  // No fallback to "some mouth of this depot": that is the same defect wearing another hat.
  assert.ok(!/\|\| list\[0\]/.test(surface), 'the shatter still falls back to an arbitrary mouth');

  // POSITIVE CONTROL: the slice-2 text must fail every assertion above.
  const broken = surface
    .replace(/glowPathByEdge\.get\(e\.edgeId\)/, 'glowPathByDepot.get(e.depotId)')
    .replace(/mouthByEdge\.get\(e\.edgeId\)/, 'mouthByDepot.get(e.depotId) || list[0]');
  assert.ok(/glowPathByDepot|mouthByDepot/.test(broken), 'the injection did not reintroduce the defect');
  assert.ok(!/glowPathByEdge\.get\(e\.edgeId\)/.test(broken));
});

test('AC-502 / AC-606 · the windscreen is --text at 22 %, and the composite clears the floor', () => {
  // ui.md §4.3 and §11.1. The contrast has to be measured on the COMPOSITED patch, because the
  // windscreen covers about a fifth of the body and slice 2's `--ink` pane put two of the five
  // cars below even AC-606's 3.0 floor on that fifth.
  const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (h) => {
    const [r, g, b] = srgb(h);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (base, tint, alpha) => {
    const A = srgb(base);
    const B = srgb(tint);
    return '#' + A.map((v, i) => Math.round(v * (1 - alpha) + B[i] * alpha).toString(16).padStart(2, '0')).join('');
  };

  assert.equal(OPACITY.glass, 0.22);
  assert.equal(C.text, '#E8ECF2');
  // There is no --car-glass token, and the renderer must not have reintroduced one.
  const theme = readFile('src/ui/theme.js');
  assert.ok(!/carGlass\s*:/.test(theme), 'a --car-glass token is back in the theme');
  const surface = readFile('src/render/PlaySurface.js');
  assert.ok(
    /color=\{withAlpha\(C\.text, OPACITY\.glass\)\}/.test(surface),
    'the windscreen is not drawn in --text at OPACITY.glass',
  );

  const plain = CAR_COLOURS.map((c) => ratio(c, C.road));
  const composited = CAR_COLOURS.map((c) => ratio(over(c, C.text, OPACITY.glass), C.road));
  assert.deepEqual(
    composited.map((r) => Number(r.toFixed(2))),
    [6.13, 8.74, 4.99, 6.71, 5.24],
    'ui.md §4.3\'s measured composite ratios',
  );
  for (let i = 0; i < CAR_COLOURS.length; i += 1) {
    assert.ok(plain[i] >= 4.2, 'palette ' + i + ' is ' + plain[i].toFixed(2) + ' : 1 against the road');
    assert.ok(composited[i] >= 3.0, 'AC-606 floor: palette ' + i + ' composited is ' + composited[i].toFixed(2));
    assert.ok(composited[i] >= 4.9, 'ui.md §11.1 floor: palette ' + i + ' composited is ' + composited[i].toFixed(2));
  }

  // POSITIVE CONTROL: the value slice 2 shipped must fail the floor this test enforces.
  const ink = CAR_COLOURS.map((c) => ratio(over(c, C.ink, OPACITY.glass), C.road));
  assert.ok(ink.some((r) => r < 3.0), '--ink at 22 % no longer breaches the 3.0 floor: ' + ink);
  assert.equal(Number(ink[2].toFixed(2)), 2.79, 'Rose under --ink glass');
  assert.equal(Number(ink[4].toFixed(2)), 2.81, 'Iris under --ink glass');
});
