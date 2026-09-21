#!/usr/bin/env node
// tools/render-audit.mjs — the two sweep-scale render claims (AC-140, AC-504).
//
//   node tools/render-audit.mjs                            1,000 levels a band, both audits
//   node tools/render-audit.mjs --seeds 100
//   node tools/render-audit.mjs --inject wrong-branch      AC-504, the blade on the other arm
//   node tools/render-audit.mjs --inject far-chord         AC-504, the pre-round-8 blade rule
//   node tools/render-audit.mjs --inject depot-first       AC-140, the slice-2 mouth lookup
//
// Both of these exist because slice 2 shipped a defect that every check it had was blind to,
// and both were found by looking at the drawing rather than by running anything. So both are
// run against the defect first — `--inject` is not a debugging aid, it is the evidence that a
// green run means something (docs/development-process.md §6.2).
//
//   AC-504  The blade's heading must differ by >= 90 deg between `open === 0` and
//           `open === 1`, at every junction of every level. ui.md §7.3 is normative that the
//           heading is the FIRST SEGMENT of `out[k]`. The floor moved 30 -> 90 in round 8 and
//           the restatement is exact rather than measured: orthogonal branches leave the node
//           at right angles by construction. The slice-2 tangent defect is gone by
//           construction, so what the clause is kept for is a blade drawn along the WRONG
//           branch — which no construction prevents.
//
//   AC-140  `delivered` and `misrouted` carry `edgeId`, the terminal edge the car arrived on.
//           The check is that the engine's value equals the previous-tick inference the
//           renderer used through slice 2, on every arrival — which is what makes deleting
//           that workaround safe rather than merely unnecessary.

import { BANDS, generate } from '../src/engine/index.js';
import {
  BLADE_SEPARATION_FLOOR_DEG,
  INK_BUDGET_PCT,
  auditArrivalEdges,
  auditBladeBlindness,
  auditBladeDirection,
  auditBladeSeparation,
  inkBudgetForLevel,
  rasterInkShare,
} from './lib/render-audit.mjs';
import {
  CAR_L,
  CAR_W,
  DEPOT_GLOW_PAD,
  DEPOT_H,
  DEPOT_W,
  JUNCTION_MARK_R,
  MOUTH_LU,
  ROAD_W,
  buildCurves,
} from '../src/render/geometry.js';
import { arg, has, table } from './lib/report.mjs';

const seeds = Number(arg('seeds', 1000));
const inject = arg('inject', null);
const bands = BANDS.slice(1).map((p) => p.band);

// --- AC-521, the ink budget (ui.md §4.6) -------------------------------------------------
//
// generation.md §6.1's cars-in-flight column, TRANSCRIBED. `actors` is measured at the band's
// MEAN OCCUPANCY, so the ink budget depends on a difficulty number — and reading it back out
// of a bot run would make this check's expectation a measurement of the thing under test.
const CARS_IN_FLIGHT = { 1: 2.73, 2: 3.96, 3: 4.26, 4: 4.38, 5: 4.40 };

