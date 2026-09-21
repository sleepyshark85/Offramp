// Offramp — the five colour glyphs (ui.md §5.1, §6.2).
//
// Shapes are chosen for maximum silhouette difference: a filled disc, a filled equilateral
// triangle apex-up, a filled square, a plus with arms 0.33 x s thick, and two horizontal bars
// with a gap equal to the bar height. No two share an outline family and no shape is another
// shape rotated (ui.md §6.2).
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
    default:
      throw new Error('UNKNOWN_GLYPH: ' + index);
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
