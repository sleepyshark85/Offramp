# Offramp

A real-time attention game for iPhone and Android.

Coloured cars enter a road network from the top and roll down at constant speed. Depots at the
bottom each wear a colour. Junctions along the way have two branches, one open; tapping a
junction flips which. Route each car into the depot matching its colour. Cars keep coming and
overlap in time — the pressure is **divided attention**, not reflex.

Levels are bounded: deliver the quota and you win, lose your lives and you don't. A level runs
roughly 50 seconds at the start of the ladder and about 110 at the top, with a hard ceiling of
130 for any seed, because sustained attention past about two minutes is not something players
have.

Road networks are **procedurally generated**, not authored.

Free, offline, no accounts, no ads, no analytics, no network calls of any kind.

## Look

A night road seen from directly above. Dark asphalt, bright painted lane edges, saturated
vehicle paint. The reference points are motorway signage and a traffic-control screen, not a toy
train set. Three rules carry it: the road network *is* the screen; nothing decorative moves, so
every animation reports a state change; and colour is reserved — the five car colours belong to
cars and depots and appear nowhere else.

The five car colours were chosen by constrained optimisation rather than by eye, maximising the
minimum CIEDE2000 separation under simulated protanopia and deuteranopia. Every one clears
4.2 : 1 against the road surface. A shape glyph rides on every car and depot face, always on,
which is what carries tritanopia — where two pairs collapse to ΔE 8.2 and colour alone would not
be enough.

## Stack

Expo SDK 56 · React Native 0.85 · React 19 · `@shopify/react-native-skia` 2.6.2 · JavaScript.

Skia is a native module and is **not** in the Expo Go runtime, so Expo Go cannot run this app.
Development runs through an EAS cloud dev build — see [`docs/device-testing.md`](docs/device-testing.md),
which also explains the rebuild boundary that costs a day when you don't know it.

## Layout

| Path | What it is |
|---|---|
| `docs/development-process.md` | How this is built — team, pipeline, the five verification tiers, the incident log |
| `docs/design/` | The design: gameplay, generation, UI, and 134 numbered acceptance criteria |
| `docs/reports/` | Verification reports — the tester's, and the orchestrator's checks of agent claims |
| `src/engine/` | Pure simulation and the track generator. Runs in bare Node, no renderer. |
| `src/render/` | Skia drawing. Reads state, paints, owns no logic. |
| `src/ui/` | React state layer, screens, theme |
| `tools/` | Headless harnesses — replay, solver bots, generator audit, spawn schedule, converging cars, layout sweep |
| `test/` | `node --test` suites |

## Running the checks

```bash
npm test                                    # engine unit + invariant tests
node tools/replay.mjs --seed 42             # seeded run as ASCII; must be identical every time
node tools/bot.mjs --seeds 1000             # constrained solver over the generator
node tools/generator-audit.mjs --seeds 5000 # structural validity of generated networks
node tools/generator-audit.mjs --geometry   # AC-206/AC-207: orthogonal roads are never one road
node tools/spawn-schedule.mjs --seeds 2000  # the schedule is exactly the cars that fit in 2:00
node tools/converge.mjs --seeds 1000        # AC-513: two cars on a shared depot approach
node docs/design/check-ac-refs.mjs          # dangling / duplicate AC references
node tools/layout-sweep.mjs                 # viewport sweep; must be 0 overflowing
```

`tools/pacing.mjs` is **deleted**. It measured completion time, and under a fixed two-minute
clock every level is exactly 7,200 ticks, so there is nothing left to measure.
`tools/spawn-margin.mjs` is replaced by `tools/spawn-schedule.mjs`: the margin it measured does
not exist any more, because the schedule is computed exactly rather than guessed.

## The three decisions worth knowing

**The simulation is a fixed-timestep integer machine.** 60 Hz, positions as integers in
milli-layout-units along a graph edge, never accumulated floats — `distance += 0.0567` over 7,200
ticks is not the same number on an arm64 phone and an x86 CI box. A run is a seed plus a list of
`{tick, junctionId}` taps, and it replays bit-identically. Every bug report is a replayable
artifact, and rendering is a *replay* of state the engine already resolved, never a driver of it.

**Networks are merge-free trees — roads divide but never rejoin.** This was forced by
measurement, not taste. Stopping two cars converging onto a shared edge requires every path to a
node to have equal arc length, and that constraint rejected essentially every candidate: zero
valid networks in 2,000 seeds per band at bands 2–5, against 3000/3000 merge-free. Merge-free
buys three guarantees by construction — two cars share an edge only if they took the same path,
every junction has at least a one-second flip window, and planarity needs no geometric test.

**A junction's state is read at the instant a car transitions onto its outgoing edge**, and at no
other time. A car that has crossed never re-routes; flipping the switch behind it does nothing.
Inputs apply before movement within a tick, so if the car hasn't reached the junction when you
tap, your tap counts. There is no hidden commit window.

## Licence

Personal project. Not affiliated with, endorsed by, or derived from the code or assets of any
existing product.
