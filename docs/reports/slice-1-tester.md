# Slice 1 — tester report

Branch `slice-1-engine`. Everything below was produced by running code, not by reading it,
except where a finding is explicitly labelled **suspected by reading**.

Written blind first: the eleven harnesses in
`/tmp/claude-1000/-home-agentadmin-sources-tot/3ab64bef-d65a-4358-96ae-b02e313dccfb/scratchpad/h/`
were written from `docs/design/acceptance-criteria.md`, `gameplay.md` and `generation.md`
before `test/` was opened. `src/engine/` was read first, because the harnesses have to call
it. `test/` was read afterwards, to find what neither pass covered — §5.

**Every harness was proven to fail before it was trusted.** Nine faulty copies of
`src/engine/step.js` were built in the scratchpad and the harnesses were run against them.
`src/`, `test/` and `tools/` were not modified. Nothing was committed.

| Fault injected into a scratchpad copy of `step.js` | Caught by | Result |
|---|---|---|
| A — junction read uses `open` from *before* this tick's inputs | H1 | 1,800 failures |
| B — a car re-routes when the junction behind it flips | H1 | 44,733 failures |
| C — transition drops the remainder (`progress = 0`) | H3 | AC-106 fires at band 1 seed 1 tick 134 |
| D — misroute subtracts 5 from the score | H3 | AC-120 fires |
| E — `lives -= 1` unclamped | H4 | AC-121 fires (`lives = -1`); **H3's 400k-tick fuzz did not reach it** |
| F — tick advances by 2 when >3 cars are in flight | H3 | AC-102, AC-126, AC-124 fire |
| G — terminal check tests `lives` before `quota` | H4 | AC-122 fires (`lost` instead of `won`) |
| H — no level-clear bonus | H4 | AC-132 fires |
| I — in-flight cars discarded at level end | H4 | AC-133 fires |

Fault E is worth calling out: the developer's fuzz and mine both miss it, because two misroutes
on one tick with one life is not something a random tap stream reaches. It needs the constructed
fixture in H4. That is the argument for hand-built edge fixtures over more fuzz ticks.

---

## 1. Findings, ranked by what a player would notice

### F1 · `SPAWN_EXHAUSTED` can crash a live game, and the real margin at band 5 is one car — **confirmed by execution**

`src/engine/step.js:140-144` throws the moment `nextSpawn` *reaches* `spawns.length`, i.e.
immediately after the last scheduled car is pushed. The usable schedule is therefore
`quota + 7`, not the `quota + 8` that `gameplay.md` §2.7 and §8.4 advertise.

Measured with an oracle router (perfect routing, unlimited taps) plus the two misroutes a
winning run is allowed, 5,000 seeds per band, plus variants that always take the longest
correct route and that place the two misroutes early, mid and late:

| Band | schedule length | worst `nextSpawn` observed | headroom | worst seed |
|---|---|---|---|---|
| 1 | 24 | 21 | 3 | 2 |
| 2 | 34 | 32 | 2 | 2 |
| 3 | 44 | 42 | 2 | 1 |
| 4 | 56 | 54 | 2 | 1 |
| 5 | **72** | **71** | **1** | **160** |

Band 5 headroom distribution over 5,000 seeds (2 misroutes, oracle routing):
`headroom 1: 30 seeds, 2: 3,953, 3: 1,017`. No crash was reproduced — but the margin is one
spawn interval, 96 ticks, 1.6 s.

The design's justification is incomplete rather than wrong: §8.4 reasons "at most `quota + 2`
cars ever need to resolve. Eight is slack", and omits the cars still in flight — about 4.4 at
band 5. `64 + 2 + 4.4 ≈ 70.4` against a usable 71.

Why this is a finding and not a curiosity:

- It is an uncaught `throw` out of `step()`. In slice 2 that is a hard crash in the middle of a
  level, at the hardest band, for a player who is doing well.
- `generation.md` §7.4's normative lever for "clear rate too high" is *increase quota, then
  reduce interval*. Both move band 5 straight through the margin.
- Anything that lengthens transit — a deeper band, a slower speed, a longer `diagLen` — does the
  same.
- Changing the guard to `>` rather than `>=` would buy back the eighth car at no cost.

