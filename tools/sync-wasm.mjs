#!/usr/bin/env node
// Copies CanvasKit's wasm binary next to the web bundle.
//
// Skia initialises itself on native but not on web, where CanvasKit is a WASM
// module that has to be fetched before the first <Canvas> renders. `index.js`
// loads it from `/canvaskit.wasm`, and `public/` is what Expo copies to the web
// output root.
//
// The binary is 8MB with an authoritative source in the lockfile, so it is
// gitignored and regenerated here on postinstall — which means it cannot drift
// from the JS that loads it.
//
// `public/` must be created, not assumed: its only file is gitignored, so git
// does not carry the directory and a fresh clone does not have it.

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'public', 'canvaskit.wasm');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm'), dest);
process.stdout.write(`sync-wasm: ${dest}\n`);
