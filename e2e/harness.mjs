// Offramp — tier-3 harness: a static server for the Expo web export, and a Chromium page at
// an iPhone viewport (docs/development-process.md §4).
//
// This uses the `playwright` LIBRARY with node:test, not `@playwright/test`. The runner
// package is not installed and adding a dependency to get a second test runner when the repo
// already has one is not a trade worth making.
//
// WHAT TIER 3 PROVES. It drives the real app — the same bundle `npx expo export` produces —
// with real pointer events, and reads `window.__offramp`. That proves input -> state ->
// the renderer's own geometry. IT DOES NOT PROVE THE PAINT: a Skia canvas has no queryable
// elements, so every assertion here is paired with a screenshot, and only the screenshots and
// tier 5 speak to whether a pixel was drawn.

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

export const DIST = process.env.OFFRAMP_WEB_DIST || new URL('../.e2e-web/', import.meta.url).pathname;
export const SHOTS = new URL('../.e2e-shots/', import.meta.url).pathname;

// ui.md §3: the reference device is the iPhone 15/16 at 393 x 852 pt. On web there is no
// env(safe-area-inset-*), so the insets are 0/0 and the play area is taller than on the
// phone — `scale` is identical (0.393, width-bound) and originY differs. That difference is
// real and is stated rather than papered over.
export const VIEWPORT = { width: 393, height: 852 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};

export function serve(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let path = join(root, normalize(decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(root, 'index.html');
    if (!existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'content-length': statSync(path).size,
      // CanvasKit's wasm is 8 MB; without this every page load refetches it.
      'cache-control': 'public, max-age=60',
    });
    createReadStream(path).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export async function openApp(query = '') {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(
      'no web export at ' + DIST + '. Run: npx expo export --platform web --output-dir .e2e-web',
    );
  }
  if (!existsSync(join(DIST, 'canvaskit.wasm'))) {
    throw new Error('canvaskit.wasm is missing from the export — Skia will render nothing on web');
  }
  mkdirSync(SHOTS, { recursive: true });
  const { server, port } = await serve(DIST);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await page.goto('http://127.0.0.1:' + port + '/' + query, { waitUntil: 'load' });
  const close = async () => {
    await context.close();
    await browser.close();
    await new Promise((r) => server.close(r));
  };
  return { page, close, errors, port };
}

/** The published snapshot, or null while the play screen has not mounted. */
export function snap(page) {
  return page.evaluate(() => (typeof window.__offramp === 'undefined' ? null : window.__offramp));
}

/** Poll `window.__offramp` until `pred` holds. Returns the snapshot that satisfied it. */
export async function waitFor(page, pred, { timeout = 20000, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await snap(page);
    if (last && pred(last)) return last;
    if (Date.now() - t0 > timeout) {
      throw new Error(
        'timed out after ' + (Date.now() - t0) + ' ms waiting for ' + label +
          '; last snapshot: ' + JSON.stringify(last && { screen: last.screen, mode: last.mode, tick: last.state && last.state.tick, phase: last.state && last.state.phase, cars: last.cars.length }),
      );
    }
    await page.waitForTimeout(40);
  }
}

export async function shot(page, name) {
  const path = join(SHOTS, name + '.png');
  await page.screenshot({ path });
  return path;
}

/** Start a level from the title screen, the way a player does. */
export async function startPlaying(page) {
  await page.getByTestId('btn-play').waitFor({ timeout: 30000 });
  await page.getByTestId('btn-play').click();
  return waitFor(page, (s) => s.screen === 'play' && s.state !== null, { label: 'the play screen' });
}