AC-123 states the right property (`state.nextSpawn < level.spawns.length` in every run) but the
only test of it (`test/engine.test.js`, "AC-123 · the spawn array carries quota + 8") asserts
`level.spawns.length === level.quota + SPAWN_SLACK` and never runs a level to its end. That
clause is untested.

### F2 · One `NaN` frame delta freezes the game permanently — **confirmed by execution**

`src/engine/clock.js:22-28`. `advanceClock(acc, NaN)` returns `{ticks: NaN, accTicks: NaN}`;
`Math.floor(NaN)` is `NaN`, and neither the `< 0` nor the `> MAX_CATCHUP_TICKS` guard catches it.
The accumulator is `NaN` from then on, so every later frame also returns `NaN` ticks and the
caller's `for (i = 0; i < ticks; i++)` never runs again.

```
deltas   [16.7, 16.7, NaN, 16.7, 16.7, 16.7, 16.7]
ticks    [   1,    1, NaN, NaN,  NaN,  NaN,  NaN]   accumulator: NaN
```

A single uninitialised `lastFrameTime` (`now - undefined`) produces exactly this. `Infinity` is
handled correctly (→ 8 ticks, accumulator 0). A negative delta returns `{0, 0}`, which also
discards a legitimately positive accumulator — minor, `clock.js:25`.

No AC covers a non-finite or negative delta. AC-127/AC-805/AC-815 all assume a sane number.

### F3 · AC-816 — newly added — is arithmetically false, and so is AC-805's parenthetical — **confirmed by execution**

`docs/design/acceptance-criteria.md:825-831` requires that replacing the tick conversion with
`Math.floor(acc / (1000 / TICK_HZ))` makes AC-805 **fail**, "reporting `n === 2` against the
required 3".

It does not. `Math.floor(50 / (1000/60)) === 3`, bit-exactly:

```
1000/60           = 16.666666666666667851   (0x4029555555555556)
50 / (1000/60)    =  3.0000000000000000000  (0x4008000000000000)  -> floor 3
50 * 60 / 1000    =  3                                            -> floor 3
```

Verified in Node v24.18.0 and cross-checked in CPython, which uses the same IEEE-754 doubles.
AC-805's parenthetical at `:773-775` ("returns **2** here") is wrong for the same reason, and
`docs/reports/slice-1-orchestrator-verification.md` repeats it.

The two forms *do* differ, just not at 50 ms. Over integer millisecond deltas in 1…2000 they
disagree 15 times; the first is **250 ms** (15 ticks vs 14). And because `MAX_CATCHUP_TICKS = 8`
clamps everything at or above 133.34 ms, **for integer-millisecond deltas the two forms are
indistinguishable everywhere inside the uncapped range.** AC-816 as written is a check that
cannot pass, added specifically to enforce the rule that a check must be able to fail.

The shipped implementation (`clock.js:23`, integer-first) is correct. AC-816 simply does not
prove it. If the designer wants a falsifying case, 250 ms is one.

### F4 · `test/fuzz.test.js`'s AC-124 assertion is skipped at bands 3, 4 and 5 — **confirmed by execution**

`test/fuzz.test.js:71` uses one seed per band, `generate(band * 101, band)`, and `:81` guards the
separation assertion with `if (observedMin !== Infinity)`. On those exact seeds, with that exact
tap pattern:

| band | seed | ticks where two cars shared an edge |
|---|---|---|
| 1 | 101 | 57 — min 429 LU |
| 2 | 202 | 12 — min 374 LU |
| 3 | 303 | **0 — assertion skipped** |
| 4 | 404 | **0 — assertion skipped** |
| 5 | 505 | **0 — assertion skipped** |

This is incident §6.2's shape: three of five bands assert nothing and report green.

**AC-124 itself holds.** Over 50 seeds per band the minimum shared-edge separation is
408 / 371 / 299 / 306 / 258 LU against floors of 396 / 365 / 286 / 259 / 228 LU and
`CAR_L = 140`. Cars share an edge on 10.7 / 0.9 / 4.3 / 0.1 / 0.2 % of ticks, so the event is
rare enough at bands 4 and 5 that a single seed is not a sample.

### F5 · No guard keeps the band table's geometry integral, and the determinism contract rests on it — **confirmed by injection**

