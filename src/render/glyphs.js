// Offramp — the SIX colour glyphs (ui.md §5.1, §6.2).
//
// Shapes are chosen for maximum silhouette difference: a filled disc, a filled equilateral
// triangle apex-up, a filled square, a plus with arms 0.33 x s thick, two horizontal bars with
// a gap equal to the bar height, and — new in round 9, for Lime — a filled diamond
// (ui.md §5.1's table).
//
// ROUND 9's SIXTH GLYPH SITS AGAINST §6.2's OWN WORDING AND THAT IS RECORDED HERE RATHER THAN
// RESOLVED QUIETLY. §6.2 says "no shape is another shape rotated", and a diamond is Rose's
// square at 45 degrees. The sentence lists five shapes and was not re-derived when ui.md §5.1
// assigned Lime the diamond; §5.2 then leans on the assignment ("diamond vs triangle separates
// them anyway"). The rule is satisfiable in substance because every glyph is COUNTER-ROTATED
// TO SCREEN-UPRIGHT (§6.2, AC-603) — which is the rule §6.2 introduces one sentence earlier,
// with the words "without this, square and diamond would be the same shape". With the
// counter-rotation in force they are two fixed, different outlines; without it they are one.
// So the diamond is drawn as specified, and the conflicting sentence goes back to the designer.
//
// Every path is centred on (0, 0) and sized to fit an `s x s` box, so the caller places it by
// translating and — on a car — counter-rotating (ui.md §6.2). Paths are built once per
// (glyph, size) and cached: nothing here runs per frame.

import { Skia } from '@shopify/react-native-skia';

const cache = new Map();

/** ui.md §6.2 — "a plus with arms 0.33 x s thick", held as an exact third. */
const PLUS_ARM_FRACTION = 1 / 3;

function build(index, s) {
  const p = Skia.Path.Make();
  const h = s / 2;
  switch (index) {
    case 0: // Ember — filled disc
      p.addCircle(0, 0, h);
      break;
    case 1: { // Sky — filled equilateral triangle, apex up
      const th = (s * Math.sqrt(3)) / 2; // height of an equilateral triangle of side s
      p.moveTo(0, -th / 2);
      p.lineTo(h, th / 2);
      p.lineTo(-h, th / 2);
      p.close();
      break;
    }
    case 2: // Rose — filled square
      p.addRect(Skia.XYWHRect(-h, -h, s, s));
      break;
    case 3: { // Teal — plus
      const a = (s * PLUS_ARM_FRACTION) / 2;
      p.addRect(Skia.XYWHRect(-a, -h, a * 2, s));
      p.addRect(Skia.XYWHRect(-h, -a, s, a * 2));
      break;
    }
    case 4: { // Iris — two horizontal bars, gap equal to the bar height
      const bar = s / 3;
      p.addRect(Skia.XYWHRect(-h, -h, s, bar));
      p.addRect(Skia.XYWHRect(-h, h - bar, s, bar));
      break;
    }
    case 5: // Lime — filled diamond, the square's outline at 45 degrees (ui.md §5.1)
      p.moveTo(0, -h);
      p.lineTo(h, 0);
      p.lineTo(0, h);
      p.lineTo(-h, 0);
      p.close();
      break;
    default:
      // A missing glyph is not a missing glyph: a throw inside the Skia element tree takes
      // the WHOLE CANVAS down, so the play surface renders nothing at all and the HUD keeps
      // working. Round 9 shipped `K = 6` before this case existed and band 5 painted a black
      // rectangle; the tier-3 suite did not see it because it only plays level 1. The message
      // names the palette length so the next person reads "the palette grew" rather than
      // "Skia broke".
      throw new Error(
        'UNKNOWN_GLYPH: ' + index + ' — every PALETTE entry needs a glyph (ui.md §5.1, §6.2)',
      );
  }
  return p;
}

export function glyphPath(index, size) {
  const key = index + ':' + size;
  let p = cache.get(key);
  if (!p) {
    p = build(index, size);
    cache.set(key, p);
  }
  return p;
}
