# Offramp

A real-time attention game for iPhone and Android. Coloured cars enter a road network from
the top, roll along fixed lanes, and must reach the depot matching their colour. The player
taps junctions to flip which branch is open. Cars keep coming and overlap in time; the
pressure is divided attention, not reflex. A level is bounded — deliver the quota and you
win, run out of lives and you lose — and is tuned to finish inside roughly two minutes,
because sustained attention past that is not a thing players have.

Road networks are **procedurally generated**, not authored.

**Stack:** Expo SDK 56, React Native 0.85, React 19, `@shopify/react-native-skia` 2.6.2.
JavaScript, not TypeScript. iPhone first; Android is a first-class target that comes free.

## The architectural rules everything rests on

These are not style preferences. They are the load-bearing decisions.

1. **A pure simulation engine.** `src/engine/` is plain JavaScript with two entry points:
   `step(state, inputs)` advancing exactly one fixed tick, and `apply(state, action)` for a
   player tap. No React, no timers, no `Date.now()`, no `Math.random()`, no floating-point
   wall-clock. Randomness comes only from a seeded PRNG carried inside the state.

2. **Fixed timestep.** The simulation runs at a constant integer tick rate (`TICK_HZ`).
   Frame time never enters the engine. A slow frame advances several ticks; it never
   advances a fraction of one. This is what makes a run reproducible.

3. **A run is a seed plus tick-stamped inputs.** `{seed, difficulty, inputs: [{tick, junctionId}]}`
   replays to a deeply equal final state, every time, on any machine. Every bug report is a
   replayable artifact. **When determinism regresses, that outranks every other finding.**

4. **Rendering is replay, never drive.** The Skia canvas reads simulation state and paints
   it. A dropped frame, a slow device or a backgrounded app cannot corrupt the world. No
   game logic lives in a render callback.

5. **The React layer owns every timer and every cleanup.** Nothing schedules work from
   inside a `setState` updater. React 19 StrictMode is on deliberately in development so
   that double-invocation fails loudly here instead of quietly on a player's phone.

## Repo map

| Path | What it is |
|---|---|
| `docs/development-process.md` | How this project is built. Team, pipeline, verification tiers, inherited incidents. |
| `docs/design/` | The design. Gameplay, generation, UI, and the numbered acceptance criteria. |
| `src/engine/` | Pure simulation and the track generator. Runs in bare Node. |
| `src/render/` | Skia drawing. Reads state, paints, owns no logic. |
| `src/ui/` | React state layer, screens, theme. |
| `tools/` | Headless harnesses — seeded replay, solver bot, pacing sweep, generator audit. |
| `test/` | `node --test` suites. |

## The squad

Three subagents in `.claude/agents/`, run in sequence:

- **game-designer** — owns gameplay, generation rules, UI, and the acceptance criteria.
  Produces `docs/design/`. Writes no production code.
- **game-developer** — implements against approved ACs. Does not invent scope, does not
  redefine an AC to match what it built.
- **game-tester** — verifies by execution and hunts beyond the ACs. Does not fix what it
  finds, does not touch `src/` or `test/`.

The orchestrator (main session) owns git and is the only party that verifies claims across
agents. No agent's report is taken at face value.

## Working rules

- **Ground everything in real files.** Cite `path:line`. A claim in a document is a claim,
  not a fact.
- **Measure, don't assert.** "Level 7 is too hard" is an opinion. "Level 7's constrained
  bot clears 41% of 1,000 seeds against a 75% target" is a finding.
- **Never trust a green check you have not seen fail.** Before relying on a new test or
  harness, inject the fault it is meant to catch and confirm it fails.
- **A check that cannot fail is not a check.**
- **Colour is the match key** — cars carry it, depots carry it. Colour-blind support is a
  secondary cue layered on top, never a change to the rules.
- **One vehicle type: the car.** Top-down, the body is one large colour fill. No trucks,
  buses or bikes.
- No `console.log` in the render path. No dead code. No dependency that is not imported.
