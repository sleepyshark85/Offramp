# Offramp — Gameplay and Simulation Model

Slice-0 design. This document defines the rules, the simulation model in the exact terms the
engine must implement, scoring, lives, difficulty and progression. It is the contract for
`src/engine/`.

Companion documents: [`generation.md`](generation.md) (the track generator),
[`ui.md`](ui.md) (visual system and layout), [`acceptance-criteria.md`](acceptance-criteria.md)
(numbered, testable ACs).

Every constant named in **SCREAMING_SNAKE** in this document is a literal the engine exports
from a single constants module. There are no magic numbers in the implementation.

---

## 1. The loop in one paragraph

Coloured cars enter a road network from a single entry at the top and roll downhill at a
constant speed. Depots sit at the bottom, one per colour. Junctions along the network have two
outgoing branches; exactly one is open, and tapping the junction flips which. A car that enters
a depot of its own colour is **delivered** and counts toward the level's quota. A car that
enters any other depot is **misrouted** and costs a life. Deliver the quota and the level is
won; lose all three lives and it is lost.

The pressure is **divided attention**. Several cars are in flight at once, each needing up to
four junction states to be correct by the time it arrives. Nothing in the game rewards reacting
faster than about 400 ms (§4.6 proves the floor), and nothing punishes planning ahead.

---

## 2. The simulation model

### 2.1 Tick rate

```
TICK_HZ           = 60          // ticks per second, integer, constant
MAX_CATCHUP_TICKS = 8           // per animation frame
```

**Why 60.** A tick is 16.667 ms. That is below the precision of a human tap, so no tap ever
feels quantised — the worst-case input latency the model introduces is one tick (§3.3). It also
keeps the per-tick position delta small (3.0–3.8 lu, §2.2), which means the "advance and
transition" loop in §2.5 is provably single-pass. 30 Hz would halve the step cost and introduce
a 33 ms quantisation right at junction-entry boundaries, which is exactly where the game's
fairness lives.

**Converting elapsed time to ticks — normative, and the integer form is required.** The React
layer accumulates real elapsed milliseconds and converts to whole ticks with exactly this
arithmetic:

```
acc += dtMs                                   // float milliseconds, from the frame callback
n    = Math.floor(acc * TICK_HZ / 1000)       // multiply FIRST, then divide
if (n > MAX_CATCHUP_TICKS) { n = MAX_CATCHUP_TICKS; acc = 0 }
else                       { acc -= n * 1000 / TICK_HZ }
for (let i = 0; i < n; i++) state = step(state, inputsForTick())
```

`Math.floor(acc * TICK_HZ / 1000)` and `Math.floor(acc / (1000 / TICK_HZ))` are **not** the same
function. `1000 / 60` is `16.666666666666668` in IEEE 754 — very slightly *above* one sixtieth of
a second — so the second form returns **2** for a 50 ms frame where the first returns the correct
**3**. The divide-first form is a silent one-tick-per-frame loss under exactly the conditions
(a frame that is a whole multiple of the tick period) where correctness is most visible. The
integer-first form is required by [AC-805](acceptance-criteria.md) and the divide-first form is
the fault [AC-816](acceptance-criteria.md) injects to prove AC-805 can fail.

`acc` is a float and it lives in the React layer only. Its residue can never perturb the
simulation, because the only thing that crosses into the engine is the integer `n`.

**Catch-up.** The layer calls `step()` at most `MAX_CATCHUP_TICKS` times per frame and
**discards** any remainder beyond that, resetting its accumulator to zero. Consequences, stated
plainly:

- On a device that cannot sustain 60 fps, world time runs slower than wall time. The level takes
  longer in seconds but is identical in ticks. That is the correct trade: a time-skip would
  teleport cars past junctions the player was about to flip.
- A run's record is a tick stream, so replay is unaffected by whether ticks were dropped live.
- On resume from background the accumulator is reset to zero and no catch-up is performed at all
  (§6.2). A phone call is not extra ticks.

### 2.2 Position: fixed-point integers along an edge

A car is **always on exactly one edge**. It is never "at" a node — node traversal is
instantaneous and happens inside a tick (§2.5). This single decision removes an entire class of
ambiguity, including the question of what it means to tap a junction a car is sitting on (§3.4).

```
LU        // layout unit: the integer coordinate system of the design space (§4.1)
MLU = 1000 // milli-layout-units per LU. All simulation distances are integers in MLU.
```

A car's state is:

```
{ id: int, colour: int, edgeId: int, progress: int }   // progress in MLU, 0 <= progress < edge.lengthMlu
```

Advancing is `progress += speedMluPerTick`, an integer addition. There is no float anywhere in
the simulation. `distance += 0.0567` over 7,200 ticks is not the same number on an arm64 phone
and an x86 CI box; `progress += 3400` is.