`src/engine/generate.js:30-35` computes `colW = LANE_SPAN / (C - 1)` and `rowH = 1200 / R` by
division. Nothing in `finalise()` or `validate()` asserts the result is an integer; the
integrality of every shipped band is a property of the five rows that happen to be in the table.

Injecting a band with `R = 7` (`rowH = 171.428…`), everything else band-2-like:

- `generate()` returns a level — no rule rejects it.
- 18 nodes have a non-integer `y`; 17 edges have a non-integer `lengthMlu` (e.g. `171428.57142857142`).
- At tick 683, car 0 holds `progress = 1371.4285714285797` — a float inside the simulation,
  which is the one thing `gameplay.md` §2.2 exists to prevent.

AC-103 and AC-218 are only exercised over the five shipped bands, so the first band-table edit
that picks a non-divisor of 780 or 1200 breaks determinism silently rather than loudly. `V13:
colW, rowH and every lengthMlu are integers` would cost two lines and would fail the moment it
mattered.

### F6 · The generator's advertised junction count overstates how many junctions carry a decision — **confirmed by execution**

Measured over 3,000 seeds per band with a *lazy* optimal router — one that taps only when the
junction's current setting would misroute the arriving car, which is what a perfect player does:

| Band | mean `J` | junctions never tapped in a whole run | levels whose live-junction count is well below `J` |
|---|---|---|---|
| 1 | 3.00 | 0.7 % | 54 / 3000 play as `J = 2` (e.g. seed 76: J=3, live=2) |
| 2 | 4.27 | **18.6 %** | 6 / 3000 play as `J = 2` (seed 986: J=5, live=2) |
| 3 | 5.21 | 11.8 % | 269 / 3000 at live=3 (seed 50: J=5, live=3) |
| 4 | 6.47 | **18.2 %** | 62 / 3000 at live=3 (seed 332: J=6, live=3) |
| 5 | 7.70 | 12.5 % | 181 / 3000 at live=5 (seed 4: J=7, live=5) |

The mechanism: **V6 only requires the two branches' reachable-colour sets to differ.** Where one
set strictly *contains* the other, the superset branch serves every colour the subset branch
does, so optimal play never has to leave the default. Rate of strict-superset junctions:

| Band | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| strict-superset junctions | 0.0 % | **29.7 %** | 13.8 % | **26.7 %** | 14.0 % |

(Zero of 39,975 junctions had *equal* masks, so V6 is doing what it says — it is just weaker
than "this junction is a decision".)

No AC and no validity rule measures this. V7/AC-211 counts drawn junctions, and a drawn junction
that never needs a tap is difficulty the band is credited with and does not deliver. If the
designer wants a rule, "neither branch's reachable-colour set contains the other's" is the
strengthening of V6 that produces it.

**The generator is not degenerate in the other ways I looked for**, all over 1,500–3,000 seeds
per band:

- 0 junctions that no car ever crosses under optimal play.
- 0 levels whose spawn stream omits one of its `K` colours.
- 0 levels won without a single tap (AC-814), at every band. This is structural: with a fixed
  `open` vector every car follows one path into one depot, so a static configuration can never
  deliver more than one colour.
- 0 runs of three identical consecutive spawn colours (AC-115 first clause).

### F7 · `JSON.stringify(state)` does not round-trip, and the failure mode is a crash — **confirmed by execution**

`state.open` is a `Uint8Array`. `JSON.stringify` renders it as `{"0":0,"1":0,…}`, not an array.
On rehydration `cloneState`'s `Uint8Array.from(thatObject)` yields a **zero-length** array, so
`next.open[node.junctionId]` is `undefined`, `node.out[undefined]` is `undefined`, and the next
transition throws `TypeError: Cannot read properties of undefined (reading 'lengthMlu')`.

AC-219 covers the *level* round trip, which passes. Nothing covers the *state*. This matters for
slice 4 persistence, for any mid-run save, and for the serialized frame snapshot that
`development-process.md` §4 says tier 3 will assert against on `window.__offramp`.

A state saved as `{...s, open: Array.from(s.open)}` and restored as
`{...saved, open: Uint8Array.from(saved.open)}` resumes to a deeply equal final state — verified
by resuming at tick 200 of a 6,000-tick run and comparing.

