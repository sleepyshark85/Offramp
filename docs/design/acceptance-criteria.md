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
**When** the simulation reaches tick `t`,
**Then** exactly one car appears with `id === i`, `colour === c`, `edgeId === level.entryEdgeId`
and `progress === 0`.

**AC-113 · The spawn schedule is a pure function of the seed**
**Given** the same `(seed, band)`,
**When** the level is generated twice in separate processes,
**Then** the two `level.spawns` arrays are deeply equal.

**AC-114 · Spawn ticks strictly increase**
**Given** any generated level at any band,
**When** `level.spawns` is inspected,
**Then** `spawns[i+1].tick > spawns[i].tick` for every `i`, and the minimum gap over 1,000 seeds
per band is at least `interval - 2*jitter` ticks.

**AC-115 · Colour bag prevents runs of three**
**Given** the spawn colour sequence of any generated level,
**When** it is scanned,
**Then** no three consecutive entries share a colour, and over 1,000 seeds the per-colour counts
differ by at most `K` across the whole sequence.

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
**Then** `state.nextSpawn < level.spawns.length` in every run.

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
**Then** the two sets differ.

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
**Then** every node's `x` and `y`, and every edge's `lengthMlu`, satisfy `Number.isInteger`.

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

**AC-241 · A lever pull satisfies both targets or is not a lever pull**
**Given** any proposed change to a band's `quota`, `interval`, `pBranch` or `K` under
[`generation.md` §7.4](generation.md#74-when-a-target-is-missed),
**When** the change is applied,
**Then** AC-221 – AC-231 are **all** re-run and all pass. A change that moves a clear rate into
band while moving a completion-time median out of band has not been applied; it has been
proposed and rejected.

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
*Slice 0 asserted a 0.33 ms remainder, which is arithmetically false.* The divide-first form
`Math.floor(acc / (1000 / TICK_HZ))` returns **2** here, because `1000 / 60` is
`16.666666666666668` in IEEE 754; see AC-816.

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
*This is the companion to AC-805: AC-805 pins the zero-remainder case and this pins a non-zero
one, so a build that drops the remainder entirely passes neither.*

**AC-816 · The divide-first form is proven to fail AC-805**
**Given** the React layer's tick conversion temporarily replaced by
`n = Math.floor(acc / (1000 / TICK_HZ))`,
**When** AC-805 is run,
**Then** it **fails**, reporting `n === 2` against the required 3; and it passes again once the
integer-first form is restored. *`docs/development-process.md:136` — a check that cannot fail is
not a check, and this is the specific fault AC-805 exists to catch.*
