# Offramp — slice ledger

**This is the file to read first in a new session.** It says what is done, what is in flight, and
what the next action is. `docs/development-process.md` says *how* work is done; this says *where
it is*.

Last updated: **round 8 implemented** (`5c03e4a`). 157 unit tests and 19 E2E green on
`slice-2-play`. Design round 9 (difficulty levers) is in flight.

---

## Status at a glance

| Slice | Contents | State |
|---|---|---|
| **0** | Squad, scaffold, toolchain, design | **Done**, merged to `main` |
| **1** | Simulation engine, generator, headless harnesses | **Done**, merged to `main`. Every §7.2 target in band. |
| **1b** | Attention model, entry geometry, difficulty levers | **Done**, merged with slice 1 |
| **2** | React state layer + Skia play surface | **Built, playing, reworked to round 8**, on `slice-2-play`. Not yet merged. |
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

### Queued by the owner — the Train of Thought identity question

**Deferred by the owner, not dropped.** To be taken up after the current lever round.

The owner played round 8: *"better. But it feels so different with train of thought, in a worst
way."* Three structural divergences from the game this reimplements:

| | the reference game | Offramp today |
|---|---|---|
| entry points | several, spatially separated | **one** |
| network | a dense web with merges | a merge-free tree |
| things moving at once | many | **2.7–3.8, flat from band 2** |

**Two of the three rejections were measured under a geometry that no longer exists:**

- **`gameplay.md` §8.1 dropped two entries** because a merge-free tree needs `K−1` terminal
  columns per entry, so two entries at four colours needed six columns, which broke the 44 pt tap
  target at 320 pt width. Round 8 moved every number in that argument. This is the biggest
  divergence: "divided attention" was meant to be **spatial**, and with one entry it is only
  temporal — everything arrives down the same road, in sequence.
- **§8.2 rejected merges** because preventing convergence required equal **Bézier arc length** on
  every path, which rejected essentially every candidate. Path length is now `|Δx| + |Δy|` in
  integers, and equalising integer lengths on a lattice is a different problem.

Neither is to be reopened casually — both are recorded rejections with real measurements behind
them. The point is that `development-process.md` §6.4 applies to our own conclusions too: *a
snapshot is a snapshot, not the truth.*

**The likely shared cause of the flat ladder and the sparse feel:** cars in flight measure
2.72 / 3.70 / 3.74 / 3.77 / 3.66 — flat from band 2, never above four. Orthogonal jogs made
journeys 20–30 % longer while `interval` falls only 8.6 % across bands 3–5. The two cancel.

**After that:** rebuild the Android dev build so the owner can play again. That loop — build,
play, redirect — is now the most valuable thing in the project (`development-process.md` §6.9).

---

## What each slice actually contains

### Slice 0 — done, on `main`

Scaffold (Expo SDK 56 / RN 0.85 / React 19 / Skia 2.6.2, JavaScript), the three-agent squad in
`.claude/agents/`, the process document, and the first full design.

Two things worth knowing rather than rediscovering:

- **Skia renders nothing on web without help**, and web is where tier-3 verification runs. It
  needs `public/canvaskit.wasm` served *and* the app import deferred until `LoadSkiaWeb` resolves
  — a static `import App` evaluates Skia's module graph too early and throws regardless of the
  wasm being present. Both are in `index.js`.
- **`npm ci` once failed on a fresh clone** because `public/`'s only file is gitignored and git
  does not carry empty directories. `tools/sync-wasm.mjs` mkdirs. Do not inline it back.

### Slice 1 + 1b — done, on `main`

The pure simulation, the generator, and the headless harnesses. It took six design rounds, and
what they bought was not the engine — it was an instrument that measures the right thing:

1. The bot's specification was ambiguous; one band's clear rate swung 0.7 % → 30 % → 100 % across
   three defensible readings of it.
2. The rebuilt bot modelled **timing**, not attention. A sensitivity guard the designer wrote
   against its own self-deception (**AC-240**) is what caught that.
3. The entry road was too short to hold a decision, so most bands were measuring a generator coin
   flip rather than difficulty.
4. The remaining bimodality was one under-served decision amplified by a binomial threshold.
5. The old `quota` ladder left 1.2 pp of per-car error for the whole five-band range — inside one
   standard error of failing. Not impossible: **unmeasurable**.

### Slice 2 — built and playing, on `slice-2-play`, not merged

React state layer, Skia play surface, tiers 3 and 4. Then reworked twice: design round 7 (two live
defects found while ratifying six values the spec never defined) and **design round 8**, the
owner's redirect.

`src/engine/serialise.js` feeds `window.__offramp`, which is how tier 3 sees state at all — a Skia
canvas has no queryable elements. `src/engine/clock.js` is the sole ms→tick boundary.

### Slices 3–6 — not started

3 is the visual system, motion and accessibility. 4 is progression and persistence. 5 is sound,
haptics and juice. 6 is store readiness.

**Carried into slice 3, and load-bearing for a measurement rather than for a look:** **AC-517**
requires a car's arrival to be an abrupt onset, never a fade. A gradual luminance ramp abolishes
onset capture, which is the mechanism the bot model and every §7.2 number rest on. If the renderer
ships a fade-in, the drawing falsifies the player model and **nothing in the clear rate would
show it.**

---

## Device builds

`eas init` **has** been run; `app.json` carries the project id. **One Android dev build exists**
and installs, which proved the native Skia path compiles — but it predates round 8 and is stale.

`expo-dev-client` is installed. It was missing until the first real build attempt refused, after
`docs/device-testing.md` had described the flow since slice 0 and three agents had relied on it. A
documented procedure that has never been executed is a plan, not a path.

iOS has never been built: it needs the owner's Apple credentials at an interactive prompt.

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