### F8 · `state.rng` is a dead field, and AC-125's "including `rng`" cannot fail — **confirmed by execution**

Over a 5,000-tick band-3 run with taps, `state.rng` takes exactly one distinct value, equal to
`mix32(level.seed, SPAWN_SALT)`. Correct given that §2.7 materialises the whole spawn schedule at
build time — but `gameplay.md` §2.4 documents the field as "spawn stream PRNG state (§2.7)",
AC-125 lists it among the things a replay must reproduce, and
`test/determinism.test.js`'s `fingerprint()` serialises it. All three treat a constant as
evidence. Either advance it or delete it; keeping it invites a future reader to believe the
spawn stream is live.

### F9 · `test/engine.test.js:368`'s AC-810 assertion compares an object with itself — **confirmed by reading and by execution**

`step()` returns the *same reference* when `phase !== 'running'` (`src/engine/step.js:122`), so
`assert.deepEqual(again, done)` is `deepEqual(x, x)`. The behaviour is correct — I verified it
separately by snapshotting through JSON before and after, and by confirming the level-clear bonus
is not applied twice — but the check is structurally incapable of failing.

Related, low: the terminal state still carries the previous tick's `events` (observed
`["misrouted@1194"]` on a `lost` state), and `step()` on it returns them unchanged forever. Today
that is harmless; a renderer that keys animations off `events` will want to know.

### F10 · AC-115's second clause is ambiguous and the test matches neither reading — **confirmed by execution**

"over 1,000 seeds the per-colour counts differ by at most `K` across the whole sequence".

| Band | K | worst per-level spread | aggregate spread over 1,000 seeds |
|---|---|---|---|
| 1 | 3 | 0 | 0 |
| 2 | 3 | 1 | **34** |
| 3 | 4 | 0 | 0 |
| 4 | 4 | 0 | 0 |
| 5 | 5 | 1 | **43** |

Per-level reading: passes comfortably. Aggregate reading: fails at bands 2 and 5, and *must* —
those are the two bands where `quota + 8` is not a multiple of `K` (34/3, 72/5), so the leftover
bag entry is a fresh uniform draw and the spread over 1,000 seeds is ordinary multinomial noise
(σ ≈ 15 for band 2). There is no bias to fix; the AC is unachievable under that reading.

The implemented test (`test/engine.test.js:170`) asserts neither: `spread <= total * 0.02` over
300 aggregated seeds, which at band 1 is a tolerance of about 144 against the AC's stated 3.

### F11 · `validate()`'s V5 and V9 have never been shown to fire — **confirmed by search**

Rules are checked in `generation.md` §5 order and the earlier ones subsume the later. I enumerated
every single-edge retarget of 200 band-3 levels — tens of thousands of mutations — and found **no**
mutation for which `validate()` returns `V5` or `V9`. An unreachable depot trips V1; a duplicated
lattice site trips V2. The developer's injection test (`test/generator.test.js`, "validate()
catches an injected violation of each rule it owns") isolates V1, V6, V7, V8 and V10, and accepts
a *set* of answers for the V3/V4 cases.

Defensive rules are legitimate. They should be labelled unreachable rather than presented as
checks, or the checking order should be inverted for the test so each one can be seen to fire.
My own injections that *did* fire cleanly: V6 (two depots sharing a colour → `V6`), V11
(coincident junction centres → `V11`), V10.

### F12 · The initial junction configuration is unspecified — **confirmed by execution, no AC covers it**

`createState` allocates `new Uint8Array(level.junctions.length)`, all zeros, and `out[0]` is
always the smaller column. So every level starts with every junction pointing left, and with no
taps every car lands in the leftmost reachable depot — 2,000 / 2,000 levels at bands 1, 3 and 5
sent car 0 to depot column 0; bands 2 and 4 to column 0 or 1 (68 % / 76 % column 0).

Nothing in `gameplay.md` §2.4, §2.7 or the ACs states what `open` starts as. It is observable,
replay-relevant and currently owned by an implicit `Uint8Array` default. Worth one sentence in
§2.4 and an AC, whichever value the designer wants.

### F13 · `tools/layout-sweep.mjs` does not exist — **confirmed**

`docs/development-process.md` §9 lists it among the checks that "must be clean before a slice
ships". Slice 1 is engine-only so nothing is blocked, but the §9 list is not runnable end to end
today and a reader will assume it is.

