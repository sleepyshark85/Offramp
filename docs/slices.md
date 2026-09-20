# Offramp — slice ledger

**This is the file to read first in a new session.** It says what is done, what is in flight, and
what the next action is. `docs/development-process.md` says *how* work is done; this says *where
it is*.

Last updated: slice 1b, design round 4 committed (`2f85acb`).

---

## Status at a glance

| Slice | Contents | State |
|---|---|---|
| **0** | Squad, scaffold, toolchain, design | **Done**, merged to `main` |
| **1** | Simulation engine, generator, headless harnesses | **Code done and green; difficulty not yet tuned.** On `slice-1-engine`, draft PR #1 |
| **1b** | Bot rebuilt to the attention model; 6 defects fixed; entry geometry corrected | **Design committed, implementation pending** |
| **2** | React state layer + Skia play surface | Not started |
| **3** | Visual system, motion, accessibility | Not started |
| **4** | Meta progression, persistence | Not started |
| **5** | Polish — sound, haptics, juice | Not started |
| **6** | Store readiness | Not started |

**Branch:** `slice-1-engine`. **`main` has slice 0 only.** Do not branch new work off
`slice-1-engine` unless the dependency is real (`development-process.md` §6.5).

---

## → The next action

**Developer round 3.** The designer has specified four rounds of changes that are not yet in code.
Everything below is decided and committed in `docs/design/`; none of it is implemented.

1. **Geometry:** `ROW0_Y` 160 → **220**, `DEPOT_Y` 1360 → **1420** (so `ENTRY_LEN` = 160 LU).
   Route height stays 1200. Only `y` translates, so no topology, tap target or `diagLen` changes.
2. **`SPAWN_SLACK` becomes per-band: `8 / 9 / 9 / 9 / 10`.** Band 2 is 9, not 8 — it crosses an
   integer boundary under the new `transitMax`.
3. **V13** — at least `Ja` junctions must have incomparable colour sets, `Ja = 3/3/4/5/7`.
4. **New ACs to implement:** AC-112 (reworded), AC-115 (per-level, tolerance 1), AC-138 (initial
   `open` all zeros), AC-139 (spawn margin ≥ 2 under injected misroutes), AC-244 (each validity
   rule invoked directly on a violating fixture), AC-245 (first-decision floor ≥ 40 ticks),
   AC-411 (depot row clearance), AC-242/AC-243 (static and dynamic actionable-`J`).
5. **Known stale spots:** `tools/bot.mjs:248` hard-codes `ENTRY_LEN = 100` in its row-0
   diagnostic. `test/geometry.test.js`'s row-y table needs +60. `test/bot.test.js` AC-240 needs
   the new headroom clause.
6. **`test/bot.test.js:263`** — the band-1 assertion loosened to "> 0 cleared" during slice 1b.
   Band 1 now measures 98.0 %, in band. **Re-tighten it to a real threshold.** This was carried
   forward explicitly and this is the moment it asked for.
7. **Missing harnesses:** `tools/spawn-margin.mjs` (AC-139) and `tools/layout-sweep.mjs`
   (`development-process.md` §9, AC-604 — that one is slice 2) do not exist.
8. **Then re-measure everything in one sweep** — V13 and the geometry change both alter the level
   population, so every generator-derived number is stale.

**After that, and only after that:** close the clear-rate gap using `generation.md` §7.4's lever
order, starting at Lever 0 (iso-duration: raise `interval`, rescale `quota`). Not before the
sweep, and never by touching a bot constant — §7.4 forbids it.

---

## Slice 0 — done

Scaffold (Expo SDK 56 / RN 0.85 / React 19 / Skia 2.6.2, JavaScript), the three-agent squad in
`.claude/agents/`, the process document, and the full design.

Two things worth knowing rather than rediscovering:

