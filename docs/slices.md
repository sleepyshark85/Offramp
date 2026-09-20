# Offramp — slice ledger

**This is the file to read first in a new session.** It says what is done, what is in flight, and
what the next action is. `docs/development-process.md` says *how* work is done; this says *where
it is*.

Last updated: developer round 4 committed (`7b28dd1`). 105 tests green.

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

**Designer round 6: pull the difficulty levers, and fix three AC wording defects.**

Round 4 implemented onset capture. **The bimodality is gone** — the row-0 split collapsed from
0.2/32.7/80.1/95.3/19.8 pp to 0.2/1.0/3.2/30.2/9.2, and AC-246 passes at every band with the
first decision now as reliable as every other one. 105 tests green, determinism re-verified,
and §7.2.4 / §7.1.8 / §7.1.10 are now fully re-derivable from this repo.

**What is left is the difficulty curve itself.** Clear rates are
**99.9 / 99.3 / 97.2 / 68.9 / 2.6 %** against targets of ≥95 / 86–97 / 76–92 / 66–85 / 55–78:

| pair | drop | R2 (≥4 pp) | R3 (≤15 pp) |
|---|---|---|---|
| 1→2 | 0.6 pp | **FAIL** | pass |
| 2→3 | 2.1 pp | **FAIL** | pass |
| 3→4 | 28.3 pp | pass | **FAIL** |
| 4→5 | 66.3 pp | pass | **FAIL** |

Bands 1–3 are flat and indistinguishable; bands 4–5 fall off a cliff. This is now a real statement
about the game, measured on an instrument that has passed its own sensitivity guard — which is
what the last four rounds bought.

Use `generation.md` §7.4's lever order, starting at **Lever 0** (iso-duration: raise `interval`,
rescale `quota` by `1 + round((quota−1)·interval/interval')`). Constraints that must all still
hold afterwards: §7.3's duration bands, AC-231's 130 s ceiling, AC-139's spawn margin re-derived
from the new parameters, AC-233's tap ceiling, AC-234's variety floors, and **AC-246** — band 5
sits at 81 % of its ceiling, and the ceiling is a function of `quota`, so a lever that cuts
`quota` loosens it and one that cuts `interval` tightens it. Never touch a bot constant.

**Three AC wording defects found by the developer, all confirmed:**

1. **AC-246's parenthesis has two readings, and one is not a working instrument.** Under the
   reachable-colour-*set* reading the gaps go negative at every band under *both* sweeps, so the
   check would pass the fault it exists to catch. Tighten it to the per-colour reading.
2. **AC-247's "exactly the number of cars that spawned" is unachievable** — a car still in flight
   at level end is never glanced at, so the ratio is 0.998–0.999.
3. **§8's harness table contradicts AC-246 about band 1**, saying the injection must fail at every
   band. Band 1 never had the defect and correctly passes.

**After that:** developer round 5 implements and re-measures, then **slice 1 merges to `main`**
and slice 2 begins.

### Carried into slice 3 — do not lose this one

**AC-517 (a car's arrival is an abrupt onset) is load-bearing for a *measurement*, not just for a
look.** The visual system originally specified a 140 ms fade-in for arriving cars. A gradual
luminance ramp is precisely the manipulation that abolishes onset capture — the mechanism the
whole bot model, and therefore every §7.2 number, now rests on. If the renderer ships a fade-in,
the drawing falsifies the player model and **nothing in the clear rate would show it.**

### Still outstanding regardless

- `tools/layout-sweep.mjs` does not exist (`development-process.md` §9, AC-604). Slice 2.
  AC-411's device-matrix clause waits on it.
- `eas init` has never been run — no `extra.eas.projectId`, so no device build exists and tier 5
  has never happened.
- `docs/design` §6.2's distinct-network counts and drawn-`J` means still differ from this repo in
  the last digit. Immaterial to every verdict; re-state them from a real run when convenient.

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