if (has('ink')) {
  const inkSeeds = Number(arg('seeds', 400));
  console.log(`# AC-521 — the ink budget, ${inkSeeds} levels a band (ui.md §4.6)\n`);
  console.log('furniture = road stroke + casing(0) + dashes(0) + terrace');
  console.log('actors    = carsInFlight x CAR_L x CAR_W + K x DEPOT_W x DEPOT_H + J x pi x R^2');
  console.log(`ROAD_W = ${ROAD_W} (was 84); the casing and the lane dashes are deleted.\n`);
  const rows = [];
  let inkFail = 0;
  for (const band of bands) {
    let share = 0;
    let shareGlow = 0;
    let shareNoTerrace = 0;
    let terrace = 0;
    let road = 0;
    let ratio = 0;
    let raster = 0;
    let worst = 0;
    const consts = {
      ROAD_W, CAR_L, CAR_W, DEPOT_W, DEPOT_H, JUNCTION_MARK_R, DEPOT_GLOW_PAD,
      mouthLu: MOUTH_LU[band],
    };
    for (let i = 0; i < inkSeeds; i += 1) {
      const level = generate(i, band);
      const r = inkBudgetForLevel(level, CARS_IN_FLIGHT[band], consts);
      share += r.share;
      shareGlow += r.shareWithGlow;
      shareNoTerrace += r.shareExclTerrace;
      terrace += r.terrace;
      road += r.roadOnly;
      ratio += r.ratio;
      if (r.share > worst) worst = r.share;
      // The raster cross-check is 25x more expensive, so it runs on a tenth of the sweep.
      if (i % 10 === 0) raster += rasterInkShare(level, CARS_IN_FLIGHT[band], consts, buildCurves(level)).share;
    }
    const mean = (100 * share) / inkSeeds;
    const ok = mean <= INK_BUDGET_PCT;
    if (!ok) inkFail += 1;
    rows.push({
      band,
      levels: inkSeeds,
      'cars in flight': CARS_IN_FLIGHT[band].toFixed(2),
      'furniture share %': mean.toFixed(1),
      'worst level %': (100 * worst).toFixed(1),
      'with --depot-glow %': ((100 * shareGlow) / inkSeeds).toFixed(1),
      'road only, no terrace %': ((100 * shareNoTerrace) / inkSeeds).toFixed(1),
      'road LU²': Math.round(road / inkSeeds),
      'terrace LU²': Math.round(terrace / inkSeeds),
      'furniture : actors': ((ratio / inkSeeds)).toFixed(2) + ' : 1',
      'raster cross-check %': ((1000 * raster) / inkSeeds).toFixed(1),
      [`AC-521 (<= ${INK_BUDGET_PCT} %)`]: ok ? 'PASS' : 'FAIL',
    });
  }
  console.log(table(rows));
  console.log('\nui.md §4.6 predicts 63.8 / 59.0 / 61.3 / 57.6 / 56.3 % and AC-521 budgets 65 %.');
  console.log('');
  console.log('THE MEASURED SHARE IS 8 TO 17 pp ABOVE THE PREDICTION AND THE WHOLE OF THE GAP IS THE');
  console.log('TERRACE. §4.6\'s formula lists `+ terraceArea` and §7.6 says the terrace "is counted as');
  console.log('furniture in §4.6\'s budget so that it cannot grow quietly" — but the terrace rect of');
  console.log('§7.6 is 223,000 to 280,000 LU², and the published shares are only reproducible with a');
  console.log('terrace contribution of about 22,000 to 26,000, i.e. roughly its TERRACE_FADE strip.');
  console.log('The `road only, no terrace` column is that reading, and it lands within 4 pp of the');
  console.log('design at every band. Round 8\'s published 80.9 % at band 5 reproduces the same way.');
  console.log('');
  console.log('Round 8 measured 85.2 / 82.5 / 83.9 / 81.7 / 80.9 %. The budget\'s real job is to');
  console.log('stop the number going back UP: a future round that wants a road texture, a shoulder');
  console.log('or a gradient has to fail this to get one.');
  console.log('');
  console.log('The raster column counts LIT UNITS at 4 LU, so two roads meeting at a junction are');
  console.log('counted once and the cars are placed rather than abstracted. The gap between it and');
  console.log('the formula IS the overlap ui.md §4.6 says the proxy ignores — reported, not hidden.');
  console.log('');
  console.log(inkFail === 0 ? 'INK BUDGET: PASS' : 'INK BUDGET: FAIL');
  process.exit(inkFail === 0 ? 0 : 1);
}

const bladeMode = inject === 'wrong-branch' || inject === 'far-chord' ? inject : 'first-segment';
const arrivalInject = inject === 'depot-first' ? 'depot-first' : null;
if (inject && bladeMode === 'first-segment' && arrivalInject === null) {
  console.error('unknown --inject: ' + inject + ' (wrong-branch | far-chord | depot-first)');
  process.exit(2);
}

console.log(`render audit — ${seeds} levels a band, bands ${bands.join('/')}` + (inject ? `, INJECTED: ${inject}` : ''));
console.log('');

// --- AC-504 -------------------------------------------------------------------------------

