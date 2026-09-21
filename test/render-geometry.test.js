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
  DEPOT_GLOW_PAD,
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
  inkBudgetForLevel,
} from '../tools/lib/render-audit.mjs';
import { CAR_COLOURS, C, OPACITY } from '../src/ui/theme.js';
import {
  chroma,
  composite,
  contrast,
  minPairwiseDeltaE,
  pairsByDeltaE,
} from '../tools/lib/colour.mjs';
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
      // The fillet's worst deviation from the polyline is CORNER_R * (sqrt(2) - 1) ~ 11.6 LU.
      // Round 8 measured that against the ROAD's half-width (42 LU); at ROAD_W = 28 the road's
      // half-width is 14 and the CAR is 2.4 times the road (ui.md §4.6), so the quantity that
      // decides whether the car looks like it left the line is CAR_W / 2 = 33.
      const corner = [c.segs[0].x1, c.segs[0].y1];
      const dev = Math.hypot(mid.x - corner[0], mid.y - corner[1]);
      assert.ok(dev <= CORNER_R * (Math.SQRT2 - 1) + 1e-6, 'fillet deviation ' + dev.toFixed(2));
      assert.ok(dev < CAR_W / 2, 'the car left its own body width on a turn');
    }
  }
  assert.ok(segments > 100 && corners > 20, segments + ' segments, ' + corners + ' corners');
  // ui.md §4.1 — CORNER_R is the CENTRELINE fillet the car follows and it did NOT move in
  // round 9. The road's own outer corner radius is the round join's, ROAD_W / 2 = 14, so the
  // car now turns a WIDER corner than the road it is on — which is correct, because the car
  // is wider than the road (ui.md §4.2). Round 8's "a third of the road width" coincidence is
  // gone and asserting it would now be asserting the coincidence rather than the rule.
  assert.equal(CORNER_R, 28, 'ui.md §4.1');
  assert.equal(ROAD_W, 28, 'ui.md §4.1: the road is one 28 LU stroke');
});

test('generation.md §3.4 · the filleted centreline abuts the polyline it is built from', () => {
  // NOTHING DRAWS THIS ANY MORE — the lane dashes that followed it are deleted (ui.md §7.2,
  // §4.6) and the road is one stroke over the raw polyline. It survives as the analytic form
  // of the centreline `poseAtLu` walks, which is what this test checks it against. Its two
  // ends must be the edge's two ends and its control point the corner.
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
  // CLAUSE (i). THE RESTATEMENT IS EXACT RATHER THAN MEASURED. A branch is {c, c±1} — one vertical, one
  // horizontal, 90° — or {c-1, c+1} — two opposed horizontals, 180°. There are no other
  // cases, so the histogram has exactly two entries and no third value is possible.
  assert.deepEqual(r.distinct.map((d) => d.deg), [90, 180], 'unexpected separation values');
  assert.equal(r.floorDeg, 90);

  // CLAUSE (ii) — the blade drawn for `open === k` points along the first segment of `out[k]`
  // and NOT along `out[1-k]`. It is the one that actually catches a blade on the wrong branch.
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

  // `wrong-branch` — the blade drawn along `out[1 - k]` — must fail clause (ii), AND IT MUST
  // NOT FAIL CLAUSE (i). Round 8's ui.md §7.3 and AC-504 both claimed the >= 90° separation
  // check "also catches a blade drawn along the wrong branch"; it cannot, because swapping
  // the two blades swaps the two angles and the separation between a swapped pair is the
  // separation between the original pair. Round 9's AC-504 requires that blindness to be
  // ASSERTED IN THE SUITE rather than recorded in a comment, and this is it.
  const swapped = auditBladeSeparation({ levels: 8, mode: 'wrong-branch' });
  assert.equal(swapped.below, 0, 'the separation clause caught the swap after all');
  assert.deepEqual(swapped.distinct, r.distinct, 'the swap left the histogram bit-identical');
  assert.ok(auditBladeDirection({ levels: 8, mode: 'wrong-branch' }).wrong > 0,
    'clause (ii) did not catch the swapped blade either, so nothing does');
});

