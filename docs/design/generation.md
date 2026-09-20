# Offramp — Track Generation

Slice-0 design. The road-network generator specified as an algorithm: the topology model, the
construction procedure, the rules that reject a candidate, the difficulty parameters per band,
and the two measurable targets the tester will hold this design to.

Companion documents: [`gameplay.md`](gameplay.md), [`ui.md`](ui.md),
[`acceptance-criteria.md`](acceptance-criteria.md).

Everything here is a pure function of an integer seed and a band index. No layout is authored.
The generator runs in bare Node, in `src/engine/`, and uses no floats except in the offline
derivation of the constants in §3.3, which are tabled rather than computed at runtime.

---

## 1. What the generator produces

```
level = {
  seed, band,
  C, K, R,                       // columns, colours (= depots), route rows
  colW, rowH, diagLen,           // geometry, integers in LU (§3)
  nodes:  [node, ...],           // §2.2 — includes the entry node and the K depot nodes
  edges:  [edge, ...],           // §2.3
  junctions: [nodeId, ...],      // ascending; index is the junctionId
  entryEdgeId,
  speedMluPerTick, interval, jitter, quota,
  spawns: [{index, tick, colour}, ...]   // gameplay.md §2.7, length = quota + 8
}
```

Everything in it is an integer or a string tag. It serialises to JSON and back with no loss,
which is what makes a bug report a replayable artifact.

---

## 2. The network topology model

### 2.1 A lattice, not a free-form graph

The network lives on an integer lattice of `R + 1` rows by `C` columns in **design space**
(§3.1). One lattice site holds at most one node.

- Rows `0 .. R-1` are **route rows**. Row `R` is the **depot row**.
- Every edge goes from a site in row `r` to a site in row `r+1`. There are no horizontal edges,
  no upward edges and no edges that skip a row.
- An edge's column change is `Δc ∈ {-1, 0, +1}`. Nothing moves two columns in one row.

This is the load-bearing simplification. It makes the graph a DAG by construction, makes every
root-to-node path exactly `r` edges long, and — most importantly — makes crossings finitely
enumerable (§2.5).

### 2.2 Nodes

```
node = { id, row, col, x, y, kind, out, junctionId, depotColour }
```

| `kind` | out-degree | in-degree | Is it a tap target? |
|---|---|---|---|
| `entry` | 1 | 0 | no |
| `branch` | 2 | 1 | **yes** — this is a junction |
| `pass` | 1 | 1 | no |
| `depot` | 0 | ≥ 1 | no |

`x` and `y` are integers in LU, derived from `(row, col)` by §3.2. `junctionId` is set iff
`kind === 'branch'`, and is the node's index in `level.junctions` (ascending by node id, so it is
stable and deterministic).

For a `branch` node, `out[0]` is the edge to the **smaller** column and `out[1]` the larger; the
two targets always differ, so the ordering is total. `junction.open ∈ {0,1}` indexes `out`
directly.

A `pass` node is not drawn as anything. It exists so that a road can run for several rows without
branching, which is how the generator controls vertical pacing.

### 2.3 Edges

```
edge = { id, from, to, lengthMlu, shape }     // shape ∈ 'entry' | 'straight' | 'diagL' | 'diagR'
```

Edges are **cubic Bézier curves** with control points that make the curve leave and arrive
vertically:

```
P0 = (x_from, y_from)
P1 = (x_from, y_from + K_CTRL * rowH)
P2 = (x_to,   y_to   - K_CTRL * rowH)
P3 = (x_to,   y_to)

K_CTRL = 0.45
```

This is one `cubicTo` per edge in Skia — no path approximation, no polyline, no sampling in the
draw call. Three consequences that matter:

1. When `x_from === x_to` the cubic degenerates exactly to a vertical straight line.
2. Every edge is vertical at both endpoints, so all edges meeting at a node are tangent-continuous
   (G1). Roads join without a kink, and a car's heading is continuous across a junction.
3. A car's heading is the curve tangent, which is always "downward-ish". The sprite never spins.

`lengthMlu` is the edge's arc length in milli-LU. It is a **table literal** (§3.3), not computed
at runtime.

### 2.4 Merge-free by construction