Each edge carries an integer `lengthMlu`. Edge lengths come from the band table in
[`generation.md` §3](generation.md#3-geometry-how-the-graph-maps-to-the-screen), as literals — they are **not** computed at
runtime, because `Math.hypot` and `Math.cbrt` are not required to be bit-identical across
JavaScript engines, and an edge length that differs by one MLU between two machines is a
determinism regression.

Screen position is derived from `(edgeId, progress)` by the renderer only. The engine never
computes an x or a y.

### 2.3 The graph

See [`generation.md` §2](generation.md#2-the-network-topology-model) for the full topology
model. The engine consumes it as immutable level data:

```
node = { id, row, col, x, y, kind: 'entry'|'branch'|'pass'|'depot',
         out: [edgeId, ...],          // length 2 for 'branch', 1 for 'entry'/'pass', 0 for 'depot'
         junctionId: int | null,      // set iff kind === 'branch'
         depotColour: int | null }    // set iff kind === 'depot'

edge = { id, from: nodeId, to: nodeId, lengthMlu: int,
         shape: 'entry'|'straight'|'diagL'|'diagR' }
```

For a `branch` node, `out[0]` is the edge whose target node has the **smaller column index**
(visually the left branch) and `out[1]` the larger. The two targets always differ, so the order
is total and deterministic. `junction.open` is `0` or `1` and indexes directly into `out`.

### 2.4 State shape

```
state = {
  tick:        int,        // the tick about to be simulated
  phase:       'running' | 'won' | 'lost',
  level:       <immutable level data from the generator>,
  rng:         uint32,     // spawn stream PRNG state (§2.7)
  cars:        [car, ...], // strictly ascending by id
  open:        Uint8Array, // indexed by junctionId, values 0|1
  nextSpawn:   int,        // index into level.spawns
  delivered:   int,
  misrouted:   int,
  lives:       int,
  score:       int,
  streak:      int,
  bestStreak:  int,
  events:      [event, ...] // cleared at the start of every step; render-only (§2.9)
}
```

**The initial junction vector is normative, not an allocation default.** `open` starts as
`length = level.junctions.length` zeros, so every junction points at `node.out[0]` — the
lower-column branch (§2.3) — until the player taps it ([AC-138](acceptance-criteria.md)). §4.8
gives the reasoning and the opening window this creates.

`rng` is carried so the determinism contract has something to compare
([AC-125](acceptance-criteria.md)), and it is **constant for the whole run**: the spawn schedule is
materialised at level construction (§2.7), so nothing draws from the spawn stream during play. Do
not read a constant field as evidence that the stream is live; if a future change makes the stream
live, §2.7 changes first.

### 2.5 `step(state, inputs)` — exactly one tick

`inputs` is the array of taps stamped with `state.tick`. The order of operations is normative.

```
step(state, inputs):
  1. state.events.length = 0

  2. APPLY INPUTS
     sort inputs ascending by junctionId; ties keep submitted array order (stable)
     for each input: state.open[input.junctionId] ^= 1
     push { type:'flip', junctionId, open } for each

  3. SPAWN
     while state.nextSpawn < level.spawns.length
           and level.spawns[state.nextSpawn].tick === state.tick:
        s = level.spawns[state.nextSpawn++]
        push car { id: s.index, colour: s.colour, edgeId: level.entryEdgeId, progress: 0 }
        push { type:'spawn', carId, colour }

  4. ADVANCE — for each car in ascending id order:
        car.progress += level.speedMluPerTick
        while car.progress >= edge(car.edgeId).lengthMlu:
           car.progress -= edge(car.edgeId).lengthMlu
           node = edge(car.edgeId).to
           if node.kind === 'depot':
              resolveArrival(car, node)      // §2.6 — removes the car, returns
              break
           if node.kind === 'branch':
              car.edgeId = node.out[ state.open[node.junctionId] ]   // THE READ (§3.1)
           else:
              car.edgeId = node.out[0]

  5. TERMINAL CHECK
     if state.delivered >= level.quota:  state.phase = 'won'
     else if state.lives <= 0:           state.phase = 'lost'

  6. state.tick += 1
```

Notes the implementation must honour:

- **Cars advance in ascending id order.** Cars do not interact — they do not collide, queue,
  block or overtake — so the order is not observable in the result, but it is fixed anyway so
  that any future interaction cannot introduce an ordering bug silently.
- **The `while` loop is provably single-pass.** The shortest edge in the game is the entry edge
  at `ENTRY_LEN = 100` LU = 100,000 MLU; the fastest speed is 3,800 MLU/tick. A car can
  therefore never cross two edges in one tick. The loop is written anyway because the invariant
  "no car is past the end of its edge without having transitioned" must hold structurally, not
  by arithmetic luck. The test suite asserts the loop body executes at most once
  ([AC-118](acceptance-criteria.md)).
- **`step()` when `phase !== 'running'` is a no-op except that it still returns the state
  unchanged.** The React layer stops calling it; the engine does not rely on that.
- **No `Date.now()`, no `Math.random()`, no floats, no React.** `step` is a pure function of
  `(state, inputs)`.

### 2.6 `resolveArrival` — the single place scoring happens

```
resolveArrival(car, depotNode):
  remove car from state.cars
  if depotNode.depotColour === car.colour:
     state.delivered += 1
     state.streak    += 1
     state.bestStreak = max(state.bestStreak, state.streak)
     state.score     += SCORE_DELIVERY + SCORE_STREAK_STEP * min(state.streak - 1, STREAK_CAP)
     push { type:'delivered', carId, depotId, colour }
  else:
     state.misrouted += 1
     state.streak     = 0
     state.lives      = max(0, state.lives - 1)        // floored; see below
     push { type:'misrouted', carId, depotId, carColour, depotColour }
```

Counters and the event are written by the same function, in one place. There is deliberately no
second derivation of the score from the event stream — two sources that must agree is the shape
of a bug, not the absence of one (`docs/development-process.md:173`).

**Why `lives` is floored at 0 and `misrouted` is not.** Step 4 of §2.5 resolves *every* arrival in
the tick before step 5 checks for a terminal condition, so two cars can misroute on the same tick
with `lives === 1`. Three things have to hold together and the resolution is normative:

1. **Every arrival resolves.** No arrival is skipped because the level is already over — the
   terminal check is a separate step and it runs once, after all of them. Skipping would make the
   result depend on car id order, which §2.5 deliberately fixed so that nothing depends on it.
2. **`misrouted` counts every misroute.** It is the honest count of what the player did, it feeds
   the end-of-level summary, and it must equal the number of `misrouted` events emitted.
3. **`lives` is clamped at 0.** `lives` is a displayed quantity with three pips; `-1` is not a
   state the UI can draw and not a state the fuzzer's invariant permits.

So on that tick `misrouted` increases by 2, two events are emitted, `lives` is 0 and not −1, and
`phase` becomes `'lost'` at step 5. This reconciles [AC-119](acceptance-criteria.md),
[AC-121](acceptance-criteria.md), [AC-122](acceptance-criteria.md) and
[AC-801](acceptance-criteria.md), which slice 1 found could not all hold under their slice-0
wording; [AC-136](acceptance-criteria.md) is the case that pins it.

### 2.7 Spawn scheduling as a deterministic function of the seed

The whole spawn schedule is materialised **at level construction**, before the first tick, into
`level.spawns` — an array of `{ index, tick, colour }`. It is a pure function of the seed.

```
SPAWN_LEAD = 90 ticks (1.5 s)   // grace before the first car enters
```

Two independent PRNG streams are derived from the level seed so that a change in the number of
generator draws can never perturb gameplay randomness, and vice versa:

```
GEN_SALT   = 0x9E3779B1
SPAWN_SALT = 0x85EBCA6B

mix32(x, salt):
   x = (x ^ salt) >>> 0
   x = Math.imul(x ^ (x >>> 16), 0x21F0AAAD) >>> 0
   x = Math.imul(x ^ (x >>> 15), 0x735A2D97) >>> 0
   return (x ^ (x >>> 15)) >>> 0

mulberry32(s):   // returns a generator of uint32
   s = (s + 0x6D2B79F5) >>> 0
   t = s
   t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
   t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0
   return (t ^ (t >>> 14)) >>> 0
```

`nextInt(n)` is `rng() % n` — modulo bias is at most 1 part in 2^32/n and is irrelevant here;
using rejection sampling would cost a variable number of draws, which is a determinism hazard
for no benefit.

**Spawn count.** `SPAWN_COUNT = quota + SPAWN_SLACK(band)`, and the slack is **derived**, not
chosen. Slice 1 measured the flat `SPAWN_SLACK = 8` down to a margin of **one car** at band 5 —
seed 160 consumed 71 of 72 spawns, and 30 of 5,000 band-5 seeds finished one spawn interval from an
uncaught `SPAWN_EXHAUSTED` throw in the middle of a level a player was winning. The old
justification — "at most `quota + 2` cars ever need to resolve, eight is slack" — is not wrong so
much as incomplete: it counts the cars that *resolve* and forgets the cars still *in flight* when
the quota-completing car lands, which is about 4 at band 3 and 5–6 at band 5.

The schedule has to cover three things and one reserve:

```
transitMax(band)  = ceil( (ENTRY_LEN + R * max(rowH, diagLen)) * MLU / speedMluPerTick )
                    // ticks, the longest root-to-depot journey in the band

inFlightMax(band) = floor( transitMax / interval ) + 2
                    // one car per interval of transit, +1 for the partial interval,
                    // +1 because jitter can pull one spawn forward across the boundary

SPAWN_SLACK(band) = (LIVES - 1)        // the misroutes a winning run is allowed
                  + inFlightMax(band)  // still on the network when the quota is met
                  + 1                  // reserve: the engine throws when nextSpawn REACHES
                                       // spawns.length, so the last entry must never be spawned
```

| Band | `transitMax` | `interval` | `inFlightMax` | observed max in flight | `SPAWN_SLACK` | `SPAWN_COUNT` |
|---|---|---|---|---|---|---|
| 1 | 555 | 156 | 5 | 4 | **8** | 24 |
| 2 | 550 | 138 | 5 | 5 | **8** | 34 |
| 3 | 518 | 120 | 6 | 5 | **9** | 45 |
| 4 | 477 | 108 | 6 | 5 | **9** | 57 |
| 5 | 489 | 96 | 7 | 6 | **10** | 74 |

Bands 1 and 2 are unchanged at 8; bands 3–5 gain one or two cars. Measured with an oracle router
over 2,000 seeds per band in both its shortest-path and longest-path variant, with the two allowed
misroutes injected, the worst `nextSpawn` reached is `21 / 32 / 42 / 54 / 71`, which under the
derived counts leaves a margin of **3 / 2 / 3 / 3 / 3** spawns
([AC-139](acceptance-criteria.md)). The engine asserts `nextSpawn` never reaches `SPAWN_COUNT`
([AC-123](acceptance-criteria.md)).

The derivation matters more than the numbers it currently produces. Every difficulty lever in
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed) moves a term in it — raising
`quota` does not, but cutting `interval` raises `inFlightMax`, and a slower speed or a deeper band
raises `transitMax`. With the slack written as a literal, a lever pull walks through the margin
silently; written as a derivation, it recomputes.

**Spawn ticks.**

```
JITTER (ticks) is a band constant (generation.md §6.1)
tick[i] = SPAWN_LEAD + i * INTERVAL + nextInt(2*JITTER + 1) - JITTER
```

The jitter exists so the spawn stream is not a metronome. A perfectly regular beat lets a player
pattern-match a rhythm instead of attending to the cars, which is the opposite of the game's
subject. Because `INTERVAL - 2*JITTER >= 60` for every band (generation.md §6.1), `tick[i+1] > tick[i]` strictly,
always — the schedule can never invert or collide.

**Spawn colours — a bag, not a coin.**

```
bag = [0, 1, ..., K-1]                     // K = colour count for the band
shuffle(bag) with Fisher-Yates using nextInt
colour[i] = bag.pop(); refill and reshuffle when empty
```

A bag rather than independent uniform draws, because uniform draws produce colour droughts
("no Teal for 14 cars") and long runs, both of which read as the generator being unfair even
though they are not. A bag of `K` distinct colours also guarantees **at most two identical
colours in a row**, for free, with no extra rule.

### 2.8 Determinism contract

A run is `{ seed, band, inputs: [{tick, junctionId}, ...] }` and replays to a deeply equal final
state on any machine. The things that make this true, and that a change must not break:

1. All simulation quantities are integers.
2. Edge lengths are table literals, not runtime-computed.
3. Both PRNG streams are 32-bit integer operations via `Math.imul` and `>>> 0`.
4. Inputs are tick-stamped and ordered by junction id, never by arrival order.
5. Iteration over cars is by ascending id; iteration over junctions is by ascending id.
6. `events` is cleared at the start of every step, so it is a pure function of the tick and does
   not accumulate.

### 2.9 Events are render hints, and only that

`state.events` exists so the renderer can start an animation on the tick a thing happened. The
engine never reads it back. Every animation inside the play surface derives its phase from
`currentTick - eventTick`, which means a replay paints identically to the live run
([AC-505](acceptance-criteria.md)).

---

## 3. The junction rule — the most important rule in the game

### 3.1 When junction state is read

**A junction's state is read at the instant a car transitions onto its outgoing edge, inside
step 4 of the tick, and never at any other time.**

Concretely: the read is the expression `state.open[node.junctionId]` in §2.5 step 4. It happens
once per car per junction, at the moment `progress` reaches the end of the incoming edge.

Consequences:

- A car that has already crossed a junction **never re-routes**. Flipping the switch behind a car
  does nothing to that car. This is the rule `docs/development-process.md:82` names as the one
  most likely to be got subtly wrong, and it is the reason the read is written as a single
  expression in a single place.
- A car approaching a junction takes whatever the state is when it arrives, no matter how many
  times it changed while the car was approaching.

### 3.2 Inputs are applied before movement

Step 2 (apply inputs) precedes step 4 (advance) within the same tick. A tap stamped at tick `T`
is therefore honoured by a car that transitions during tick `T`.

This is the player-favourable reading and it is the only one that makes tap timing legible: if
the car has not yet reached the junction when you tap, your tap counts. There is no hidden
commit window in the simulation.

### 3.3 The one honest caveat: render latency

The simulation has no commit window, but the *screen* does. The player is looking at a frame
painted from tick `T-1` or earlier, and their tap is stamped to the tick the React layer is
about to run. The ambiguous window is therefore about one frame — 16.7 ms, or 3.0–3.8 LU of car
travel, roughly 3 % of a car's length.

This is mitigated in the UI, not in the rules: when a car is within `COMMIT_PREVIEW = 260 LU` of
a junction, that junction draws a **lead highlight** along the branch the car will take
([`ui.md` §7.3](ui.md#73-junction)). The player sees the outcome before it happens. The rule does
not change; the information does.

### 3.4 Tapping a junction a car is "on"

Because cars are always on an edge and node traversal is instantaneous, there is no state in
which a car occupies a junction. The question resolves completely into three cases:

| Situation at the time the tap is applied | Result |
|---|---|
| Car is on an edge **approaching** the junction and has not yet transitioned | The flip applies. The car will read the new state when it arrives. |
| Car transitions during **this same tick** (tap applied in step 2, car moves in step 4) | The flip applies. The car takes the new branch. |
| Car has **already** transitioned, on a previous tick or earlier in this tick's step 4 | The flip does not affect that car. It affects the next car to arrive. |

The flip is never blocked, never queued, never deferred and never silently dropped. A blocked
tap is an invisible rule, and an invisible rule in a real-time game is a defect.

### 3.5 Two taps in the same tick

Inputs for a tick are sorted **ascending by `junctionId`**, not by arrival order
(`docs/development-process.md:79`). Ties — two taps on the *same* junction in the same tick —
keep the order they were submitted in, applied with a stable sort, and each one toggles. Two taps
on the same junction in the same tick therefore net to **no change**, which is correct: two
toggles is two toggles.

Multi-touch is allowed up to `MAX_POINTERS = 2`. Two fingers landing on two junctions in the same
frame produce two inputs stamped to the same tick, and they resolve by junction id. There is no
debounce and no coalescing.

---

## 4. Rules, scoring and failure

### 4.1 Lives

```
LIVES = 3
```

Three is the smallest number that supports a distinct **last life** state (which the UI needs to
communicate jeopardy, [`ui.md` §8.5](ui.md#85-last-life)) while still allowing two recoveries. A
level ends on the terminal check of the tick in which the third life is lost — that is, after
every arrival on that tick has resolved (§2.6), not in the middle of them. `lives` is clamped at
0, so two misroutes on the tick that takes the player from one life to none leave `lives === 0`,
`misrouted` up by two, and `phase === 'lost'`.

### 4.2 Quota and level end

A level ends on the tick that either condition first becomes true, checked in this order:

1. `delivered >= quota` → **won**
2. `lives <= 0` → **lost**

The quota check comes first so that a tick in which the quota-completing car is delivered and
another car is misrouted is a **win**. The player got there.

Cars still in flight when the level ends are discarded without scoring. The renderer freezes
them in place and dims them ([`ui.md` §8.6](ui.md#86-level-complete)).

### 4.3 Scoring

```
SCORE_DELIVERY   = 100
SCORE_STREAK_STEP = 10
STREAK_CAP        = 9          // a *gameplay parameter*, not a safety rail
SCORE_LIFE_BONUS  = 50
```

- Correct delivery: `100 + 10 * min(streak - 1, 9)`, i.e. 100 rising to 190 at a streak of ten
  and flat thereafter.
- Misroute: zero points, streak resets to 0, one life lost.
- Level clear: `+ 50 * livesRemaining`.

Score is a non-negative integer and is **non-decreasing** — a misroute never subtracts. That is
an engine invariant the fuzzer asserts (`docs/development-process.md:130`), and it is also a
design position: the punishment for a misroute is the life and the broken streak, not a number
going backwards.

`STREAK_CAP` is reached in ordinary play — a competent run at band 3 clears ten in a row
routinely — so it is labelled what it is. A cap that play reaches is a gameplay parameter, not a
safety rail (`docs/development-process.md:165`).

There is deliberately **no time bonus**. A time bonus rewards going faster, and the game is not
about going faster.

### 4.4 Cars do not interact

Cars pass through one another with no collision, no queueing and no speed change. Reasons:

- A second failure mode (traffic jams) would make the generator's solvability analysis much
  harder and would introduce a way to lose that the player cannot see coming.
- The topology guarantees it is almost never visible anyway (§4.5).

### 4.5 Why two cars never overlap on the same edge

**The heading is the claim, and the claim is narrower than slice 0 made it.** The argument below
proves something about two cars *on one edge*. It proves nothing about two cars on two different
edges, and §4.5b is the case it does not cover.

The network is a **tree**: no non-depot node has more than one incoming edge
([`generation.md` §2.4](generation.md#24-merge-free-by-construction)). Two cars are on the same
edge only if they travelled the identical path from the entry. All cars move at the same constant
speed, so their separation along that path is exactly their spawn separation in ticks times the
speed:

```
minSeparationLu = (INTERVAL - 2 * JITTER) * SPEED_MLU / 1000
```

| Band | min separation | car length | clearance |
|---|---|---|---|
| 1 | 396 LU | 140 LU | 256 LU |
| 2 | 365 LU | 140 LU | 225 LU |
| 3 | 286 LU | 140 LU | 146 LU |
| 4 | 259 LU | 140 LU | 119 LU |
| 5 | 228 LU | 140 LU | 88 LU |

The worst case, band 5, leaves 88 LU — about 32 pt on an iPhone 16 — of clear road between two
cars. This is a *structural* guarantee for cars sharing an edge, and it is not a tuned one: no
network the generator emits can violate it, because the route portion of the network has nowhere
for two paths to converge. ([AC-124](acceptance-criteria.md))

### 4.5b Where the guarantee stops: the depot mouth

Two paths *do* converge in one place — the depot row. V2
([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate)) requires terminal
targets to be non-decreasing rather than strictly increasing, so two or three terminal edges may
feed one depot. Slice 1 measured what that means:

| Measured over the generator | Result |
|---|---|
| Levels with at least one depot fed by two or more terminal edges | **100 % at every band** (max depot in-degree 3 at bands 2–5) |
| Runs in which two cars on different terminal edges came within a car length | **0–5 per 1,000**, by band |
| Minimum observed centre-to-centre distance | **26 LU**, against `CAR_L = 140` — a total overlap, not a near miss |

So the situation is universal structurally and rare behaviourally, and when it lands it is a
complete overlap. **No rule and no generator change follows from this.** Both cars resolve
correctly and independently; §4.4 already says cars do not interact. It is a drawing problem, and
it is solved in the drawing: [`ui.md` §7.6](ui.md#76-the-depot-mouth) specifies a depot-mouth
apron that covers the last stretch of every terminal edge, sized per band so that the region where
two converging centrelines are closer than a car's width is drawn over the cars rather than under
them. Outside the apron the worst residual overlap is 11 % of a car body — a flank clip — and the
minimum centre-to-centre distance is 91 LU, which is three and a half times the 26 LU that was
measured. ([AC-513](acceptance-criteria.md))

### 4.6 Why a junction is always flippable in time

Two cars arrive at the same junction only if they took the same path to it, so their arrival
separation equals their spawn separation. The minimum across all bands is band 5's
`96 - 36 = 60` ticks = **1.00 s**. Band 1 is 2.20 s.

One second is comfortably above the sum of a human's visual reaction (~250 ms) and tap (~100 ms).
No band asks the player to beat a 400 ms window at a single junction. The difficulty is the
*aggregate* load across several junctions, which is what the constrained bot measures
([`generation.md` §7](generation.md#7-the-two-measurable-targets)).

### 4.7 Every level is solvable, provably

The generator guarantees every depot is reachable from the entry and every junction has both
branches leading to at least one depot
([`generation.md` §4](generation.md#5-validity-rules-what-rejects-a-candidate)). Combined with
§4.6, an unconstrained solver — one allowed to tap any junctions on any tick — clears **100 % of
generated levels at every band with zero misroutes**. That is a required, measurable acceptance
criterion, not an aspiration ([AC-220](acceptance-criteria.md)).

Being clearable by an omniscient bot proves nothing about playability. That is what the
constrained bot is for.

### 4.8 How a level opens

**Every junction starts pointing left.** `state.open` is all zeros at tick 0, and `node.out[0]` is
always the lower-column branch (§2.3), so an untouched network sends every car to the leftmost
depot it can reach ([AC-138](acceptance-criteria.md)). This was an unstated implementation default
through slices 0 and 1; it is a rule now, and the alternative — seeding `open` from the level seed
so each level opens differently — is rejected.

Three reasons:

1. **It is one rule the player learns once.** "Nothing I have touched points left" is legible from
   the first level and stays true for the rest of the game. A per-level random opening is a fresh
   reading task in the first two seconds of every level, and those two seconds are the only quiet
   ones the level has.
2. **It keeps `createState` a pure function of the level with no draw of its own.** The spawn
   stream stays the only gameplay PRNG (§2.7), which is what makes a run reproducible from
   `{seed, band, inputs}` alone (§2.8).
3. **It is inspectable.** A replay, a screenshot and a bug report all start from the same known
   configuration, and a level's opening state can be reasoned about without running the seed.

**The window this creates.** The first car enters at `SPAWN_LEAD = 90` ticks and crosses the
`ENTRY_LEN = 100` LU entry edge before it reaches the row-0 node, which is the first junction it
can meet:

| Band | entry-edge transit | first decision at | wall time |
|---|---|---|---|
| 1 | 34 ticks | tick 124 | 2.07 s |
| 2 | 32 | 122 | 2.03 s |
| 3 | 30 | 120 | 2.00 s |
| 4 | 28 | 118 | 1.97 s |
| 5 | 27 | 117 | **1.95 s** |

So the player has at least **1.95 s** from the first tick to read the board and set the first
junction if the default is wrong for the first car — comfortably above the ~350 ms of reaction plus
tap that §4.6 budgets, and the *only* moment in a level where the board is empty while a decision
is pending. If a future change raises speed or lowers `SPAWN_LEAD` far enough to push this below
1.0 s, the opening stops being free and this section is what has to be re-argued.

---

## 5. Difficulty

Five bands. Level `N` maps to a band, and the band supplies every parameter.

| Band | Levels | Colours `K` | Columns `C` | Rows `R` | Junctions drawn `J` | Junctions actionable `Ja` | Depth `D` | Speed (MLU/tick) | Speed (LU/s) | Interval (ticks) | Jitter | Quota |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | 3 | 3 | 3 | 3 | ≥3 | 2 | 3000 | 180 | 156 (2.60 s) | ±12 | 16 |
| 2 | 5–9 | 3 | 4 | 4 | 3–5 | ≥3 | 2–3 | 3200 | 192 | 138 (2.30 s) | ±12 | 26 |
| 3 | 10–15 | 4 | 4 | 4 | 4–6 | ≥4 | 2–3 | 3400 | 204 | 120 (2.00 s) | ±18 | 36 |
| 4 | 16–22 | 4 | 5 | 5 | 5–7 | ≥5 | 2–4 | 3600 | 216 | 108 (1.80 s) | ±18 | 48 |
| 5 | 23+ | 5 | 5 | 6 | 7–8 | ≥7 | 2–4 | 3800 | 228 | 96 (1.60 s) | ±18 | 64 |

`J` and `D` ranges are measured outcomes of the generator over 3,000 seeds per band, not targets
([`generation.md` §5](generation.md#6-difficulty-parameters-per-band)). `D` is the number of
junctions on a root-to-depot path; a band's range means different colours in the same level take
different numbers of decisions, which is deliberate — some colours are a rest.

**`J` and `Ja` are different claims and only `Ja` is a difficulty claim.** `J` counts the junctions
the player can see and tap. `Ja` counts the ones a perfect player has to flip: where one branch's
reachable colours are a strict superset of the other's, the superset branch serves every colour the
subset branch does and the junction never has to move. Slice 1 measured that up to 30 % of drawn
junctions were decorative in that sense, so a band advertising `J = 5–7` was in places delivering
three decisions. `Ja` is now a validity rule
([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate), V13) and a measured
one ([AC-242](acceptance-criteria.md), [AC-243](acceptance-criteria.md)). A decorative junction is
not worthless — it is a real branch a car takes and a real thing to read — but it is scenery, and
the difficulty table may not be paid for it.

### 5.1 What escalates, and in what order

| Step | What changes | Why that axis |
|---|---|---|
| 1 → 2 | Network widens (3→4 columns), gains a row, quota +10 | Teach that a path can be longer than two decisions before adding a colour |
| 2 → 3 | **Fourth colour** | The biggest single jump; a new colour is a new thing to hold |
| 3 → 4 | Network deepens (5 rows), more junctions | Depth, now that four colours are habitual |
| 4 → 5 | **Fifth colour**, deepest network | The ceiling |

Speed, spawn interval and quota move monotonically at every step. Colour count and topology
alternate, so that consecutive bands never feel like the same level with a bigger number.

### 5.2 Within a level

Nothing ramps inside a level. Speed, spawn interval and colour count are constant from the first
car to the last. Reasons:

- The quota bar is the only progress signal the player needs; a hidden difficulty curve inside a
  90-second level is invisible pressure.
- A constant-rate level is analysable: the constrained bot's completion time is a tight
  distribution, which is what makes the two-minute ceiling a measurable criterion rather than an
  aspiration.

The level does get harder in one way, and it is emergent rather than scripted: after a misroute
the streak resets and the player's own state of mind changes. That is enough.

### 5.3 Session length

| Band | Nominal duration (zero misroutes) | With two misroutes | Design band |
|---|---|---|---|
| 1 | 49.1 s | 54.3 s | 42–62 s |
| 2 | 67.0 s | 71.6 s | 58–78 s |
| 3 | 79.0 s | 83.0 s | 70–92 s |
| 4 | 92.9 s | 96.5 s | 84–106 s |
| 5 | 108.8 s | 112.0 s | 98–122 s |

Nominal duration is `SPAWN_LEAD/60 + (quota - 1) * INTERVAL/60 + transit`, with transit measured
for a typical two-diagonal path.

**The band and its justification.** The brief's target is "about two minutes". Two minutes is the
*ceiling*, not the mean, and treating it as the mean would be wrong: a first level that takes two
minutes before the player knows whether they are good at this is two minutes of uncertainty. The
ladder therefore starts at roughly 50 s and grows to roughly 110 s, so that:

- A player's first complete win arrives inside the first minute.
- The hardest band approaches the attention ceiling without crossing it — 108.8 s nominal, 122 s
  at the top of the design band, and a hard acceptance ceiling of **130 s for any seed at any
  band** ([AC-231](acceptance-criteria.md)).
- A losing run is always *shorter* than a winning one, so failure never costs more time than
  success.

---

## 6. Run control

### 6.1 Pause

`phase` stays `'running'`; the React layer simply stops calling `step()` and sets its own
`paused` flag. The engine has no concept of pause, because a pause that the engine knows about is
a pause that can be got wrong in a replay. Taps are discarded while paused.

### 6.2 Background and resume

On `AppState` leaving `'active'` the React layer pauses (§6.1) and **zeroes its tick
accumulator**. On resume it shows a 3-2-1 countdown (3 × 600 ms) and only then resumes calling
`step()`. The countdown is wall-clock and involves no simulation ticks.

### 6.3 Retry

Retry rebuilds the level from the same seed and starts a fresh state at tick 0. The same seed
always produces the same network and the same spawn schedule, so retrying is retrying the same
level, not a re-roll.

---

## 7. Progression (slice 4 territory, specified here so it is not invented later)

- Levels are numbered from 1 and unlock in sequence; clearing level `N` unlocks `N+1`.
- Level `N`'s seed is `mix32(RUN_SEED ^ Math.imul(N, 0x9E3779B1), GEN_SALT)` where `RUN_SEED` is
  a per-install constant. Every install gets a different ladder; every device replays its own
  ladder identically.
- Per level the game stores: cleared (bool), best score, best streak, fewest misroutes.
- There is no star rating, no currency, no energy, no ads, no accounts and no network calls.
- Level 1 is always playable. There is no gate before the first level.

---

## 8. Decisions that were genuinely open, and where they landed

Each of these is decided and designed on. They are listed because they are the ones most worth a
second look, not because they are unresolved.

### 8.1 One entry, not two — **decided**
An earlier draft gave bands 3–5 two entry points to create two independent attention fronts.
It was dropped because the merge-free topology (§4.5) makes each entry's tree need
`K - 1` terminal columns, so two entries with four colours need six columns, and six columns
breaks the 44 pt tap-target floor on a 320 pt-wide viewport
([`ui.md` §4.4](ui.md#44-tap-target-arithmetic)). One entry buys a deeper tree (depth 4 instead
of 2) and more colours. Divided attention comes from the number of cars in flight and the number
of colours, both of which are preserved.

### 8.2 Merge-free networks — **decided**
Allowing two roads to merge was prototyped and measured: to stop two cars converging and
overlapping, the generator has to keep all paths to a node the same length, and that constraint
rejects essentially every candidate network at bands 2–5 (measured: 0 valid networks in
2,000 seeds per band). Merge-free removes the problem by construction, satisfies
`docs/development-process.md:96` ("no junction a car can enter from two directions") completely
rather than partially, and generates at 3,000/3,000 with a median of 2–5 attempts. The cost is
that networks are trees rather than graphs, which is a smaller visual vocabulary. It is worth it.

### 8.3 Always-on colour-blind glyphs — **decided**
The glyph on car and depot is always drawn, not gated behind a setting. A mode that only some
players see is a mode that rots: it is not exercised in development, not screenshotted, and not
caught when it breaks. An accessibility setting increases glyph **size and opacity**; it does not
turn the glyph on. The glyph never changes the rules ([`ui.md` §6](ui.md#6-colour-blind-support)).

### 8.4 Spawn slack is derived, not chosen — **decided**
The spawn schedule contains more cars than `quota`. With exactly `quota`, one misroute makes the
quota unreachable and lives become decorative; with slack, a misroute costs a life and roughly one
extra spawn interval, which is what lives are for. That part was right in slice 0.

The number was not. Slice 0 wrote `quota + 8` and called eight cars comfortable slack, on an
argument that counted only the cars that have to *resolve* (`quota` deliveries plus the two
misroutes a winning run is allowed) and omitted the cars still *in flight* when the last delivery
lands — 4 to 6 of them, depending on band. Slice 1 measured the consequence: band 5 seed 160
consumed 71 of its 72 spawns, and 30 of 5,000 band-5 seeds finished with a margin of exactly one
car. Nothing had crashed; the margin had simply been spent without anyone noticing, and
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed)'s normative response to a too-high
clear rate — raise `quota`, then cut `interval` — drives straight through what was left.

§2.7 now derives the slack from the three quantities that consume it, so the same lever that used
to spend the margin silently now recomputes it. The derived values are `8 / 8 / 9 / 9 / 10`, which
restores a measured margin of `3 / 2 / 3 / 3 / 3` against a worst case of `21 / 32 / 42 / 54 / 71`
([AC-139](acceptance-criteria.md)). The lesson generalises past this number: **a safety constant
that a normative lever moves through must be written as a function of the lever, not as a
literal.**

### 8.5 **Owner recommendation — not a blocker.** Haptics default
Slice 5 adds haptics. The recommendation is **haptics on by default**: a light impact on a
successful flip and an error notification on a misroute, with a settings toggle. Rationale: the
flip confirmation is the one piece of feedback the player needs without looking, and they are
looking at a car, not at the junction they just tapped. This is designed on throughout
[`ui.md` §9](ui.md#9-motion-spec). If the owner prefers off-by-default, only the default
value of one setting changes.

### 8.6 **Owner recommendation — not a blocker.** Band 5 tap load
The estimated sustained tap rate at band 5 is **1.03 taps/s** over 109 s. That is high, and it is
the number most likely to come back from the tester as "too hard". The recommendation is to hold
the parameters as specified and let the constrained bot arbitrate: if band 5's clear rate falls
below the 55 % floor ([`generation.md` §7.2](generation.md#72-target-1--constrained-bot-clear-rate)),
the first lever is the iso-duration pair — raise `interval` and cut `quota` together so the
completion-time band, which passes today, keeps passing
([`generation.md` §7.4](generation.md#74-when-a-target-is-missed)). Speed is never a lever:
reducing it shortens the planning horizon relative to the spawn rate and pushes the game toward
reaction. This ordering is normative so the fix is not reinvented under time pressure.

### 8.7 The bot is a model of attention, not of timing — **decided**
Slice 0's constrained bot constrained only *when* it could tap. Slice 1 measured the consequence:
one reading of the policy cleared 100 % of band 5 while obeying every constraint the design
imposed, because nothing in the design ever asked it to divide its attention. A bot with perfect
memory of every car's colour and no cost to switching between cars cannot measure the difficulty
of dividing attention, which is the only thing this game is about.

[`generation.md` §7.1](generation.md#71-the-constrained-solver-bot) now specifies a bounded
working set of three cars, a cost in ticks to focus a car, a higher cost to focus one it has
forgotten, a memory that expires after two seconds, and a fixed sweep that must *find* the next
car rather than being handed a sorted list. The line it draws is deliberate: **the static picture
is free, the moving objects are not.** A player reads the network once and refers back to a
drawing that has not changed; what costs them is keeping four coloured cars bound to four
positions while the board keeps producing more.

The sharpest consequence is that the safe-window check now ranges over the bot's working set
only. The bot can misroute a car it has forgotten by flipping a junction for a car it is holding
— and never see it coming. That is the game's actual failure mode, and the old instrument could
not produce it at all.

### 8.8 §4.5's guarantee is narrowed, not repaired — **decided**
Slice 0 claimed no two cars ever visually overlap. Slice 1 measured that every level has a depot
fed by two or more terminal edges, and that two cars come within 26 LU of each other there in up
to 5 runs per 1,000. The options were to constrain the generator (make terminal targets strictly
increasing, which costs the shared-depot topology entirely and shrinks an already small network
space), to add a spacing rule on terminal edges (a rule that would reject valid networks for a
render artifact), or to draw it correctly. The third is the only one that costs the game nothing,
so §4.5's heading now says what its argument proves, §4.5b states the exception with its measured
numbers, and [`ui.md` §7.6](ui.md#76-the-depot-mouth) covers it.