---

## 2. The junction read-timing rule — clean

`gameplay.md` §3 is the rule the process document calls the one most likely to be got subtly
wrong. It is not wrong. **H1**, over 900 real junction transitions (5 bands × 30 seeds × up to 6
transitions per seed, 17,748 assertions, all passing):

For each transition of car *c* through junction *J* at tick *T*, taken from a no-tap baseline:

| Probe | Requirement | Result |
|---|---|---|
| flip at tick `T` | the car takes the **other** branch (AC-109, §3.2) | 900 / 900 |
| flip at tick `T-1` | the car takes the other branch (AC-310) | 900 / 900 |
| flip at tick `T+1` | the car's edge sequence **and** its arrival depot are bit-identical to baseline (AC-108, AC-311) | 900 / 900 |
| flip `J` on **every** tick from `T+1` to `T+400` | same (a car that has crossed never re-routes) | 900 / 900 |
| every branch transition, in all 4,500 probe runs | the edge taken is exactly `node.out[open after this tick's inputs]` (AC-107) | no violation (17,748 assertions total across the five probes) |

Both directions are proven to be checkable: fault A (read `open` from before the inputs) produces
1,800 failures; fault B (re-route when the junction behind the car flips) produces 44,733.

`src/engine/step.js:164` is the single expression the rule lives in, and step 2 (`:129-131`)
precedes step 4, so §3.2's player-favourable reading holds structurally, not by test.

---

## 3. Determinism — attacked, held

`src/engine/step.js:122-185` is a pure function of `(state, inputs)`. Everything below is from
**H2** (3,212 assertions) and **H3**.

| Attack | Result |
|---|---|
| Same `(seed, band, inputs)` replayed twice in one process, 5 bands × 5 seeds including `0xdeadbeef` and `2^31`, 12,000 ticks each | deeply equal (AC-125) |
| Same run replayed in a **fresh process** (`execFileSync`), 3 bands × 3 seeds | deeply equal (AC-811, x86↔x86 only) |
| Same-tick inputs supplied in **reversed array order** | deeply equal (AC-110) |
| Level driven after a `JSON.parse(JSON.stringify(level))` round trip — catches any dependence on object identity or on a typed array | deeply equal (AC-219) |
| `step()` called twice on the same state object, every tick of a 3,000-tick run | identical results; input state byte-identical afterwards; `inputs` array unmutated; `level` reference preserved |
| `generate(777, 5)` before and after 300 unrelated `generate()` calls | deeply equal — no cross-call memory despite module-level `GEN_STATS` |
| Spawn schedule after forcing a different band/seed through the generator stream first, 5 bands × 4 seeds | unchanged (AC-134) |
| Every numeric field of state and of every car, 1.2 M fuzz ticks | `Number.isInteger` everywhere (AC-103) |
| Mid-run state serialised and resumed at tick 200 of a 6,000-tick run | deeply equal — *provided* `open` is rebuilt as a `Uint8Array`; see F7 |
| `state.rng` | constant for the whole run; see F8 |

Float hunting: the only divisions in `src/engine/` are `colWFor`, `rowHFor` and `xOf` in
`generate.js:30-41`, all exact for the five shipped bands — and unguarded for any sixth (F5).
`clock.js` is the only module that touches a fraction, and it is outside the engine's tick
arithmetic by design. No key-insertion-order iteration exists: `open` is a `Uint8Array`, cars are
an array in ascending id order, junctions are indexed by integer. The one order-dependent
construct, `inputs.slice().sort((a,b) => a.junctionId - b.junctionId)` at `step.js:130`, relies on
`Array.prototype.sort` stability, which ES2019 requires; and since ties are two toggles of the
same junction, order is unobservable anyway (verified: AC-111 and the reversed-order replay).

---

## 4. Invariant fuzzing and the edges

### 4.1 Fuzz — 1,200,312 ticks, 1,299 runs, 0 violations

**H3.** 1,299 level runs spread over five bands and six tap modes, asserting my own invariant
set after **every** step:

