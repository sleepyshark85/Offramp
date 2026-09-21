# Offramp — Acceptance Criteria

Numbered, grouped, one observable behaviour each. The developer builds against these; the tester
writes its own tests from these **before** reading the developer's
(`docs/development-process.md:138`).

Every AC is executable without asking the designer a question. Where an AC cites a number, the
number is in [`gameplay.md`](gameplay.md), [`generation.md`](generation.md) or
[`ui.md`](ui.md) and is normative there.

| Range | Area | Verification tier |
|---|---|---|
| 100–199 | Simulation engine | 1 — `node --test` + invariant fuzzing |
| 200–299 | Track generator | 2 — solver bots over thousands of seeds |
| 300–399 | Input model | 1 for the engine half, 3 for the gesture half |
| 400–499 | Layout | 4 — arithmetic over a continuous viewport sweep |
| 500–599 | Visual system | 3 + 5 |
| 600–699 | Accessibility | 3 + 4 + 5 |
| 700–799 | Progression | 1 + 3 |
| 800–899 | Failure and edge cases | 1 + 3 + 5 |

Numbers are assigned with gaps inside each hundred. New ACs take the next free number in their
group; **a number is never reused for an unrelated subject.** Round 8 re-subjected four criteria
whose original subject ceased to exist — AC-117, AC-132, AC-226–AC-230 and AC-231 — and each says
so in its own note, because the engine, its tests and a dozen commit messages cite these numbers
and a dangling citation is worse than a redirected one.

> **Round 8 re-derived every criterion tied to geometry or to duration.** A level is a fixed two
> minutes, roads are orthogonal, the grid is finer, and row 0 is always a pass. Criteria whose
> **Then** clause carries a number the designer could compute are stated with that number;
> criteria whose number can only come from the developer's sweep are marked *(to be measured)* and
> **must not be quoted as measured until they are**.

---

## 100 — Simulation

**AC-101 · Fixed tick rate**
**Given** the engine constants module,
**When** `TICK_HZ` is read,
**Then** it is the integer `60`, and no other module defines a tick rate.

**AC-102 · One step is one tick**
**Given** a state at tick `T`,
**When** `step(state, [])` is called,
**Then** the returned state's `tick` is exactly `T + 1`. Never `T`, never `T + 2`.

**AC-103 · No floating point in the simulation**
**Given** any state reached after 10,000 ticks of a seeded run,
**When** every numeric field of the state and of every car is inspected,
**Then** each one satisfies `Number.isInteger(v)`.

**AC-104 · A car is always on exactly one edge**
**Given** any state,
**When** the car list is inspected,
**Then** every car has exactly one `edgeId`, that edge exists in `level.edges`, and
`0 <= car.progress < edge.lengthMlu`.

**AC-105 · Constant advance**
**Given** a car not transitioning this tick,
**When** one `step()` runs,
**Then** its `progress` increased by exactly `level.speedMluPerTick`.

**AC-106 · Transition carries the remainder**
**Given** a car whose `progress + speed >= edge.lengthMlu`,
**When** one `step()` runs,
**Then** the car is on an outgoing edge of that edge's `to` node with
`progress === (oldProgress + speed) - oldEdge.lengthMlu`.

**AC-107 · Junction state is read at the transition**
**Given** a car transitioning onto a branch node this tick,
**When** the outgoing edge is selected,
**Then** it is `node.out[state.open[node.junctionId]]` evaluated at that instant, using the value
of `open` after this tick's inputs were applied.

**AC-108 · A flip behind a car does not re-route it**
**Given** a car that transitioned through junction `J` at tick `T`,
**When** `J` is flipped at any tick `> T`,
**Then** that car's `edgeId` is unchanged by the flip and it arrives at the same depot it would
have without the flip.

**AC-109 · Inputs are applied before movement**
**Given** a car that will reach junction `J` during tick `T`,
**When** an input `{tick: T, junctionId: J}` is supplied to `step()`,
**Then** the car takes the branch selected by the **post-flip** value of `open[J]`.

**AC-110 · Two taps in one tick resolve by junction id**
**Given** inputs `[{tick:T, junctionId:5}, {tick:T, junctionId:2}]` supplied in that array order,
**When** `step()` runs,
**Then** junction 2 is toggled before junction 5, and the resulting state is deeply equal to the
state produced when the same two inputs are supplied in the opposite array order.

**AC-111 · Duplicate taps on one junction net out**
**Given** inputs `[{tick:T, junctionId:3}, {tick:T, junctionId:3}]`,
**When** `step()` runs,
**Then** `open[3]` has its original value, and two `flip` events were emitted.

