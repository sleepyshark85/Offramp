// Offramp — edge geometry for the harnesses (generation.md §2.3, §3.4).
//
// This file used to hold its own copy of the arc-length table, with a comment saying it was
// "the same 65-entry table the renderer will build". Two implementations that have to agree
// is the bug shape rather than its absence (docs/development-process.md §6.3): the bot
// measures where a car is in order to speak about what the player can see, and if the
// harness's curve and the renderer's curve drifted apart, every §7.2 number would be about a
// picture nobody is shown.
//
// So slice 2 removed the second source. src/render/geometry.js is the one implementation;
// this module re-exports it. `node tools/bot.mjs --seeds 200` and `node tools/pacing.mjs
// --seeds 200` produce byte-identical output across the change.

export { buildCurves, carPoint } from '../../src/render/geometry.js';
