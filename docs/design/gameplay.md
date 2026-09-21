# Offramp — Gameplay and Simulation Model

This document defines the rules, the simulation model in the exact terms the engine must
implement, scoring, lives, difficulty and progression. It is the contract for `src/engine/`.

Companion documents: [`generation.md`](generation.md) (the track generator),
[`ui.md`](ui.md) (visual system and layout), [`acceptance-criteria.md`](acceptance-criteria.md)
(numbered, testable ACs).

Every constant named in **SCREAMING_SNAKE** in this document is a literal the engine exports
from a single constants module. There are no magic numbers in the implementation.

> **Round 8 rebuilt this document around four owner decisions taken after the first play
> session**, and they are tier-5 findings: a level is a **fixed two minutes**, not a car quota
> (§4.2); every road is **horizontal or vertical** (§2.2); roads and cars are **smaller**
> ([`ui.md` §4.1](ui.md#41-geometry-constants-lu)); and a junction in the first row is unfair, so
> there is no longer one (§4.6b, [`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate) V14).
> **Every number tied to geometry or to duration in these documents is new.** Tables marked
> *(to be measured)* are the ones only the developer's sweep can settle; everything else is
> computed here and re-derivable in a few lines.

---

## 1. The loop in one paragraph

Coloured cars enter a road network from a single entry at the top and roll downhill at a
constant speed. Depots sit at the bottom, one per colour. Junctions along the network have two
outgoing branches; exactly one is open, and tapping the junction flips which. A car that enters
a depot of its own colour is **delivered** and is the score. A car that enters any other depot
is **misrouted** and costs a life. The level runs for exactly **two minutes** and then ends;
three misroutes ends it early.

The pressure is **divided attention**. Several cars are in flight at once, each needing up to
five junction states to be correct by the time it arrives. Nothing in the game rewards reacting
faster than about 1.6 s — §4.6 proves the floor between two cars at one junction, §4.6b proves
the one between a car appearing and its first decision — and nothing punishes planning ahead.

---

## 2. The simulation model

### 2.1 Tick rate and the level clock

```
TICK_HZ           = 60          // ticks per second, integer, constant
MAX_CATCHUP_TICKS = 8           // per animation frame
LEVEL_SECONDS     = 120
LEVEL_TICKS       = TICK_HZ * LEVEL_SECONDS = 7200
```

**Why 60.** A tick is 16.667 ms. That is below the precision of a human tap, so no tap ever
feels quantised — the worst-case input latency the model introduces is one tick (§3.3). It also
keeps the per-tick position delta small (2.75–3.35 LU, §2.2), which means the "advance and
transition" loop in §2.5 is provably single-pass. 30 Hz would halve the step cost and introduce
a 33 ms quantisation right at junction-entry boundaries, which is exactly where the game's
fairness lives.

**Why the clock is in ticks and not in milliseconds.** `LEVEL_TICKS` is an integer compared
against `state.tick`, so the length of a level is a property of the simulation and not of how
many frames the device managed to draw. A run that drops frames is still exactly 7,200 ticks
long; it just takes longer than 120 s of wall time (see catch-up, below). A replay is therefore
the same length as the run it replays, which would not be true of a wall-clock timer.
([AC-141](acceptance-criteria.md))

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
integer-first form is required by [AC-805](acceptance-criteria.md) and the reason it cannot be
checked behaviourally is [AC-816](acceptance-criteria.md).

`acc` is a float and it lives in the React layer only. Its residue can never perturb the
simulation, because the only thing that crosses into the engine is the integer `n`.

**Catch-up.** The layer calls `step()` at most `MAX_CATCHUP_TICKS` times per frame and
**discards** any remainder beyond that, resetting its accumulator to zero. Consequences, stated
plainly:

- On a device that cannot sustain 60 fps, world time runs slower than wall time. The level takes
  longer in seconds but is identical in ticks. That is the correct trade: a time-skip would
  teleport cars past junctions the player was about to flip. **Under the fixed clock it is also
  the only honest choice** — discarding ticks would silently shorten the level and hand a
  stuttering device a different game.
- A run's record is a tick stream, so replay is unaffected by whether ticks were dropped live.
- On resume from background the accumulator is reset to zero and no catch-up is performed at all
  (§6.2). A phone call is not extra ticks, and it does not eat the level clock either.

### 2.2 Position: fixed-point integers along an edge

A car is **always on exactly one edge**. It is never "at" a node — node traversal is
instantaneous and happens inside a tick (§2.5). This single decision removes an entire class of
ambiguity, including the question of what it means to tap a junction a car is sitting on (§3.4).

```
LU        // layout unit: the integer coordinate system of the design space (generation.md §3.1)
MLU = 1000 // milli-layout-units per LU. All simulation distances are integers in MLU.
```

A car's state is:

```
{ id: int, colour: int, edgeId: int, progress: int }   // progress in MLU, 0 <= progress < edge.lengthMlu
```

Advancing is `progress += CAR_SPEED`, an integer addition. There is no float anywhere in
the simulation. `distance += 0.0567` over 7,200 ticks is not the same number on an arm64 phone
and an x86 CI box; `progress += 2750` is.

**Edge lengths are now computed, not tabled, and that is the whole of what orthogonal roads cost
the simulation — a negative amount.** Every road segment runs horizontally or vertically
([`generation.md` §2.3](generation.md#23-edges)), so an edge's length is

```
lengthLu  = |x_to - x_from| + |y_to - y_from|
lengthMlu = lengthLu * MLU
```

— an exact integer, obtained by two subtractions and an addition, identical on every machine.
Through slices 0–1 this was a **table literal** (`diagLen` per band) because an edge was a cubic
Bézier and its arc length came from a 128-step chord sum, and `Math.hypot` is not required to be
bit-identical across JavaScript engines, so a runtime computation was a determinism hazard. That
hazard is gone with the curve. `diagLen`, the reference derivation and the unit test that guarded
the table against drift are **deleted**; [AC-207](acceptance-criteria.md) now asserts the identity
above instead. ([AC-218](acceptance-criteria.md) still requires every length to be an integer,
which is now true by construction rather than by the band table happening to divide.)

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
         shape: 'entry' | 'straight' | 'jogL' | 'jogR' }
```

For a `branch` node, `out[0]` is the edge whose target node has the **smaller column index**
(visually the left branch) and `out[1]` the larger. The two targets always differ, so the order
is total and deterministic. `junction.open` is `0` or `1` and indexes directly into `out`.

`shape` is render-only. `straight` is a single vertical segment; `jogL` and `jogR` are a
horizontal run at the source row's `y` followed by a vertical drop, mirror images of each other
([`generation.md` §2.3](generation.md#23-edges)). The engine reads `lengthMlu` and nothing else.

### 2.4 State shape

```
state = {
  tick:        int,        // the tick about to be simulated
  phase:       'running' | 'ended' | 'lost',
  level:       <immutable level data from the generator>,
  rng:         uint32,     // spawn stream PRNG state (§2.7)
  cars:        [car, ...], // strictly ascending by id
  open:        Uint8Array, // indexed by junctionId, values 0|1
  nextSpawn:   int,        // index into level.spawns
  delivered:   int,        // THE SCORE (§4.3)
  misrouted:   int,
  lives:       int,
  streak:      int,
  bestStreak:  int,
  events:      [event, ...] // cleared at the start of every step; render-only (§2.9)
}
```

**Two terminal phases, and they are not the same outcome.** `'ended'` means the clock ran out
with at least one life left: the level is **cleared** and `delivered` is the score. `'lost'`
means the third life went before the clock did. A player sees a different overlay for each
([`ui.md` §8.6](ui.md#86-level-complete), [`ui.md` §8.7](ui.md#87-level-failed)) and progression
unlocks only on `'ended'` (§7). There is no `'won'` phase any more, because there is no quota to
complete: *finishing* is what winning is.

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
        car.progress += CAR_SPEED
        while car.progress >= edge(car.edgeId).lengthMlu:
           car.progress -= edge(car.edgeId).lengthMlu
           node = edge(car.edgeId).to
           if node.kind === 'depot':
              resolveArrival(car, node, car.edgeId)   // §2.6 — removes the car, returns
              break
           if node.kind === 'branch':
              car.edgeId = node.out[ state.open[node.junctionId] ]   // THE READ (§3.1)
           else:
              car.edgeId = node.out[0]

  5. TERMINAL CHECK — checked in this order
     if state.lives <= 0:                 state.phase = 'lost'
     else if state.tick + 1 >= LEVEL_TICKS: state.phase = 'ended'

  6. state.tick += 1
```

Notes the implementation must honour:

- **The clock is checked against `tick + 1`, the tick that has just finished.** Step 6 increments
  after the check, so the last tick simulated is `LEVEL_TICKS - 1` and a run contains exactly
  `LEVEL_TICKS` ticks numbered `0 … 7199`. Off by one here is a level that is one tick long or one
  tick short of two minutes, in a design whose whole difficulty model is `120 s / interval`.
  ([AC-141](acceptance-criteria.md))
- **`lives` is checked before the clock.** A tick in which the third life is lost *and* the clock
  expires is a **loss**. This is the opposite of the old quota rule, which resolved a tie in the
  player's favour, and the reversal is deliberate: under a quota, the tie was "you finished the job
  and also made a mistake", and the job was the point. Under a clock, the tie is "you ran out of
  lives on the last tick", and there is no job to have finished — every run reaches the clock.
  Resolving it as a clear would mean the last tick of the level is the one tick on which a misroute
  is free. ([AC-122](acceptance-criteria.md))
- **Cars advance in ascending id order.** Cars do not interact — they do not collide, queue,
  block or overtake — so the order is not observable in the result, but it is fixed anyway so
  that any future interaction cannot introduce an ordering bug silently.
- **The `while` loop is provably single-pass.** The shortest edge in the game is a `straight` at
  `rowH = 180` LU = 180,000 MLU; the fastest speed is 3,350 MLU/tick. A car can therefore never
  cross two edges in one tick — it cannot even cross a fiftieth of one. The loop is written anyway
  because the invariant "no car is past the end of its edge without having transitioned" must hold
  structurally, not by arithmetic luck. The test suite asserts the loop body executes at most once
  ([AC-118](acceptance-criteria.md)).
  *The entry edge is no longer the shortest edge: at `ENTRY_LEN = 220` it is longer than a straight
  row edge at every band. The bound is restated against `rowH` for that reason.*
- **`step()` when `phase !== 'running'` is a no-op except that it still returns the state
  unchanged.** The React layer stops calling it; the engine does not rely on that.
- **No `Date.now()`, no `Math.random()`, no floats, no React.** `step` is a pure function of
  `(state, inputs)`.

### 2.6 `resolveArrival` — the single place scoring happens

```
resolveArrival(car, depotNode, edgeId):                // edgeId: the terminal edge car arrived on
  remove car from state.cars
  if depotNode.depotColour === car.colour:
     state.delivered += 1
     state.streak    += 1
     state.bestStreak = max(state.bestStreak, state.streak)
     push { type:'delivered', carId, depotId, edgeId, colour }
  else:
     state.misrouted += 1
     state.streak     = 0
     state.lives      = max(0, state.lives - 1)        // floored; see below
     push { type:'misrouted', carId, depotId, edgeId, carColour, depotColour }
```

Counters and the event are written by the same function, in one place. There is deliberately no
second derivation of the result from the event stream — two sources that must agree is the shape
of a bug, not the absence of one (`docs/development-process.md:173`).

**`delivered` is the score and there is no points total.** `SCORE_DELIVERY`,
`SCORE_STREAK_STEP`, `STREAK_CAP` and `SCORE_LIFE_BONUS` are **deleted**; §4.3 gives the reasoning.
`streak` and `bestStreak` survive as reported statistics, not as multipliers.

**Why `edgeId` is on both events.** A depot has an in-degree of up to 3 (§4.5b), so `depotId` does
**not** identify which road the car came down. The renderer needs that road:
[`ui.md` §8.4](ui.md#84-car-misrouted) throws the misroute shatter from the **terrace line of the
arriving edge**, not from the depot node, and [`ui.md` §8.3](ui.md#83-car-delivered) glows the same
mouth on a delivery. §2.5's transition loop holds the arriving edge at the moment it calls
`resolveArrival`; passing it through costs one argument and removes an inference the renderer would
otherwise have to make from a previous-tick snapshot. The field is **render-only** like the rest of
the event (§2.9): nothing in the engine reads it, and no counter, phase or invariant depends on it.
([AC-140](acceptance-criteria.md), [AC-515](acceptance-criteria.md))

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
[AC-801](acceptance-criteria.md); [AC-136](acceptance-criteria.md) is the case that pins it.

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

**The schedule is bounded by the clock, and that replaces the whole of the old slack derivation.**

```
for i = 0, 1, 2, …:
    nominal = SPAWN_LEAD + i * INTERVAL
    if nominal - JITTER >= LEVEL_TICKS: stop
    t = nominal + nextInt(2*JITTER + 1) - JITTER
    if t < LEVEL_TICKS: append { index: spawns.length, tick: t, colour: <bag, below> }

SPAWN_COUNT = spawns.length
```

Every car that can enter inside two minutes is in the array, and no car that cannot is. The
engine therefore never needs a reserve entry, never throws `SPAWN_EXHAUSTED`, and the old
`SPAWN_SLACK` derivation — `(LIVES - 1) + inFlightMax(band) + 1`, with its `transitMax`,
its `floor(transitMax / interval) + 2` and its measured margin of 3 — is **deleted in full**.

That derivation existed because under a quota the number of cars a level needed was a *guess*: it
depended on how many the player misrouted and how many were still in flight when the quota-completing
car landed, and slice 1 found it eroded to a margin of one car at band 5 without anything failing
([`generation.md` §7.4](generation.md#74-when-a-target-is-missed)'s levers walked through it).
Under a clock the count is not a guess. It is `floor((LEVEL_TICKS - 1 - SPAWN_LEAD + JITTER) / INTERVAL) + 1`
at most, and an exact array at the seed. **A safety constant that a normative lever moves through
has to be written as a function of the lever** — §8.4's lesson — and the best possible version of
that is a constant that stops existing because the quantity it guarded became exact.

| Band | `INTERVAL` | `JITTER` | `SPAWN_COUNT` (upper bound) |
|---|---|---|---|
| 1 | 204 | ±26 | **35** |
| 2 | 150 | ±18 | **48** |
| 3 | 140 | ±18 | **51** |
| 4 | 132 | ±16 | **54** |
| 5 | 128 | ±16 | **56** |

The invariant that replaces [AC-123](acceptance-criteria.md)'s old throw is an equality: in a run
that reaches `LEVEL_TICKS`, **`nextSpawn === spawns.length`** — every scheduled car entered. A
schedule that stops short of the clock, or an engine that stops consuming it early, fails that and
nothing else would catch it. ([AC-123](acceptance-criteria.md), [AC-139](acceptance-criteria.md),
[AC-808](acceptance-criteria.md))

Because `INTERVAL - 2*JITTER >= 60` for every band
([`generation.md` §6.1](generation.md#61-the-table)), `tick[i+1] > tick[i]` strictly, always — the
schedule can never invert or collide. The jitter exists so the spawn stream is not a metronome: a
perfectly regular beat lets a player pattern-match a rhythm instead of attending to the cars, which
is the opposite of the game's subject. **Under a two-minute clock the beat is heard 32 to 56 times
in a row rather than 16 to 51, so the jitter matters more than it did**, and it has been widened in
proportion to `INTERVAL` at every band.

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
2. Edge lengths are `|Δx| + |Δy|` in exact integers (§2.2) — no arc length, no `Math.hypot`.
3. Both PRNG streams are 32-bit integer operations via `Math.imul` and `>>> 0`.
4. Inputs are tick-stamped and ordered by junction id, never by arrival order.
5. Iteration over cars is by ascending id; iteration over junctions is by ascending id.
6. The level's length is `LEVEL_TICKS`, an integer compared against `state.tick`, never a
   wall-clock deadline.
7. `events` is cleared at the start of every step, so it is a pure function of the tick and does
   not accumulate.

### 2.9 Events are render hints, and only that

`state.events` exists so the renderer can start an animation on the tick a thing happened. The
engine never reads it back. Every animation inside the play surface derives its phase from
`currentTick - eventTick`, which means a replay paints identically to the live run
([AC-505](acceptance-criteria.md)).

**An event therefore carries everything its animation needs to be placed, and nothing else.** That
is the rule that decides what goes on an event. `edgeId` on `delivered` and `misrouted` (§2.6) is
there because the animation is anchored to a terrace line and the depot does not identify the road;
the alternative is the renderer re-deriving a fact the engine already had, which is the shape of a
bug (`docs/development-process.md:173`) even when the derivation happens to be sound. The test for
a proposed event field is not "could the renderer work it out?" but "is the renderer's only route
to it a second derivation?" A field that fails that test does not go on the event, because
`state.events` is not a general-purpose state export; `serialise.js` is.

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

**Orthogonal roads make this rule visible for the first time.** A branch node is now a corner or a
T: one outgoing edge leaves the node vertically and the other leaves it *horizontally*, or the two
leave in opposite horizontal directions ([`generation.md` §2.3](generation.md#23-edges)). The
moment a car commits is the moment it turns, and the turn is a 90° change of heading rather than
the few degrees of tangent a cubic gave it. Nothing in the rule changed; the drawing stopped hiding
it.

### 3.2 Inputs are applied before movement

Step 2 (apply inputs) precedes step 4 (advance) within the same tick. A tap stamped at tick `T`
is therefore honoured by a car that transitions during tick `T`.

This is the player-favourable reading and it is the only one that makes tap timing legible: if
the car has not yet reached the junction when you tap, your tap counts. There is no hidden
commit window in the simulation.

### 3.3 The one honest caveat: render latency

The simulation has no commit window, but the *screen* does. The player is looking at a frame
painted from tick `T-1` or earlier, and their tap is stamped to the tick the React layer is
about to run. The ambiguous window is therefore about one frame — 16.7 ms, or 2.75–3.35 LU of car
travel, roughly 3 % of a car's length.

This is mitigated in the UI, not in the rules: when a car is within `COMMIT_PREVIEW = 200 LU` of
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

**Two inputs on one tick are reachable with one finger, which is why this rule is load-bearing
even though the game is single-pointer** ([`ui.md` §10.3](ui.md#103-gestures)). A tap is stamped
to the next tick the layer will simulate (§3.3), so any two taps that arrive between two
consecutive `step()` calls share a tick stamp. At 60 fps that window is 16.7 ms and the case is
rare; on a device running at 30 fps it is 33 ms, and two taps 20 ms apart — which
[AC-309](acceptance-criteria.md) requires to both be enqueued — land in it. Under a
`MAX_CATCHUP_TICKS` catch-up the window is longer still. There is no debounce and no coalescing,
so the queue must order them, and ordering by arrival would make the result depend on how the
platform happened to deliver two touches. Ascending `junctionId` is a property of the board.

---

## 4. Rules, scoring and failure

### 4.1 Lives

```
LIVES = 3
```

Three is the smallest number that supports a distinct **last life** state (which the UI needs to
communicate jeopardy, [`ui.md` §8.5](ui.md#85-last-life)) while still allowing two recoveries. **It
is the same three at every band, and round 9 measured that choice rather than inheriting it** — the
reference game this reimplements tightens lives with level, so the axis was tried. One life is worth
**16 to 26 percentage points** of clear rate at this ladder's per-car error, against a 15-point
ceiling on any single band-to-band step, and a band given fewer lives has to be given a *sparser*
board to stay in window — which is the opposite of what the ladder escalates.
[`generation.md` §6.1.5](generation.md#615-lives-were-measured-as-a-lever-this-round-and-they-are-too-strong-to-be-one)
has the measured misroute distribution and prices the one shape in which lives could still be used:
**an extra rung past band 5, not a re-tune of it.** That is on the owner's list, not the designer's
([`generation.md` §7.4.2](generation.md#742-the-tier-5-register--what-only-the-owner-can-settle)
item L).

 A
level ends on the terminal check of the tick in which the third life is lost — that is, after
every arrival on that tick has resolved (§2.6), not in the middle of them. `lives` is clamped at
0, so two misroutes on the tick that takes the player from one life to none leave `lives === 0`,
`misrouted` up by two, and `phase === 'lost'`.

**Lives survived the move to a fixed clock, and the alternative was considered and rejected.** A
timed run could end only on the clock, with misroutes costing nothing but the delivery they threw
away. Three reasons it does not:

1. **A loss has to be legible.** Without lives, a bad run and a good run differ by a number the
   player reads at the end. With lives, the run stops and the player knows exactly which car did
   it.
2. **It is what makes the difficulty measurable.** A level is cleared when it collects at most
   `LIVES - 1 = 2` misroutes across its `N` arrivals, so the clear rate is
   `P(Binomial(N, p) <= 2)` — a threshold on the per-car error rate
   ([`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)).
   Without it, difficulty would show up only as a slightly lower mean score, and every shape rule
   in [`generation.md` §7.2](generation.md#72-target-1--the-clear-rate) — R2's gradient, R3's wall
   ceiling — would have nothing to bite on.
3. **It is the only thing that makes the clock feel like a run rather than a timer.** Two minutes
   with nothing at stake is an exercise.

### 4.2 The clock, and what ends a level

**A level is exactly `LEVEL_TICKS = 7200` ticks — two minutes — and then it ends.** `quota` does
not exist. There is no delivery count that finishes a level early and no way to shorten one.

A level ends on the tick at which either condition first becomes true, checked in this order
(§2.5 step 5):

1. `lives <= 0` → **lost**
2. `tick + 1 >= LEVEL_TICKS` → **ended** (cleared)

Cars still in flight when the level ends are discarded without scoring. The renderer freezes
them in place and dims them ([`ui.md` §8.6](ui.md#86-level-complete)). At every band there are
between two and four of them, and that is the honest cost of a hard stop: the clock does not wait
for the board to clear, and a car three quarters of the way to its depot is simply lost. The
alternative — let the board drain after the clock — would make the level's real length depend on
what was in flight, which is the thing the owner asked to remove.

**What the two minutes buys, and what it costs.** The brief always said "about two minutes" and
the old ladder read that as a ceiling, running 49 s at band 1 up to 110 s at band 5 so that a
player's first win arrived inside the first minute. The owner has played it and asked for a fixed
two minutes, and that is settled. The consequence worth stating plainly is that **band 1 is now
two minutes long**, two and a half times what it was, and it is the first thing a new player
meets. §5's band table answers that in the only way left to it: band 1's spawn interval is
**204 ticks (3.40 s)**, the slowest in the game by a wide margin, so the two minutes carry 32 cars
rather than 52 and the board holds 2.9 at a time. Band 1 is long, but it is not busy.

### 4.3 The score is the number of cars delivered

```
score = state.delivered
```

That is the whole scoring system. There are no points, no streak multiplier, no life bonus and no
time bonus.

**Why, and what was deleted.** Under a quota, `delivered` ran to a known target and stopped, so it
could not be a score — it was progress, and the score was a separate points total
(`100 + 10 * min(streak - 1, 9)`, plus `50` per life remaining) laid on top. Under a clock,
`delivered` *is* the interesting number: it is throughput over a fixed window, it rises with skill,
and it is the thing the player is actually doing. Putting a points total on top of it would mean
the big number in the HUD is a monotone function of the number underneath it — two quantities that
must agree, which is the bug shape this project keeps finding
(`docs/development-process.md:173`) — and it would make the headline number stop meaning "cars".

So `SCORE_DELIVERY`, `SCORE_STREAK_STEP`, `STREAK_CAP` and `SCORE_LIFE_BONUS` are deleted, and
with them the count-up animation's arithmetic and one HUD element.

**`streak` and `bestStreak` stay**, as reported statistics on the end-of-level panel and as
persisted bests (§7). They cost one integer each, they give a good run something to have been good
*at* beyond the total, and they are what the misroute breaks in the moment. They multiply nothing.

`delivered` is a non-negative integer and is **non-decreasing** — a misroute never subtracts.
That is an engine invariant the fuzzer asserts (`docs/development-process.md:130`), and it is also
a design position: the punishment for a misroute is the life and the broken streak, not a number
going backwards. ([AC-120](acceptance-criteria.md))

**Modelled score by band**, from `N` and the per-car error the sweep is expected to measure — this
is a *prediction*, and [`generation.md` §7.3](generation.md#73-target-2--the-delivery-band) is
where the measured version lives:

| Band | arrivals `N` in two minutes | a clean run delivers | expected delivered |
|---|---|---|---|
| 1 | 32 | 32 | ≈ 31.6 |
| 2 | 44 | 44 | ≈ 42.1 |
| 3 | 47 | 47 | ≈ 43.0 |
| 4 | 50 | 50 | ≈ 43.8 |
| 5 | 52 | 52 | ≈ 42.7 |

**The score is a within-band signal, not a between-band one**, and that is worth knowing before
someone reads the table as a difficulty claim. A harder band spawns slightly more cars and loses
slightly more of them, and the two nearly cancel: the expected score is flat from band 3 upward.
What separates the bands is how often the run survives to the end, not how much it scores when it
does.

### 4.4 Cars do not interact

Cars pass through one another with no collision, no queueing and no speed change. Reasons:

- A second failure mode (traffic jams) would make the generator's solvability analysis much
  harder and would introduce a way to lose that the player cannot see coming.
- The topology keeps it out of sight almost everywhere (§4.5), and §4.5b is the exception, which
  is drawn rather than ruled.

### 4.5 Why two cars never overlap on the same road, except at a depot

**The heading is the claim, and the claim is narrower than it reads.** The argument below proves
something about two cars that took the **same path**. §4.5b is the case it does not cover, and
under orthogonal roads that case got materially bigger.

The route portion of the network is a **tree**: no node above the depot row has more than one
incoming edge ([`generation.md` §2.4](generation.md#24-merge-free-by-construction)). Two cars are
on the same route edge only if they travelled the identical path from the entry. All cars move at
the same constant speed, so their separation along that path is exactly their spawn separation in
ticks times the speed:

```
minSeparationLu = (INTERVAL - 2 * JITTER) * SPEED_MLU / 1000
```

| Band | min separation | car length | clearance |
|---|---|---|---|
| 1 | 418 LU | 104 LU | 314 LU |
| 2 | 331 LU | 104 LU | 227 LU |
| 3 | 317 LU | 104 LU | 213 LU |
| 4 | 320 LU | 104 LU | 216 LU |
| 5 | 322 LU | 104 LU | 218 LU |

The worst case, band 3, leaves 213 LU — about 78 pt on an iPhone 16 — of clear road between two
cars. This is a *structural* guarantee for cars on a common path, and it is not a tuned one: no
network the generator emits can violate it. ([AC-124](acceptance-criteria.md))

### 4.5b Where the guarantee stops: the shared approach road

Paths converge in exactly one place — the depot row. V2
([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate)) requires terminal
targets to be non-decreasing rather than strictly increasing, so two or three terminal edges may
feed one depot, and with orthogonal routing they do so by running down **the same vertical road**
for the whole of the last row ([`generation.md` §2.3](generation.md#23-edges)). Two cars on it
took different paths of different lengths, so nothing constrains their separation.

**This is worse than it was, and the owner's change bought it.** Under cubic edges the two
approaches were separate curves that converged only in the last stretch, and slice 1 measured two
cars coming within a car length in **0–5 runs per 1,000**. Under orthogonal routing the shared
stretch is `rowH` — 180 to 216 LU — and the same measurement, over 800 seeds per band with an
oracle router choosing arms at random, reads:

| Band | converging pairs examined | pairs within a car length | per 1,000 runs | closest observed |
|---|---|---|---|---|
| 1 | 37,878 | 59 | **74** | 3 LU |
| 2 | 110,561 | 241 | **301** | 0 LU |
| 3 | 78,128 | 178 | **223** | 0 LU |
| 4 | 113,354 | 172 | **215** | 3 LU |
| 5 | 98,488 | 47 | **59** | 27 LU |

*Measured in the designer's prototype with a random choice of arm, which overstates the rate a
real player produces (a player routes for colour, not at random) and understates nothing. The
figure the tester holds the build to is [AC-513](acceptance-criteria.md)'s, taken from the real
generator and the real bot.*

**Three repairs were considered and two were measured.**

- **Rejected, measured: make every path to a depot the same length** (V16 — all root-to-depot
  paths ending at the same depot carry the same number of jogs, so their arc lengths are equal and
  §4.5's spawn-separation guarantee extends to the shared road). It is the complete fix and it is
  unaffordable. Over 3,000 seeds per band it takes generation from 3,000/3,000 valid to
  **2,976 and 2,960** at bands 3 and 5 — `GEN_EXHAUSTED` in play, which
  [AC-203](acceptance-criteria.md) forbids outright — the attempt count from a median of 1–2 to
  **37 and 40** with a p95 of **150 and 168** against AC-203's ceiling of 128, and distinct edge
  topologies from `63 / 251 / 312 / 744 / 794` to `30 / 128 / 160 / 240 / 171`. It is the same finding
  [`generation.md` §5.1](generation.md#51-why-v6-was-not-simply-strengthened) records about
  strengthening V6, arriving from a different direction: the merge-free space is small, and a
  global constraint on it is nearly unsatisfiable.
- **Rejected without measurement: forbid shared depots** (terminal targets strictly increasing).
  It is arithmetic, not a trade. A merge-free network with `K` leaves and binary branching has
  exactly `K - 1` branch nodes, so `J` would be pinned at `K - 1` — **4 at band 5, against a
  band table that asks for 7 to 9**. The shared depot is what pays for the junction count;
  [`generation.md` §5.1](generation.md#51-why-v6-was-not-simply-strengthened) already says so from
  the other side.
- **Taken: draw it.** [`ui.md` §7.6](ui.md#76-the-depot-terrace) covers the last `mouthLu` of
  every terminal edge with the depot terrace, sized per band at its maximum legal value
  `rowH - JUNCTION_MARK_R - 12` = **170 / 170 / 134 / 134 / 134** LU, so all but the top 46 LU of
  the shared approach is under the building. A car is hidden for 1.03 / 0.98 / 0.73 / 0.70 /
  0.67 s before it resolves — *less* than the 0.61–1.00 s the old apron hid — and the residual is
  two cars whose centres are both inside a 46 LU window, each of them then more than half covered.
  The residual is **not zero and is not claimed to be**; [AC-513](acceptance-criteria.md) is
  where it is bounded and reported. This is the same decision §8.8 recorded, taken again against a
  bigger number, and it is recorded again in §8.8 because the number changed.

### 4.6 Why a junction is always flippable in time

**The heading is the claim, and — as in §4.5 — the claim is narrower than it reads.** What follows
is about the gap between **two cars** at one junction. It says nothing about the gap between a car
**appearing** and its first decision, and §4.6b is the case it does not cover.

Two cars arrive at the same junction only if they took the same path to it, so their arrival
separation equals their spawn separation. The minimum across all bands is band 5's
`128 - 26 = 102` ticks = **1.70 s**. The full set is `2.77 / 1.95 / 1.87 / 1.75 / 1.70 s`, monotone
decreasing, because [`generation.md` §6.1](generation.md#61-the-table)'s `interval` column is.

*Every one of those numbers rose in round 9, and none of them was bought with a lever pull. They
rose because car speed stopped rising up the ladder: the window is `(interval - 2*jitter) / 60`, and
holding the board's occupancy at a target while `speed` falls means `interval` goes up.*

What this section claims is a floor, and the floor is **1.50 s**. One and a half seconds is four
times the sum of a human's visual reaction (~250 ms) and tap (~100 ms). **No band asks the player
to re-flip one junction between two cars inside 1.6 s.** The difficulty is the *aggregate* load
across several junctions, which is what the constrained bot measures
([`generation.md` §7](generation.md#7-the-measurable-targets)).

*The floor moved from 1.00 s to 1.50 s and the reason is §4.6b, not this section: the same lever —
`interval` — sets both windows now, and the first-decision floor is the binding one.*

### 4.6b The other window: from a car appearing to its first decision

**This is the window the owner rejected the game over, and it is the one place in this design
where an acceptance criterion certified something a person could not do.**

A car's colour cannot be known before it spawns. Nothing about its first junction can be prepared:
the player can watch the spawn point, but there is nothing to read there until the car is on it. So
for the first branch node on a car's path, the whole decision — notice, read the colour, recall
that colour's depot, decide, tap, and have the tap land before the car is on the junction — has to
fit inside the time the car takes to travel from the entry node to that branch node.

```
L1                 = path length in LU from the entry node to the first branch node on the path
firstDecisionTicks = ceil( L1 * MLU / CAR_SPEED )
```

**Row 0 is now always a pass node** ([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate),
**V14**), so no car's first junction is one row below the entry. `rows[0]` holds exactly one node,
and under [`generation.md` §2.3](generation.md#23-edges)'s construction rule a pass node's single
outgoing edge is vertical, so `rows[1]` holds exactly one node too and `L1` is at least
`ENTRY_LEN + rowH`.

| Band | speed | `ENTRY_LEN` alone (the old worst case) | `ENTRY_LEN + rowH` | round 8 | floor |
|---|---|---|---|---|---|
| 1 | 2750 | 80 ticks — 1.33 s | **159 ticks — 2.65 s** | 2.65 s | 90 |
| 2 | 2750 | 80 — 1.33 s | **159 ticks — 2.65 s** | 2.52 s | 90 |
| 3 | 2750 | 80 — 1.33 s | **146 ticks — 2.43 s** | 2.20 s | 90 |
| 4 | 2750 | 80 — 1.33 s | **146 ticks — 2.43 s** | 2.08 s | 90 |
| 5 | 2750 | 80 — 1.33 s | **146 ticks — 2.43 s** | 2.00 s | 90 |

**The worst case moved from 2.00 s to 2.43 s in round 9, and nothing was traded for it.** Speed left
the band table ([`generation.md` §6.1](generation.md#61-the-table)) because it was flattening the
difficulty ladder, and this window is `(ENTRY_LEN + rowH) / speed`, so a ladder that stops
accelerating stops shortening it. **No band is now given less time for its first decision than band 1
was given in round 8** — which is the strongest form of the guarantee §6.9 asked for, because it does
not depend on any number derived from the bot.

> **The first-decision floor.** `firstDecisionTicks >= 90` (1.50 s) at every band, for every path,
> in every generated level. ([AC-245](acceptance-criteria.md))

**The floor was 40 ticks and it was wrong, and saying how it was wrong matters more than the new
number.** Round 4 raised `ENTRY_LEN` from 100 to 160 LU, which took the band-5 first decision from
450 ms to **717 ms**, and [AC-245](acceptance-criteria.md) certified it: 43 ticks against a floor
of 40. The constrained bot cleared it. **The owner then played it and could not.**

The floor of 40 was derived from the bot's own constants — `BOT_ACQUIRE_TICKS` 15 to read a colour
and bind it, one tick to act, `BOT_LOCKOUT_TICKS` 6 of runway, plus one more acquire of slack
because the player might be mid-glance — and that derivation prices **one decision made in
isolation**. [`generation.md` §7.1.7](generation.md#717-the-first-decision-deadline-and-why-the-bot-must-not-be-given-it-for-free)
had already established, in the same round, that the binding term is not the cost of the decision
but the **latency to starting it**, which grows with traffic. The floor never contained that term.
So it was a check derived from half of an inequality its own document had written down in full, and
it passed a window a person fails. **That is a limit on what the instrument can certify, and it
belongs in the document:** a criterion derived from the model of a player can only be as complete
as the model, and where the model has two terms the criterion may not price one.

The new floor prices both:

```
decision, uninterrupted   BOT_SCAN_TICKS 6 + BOT_ACQUIRE_TICKS 15 + 1 act + BOT_LOCKOUT_TICKS 6 = 28
one focus already running  BOT_SCAN_TICKS 6 + BOT_ACQUIRE_TICKS 15                              = 21
the sweep coming round     BOT_SCAN_TICKS 6 x cars in flight (2.9 - 3.9)                        = 18 - 24
                                                                                          total = 67 - 73
                                                                        rounded, with margin ->   90
```

Measured against it, every band passes with 30 to 69 ticks in hand, and band 5 — the tightest, and
the band the owner was playing — sits at **2.00 s against the 0.72 s that was rejected**. The floor
also no longer rests on `ENTRY_LEN` alone, which is what made it fragile: it rests on
`ENTRY_LEN + rowH`, and `rowH` is the one geometric quantity that cannot be spent without the
network getting shallower.

**The counterfactual is kept because it is the fallback if V14 is ever reconsidered.** With row 0
free to branch, `firstDecisionTicks` would be `80 / 76 / 73 / 69 / 66` — above the old floor of 40
at every band, and *below* the new floor of 90 at every band. `ENTRY_LEN = 220` alone does not
buy a fair first decision. V14 does.

**This is therefore still a claim the drawing has to keep.** If a car's arrival is not an abrupt
luminance transient on screen, the onset does not capture attention, and the first decision goes
back to being found by search
([`generation.md` §7.1.5](generation.md#715-the-per-tick-procedure--normative) D3).
[`ui.md` §7.5](ui.md#75-car) is where that is specified and
[AC-517](acceptance-criteria.md) is where it is checked.

### 4.7 Every level is solvable, provably

The generator guarantees every depot is reachable from the entry and every junction has both
branches leading to at least one depot
([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate)). Combined with
§4.6 and §4.6b, an unconstrained solver — one allowed to tap any junctions on any tick — delivers
**every car that arrives, at every band, with zero misroutes**. That is a required, measurable
acceptance criterion, not an aspiration ([AC-220](acceptance-criteria.md)).

*Under a clock this is stated per car rather than per level, because every level "completes": the
unconstrained bot's claim is now that it never misroutes and that its delivered count equals `N`,
the number of arrivals the schedule and the clock allow.*

Being clearable by an omniscient bot proves nothing about playability. That is what the
constrained bot is for.

### 4.8 How a level opens

**Every junction starts pointing left.** `state.open` is all zeros at tick 0, and `node.out[0]` is
always the lower-column branch (§2.3), so an untouched network sends every car to the leftmost
depot it can reach ([AC-138](acceptance-criteria.md)). The alternative — seeding `open` from the
level seed so each level opens differently — is rejected.

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

**The window this creates.** The first car enters at `SPAWN_LEAD = 90` ticks and must cross
`ENTRY_LEN + rowH` before it reaches the first junction it can meet:

| Band | entry-to-first-junction transit | first decision at | wall time |
|---|---|---|---|
| 1 | 159 ticks | tick 249 | 4.15 s |
| 2 | 151 | 241 | 4.02 s |
| 3 | 132 | 222 | 3.70 s |
| 4 | 125 | 215 | 3.58 s |
| 5 | 120 | 210 | **3.50 s** |

So the player has at least **3.50 s** from the first tick to read the board and set the first
junction if the default is wrong for the first car, and it is the *only* moment in a level where
the board is empty while a decision is pending.

This paragraph is about the **first** car only, which is why it was never the guard that mattered:
`SPAWN_LEAD` buys the opening car 1.5 s that no later car gets. Every car after it has only the
entry-to-first-junction transit, and that is §4.6b.

---

## 5. Difficulty

Five bands. Level `N` maps to a band, and the band supplies every parameter.

| Band | Levels | Colours `K` | Columns `C` | Rows `R` | Junctions `J` | Actionable `Ja` | Depth `D` | `colW` | Interval (ticks) | Jitter | **Cars on screen** | Arrivals `N` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | **3** | 3 | 5 | 3–4 | ≥3 | 2–3 | 300 | **208 (3.47 s)** | ±21 | **2.73** | **32** |
| 2 | 5–9 | **4** | 4 | 5 | 3–5 | ≥3 | 2–3 | 264 | **147 (2.45 s)** | ±15 | **3.96** | **45** |
| 3 | 10–15 | **4** | 4 | 6 | 4–6 | ≥4 | 2–4 | 264 | **140 (2.33 s)** | ±14 | **4.26** | **47** |
| 4 | 16–22 | **5** | 5 | 6 | 5–7 | ≥5 | 2–4 | 198 | **131 (2.18 s)** | ±13 | **4.38** | **50** |
| 5 | 23+ | **6** | 6 | 6 | 7–9 | ≥7 | 2–5 | 158 | **128 (2.13 s)** | ±13 | **4.40** | **51** |

**Car speed has left this table.** It is `CAR_SPEED = 2750` MLU/tick = 165 LU/s at every band —
the owner's instruction, and
[`generation.md` §6.1.1](generation.md#611-cars-in-flight-is-the-ladder-and-it-has-exactly-two-inputs)
is the measurement that says the per-band speed column was the thing flattening the difficulty
ladder. **Lives are 3 at every band** and §4.1 records why that was measured rather than assumed.

`quota` is gone. **`N` — the number of cars that arrive inside two minutes — has taken its place,
and it is not a parameter.** It is `120 s / interval` less the cars still in transit at the bell,
computed in [`generation.md` §6.1](generation.md#61-the-table) and reproduced here because it is
the quantity every difficulty statement in these documents is made against.

`J` and `D` ranges are measured outcomes of the generator over 3,000 seeds per band, not targets
([`generation.md` §6.2](generation.md#62-measured-generator-behaviour)). `D` is the number of
junctions on a root-to-depot path; a band's range means different colours in the same level take
different numbers of decisions, which is deliberate — some colours are a rest.

**`J` and `Ja` are different claims and only `Ja` is a difficulty claim.** `J` counts the junctions
the player can see and tap. `Ja` counts the ones a perfect player has to flip: where one branch's
reachable colours are a strict superset of the other's, the superset branch serves every colour the
subset branch does and the junction never has to move. `Ja` is a validity rule
([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate), V13) and a measured
one ([AC-242](acceptance-criteria.md), [AC-243](acceptance-criteria.md)). A decorative junction is
not worthless — it is a real branch a car takes and a real thing to read — but it is scenery, and
the difficulty table may not be paid for it.

### 5.1 What escalates, and in what order

| Step | What changes | Why that axis |
|---|---|---|
| 1 → 2 | Network widens (3→4 columns), **a fourth colour**, and the board **saturates**: 2.7 → 4.0 cars on screen at once, 3.47 s → 2.45 s between cars | Level 5 is where the game stops being a tutorial. Band 1 runs *below* the player's working set, so a car never has to be dropped; this is the step that takes it above, and that is the mechanical content of "the game starts" |
| 2 → 3 | A **sixth row** — the deepest networks so far — and 4.0 → 4.3 cars | The one step where the colour count repeats. Depth is what it buys instead, and the extra row is what a fourth colour needed in order to mean anything |
| 3 → 4 | Network widens again (5 columns), a **fifth colour**, more junctions, 4.3 → 4.4 cars | Width and colour together, now that four colours are habitual. More depots to keep apart, more roads between them |
| 4 → 5 | **Sixth colour**, sixth column, the deepest paths, 4.4 cars | The ceiling, and it is a real one: six columns is the most `DESIGN_W = 1000` can carry at a 44 pt tap target, so six colours is the most this game can have ([`generation.md` §3.2.1](generation.md#321-colw-is-derived-not-chosen)) |

**Four axes, and every one of them is visible to the player**: how many cars are on the screen, how
many colours are in play, how wide and deep the network is, and how long the paths are. Round 8 had
a fifth — **car speed** — which was invisible as escalation and was actively working against the
others; it is now one constant at every band
([`generation.md` §6.1](generation.md#61-the-table)). **Lives are deliberately not an axis**, and
[`generation.md` §6.1.5](generation.md#615-lives-were-measured-as-a-lever-this-round-and-they-are-too-strong-to-be-one)
is the measurement that decided it: one life is worth 16–26 percentage points of clear rate, against
a 15-point ceiling on any single band-to-band step.

**Cars on the screen is monotone for the first time in this design's history, and that is round 9's
whole content.** Round 8's table read `2.72 / 3.70 / 3.74 / 3.77 / 3.66` — flat from band 2 and
*falling* from band 4 to band 5 — because `interval` fell 37 % across the ladder while car speed
rose 22 %, and the board's occupancy is `transit / interval`, so the two cancelled. The owner's
instruction — *"the vehicle should keep their constant speed regardless of level, there should be
more vehicles appears"* — is the fix, and
[`generation.md` §6.1.1](generation.md#611-cars-in-flight-is-the-ladder-and-it-has-exactly-two-inputs)
is the arithmetic for why it is the fix. The old paragraph below is kept because its *reasoning* about
`interval` is still right; it was simply being cancelled by a column nobody was watching.

 Under the quota model
[`generation.md` §7.4.1](generation.md#741-the-lever-order-under-a-clock-and-what-round-6-proved-that-still-holds) proved that `interval`
*could not* stay monotone past band 3: band 5 needed a long interval to clear its floor and band 4
needed a short one to stay under its ceiling, so the ladder's traffic axis inverted. Under the
clock it does not, and the mechanism is arithmetic rather than taste. Cutting `interval` now does
two things at once: it raises the per-car error rate `p` *and* it raises `N`, the number of cars
that have to be got right. A given drop in clear rate is therefore bought with roughly half the
rise in `p` it used to cost, and the cliff that stopped band 4 → 5 disappears.
[`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)
has the arithmetic.

What escalates alongside it is **decisions per car** (mean junction depth `2.36 / 2.57 / 2.87 /
3.10 / 3.45`, measured over 3,000 seeds per band), **colours** (`K` at `3 / 4 / 4 / 5 / 6`) and
**cars that must be got right in a row** (`N` at `32 / 45 / 47 / 50 / 51`).

**One honest note on the colour axis, which is why the repeat sits at 2 → 3.** A colour on its own
is worth very little *to the instrument*: the bot pays per *car held*, not per colour in the world,
so a colour costs attention mainly through the deeper networks it makes possible
([`generation.md` §7.4.1](generation.md#741-the-lever-order-under-a-clock-and-what-round-6-proved-that-still-holds)). The step still reads
as the game's biggest change to a player, because a fourth colour is a fourth thing to recognise
and a fourth depot to remember, and that is why it stays where it is. But the difficulty it buys is
bought by the sixth row that comes with it, and a future lever pull should not expect `K` to carry
a band on its own.

### 5.2 Within a level

Nothing ramps inside a level. Speed, spawn interval and colour count are constant from the first
car to the last. Reasons:

- The clock is the only progress signal the player needs; a hidden difficulty curve inside a
  two-minute level is invisible pressure.
- A constant-rate level is analysable: `N` is a known integer, which is what makes
  `P(Binomial(N, p) <= 2)` the right model and the clear rate a measurable criterion rather than an
  aspiration.

The level does get harder in one way, and it is emergent rather than scripted: after a misroute
the streak resets and the player's own state of mind changes. That is enough.

### 5.3 Session length

**Every level is 7,200 ticks. There is nothing to measure.**

That sentence is the whole of what used to be a table of nominal durations, design bands, measured
medians and a 130 s absolute ceiling, plus [`generation.md` §7.3](generation.md#73-target-2--the-delivery-band)'s
completion-time target and five acceptance criteria. All of it is deleted, and the deletion is the
single biggest simplification the owner's change brought: **duration stopped being a thing that can
be got wrong.**

Two things follow that are worth stating because they used to be arguments and are now facts:

- **A losing run is always shorter than a clearing one.** It always was, and it still is; it is now
  true by construction rather than by measurement, because a clearing run is exactly 120 s and a
  lost run is whatever fraction of it the player survived.
- **§7.4's lever order lost its duration constraint.** Under the quota model a lever pull had to
  satisfy the clear-rate target *and* the completion-time band, and slice 1's worked example was a
  pull that fixed one and broke the other. There is no second target to break any more, and
  [`generation.md` §7.4](generation.md#74-when-a-target-is-missed) is correspondingly shorter — and
  correspondingly more dangerous, because the constraint that used to stop a lever being pulled too
  far has been replaced by one that is easier to ignore (§7.3's delivery band is a report, not a
  bound).

What replaces the duration target is the **delivery band** — the number of cars delivered per run,
by band ([`generation.md` §7.3](generation.md#73-target-2--the-delivery-band)). It is not a
constraint on the design in the way duration was; it is the quantity that tells you *what happened*
in a run whose length tells you nothing.

---

## 6. Run control

### 6.1 Pause

`phase` stays `'running'`; the React layer simply stops calling `step()` and sets its own
`paused` flag. The engine has no concept of pause, because a pause that the engine knows about is
a pause that can be got wrong in a replay. Taps are discarded while paused.

**Under a fixed clock, pausing stops the clock**, because the clock is `state.tick` and `state.tick`
only advances inside `step()`. There is no wall-clock deadline to run down while the game is
paused, and therefore no way to lose time by pausing and no way to gain it. This is a property of
§2.1's decision to make the level length a tick count, and it is the main reason that decision is
worth its one paragraph. ([AC-128](acceptance-criteria.md), [AC-803](acceptance-criteria.md))

### 6.2 Background and resume

On `AppState` leaving `'active'` the React layer pauses (§6.1) and **zeroes its tick
accumulator**. On resume it shows a 3-2-1 countdown (3 × 600 ms) and only then resumes calling
`step()`. The countdown is wall-clock and involves no simulation ticks, so it costs the player no
level time.

### 6.3 Retry

Retry rebuilds the level from the same seed and starts a fresh state at tick 0. The same seed
always produces the same network and the same spawn schedule, so retrying is retrying the same
level, not a re-roll.

---

## 7. Progression (slice 4 territory, specified here so it is not invented later)

- Levels are numbered from 1 and unlock in sequence. **Clearing level `N` means surviving its two
  minutes** — `phase === 'ended'`, not `'lost'` — and that unlocks `N+1`. There is no delivery
  target to hit; the bar is "do not lose three cars". ([AC-703](acceptance-criteria.md))
- Level `N`'s seed is `mix32(RUN_SEED ^ Math.imul(N, 0x9E3779B1), GEN_SALT)` where `RUN_SEED` is
  a per-install constant. Every install gets a different ladder; every device replays its own
  ladder identically.
- Per level the game stores: cleared (bool), **best delivered**, best streak, fewest misroutes.
- There is no star rating, no currency, no energy, no ads, no accounts and no network calls.
- Level 1 is always playable. There is no gate before the first level.

**Why the unlock is survival and not a delivery target.** A delivery target is a quota by another
name, and the owner removed the quota. It would also be the wrong shape: two players who both
survive two minutes have both demonstrated the skill the level teaches, and one of them getting
three more cars because their seed spawned a friendlier colour order is not a reason to gate them.
`delivered` is what a player competes with themselves on; survival is what the game asks for.

---

## 8. Decisions that were genuinely open, and where they landed

Each of these is decided and designed on. They are listed because they are the ones most worth a
second look, not because they are unresolved.

### 8.0 The clock, the score and the three lives — **decided, round 8**

The owner's words were *"I want to have fixed time, not fixed number of vehicles — 2 minutes."*
That settles the clock. Two things it does not settle were decided here and are stated in one
place so they are not re-argued in three:

- **Three misroutes still ends the run early** (§4.1). It keeps a loss legible, it is what makes
  `P(Bin(N, p) <= 2)` the governing quantity, and without it none of
  [`generation.md` §7.2](generation.md#72-target-1--the-clear-rate)'s shape rules have anything to
  measure.
- **The score is `delivered`, and there are no points** (§4.3). Under a clock, throughput is the
  interesting number, and a points total laid on top of it would be a second quantity that has to
  agree with the first.
- **A level is cleared by surviving it** (§7). Not by delivering a number.

### 8.1 One entry, not two — **decided, and re-opened by the owner for a later round**
An earlier draft gave bands 3–5 two entry points to create two independent attention fronts.
It was dropped because the merge-free topology (§4.5) makes each entry's tree need
`K - 1` terminal columns, so two entries with four colours need six columns, and at six columns
the junction pitch is already at the 44 pt tap-target floor on a 320 pt-wide viewport
([`ui.md` §4.4](ui.md#44-tap-target-arithmetic)). One entry buys a deeper tree and more colours.
Divided attention comes from the number of cars in flight and the number of colours, both of which
are preserved.

*Round 8 note: band 5 now uses all six columns, so the sixth column this decision was holding in
reserve has been spent. A second entry is no longer available at any band without moving
`DESIGN_W`.*

> **Round 9, owner-directed: deferred, not settled.** The owner has read this rejection against
> round 8's geometry and observed that every number in it moved — the design rectangle, `colW`, and
> the tap-target margin — and that "divided attention" was meant to be *spatial*, which with one
> entry it is not. **He has deferred the question to its own round and instructed that nothing be
> changed or re-measured now, so round 9 changed nothing here.**
> [`generation.md` §9.1](generation.md#91-two-entry-points-gameplaymd-81) is the brief for that
> round: what has to be measured, with which harness, and the one number round 9 did settle — that
> `C = 7` is impossible at `DESIGN_W = 1000` and why.

### 8.2 Merge-free networks — **decided, and re-opened by the owner for a later round**
Allowing two roads to merge above the depot row was prototyped and measured: to stop two cars
converging and overlapping, the generator has to keep all paths to a node the same length, and that
constraint rejects essentially every candidate network at bands 2–5 (measured: 0 valid networks in
2,000 seeds per band). Merge-free removes the problem by construction, satisfies
`docs/development-process.md:96` ("no junction a car can enter from two directions") completely
rather than partially, and generates at 3,000/3,000 with a median of 1–2 attempts. The cost is
that networks are trees rather than graphs, which is a smaller visual vocabulary. It is worth it.

*Round 8 measured the same constraint again in its narrowest possible form — equal path length to a
shared **depot** only, which is the one place merging is allowed — and it is still unaffordable
(§4.5b, V16). Two rounds, two constraint strengths, the same answer.*

> **Round 9, owner-directed: deferred, not settled, and with one thing worth flagging.** Under
> orthogonal routing a path's length is `ENTRY_LEN + r*rowH + jogs*colW`, and `r*rowH` is the same
> for every path to row `r` — so "equal path length" has become **"equal jog count"**, an integer
> condition on a small integer rather than an equality between two arc-length integrals. Both
> previous measurements priced it as a **rejection filter** over a search that does not know about
> it, and a rejection-sampling cost is evidence about the search, not about the space
> ([`generation.md` §5.1](generation.md#51-why-v6-was-not-simply-strengthened) records the same
> shape of mistake). **Nothing is changed here and nothing was re-measured**;
> [`generation.md` §9.2](generation.md#92-merges-gameplaymd-82) is the brief for the round that
> takes it up, including what it would retire — §4.5b, the depot terrace and
> [AC-513](acceptance-criteria.md) all exist only because paths to a shared depot have different
> lengths.

### 8.3 Always-on colour-blind glyphs — **decided**
The glyph on car and depot is always drawn, not gated behind a setting. A mode that only some
players see is a mode that rots: it is not exercised in development, not screenshotted, and not
caught when it breaks. An accessibility setting increases glyph **size and opacity**; it does not
turn the glyph on. The glyph never changes the rules ([`ui.md` §6](ui.md#6-colour-blind-support)).

### 8.4 The spawn schedule is exact, and `SPAWN_SLACK` no longer exists — **decided, round 8**

Slice 0 wrote `SPAWN_COUNT = quota + 8` and called eight cars comfortable slack, on an argument
that counted only the cars that have to *resolve* and omitted the cars still *in flight* when the
last delivery landed. Slice 1 measured the consequence: band 5 seed 160 consumed 71 of its 72
spawns, and 30 of 5,000 band-5 seeds finished with a margin of exactly one car. Nothing had
crashed; the margin had simply been spent without anyone noticing. §2.7 then derived the slack from
the three quantities that consume it, and round 6's lever pull proved the derivation worked — it
moved `interval` and `quota` at four bands and the slack moved with them without anyone editing a
constant.

**Round 8 deletes the whole apparatus, and the deletion is the point.** Under a clock the schedule
is not a guess about how many cars a level will need; it is the list of cars that fit in two
minutes, computed exactly (§2.7). There is no slack, no `inFlightMax`, no `transitMax`, no reserve
entry and no `SPAWN_EXHAUSTED`. [AC-139](acceptance-criteria.md)'s oracle sweep over 2,000 seeds in
two variants, which existed to measure a margin, is replaced by an equality any single run checks.

The lesson generalises past this number and it is worth keeping in the form the two rounds together
give it: **a safety constant that a normative lever moves through must be written as a function of
the lever — and the best version of that is a change to the model that makes the constant
unnecessary.** Round 6 did the first. Round 8 did the second, by accident, because the owner
removed the quota for an unrelated reason.

### 8.5 **Owner recommendation — not a blocker.** Haptics default
Slice 5 adds haptics. The recommendation is **haptics on by default**: a light impact on a
successful flip and an error notification on a misroute, with a settings toggle. Rationale: the
flip confirmation is the one piece of feedback the player needs without looking, and they are
looking at a car, not at the junction they just tapped. This is designed on throughout
[`ui.md` §9](ui.md#9-motion-spec). If the owner prefers off-by-default, only the default
value of one setting changes.

### 8.6 Tap load — **closed by measurement, and re-opened by the clock**

Band 5's estimated sustained tap rate was 1.03 taps/s through slices 0 and 1, and round 6's lever
pull took the measured rate to 0.71 /s against [AC-233](acceptance-criteria.md)'s 1.25 ceiling.

**The clock changes the shape of this number and the ceiling has to be re-read, not reused.** Under
a quota, tap load was a rate sustained for 49–110 s depending on the band. Under a clock it is a
rate sustained for **exactly 120 s at every band**, which is the longest any band ever asked for and
is now what band 1 asks for. The ceiling stays at 1.25 /s because it was derived from what a thumb
can do, not from how long it did it; what changes is that the *duration* at which it must hold is
now uniform and maximal. [AC-233](acceptance-criteria.md) is re-measured under the new table and
the estimate in [`generation.md` §6.3](generation.md#63-tap-load) is recomputed; the estimate is
`0.34 / 0.52 / 0.62 / 0.71 / 0.81` taps/s and the designer's 3,000-seed prototype measures
`0.34 / 0.54 / 0.55 / 0.65 / 0.72`, every band well inside the 1.25 /s ceiling and the estimate
overstating at four of five bands, in the direction §6.3 predicts.

### 8.7 The bot is a model of attention, not of timing — **decided**
Slice 0's constrained bot constrained only *when* it could tap. Slice 1 measured the consequence:
one reading of the policy cleared 100 % of band 5 while obeying every constraint the design
imposed, because nothing in the design ever asked it to divide its attention. A bot with perfect
memory of every car's colour and no cost to switching between cars cannot measure the difficulty
of dividing attention, which is the only thing this game is about.

[`generation.md` §7.1](generation.md#71-the-constrained-solver-bot) specifies a bounded
working set of three cars, a cost in ticks to focus a car, a higher cost to focus one it has
forgotten, a memory that expires after two seconds, and a sweep that must *find* the next car
rather than being handed a sorted list — with one exception, that a car which has just appeared is
looked at next rather than last (§8.10). The line it draws is deliberate: **the static picture is
free, the moving objects are not.**

The sharpest consequence is that the safe-window check ranges over the bot's working set
only. The bot can misroute a car it has forgotten by flipping a junction for a car it is holding
— and never see it coming. That is the game's actual failure mode, and the old instrument could
not produce it at all.

**Round 8 changed none of this and that is deliberate.** The machinery is sound; every number hung
off it was tied to a geometry or a duration that moved.
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed) still forbids changing a §7.1
constant to make a target pass.

### 8.8 §4.5's guarantee is narrowed, not repaired — **decided, and the number got worse**
Slice 0 claimed no two cars ever visually overlap. Slice 1 measured that every level has a depot
fed by two or more terminal edges, and that two cars come within 26 LU of each other there in up
to 5 runs per 1,000. Round 8's orthogonal routing makes the converging stretch an entire row rather
than the tail of two curves, and the same measurement reads **59 to 301 runs per 1,000** (§4.5b).

The options were the same three and the answer is the same one — constrain the generator (measured:
unaffordable, twice, §4.5b and §8.2), forbid shared depots (arithmetically impossible, it pins `J`
at `K - 1`), or draw it correctly. The third is the only one that costs the game nothing, so §4.5's
heading says what its argument proves, §4.5b states the exception with its measured numbers and its
two rejected repairs, and [`ui.md` §7.6](ui.md#76-the-depot-terrace) covers it with the depot
terrace.

**What is new is the honesty requirement.** At 0–5 per 1,000 an uncovered residual was a curiosity.
At 59–301 per 1,000 it is a thing a player will see, so [AC-513](acceptance-criteria.md) is written
to **report the rate as well as bound the geometry**, and the tester is expected to look at a
screenshot of it rather than only at a number.

### 8.9 A road changes column only at a junction — **decided, round 8**

Orthogonal roads make the planarity argument of
[`generation.md` §2.5](generation.md#25-planarity-and-non-coincidence-why-no-two-roads-are-ever-mistaken-for-one) fail: the
old proof was about monotone chords, and two horizontal runs in the same row can be **collinear and
touching**, which draws as one continuous road and is a worse legibility failure than a crossing.
[`generation.md` §2.5](generation.md#25-planarity-and-non-coincidence-why-no-two-roads-are-ever-mistaken-for-one) proves
the replacement by construction, and the construction is one rule:

> **A pass node's single outgoing edge is vertical.** Only a branch node may change column.

Everything else follows from it and from V2. It is also the rule that gives the drawing its
strongest identity statement — **every corner in the network is a junction corner** — and it is what
makes [`ui.md` §7.3](ui.md#73-junction)'s blade unambiguous, because the two branches of a junction
now leave it 90° or 180° apart instead of the 36.87° a cubic gave them.

**What it cost, measured.** Over 3,000 seeds per band, against a generator identical except that a
pass node may change column: distinct edge topologies fall
`380 / 1118 / 913 / 1653 / 1589` → `63 / 251 / 312 / 744 / 794`, and mean jogs per path fall
`2.19 / 2.72 / 2.65 / 3.16 / 3.47` → `1.20 / 1.54 / 1.55 / 1.88 / 2.06`. **That is between 51 % and
83 % of the shape space and it is the single largest cost in round 8.** It is paid for by the finer
grid: every band gained a row or a column, and distinct network **signatures** — topology plus
depot-colour assignment, which is what a player actually distinguishes — come out at
`279 / 851 / 1380 / 2216 / 2745` against [AC-234](acceptance-criteria.md)'s re-derived floors of
`160 / 250 / 360 / 490 / 1000`. Band 1 is the tight one and it is why band 1 has five rows:
at four rows it measures 155 against a floor of 160 and fails
([`generation.md` §6.2](generation.md#62-measured-generator-behaviour)).

### 8.10 A new car is looked at next, and the entry shows no preview — **decided**

The player model's sweep visited the newest car **last**, and that is a wrong claim about people:
an abrupt onset is the standard exogenous capture cue, and in this game every onset happens at one
fixed location the player already knows. The rule costs the full glance and the full colour read;
it only reorders. It took the first decision's failure rate from between 3× and 16× worse than a
later decision to level with one, and it cost the rest of the board, which is the right place for
it to cost something.

**Rejected: show the next car's colour at the entry.** A preview queue is the genre's usual answer
and it is the one change that would have altered what the player is allowed to know. It changes the
subject of the game — the optimal line becomes "watch the queue, pre-set the entry junction",
attention concentrated on a HUD rather than divided across the board — and it does not fix the
mechanism, because the term that scales with traffic is the *latency to first attention* and a
preview slot is one more thing to find in the sweep.

*Round 8 note: the third argument against a preview used to be "there is nowhere to put it", and
that is no longer true — the design rectangle was re-laid out and there is room above the entry.
The first two arguments are the load-bearing ones and they are unaffected.*

### 8.11 What the acceptance criteria could not certify — **recorded, round 8**

[AC-245](acceptance-criteria.md) passed at every band with 3 to 14 ticks of margin, and the owner
then played the game and reported the exact failure the criterion was written to prevent. The
criterion was not misapplied and the measurement was not wrong. The **derivation** was incomplete:
it priced one decision made in isolation, from the bot's own constants, when
[`generation.md` §7.1.7](generation.md#717-the-first-decision-deadline-and-why-the-bot-must-not-be-given-it-for-free)
had already established in the same round that the binding term is the latency to *starting* the
decision, which grows with traffic.

Three things follow and they are not specific to this criterion:

1. **A criterion derived from a player model inherits that model's blind spots**, and a model with
   two terms may not be priced with one. §4.6b's new floor prices both, and says so in the
   derivation rather than in a footnote.
2. **Tier 2 cannot certify fairness.** The constrained bot can tell you whether a window is
   *reachable by the model*; it cannot tell you whether the model is the player. Only tier 5 — the
   owner, or a person — can, and this is the first thing in this project that only tier 5 could
   have found. `docs/development-process.md`'s tier table should be read with that in it.
3. **The bot passing is not evidence that a human passes.** It is evidence that the design is
   consistent with the model. Where the two diverge, the model is what changes — §7.4's exception
   clause — and every target is then re-read, not just the failing one.

### 8.8 Where the tier-5 questions live — **added round 9**

Five decisions in this design turn on how the game *feels* rather than on what it measures, and
`development-process.md` §6.9 is the rule that says a bot cannot settle any of them: **a threshold
derived from the instrument's own constants is not evidence about a human.**

They are gathered in one place —
[`generation.md` §7.4.2](generation.md#742-the-tier-5-register--what-only-the-owner-can-settle) —
with a measured price and a recommendation each, so that no tier-1 pass on one of them is read as
settled. In short: **D** how busy the board should be, **L** whether lives should tighten at the
top, **T** two-colour cars, **S** the one car speed, **R** whether the road recedes enough
([`ui.md` §4.6](ui.md#46-the-ink-budget)), and **P** whether the palette is still bleak
([`ui.md` §5](ui.md#5-colour)).

**None is a blocker and the design is buildable on the recommendations.** The one that most deserves
a play session is **D**: round 9 takes the board from 3.7 cars to 4.4 at band 5, and if the owner
still reads that as sparse, the finding is about the *model of the player* rather than about the
table — which is the one exception
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed) allows, and it re-reads every target
rather than the failing one.