**AC-112 · Cars spawn on their scheduled tick**
**Given** `level.spawns[i] = {index:i, tick:t, colour:c}`,
**When** the tick whose `state.tick` is `t` has been stepped,
**Then** the returned state contains exactly one car with `id === i` and `colour === c`; it is on
`level.entryEdgeId` with `progress === level.speedMluPerTick`; no car with `id === i` existed in
the state returned by the previous tick; and the returned `events` contain exactly one
`{type:'spawn', tick:t, carId:i, colour:c}`.
*`progress === 0` is not observable by any caller: spawn is step 3 of
[`gameplay.md` §2.5](gameplay.md#25-stepstate-inputs--exactly-one-tick) and the advance is step 4,
so the car has always moved once by the time `step()` returns. `speedMluPerTick` is the right value
because the entry edge is `ENTRY_LEN = 220,000` MLU, sixty times one tick of travel at any band, so
the spawning car cannot transition on its spawn tick.*

**AC-113 · The spawn schedule is a pure function of the seed**
**Given** the same `(seed, band)`,
**When** the level is generated twice in separate processes,
**Then** the two `level.spawns` arrays are deeply equal.

**AC-114 · Spawn ticks strictly increase**
**Given** any generated level at any band,
**When** `level.spawns` is inspected,
**Then** `spawns[i+1].tick > spawns[i].tick` for every `i`, and the minimum gap over 1,000 seeds
per band is at least `interval - 2*jitter` ticks.

**AC-115 · Colour bag prevents runs of three, and balances within a level**
**Given** the spawn colour sequence of **one** generated level, at any band and any seed,
**When** it is scanned,
**Then** (a) no three consecutive entries share a colour, and (b) across that one level's
`SPAWN_COUNT` entries the most-used colour's count exceeds the least-used colour's count by **at
most 1** — spread `0` when `K` divides `SPAWN_COUNT` and exactly `1` otherwise. The tolerance is 1,
not `K`, and it is exact rather than statistical: the bag deals `floor(SPAWN_COUNT / K)` complete
bags in which every colour appears equally often, and the `SPAWN_COUNT mod K` leftover entries come
from one shuffled bag and are therefore distinct colours.
*The aggregate-over-seeds reading of this clause is **withdrawn**. Slice 1 measured the aggregate
spread over 1,000 seeds at 34 (band 2) and 43 (band 5) — both bands where `K` does not divide
`SPAWN_COUNT`, so the leftover is a fresh uniform draw and the spread is ordinary multinomial noise
with σ ≈ 15. There is no bias to remove and no tolerance below which that reading would be a check
rather than a coin toss. The per-level reading above is a theorem about the bag, so it holds at
every seed and fails the moment the bag is replaced by independent draws.*

**AC-116 · Correct delivery counts**
**Given** a car entering a depot whose `depotColour` equals the car's colour,
**When** the arrival resolves,
**Then** `delivered` increases by 1, `streak` increases by 1, `bestStreak` is `max` of itself and
`streak`, the car is removed, `lives` is unchanged, and a `delivered` event carrying `edgeId` is
emitted. `delivered` **is the score**
([`gameplay.md` §4.3](gameplay.md#43-the-score-is-the-number-of-cars-delivered)).

**AC-117 · Streak is a statistic and multiplies nothing**
**Given** the engine constants module and any seeded run,
**Then** `SCORE_DELIVERY`, `SCORE_STREAK_STEP`, `STREAK_CAP` and `SCORE_LIFE_BONUS` **do not
exist** anywhere in `src/`; `state` carries no `score` field; `streak` increments on every delivery
with no cap and resets to 0 on every misroute; `bestStreak` is its running maximum; and neither
value is read by any expression that affects `delivered`, `lives` or `phase`.
*Re-subjected in round 8. This number used to assert the streak bonus `100 + 10 * min(n - 1, 9)`.
Under a fixed clock the score is the number of cars delivered and there is no points total
([`gameplay.md` §4.3](gameplay.md#43-the-score-is-the-number-of-cars-delivered)), so the criterion
now asserts the deletion instead of the formula — which is the check that actually catches a build
that kept the old code path alive behind an unused field.*

**AC-118 · The transition loop is single-pass**
**Given** any seeded run of a full level at any band,
**When** the transition `while` loop is instrumented,
**Then** its body executes at most once per car per tick.
*The bound is `min(rowH) = 180` LU against `max(speedMluPerTick) = 3350`, so a car covers under a
fiftieth of the shortest edge in a tick. The entry edge is no longer the shortest edge
([`gameplay.md` §2.5](gameplay.md#25-stepstate-inputs--exactly-one-tick)).*

**AC-119 · Misroute costs a life and no points**
**Given** a car entering a depot whose colour differs from the car's,
**When** the arrival resolves,
**Then** `lives` becomes `max(0, lives - 1)`, `misrouted` increases by 1 unconditionally, `streak`
becomes 0, `delivered` is unchanged, and a `misrouted` event carrying both colours and `edgeId` is
emitted.
*The decrement is clamped, not conditional: the arrival always resolves and is always counted,
and only the displayed life total is floored. See AC-121, AC-122, AC-136 and AC-801, which
together were unsatisfiable under their slice-0 wording, and*
[`gameplay.md` §2.6](gameplay.md#26-resolvearrival--the-single-place-scoring-happens) *for the
resolution.*

**AC-120 · The score is non-decreasing**
**Given** a seeded fuzz run of a full level with randomised taps,
**When** `delivered` is sampled after every `step()`,
**Then** it is a non-negative integer that never decreases, and it increases only on a tick that
also emitted a `delivered` event.

**AC-121 · Lives are non-increasing and floored**
**Given** the same fuzz run,
**Then** `lives` never increases and never goes below 0 — including on a tick in which more
misroutes resolve than there are lives remaining (AC-136). The floor is a property of the
decrement in AC-119, not a separate clamp applied afterwards, so there is exactly one place in the
engine where `lives` is written.

**AC-122 · Terminal conditions, and their order**
**Given** the tick `LEVEL_TICKS - 1` in which a car is delivered **and** another car is misrouted
taking `lives` to 0,
**When** the terminal check runs,
**Then** `phase === 'lost'`, not `'ended'`. Both arrivals resolved first: `delivered`, `misrouted`
and `lives` all reflect both cars, because step 4 of
[`gameplay.md` §2.5](gameplay.md#25-stepstate-inputs--exactly-one-tick) resolves every arrival in
the tick and step 5 runs the terminal check exactly once, afterwards — and step 5 checks `lives`
**before** the clock.
*The order is reversed from slice 0's, which resolved the tie as a win because the player had
completed the quota. There is no quota to have completed: every run reaches the clock, so resolving
the tie in the player's favour would make the last tick of the level the one tick on which a
misroute is free ([`gameplay.md` §2.5](gameplay.md#25-stepstate-inputs--exactly-one-tick)).*

**AC-123 · The spawn schedule is exactly consumed**
**Given** any seeded run at any band that reaches `phase === 'ended'`,
**When** the final state is inspected,
**Then** `state.nextSpawn === level.spawns.length` — every scheduled car entered — and at every
earlier tick `state.nextSpawn <= level.spawns.length`.
*This replaces a criterion that asserted a reserve entry was never reached. Under a clock the
schedule contains exactly the cars that fit in two minutes and nothing more
([`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)), so
`SPAWN_EXHAUSTED`, `SPAWN_SLACK`, `inFlightMax` and `transitMax` are all deleted. The failure this
catches instead is a schedule that stops short of the clock or an engine that stops consuming it
early — neither of which the old criterion could see, because both leave `nextSpawn` comfortably
below `spawns.length`.*

**AC-124 · Minimum car separation**
**Given** any seeded run at any band,
**When** every pair of cars sharing an edge is measured after every `step()`,
**Then** their separation in LU is at least `(interval - 2*jitter) * speedMluPerTick / 1000`,
which is `418 / 331 / 317 / 320 / 322` LU by band and never less than **317 LU** — three times
`CAR_L = 104`.
*This covers two cars that took the **same path**. It does not cover two cars on the shared depot
approach, which took different paths of different lengths; that is AC-513 and it is a drawing
problem, not a rule ([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)).*

**AC-125 · Replay determinism**
**Given** a recorded run `{seed, band, inputs}`,
**When** it is replayed twice in one process and once in a fresh process,
**Then** all three final states are deeply equal, including `score`, `rng`, `tick` and every car.

**AC-126 · Events do not accumulate**
**Given** any state,
**When** `step()` is called,
**Then** `state.events` contains only events generated during that tick.

**AC-127 · Frame catch-up is capped**
**Given** a frame delta of 2,000 ms,
**When** the React layer converts it to ticks,
**Then** `step()` is called at most `MAX_CATCHUP_TICKS = 8` times and the accumulator is reset to
0 rather than carrying the remainder.

**AC-128 · A paused game does not advance, and the clock does not run down**
**Given** a paused game,
**When** 5 seconds of wall time pass,
**Then** `state.tick` is unchanged, and the HUD's clock bar and caption show the same values they
showed at the moment of pausing ([AC-520](acceptance-criteria.md)).
*Under a fixed clock this is the criterion that says pausing is free. The level's length is
`state.tick`, which only advances inside `step()`, so there is no wall-clock deadline to run down —
a property of [`gameplay.md` §2.1](gameplay.md#21-tick-rate-and-the-level-clock)'s decision to make
the level length a tick count, and the main reason that decision is worth its paragraph.*

**AC-129 · `step` is pure**
**Given** the source of `src/engine/`,
**When** it is searched,
**Then** there are no occurrences of `Date.now`, `performance.now`, `Math.random`, `setTimeout`,
`setInterval`, or any import from `react` or `react-native`.

**AC-130 · Car ids are unique and ascending**
**Given** any state,
**Then** `cars` is strictly ascending by `id` and no id appears twice.

**AC-131 · No car occupies two edges**
**Given** the fuzz run of AC-120,
**Then** no car object ever holds more than one `edgeId`, and the total car count equals
(spawned − delivered − misrouted) after every `step()`.

**AC-132 · Clearing a level is surviving it**
**Given** any completed run,
**Then** `phase === 'ended'` if and only if the run reached tick `LEVEL_TICKS` with `lives >= 1`,
and `phase === 'lost'` if and only if `lives` reached 0; there is no third terminal phase and no
`'won'`; and the unlock of the next level is a function of `phase === 'ended'` and of nothing else
— not of `delivered`, `streak` or `misrouted`
([`gameplay.md` §7](gameplay.md#7-progression-slice-4-territory-specified-here-so-it-is-not-invented-later)).
*Re-subjected in round 8. This number used to assert a `50 × lives` clear bonus, which does not
exist under a clock (AC-117). What it now asserts is the thing that replaced it: a delivery target
would be a quota by another name, and the owner removed the quota.*

**AC-133 · Cars in flight are discarded at level end**
**Given** a level that ends with cars still on the network — which is **every** level, since the
clock does not wait for the board to drain —
**Then** those cars score nothing, cost nothing, and remain in `state.cars` for the renderer to
freeze; and over 1,000 seeds per band the count of such cars is between 2 and 5, matching
`transit / interval` from [`generation.md` §6.1](generation.md#61-the-table) to within one car.

**AC-134 · PRNG streams are independent**
**Given** a level,
**When** the number of generator draws is artificially changed without changing the seed,
**Then** `level.spawns` is unchanged.

**AC-135 · The engine runs in bare Node**
**Given** `src/engine/`,
**When** it is imported and driven by `node --test` with no bundler and no React,
**Then** it runs to completion.

**AC-136 · Two misroutes on one tick with one life**
**Given** `lives === 1` and two cars whose `progress` reaches the end of their edges into
wrong-coloured depots on the same tick,
**When** that tick is stepped,
**Then** both arrivals resolve in ascending car id order, `misrouted` increases by **2**, exactly
two `misrouted` events are emitted, `lives === 0` and not `-1`, `delivered` is unchanged, and
`phase === 'lost'` after the terminal check of that tick.

**AC-137 · The terminal check runs once, after every arrival**
**Given** a seeded fuzz run of a full level with randomised taps,
**When** `phase` is sampled inside step 4 of every tick,
**Then** it is `'running'` throughout step 4 on every tick, and changes only at step 5 — no
arrival is ever skipped because an earlier arrival in the same tick ended the level.

**AC-138 · Every junction starts on branch 0**
**Given** a freshly created state for any generated level at any band,
**When** `state.open` is read before any `step()`,
**Then** every entry is `0`, so every junction points at `node.out[0]` — the lower-column branch
([`gameplay.md` §2.3](gameplay.md#23-the-graph)) — and `state.open.length === level.junctions.length`.
*This is a design decision, not an allocation default: see
[`gameplay.md` §4.8](gameplay.md#48-how-a-level-opens). A build that seeded `open` from the level
seed would pass every other AC in this document and would change how every level opens.*

**AC-139 · The spawn schedule matches its closed form**
**Given** any generated level at any band,
**When** `level.spawns` is inspected,
**Then** every entry's `tick` is `< LEVEL_TICKS = 7200`; the entries are strictly increasing in
`tick`; `spawns[i].index === i`; `spawns.length` is at most
`floor((LEVEL_TICKS - 1 - SPAWN_LEAD + JITTER) / INTERVAL) + 1` — **35 / 48 / 51 / 54 / 56** by
band — and at least that value minus 1; and no `i` was skipped for which
`SPAWN_LEAD + i*INTERVAL - JITTER < LEVEL_TICKS`.
*Slice 1 measured a spawn margin of `3 / 2 / 2 / 2 / 1` under a flat `SPAWN_SLACK = 8`, with band 5
seed 160 consuming 71 of 72 spawns — one spawn interval from an uncaught throw in the middle of the
hardest band — and round 6's derived slack restored it to 3 everywhere. **Round 8 deleted the
quantity.** Under a clock the schedule is the exact list of cars that fit in two minutes, so what
used to need a 2,000-seed oracle sweep in two variants is now an identity any single generated
level checks. This AC is the identity; `tools/spawn-margin.mjs` is replaced by
`tools/spawn-schedule.mjs`
([`generation.md` §8](generation.md#8-harnesses-this-design-assumes-exist)).*

**AC-140 · An arrival event names the edge the car came down**
**Given** a `delivered` or `misrouted` event emitted by `resolveArrival`,
**Then** it carries `edgeId`, the id of the terminal edge the car was on when it reached the
depot; `level.edges[edgeId].to === depotId`; and in a seeded run of 1,000 levels per band every
such event's `edgeId` equals the `edgeId` that car held in `state.cars` at the end of the previous
tick.
*A depot has an in-degree of up to 3 and 100 % of levels have a shared depot
([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)), so
`depotId` does not identify the road. AC-515 needs it: the shatter is thrown from the terrace line of the
arriving edge. Slice 2 recovered it in the renderer from a previous-tick snapshot — sound, because
one tick moves at most 3.8 LU against a ≥ 200 LU terminal edge, but it is a second derivation of a
fact §2.5's transition loop holds in a local variable at the moment it calls `resolveArrival`. The
field is render-only: no counter, score, phase or invariant may read it
([`gameplay.md` §2.6](gameplay.md#26-resolvearrival--the-single-place-scoring-happens), §2.9). The
third clause is the check that the engine's value and the renderer's old inference agree, and it
is what makes the workaround safe to delete rather than merely unnecessary.*

**AC-141 · The level is exactly two minutes of ticks**
**Given** any seeded run at any band in which no life is lost,
**When** it is driven to `phase !== 'running'`,
**Then** the run contains exactly **7,200** `step()` calls, the last tick simulated is **7,199**,
`state.tick === 7200` in the final state, and `phase === 'ended'`;
**And given** the same run replayed at a deliberately degraded frame rate that triggers
`MAX_CATCHUP_TICKS` clamping,
**Then** the final state is deeply equal to the live run's — the level is the same length in ticks
however long it took in seconds.
*This is the criterion the fixed clock rests on and it is new in round 8. `LEVEL_TICKS` is an
integer compared against `state.tick`, never a wall-clock deadline
([`gameplay.md` §2.1](gameplay.md#21-tick-rate-and-the-level-clock)); a wall-clock timer would make
a dropped frame shorten the level, and would make a replay a different length from the run it
replays. The off-by-one is the part to check hardest: step 5 tests `tick + 1 >= LEVEL_TICKS` and
step 6 increments, so a level that runs 7,201 or 7,199 ticks passes every other AC in this
document.*

---

## 200 — Generation

**AC-201 · Generation is a pure function of `(seed, band)`**
**Given** the same seed and band,
**When** `generate()` is called in two separate processes,
**Then** the two level objects are deeply equal.

**AC-202 · Band parameters are applied**
**Given** a generated level for band `b`,
**Then** its `C`, `K`, `R`, `colW`, `rowH`, `speedMluPerTick`, `interval` and `jitter` exactly
match row `b` of [`generation.md` §6.1](generation.md#61-the-table), and the level object carries
**no** `quota` and **no** `diagLen` field.

**AC-203 · Generation never exhausts**
**Given** `tools/generator-audit.mjs --seeds 5000` across all five bands,
**Then** zero `GEN_EXHAUSTED` errors are thrown, and the reported attempt count has median ≤ 8 and
maximum ≤ 128.
*Measured in the designer's prototype at 3,000 seeds per band: median `1 / 2 / 1 / 2 / 1`, p95
`5 / 8 / 3 / 6 / 4`, max 20. The `max` column is a sample maximum and grows with the seed count, so
it is always quoted with the seed count that produced it
([`generation.md` §6.2](generation.md#62-measured-generator-behaviour)).*

**AC-204 · V1 — no dead ends**
**Given** any generated level,
**Then** every non-depot node has out-degree 1 or 2, every depot has out-degree 0 and in-degree
≥ 1, and every node reaches at least one depot.

**AC-205 · V2 — merge-free ordering**
**Given** any generated level,
**When** the edge targets of each route row are listed left to right by source column,
**Then** they are strictly increasing; on the terminal row they are non-decreasing.

**AC-206 · No two roads are ever drawn as one**
**Given** any generated level,
**When** every pair of edges within the same row band is tested,
**Then** (a) no pair `(a→b)`, `(a'→b')` exists with `a < a'` and `b > b'`; **and** (b) no two
horizontal runs are collinear and share more than an endpoint; **and** (c) where two horizontal
runs share exactly an endpoint, they either leave the **same** source node or arrive at the **same
depot**; **and** (d) no horizontal run terminates on an occupied lattice site of its own row.
*Clauses (b)–(d) are new and they replace the whole of the old chord argument, which proved
something about crossings and proves nothing about Manhattan routing. Two collinear touching
horizontal runs draw as **one continuous road with a fork in the middle that is not a junction**,
which is a worse legibility failure than a crossing;
[`generation.md` §2.5](generation.md#25-planarity-and-non-coincidence-why-no-two-roads-are-ever-mistaken-for-one)
proves all four clauses by construction from V2 and V15. The fault to inject is a generator with
V15 removed — a pass node allowed to change column — which must fail (b), (c) and (d).*

**AC-207 · Edge lengths are Manhattan distances**
**Given** any generated level at any band,
**When** every edge is inspected,
**Then** `edge.lengthMlu === (|x_to - x_from| + |y_to - y_from|) * 1000` exactly, for every edge
including the entry edge; so a `straight` is `rowH`, a `jogL`/`jogR` is `rowH + colW` and the entry
edge is `ENTRY_LEN = 220`;
**And** `src/engine/` contains no `Math.hypot`, `Math.cbrt`, `Math.sqrt`, `Math.sin`, `Math.cos`
or `**` operator, and no `diagLen` constant or table.
*This replaces a criterion that re-derived a per-band arc-length literal with a 128-step chord sum,
which existed because `Math.hypot` is not required to be bit-identical across JavaScript engines
and a runtime arc length was therefore a determinism hazard. Orthogonal roads remove the hazard:
two subtractions and an addition are the same integer everywhere
([`gameplay.md` §2.2](gameplay.md#22-position-fixed-point-integers-along-an-edge)). The second
clause is the one that keeps it true — it is a source check, and it is the cheapest way to catch a
future edge shape that reintroduces a curve.*

**AC-208 · V4 — lattice invariant**
**Given** any generated level,
**Then** every edge has `to.row === from.row + 1` and `|to.col - from.col| <= 1`.

**AC-209 · V5 — every depot is reachable from the entry**
**Given** any generated level,
**When** a forward search from the entry node is run,
**Then** all `K` depot nodes are reached.

**AC-210 · V6 — every junction is decisive**
**Given** any branch node,
**When** the reachable depot-colour set of each of its two branches is computed,
**Then** the two sets differ. *Differing is a weaker property than mattering — where one set
strictly contains the other, optimal play never has to leave the default. AC-242 and AC-243 are
what hold the band table's difficulty claim; this AC only forbids the outright no-op junction.*

**AC-211 · V7 — junction count in band range**
**Given** 1,000 generated levels per band,
**Then** every level's junction count lies in its band's `J` range — `3–4 / 3–5 / 4–6 / 5–7 / 7–9`
— and the observed distribution matches
[`generation.md` §6.2](generation.md#62-measured-generator-behaviour) within 5 percentage points
per bucket. *(The §6.2 distribution is from the designer's prototype; where the developer's
generator disagrees, the audit is right and §6.2 is corrected.)*

**AC-212 · V8 — depth in band range**
**Given** any generated level,
**When** the junction count on every entry-to-depot path is computed,
**Then** each lies within the band's `[Dmin, Dmax]`.

**AC-213 · V12 — consecutive levels differ**
**Given** any two consecutive level indices in the same band,
**Then** their network signatures (sorted edge list + entry column + depot-colour assignment)
differ.

**AC-214 · V9 — one node per lattice site**
**Given** any generated level,
**Then** no two nodes share `(row, col)`, and no row holds more than `C` nodes.

**AC-215 · V10 — palette assignment**
**Given** a level at a band with `K` colours,
**Then** its depot colours are exactly the first `K` entries of the palette in
[`ui.md` §5.1](ui.md#51-the-car-palette), each used once.

**AC-216 · V11 — junction separation**
**Given** any generated level,
**When** the distance between every pair of junction centres is computed,
**Then** the minimum is at least 150 LU, which is `min(colW, rowH)` at band 5 and is the binding
case for [AC-401](acceptance-criteria.md)'s 44 pt floor.

**AC-217 · Merge-free**
**Given** any generated level,
**Then** no node with `kind !== 'depot'` has in-degree greater than 1.

**AC-218 · Integer geometry**
**Given** any generated level,
**Then** every node's `x` and `y`, every edge's `lengthMlu`, and the level's `colW` and `rowH` all
satisfy `Number.isInteger`; **and given** a band-table row whose `R` is not a divisor of
`ROUTE_H = 1080`, or whose `colW × (C - 1)` is odd, **then** level construction **throws** rather
than returning a level.
*`colW` is a band-table value in round 8 rather than `LANE_SPAN / (C - 1)`
([`generation.md` §3.2](generation.md#32-site-coordinates)), which removes one of the two divisions
this guard existed for. `rowH = ROUTE_H / R` is the one that remains, and `ROUTE_H = 1080` is
divisible by both `R` values the table uses.* *The throw is the point. Slice 1 injected `R = 7` and got a level back: 18 nodes
with fractional `y`, 17 edges with fractional `lengthMlu`, and by tick 683 a car holding
`progress = 1371.4285714285797` — a float inside the simulation, which is the one thing the
fixed-point rule of [`gameplay.md` §2.2](gameplay.md#22-position-fixed-point-integers-along-an-edge)
exists to prevent, arriving silently through a band-table edit rather than through a code change.*

**AC-219 · Serialisation round-trip**
**Given** any generated level,
**When** it is `JSON.stringify`'d and parsed back,
**Then** the result is deeply equal to the original.

**AC-220 · The unconstrained bot delivers every car that arrives**
**Given** `tools/bot.mjs --unconstrained --seeds 1000` per band,
**Then** every run reaches `phase === 'ended'`, the misroute count is **0**, and `delivered` equals
the number of cars that reached a depot before the clock — which matches
[`generation.md` §6.1](generation.md#61-the-table)'s `N` of **32 / 44 / 47 / 50 / 52** to within
one car.
*Stated per car rather than per level because under a clock every level "completes": an
unconstrained bot cannot fail to reach the bell, so "clears 100 %" would be vacuous. What is not
vacuous is that it never misroutes, which follows from V1/V5/V6 plus the 1.60 s minimum flip window
([`gameplay.md` §4.7](gameplay.md#47-every-level-is-solvable-provably)), and that `N` is what the
design says it is.*

**AC-221 · Constrained bot clear rate — band 1**
**Given** `tools/bot.mjs --seeds 1000 --band 1` with the attention model of
[`generation.md` §7.1](generation.md#71-the-constrained-solver-bot),
**Then** the clear rate is **≥ 95 %**. There is no upper bound at band 1
([`generation.md` §7.2](generation.md#72-target-1--the-clear-rate) R1).

**AC-222 · Constrained bot clear rate — band 2**
**Then** the clear rate is within **86 – 97 %**.

**AC-223 · Constrained bot clear rate — band 3**
**Then** the clear rate is within **76 – 92 %**.

**AC-224 · Constrained bot clear rate — band 4**
**Then** the clear rate is within **66 – 85 %**.

**AC-225 · Constrained bot clear rate — band 5**
**Then** the clear rate is within **55 – 78 %**.

*A level is **cleared by surviving its two minutes** — `phase === 'ended'`
([`gameplay.md` §4.2](gameplay.md#42-the-clock-and-what-ends-a-level)) — so the clear rate is the
share of runs that reach the bell with a life left.*

*AC-221 – AC-225's five windows have not moved since they were derived from R1–R4, and **round 8
did not move them either**, because R1–R4 are statements about what a difficulty ladder is for and
the change from a quota to a clock does not touch any of them. What did move is the per-car error
`p` each window corresponds to, which
[`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)
re-derives against `N` instead of `quota`: `0.00–2.60 / 1.53–2.95 / 2.15–3.61 / 2.68–4.12 /
3.11–4.74 %`.*

*Round 6 measured `99.9 / 91.5 / 81.5 / 74.1 / 66.0 %` against these windows and **none of that
reading transfers** — it was taken against a quota ladder that no longer exists, a geometry whose
every dimension has changed, a network model whose pass nodes could drift sideways, and a
first-decision window the owner has since rejected. The round-8 reading is* **(to be measured)**
*and must not be assumed to resemble it.*

**AC-226 · Delivery band — band 1**
**Given** `tools/bot.mjs --seeds 1000 --band 1`,
**Then** the median `delivered` over all runs is reported, and it lies within **28 – 32**.

**AC-227 · Delivery band — band 2**
**Then** median `delivered` within **38 – 44**.

**AC-228 · Delivery band — band 3**
**Then** median `delivered` within **40 – 47**.

**AC-229 · Delivery band — band 4**
**Then** median `delivered` within **42 – 50**.

**AC-230 · Delivery band — band 5**
**Then** median `delivered` within **43 – 52**.

*AC-226 – AC-230 are **re-subjected**. They used to be the completion-time band — median and p95
duration per band — and that quantity no longer varies: every level is exactly 7,200 ticks
([`gameplay.md` §5.3](gameplay.md#53-session-length)). What replaces it is the quantity that does
vary and that the player reads as their result. The upper edge of each band is
[`generation.md` §6.1](generation.md#61-the-table)'s `N`, which a run with no misroutes delivers
exactly; the lower edge is roughly `N - 4`, which is what two misroutes plus the cars lost to the
bell cost. **These are reports with a sanity range, not constraints on the design** — unlike the
duration band, which was a constraint a lever pull could break
([`generation.md` §7.3](generation.md#73-target-2--the-delivery-band)). The p10 of the same
distribution is also reported, because `delivered` should be strongly bimodal — a run either
reaches the bell or stops at its third misroute — and a p10 close to the median means the lives are
not doing their job.*

**AC-231 · Every level is the same two minutes**
**Given** every constrained-bot run across all bands and all sampled seeds,
**Then** **every** run that reaches `phase === 'ended'` has `state.tick === 7200` exactly, every
run that reaches `phase === 'lost'` has `state.tick < 7200`, and **no** run of either kind exceeds
7,200 ticks.
*Re-subjected. This number used to be the 130 s absolute ceiling — "the two-minute promise made
measurable, with 10 s of headroom for the two misroutes a winning run may contain". The promise is
no longer a ceiling to be measured against; it is a constant the engine enforces, and what is worth
checking is that it is enforced **identically at every band**, since `LEVEL_TICKS` is the one
parameter the band table does not carry. See AC-141 for the per-run form.*

**AC-232 · Bot motor constraints are enforced**
**Given** the constrained bot's own input log and the per-tap record of which car the tap was made
for,
**Then** no two taps occur within `BOT_MIN_TAP_GAP = 11` ticks, no tap occurs within
`BOT_LOCKOUT_TICKS = 6` ticks of **the car it was made for** reaching the tapped junction, and no
tick contains more than one tap. *The lockout is scoped to the focused car; slice 0 phrased it over
any car, which is a different constraint and not one the bot can evaluate without global
knowledge.*

**AC-233 · Tap rate is measured and reported**
**Given** `tools/bot.mjs --seeds 1000` per band,
**Then** it reports mean taps per second per band, and the reported value is ≤ **1.25 /s** at
**every** band.
*The ceiling applies at every band now rather than only at band 5, because the rate is sustained
for exactly 120 s at every band and band 1 is no longer the short one
([`gameplay.md` §8.6](gameplay.md#86-tap-load--closed-by-measurement-and-re-opened-by-the-clock)).
[`generation.md` §6.3](generation.md#63-tap-load) estimates demand at
`0.32 / 0.50 / 0.57 / 0.70 / 0.79 /s`; the measured value is* **(to be measured)** *and the
estimate must never be used to corroborate it — slice 1 found a broken bot policy matching the
estimate exactly while clearing 0.7 % of band 5.*

**AC-234 · Network variety**
**Given** 3,000 generated levels per band,
**When** distinct **network signatures** — the sorted edge list plus the entry column plus the
depot-colour assignment — are counted, and distinct **edge topologies** are counted separately,
**Then** the signature count is at least **160 / 250 / 360 / 490 / 1000** for bands 1–5, and both
counts are reported.
*The floors are derived, not chosen. A band of `L` levels drawing from `T` distinct signatures
repeats with probability about `L²/2T`, and `T >= 10 L²` puts that under 5 %; the bands are 4, 5, 6
and 7 levels long, and band 5 is open-ended so it is held to a 10-level stretch, which is `10 × 10² = 1000`. The signature is
the right object because a player distinguishes a shape **with its depot colours on it**; the edge
topology is reported alongside because it is what a generator change moves.*

*The designer's prototype measures `279 / 851 / 1380 / 2216 / 2745` signatures and
`63 / 251 / 312 / 744 / 794` edge topologies, clearing the floors by 74 % / 240 % / 283 % / 352 % /
175 %.*

***This criterion is what set band 1's row count, and that is the thing to know before changing
it.*** *At `C = 3, R = 4` — band 1's obvious geometry — it measures **155 against a floor of 160
and fails**. Band 1's fifth row exists for this criterion and for nothing else: its depth range is
2–3 either way. The alternative priced was `C = 4, K = 3` (89 topologies, 400 signatures at
`R = 4`), declined because it makes bands 1 and 2 differ only in `interval`
([`generation.md` §6.2](generation.md#62-measured-generator-behaviour)). **A generator change that
takes band 1 below 160 has not made the game worse in any way a clear rate can see**, which is why
this is a criterion and not a note.*

**AC-235 · The bot's attention bounds are enforced**
**Given** `tools/bot.mjs --seeds 1000` per band with its bot state instrumented after every tick,
**Then** `mem.length <= BOT_WORKING_SET = 3` on every tick of every run; no entry survives more
than `BOT_MEMORY_TICKS = 120` ticks past its `seenTick`; the bot never emits a tap on a tick where
`focus === null`; and every tap is for the car that was focused when the tap was emitted.

**AC-236 · The bot is deterministic and seeded**
**Given** the same `(seed, band)`,
**When** `tools/bot.mjs` is run twice in one process and once in a fresh process,
**Then** the three input streams are element-for-element identical, and the bot's PRNG has been
drawn from exactly once per glance and never anywhere else — asserted by counting draws against
the glance count.

**AC-237 · R2 — every band is measurably harder than the one below it**
**Given** the five clear rates of AC-221 – AC-225 over 1,000 seeds per band,
**Then** each band's clear rate is at least **4 percentage points** below the band above it. *A
run in which every band sits inside its own window but two adjacent bands measure within 4 points
of each other is a failure: the ladder is not escalating.*

**AC-238 · R3 — no band boundary is a wall**
**Given** the same five clear rates,
**Then** no adjacent pair differs by more than **15 percentage points**.

*AC-237 and AC-238 together are what makes the ladder a ladder, and together with AC-221–AC-225
they take about half the room the design has.
[`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)
searches every monotone per-car-error ladder the five windows admit and finds a best smallest
margin of **2.79 pp**, of which R2 at the 1 → 2 pair is the tightest constraint. Solved against the
clear-rate windows and R2/R3 alone, ignoring per-car error entirely, the ceiling is **5.00 pp** —
so the monotone-`p` requirement costs 2.21 pp and **neither half is dominant**. The same search
against round 6's quota ladder gives 2.76 pp, so **the fixed clock did not loosen this**: it widened
the span the ladder may sit in by 16 % and left the margin where it was. The four measured drops
are* **(to be measured)**.*

**AC-239 · The attention report is emitted**
**Given** `tools/bot.mjs --attention-report --seeds 1000` per band,
**Then** it reports, per band: glances/s, focus events/s, the split between `BOT_SWITCH_TICKS` and
`BOT_ACQUIRE_TICKS` focuses, mean working-set occupancy, evictions/s, memory expiries/s, and the
count of misroutes caused by a flip the bot made for a held car that misrouted a car it was **not**
holding. *Without these a missed target in AC-221 – AC-225 cannot be explained, only observed.*

**AC-240 · The instrument is proven to be sensitive**
**Given** the bot run at band 5 over 1,000 seeds with `BOT_WORKING_SET` raised to `Infinity`,
`BOT_ACQUIRE_TICKS` and `BOT_SWITCH_TICKS` set to 0 and `BOT_MEMORY_TICKS` set to `Infinity` —
every attention constraint removed, every timing constraint kept —
**Then** the clear rate rises by at least **20 percentage points** over the unmodified bot.
*This is the fault injection required by `docs/development-process.md:136`. It proves the
attention model is what binds the measurement rather than something else wearing its name; a bot
whose clear rate barely moves when attention is made free is not measuring attention.*

*The rise is asserted wherever there is room for it to be asserted. A 20 pp rise needs 20 pp of
headroom, so the test is meaningless wherever the unmodified bot already clears above 80 %, and
such a band is a ceiling, not insensitivity. A band whose unmodified rate is above 80 % is reported
as `n/a (no headroom)` and is not a failure; any band at or below 80 % that fails to rise 20 pp
**is**. Round 6 measured `+0.1 / +7.9 / +17.9 / +25.0 / +31.7 pp` against clear rates of
`99.9 / 91.5 / 81.5 / 74.1 / 66.0 %`, asserting at bands 4 and 5 and passing at both.*

***Round 8 requires this to be re-run and reported per band, and a failure at bands 1–3 for want of
headroom is not a reason to re-open V14.*** *Round 4 measured "forbid a branch at row 0" and
rejected it partly because it over-corrected: with it in force the bot cleared
`100 / 100 / 99.9 / 96.9 / 25.0 %` and this AC lost its headroom at four bands. That measurement
was taken against a quota ladder that no longer exists, and under a clock the same removal of load
is absorbed by `N` being 32–52 rather than a quota of 16–51. The rule is now V14 and it is settled
by tier-5 feedback ([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision));
if this AC cannot assert at a band, the repair is
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed)'s lever order, not the rule. The
failure this AC is for looks like slice 1b's: bands 4 and 5 rising `+2.0` and `+7.4 pp` from 19.7 %
and 2.3 %, with plenty of headroom and nothing moving — which correctly located a deadline in the
**game** that no player model could meet, not a fault in the bot.*

**AC-241 · A lever pull recomputes the window it is aimed at**
**Given** any proposed change to a band's `interval`, `pBranch`, `R`, `C` or `K` under
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed),
**When** the change is applied,
**Then** `N` is recomputed from the new parameters; **AC-246's ceiling `0.25 × 2/N` is recomputed
with it**;
[`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)'s
per-car window for that band is recomputed; and AC-221 – AC-225, AC-237, AC-238, AC-245, AC-246
and AC-139 are **all** re-run and all pass, with the measured `p` read against the **new** window
and not the old one.
*Under a quota, `interval` and `quota` were independent and
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed)'s lever 0 moved them against each
other at constant duration; the second constraint a lever pull had to satisfy was the
completion-time band, and slice 1's worked example was a pull that fixed the clear rate and broke
it. **Lever 0 no longer exists and neither does the duration constraint**: `N = 120 s / interval`,
so one knob moves the ball and the goalposts together. This AC is what replaces the missing second
constraint, and the clause that matters is the last one — reading a measured `p` against a window
computed from the pre-pull `N` is the single most likely way to get this model wrong.*

**AC-242 · V13 — the actionable junction floor**
**Given** any generated level at band `b`,
**When** every branch node's two reachable-colour sets are compared,
**Then** the number of branch nodes whose two sets are **incomparable** — neither contains the
other — is at least the band's `Ja` in [`generation.md` §6.1](generation.md#61-the-table):
**3 / 3 / 4 / 5 / 7** for bands 1–5. A junction whose sets are comparable is *decorative*: the
superset branch serves every colour the subset branch does, so a perfect player never has to flip
it. *The rule constrains the generator rather than describing it. Measured in the designer's round-8
prototype, `Ja` sits at exactly its floor in 100 % of levels at bands 1, 2, 4 and 5 and at 4 or 5 at
band 3, and V13 costs a median of 0 extra attempts. The decorative-junction share is*
**(to be measured)**.

*Every comparable pair comes from a shared depot
([`generation.md` §5.1](generation.md#51-why-v6-was-not-simply-strengthened)), so a level whose
depots are all in-degree 1 has `Ja = J` automatically — but no such level exists, because
forbidding shared depots pins `J` at `K - 1`
([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)).*

**AC-243 · Actionable `J` is measured per run, not assumed from the table**
**Given** `tools/generator-audit.mjs --actionable --seeds 3000` per band, which drives each level
with the lazy-optimal oracle of
[`generation.md` §6.2](generation.md#62-measured-generator-behaviour) and records the set of
junctions that oracle flips at least once,
**Then** it reports, per band: the mean and minimum live-junction count, the share of levels whose
live count is below `Ja`, and the mean count of junctions flipped **twice or more**; and the
measured values satisfy — live count `>= Ja - 1` in **100 %** of runs, and `>= Ja` in at least
**95 %**. *(to be measured against the round-8 table.)*
*Round 6 measured mean live `2.98 / 3.48 / 4.81 / 5.54 / 7.07`, minimum `2 / 2 / 4 / 4 / 6`,
below-`Ja` share `1.6 / 0.2 / 0.0 / 0.0 / 0.2 %`. The residue is a spawn-order effect, not a
topology one, and no static rule removes it: a junction can be structurally actionable and still
not be exercised by one particular colour sequence. This AC exists so that residue stays visible
and bounded instead of being invisible. **Under a clock the oracle drives a fixed 7,200 ticks
rather than to a quota**, so it sees 32–52 cars rather than 16–51 and the residue should fall
slightly at bands 1 and 2; if it rises, that is a finding.*

**AC-244 · Every validity rule is proven able to fire**
**Given** the eleven checks `V1`–`V11` plus `V13`, `V14` and `V15`,
**When** the audit's rule-injection suite runs,
**Then** for **each** rule there is a fixture that the rule's own check rejects, and the check is
invoked **directly** rather than through `validate()`'s ordered cascade.
***`V14` and `V15` are new and are in the hardest class of all***: `buildRow` cannot construct a
violation of either — `forcePass` at `r === 0` and `passOptions = [[a]]` are the only places a pass
option comes from
([`generation.md` §4.2](generation.md#42-buildrow--depth-first-with-backtracking)) — so their
checks will **never** be executed against a violation by any amount of seed sweeping. They are the
two rules a future generator change is most likely to break silently: V15 breaks the drawing
([AC-206](acceptance-criteria.md)) and V14 breaks the fairness floor
([AC-245](acceptance-criteria.md)), and **neither failure shows up in a clear rate.**
*Only `V6`, `V7` and `V8` ever reject a candidate that `tryBuild` produced — measured over 15,000 `generate()` calls, with
zero rejections attributed to `V1`, `V2`, `V3`, `V4`, `V5`, `V9`, `V10` or `V11`. Those are
structural tripwires, not filters ([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate)),
and running them through the cascade means an earlier rule catches the fixture first — which is
why slice 1's blind pass could not make `V5` or `V9` fire from any single-edge mutation of 200
band-3 levels. A tripwire whose check has never been executed against a violation is not a check.*

**AC-245 · The first-decision window clears its floor**
**Given** any generated level at any band,
**When**, for every entry-to-depot path, `L1` is taken as the path length in LU from the entry node
to the **first branch node** on that path, and
`firstDecisionTicks = ceil(L1 * MLU / speedMluPerTick)`,
**Then** `firstDecisionTicks >= 90` (1.50 s) for every path in every level; **and** the minimum
over 1,000 levels per band is exactly `ENTRY_LEN + rowH` in ticks — **159 / 151 / 132 / 125 / 120**
— because V14 makes `rows[0]` a pass and
[`generation.md` §2.2](generation.md#22-nodes) makes a pass node's edge vertical, so `rows[1]`
holds one node too.

***This is the criterion that certified a window the owner could not play, and that is recorded
here rather than only in the design.*** *Round 4 raised `ENTRY_LEN` 100 → 160 LU, taking the band-5
first decision from 450 ms to **717 ms**, and this AC passed at 43 ticks against a floor of 40. The
constrained bot cleared it. The owner then played it and reported exactly the failure the criterion
exists to prevent: "there is a level to change road that too close at the entrance, impossible to
react in high level/high traffic".*

*The criterion was not misapplied and the measurement was not wrong. **The derivation was
incomplete.** The old floor of 40 was `BOT_ACQUIRE_TICKS 15 + 1 act + BOT_LOCKOUT_TICKS 6`, plus
one more acquire of slack — the cost of **one decision made in isolation**, taken from the bot's own
constants. [`generation.md` §7.1.7](generation.md#717-the-first-decision-deadline-and-why-the-bot-must-not-be-given-it-for-free)
had already established, in the same round, that the binding term is not the cost of the decision
but the **latency to starting it**, which grows with traffic. The floor never contained that term.
A criterion derived from a player model inherits that model's blind spots, and a model with two
terms may not be priced with one
([`gameplay.md` §8.11](gameplay.md#811-what-the-acceptance-criteria-could-not-certify--recorded-round-8)).*

*The new floor of 90 prices both: `BOT_SCAN_TICKS 6 + BOT_ACQUIRE_TICKS 15 + 1 + BOT_LOCKOUT_TICKS 6
= 28` for the decision, `+ 21` for one focus already running, `+ 6 × cars in flight (18–24)` for the
sweep to come round — 67 to 73 ticks, rounded to 90 with margin. Every band passes with 30 to 69
ticks in hand, and band 5 sits at 2.00 s against the 0.72 s that was rejected.*

*The floor is met by **V14**, not by `ENTRY_LEN`. With row 0 free to branch, `firstDecisionTicks`
would be `80 / 76 / 73 / 69 / 66` — above the old floor of 40 at every band and **below the new
floor of 90 at every band**. More entry road does not buy a fair first decision; a whole row does.
`firstDecisionTicks` is now a function of `rowH`, which is the one geometric quantity that cannot
be spent without the network getting shallower, and that is what makes the new floor harder to
erode than the old one.*

*This floor is **necessary and not sufficient**, and round 5 had to measure that to find it out. It
prices the decision from the moment the player starts it; [AC-246](acceptance-criteria.md) is the
sufficient condition and this AC is the cheap static check that catches the same defect a
generation earlier.*

**AC-246 · The first decision is as reliable as every other decision**
**Given** the constrained bot of [`generation.md` §7.1](generation.md#71-the-constrained-solver-bot)
run over 1,000 seeds per band,
**When** every junction a car actually crosses is classified as a **decision for that car** or not,
where a junction is a decision for a car if and only if **exactly one of its two outgoing branches
leads to a depot of that car's own colour** — the test `evaluate` itself applies
([`generation.md` §7.1.6](generation.md#716-the-helper-functions), `k0 === k1` is NOTHING) — and
each car's decisions are split into its **first** and its **later** ones, and `p_first` and
`p_later` are the shares of each class that the car left on a branch that cannot reach its colour,
**Then** `p_first - p_later <= 0.25 * (2 / N)` at every band — **1.56 / 1.14 / 1.06 / 1.00 /
0.96** percentage points for bands 1–5, with `N` from
[`generation.md` §6.1](generation.md#61-the-table) — **and** both figures are reported per band
whether or not the check passes.

*The definition above is deliberate and it replaces a parenthesis that had two readings. "The first
branch node on its path, where the two branches differ in which depot colours they reach" can mean
**differ for this car's colour** or **differ in their reachable-colour sets**, and only the first
is a working instrument. Under the set reading a junction counts as a decision for a car it poses
no question to, so the class is diluted with crossings that cannot be got wrong; measured, the gap
goes **negative at every band under both sweeps** — `−0.70 / −1.24 / −1.83 / −1.20 / −1.59` pp
under the correct rule and `−0.49 / −1.34 / −1.26 / −0.75 / −0.47` pp under the round-robin
injection this AC exists to catch. A check that passes its own fault injection at every band is not
a check. The per-colour reading reproduces the design's numbers to two decimal places and fails the
injection at bands 2–5, which is why it is the one written into the **When**.*
*This is the guard [`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)
argues for, and the threshold is derived rather than fitted: a level clears on at most `LIVES - 1`
misroutes across the `N` cars that arrive inside the clock, so `2/N` is the band's per-car error
budget and this allows the one decision that every car in the level must make to consume a quarter
of it more than an ordinary one. **The ceiling tightened at band 1 (3.13 → 1.56 pp) and loosened
nowhere**, because `N` is larger than `quota` was at every band — which is the clock's one
unambiguous cost to this guard, and it is the right direction for a guard to move. It is stated in `p` and not in a clear rate because `p` is the unamplified quantity — the same
1 pp drift shows up as anywhere between 0 and 60 points of clear rate depending on where the band
sits, which is how an 8 pp gap survived two rounds of measurement while looking like a difficulty
result. Round 6 measured `-0.39 / -0.69 / -0.21 / +0.10 / +0.27` pp against the old ceilings; the round-8
reading is* **(to be measured)**. *It remains the figure to re-read after any lever pull, and under
a clock **every** lever pull moves it, because every lever moves `interval` or the topology and
`interval` sets `N` ([AC-241](acceptance-criteria.md)).*

*The fault to inject is round 3's shipped sweep — pure round-robin, no onset capture — which reads
`+1.23 / +7.55 / +8.18 / +8.34 / +9.02` pp and must fail this at bands **2, 3, 4 and 5**. Band 1
passes under the injection and that is correct, not a weakness in the check: at `N = 32` the per-car
budget is 6.25 % and a 1.2 pp gap does not reach it. The check fails exactly where the defect was.*

***The per-arm split this sweep used to report is gone.*** *`tools/bot.mjs --entry-window` reported
the clear rate separately for levels whose row-0 node was a branch and levels whose was not, and
that bit was the largest structural variable in the game — 0.4 % against 95.7 % at band 4 before
D3. V14 means no level has a row-0 branch, so there is only one arm. The `p` gap this AC is written
in is what survives, and it survives precisely because it was never stated in terms of the arm.*

**AC-247 · Onset capture is an ordering and nothing more**
**Given** a constrained-bot run at any band,
**Then** over the whole run the count of captures — glances at a car that had never been glanced
at before — is **exactly equal to the number of distinct cars captured**, and is **less than or
equal to the number of cars that spawned**, so no car is captured twice and no tick produces more
than one capture; the bot's round-robin `cursor` has the same value after a capture as before it;
a capture sets `busyUntil` to `T + BOT_SCAN_TICKS` exactly as an ordinary glance does; and total
glances per second differ from a pure round-robin run of the same seeds by less than 2 %.
*Four separate ways for [`generation.md` §7.1.5](generation.md#715-the-per-tick-procedure--normative)
D3 to decay into the free-attention repair that §7.1.8 rejects twice. The capture must fire once
per car and not once per tick; it must not clobber the sweep, which is how one of §7.1.8's variants
starved every older car; it must cost a full glance; and it must come **out of** the attention
budget rather than adding to it.*

*The first clause used to read "exactly the number of cars that spawned", and that is not
achievable by any correct implementation: a car still in flight when the quota is met or the last
life is lost is never glanced at, so the ratio of captures to spawns measures `0.993 – 0.997` and
the AC fails on a bot that is behaving exactly as specified. `captures === distinct cars captured`
is the identity that is actually true, and it catches the defect the clause was written for —
a capture firing per tick instead of per car — **strictly harder**, because a per-tick capture
breaks the identity on the very first car rather than only in aggregate. `captures <= spawned` is
kept as the one-sided bound that survives the end-of-level truncation.*

*Round 6 measured captures per second `0.384 / 0.549 / 0.561 / 0.541 / 0.497` against spawn rates
`0.385 / 0.556 / 0.566 / 0.545 / 0.500`, the identity holding on every one of 5,000 runs, and
glances per second `7.20 / 5.97 / 5.74 / 5.45 / 5.53` against a round-robin's
`7.19 / 6.05 / 5.82 / 5.52 / 5.57` — a drift of `+0.1 / −1.3 / −1.4 / −1.3 / −0.7 %`. Under round 8
the spawn rates are `0.294 / 0.400 / 0.429 / 0.455 / 0.469` and the absolute capture rate should
track them; **the durable claims in this AC are the identity and the under-2 % drift**, both of
which are independent of the band table. Under a clock the truncation is larger — every run ends
with 2 to 5 cars in flight (AC-133) — so the captures-to-spawns ratio should read slightly below
round 6's 0.993–0.997, which is exactly why the first clause is an identity and not a ratio.*

**AC-248 · V14 — the row-0 node is a pass**
**Given** any generated level at any band, over 3,000 seeds per band,
**Then** `rows[0]` holds exactly one node, its `kind` is `'pass'`, its single outgoing edge has
`Δcol = 0`, and `rows[1]` therefore also holds exactly one node;
**And given** `buildRow` with its `forcePass` argument disabled,
**Then** levels with a row-0 branch are produced and this check rejects them.
*V14 is the owner's fourth change made structural
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)).
It is enforced as a **construction** constraint, not a rejection rule, and that distinction is what
makes it affordable: round 4 measured it as a rejection rule reaching `MAX_ATTEMPTS` on 2 seeds per
1,000 at band 5, and as a construction constraint it costs a median of 0 extra attempts
([`generation.md` §5.2](generation.md#52-which-rules-actually-reject-anything-and-what-rule-p-and-v14-cost)).
The second clause is the fault injection, and it is required because no amount of seed sweeping
will ever make the first clause fail.*

**AC-249 · V15 — a road changes column only at a junction**
**Given** any generated level at any band,
**Then** every node of kind `'pass'` or `'entry'` has exactly one outgoing edge and that edge has
`Δcol = 0`; equivalently, every edge with `Δcol ≠ 0` leaves a node of kind `'branch'`;
**And** over 3,000 seeds per band, the count of edges with `Δcol ≠ 0` equals the count of branch
nodes whose two targets are not `{c-1, c+1}`, plus twice the count of those that are;
**And given** `buildRow` with `passOptions` widened to every candidate column,
**Then** levels violating the first clause are produced, this check rejects them, and
[AC-206](acceptance-criteria.md) clauses (b), (c) and (d) fail on them.
*This is the single rule
[`generation.md` §2.5](generation.md#25-planarity-and-non-coincidence-why-no-two-roads-are-ever-mistaken-for-one)'s
entire non-coincidence proof rests on, and it is the reason "every corner in the network is a
junction corner" is a theorem rather than a hope
([`ui.md` §1](ui.md#1-identity)). It is the most expensive rule in round 8 — it roughly halves the
distinct edge topologies at every band — and it buys the drawing its only guarantee that two roads
are never mistaken for one. The third clause is the fault injection and it is the only way this
check is ever executed against a violation.*

---

## 300 — Input

**AC-301 · Screen-to-design mapping**
**Given** `scale`, `originX`, `originY` from [`ui.md` §3.2](ui.md#32-mapping-design-space-onto-the-play-area),
**When** a touch at `(sx, sy)` is converted,
**Then** the result is `round((sx - originX)/scale)`, `round((sy - originY)/scale)`.

**AC-302 · Hit radius formula**
**Given** any `scale` and any band,
**Then** `HIT_R_LU === min( max( ceil(22/scale), 76 ), floor((min(colW,rowH) - 6)/2) )`, with the
upper bound applied **last**.
*The ordering is normative and it is not decorative. At band 5, `min(colW, rowH) = 150` gives an
upper bound of 72, which is below the lower bound of 76 — so the lower bound is inert there and the
upper bound wins. An implementation that applied them the other way round would produce 76 LU hit
circles on a 150 LU pitch, which touch ([AC-303](acceptance-criteria.md)).
([`ui.md` §4.4](ui.md#44-tap-target-arithmetic))*

**AC-303 · Hit circles never overlap**
**Given** any band and any supported viewport,
**Then** `2 * HIT_R_LU <= min(colW, rowH) - 6 < min(colW, rowH)`, so at most one junction contains
any point. Verified over the full sweep of [AC-401](acceptance-criteria.md): 5,512,425
configurations, zero overlaps.

**AC-304 · A tap on empty road is ignored**
**Given** a tap more than `HIT_R_LU` from every junction centre,
**Then** no input is enqueued, no event is emitted, and nothing on screen changes.

**AC-305 · A tap is stamped to the next tick to be simulated**
**Given** a tap received between two `step()` calls where the next is tick `T`,
**Then** the enqueued input is `{tick: T, junctionId}` and it is consumed by that `step()`.

**AC-306 · Two taps in one frame are two inputs on one tick**
**Given** two taps on two different junctions that both arrive between the same pair of `step()`
calls — reachable with one finger at 30 fps, or under any catch-up frame
([`ui.md` §10.3](ui.md#103-gestures)),
**Then** two inputs are enqueued with the same `tick`, neither is coalesced or dropped, and
`step()` applies them in ascending junction id regardless of arrival order
(AC-110).
*This was "two simultaneous pointers" through slice 2 and it was not testable — a mouse has one
pointer, and round 7 made Offramp a one-pointer game
([`ui.md` §10.3](ui.md#103-gestures)). The guarantee it was protecting is a property of the input
**queue**, not of the touch layer, and in that form it is reachable from a unit test and from
tier 3.*

**AC-307 · Taps are discarded while paused**
**Given** a paused game or an active resume countdown,
**When** the canvas is tapped,
**Then** no input is enqueued.

**AC-308 · Taps are discarded after the level ends**
**Given** `phase !== 'running'`,
**When** the canvas is tapped,
**Then** no input is enqueued.

**AC-309 · No debounce**
**Given** two taps on the same junction 20 ms apart,
**Then** both are enqueued, on consecutive ticks, and the junction ends in its original state.

**AC-310 · Flipping ahead of a car works**
**Given** a car on an edge approaching junction `J`,
**When** `J` is tapped,
**Then** the flip applies immediately and the car takes the new branch on arrival.

**AC-311 · Flipping behind a car does nothing to it**
**Given** a car that has already transitioned through `J`,
**When** `J` is tapped,
**Then** that car's route is unchanged; the flip affects only later arrivals.

**AC-312 · Tap is the only gesture**
**Given** the gesture configuration over the canvas,
**Then** exactly one gesture is registered, it is a `Gesture.Tap()`, and there is no pan, swipe,
long-press, double-tap or `Manual` handler.
*Reaffirmed in round 7 against the alternative of relaxing it to `Gesture.Manual()` for two-finger
play. [`ui.md` §10.3](ui.md#103-gestures) records why the game is one-pointer and what the three
arguments were.*

**AC-313 · A second pointer does not move the tap**
**Given** a recognised tap,
**Then** the point hit-tested is the position of the gesture's **first** pointer, captured when the
gesture begins — not the centroid of its live pointers;
**And given** a second pointer that lands on the canvas while the first is still down and lifts
before or with it,
**Then** the tap still resolves to the first pointer's junction, exactly one input is enqueued,
and the gesture is not cancelled.
*RNGH tracks the centroid, so the default behaviour is that a second finger drags the reported
point toward it and two fingers on two junctions report one tap at the midpoint — which usually
hits neither junction and occasionally hits a third. Verifiable at tier 3 with
`CDPSession.Input.dispatchTouchEvent` and two touch points, and at tier 5 by resting a second
finger on the glass; both are required, because the web and native recognisers are different code.*

---

## 400 — Layout

**AC-401 · 44 pt tap targets across the viewport sweep**
**Given** `tools/layout-sweep.mjs` over widths 320–520 pt, heights 560–1200 pt, nine safe-area
inset profiles and all five bands, excluding configurations below the declared support floor
([AC-409](acceptance-criteria.md)),
**Then** `2 * HIT_R_LU * scale >= 44` in every configuration; the harness reports 0 violations and
a minimum of **44.16 pt**, at `320 × 572` with 24/24 insets at band 5.
*The designer's arithmetic sweep measures 5,512,425 configurations. The margin is **0.16 pt**,
against 2.00 pt under the old geometry: band 5's six columns put `min(colW, rowH)` at 150 LU, which
is as fine as this design rectangle goes. A seventh column, or any rise in `HIT_R_MIN`, requires
`DESIGN_W` to move ([`ui.md` §4.4](ui.md#44-tap-target-arithmetic)).*

**AC-402 · Car body legibility across the sweep**
**Given** the same sweep,
**Then** `CAR_W * scale >= 20` in every configuration; the minimum is **20.24 pt**, at `320 × 572`
with 24/24 insets.
*`CAR_W = 66` LU is set by this criterion and by nothing else: the smallest supported configuration
scales at 0.30667, so `CAR_W >= 65.2`. The owner asked for smaller cars and this is the floor that
answers how much smaller — 66 LU is 21 % narrower and 42 % smaller in area than the 84 LU it
replaces, and **the car cannot get smaller than this without raising the support floor or
re-arguing this criterion** ([`ui.md` §4.1](ui.md#41-geometry-constants-lu)).*

**AC-403 · Scale is uniform**
**Given** any viewport,
**Then** `scale === min(playW/1000, playH/1500)` and the same value is used on both axes.
*`DESIGN_H` moved 1600 → 1500. LU is a ratio unit, so the change is not a shrink — it is an aspect
correction that stops the design rectangle being height-bound on the binding device, and it is
worth 5.8 % of scale there ([`ui.md` §3.2](ui.md#32-mapping-design-space-onto-the-play-area)).*

**AC-404 · Vertical slack split**
**Given** a viewport with vertical slack,
**Then** `originY === playTop + slackY * 0.55` and `originX === (playW - 1000*scale)/2`, with
`slackY === playH - 1500 * scale`.

**AC-405 · HUD sits below the safe-area top inset**
**Given** any inset profile,
**Then** the HUD's top edge equals `safeAreaTop` and its height is 56 pt.

**AC-406 · Play area clears the bottom inset**
**Given** any inset profile,
**Then** the play area's bottom edge is `safeAreaBottom + 8` pt above the screen bottom, and no
interactive element is within 16 pt of the bottom inset.

**AC-407 · Portrait only**
**Given** the app configuration,
**Then** `orientation` is `"portrait"`, and rotating the device does not re-lay out the game.

**AC-408 · Reference device fit**
**Given** 393 × 852 pt with insets 59 / 34,
**Then** `scale === 0.393`, play height is 695 pt, vertical slack is 106 pt, the junction target at
band 5 is **56.6 pt**, the car body is **25.9 × 40.9 pt** and the road is **33.0 pt** wide
([`ui.md` §3.3](ui.md#33-measured-fit-across-real-devices)).

**AC-409 · Support floor is enforced, not assumed**
**Given** a viewport with `playW < 320` or `playH < 460`,
**Then** the game still renders without crashing, and the layout harness reports it as outside the
declared support envelope rather than as a pass.
*The height floor moved 400 → 460 pt. The design rectangle is shorter, so it reaches its height
bound at a larger `playH`; at `playH = 460` the scale is 0.30667 and AC-401 and AC-402 clear by
0.16 pt and 0.24 pt. Below it, band 5's 44 pt target cannot be met.*

**AC-410 · Depots stay inside the design rect**
**Given** any band,
**Then** every depot's `x ± DEPOT_W/2` lies within `[0, 1000]`, with a margin of at least 30 LU
(narrowest: band 5, **63 LU**); **and** adjacent depots are separated by at least 20 LU
(narrowest: band 5, `colW - DEPOT_W = 150 - 124 = ` **26 LU**).

**AC-411 · The depot row stays inside the design rect vertically**
**Given** any band,
**Then** `DEPOT_Y + DEPOT_H = 1350 + 128 = 1478 <= DESIGN_H = 1500`, and the depot body at its 1.04
**receiving** scale ([`ui.md` §7.4](ui.md#74-depot)) reaches `1480.6`, also inside; **and given**
the arithmetic sweep of [AC-401](acceptance-criteria.md)'s device matrix, **then** the clear space
between the depot body and the bottom of the screen is at least **8 pt** on every supported
configuration, measured minimum **14.75 pt**.
*Slice 1b spent this margin down to 11.0 pt on the binding device, taking `DEPOT_Y` from 1360 to
1420 to buy 60 LU of `ENTRY_LEN`. Re-laying the design rectangle in round 8 gave it back — 22 LU of
design margin rather than 10. It is still not free twice, and this AC is what makes the next attempt
to spend it fail loudly.*

---

## 500 — Visual

**AC-501 · Draw order**
**Given** a rendered frame,
**Then** elements are painted in the order of [`ui.md` §4.2](ui.md#42-draw-order); **every car
shadow is painted before every car body** (§4.2 steps 7 and 8 are two passes over the car list,
not one); a car is never occluded by a junction marker, by the road, by another car's shadow or by
anything outside the depot layer; and a car **is** occluded by the depot terrace and the depot
body, which are the two things painted after it ([`ui.md` §7.6](ui.md#76-the-depot-terrace)).
*Through slice 2 §4.2 said "cars, ascending by id, each with body, roof glyph and shadow", which
draws car n+1's shadow over car n's body and contradicts this AC's own third clause. Round 7 split
the step. **The case is far more reachable than it was**: §4.5's no-overlap guarantee stops at the
shared depot approach, which every level at every band has, and under orthogonal routing two cars
come within a car length there in 59–301 runs per 1,000 rather than 0–5
([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)).*

**AC-502 · The car body is one colour fill**
**Given** a rendered car,
**Then** its body is a single rounded rectangle `CAR_L × CAR_W = 104 × 66` at radius
`CAR_RADIUS = 12`, filled with one palette colour; the windscreen is `--text` at 22 % and the glyph
`--ink`, and together they cover less than 35 % of the body's area — measured **34.0 %** by
rasterising the exact shapes at 0.25 LU: windscreen 26 × 36 LU at radius 6 offset 24, glyph
`GLYPH_CAR = 42` square, overlap counted once, against a body of **6,740 LU²**.
*The old car measured 31.5 % of 11,542 LU². The share rose because the body's area fell 42 % while
`GLYPH_CAR` fell only 13 % — it has to stay legible at 13.4 pt on the binding device
([`ui.md` §6.2](ui.md#62-glyph-drawing-rules)) — so the windscreen gave up the difference. **1.0 pp
of headroom against this ceiling is what says the car is as small as the current glyph sizes
allow**, and a future request for a smaller car has to move `GLYPH_CAR` first and then re-argue
AC-604 and §6.2.*

**AC-503 · Car fits the road**
**Given** any band,
**Then** `CAR_W (66) < ROAD_W (84)` with a 9 LU shoulder each side; two roads in adjacent columns
are separated by at least `colW - ROAD_W = 150 - 84 = 66` LU at the narrowest band; and the
junction marker's diameter `2 × JUNCTION_MARK_R = 68` is **less than** `ROAD_W`, so the marker sits
inside its road rather than overhanging it.

**AC-504 · The blade shows the open branch**
**Given** a junction with `open === k`,
**Then** its blade is rotated to the direction of the **first segment** of `out[k]` — down for a
`straight`, left for a `jogL`, right for a `jogR` — it is `BLADE_LEN = 30` LU long and
`BLADE_W = 9` LU thick, and the first 120 LU of `out[k]` is drawn brighter than the closed
branch with butt caps and a linear alpha ramp to zero over its final `OPEN_BRANCH_FADE = 28` LU;
**And given** any junction of any generated level,
**Then** the rendered blade angle **differs** between `open === 0` and `open === 1` by at least
**90°**, at every junction of every level over 1,000 seeds per band.

*The ≥ 30° clause is **restated as ≥ 90°** and the restatement is exact rather than measured. The
old threshold was derived from `atan(colW / rowH)` — the angle between a straight branch and a
diagonal one under the cubic model — and measured out at eight values, `36.87 / 39.09 / 40.91 /
44.27°` for straight-against-diagonal and `73.74 / 78.19 / 81.83 / 88.55°` for two diagonals, so
30° was a real threshold with a few degrees of room. **Orthogonal branches leave the node at right
angles by construction**: a branch is `{c, c±1}` (one vertical, one horizontal → 90°) or
`{c-1, c+1}` (two opposed horizontals → 180°). There are no other cases and no measurement is
needed.*

*The slice-2 defect this clause exists for is **gone by construction, not by discipline**. Under
the cubic model every edge left its node vertically, so a tangent-derived blade drew the identical
vertical bar for both branches and the junction silently stopped showing its state; it shipped, and
it was caught by looking at a screenshot rather than by a test. A tangent-derived blade is now
*correct*, because the tangent at the node **is** the first segment's direction. The second clause
is kept anyway, because "the two blades differ by at least 90°" also catches a blade drawn along
the wrong branch, which no construction prevents.
[`ui.md` §7.3](ui.md#73-junction) is normative.*

**AC-505 · In-canvas animation is replay-deterministic**
**Given** a recorded run replayed at a fixed frame rate,
**When** frames are captured at the same ticks as the live run,
**Then** the screenshots are identical, because every play-surface animation derives its phase
from `currentTick - eventTick`.

**AC-506 · Commit preview arms at 200 LU**
**Given** a car whose remaining distance to junction `J` is ≤ `COMMIT_PREVIEW = 200` LU,
**Then** `J` draws the lead-highlight bar along its open branch for 170 LU, following the branch's
polyline and its fillet; above 200 LU it does not.

**AC-507 · Nothing idles**
**Given** a running level with no `events` in the current tick and `lives > 1`,
**Then** the only changing pixels in the play surface are car positions.

**AC-508 · No logging in the render path**
**Given** `src/render/`,
**Then** it contains no `console.*` call.

**AC-509 · Depot colours are unique within a level**
**Given** any level,
**Then** no two depots share a colour, and every car colour has exactly one matching depot.

**AC-510 · Last-life state**
**Given** `lives === 1`,
**Then** the 2 pt `--alert` border at 24 % is present and the life-pip row is pulsing on a 1.6 s
cycle; at `lives >= 2` neither is present.

**AC-511 · Failure desaturates**
**Given** `phase === 'lost'`,
**Then** the play surface transitions to greyscale over 320 ms and the cars freeze in place.

**AC-512 · Palette values are exact**
**Given** the theme module,
**Then** the five car colours are `#FF852A`, `#89D9FF`, `#FF5386`, `#22C6AF`, `#A879FF` in that
index order, and the chrome tokens match [`ui.md` §5.3](ui.md#53-surface-and-chrome-palette)
character for character.

**AC-513 · The depot terrace covers the shared approach, and the residual is reported**
**Given** any band and the `mouthLu` table of [`ui.md` §7.6](ui.md#76-the-depot-terrace),
**Then** the terrace's top edge is `DEPOT_Y - mouthLu` and it covers every terminal edge from there
to the depot, leaving exactly `rowH - mouthLu = 46` LU of shared approach road visible at **every**
band;
**And given** `tools/converge.mjs --seeds 1000` per band driving the constrained bot,
**Then** it **reports**: the rate at which two cars on a shared terminal approach come within
`CAR_L = 104` LU of each other, the share of those pairs in which **both** centres are above the
terrace, and the worst observed centre-to-centre distance among that share — together with a
captured frame of the worst case.

***This AC reports a number as well as bounding a geometry, and that is deliberate.*** *Under the
cubic model the residual was a curiosity: two cars came within a car length on converging terminal
edges in **0–5 runs per 1,000**, with the apron reducing the worst visible overlap to 11 % of a
body. Under orthogonal routing two or three terminal edges share **the same vertical road for the
whole of the last row**, and the designer's prototype measures the same event at **59 to 301 runs
per 1,000** by band, with a minimum centre-to-centre distance of 0 LU. **The owner's
orthogonal-roads direction bought this, and it is the one place in round 8 where the drawing got
harder rather than easier**
([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)).*

*Two structural repairs were measured and rejected: equal path length to a shared depot (V16) takes
generation to `GEN_EXHAUSTED` at bands 3 and 5 and the attempt p95 to 168 against
[AC-203](acceptance-criteria.md)'s ceiling of 128; forbidding shared depots pins `J` at `K - 1`,
which is 4 at band 5 against a table asking for 7–9. **A full geometric guarantee is therefore not
available and is not claimed**, and the terrace is already at its maximum legal depth
([AC-514](acceptance-criteria.md)). What is left is a rate, and a rate a player will encounter is a
thing the tester should look at rather than only tick.*

**AC-514 · The terrace never reaches a junction marker**
**Given** the band table,
**Then** `mouthLu === rowH - JUNCTION_MARK_R - 12` exactly, for every band — **170 / 170 / 134 /
134 / 134** — so the terrace's top edge is always 12 LU below the bottom of any junction marker on
the last route row, and every junction remains fully visible and fully tappable;
**And** the terrace spans horizontally from `x(0) - DEPOT_W/2 - 12` to `x(C-1) + DEPOT_W/2 + 12`,
which contains every terminal edge's horizontal run and both ends of every depot body.
*`mouthLu` is at its **maximum legal value** at every band, not at a chosen one: the whole of
[AC-513](acceptance-criteria.md)'s residual is what is left over after taking as much as the
junction markers allow. `MOUTH_W` is deleted — there is no per-edge apron stroke any more, so there
is no stroke width to size against a car's diagonal ([`ui.md` §7.6](ui.md#76-the-depot-terrace)).*

**AC-515 · A misroute is legible from under the depot**
**Given** a `misrouted` event,
**Then** the shatter fragments originate at the **terrace line** of `level.edges[event.edgeId]` —
the point at which the car went under, on the edge named on the event (AC-140), not the depot node
and not an edge inferred from state the renderer kept from an earlier tick — are filled with the
**car's** colour, and are drawn over the terrace and the depot body; and the rejecting depot
desaturates over the same 350 ms
([`ui.md` §8.4](ui.md#84-car-misrouted)).
*The same applies to the delivery glow of [`ui.md` §8.3](ui.md#83-car-delivered), which is anchored
to the same terrace line and reads `edgeId` from the `delivered` event. Slice 2 shipped this by
reading the car's edge from a previous-tick snapshot, correctly and knowingly, and reported it; the
event now carries the edge and the snapshot path is to be deleted rather than kept as a fallback —
two routes to one fact is the bug shape this project keeps finding
(`docs/development-process.md:173`).*

**AC-516 · The terrace is one shape and does not stack alpha**
**Given** any rendered frame,
**When** the depot terrace is drawn,
**Then** it is **one** rounded rectangle with **one** linear alpha gradient along its top edge, not
a per-edge stroke and not a union of paths; sampling any point inside it returns the same
`--depot` value regardless of how many terminal edges pass beneath; and no `saveLayer` is required
to make that true.
*The old treatment stroked a per-edge apron, which needed a `saveLayer` so overlapping fade
segments did not accumulate into a visible lens, plus a `MOUTH_W` derived from the car's diagonal.
Under orthogonal routing every terminal edge ends in a vertical drop at a depot column, so the
region to cover is a single horizontal band across the depot row. **This criterion went from
carefully satisfied to trivially satisfied**, which is one of the few places round 8's geometry made
the drawing simpler ([`ui.md` §7.6](ui.md#76-the-depot-terrace)).*

**AC-520 · The clock is drawn from the tick, and the last ten seconds are marked**
**Given** the HUD at any tick,
**Then** the clock bar's fill width is `180 * (LEVEL_TICKS - state.tick) / LEVEL_TICKS` pt and its
caption is `floor((LEVEL_TICKS - tick)/3600)`:`ss`, both computed from `state.tick` and from no
other source — no `Date.now()`, no `setInterval`, no wall-clock accumulator;
**And given** a paused game or an active resume countdown,
**Then** the bar and the caption do not move;
**And given** `state.tick >= LEVEL_TICKS - 600`,
**Then** the bar fill and the caption are `--alert`, the caption shows whole seconds only, and
neither pulses, scales nor otherwise animates;
**And given** a recorded run replayed,
**Then** the bar and caption are pixel-identical to the live run at the same tick
([AC-505](acceptance-criteria.md)).
*The bar **drains** where the quota bar filled, which is the correct direction for a resource being
spent and makes a pre-round-8 screenshot immediately distinguishable from a post-round-8 one. The
tick-derived rule is the load-bearing clause: a `setInterval` counting seconds drifts from the
simulation on any device that drops frames — where world time runs slower than wall time by design
([`gameplay.md` §2.1](gameplay.md#21-tick-rate-and-the-level-clock)) — and would show 0:00 while
cars were still moving. The final-ten state is a state change and not decoration: routing decisions
in the last ten seconds are worth nothing for any car that cannot reach a depot in time, and
[`generation.md` §6.1](generation.md#61-the-table)'s minimum transit is 389 ticks, so that is most
of the board ([`ui.md` §7.1](ui.md#71-hud)).*

**AC-517 · A car's arrival is an abrupt onset**
**Given** the frame on which a car spawns and the frames after it,
**Then** the car body, its glyph and its stroke are drawn at **full** opacity and full scale on the
first frame the car exists, with no fade, ramp or scale-up applied to the car at any point on the
entry edge; and the entry flare of [`ui.md` §7.5](ui.md#75-car) is drawn beneath the car layer and
carries none of the car's colour.
*The player model this design's targets are read off asserts that a newly appeared car is looked at
**next** rather than last, and that is the only reason the first junction decision is reachable
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision),
[AC-246](acceptance-criteria.md)). Attention is captured by an abrupt luminance transient and a
gradual onset of the same magnitude does not capture it, so a fade-in would make the drawing
falsify the design's own claim about the player — silently, and in the one place it could not be
detected from a clear rate. **Round 8 did not weaken this.** V14 buys the player time to *start*
the first decision; D3 and this criterion are what make the decision reachable once started, and
[`generation.md` §7.1.7](generation.md#717-the-first-decision-deadline-and-why-the-bot-must-not-be-given-it-for-free)
is the two-column table that shows both terms are needed.*

**AC-518 · The depot's colour geometry is the specified geometry**
**Given** a rendered depot at either symbol size,
**Then** the glyph disc is centred on the body with radius `0.75 × glyphSize` — 39 LU at
`GLYPH_DEPOT = 52`, 54 LU at `GLYPH_DEPOT_LARGE = 72` — so it circumscribes the square glyph's
`0.707 × s` corner radius with margin and still clears `DEPOT_W = 124` by at least 8 LU a side;
**And** the sill is **three** rounded bars, each `DEPOT_HATCH_W = 5` LU tall on an 8 LU pitch,
inset 12 LU from each side, the lowest bar's bottom edge 6 LU above the body's bottom edge, in the
depot's colour at 18 %;
**And** on a rejecting depot the face band, the glyph disc and the sill bars all desaturate
together ([`ui.md` §7.4](ui.md#74-depot)).
*All four numbers were undefined through slice 2 — §7.4 drew a disc without sizing it and called
the sill "a 6 LU hatch in the colour at 18 %, bottom third", which named a texture and a region
and specified neither. Round 8 scaled all of them by the depot's 0.78 shrink; the disc ratio is
derived and does not scale.*

**AC-519 · A delivery glows one road, not the depot's roads**
**Given** a `delivered` event at a depot fed by two or three terminal edges,
**Then** the mouth glow of [`ui.md` §8.3](ui.md#83-car-delivered) is drawn on the last `mouthLu` of
`level.edges[event.edgeId]` alone — which, where the final approach is shared, is that shared
segment plus the horizontal run the arriving car actually came in on — and the horizontal runs of
that depot's other terminal edges are unchanged for the whole 220 ms.
*Slice 2 unioned every mouth of a depot into one path and glowed all of them, so one arriving car
lit two or three roads. Every level at every band has at least one such depot, so this fires
constantly. **Under orthogonal routing the clause needs its parenthesis**: the shared vertical
genuinely belongs to every edge that feeds the depot, so glowing it is correct; what must not glow
is another edge's horizontal run. AC-140 is what makes the distinction available to the
renderer.*

---

## 600 — Accessibility

**AC-601 · Glyph assignment**
**Given** the five palette entries,
**Then** their glyphs are circle, triangle-up, square, plus, double-bar in index order — so that
the two tritanopia-collapsing pairs (Ember/Rose, Sky/Teal) are circle-vs-square and
triangle-vs-plus.

**AC-602 · Glyphs are always drawn**
**Given** any settings combination,
**Then** every car and every depot shows its glyph. There is no setting that hides it.

**AC-603 · Glyphs are screen-upright**
**Given** a car anywhere on its path, including mid-corner,
**Then** its glyph is rotated 0° relative to the screen while its body is rotated to the road
direction — through a corner the body sweeps 90° over `2 × CORNER_R = 56` LU and the glyph
counter-rotates over exactly the same span, so it is upright on every frame and not only at the
ends.

**AC-604 · Symbol size setting**
**Given** Symbol size = Large,
**Then** `GLYPH_CAR` is 58 LU, `GLYPH_DEPOT` is 72 LU and car-glyph opacity is 100 %; at Standard
they are 42 LU, 52 LU and 78 %.
*Every glyph scaled with its carrier in round 8. At Standard the car glyph is 13.4 pt on the
binding device against the 14 pt §6.2 names as the silhouette-difference floor; **Large is the
setting that clears it** (18.6 pt), which is why Large raises opacity as well as size and why §6.2
assigns the most shape-distinct glyphs to the two tritanopia-collapsing pairs.*

**AC-605 · Reduce motion preserves information**
**Given** Reduce motion = On,
**Then** the shatter, vignette flash, panel spring, last-life pulse and score count-up are
replaced by their static or 120 ms-fade equivalents, and every state in
[`ui.md` §8](ui.md#8-screen-states) is still distinguishable from every other.

**AC-606 · Contrast floors**
**Given** the theme,
**Then** every text token is ≥ 4.5 : 1 against every surface it is used on; every car colour is
≥ 3.0 : 1 against `--road` (measured minimum 4.21 : 1); **and so is every car colour after the
windscreen tint is composited over it** — `--text` at 22 % gives
`6.13 / 8.74 / 4.99 / 6.71 / 5.24 : 1` in palette index order, minimum 4.99.
*The third clause exists because the windscreen covers about a fifth of the body and slice 2 drew
it in `--ink` at 22 %, which puts Rose at 2.79 : 1 and Iris at 2.81 : 1 — below even the 3.0 floor,
on the element whose only job is to be identified by colour. The contrast check has to be run on
the composited patch, not on the palette entry.
[`ui.md` §4.3](ui.md#43-the-car) has the derivation.*

**AC-607 · Screen-reader scope is what is claimed**
**Given** VoiceOver enabled,
**Then** every menu, overlay and settings control is labelled and operable, and the play surface
is exposed as a single element whose label updates on delivery, misroute and level end with the
level number, delivered count, time remaining and lives. Per-car announcement is explicitly out of
scope.

**AC-608 · Every control is at least 44 × 44 pt**
**Given** any screen,
**Then** every interactive element has a hit area of at least 44 × 44 pt with at least 8 pt
between adjacent targets.

**AC-609 · Lives are not signalled by colour alone**
**Given** the HUD,
**Then** a lost life is indicated by the pip becoming outlined, not by a hue change, and the
count is also legible from the pip fill state alone in greyscale.

**AC-610 · Haptics can be turned off**
**Given** Haptics = Off,
**Then** no `expo-haptics` call is made for any event.

---

## 700 — Progression

**AC-701 · Level-to-band mapping**
**Given** a level number `N`,
**Then** its band is 1 for `N ≤ 4`, 2 for `5 ≤ N ≤ 9`, 3 for `10 ≤ N ≤ 15`, 4 for
`16 ≤ N ≤ 22`, and 5 for `N ≥ 23`.

**AC-702 · Level seed derivation**
**Given** `RUN_SEED` and level `N`,
**Then** the level seed is `mix32(RUN_SEED ^ Math.imul(N, 0x9E3779B1), GEN_SALT)` and is stable
across restarts.

**AC-703 · Unlock sequence**
**Given** a run of level `N` that ends with `phase === 'ended'` for the first time,
**Then** level `N+1` becomes available and no later level does;
**And given** a run that ends with `phase === 'lost'`, whatever its `delivered`,
**Then** nothing unlocks.
*Clearing a level is surviving its two minutes and nothing else — not a delivery target, which
would be a quota by another name
([`gameplay.md` §7](gameplay.md#7-progression-slice-4-territory-specified-here-so-it-is-not-invented-later),
AC-132). Two players who both survive have both shown the skill the level teaches; one of them
getting three more cars because their seed spawned a friendlier colour order is not a reason to
gate them.*

**AC-704 · Retry replays the same level**
**Given** a level and its seed,
**When** Retry is chosen,
**Then** the regenerated network, depot colours and spawn schedule are deeply equal to the
previous attempt's.

**AC-705 · Persistence fields**
**Given** a cleared level,
**Then** cleared-flag, **best delivered**, best streak and fewest misroutes are stored, and survive
an app restart. There is no stored "best score" distinct from best delivered, because there is no
score distinct from delivered (AC-117).

**AC-706 · No network, no accounts, no ads**
**Given** the whole app,
**Then** it makes no outbound network request, has no sign-in, and contains no advertising or
analytics SDK.

**AC-707 · Level 1 is always playable**
**Given** a fresh install with no stored progress,
**Then** level 1 is immediately available with no gate.

---

## 800 — Failure and edge cases

**AC-801 · The third misroute ends the level on that tick**
**Given** `lives === 1`,
**When** a car is misrouted,
**Then** `phase` becomes `'lost'` at the terminal check of that same tick, `state.tick < 7200`, and
no car resolves on any **later** tick. Cars arriving in the **same** tick still resolve and are
still counted (AC-122, AC-136) — the terminal check is step 5 and runs once, after step 4 has
resolved every arrival. *Slice 0's wording said "no further car resolves", which read as an abort
in the middle of step 4 and contradicted AC-122.*

**AC-802 · The clock and the third misroute on the same tick is a loss**
See AC-122; this is the on-device expression of it — the **failure** overlay is shown, not the
level-complete overlay, and the next level does not unlock.
*This reverses slice 0's rule, which resolved the tie as a win because the quota had been
completed. Under a clock there is no job to have finished, and resolving the tie in the player's
favour would make tick 7,199 the one tick on which a misroute is free.*

**AC-803 · Backgrounding does not advance the simulation**
**Given** a running level,
**When** the app is backgrounded for 30 s and resumed,
**Then** `state.tick` at the moment of resume equals `state.tick` at the moment of backgrounding.

**AC-804 · Resume countdown**
**Given** a resume from background,
**Then** a 3-2-1 countdown of 3 × 600 ms runs, no `step()` is called during it, and taps are
discarded until it completes.

**AC-805 · A slow frame advances whole ticks, computed integer-first**
**Given** an accumulator of 0 ms and a frame delta of 50 ms,
**When** the React layer converts elapsed milliseconds to ticks using the normative form
`n = Math.floor(acc * TICK_HZ / 1000)` from
[`gameplay.md` §2.1](gameplay.md#21-tick-rate-and-the-level-clock),
**Then** `n === 3`, `step()` is called exactly **3** times, and the accumulator is left holding
exactly **0 ms** — 50 ms is three whole ticks at 60 Hz and the remainder is zero, not 0.33 ms.
*Slice 0 asserted a 0.33 ms remainder, which is arithmetically false.*

**50 ms does not distinguish the two conversion forms.** An earlier revision of this AC claimed the
divide-first form `Math.floor(acc / (1000 / TICK_HZ))` returns **2** here. It does not: `50 / (1000/60)`
is exactly `3` in IEEE 754 — bit pattern `0x4008000000000000`, no rounding error at all — so both
forms floor to 3. The claim reached this document from a verification report that had checked it
with Python's float `//`, which is computed from `fmod` and is not `floor(a/b)`. AC-816 states what
is actually true of the two forms and why the requirement is a source rule.

**AC-806 · A very slow frame is capped**
See AC-127; on device, a 2 s stall must not produce a visible teleport of any car by more than
`8 * speed` LU (at most 26.8 LU, a quarter of a car), **and it must not shorten the level**: the
run still contains 7,200 ticks, it simply takes longer than 120 s of wall time (AC-141).

**AC-807 · Generator exhaustion throws**
**Given** a deliberately impossible band configuration injected into the band table,
**Then** `generate()` throws `GEN_EXHAUSTED` with the band and seed in the message, and
`tools/generator-audit.mjs` reports a failure rather than a pass.

**AC-808 · A schedule that does not reach the clock is a build error**
**Given** a level whose `spawns` array is artificially truncated so that its last entry's `tick` is
more than `INTERVAL + JITTER` ticks before `LEVEL_TICKS`,
**Then** level construction **throws** rather than returning a level that would quietly stop
spawning part-way through the two minutes;
**And given** a normal level driven to the bell,
**Then** `state.nextSpawn === level.spawns.length` (AC-123) and no throw occurs.
*Re-subjected in round 8. This number used to assert a `SPAWN_EXHAUSTED` throw when a run consumed
its reserve entry — a guard against a schedule that was too short for an unknown number of cars.
The schedule is now exactly as long as the clock
([`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)), so
running out is impossible and **stopping early is the failure that replaced it**. A silently short
schedule is the harder fault: the level still plays, still ends on the clock, and simply has fewer
cars in it than the difficulty model says — which would move `N`, and with it every window in
[`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not),
with nothing visibly wrong.*

**AC-809 · Empty input array**
**Given** `step(state, [])`,
**Then** the tick advances and no junction changes state.

**AC-810 · `step()` after a terminal state**
**Given** `phase !== 'running'`,
**When** `step()` is called,
**Then** the returned state is deeply equal to the input state.

**AC-811 · Cross-machine replay**
**Given** the same recorded run,
**When** it is replayed on an arm64 device and on an x86 CI runner,
**Then** the final states are deeply equal. **A regression here outranks every other finding.**

**AC-812 · React 19 StrictMode double-invocation**
**Given** development mode with StrictMode on,
**When** the play screen mounts,
**Then** the simulation advances the same number of ticks per second as it does with StrictMode
off, no timer is registered twice, and no `step()` is called from inside a `setState` updater.

**AC-813 · A level with the minimum junction count is still winnable**
**Given** a band-1 level with `J = 3` at its minimum depth,
**Then** the constrained bot clears it, and every one of its three colours requires at least one
flip in at least one spawn sequence over 1,000 seeds — i.e. no level is won by never tapping.

**AC-814 · No level is survived by never tapping**
**Given** 1,000 seeds per band and a bot that never taps,
**Then** the clear rate is 0 % at every band — every run loses three lives before the clock.
*Under a quota this was "no level is won", which a never-tapping bot failed by never reaching the
quota. Under a clock a never-tapping bot would otherwise simply reach the bell with a low score, so
the criterion now depends entirely on lives existing
([`gameplay.md` §4.1](gameplay.md#41-lives)). It is the cheapest check in the document that the
three-lives rule is doing its job, and the first one that would fail if someone removed it.*

**AC-815 · The accumulator carries a true remainder**
**Given** an accumulator of 0 ms and a frame delta of 55 ms,
**Then** `step()` is called exactly **3** times and the accumulator retains **5 ms**; and given a
following frame delta of 12 ms (accumulator 17 ms), `step()` is called exactly **1** more time.
*The shipped accumulator is carried in tick units rather than milliseconds, so "5 ms" is observed
as `0.3` ticks; the two statements are the same number and either form satisfies this AC.*
*This is the companion to AC-805: AC-805 pins the zero-remainder case and this pins a non-zero
one, so a build that drops the remainder entirely passes neither.*

**AC-816 · The tick conversion is integer-first, checked at the source**
**Given** the module that converts elapsed wall time to ticks (`src/engine/clock.js`),
**When** its conversion expression is read,
**Then** it multiplies before it divides — the elapsed quantity is scaled by `TICK_HZ` and then
divided by `1000` — and no sub-expression of the form `1000 / TICK_HZ` exists anywhere in the
ticking path. *This is a source check, and it is a source check on purpose.*

**Why this cannot be a behavioural check.** The two forms are indistinguishable everywhere the
shipped clock can report:

- Over integer-millisecond deltas from 1 to 2,000 they disagree exactly 15 times, and the **first**
  is **250 ms** — integer-first 15 ticks, divide-first 14.
- `MAX_CATCHUP_TICKS = 8` clamps every delta at or above `8 × 1000 / 60 = 133.34 ms` (AC-127), so
  250 ms returns 8 ticks under either form. Every disagreement sits above the clamp.
- Below the clamp the forms agree not only on integers: over 5,000,000 random fractional
  accumulator values in `[0, 133.33)` there were **zero** disagreements.

So no input to `advanceClock` produces different output under the two forms, and an AC of the shape
"inject the divide-first form and watch AC-805 fail" is a check that **cannot pass**. The previous
revision of this AC was exactly that, written in good faith from the wrong number corrected in
AC-805 — the mirror image of a check that cannot fail, and just as useless. Integer-first still
ships, for the ordinary reason that it cannot drift as `TICK_HZ` or the clamp changes, and that is
a property of the source, so the source is where it is asserted. AC-805 and AC-815 remain the
behavioural checks: a build that drops or mis-rounds the remainder fails both.

**AC-817 · A non-finite or negative frame delta is dropped, not accumulated**
**Given** an accumulator holding a valid value,
**When** `advanceClock` is called with `NaN`, `+Infinity`, `-Infinity` or a negative delta,
**Then** it returns `0` ticks, the accumulator it returns is finite, and the **next** call with a
normal 16.7 ms delta returns ticks again.
*`NaN` fails both the `< 0` and the `> MAX_CATCHUP_TICKS` guard, so without an explicit finiteness
test one bad frame — which an uninitialised `lastFrameTime` in the React layer produces exactly —
poisons the accumulator and freezes the simulation for the rest of the session. Slice 1 reproduced
that freeze. The behaviour now exists in the engine; this AC is what keeps it there.*