- **Skia renders nothing on web without help**, and web is where tier-3 Playwright verification
  runs. It needs `public/canvaskit.wasm` served *and* the app import deferred until `LoadSkiaWeb`
  resolves — a static `import App` evaluates Skia's module graph too early and throws regardless
  of the wasm being present. Both are in `index.js`.
- **`npm ci` once failed on a fresh clone** because `public/`'s only file is gitignored and git
  does not carry empty directories. `tools/sync-wasm.mjs` mkdirs. Do not inline it back.

## Slice 1 — code done, green, difficulty open

`src/engine/` (simulation + generator), `test/` (93 tests), `tools/` (replay, bot, pacing,
generator-audit). CI runs all of it plus iOS/Android/web bundles.

**What is proven:** determinism in-process and cross-process; generator audit clean over 25,000
levels; the unconstrained solver clears 100 % of levels; completion times inside every band with
the slowest run anywhere at 113.5 s against a 130 s ceiling; every harness proven to fail before
being trusted.

**What is not:** the constrained-bot clear rate. First trustworthy reading is
**98.0 / 79.3 / 38.4 / 19.1 / 2.0 %** against targets of ≥95 / 86–97 / 76–92 / 66–85 / 55–78. R2
(the ≥4 pp gradient) passes everywhere; R3 (≤15 pp) fails at all four pairs. **That gap is now a
statement about the game, not about the gauge** — which took three rounds to be able to say.

## Slice 1b — design committed, implementation pending

Three findings, each of which changed the design:

1. **The bot's spec was ambiguous** and the clear rate swung 0.7 % → 30 % → 100 % across three
   readings of it. Rewritten as a labelled ladder where every branch returns.
2. **The bot measured timing, not attention.** It now has a working set of 3, pays ticks to
   glance/acquire/switch, forgets after 2 s, and only avoids breaking cars it currently holds.
   **AC-240** guards this: strip attention, keep timing, and the clear rate must rise ≥ 20 pp.
3. **The entry road was too short to hold a decision.** A junction on row 0 was unreachable —
   450 ms of travel against 27 ticks of unavoidable latency — so bands 2–5 were measuring
   `P(row 0 is a pass node)`, a coin flip. Fixed by translating the lattice down 60 LU.
   AC-240 then passes at bands 2–5 **with no change to the bot**, which is what proved the
   instrument had been right all along.

## Slices 2–6 — not started

Slice 2 is the React state layer and the Skia play surface, and it is done when **the game plays
on a real phone**. Read `docs/device-testing.md` before starting it: Skia is a native module, so
Expo Go cannot run this app and iteration goes through an EAS cloud dev build.

Three things slice 2 will need that already exist: `src/engine/serialise.js` for the
`window.__offramp` snapshot tier-3 asserts against, `src/engine/clock.js` for the ms→tick
boundary (it already guards non-finite deltas), and `ui.md` §7.6's depot-mouth draw order, which
changes the car and depot layer ordering.

`eas init` has **not** been run — `app.json` has no `extra.eas.projectId`, so no device build has
ever been made.

---

## Reading order for a new session

1. This file.
2. `CLAUDE.md` — the architectural rules everything rests on.
3. `docs/development-process.md` — especially **§6, the incident log**. Six of the seven incidents
   are about verification rather than code, and two of them happened in this project.
4. `docs/design/` — `gameplay.md`, `generation.md`, `ui.md`, `acceptance-criteria.md` (157 ACs).
5. `docs/reports/` — what was actually verified, by whom, and what was found.

## Habits this project runs on, which are not optional

- **No agent's report is acted on until it has been re-run.** This caught a wrong number of mine
  that had already become an unsatisfiable acceptance criterion one step downstream
  (`development-process.md` §6.6).
- **Never trust a green check you have not seen fail.** Two checks in this repo were found
  asserting nothing while reporting green.
- **Measure, don't assert.** Three design decisions here were reversed by measurement, including
  one where the obvious fix made the game easier.
- **The orchestrator owns git.** Agents do not commit. Branch each slice from `main`.