| Tap mode | What it does |
|---|---|
| `none` | never taps |
| `all` | taps **every** junction on **every** tick |
| `dup` | two taps on the **same** junction in one tick |
| `dup3` | three taps on the same junction in one tick |
| `burst` | 0…J taps on random junctions in one tick |
| `random` | one tap on a random junction, 25 % of ticks |

Asserted after each step: tick +1 exactly (AC-102); every numeric field integral (AC-103); every
car on exactly one existing edge with `0 <= progress < lengthMlu` (AC-104); a non-transitioning
car advanced by exactly `speedMluPerTick` (AC-105); a transitioning car carries the exact
remainder **and** lands on an out-edge of the node it just crossed (AC-106); spawns match
`level.spawns[i]` in tick, colour and starting edge, and no id spawns twice (AC-112, AC-130);
score integral, non-negative, non-decreasing (AC-120); lives non-increasing, never below 0
(AC-121); `cars.length === nextSpawn - delivered - misrouted` (AC-131); `open[j] ∈ {0,1}`;
every event stamped with this tick (AC-126); shared-edge separation above the band floor
(AC-124); and the transition loop single-pass per car-tick (AC-118).

Zero violations. Faults C, D and F are caught by this harness.

### 4.2 Edges — hand-built fixtures, 29 assertions

**H4** builds a two-depot level whose branch lengths differ by exactly 100 ticks of travel, so
two cars spawned 100 ticks apart arrive at **different depots on the same tick**, on demand.

| Case | Result |
|---|---|
| two deliveries on one tick | both resolve; `delivered = 2`, streak 2, score `100 + 110` |
| two misroutes on one tick | both resolve; `misrouted = 2`, `lives = 1`, score 0 |
| two misroutes on one tick with **`lives === 1`** | `misrouted = 2`, `lives = 0` (not −1), score unchanged, two `misrouted` events in ascending car id order, `phase = 'lost'` — **AC-136 and the revised AC-801 confirmed exactly as newly written** |
| quota-completing delivery **and** a misroute taking the last life, same tick | `phase = 'won'`, `lives = 0`, clear bonus `50 × 0 = 0` — AC-122 / AC-802 |
| quota reached with 3 cars in flight | `won`; the 3 cars stay in `state.cars`, score nothing, cost nothing (AC-133); clear bonus `50 × 3` (AC-132) |
| `step()` after terminal | state deeply equal, bonus not re-applied on repeated calls (AC-810) |
| quota of 1 | wins on the arrival tick; score `100 + 150` |
| `step(s, [])`, `step(s, undefined)`, `step(s, null)` | all advance one tick, no junction changes (AC-809) |
| two taps / three taps on one junction in one tick | net no change / net flipped; two and three `flip` events (AC-111) |
| hostile `junctionId`: `-1`, out-of-range, `1.5`, `NaN`, `undefined`, `null`, `'0'`, `{}` | **all throw `BAD_JUNCTION`** (`step.js:73-76`) |

That last row is behaviour, not a defect — but it is worth the React layer's attention. `step()`
throws on a malformed input rather than ignoring it, including for the string `'0'`, which is a
valid index. No AC covers what `step()` does with a bad input; AC-304 assigns the filtering to the
UI. The purity of `step()` means the caller's state survives the throw, so this is recoverable —
if someone catches it.

Smallest and largest band configurations (band 1, `C=3 R=3 J=3 quota=16`; band 5,
`C=5 R=6 J=7–8 quota=64`) are covered by every sweep above; band 1 also by the quota-of-1 and
minimum-junction fixtures.

---

## 5. What neither pass covered, and what I closed

Read `test/` after writing mine. The developer's suite is thorough and its fixtures are better
than mine for several ACs (`twoDepotLevel` is a good design; `AC-104`'s
`Object.keys(car).length === 4` catches a class of bug I did not think to check for). Gaps:

