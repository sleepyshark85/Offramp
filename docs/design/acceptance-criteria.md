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
group; numbers are never reused.

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
so the car has always moved once by the time `step()` returns. Slice 1's wording asked for a value
that exists only between two statements inside `step()`, and the developer correctly implemented
the observable behaviour and flagged the AC instead of matching it. `speedMluPerTick` is the right
value because the entry edge is `ENTRY_LEN = 160,000` MLU, far longer than one tick of travel at
any band, so the spawning car cannot transition on its spawn tick.*

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

**AC-116 · Correct delivery scores and counts**
**Given** a car entering a depot whose `depotColour` equals the car's colour,
**When** the arrival resolves,
**Then** `delivered` increases by 1, `streak` increases by 1, the car is removed, `lives` is
unchanged, and a `delivered` event is emitted.

**AC-117 · Streak bonus and its cap**
**Given** a run of `n` consecutive correct deliveries,
**When** the `n`-th resolves,
**Then** the score increased by `100 + 10 * min(n - 1, 9)`; for `n >= 10` the increment is exactly
190.

**AC-118 · The transition loop is single-pass**
**Given** any seeded run of 20,000 ticks at any band,
**When** the transition `while` loop is instrumented,
**Then** its body executes at most once per car per tick.

**AC-119 · Misroute costs a life and no points**
**Given** a car entering a depot whose colour differs from the car's,
**When** the arrival resolves,
**Then** `lives` becomes `max(0, lives - 1)`, `misrouted` increases by 1 unconditionally, `streak`
becomes 0, `score` is unchanged, and a `misrouted` event carrying both colours is emitted.
*The decrement is clamped, not conditional: the arrival always resolves and is always counted,
and only the displayed life total is floored. See AC-121, AC-122, AC-136 and AC-801, which
together were unsatisfiable under their slice-0 wording, and*
[`gameplay.md` §2.6](gameplay.md#26-resolvearrival--the-single-place-scoring-happens) *for the
resolution.*

**AC-120 · Score is non-decreasing**
**Given** a seeded fuzz run of 50,000 ticks with randomised taps,
**When** the score is sampled after every `step()`,
**Then** it is a non-negative integer that never decreases.

**AC-121 · Lives are non-increasing and floored**
**Given** the same fuzz run,
**Then** `lives` never increases and never goes below 0 — including on a tick in which more
misroutes resolve than there are lives remaining (AC-136). The floor is a property of the
decrement in AC-119, not a separate clamp applied afterwards, so there is exactly one place in the
engine where `lives` is written.

**AC-122 · Terminal conditions, and their order**
**Given** a tick in which the quota-completing car is delivered **and** another car is misrouted
taking `lives` to 0,
**When** the terminal check runs,
**Then** `phase === 'won'`. Both arrivals resolved first: `delivered`, `misrouted`, `score` and
`lives` all reflect both cars, because step 4 of
[`gameplay.md` §2.5](gameplay.md#25-stepstate-inputs--exactly-one-tick) resolves every arrival in
the tick and step 5 runs the terminal check exactly once, afterwards.

**AC-123 · The spawn array is never exhausted**
**Given** a constrained-bot run over 1,000 seeds per band,
**When** each level ends,
**Then** `state.nextSpawn < level.spawns.length` at **every tick** of every run — not only at the
final tick. The engine throws `SPAWN_EXHAUSTED` when `nextSpawn` *reaches* `spawns.length`, so the
last scheduled car is a reserve that is never needed; see AC-139 for the margin this AC leaves and
[`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed) for
the derivation that sizes it.

**AC-124 · Minimum car separation**
**Given** any seeded run at any band,
**When** every pair of cars sharing an edge is measured after every `step()`,
**Then** their separation in LU is at least `(interval - 2*jitter) * speedMluPerTick / 1000`,
which is never less than 228 LU — greater than `CAR_L = 140`.

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

**AC-128 · A paused game does not advance**
**Given** a paused game,
**When** 5 seconds of wall time pass,
**Then** `state.tick` is unchanged.

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

**AC-132 · Level clear bonus**
**Given** a level won with `L` lives remaining,
**Then** the final score includes `50 * L` over and above the delivery total.

**AC-133 · Cars in flight are discarded at level end**
**Given** a level that ends with cars still on the network,
**Then** those cars score nothing, cost nothing, and remain in `state.cars` for the renderer to
freeze.

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
two `misrouted` events are emitted, `lives === 0` and not `-1`, `score` is unchanged, and
`phase === 'lost'` after the terminal check of that tick.

**AC-137 · The terminal check runs once, after every arrival**
**Given** a seeded fuzz run of 50,000 ticks with randomised taps,
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

**AC-139 · The spawn schedule keeps a measured margin**
**Given** an oracle router — perfect routing, unlimited taps — run over 2,000 seeds per band, in
both its shortest-path and its longest-path variant, with the `LIVES - 1 = 2` misroutes a winning
run is allowed injected at the first two opportunities,
**When** the maximum `state.nextSpawn` reached in each run is recorded,
**Then** `level.spawns.length - max(nextSpawn) >= 2` in **every** run at **every** band.
*Slice 1 measured this margin at `3 / 2 / 2 / 2 / 1` under the flat `SPAWN_SLACK = 8`, with band 5
seed 160 consuming 71 of 72 spawns and 30 of 5,000 band-5 seeds finishing with a margin of exactly
1 — one spawn interval, 1.6 s, from an uncaught throw in the middle of the hardest band. The
per-band derivation in [`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)
restores it to `3 / 2 / 3 / 3 / 3`. This AC is the reason the derivation exists, and
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed) requires it to be re-run after
every lever move.*

---

## 200 — Generation

**AC-201 · Generation is a pure function of `(seed, band)`**
**Given** the same seed and band,
**When** `generate()` is called in two separate processes,
**Then** the two level objects are deeply equal.

**AC-202 · Band parameters are applied**
**Given** a generated level for band `b`,
**Then** its `C`, `K`, `R`, `colW`, `rowH`, `diagLen`, `speedMluPerTick`, `interval`, `jitter`
and `quota` exactly match row `b` of [`generation.md` §6.1](generation.md#61-the-table).

**AC-203 · Generation never exhausts**
**Given** `tools/generator-audit.mjs --seeds 5000` across all five bands,
**Then** zero `GEN_EXHAUSTED` errors are thrown, and the reported attempt count has median ≤ 8 and
maximum ≤ 128.

**AC-204 · V1 — no dead ends**
**Given** any generated level,
**Then** every non-depot node has out-degree 1 or 2, every depot has out-degree 0 and in-degree
≥ 1, and every node reaches at least one depot.

**AC-205 · V2 — merge-free ordering**
**Given** any generated level,
**When** the edge targets of each route row are listed left to right by source column,
**Then** they are strictly increasing; on the terminal row they are non-decreasing.

**AC-206 · V3 — planarity**
**Given** any generated level,
**When** every pair of edges within the same row band is tested,
**Then** no pair `(a→b)`, `(a'→b')` exists with `a < a'` and `b > b'`.

**AC-207 · Edge lengths match the curve**
**Given** the band table's `diagLen` values,
**When** the reference derivation of [`generation.md` §3.3](generation.md#33-edge-lengths) is run
(128-step chord sum of the cubic, rounded),
**Then** it returns 521, 415, 415, 323 and 293 for bands 1–5 respectively, and every edge's
`lengthMlu` is `1000 ×` the table value for its shape.

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
**Then** every level's junction count lies in its band's `J` range, and the observed distribution
matches [`generation.md` §6.2](generation.md#62-measured-generator-behaviour) within 5 percentage
points per bucket.

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
**Then** the minimum is at least 150 LU.

**AC-217 · Merge-free**
**Given** any generated level,
**Then** no node with `kind !== 'depot'` has in-degree greater than 1.

**AC-218 · Integer geometry**
**Given** any generated level,
**Then** every node's `x` and `y`, every edge's `lengthMlu`, and the level's `colW`, `rowH` and
`diagLen` all satisfy `Number.isInteger`; **and given** a band-table row whose `C` or `R` is not a
divisor of `LANE_SPAN` or of `DEPOT_Y - ROW0_Y`, **then** level construction **throws** rather than
returning a level. *The throw is the point. Slice 1 injected `R = 7` and got a level back: 18 nodes
with fractional `y`, 17 edges with fractional `lengthMlu`, and by tick 683 a car holding
`progress = 1371.4285714285797` — a float inside the simulation, which is the one thing the
fixed-point rule of [`gameplay.md` §2.2](gameplay.md#22-position-fixed-point-integers-along-an-edge)
exists to prevent, arriving silently through a band-table edit rather than through a code change.*

**AC-219 · Serialisation round-trip**
**Given** any generated level,
**When** it is `JSON.stringify`'d and parsed back,
**Then** the result is deeply equal to the original.

**AC-220 · Unconstrained bot clears everything**
**Given** `tools/bot.mjs --unconstrained --seeds 1000` per band,
**Then** the clear rate is **100 %** and the misroute count is **0** in every run.

**AC-221 · Constrained bot clear rate — band 1**
**Given** `tools/bot.mjs --seeds 1000 --band 1` with the attention model of
[`generation.md` §7.1](generation.md#71-the-constrained-solver-bot),
**Then** the clear rate is **≥ 95 %**. There is no upper bound at band 1
([`generation.md` §7.2](generation.md#72-target-1--constrained-bot-clear-rate) R1).

**AC-222 · Constrained bot clear rate — band 2**
**Then** the clear rate is within **86 – 97 %**.

**AC-223 · Constrained bot clear rate — band 3**
**Then** the clear rate is within **76 – 92 %**.

**AC-224 · Constrained bot clear rate — band 4**
**Then** the clear rate is within **66 – 85 %**.

**AC-225 · Constrained bot clear rate — band 5**
**Then** the clear rate is within **55 – 78 %**.

**AC-226 · Completion-time band — band 1**
**Given** `tools/pacing.mjs` over 1,000 successful constrained-bot runs,
**Then** the median simulated duration is within **42 – 62 s** and p95 ≤ **68 s**.

**AC-227 · Completion-time band — band 2**
**Then** median within **58 – 78 s**, p95 ≤ **86 s**.

**AC-228 · Completion-time band — band 3**
**Then** median within **70 – 92 s**, p95 ≤ **100 s**.

**AC-229 · Completion-time band — band 4**
**Then** median within **84 – 106 s**, p95 ≤ **114 s**.

**AC-230 · Completion-time band — band 5**
**Then** median within **98 – 122 s**, p95 ≤ **126 s**.

**AC-231 · The two-minute ceiling**
**Given** every constrained-bot run across all bands and all sampled seeds,
**Then** **no** run exceeds **130 s** of simulated time.

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
**Then** it reports mean taps per second per band, and the reported value for band 5 is
≤ **1.25 /s**.

**AC-234 · Network variety**
**Given** 3,000 generated levels per band,
**Then** the count of distinct network signatures is at least 30 for band 1 and at least 500 for
bands 2–5.

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

*The rise is asserted at **band 5 only**, and the reason is now a measured one rather than a
convention. A 20 pp rise needs 20 pp of headroom, so the test is meaningless wherever the
unmodified bot already clears above 80 % — bands 1–4 report `+0.1 / +0.0 / +0.4 / +4.8 pp` under a
generator that lifts them to 95–100 %, and those are ceilings, not insensitivity. A band whose
unmodified rate is above 80 % is reported as `n/a (no headroom)` and is not a failure; any band at
or below 80 % that fails to rise 20 pp **is**. The failure this AC is for looks like slice 1b's:
bands 4 and 5 rising `+2.0` and `+7.4 pp` from 19.7 % and 2.3 %, with plenty of headroom and
nothing moving — which correctly located a deadline in the **game** that no player model could
meet ([AC-245](acceptance-criteria.md)), not a fault in the bot.*

**AC-241 · A lever pull satisfies both targets or is not a lever pull**
**Given** any proposed change to a band's `quota`, `interval`, `pBranch` or `K` under
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed),
**When** the change is applied,
**Then** AC-221 – AC-231 are **all** re-run and all pass. A change that moves a clear rate into
band while moving a completion-time median out of band has not been applied; it has been
proposed and rejected.

**AC-242 · V13 — the actionable junction floor**
**Given** any generated level at band `b`,
**When** every branch node's two reachable-colour sets are compared,
**Then** the number of branch nodes whose two sets are **incomparable** — neither contains the
other — is at least the band's `Ja` in [`generation.md` §6.1](generation.md#61-the-table):
**3 / 3 / 4 / 5 / 7** for bands 1–5. A junction whose sets are comparable is *decorative*: the
superset branch serves every colour the subset branch does, so a perfect player never has to flip
it. *Before this rule, decorative junctions were `0.0 / 29.6 / 13.5 / 26.7 / 14.1 %` of all drawn
junctions over 3,000 seeds per band; with it they are `0.0 / 29.6 / 11.4 / 25.0 / 12.2 %` and every
level clears the floor. The rule constrains the generator rather than describing it: it is the
reason the minimum actionable count is `3 / 3 / 4 / 5 / 7` instead of `3 / 3 / 3 / 3 / 5`.*

**AC-243 · Actionable `J` is measured per run, not assumed from the table**
**Given** `tools/generator-audit.mjs --actionable --seeds 3000` per band, which drives each level
with the lazy-optimal oracle of
[`generation.md` §6.2](generation.md#62-measured-generator-behaviour) and records the set of
junctions that oracle flips at least once,
**Then** it reports, per band: the mean and minimum live-junction count, the share of levels whose
live count is below `Ja`, and the mean count of junctions flipped **twice or more**; and the
measured values satisfy — live count `>= Ja - 1` in **100 %** of runs, and `>= Ja` in at least
**95 %**. *Measured with V13 in force: mean live `2.98 / 3.48 / 4.81 / 5.54 / 7.07`, minimum
`2 / 2 / 4 / 4 / 6`, below-`Ja` share `1.6 / 0.2 / 0.0 / 0.0 / 0.2 %`. The residue at bands 1 and 2
is a spawn-order effect, not a topology one, and no static rule removes it: a junction can be
structurally actionable and still not be exercised by one particular colour sequence. This AC
exists so that residue stays visible and bounded instead of being invisible, which is what it was
through slices 0 and 1.*

**AC-244 · Every validity rule is proven able to fire**
**Given** the eleven checks `V1`–`V11` plus `V13`,
**When** the audit's rule-injection suite runs,
**Then** for **each** rule there is a fixture that the rule's own check rejects, and the check is
invoked **directly** rather than through `validate()`'s ordered cascade. *Only `V6`, `V7` and `V8`
ever reject a candidate that `tryBuild` produced — measured over 15,000 `generate()` calls, with
zero rejections attributed to `V1`, `V2`, `V3`, `V4`, `V5`, `V9`, `V10` or `V11`. Those are
structural tripwires, not filters ([`generation.md` §5](generation.md#5-validity-rules-what-rejects-a-candidate)),
and running them through the cascade means an earlier rule catches the fixture first — which is
why slice 1's blind pass could not make `V5` or `V9` fire from any single-edge mutation of 200
band-3 levels. A tripwire whose check has never been executed against a violation is not a check.*

**AC-245 · The first-decision window clears its floor**
**Given** any generated level at any band,
**When**, for every entry-to-depot path, `L1` is taken as the arc length in LU from the entry node
to the **first branch node** on that path, and
`firstDecisionTicks = ceil(L1 * MLU / speedMluPerTick)`,
**Then** `firstDecisionTicks >= 40` (667 ms) for every path in every level; **and** the minimum
over 1,000 levels per band is exactly the entry-edge transit `54 / 50 / 48 / 45 / 43`, because
`rows[0]` holds one node and 41–89 % of levels branch there.
*This is the window §4.6 never computed. §4.6's 1.00 s is the separation between **two cars** at
one junction; this is the time from **one car appearing** to its first decision, and a car's colour
cannot be known before it spawns, so nothing about it can be prepared
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)).
The floor of 40 ticks is the player model of
[`generation.md` §7.1.3](generation.md#713-constants) priced twice: 22 ticks to read a colour, act
and leave the lockout runway, plus one more acquire of slack because a player who is mid-acquire on
another car cannot start immediately. At `ENTRY_LEN = 100` the measured values were
`34 / 32 / 30 / 28 / 27` — band 5 failed this floor by 13 ticks, on a junction every car in the
level crosses, and the constrained bot emitted zero taps there across 269 levels that had one.*

*This floor is **necessary and not sufficient**, and round 5 had to measure that to find it out. It
prices the decision from the moment the player starts it and says nothing about how long they take
to start — a term that grows with traffic while this one shrinks with speed
([`generation.md` §7.1.7](generation.md#717-the-first-decision-deadline-and-why-the-bot-must-not-be-given-it-for-free)).
With this AC passing at every band the first decision was still being answered wrongly 20.6 % of the
time per car at band 4. [AC-246](acceptance-criteria.md) is the sufficient condition and this AC is
the cheap static check that catches the same defect a generation earlier.*

**AC-246 · The first decision is as reliable as every other decision**
**Given** the constrained bot of [`generation.md` §7.1](generation.md#71-the-constrained-solver-bot)
run over 1,000 seeds per band,
**When** every junction a car actually crosses is classified as that car's **first** decision (the
first branch node on its path, where the two branches differ in which depot colours they reach) or
as a **later** one, and `p_first` and `p_later` are the shares of each class that the car left on a
branch that cannot reach its colour,
**Then** `p_first - p_later <= 0.25 * (2 / quota)` at every band — **3.13 / 1.92 / 1.39 / 1.04 /
0.78** percentage points for bands 1–5 — **and** both figures are reported per band whether or not
the check passes.
*This is the guard [`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)
argues for, and the threshold is derived rather than fitted: a level clears on at most `LIVES - 1`
misroutes in `quota` cars, so `2/quota` is the band's per-car error budget and this allows the one
decision that every car in the level must make to consume a quarter of it more than an ordinary
one. It is stated in `p` and not in a clear rate because `p` is the unamplified quantity — the same
1 pp drift shows up as anywhere between 0 and 60 points of clear rate depending on where the band
sits, which is how an 8 pp gap survived two rounds of measurement while looking like a difficulty
result. Measured under §7.1.5 D3 over 1,000 seeds per band: `-0.39 / -0.20 / +0.04 / +0.00 /
+0.63` pp, passing everywhere, with band 5 at 81 % of its ceiling and therefore the figure to
re-read after any lever pull that moves `quota`. The fault to inject is round 3's shipped sweep —
pure round-robin, no onset capture — which reads `+1.23 / +3.71 / +6.42 / +8.35 / +11.80` pp and
must fail this at bands **2, 3, 4 and 5**. Band 1 passes under the injection and that is correct,
not a weakness in the check: band 1 cleared 96.7 % against 99.5 % across the row-0 bit even with
the defect in force, because at `quota = 16` the per-car budget is 12.5 % and a 1.2 pp gap does not
reach it. The check fails exactly where the defect was.*

**AC-247 · Onset capture is an ordering and nothing more**
**Given** a constrained-bot run at any band,
**Then** over the whole run the count of glances at a car that had never been glanced at before is
exactly the number of cars that spawned; the bot's round-robin `cursor` has the same value after a
capture as before it; a capture sets `busyUntil` to `T + BOT_SCAN_TICKS` exactly as an ordinary
glance does; and total glances per second differ from a pure round-robin run of the same seeds by
less than 2 %.
*Four separate ways for [`generation.md` §7.1.5](generation.md#715-the-per-tick-procedure--normative)
D3 to decay into the free-attention repair that §7.1.8 rejects twice. The capture must fire once
per car and not once per tick; it must not clobber the sweep, which is how one of §7.1.8's variants
starved every older car; it must cost a full glance; and it must come **out of** the attention
budget rather than adding to it. Measured: captures per second `0.38 / 0.43 / 0.50 / 0.55 / 0.62`
against spawn rates `0.385 / 0.435 / 0.500 / 0.556 / 0.625`, and glances per second
`7.19 / 6.39 / 6.00 / 5.41 / 4.90` against a round-robin's `7.19 / 6.47 / 6.08 / 5.47 / 4.93`.*

---

## 300 — Input

**AC-301 · Screen-to-design mapping**
**Given** `scale`, `originX`, `originY` from [`ui.md` §3.2](ui.md#32-mapping-design-space-onto-the-play-area),
**When** a touch at `(sx, sy)` is converted,
**Then** the result is `round((sx - originX)/scale)`, `round((sy - originY)/scale)`.

**AC-302 · Hit radius formula**
**Given** any `scale` and any band,
**Then** `HIT_R_LU === clamp(ceil(22/scale), 76, floor((min(colW,rowH) - 6)/2))`.

**AC-303 · Hit circles never overlap**
**Given** any band and any supported viewport,
**Then** `2 * HIT_R_LU < min(colW, rowH)`, so at most one junction contains any point.

**AC-304 · A tap on empty road is ignored**
**Given** a tap more than `HIT_R_LU` from every junction centre,
**Then** no input is enqueued, no event is emitted, and nothing on screen changes.

**AC-305 · A tap is stamped to the next tick to be simulated**
**Given** a tap received between two `step()` calls where the next is tick `T`,
**Then** the enqueued input is `{tick: T, junctionId}` and it is consumed by that `step()`.

**AC-306 · Two pointers, two inputs, one tick**
**Given** two simultaneous taps on two different junctions within one frame,
**Then** two inputs are enqueued with the same `tick`, and they resolve by ascending junction id.

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
**Then** only `Gesture.Tap()` is registered; there is no pan, swipe, long-press or double-tap
handler.

---

## 400 — Layout

**AC-401 · 44 pt tap targets across the viewport sweep**
**Given** `tools/layout-sweep.mjs` over widths 320–520 pt, heights 560–1200 pt, eight safe-area
inset profiles and all five bands,
**Then** `2 * HIT_R_LU * scale >= 44` in every configuration; the harness reports 0 overflowing
and a minimum of 44.00 pt.

**AC-402 · Car body legibility across the sweep**
**Given** the same sweep,
**Then** `CAR_W * scale >= 20` in every configuration; the minimum is 21.00 pt.

**AC-403 · Scale is uniform**
**Given** any viewport,
**Then** `scale === min(playW/1000, playH/1600)` and the same value is used on both axes.

**AC-404 · Vertical slack split**
**Given** a viewport with vertical slack,
**Then** `originY === playTop + slackY * 0.55` and `originX === (playW - 1000*scale)/2`.

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
**Then** `scale === 0.393`, play height is 695 pt, and the junction target is 59.7 pt.

**AC-409 · Support floor is enforced, not assumed**
**Given** a viewport with `playW < 320` or `playH < 400`,
**Then** the game still renders without crashing, and the layout harness reports it as outside the
declared support envelope rather than as a pass.

**AC-410 · Depots stay inside the design rect**
**Given** any band,
**Then** every depot's `x ± DEPOT_W/2` lies within `[0, 1000]`, with a margin of at least 30 LU.

**AC-411 · The depot row stays inside the design rect vertically**
**Given** any band,
**Then** `DEPOT_Y + DEPOT_H <= DESIGN_H`, and the depot body at its 1.04 **receiving** scale (§7.4)
also lies within `[0, DESIGN_H]`; **and given** the arithmetic sweep of
[AC-401](acceptance-criteria.md)'s device matrix, **then** the clear space between the depot body
and the bottom of the screen is at least **8 pt** on every supported configuration.
*Slice 1b spent this margin deliberately: `DEPOT_Y` moved 1360 → 1420 to buy the 60 LU that
[AC-245](acceptance-criteria.md) needs, taking the clearance below the depot from 70 LU to 10
(`1420 + 170 = 1590` against `DESIGN_H = 1600`, receiving scale reaching 1593.4). It was free
because nothing was drawn there; it is not free twice, and this AC is what makes the next attempt
to spend it fail loudly. The binding device is the iPhone SE 1st generation at 11.0 pt
([`ui.md` §3.3](ui.md#33-measured-fit-across-real-devices)).*

---

## 500 — Visual

**AC-501 · Draw order**
**Given** a rendered frame,
**Then** elements are painted in the order of [`ui.md` §4.2](ui.md#42-draw-order); a car is never
occluded by a junction marker, by the road, by another car's shadow or by anything outside the
depot layer; and a car **is** occluded by the depot-mouth apron and the depot body, which are the
two things painted after it ([`ui.md` §7.6](ui.md#76-the-depot-mouth)).

**AC-502 · The car body is one colour fill**
**Given** a rendered car,
**Then** its body is a single rounded rectangle filled with one palette colour; the windscreen and
glyph are drawn over it and together cover less than 35 % of its area.

**AC-503 · Car fits the road**
**Given** any band,
**Then** `CAR_W (84) < ROAD_W (104)`, and two roads in adjacent columns are separated by at least
`colW - ROAD_W = 91` LU at the narrowest band.

**AC-504 · The blade shows the open branch**
**Given** a junction with `open === k`,
**Then** its blade is rotated to lie along `out[k]`, and the first 150 LU of that edge is drawn
brighter than the closed branch.

**AC-505 · In-canvas animation is replay-deterministic**
**Given** a recorded run replayed at a fixed frame rate,
**When** frames are captured at the same ticks as the live run,
**Then** the screenshots are identical, because every play-surface animation derives its phase
from `currentTick - eventTick`.

**AC-506 · Commit preview arms at 260 LU**
**Given** a car whose remaining distance to junction `J` is ≤ `COMMIT_PREVIEW = 260` LU,
**Then** `J` draws the lead-highlight arc along its open branch; above 260 LU it does not.

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

**AC-513 · The depot mouth covers the convergence zone**
**Given** any band and the `mouthLu` table of [`ui.md` §7.6](ui.md#76-the-depot-mouth),
**When** every pair of positions on two terminal edges feeding the same depot is swept at 2 LU
resolution with both car centres outside the apron,
**Then** the minimum centre-to-centre distance is at least **91 LU**, the worst overlap of the two
car bodies is at most **11 %** of a body, and diagonal-vs-opposite-diagonal pairs overlap by
**0 %** — and in a seeded run of 1,000 levels per band, every pair of cars that comes within
`CAR_L = 140` LU on converging terminal edges has both centres inside the apron.

**AC-514 · The mouth never reaches a junction marker**
**Given** the band table,
**Then** `mouthLu <= rowH - JUNCTION_MARK_R - 12` for every band (tightest: band 5, 140 ≤ 142),
and `MOUTH_W = 176 >= sqrt(CAR_L² + CAR_W²) = 163.3`, so no corner of a car at any heading
protrudes from the side of the apron.

**AC-515 · A misroute is legible from under the depot**
**Given** a `misrouted` event,
**Then** the shatter fragments originate at the mouth line of the terminal edge the car came down
— not at the depot node — are filled with the **car's** colour, and are drawn over the apron and
the depot body; and the rejecting depot desaturates over the same 350 ms
([`ui.md` §8.4](ui.md#84-car-misrouted)).

**AC-516 · The apron does not stack alpha**
**Given** a depot fed by two or three terminal edges,
**When** the frame is sampled inside the overlap of two apron fade segments,
**Then** the sampled colour equals the colour of a single fade segment at the same alpha —
the fades are composited in one `saveLayer` and the cores are one filled path
([`ui.md` §7.6](ui.md#76-the-depot-mouth)).

**AC-517 · A car's arrival is an abrupt onset**
**Given** the frame on which a car spawns and the frames after it,
**Then** the car body, its glyph and its stroke are drawn at **full** opacity and full scale on the
first frame the car exists, with no fade, ramp or scale-up applied to the car at any point on the
entry edge; and the entry flare of [`ui.md` §7.5](ui.md#75-car) is drawn beneath the car layer and
carries none of the car's colour.
*The player model this design's targets are read off asserts that a newly appeared car is looked at
**next** rather than last, and that is the only reason the first junction decision is reachable
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision),
§8.10, [AC-246](acceptance-criteria.md)). Attention is captured by an abrupt luminance transient and
a gradual onset of the same magnitude does not capture it, so a fade-in would make the drawing
falsify the design's own claim about the player — silently, and in the one place it could not be
detected from a clear rate. The 140 ms fade-in specified through slice 1b was also spending 40 of
the entry edge's 160 LU making the colour unreadable inside the only window in which that car's
colour can be read.*

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
**Given** a car on a diagonal edge,
**Then** its glyph is rotated 0° relative to the screen while its body is rotated to the road
tangent.

**AC-604 · Symbol size setting**
**Given** Symbol size = Large,
**Then** `GLYPH_CAR` is 66 LU, `GLYPH_DEPOT` is 88 LU and car-glyph opacity is 100 %; at Standard
they are 48 LU, 64 LU and 78 %.

**AC-605 · Reduce motion preserves information**
**Given** Reduce motion = On,
**Then** the shatter, vignette flash, panel spring, last-life pulse and score count-up are
replaced by their static or 120 ms-fade equivalents, and every state in
[`ui.md` §8](ui.md#8-screen-states) is still distinguishable from every other.

**AC-606 · Contrast floors**
**Given** the theme,
**Then** every text token is ≥ 4.5 : 1 against every surface it is used on, and every car colour
is ≥ 3.0 : 1 against `--road` (measured minimum 4.21 : 1).

**AC-607 · Screen-reader scope is what is claimed**
**Given** VoiceOver enabled,
**Then** every menu, overlay and settings control is labelled and operable, and the play surface
is exposed as a single element whose label updates on delivery, misroute and level end with the
level number, delivered count, quota and lives. Per-car announcement is explicitly out of scope.

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
**Given** level `N` cleared for the first time,
**Then** level `N+1` becomes available and no later level does.

**AC-704 · Retry replays the same level**
**Given** a level and its seed,
**When** Retry is chosen,
**Then** the regenerated network, depot colours and spawn schedule are deeply equal to the
previous attempt's.

**AC-705 · Persistence fields**
**Given** a cleared level,
**Then** cleared-flag, best score, best streak and fewest misroutes are stored, and survive an app
restart.

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
**Then** `phase` becomes `'lost'` at the terminal check of that same tick, and no car resolves on
any **later** tick. Cars arriving in the **same** tick still resolve and are still counted
(AC-122, AC-136) — the terminal check is step 5 and runs once, after step 4 has resolved every
arrival. *Slice 0's wording said "no further car resolves", which read as an abort in the middle
of step 4 and contradicted AC-122.*

**AC-802 · Quota and misroute on the same tick is a win**
See AC-122; this is the on-device expression of it — the level-complete overlay is shown, not the
failure overlay.

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
[`gameplay.md` §2.1](gameplay.md#21-tick-rate),
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
`8 * speed` LU.

**AC-807 · Generator exhaustion throws**
**Given** a deliberately impossible band configuration injected into the band table,
**Then** `generate()` throws `GEN_EXHAUSTED` with the band and seed in the message, and
`tools/generator-audit.mjs` reports a failure rather than a pass.

**AC-808 · Spawn exhaustion is asserted, not tolerated**
**Given** a run artificially forced past `spawns.length`,
**Then** the engine throws rather than spawning nothing and silently stalling.

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
**Given** a band-1 level (`J = 3`, `D = 2`),
**Then** the constrained bot clears it, and every one of its three colours requires at least one
flip in at least one spawn sequence over 1,000 seeds — i.e. no level is won by never tapping.

**AC-814 · No level is won by never tapping**
**Given** 1,000 seeds per band and a bot that never taps,
**Then** the clear rate is 0 % at every band.

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
