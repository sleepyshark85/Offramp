#!/usr/bin/env node
// tools/render-audit.mjs — the two sweep-scale render claims (AC-140, AC-504).
//
//   node tools/render-audit.mjs                            1,000 levels a band, both audits
//   node tools/render-audit.mjs --seeds 100
//   node tools/render-audit.mjs --inject tangent           AC-504, the slice-2 blade
//   node tools/render-audit.mjs --inject tangent0          AC-504, the blade at the node
//   node tools/render-audit.mjs --inject depot-first       AC-140, the slice-2 mouth lookup
//
// Both of these exist because slice 2 shipped a defect that every check it had was blind to,
// and both were found by looking at the drawing rather than by running anything. So both are
// run against the defect first — `--inject` is not a debugging aid, it is the evidence that a
// green run means something (docs/development-process.md §6.2).
//
//   AC-504  The blade's heading must differ by >= 30 deg between `open === 0` and
//           `open === 1`, at every junction of every level. ui.md §7.3 is normative that the
//           heading is the CHORD to the branch's far node. Slice 2 derived it from the road's
//           tangent, and every edge leaves its node vertically by design
//           (generation.md §2.3), so the same vertical bar was drawn whichever way the switch
//           was set. The old wording — "rotated to lie along out[k]" — was satisfied by that.
//
//   AC-140  `delivered` and `misrouted` carry `edgeId`, the terminal edge the car arrived on.
//           The check is that the engine's value equals the previous-tick inference the
//           renderer used through slice 2, on every arrival — which is what makes deleting
//           that workaround safe rather than merely unnecessary.

import { BANDS } from '../src/engine/index.js';
import {
  BLADE_SEPARATION_FLOOR_DEG,
  auditArrivalEdges,
  auditBladeSeparation,
} from './lib/render-audit.mjs';
import { arg, table } from './lib/report.mjs';

const seeds = Number(arg('seeds', 1000));
const inject = arg('inject', null);
const bands = BANDS.slice(1).map((p) => p.band);

const bladeMode = inject === 'tangent' || inject === 'tangent0' ? inject : 'chord';
const arrivalInject = inject === 'depot-first' ? 'depot-first' : null;
if (inject && bladeMode === 'chord' && arrivalInject === null) {
  console.error('unknown --inject: ' + inject + ' (tangent | tangent0 | depot-first)');
  process.exit(2);
}

console.log(`render audit — ${seeds} levels a band, bands ${bands.join('/')}` + (inject ? `, INJECTED: ${inject}` : ''));
console.log('');

// --- AC-504 -------------------------------------------------------------------------------

const blade = auditBladeSeparation({ bands, levels: seeds, mode: bladeMode });
console.log(`AC-504 · blade angular separation between open = 0 and open = 1 (mode: ${bladeMode})`);
console.log(
  table(
    blade.distinct.map((d) => ({
      'separation deg': d.deg.toFixed(2),
      junctions: d.n,
      'vs 30 deg floor': d.deg >= BLADE_SEPARATION_FLOOR_DEG ? 'ok' : 'BELOW',
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
const bladeOk = blade.below === 0 && blade.junctions > 0;
console.log(`  AC-504: ${bladeOk ? 'PASS' : 'FAIL'}`);
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