| Gap | Status |
|---|---|
| AC-234 network variety | no `test/` coverage; asserted only in `tools/generator-audit.mjs` at ≥3,000 seeds. **Closed by me:** distinct signatures over 3,000 seeds = 190 / 1,867 / 1,981 / 2,773 / 2,507 against floors 30 / 500 / 500 / 500 / 500. Passes. |
| AC-123's "`nextSpawn < spawns.length` in every run" | untested. **Closed by me:** passes, but with a margin of 1 at band 5 — F1. |
| AC-124 at bands 3–5 | vacuous — F4. **Closed by me** over 50 seeds/band. |
| AC-115's colour-balance clause | tested against a third criterion — F10. |
| State serialisation | untested anywhere — F7. |
| Non-finite / negative frame deltas | untested anywhere — F2. |
| Hostile `junctionId` values | untested anywhere — §4.2. |
| Band-table integrality | untested anywhere — F5. |
| Junction *actionability* (as opposed to count) | unmeasured anywhere — F6. |
| `validate()` V5, V9 firing | not isolated — F11. |
| AC-137 (phase constant through step 4) | new; no test yet. Verified indirectly: `phase` is written only at `step.js:176-180`, after the advance loop, and the conservation invariant `cars === spawned − delivered − misrouted` held over 1.2 M ticks, so no arrival is ever skipped. Plus the AC-136 fixture. |
| AC-815 | new; no test yet. **Closed by me:** `advanceClock(0, 55)` → 3 ticks holding 5.000000 ms; the following 12 ms frame → exactly 1 tick. Passes. |
| AC-816 | new; **fails as written** — F3. |

---

## 6. Numbers the designer can use, measured without the constrained bot

Per the brief I did not touch `tools/bot.mjs`'s clear rate. But two of the quantities the bot was
meant to supply do not depend on its policy at all, because they are properties of the *level*:
the **minimum** tap load and the **minimum** duration under perfect play. Both are hard floors
under whatever the revised bot produces.

Lazy optimal router, 1,200–3,000 seeds per band:

| Band | taps per level | **taps/s (floor)** | §6.3 estimate | duration (s) | §5.3 nominal | §7.3 band |
|---|---|---|---|---|---|---|
| 1 | 19.0 | **0.39** | 0.38 | 48.7 | 49.1 | 42–62 ✓ |
| 2 | 30.6 | **0.46** | 0.54 | 67.1 | 67.0 | 58–78 ✓ |
| 3 | 49.9 | **0.63** | 0.68 | 79.1 | 79.0 | 70–92 ✓ |
| 4 | 65.8 | **0.71** | 0.89 | 93.2 | 92.9 | 84–106 ✓ |
| 5 | 96.2 | **0.88** | 1.03 | 109.1 | 108.8 | 98–122 ✓ |

