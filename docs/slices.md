# Offramp — slice ledger

**This is the file to read first in a new session.** It says what is done, what is in flight, and
what the next action is. `docs/development-process.md` says *how* work is done; this says *where
it is*.

Last updated: **design round 8** (`c62b84f`) — the owner played the game and redirected it.
148 unit tests and 17 E2E green on `slice-2-play`, but against the *previous* design.

---

## Status at a glance

| Slice | Contents | State |
|---|---|---|
| **0** | Squad, scaffold, toolchain, design | **Done**, merged to `main` |
| **1** | Simulation engine, generator, headless harnesses | **Done**, merged to `main`. Every §7.2 target in band. |
| **1b** | Attention model, entry geometry, difficulty levers | **Done**, merged with slice 1 |
| **2** | React state layer + Skia play surface | **Built and playing** on `slice-2-play`; now being reworked to round 8 |
| **3** | Visual system, motion, accessibility | Not started |
| **4** | Meta progression, persistence | Not started |
| **5** | Polish — sound, haptics, juice | Not started |
| **6** | Store readiness | Not started |

**Branch:** `slice-2-play`, cut from `main`. `main` carries slices 0, 1 and 1b.

---

## → The next action

**Implement design round 8.** The owner played the game for the first time and changed four
things. This is tier-5 feedback and it is not up for debate; `docs/design/` is already revised
and committed at `c62b84f`.

1. **A level is exactly 2:00** (`LEVEL_TICKS = 7200`). `quota`, `phase === 'won'` and the entire
   points system are deleted. Score is cars delivered; three misroutes still ends a run early.
2. **Orthogonal roads only** — horizontal and vertical runs with rounded corners. No Béziers, no
   arc-length tables, no `diagLen`. **Every float leaves `src/engine/`.** New rule **V15**: a pass
   node's outgoing edge is vertical; only a branch changes column.
3. **Smaller everything.** Car 104×66 LU (was 140×84), road 84 (was 104). Both AC floors are now
   tight rather than comfortable: 44.16 pt junction target, 20.24 pt car body.
4. **V14 — the row-0 node is always a pass**, enforced in construction. First decision goes from
   the 717 ms the owner rejected to 2.00–2.65 s.

**22 sites in `generation.md` and 8 ACs are marked `(to be measured)`.** Round 6's numbers are
quoted only as history and **none of them transfers.** The developer's sweep produces the real
ones: all five clear rates, all five `p`, AC-246 gaps, AC-240 rises, tap rate, the attention
report, the actionable-junction oracle, delivery medians, and AC-513's converging-car rate.

Harness changes: `tools/spawn-schedule.mjs` replaces `tools/spawn-margin.mjs`,
`tools/converge.mjs` is new, `tools/pacing.mjs` is **deleted** (the clock makes it trivially
true), `generator-audit --geometry` is new.

Also outstanding from the playtest and slice 2:

- **Backgrounding pauses too eagerly on web.** Correct on a phone — a phone call must not advance
  the simulation — but web is only a dev harness and it interrupted the owner's play session.
  Make it lenient on web only.
- **The title screen's buttons are not centred.** Fixed 340 pt wide and left-aligned, so at any
  width above ~372 they sit left of the title. Measured at three widths.
- **`tools/layout-sweep.mjs` exists now**, but its numbers are stale — the design rect is
  1000×1500 and every geometry constant moved.
- The **depot is materially worse** under orthogonal routing: two cars come within a car length in
  59–301 runs per 1,000, against 0–5 with curves. Two structural repairs were measured and
  rejected. AC-513 now reports a rate and **asks for a screenshot**.

**After that:** rebuild the Android dev build so the owner can play again. That loop — build,
play, redirect — is now the most valuable thing in the project (`development-process.md` §6.9).

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