**No node other than a depot has in-degree greater than one.** The route portion of the network
is a tree rooted at the entry; the depot row is where branches are allowed to rejoin, and a car
entering a depot is resolved and removed in the same tick, so it cannot share an edge with
anything.

This single property delivers four things at once:

- It satisfies `docs/development-process.md:96` — "no junction a car can enter from two
  directions" — completely rather than approximately.
- Two cars share an edge only if they took the identical path, so their separation is exactly
  their spawn separation ([`gameplay.md` §4.5](gameplay.md#45-why-two-cars-never-visually-overlap)).
  No car ever overlaps another. This needs no validity rule and no tuning.
- Two cars arrive at the same junction only if they took the same path to it, so the minimum
  flip window at any junction equals the minimum spawn gap — 1.00 s at the hardest band
  ([`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time)).
- The drawing reads as a river delta: roads only ever divide, never converge. On a 6.1" screen
  that is dramatically easier to follow than a lattice of merges.

The alternative — a general DAG with merges — was prototyped and measured. To stop two cars
converging on a shared edge it requires every path to a node to have identical arc length, and
that constraint rejects essentially every candidate at bands 2–5: **0 valid networks in 2,000
seeds per band**, against 3,000/3,000 for the merge-free model. The decision is recorded in
[`gameplay.md` §8.2](gameplay.md#82-merge-free-networks-decided).

### 2.5 Planarity: why there are never ambiguous crossings

Within one row band, an edge is a chord from column `a` to column `b` with `|a - b| ≤ 1`. Take two
edges `(a→b)` and `(a'→b')` with `a < a'`. They cross iff `b > b'`.

- If `a' = a + 1`: `b ∈ {a-1, a, a+1}` and `b' ∈ {a, a+1, a+2}`. The only pair with `b > b'` is
  `b = a+1, b' = a` — the adjacent swap.
- If `a' ≥ a + 2`: `b ≤ a + 1` and `b' ≥ a' - 1 ≥ a + 1`, so `b > b'` is impossible.

**Therefore the only possible crossing in the entire model is the adjacent swap
`{(c→c+1), (c+1→c)}` within one row band.** In a merge-free network the targets across a row are
strictly increasing (§4, rule **V2**), which forbids the swap outright.

The generator does not need a geometric planarity test. Planarity is a property of the
construction, verifiable by a two-line check ([AC-206](acceptance-criteria.md)). Separately,
because `|Δc| ≤ 1`, no edge ever passes near an intervening lattice site, so no road ever runs
close enough to an unrelated junction to be mistaken for feeding it.

### 2.6 A worked example

Band 3, `C = 4`, `K = 4`, `R = 4`, entry at column 1, `J = 5`, depth 2–3. Generated from seed 13.

```
              col 0      col 1      col 2      col 3
                            ┃
   entry  y=  60            ┃              (entry edge, 100 LU, straight)
                            ┃
   row 0  y= 160          ╭─◆─╮                          ◆ = junction (branch node)
                          │   ╰──╮                       · = pass node (not drawn)
   row 1  y= 460       ╭──◆──╮   ◆──╮                    ╱╲ = cubic edges
                       │     │   │  ╰──╮
   row 2  y= 760       ·     ·   ·     ·                 (a pass row: four roads run straight)
                       │     │   │     │
   row 3  y=1060       ·   ╭─◆─╮ ◆─╮   ·
                       │   │   ╰─│─╯   │                 (two branches, both rejoining at depots)
   depot  y=1360     ┌───┐┌───┐┌───┐┌───┐
                     │ A ││ B ││ C ││ D │
                     └───┘└───┘└───┘└───┘
                     Ember  Sky  Rose  Teal
```

Depth from the entry: depot A takes 2 junctions, B takes 3, C takes 3, D takes 2. Different
colours cost different amounts of attention within the same level, which is deliberate.

---

## 3. Geometry: how the graph maps to the screen

### 3.1 Design space

The generator works entirely in a fixed, device-independent rectangle:

```
DESIGN_W = 1000 LU
DESIGN_H = 1600 LU
```

Nothing about the device reaches the engine. The renderer maps this rectangle into the play area
with a single uniform scale ([`ui.md` §4](ui.md#4-the-play-surface)). An engine that knew the
screen size would produce different levels on different phones, and a bug report from an iPhone
would not reproduce on CI.

### 3.2 Site coordinates

```
LANE_SPAN = 780            // total horizontal span of the outermost columns
ENTRY_Y   = 60
ROW0_Y    = 160
DEPOT_Y   = 1360
ENTRY_LEN = ROW0_Y - ENTRY_Y = 100 LU

colW  = min(300, LANE_SPAN / (C - 1))
rowH  = (DEPOT_Y - ROW0_Y) / R = 1200 / R
x(c)  = 500 - colW*(C-1)/2 + c*colW
y(r)  = ROW0_Y + r*rowH
```

All of these are exact integers for every `(C, R)` the bands use:

| `C` | `colW` | column x positions |
|---|---|---|
| 3 | 300 | 200, 500, 800 |
| 4 | 260 | 110, 370, 630, 890 |
| 5 | 195 | 110, 305, 500, 695, 890 |

| `R` | `rowH` | row y positions (row 0 … depot row) |
|---|---|---|
| 3 | 400 | 160, 560, 960, 1360 |
| 4 | 300 | 160, 460, 760, 1060, 1360 |
| 5 | 240 | 160, 400, 640, 880, 1120, 1360 |
| 6 | 200 | 160, 360, 560, 760, 960, 1160, 1360 |

The minimum distance between two lattice sites is `min(colW, rowH)`, which is **195 LU** at its
worst (band 4 and 5). That is the number the 44 pt tap-target arithmetic in
[`ui.md` §4.4](ui.md#44-tap-target-arithmetic) is built on, and it is why `C` is capped at 5.

### 3.3 Edge lengths

`straight` edges have length `rowH`. `entry` edges have length `ENTRY_LEN = 100`. Diagonal edges
(`diagL`, `diagR` — mirror images, identical length) have the arc length of the cubic in §2.3.

**Reference derivation** (offline, for deriving and for verifying the table — not run at level
build time): sample the cubic at 128 uniform steps in `t`, sum the chord lengths, round to the
nearest integer LU.

| Band | `colW` | `rowH` | `diagLen` | `diagLen - rowH` |
|---|---|---|---|---|
| 1 | 300 | 400 | **521** | 121 |
| 2 | 260 | 300 | **415** | 115 |
| 3 | 260 | 300 | **415** | 115 |
| 4 | 195 | 240 | **323** | 83 |
| 5 | 195 | 200 | **293** | 93 |

`lengthMlu` is `1000 ×` the LU value. The engine reads these from the band table. A unit test
re-derives them with the reference algorithm and asserts equality
([AC-207](acceptance-criteria.md)) — that is what stops the table drifting from the drawing.

### 3.4 Arc-length parameterisation (renderer only)

To place a car, the renderer needs `t` from a distance along the curve. It precomputes, once per
level, a 65-entry `distance → t` table per distinct edge shape (at most three: `entry`,
`straight`, `diagonal`; `diagL` and `diagR` share one, mirrored), and linearly interpolates. This
is floating-point and lives in `src/render/`, where floating-point is harmless — the simulation
has already decided where the car is, in integers.

---

## 4. The generator, as an algorithm

```
generate(seed, band):
  P   = BAND[band]                                  // §5
  rng = mulberry32(mix32(seed, GEN_SALT))           // gameplay.md §2.7
  for attempt in 0 .. MAX_ATTEMPTS-1:               // MAX_ATTEMPTS = 256
     net = tryBuild(rng, P)
     if net === null:                       continue
     if validate(net, P) !== null:          continue
     return finalise(net, P, seed)
  throw new Error('GEN_EXHAUSTED: band=' + band + ' seed=' + seed)
```

**There is no fallback layout.** A silent fallback would hide a generator regression behind a
level that still plays. Exhaustion throws, and `tools/generator-audit.mjs` asserts it never
happens over 5,000 seeds × 5 bands ([AC-203](acceptance-criteria.md)). Measured attempt counts
are in §5.2; the worst observed over 15,000 runs is 68.

### 4.1 `tryBuild`

```
tryBuild(rng, P):
  all       = [0 .. C-1]
  depotCols = (K === C) ? all : rngChoose(rng, combinations(all, K))
  entryCol  = rngChoose(rng, all.filter(c => |c - (C-1)/2| <= 1))

  rows[0] = [entryCol]
  for r = 0 .. R-1:
     terminal = (r === R-1)
     allowed  = terminal ? depotCols : all
     band     = buildRow(rng, rows[r], allowed, terminal, P.pBranch)
     if band === null: return null
     rows[r+1] = sorted distinct targets of band
     if !terminal and rows[r+1].length > C: return null
     record edges
  return { entryCol, depotCols, rows, edges }
```

### 4.2 `buildRow` — depth-first with backtracking

Sources are processed left to right. A running `minTarget` enforces the ordering rule that makes
the row simultaneously merge-free and planar.

```
buildRow(rng, srcs, allowed, terminal, pBranch):
  budget = 40000 recursion steps      // exceeding it fails this attempt, not the level

  rec(i, minTarget):
     if i === srcs.length:
        if terminal: return every depot column is covered
        return true
     a    = srcs[i]
     cand = [a-1, a, a+1] ∩ allowed, filtered to >= minTarget
     branchOptions = shuffled 2-subsets of cand      // node becomes a junction
     passOptions   = shuffled 1-subsets of cand      // node becomes a pass node
     options = (rng() < pBranch) ? branchOptions ++ passOptions
                                 : passOptions ++ branchOptions
     for opt in options:
        emit edges a → opt
        nextMin = terminal ? max(opt)        // depots may be shared
                           : max(opt) + 1    // route rows may not
        if rec(i+1, nextMin): return true
        retract edges
     return false

  return rec(0, -Infinity)
```

`pBranch` is the band's branch bias (§5). It steers the search toward the junction count the band
wants without adding a rejection round-trip: with `pBranch = 0.88`, branch options are tried first
88 % of the time.

The `nextMin` rule is doing three jobs at once. Targets across a route row are strictly
increasing, which means (a) no two nodes share a target — the network is merge-free; (b) no
adjacent swap — the network is planar (§2.5); (c) every node's targets are contiguous with its
neighbours', which is what keeps the drawing a clean delta.

### 4.3 `finalise`

Assigns node ids in `(row, col)` order, assigns `junctionId` to branch nodes in node-id order,
maps a random permutation of the band's `K` colours onto the `K` depot columns, looks up
`lengthMlu` per edge shape from the band table, and builds the spawn schedule
([`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)).

---

## 5. Validity rules: what rejects a candidate

`validate(net, P)` returns `null` or the id of the first rule violated. Rules are checked in this
order; the id is what a generator-audit failure reports.

| Id | Rule | Why |
|---|---|---|
| **V1** | Every route-row node has out-degree 1 or 2; every depot has out-degree 0 and in-degree ≥ 1. | No dead ends. Every car reaches a depot. |
| **V2** | Targets across a route row are strictly increasing; targets across the terminal row are non-decreasing. | Merge-free (§2.4) and planar (§2.5), in one rule. |
| **V3** | No node other than a depot has in-degree > 1. | `development-process.md:96`. Implied by V2; checked independently so the check can fail. |
| **V4** | Every edge has `|Δcol| ≤ 1` and `Δrow = +1`. | The lattice invariant. |
| **V5** | Every depot column is reachable from the entry. | Any colour can spawn; every colour must be routable. |
| **V6** | Every branch node's two branches lead to **different** depot-colour sets. | A junction whose two branches are equivalent is a lie to the player. |
| **V7** | Junction count `J` is within the band's range. | Difficulty. |
| **V8** | Every root-to-depot path has junction depth within the band's `[Dmin, Dmax]`. | No colour is free; no colour is a five-step puzzle. |
| **V9** | At most one node per lattice site; `rows[r].length ≤ C` for all `r`. | Geometry. |
| **V10** | The `K` depot colours are distinct and are exactly the band's first `K` palette entries. | [`ui.md` §5.1](ui.md#51-the-car-palette). |
| **V11** | Minimum distance between any two junction centres ≥ 150 LU. | Tap targets (§3.2). Guaranteed by the lattice; asserted anyway. |

**V6 subsumes the "no-op junction" case.** If both branches reached the same set, flipping it
would change nothing for any colour, and the player would learn that tapping sometimes does
nothing.

**What is deliberately *not* a rule:** there is no path-length-skew rule and no car-separation
rule. Both are guaranteed by V2 (§2.4), and a rule that cannot fail is not a rule
(`development-process.md:168`).

---

## 6. Difficulty parameters per band

### 6.1 The table

| Band | Levels | `C` | `K` | `R` | `pBranch` | `J` | `D` | `rowH` | `colW` | `diagLen` | Speed MLU/tick | LU/s | Interval | Jitter | Quota |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | 3 | 3 | 3 | 0.85 | 3 | 2 | 400 | 300 | 521 | 3000 | 180 | 156 | ±12 | 16 |
| 2 | 5–9 | 4 | 3 | 4 | 0.70 | 3–5 | 2–3 | 300 | 260 | 415 | 3200 | 192 | 138 | ±12 | 26 |
| 3 | 10–15 | 4 | 4 | 4 | 0.80 | 4–6 | 2–3 | 300 | 260 | 415 | 3400 | 204 | 120 | ±18 | 36 |
| 4 | 16–22 | 5 | 4 | 5 | 0.80 | 5–7 | 2–4 | 240 | 195 | 323 | 3600 | 216 | 108 | ±18 | 48 |
| 5 | 23+ | 5 | 5 | 6 | 0.88 | 7–8 | 2–4 | 200 | 195 | 293 | 3800 | 228 | 96 | ±18 | 64 |

`D` is `[Dmin, Dmax]` over all root-to-depot paths. `J` is the junction count.

### 6.2 Measured generator behaviour

Measured with a faithful prototype of §4 over **3,000 seeds per band**, 15,000 runs total:

| Band | Valid networks | Attempts: median / p95 / max | Distinct networks | `J` distribution | `D` range |
|---|---|---|---|---|---|
| 1 | 3000 / 3000 | 5 / 19 / 68 | 37 | J=3: 100 % | 2 |
| 2 | 3000 / 3000 | 3 / 11 / 32 | 1022 | J=3: 17 %, 4: 38 %, 5: 44 % | 2–3 |
| 3 | 3000 / 3000 | 2 / 6 / 17 | 690 | J=4: 20 %, 5: 37 %, 6: 43 % | 2–3 |
| 4 | 3000 / 3000 | 2 / 8 / 17 | 1883 | J=5: 11 %, 6: 32 %, 7: 57 % | 2–4 |
| 5 | 3000 / 3000 | 2 / 7 / 17 | 951 | J=7: 29 %, 8: 71 % | 2–4 |

**Band 1's network space is genuinely small** — 37 distinct networks, because `C = 3`, `R = 3`
and `J = 3` leaves little to vary. Band 1 is four levels long, so this is acceptable, but it
means a repeat is possible. Hence:

> **V12 (cross-level rule).** A level's network signature — the sorted edge list plus the
> entry column plus the depot-colour assignment — must differ from the immediately preceding
> level's. If it matches, re-derive with `seed = mix32(seed, 0xC2B2AE35)` and rebuild, up to 8
> times. ([AC-213](acceptance-criteria.md))

### 6.3 Tap load

The sustained tap rate is the third difficulty metric. It is derived rather than targeted, and
the constrained bot measures the true value.

| Band | Spawn rate | Mean depth | Estimated taps/s | Cars in flight |
|---|---|---|---|---|
| 1 | 0.385 /s | 2.0 | 0.38 | 3.3 |
| 2 | 0.435 /s | 2.5 | 0.54 | 3.5 |
| 3 | 0.500 /s | 2.7 | 0.68 | 3.8 |
| 4 | 0.556 /s | 3.2 | 0.89 | 3.8 |
| 5 | 0.625 /s | 3.3 | 1.03 | 4.1 |

The estimate assumes a junction is in the wrong state half the time, which overstates the true
rate because consecutive same-colour cars inherit a correct junction. The measured value from
`tools/bot.mjs` is the one that counts ([AC-233](acceptance-criteria.md)).

---

## 7. The two measurable targets

These are the numbers the tester will hold this design to. They are measured by
`tools/bot.mjs --seeds 1000` per band and `tools/pacing.mjs`.

### 7.1 The constrained solver bot

An omniscient bot proves nothing about playability (`development-process.md:99`). The bot that
the targets are stated against is constrained to human limits, and its constraints are
normative — a bot that clears a level by doing something a person cannot do is not evidence.

```
BOT_REACTION_TICKS   = 15    // 250 ms: a car is not "seen" until 15 ticks after it spawns
                             //          or after it transitions at a junction
BOT_MIN_TAP_GAP      = 11    // 180 ms between consecutive taps
BOT_MAX_TAPS_PER_TICK = 1    // one finger
BOT_LOCKOUT_TICKS    = 6     // 100 ms: will not attempt a flip inside the last 100 ms
                             //          before a car reaches the junction — no frame-perfect play
BOT_LOOKAHEAD_CARS   = 4     // considers only the 4 cars nearest to their next junction
BOT_SAFE_WINDOW      = 20    // will not flip a junction if another car reaches it within 20 ticks
                             //          and the flip would misroute that car
```

Policy: each tick, for the nearest actionable car, compute the branch at its next junction that
leads to its depot (from the precomputed per-node reachable-colour sets). If the junction is
already correct, do nothing. If it is wrong and neither the lockout nor the safe window forbids
it, tap it. Otherwise move to the next car in the lookahead window.

### 7.2 Target 1 — constrained-bot clear rate

Over 1,000 seeds per band. Both ends matter: a band that clears at 99 % is not a challenge, and a
band that clears at 40 % is not a game.

| Band | Clear-rate band |
|---|---|
| 1 | 92 – 100 % |
| 2 | 88 – 99 % |
| 3 | 80 – 96 % |
| 4 | 72 – 90 % |
| 5 | 62 – 84 % |

An **unconstrained** bot must clear **100 % of seeds at every band with zero misroutes**. That
follows from V1/V5/V6 plus the 1.00 s minimum flip window
([`gameplay.md` §4.7](gameplay.md#47-every-level-is-solvable-provably)), so a failure there is a
generator defect, not a tuning question. ([AC-220](acceptance-criteria.md))

### 7.3 Target 2 — completion-time band

Measured over successful constrained-bot runs, in seconds of simulated time (`ticks / 60`).

| Band | Nominal | Median must fall in | p95 ceiling | Absolute ceiling, any seed |
|---|---|---|---|---|
| 1 | 49.1 s | 42 – 62 s | 68 s | **130 s** |
| 2 | 67.0 s | 58 – 78 s | 86 s | **130 s** |
| 3 | 79.0 s | 70 – 92 s | 100 s | **130 s** |
| 4 | 92.9 s | 84 – 106 s | 114 s | **130 s** |
| 5 | 108.8 s | 98 – 122 s | 126 s | **130 s** |

The 130 s absolute ceiling is the two-minute promise made measurable, with 10 s of headroom for
the two misroutes a winning run may contain. No seed at any band may exceed it
([AC-231](acceptance-criteria.md)).

### 7.4 When a target is missed

The lever order is normative, so the fix is not reinvented under time pressure.

- **Clear rate too low:** reduce `quota` first, then increase `interval`. Do **not** reduce speed
  — a slower car shortens nothing and a faster spawn rate is what makes it hard; reducing speed
  shortens the planning horizon relative to the spawn rate and pushes the game toward reaction.
- **Clear rate too high:** increase `quota`, then reduce `interval`, then raise `pBranch`.
- **Median time above band:** reduce `quota`. Duration is `≈ SPAWN_LEAD/60 + (quota-1)·interval/60 + transit`,
  and `quota` is the only term that moves it without changing how the level feels.
- **Median time below band:** increase `quota`.

`interval` must never fall below `2·jitter + 60` ticks, or the minimum flip window drops below
1.00 s and [`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time) stops
being true.

---

## 8. Harnesses this design assumes exist

| Tool | What it must assert |
|---|---|
| `tools/generator-audit.mjs --seeds 5000` | V1–V12 hold for every band × seed; zero `GEN_EXHAUSTED`; report attempt-count percentiles and distinct-network counts per band. |
| `tools/bot.mjs --seeds 1000` | Unconstrained clear rate = 100 %; constrained clear rate within §7.2; measured taps/s per band. |
| `tools/pacing.mjs` | Completion-time median / p95 / max per band against §7.3. |
| `tools/replay.mjs --seed N` | A recorded run replays to a deeply equal final state, twice in a row and across machines. |

Per `development-process.md:136`: before any of these is trusted to pass, the fault it is meant
to catch is injected and the harness is confirmed to fail.