Two things follow. First, `gameplay.md` §5.3's nominal durations are confirmed by execution to
within 0.5 s at every band, and the oracle's duration is the floor of the completion-time
distribution, so AC-226–AC-230's lower bounds are reachable. Second, `generation.md` §6.3's
estimate overstates the true tap load at bands 2–5 by 15–20 %, which is the direction it says it
should ("overstates the true rate because consecutive same-colour cars inherit a correct
junction") — band 5's floor is 0.88 taps/s against the 1.03 estimate and AC-233's 1.25 ceiling.

Other measurements reproduced independently:

- **AC-203** attempts, 1,500 seeds/band: median 5 / 3 / 2 / 2 / 2, p95 19 / 11 / 6 / 7 / 7, max
  45 / 27 / 13 / 17 / 16. Design says median ≤ 8, max ≤ 128, and §6.2's measured medians are
  5 / 3 / 2 / 2 / 2. Agrees.
- **AC-211** junction distribution, 3,000 seeds/band, worst deviation from §6.2's table
  **1.8 pp** (band 3), tolerance 5 pp. Agrees.
- **AC-114** minimum spawn gap **equals** `interval − 2·jitter` exactly at every band
  (132 / 114 / 84 / 72 / 60). The bound is attained, not slack — which is also why
  `generation.md` §7.4's "`interval` must never fall below `2·jitter + 60`" is load-bearing.
- **AC-210** equal-mask junctions: 0 of 39,975. **AC-214** lattice-site violations: 0.
- **Depot in-degree**: max 3 at bands 2–5; 1.00 / 1.99 / 2.15 / 3.01 / 3.56 shared depots per
  level. Corroborates the orchestrator's finding 1, and the revised `generation.md` §2.4 now
  states it correctly.

---

## 7. AC status

**Verified independently by execution (tier 1 and 2):**
AC-101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112 *(see note)*, 113, 114, 115
*(first clause; second clause — F10)*, 116, 117, 118, 119, 120, 121, 122, 123 *(passes, margin 1 —
F1)*, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137 *(indirect)*, 201, 202,
203, 204, 205, 206 *(via the §2.5 ordering argument)*, 207 *(edge lengths against the table; I did
not re-derive the Bézier — the developer's `test/geometry.test.js` does, at 128 and 4,096 steps)*,
208, 209 *(directly, and indirectly: the oracle delivers all `K` colours in 100 % of 2,000
levels/band)*, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 234, 309/310/311 *(engine
half)*, 701, 702, 704, 801, 802, 807, 808, 809, 810 *(F9)*, 811 *(x86↔x86 only)*, 813 *(engine
half)*, 814, 815.

**Verified as failing:** AC-816 — F3.

**Not verified, and why:**

- **AC-221 – AC-233** (constrained-bot clear rate, tap rate, bot constraints) and
  **AC-226 – AC-231** (pacing over constrained-bot runs) — the bot specification is being revised
  and I was directed not to spend effort there. I measured the perfect-play floors instead (§6),
  which bound them below.
- **AC-811 on arm64** — only x86↔x86 was available. The cross-process replay is deeply equal;
  the architecture half is untested. Given that every simulation quantity is an integer and edge
  lengths are table literals, I have no specific concern — but I did not run it.
- **AC-301 – AC-308, AC-312** (gesture and screen-to-design mapping) — no React or render layer
  exists in slice 1.
- **AC-401 – AC-410** (layout) — no layout code, and `tools/layout-sweep.mjs` does not exist (F13).
- **AC-501 – AC-512** (visual), **AC-601 – AC-610** (accessibility) — nothing to render.
- **AC-703, AC-705 – AC-707** (unlock, persistence, no-network) — slice 4.
- **AC-803, AC-804, AC-806, AC-812** — the engine halves pass (`advanceClock` caps and resets
  correctly; not calling `step()` does not advance the tick), but backgrounding, the resume
  countdown, on-device teleport and StrictMode double-invocation are all React-layer behaviours
  that do not exist yet.

**Note on AC-112.** As written it requires an observable state in which a fresh car has
`progress === 0`. There is none: spawn is step 3 and advance is step 4 of the same tick, so the
first state any caller sees has `progress === speedMluPerTick`. The developer implemented the
spec correctly and documented the discrepancy in a comment. My harness asserts the observable
form (right tick, right colour, right id, on `entryEdgeId`) and it passes. The AC's final clause
is unobservable and should say `progress === speedMluPerTick` after the tick, or say "at the
moment it is pushed".

---

## 8. Reproduction

Harnesses live in
`/tmp/claude-1000/-home-agentadmin-sources-tot/3ab64bef-d65a-4358-96ae-b02e313dccfb/scratchpad/h/`
(session scratchpad, per the tester's boundaries — nothing under `src/`, `test/` or `tools/` was
touched). `ENGINE=<path to an index.js>` points any of them at a faulty engine copy.

```
node h/h1-junction-timing.mjs          # junction read timing, 900 transitions
node h/h2-determinism.mjs              # determinism attacks, incl. cross-process
TICKS=1200000 node h/h3-fuzz.mjs       # adversarial invariant fuzz
node h/h4-edges.mjs                    # simultaneous arrivals, terminal ordering, hostile input
SEEDS=400  node h/h5-spawnslack.mjs    # spawn headroom + oracle clear rate
SEEDS=1000 node h/h6-spawnworst.mjs    # worst-case spawn consumption
node h/h6b.mjs                         # band 4/5 headroom histogram, 5,000 seeds
SEEDS=1500 node h/h7-fairness.mjs      # degenerate-level survey
SEEDS=1200 node h/h8-structure.mjs     # independent structural validation
node h/h9-extremes.mjs                 # least demanding levels; AC-234
node h/h10-misc.mjs                    # clock, purity, streak cap, V12, GEN_EXHAUSTED
node h/h11-probes.mjs                  # float geometry, NaN clock, terminal events, initial open
SEEDS=3000 node h/h12-gaps.mjs         # AC-211 distribution, validate() injections, AC-124, AC-115
node h/h13-final.mjs                   # AC-815/816/136, AC-124 vacuity, V5/V9 reachability
```

`npm test` is green here too: 72 pass, 0 fail.