test('AC-504 / ui.md §7.3 · the blade fits the marker, and the open branch fades out', () => {
  // The two blade dimensions, proportions of the marker, shrunk with it in round 8.
  assert.equal(JUNCTION_MARK_R, 34);
  assert.equal(BLADE_LEN, 30);
  assert.equal(BLADE_W, 9);
  assert.equal(JUNCTION_MARK_R - BLADE_LEN, 4, 'ui.md §7.3: 4 LU of disc face past the blade tip');
  assert.ok(BLADE_LEN / BLADE_W > 3.3 && BLADE_LEN / BLADE_W < 3.4, 'a 3.3 : 1 bar');
  // AC-503, INVERTED IN ROUND 9. The marker's diameter is 2.4 times the road, so a junction
  // reads as an OBJECT ON the network rather than as a fitting inside it. Round 8 asserted the
  // opposite — 68 < 84 — and the inversion is the point (ui.md §4.1, §4.6).
  assert.equal(2 * JUNCTION_MARK_R, 68);
  assert.equal(ROAD_W, 28);
  assert.ok(
    Math.abs((2 * JUNCTION_MARK_R) / ROAD_W - 2.4) < 0.05,
    'AC-503: the marker is 2.4 x the road, got ' + ((2 * JUNCTION_MARK_R) / ROAD_W).toFixed(2),
  );
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
  // AC-503, inverted: the car OVERHANGS the road by 19 LU each side rather than sitting in it
  // with a 9 LU shoulder. `CAR_W / ROAD_W` is 2.4 (ui.md §4.1).
  assert.equal((CAR_W - ROAD_W) / 2, 19, 'AC-503: 19 LU of car overhangs the road each side');
  assert.ok(Math.abs(CAR_W / ROAD_W - 2.4) < 0.05, 'AC-503: the car is 2.4 x the road');

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
  // First: the case is reachable, because a defect that never fires is not worth a check.
  //
  // ROUND 9 BROKE A DESIGN CLAIM HERE AND THE NUMBER IS RECORDED RATHER THAN ROUNDED AWAY.
  // gameplay.md §4.5b, ui.md §7.6 and AC-140's note all say every level at every band has a
  // depot fed by two or three terminal edges. That was true while `K < C` at bands 2 and 4,
  // because fewer depots than columns forces a merge. `K = C` at every band now, so a level
  // whose terminal row is C sources each going straight down has NO shared depot — and that
  // level is a pure binary tree, which has exactly `K - 1` branch nodes (generation.md §5.1).
  // `K - 1` is 2 / 3 / 3 / 4 / 5 against `Jmin` of 3 / 3 / 4 / 5 / 7, so V7 forbids it
  // everywhere EXCEPT band 2, where `J = 3` is legal. Measured over 2,000 seeds a band:
  // 100 / 91.2 / 100 / 100 / 100 %.
  const SHARED_FLOOR_PCT = { 1: 100, 2: 85, 3: 100, 4: 100, 5: 100 };
  for (let band = 1; band <= 5; band += 1) {
    let shared = 0;
    const n = 40;
    for (let i = 0; i < n; i += 1) {
      const geom = buildLevelGeometry(generate(5500 + band * 977 + i, band));
      const byDepot = new Map();
      for (const m of geom.mouths) byDepot.set(m.depotNodeId, (byDepot.get(m.depotNodeId) || 0) + 1);
      if ([...byDepot.values()].some((c) => c > 1)) shared += 1;
    }
    assert.ok(
      (100 * shared) / n >= SHARED_FLOOR_PCT[band],
      'band ' + band + ': only ' + shared + '/' + n + ' levels have a shared depot',
    );
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
  // ui.md §4.3 and AC-606. The contrast has to be measured on the COMPOSITED patch, because
  // the windscreen covers about a fifth of the body and slice 2's `--ink` pane put two of the
  // cars below even AC-606's 3.0 floor on that fifth.
  //
  // EVERY NUMBER HERE MOVED IN ROUND 9 and none of the movement is in the windscreen: `--road`
  // went from #2B323C to #3A4350 (ui.md §5.3), so every ratio measured AGAINST the road fell.
  assert.equal(OPACITY.glass, 0.22);
  assert.equal(C.text, '#E8ECF2');
  assert.equal(C.road, '#3A4350');
  // There is no --car-glass token, and the renderer must not have reintroduced one.
  const theme = readFile('src/ui/theme.js');
  assert.ok(!/carGlass\s*:/.test(theme), 'a --car-glass token is back in the theme');
  const surface = readFile('src/render/PlaySurface.js');
  assert.ok(
    /color=\{withAlpha\(C\.text, OPACITY\.glass\)\}/.test(surface),
    'the windscreen is not drawn in --text at OPACITY.glass',
  );

  const plain = CAR_COLOURS.map((c) => contrast(c, C.road));
  const composited = CAR_COLOURS.map((c) => contrast(composite(c, C.text, OPACITY.glass), C.road));

  // ui.md §5.2's road column, TRANSCRIBED. It reproduces exactly, which is what makes the
  // CVD figures below worth believing: the same luminance code produces both.
  assert.deepEqual(
    plain.map((r) => Number(r.toFixed(2))),
    [4.12, 6.40, 3.26, 4.65, 3.26, 7.55],
    'ui.md §5.2\'s measured ratios against --road',
  );

  for (let i = 0; i < CAR_COLOURS.length; i += 1) {
    // AC-606's normative floor for a graphical object, on the palette entry AND on the
    // composite. ui.md §5.2 states the same 3.0 and records the measured worst at 3.26.
    assert.ok(plain[i] >= 3.0, 'AC-606 floor: palette ' + i + ' is ' + plain[i].toFixed(2) + ' : 1 against the road');
    assert.ok(composited[i] >= 3.0, 'AC-606 floor: palette ' + i + ' composited is ' + composited[i].toFixed(2));
  }

  // THE COMPOSITE MEASURES 4.74 / 6.77 / 3.86 / 5.19 / 4.05 / 7.69, MINIMUM 3.86 — and two
  // numbers in the design are now stale against it, which is recorded here rather than
  // quietly satisfied:
  //
  //   * AC-606's third clause quotes `6.13 / 8.74 / 4.99 / 6.71 / 5.24`, "minimum 4.99". Those
  //     are round-8 figures, five colours long, taken against #2B323C.
  //   * ui.md §11.1 states floors of ">= 4.2 : 1 against the road" and ">= 4.9 : 1 after the
  //     windscreen tint is composited". Neither survives the brighter road: ui.md §5.2 itself
  //     now says "every car colour clears 3.26 : 1 ... above the 3.0 : 1 floor", so §5.2 and
  //     §11.1 disagree inside one document.
  //
  // The floor asserted above is AC-606's and §5.2's 3.0, which is the one both the criterion
  // and the palette section state. The measured composite is asserted exactly so that a drift
  // in either direction is a failure rather than a shrug.
  assert.deepEqual(
    composited.map((r) => Number(r.toFixed(2))),
    [4.74, 6.77, 3.86, 5.19, 4.05, 7.69],
    'the composited ratios against round 9\'s --road',
  );

  // POSITIVE CONTROL: the value slice 2 shipped must still fail the floor this test enforces.
  const ink = CAR_COLOURS.map((c) => contrast(composite(c, C.ink, OPACITY.glass), C.road));
  assert.ok(ink.some((r) => r < 3.0), '--ink at 22 % no longer breaches the 3.0 floor: ' + ink);
  assert.equal(Number(ink[2].toFixed(2)), 2.16, 'Rose under --ink glass');
  assert.equal(Number(ink[4].toFixed(2)), 2.18, 'Iris under --ink glass');
});

test('AC-611 · the sixth colour clears every separation floor', () => {
  // ui.md §5.1, §5.2. `K` rose to 6 at band 5 on the owner's instruction that colour escalate
  // with level, and a sixth colour is the kind of change that quietly erodes an optimisation
  // nobody re-runs. This is the re-run.
  //
  // The per-band colour set is entries `0 … K-1` of the palette, with `K = 3 / 4 / 4 / 5 / 6`
  // — TRANSCRIBED from generation.md §6.1, not read out of BANDS.
  const K_BY_BAND = { 1: 3, 2: 4, 3: 4, 4: 5, 5: 6 };
  const names = ['Ember', 'Sky', 'Rose', 'Teal', 'Iris', 'Lime'];
  assert.equal(CAR_COLOURS.length, 6, 'ui.md §5.1 — six car colours');

  for (let band = 1; band <= 5; band += 1) {
    const set = CAR_COLOURS.slice(0, K_BY_BAND[band]);
    for (const type of ['normal', 'protanopia', 'deuteranopia']) {
      const { min, pair } = minPairwiseDeltaE(set, type);
      assert.ok(
        min >= 16,
        'AC-611: band ' + band + ' ' + type + ' min ΔE is ' + min.toFixed(1) +
          ' (' + names[pair[0]] + '/' + names[pair[1]] + ')',
      );
    }
    for (const hex of set) {
      assert.ok(contrast(hex, C.road) >= 3.0, 'AC-611: ' + hex + ' vs --road');
      assert.ok(contrast(hex, C.bg) >= 4.5, 'AC-611: ' + hex + ' vs --bg');
      assert.ok(chroma(hex) >= 30, 'AC-611: ' + hex + ' C* is ' + chroma(hex).toFixed(0));
    }
  }

  // ui.md §5.1's price of the sixth colour, stated as the claim rather than as a number:
  // DEUTERANOPIC SEPARATION DOES NOT MOVE when Lime is added. It is the clause worth pinning,
  // because it is what says Lime does not join the pair the glyphs are carrying.
  const d5 = minPairwiseDeltaE(CAR_COLOURS.slice(0, 5), 'deuteranopia').min;
  const d6 = minPairwiseDeltaE(CAR_COLOURS, 'deuteranopia').min;
  assert.ok(d6 >= d5 - 0.5, 'Lime costs deuteranopic separation: ' + d5.toFixed(1) + ' -> ' + d6.toFixed(1));

  // ui.md §5.2 — tritanopia collapses Ember/Rose and Sky/Teal at EVERY K and always has; that
  // is what the glyphs carry (AC-601). The claim this criterion makes is that LIME DOES NOT
  // JOIN EITHER COLLAPSE.
  const trit = pairsByDeltaE(CAR_COLOURS, 'tritanopia');
  const nearestToLime = trit.find((p) => p.i === 5 || p.j === 5);
  assert.ok(
    nearestToLime.deltaE > trit[0].deltaE + 2,
    'Lime joins the tritanopic collapse at ΔE ' + nearestToLime.deltaE.toFixed(1),
  );
  assert.equal(nearestToLime.i === 5 ? nearestToLime.j : nearestToLime.i, 1, 'Lime\'s nearest tritanopic neighbour is Sky');

  // POSITIVE CONTROL. The floor has to be able to fail, and the cheapest proof is a palette
  // that a human eye would also reject: Rose nudged toward Ember.
  const broken = CAR_COLOURS.slice(0, 5).concat(['#FF6B2E']);
  assert.ok(minPairwiseDeltaE(broken, 'normal').min < 16, 'the ΔE floor cannot fail');
});

test('AC-512 · the palette and the chrome tokens are ui.md §5.3, character for character', () => {
  // TRANSCRIBED from ui.md §5.1 and §5.3. Every hex is a literal here on purpose.
  assert.deepEqual(CAR_COLOURS, ['#FF852A', '#89D9FF', '#FF5386', '#22C6AF', '#A879FF', '#B0F0A3']);
  assert.equal(C.bg, '#0B0E13');
  assert.equal(C.surface, '#151A22');
  assert.equal(C.surfaceRaised, '#1F2630');
  assert.equal(C.road, '#3A4350');
  assert.equal(C.depot, '#1B222C');
  assert.equal(C.ink, '#0B0E13');
  assert.equal(C.text, '#E8ECF2');
  assert.equal(C.textDim, '#96A0B0');
  assert.equal(C.textMute, '#6B7688');
  assert.equal(C.alert, '#FF2D55');
  assert.equal(C.ok, '#E8ECF2');
  // ui.md §5.3's three additions — what answers "feels sad" without touching a rule.
  assert.equal(C.accent, '#4ADE9B');
  assert.equal(C.accentDim, '#2E8B66');
  assert.equal(OPACITY.depotGlow, 0.18);

  // AC-512's deletion clause: `--road-edge` and `--road-dash` DO NOT EXIST.
  assert.ok(!('roadEdge' in C), '--road-edge is back in the theme');
  assert.ok(!('roadDash' in C), '--road-dash is back in the theme');
  assert.ok(!('roadDash' in OPACITY), 'the lane-dash opacity is back');
  const theme = readFile('src/ui/theme.js');
  assert.ok(!/roadEdge\s*:|roadDash\s*:/.test(theme), 'a deleted road token is back');

  // ui.md §5.3's reason the road got BRIGHTER rather than darker: it recedes by occupying
  // less area, not by being harder to see, and at 28 LU it has to read as a connected network.
  assert.ok(Math.abs(contrast(C.road, C.bg) - 1.93) < 0.01, '--road vs --bg is 1.93 : 1');
  assert.ok(contrast(C.road, C.bg) > contrast('#2B323C', C.bg), 'round 9 made --road brighter');

  // ui.md §5.3's accent has to be legible on the surfaces it is used on.
  assert.ok(contrast(C.accent, C.surface) >= 4.5, '--accent on --surface: ' + contrast(C.accent, C.surface).toFixed(2));
  assert.ok(contrast(C.bg, C.accent) >= 4.5, '--bg on an --accent button');
});

test('ui.md §7.2 / §4.6 · the road is ONE stroke, and the ink budget is measured', () => {
  // AC-521 and ui.md §4.6. The road stroke is 28 LU, the casing and the lane dashes are gone,
  // and the junction ring is `--road` because `--road-edge` no longer exists.
  assert.equal(ROAD_W, 28);
  const geomSrc = readFile('src/render/geometry.js');
  assert.ok(!/export const (ROAD_EDGE_W|LANE_DASH_W|LANE_DASH_ON|LANE_DASH_OFF)\b/.test(geomSrc),
    'a deleted road constant is exported again from src/render/geometry.js');
  const surface = readFile('src/render/PlaySurface.js');
  assert.ok(!/DashPathEffect/.test(surface), 'the lane dashes are back');
  assert.ok(!/C\.roadEdge|C\.roadDash/.test(surface), 'a deleted road token is drawn');
  assert.equal((surface.match(/path=\{road\}/g) || []).length, 1, 'the road is not one stroke');

  // THE MEASUREMENT, over a sample small enough to live in `npm test`. The full sweep is
  // `node tools/render-audit.mjs --ink --seeds 400`.
  //
  // IT DOES NOT MEET AC-521's 65 % BUDGET AND THIS TEST SAYS SO RATHER THAN ROUNDING IT AWAY.
  // ui.md §4.6's formula is `road stroke + casing + dashes + terraceArea`, and §7.6 says the
  // terrace "is counted as furniture in §4.6's budget so that it cannot grow quietly". The
  // terrace rect of §7.6 is 223,000 to 280,000 LU² — larger than the whole road stroke at
  // every band — and with it in, the share is 73 to 81 %. The design's published
  // `63.8 / 59.0 / 61.3 / 57.6 / 56.3 %` is reproducible only with the terrace at roughly a
  // tenth of its area, i.e. about its TERRACE_FADE strip: `shareExclTerrace` lands within 4 pp
  // of every published figure. Round 8's published 80.9 % at band 5 reproduces the same way.
  //
  // What is asserted here is the part that is not in dispute — the road stroke alone is far
  // below the budget, and it fell by two thirds — plus the terrace's dominance as a number, so
  // that the designer's decision is made against a measurement.
  const CARS_IN_FLIGHT = { 1: 2.73, 2: 3.96, 3: 4.26, 4: 4.38, 5: 4.40 };
  const shares = {};
  for (let band = 1; band <= 5; band += 1) {
    const consts = {
      ROAD_W, CAR_L, CAR_W, DEPOT_W, DEPOT_H, JUNCTION_MARK_R, DEPOT_GLOW_PAD,
      mouthLu: MOUTH_LU[band],
    };
    let share = 0;
    let exclTerrace = 0;
    let terraceOverRoad = 0;
    const n = 20;
    for (let seed = 0; seed < n; seed += 1) {
      const r = inkBudgetForLevel(generate(seed, band), CARS_IN_FLIGHT[band], consts);
      share += r.share;
      exclTerrace += r.shareExclTerrace;
      terraceOverRoad += r.terrace / r.roadOnly;
    }
    shares[band] = { all: (100 * share) / n, road: (100 * exclTerrace) / n, ratio: terraceOverRoad / n };
    // The road stroke alone is comfortably inside the budget at every band, and that is the
    // part of §4.6 the road change was aimed at.
    assert.ok(shares[band].road <= 65,
      'band ' + band + ': road-only furniture share is ' + shares[band].road.toFixed(1) + ' %');
    // The terrace is larger than the entire road network at every band, which is what makes it
    // the whole of the disagreement.
    assert.ok(shares[band].ratio > 1,
      'band ' + band + ': the terrace is no longer the dominant furniture term — re-read AC-521');
  }
  // And the direction of travel, which is what the budget's "real job" is: round 8 measured
  // 85.2 / 82.5 / 83.9 / 81.7 / 80.9 % on the same formula.
  const ROUND_8 = { 1: 85.2, 2: 82.5, 3: 83.9, 4: 81.7, 5: 80.9 };
  for (let band = 1; band <= 5; band += 1) {
    assert.ok(shares[band].all < ROUND_8[band],
      'band ' + band + ': the ink budget went UP, which is what AC-521 exists to stop');
  }
});

test('AC-601 · every palette entry has a glyph, and the sixth is a diamond', () => {
  // ROUND 9 SHIPPED `K = 6` WITH FIVE GLYPHS AND EVERY CHECK STAYED GREEN. `glyphPath` threw
  // inside the Skia element tree, which takes the whole canvas down: the HUD kept drawing, the
  // serialised snapshot kept reporting cars in flight, and no page or console error was
  // produced. It was found by LOOKING AT A SCREENSHOT — the third defect in this project's
  // history found that way and the second in the play surface.
  //
  // This is the cheap half of the repair. `src/render/glyphs.js` imports Skia and cannot be
  // loaded in bare Node, so the check is on the SOURCE: every palette index must have a case.
  // The expensive half — that the band-5 board actually paints — is the tier-3 case in
  // e2e/play.e2e.mjs, which is the one proven to fail against the missing glyph.
  const src = readFile('src/render/glyphs.js');
  const body = src.slice(src.indexOf('function build('), src.indexOf('export function glyphPath'));
  for (let i = 0; i < CAR_COLOURS.length; i += 1) {
    assert.ok(
      new RegExp('case ' + i + ':').test(body),
      'palette index ' + i + ' (' + CAR_COLOURS[i] + ') has no glyph — the canvas will render NOTHING at any band that uses it',
    );
  }
  // And the check is not vacuous: an index past the palette must NOT have one, or the regex
  // above would pass on any file containing enough digits.
  assert.ok(!new RegExp('case ' + CAR_COLOURS.length + ':').test(body), 'there is a glyph for a colour that does not exist');
  // POSITIVE CONTROL. Delete the sixth case and the loop above must fail — which is the
  // state round 9 actually shipped for the length of one build.
  const fiveOnly = body.replace(/case 5:[\s\S]*?break;/, '');
  assert.ok(!/case 5:/.test(fiveOnly), 'the injection did not remove the sixth case');
  assert.ok(/case 4:/.test(fiveOnly), 'the injection removed more than the sixth case');

  // ui.md §5.1 assigns Lime the DIAMOND, and ui.md §6.2's "no shape is another shape rotated"
  // is left over from the five-shape set: a diamond is Rose's square at 45 degrees. The rule
  // holds in substance only because every glyph is counter-rotated to screen-upright
  // (AC-603) — which is the rule §6.2 states one sentence earlier, in the words "without this,
  // square and diamond would be the same shape". The conflict is the designer's to settle; the
  // renderer draws what §5.1's table says, and the counter-rotation is asserted elsewhere in
  // this file.
  assert.ok(/case 5:.*diamond/is.test(body.slice(body.indexOf('case 5:'), body.indexOf('case 5:') + 120)),
    'the sixth glyph is not the diamond ui.md §5.1 assigns');
});