const blade = auditBladeSeparation({ bands, levels: seeds, mode: bladeMode });
console.log(`AC-504 · clause (i) — blade angular separation between open = 0 and open = 1 (mode: ${bladeMode})`);
console.log(
  table(
    blade.distinct.map((d) => ({
      'separation deg': d.deg.toFixed(2),
      junctions: d.n,
      ['vs ' + BLADE_SEPARATION_FLOOR_DEG + ' deg floor']: d.deg >= BLADE_SEPARATION_FLOOR_DEG ? 'ok' : 'BELOW',
    })),
  ),
);
console.log('');
console.log(`  junctions measured : ${blade.junctions}`);
console.log(`  distinct values    : ${blade.distinct.length}`);
console.log(`  floor              : ${blade.floorDeg.toFixed(2)} deg (floor required: ${BLADE_SEPARATION_FLOOR_DEG})`);
console.log(`  below the floor    : ${blade.below}`);
if (blade.below > 0) {
  console.log(`  worst              : ${blade.worst.deg.toFixed(2)} deg at band ${blade.worst.band}, seed ${blade.worst.seed}, junction ${blade.worst.junctionId}`);
}
const dir = auditBladeDirection({ bands, levels: seeds, mode: bladeMode });
console.log('');
console.log(`AC-504 · clause (ii) — the blade points along the FIRST SEGMENT of out[k], not out[1-k]`);
console.log(`  branch headings checked : ${dir.checked}`);
console.log(`  wrong heading           : ${dir.wrong}`);
if (dir.wrong > 0) {
  console.log(`  worst                   : ${dir.worst.deg.toFixed(2)} deg off on a '${dir.worst.shape}' edge, band ${dir.worst.band}, seed ${dir.worst.seed}, junction ${dir.worst.junctionId}`);
}
const bladeOk = blade.below === 0 && blade.junctions > 0 && dir.wrong === 0 && dir.checked > 0;
console.log(`  AC-504: ${bladeOk ? 'PASS' : 'FAIL'}`);
console.log('');

// AC-504's round-9 requirement: the BLINDNESS IS ASSERTED, not described. Under the
// `wrong-branch` injection clause (ii) must fail and clause (i) must PASS — because swapping
// the two blades swaps the two angles and the separation between a swapped pair is the
// separation between the original pair.
const blind = auditBladeBlindness({ bands, levels: Math.min(seeds, 50) });
console.log('AC-504 · clause (i) is BLIND to a blade drawn along the wrong branch — asserted');
console.log(`  junctions                                    : ${blind.junctions}`);
console.log(`  clause (i) junctions below 90 deg under swap : ${blind.clauseIBelow} (must be 0)`);
console.log(`  clause (ii) wrong headings under swap        : ${blind.clauseIiWrong} (must be > 0)`);
console.log(`  separation histogram unchanged by the swap   : ${blind.histogramsMatch}`);
console.log(`  blindness recorded: ${blind.ok ? 'PASS' : 'FAIL'}`);
if (!blind.ok) process.exitCode = 1;
console.log('');

// --- AC-140 -------------------------------------------------------------------------------

const arrivals = auditArrivalEdges({ bands, levels: seeds, inject: arrivalInject });
console.log('AC-140 · the engine\'s arrival edgeId vs the renderer\'s previous-tick inference' + (arrivalInject ? ` (INJECTED: ${arrivalInject})` : ''));
console.log(
  table(
    arrivals.perBand.map((r) => ({
      band: r.band,
      levels: r.levels,
      arrivals: r.arrivals,
      'at a shared mouth': r.sharedMouth,
      disagreements: r.disagreements,
    })),
  ),
);
console.log('');
console.log(`  arrivals            : ${arrivals.seen} (${arrivals.delivered} delivered, ${arrivals.misrouted} misrouted)`);
console.log(`  at a depot fed by >1 terminal edge : ${arrivals.sharedMouth} (${((100 * arrivals.sharedMouth) / (arrivals.seen || 1)).toFixed(1)} %)`);
console.log(`  edgeId not a terminal edge         : ${arrivals.notTerminal}`);
console.log(`  edges[edgeId].to !== depotId       : ${arrivals.wrongDepot}`);
console.log(`  disagreements                      : ${arrivals.disagreements}`);
for (const ex of arrivals.examples) console.log('    ' + JSON.stringify(ex));
const arrivalsOk =
  arrivals.disagreements === 0 && arrivals.notTerminal === 0 && arrivals.wrongDepot === 0 && arrivals.seen > 0;
console.log(`  AC-140: ${arrivalsOk ? 'PASS' : 'FAIL'}`);
console.log('');

// --- verdict ------------------------------------------------------------------------------

if (inject) {
  const caught = inject === 'depot-first' ? !arrivalsOk : !bladeOk;
  console.log(
    caught
      ? `INJECTION TEST: PASS (the audit fails when it should — ${inject} was caught)`
      : `INJECTION TEST: FAIL (${inject} went undetected; this audit proves nothing)`,
  );
  process.exit(caught ? 0 : 1);
}

console.log(bladeOk && arrivalsOk ? 'RENDER AUDIT: PASS' : 'RENDER AUDIT: FAIL');
process.exit(bladeOk && arrivalsOk ? 0 : 1);
