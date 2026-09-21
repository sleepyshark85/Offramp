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
  DEPOT_DISC_RATIO,
  DEPOT_H,
  DEPOT_HATCH_W,
  DEPOT_SILL_BARS,
  DEPOT_SILL_BOTTOM,
  DEPOT_SILL_INSET,
  DEPOT_SILL_PITCH,
  DEPOT_W,
  GLYPH_DEPOT,
  GLYPH_DEPOT_LARGE,
  JUNCTION_MARK_R,
  JUNCTION_RING_W,
  MOUTH_FADE,
  MOUTH_LU,
  OPEN_BRANCH_FADE,
  buildLevelGeometry,
  carPose,
  pointAtLu,
  subPathPoints,
} from '../src/render/geometry.js';
import {
  BLADE_SEPARATION_FLOOR_DEG,
  auditArrivalEdges,
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
  // 9 (aprons), 10 (depots), 11 (transient effects). Cars come BEFORE the depot layer: a car
  // drives under the mouth and under the building (ui.md §7.6).
  const order = ['Roads', 'Junction', 'Flares', 'Cars', 'Mouths', 'Depot', 'Shatter'];
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

test('AC-504 · the blade angle differs by at least 30 deg between the two switch states', () => {
  const r = auditBladeSeparation({ levels: 8 });
  assert.equal(BLADE_SEPARATION_FLOOR_DEG, 30, 'the floor is ui.md §7.3\'s, not a measurement');
  assert.ok(r.junctions > 200, 'only ' + r.junctions + ' junctions were measured');
  assert.equal(r.below, 0, r.below + ' junctions below the floor, worst ' + JSON.stringify(r.worst));
  // The measured floor is 36.87 deg = atan(colW / rowH) at band 1, so 30 is a real threshold
  // with room in it rather than a restatement of the geometry.
  assert.ok(r.floorDeg > 36, 'floor was ' + r.floorDeg.toFixed(2) + ' deg');
  assert.ok(r.floorDeg < 90);

  // POSITIVE CONTROL, and this is the whole point of the AC. The previous wording — "rotated
  // to lie along out[k]" — was SATISFIED by a tangent-derived blade, which drew the identical
  // vertical bar for both branches because every edge leaves its node vertically
  // (generation.md §2.3). Both tangent derivations must be caught.
  for (const mode of ['tangent', 'tangent0']) {
    const bad = auditBladeSeparation({ levels: 8, mode });
    assert.ok(bad.below > 0, 'the ' + mode + ' blade went undetected');
    assert.ok(bad.floorDeg < BLADE_SEPARATION_FLOOR_DEG, mode + ' floor was ' + bad.floorDeg);
  }
});

test('AC-504 / ui.md §7.3 · the blade fits the marker, and the open branch fades out', () => {
  // The two blade dimensions, ratified in round 7 as proportions of the marker.
  assert.equal(BLADE_LEN, 40);
  assert.equal(BLADE_W, 12);
  assert.equal(BLADE_W, 3 * JUNCTION_RING_W, 'the blade is three times the ring');
  const clear = JUNCTION_MARK_R - JUNCTION_RING_W - BLADE_LEN;
  assert.equal(clear, 2, 'blade tip to the inside of the ring');
  assert.ok(BLADE_LEN / BLADE_W > 3.3 && BLADE_LEN / BLADE_W < 3.4, 'a 3.3 : 1 bar');

  // The open-branch overdraw: solid, then a ramp to zero over its final 36 LU. Both stretches
  // together are the specified 150 LU, they abut exactly, and neither is drawn twice.
  assert.equal(OPEN_BRANCH_FADE, 36);
  assert.equal(OPEN_BRANCH_FADE, MOUTH_FADE, 'the same distance as the apron fade, ui.md §7.3');
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

test('AC-518 · the depot glyph disc and sill bars are ui.md §7.4\'s geometry', () => {
  // The disc ratio is derived: the widest glyph is a filled square, whose corners sit at
  // sqrt(2)/2 = 0.7071 of the glyph size from the centre.
  assert.equal(DEPOT_DISC_RATIO, 0.75);
  assert.ok(DEPOT_DISC_RATIO > Math.SQRT1_2, 'the disc would clip the square glyph');
  assert.ok(DEPOT_DISC_RATIO >= 0.72, 'ui.md §7.4: do not take this below 0.72');
  assert.equal(DEPOT_DISC_RATIO * GLYPH_DEPOT, 48);
  assert.equal(DEPOT_DISC_RATIO * GLYPH_DEPOT_LARGE, 66);
  assert.ok(DEPOT_W / 2 - DEPOT_DISC_RATIO * GLYPH_DEPOT_LARGE >= 14, 'the Large disc crowds DEPOT_W');

  assert.equal(DEPOT_SILL_BARS, 3);
  assert.equal(DEPOT_HATCH_W, 6);
  assert.equal(DEPOT_SILL_PITCH, 10);
  assert.equal(DEPOT_SILL_INSET, 16);
  assert.equal(DEPOT_SILL_BOTTOM, 8);
  assert.equal(OPACITY.depotHatch, 0.18);

  const geom = buildLevelGeometry(generate(4711, 3));
  assert.ok(geom.depots.length >= 2);
  for (const d of geom.depots) {
    assert.equal(d.sill.length, DEPOT_SILL_BARS);
    for (const bar of d.sill) {
      assert.equal(bar.h, DEPOT_HATCH_W);
      assert.equal(bar.x - d.x, DEPOT_SILL_INSET);
      assert.equal(d.x + d.w - (bar.x + bar.w), DEPOT_SILL_INSET);
      assert.equal(bar.w, DEPOT_W - 2 * DEPOT_SILL_INSET, 'the bars are 128 LU wide');
    }
    for (let i = 1; i < d.sill.length; i += 1) {
      assert.equal(d.sill[i].y - d.sill[i - 1].y, DEPOT_SILL_PITCH, 'a 10 LU pitch');
    }
    const lowest = d.sill[d.sill.length - 1];
    assert.equal(d.y + d.h - (lowest.y + lowest.h), DEPOT_SILL_BOTTOM, 'lowest bar 8 LU up');
    const band = lowest.y + lowest.h - d.sill[0].y;
    assert.equal(band, 26, 'the sill occupies the bottom 26 LU');
    assert.ok(band / DEPOT_H < 0.2, 'ui.md §7.4: 15 % of the body, not a third — got ' + (band / DEPOT_H));
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
  assert.ok(!/corePathByDepot|mouthByDepot/.test(surface), 'a mouth lookup is still keyed by depot');
  assert.ok(/corePathByEdge\.get\(e\.edgeId\)/.test(surface), 'the glow does not read e.edgeId');
  assert.ok(/mouthByEdge\.get\(e\.edgeId\)/.test(surface), 'the shatter does not read e.edgeId');
  // No fallback to "some mouth of this depot": that is the same defect wearing another hat.
  assert.ok(!/\|\| list\[0\]/.test(surface), 'the shatter still falls back to an arbitrary mouth');

  // POSITIVE CONTROL: the slice-2 text must fail every assertion above.
  const broken = surface
    .replace(/corePathByEdge\.get\(e\.edgeId\)/, 'corePathByDepot.get(e.depotId)')
    .replace(/mouthByEdge\.get\(e\.edgeId\)/, 'mouthByDepot.get(e.depotId) || list[0]');
  assert.ok(/corePathByDepot|mouthByDepot/.test(broken), 'the injection did not reintroduce the defect');
  assert.ok(!/corePathByEdge\.get\(e\.edgeId\)/.test(broken));
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
