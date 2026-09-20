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
- Two cars share an edge only if they took the identical path, so their separation *on that edge*
  is exactly their spawn separation
  ([`gameplay.md` §4.5](gameplay.md#45-why-two-cars-never-overlap-on-the-same-edge)). This needs
  no validity rule and no tuning. It is a guarantee about **one edge**, and it says nothing about
  two cars on two different terminal edges converging on a shared depot, which V2 permits and
  which every generated level contains; that case is handled in the renderer
  ([`ui.md` §7.6](ui.md#76-the-depot-mouth)).
- Two cars arrive at the same junction only if they took the same path to it, so the minimum
  flip window at any junction equals the minimum spawn gap — 1.00 s at the hardest band
  ([`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time)).
- The drawing reads as a river delta: roads only ever divide, never converge. On a 6.1" screen
  that is dramatically easier to follow than a lattice of merges.

The alternative — a general DAG with merges — was prototyped and measured. To stop two cars
converging on a shared edge it requires every path to a node to have identical arc length, and
that constraint rejects essentially every candidate at bands 2–5: **0 valid networks in 2,000
seeds per band**, against 3,000/3,000 for the merge-free model. The decision is recorded in
[`gameplay.md` §8.2](gameplay.md#82-merge-free-networks--decided).

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

**Read this table as an upper bound on *demand*, never as a prediction of the bot.** Slice 1 found
that the `literal` bot policy's measured tap rate landed almost exactly on this estimate while
clearing 0.7 % of band 5 — a bot can match the tap rate by tapping the wrong things. Agreement
between this column and a measured column is not evidence that the bot is playing well, and the
two must never be used to corroborate each other.

---

## 7. The two measurable targets

These are the numbers the tester will hold this design to. They are measured by
`tools/bot.mjs --seeds 1000` per band and `tools/pacing.mjs`.

### 7.1 The constrained solver bot

An omniscient bot proves nothing about playability (`development-process.md:99`). The bot that
the targets are stated against is constrained to human limits, and its constraints are
normative — a bot that clears a level by doing something a person cannot do is not evidence.

**This section was rewritten after slice 1.** The previous wording admitted at least three
readings and the developer implemented all three; band 5's measured clear rate moved
0.7 % → 30.0 % → 100 % across them, which means no clear-rate number stated against it was
falsifiable. Worse, the most permissive reading cleared **100 % at every band while obeying every
constraint the section imposed**, because every constraint was a *timing* constraint. Offramp's
subject is divided attention, and nothing in the old bot ever divided its attention: it had
perfect topology knowledge, perfect memory of every car's colour, and no cost to switching
between cars. What follows replaces the timing-only model with an **attention model**, and is
written so that two competent implementers cannot disagree about what the bot does on any tick.

#### 7.1.1 What the bot is a model of

A **competent, attentive adult playing with one thumb**. Not an expert, not a beginner, not a
machine. It is the instrument the two targets in §7.2 and §7.3 are read off, so the question to
ask of every constant below is not "is this optimal?" but "is this what a person can do?".

#### 7.1.2 What the bot is given for free, and why the line is drawn there

| Given free | Why |
|---|---|
| The network topology, and the set of depot colours reachable from every node | The network is drawn on screen, is static for the whole level, and does not move. A player reads it once during `SPAWN_LEAD` and refers back to a picture that has not changed. Charging for this would measure map-reading, not attention. |
| The exact position of any car it is currently looking at | Positions are on screen and unambiguous. |
| Its own tap timing | Motor constraints are modelled explicitly below. |

| **Not** given free | Why |
|---|---|
| **Which car to look at next** | A player is not handed a list sorted by urgency. The bot scans (§7.1.5 D). |
| **A car's colour** | Binding a colour to a moving object is the expensive operation in this game. It costs focus (§7.1.5 E) and it is forgotten (§7.1.5 A). |
| **Simultaneous attention to many cars** | Capacity is `BOT_WORKING_SET`. |
| **Knowing whether a flip hurts a car it has forgotten** | The safe-window check ranges over the working set only (§7.1.6). Capacity limits what the bot can fix *and* what it can avoid breaking. |

#### 7.1.3 Constants

Motor and latency constants — unchanged from slice 0 except where noted:

```
BOT_MIN_TAP_GAP       = 11   // 180 ms between consecutive taps. One thumb, returning to a new
                             //   target: the fast end of Fitts-law reciprocal tapping at these
                             //   target sizes.
BOT_MAX_TAPS_PER_TICK = 1    // one finger. A consequence of §7.1.5, not a separate rule.
BOT_LOCKOUT_TICKS     = 6    // 100 ms. The bot will not attempt a flip when the car it is acting
                             //   for reaches the junction in fewer than 6 ticks — no frame-perfect
                             //   play. (Slice 0 phrased this over "a car"; it is the *focused*
                             //   car, because this models the bot's own motor confidence.)
BOT_SAFE_WINDOW       = 20   // 333 ms. The bot will not flip a junction if a car it is currently
                             //   holding in its working set would be misrouted by the flip and
                             //   reaches that junction within 20 ticks. Cars it is not holding are
                             //   not considered — it does not know about them.
```

Attention constants — new, and the reason this section exists:

```
BOT_WORKING_SET   = 3    // cars whose colour and identity the bot holds at once.
                         //   Visual working memory for objects that must stay bound to a moving
                         //   location is 3–4 items; 3 is the conservative end. It is deliberately
                         //   *below* the 3.3–4.1 cars in flight (§6.3): if capacity exceeded
                         //   traffic, the game would be a checklist rather than a division of
                         //   attention.

BOT_SCAN_TICKS    = 6    // 100 ms per glance. About ten glances a second — the fast end of serial
                         //   visual search for a positional judgement over a sparse field. Chosen
                         //   generously so that a failure is attributable to capacity rather than
                         //   to search speed.

BOT_ACQUIRE_TICKS = 15   // 250 ms to focus a car that is NOT in the working set: find it, read its
                         //   colour, bind the colour to that moving object, recall the depot.
                         //   This is slice 0's BOT_REACTION_TICKS at the same value, reattached to
                         //   the operation it was always meant to price. A newly spawned car is
                         //   not a special case — it is simply a car not yet held.

BOT_SWITCH_TICKS  = 4    // 67 ms to re-focus a car already in the working set: a covert attention
                         //   shift to an already-encoded item. Cheap, but not free — that gap is
                         //   what makes holding three cars different from holding one.

BOT_MEMORY_TICKS  = 120  // 2.00 s. An entry not refreshed for this long is dropped and the car's
                         //   colour must be re-observed at full price. Two seconds is shorter than
                         //   band 1's spawn interval (2.60 s) and longer than band 5's (1.60 s),
                         //   so memory alone can never carry the bot across the traffic stream,
                         //   and it carries less of it as the bands get harder.

BOT_URGENCY_TICKS = 90   // 1.50 s. A glance at a car whose next junction is further away than this
                         //   does not escalate to a focus. It covers acquire (15) + tap gap (11) +
                         //   lockout (6) with more than twice the margin, and it is short enough
                         //   that the bot cannot pre-solve the board at leisure.

BOT_LAPSE_PCT     = 3    // 3 % of glances land on nothing — roughly one lost glance every three
                         //   seconds of sustained play. This is the only stochastic element and it
                         //   is what makes the clear rate a distribution rather than a per-seed
                         //   pass/fail, which is what a human's clear rate on one level is.

BOT_SALT          = 0x5BF03635
```

`BOT_LOOKAHEAD_CARS` from slice 0 is **deleted**. It was the constant that made the three
readings possible: it described a window over a globally sorted list, and nothing said what the
bot did with a car in the window that needed nothing. There is no list and no window now.

#### 7.1.4 Bot state

The bot is a pure function of `(level, botState, simState)` and carries its own state. It runs
**before** `step()` for tick `T` and returns the input array for that tick — either `[]` or a
single `[{ tick: T, junctionId }]`.

```
botState = {
  rng:         uint32,        // mulberry32(mix32(seed, BOT_SALT)) — gameplay.md §2.7
  busyUntil:   int,           // ticks strictly before this are consumed by an action in progress
  focus:       carId | null,  // the one car currently focused
  mem:         [ { carId, colour, seenTick } ],   // the working set, oldest first, length <= 3
  cursor:      carId | null,  // where the scan sweep is
  lastTapTick: int,           // -BOT_MIN_TAP_GAP at tick 0
}
```

`mem` is a **queue ordered by insertion**, not by recency of use. Eviction removes `mem[0]`.

#### 7.1.5 The per-tick procedure — normative

Exactly this, in exactly this order. Every branch returns; there is no fall-through that is not
written down.

```
botTick(sim, bot):
  T = sim.tick

  // ── A. HOUSEKEEPING. Free, and it happens on every tick including busy ones.
  A1  drop from bot.mem every entry with  T - entry.seenTick >= BOT_MEMORY_TICKS
  A2  drop from bot.mem every entry whose carId is not in sim.cars
  A3  if bot.focus is not in sim.cars:  bot.focus = null
  A4  if bot.focus is not null and no entry in bot.mem has carId === bot.focus:
          bot.focus = null                     // its memory decayed out from under it

  // ── B. BUSY. An action in progress consumes the tick.
  B1  if T < bot.busyUntil:  return []

  // ── C. ACT. A ready focus is evaluated and then released, whatever the outcome.
  C1  if bot.focus !== null:
          c = the car in sim.cars with id bot.focus   // A3/A4 guarantee it exists
          m = the entry in bot.mem with carId === bot.focus  // A4 guarantees it exists
          v = evaluate(sim, c, m.colour)                      // §7.1.6
          m.seenTick   = T                                    // looking refreshes, either way
          bot.focus    = null
          bot.busyUntil = T + 1
          if v is NOTHING:  return []
          j = v.junctionId
          if T - bot.lastTapTick <  BOT_MIN_TAP_GAP:            return []
          if ticksToReach(sim, c, j) <  BOT_LOCKOUT_TICKS:      return []
          if breaksHeldCar(sim, bot, j, c):                     return []
          bot.lastTapTick = T
          return [ { tick: T, junctionId: j } ]

  // ── D. GLANCE. One car per BOT_SCAN_TICKS, in a fixed sweep. This is the only way the bot
  //       ever learns that a car exists.
  D1  bot.busyUntil = T + BOT_SCAN_TICKS
  D2  if sim.cars is empty:  return []
  D3  bot.cursor = nextCarId(sim.cars, bot.cursor)
  D4  r = bot.rng.next()                       // exactly one draw per glance; nowhere else
      if r % 100 < BOT_LAPSE_PCT:  return []   // the glance did not land
  D5  c = the car in sim.cars with id bot.cursor
      j = nextJunction(sim, c)                 // §7.1.6
      if j === null:                           // nothing left to decide for this car
          drop the mem entry for c.id if present
          return []
      if ticksToReach(sim, c, j) > BOT_URGENCY_TICKS:  return []

  // ── E. ESCALATE TO FOCUS. Paid for on top of the glance that found it.
  E1  if bot.mem has an entry e for c.id:
          e.seenTick    = T
          bot.focus     = c.id
          bot.busyUntil = T + BOT_SCAN_TICKS + BOT_SWITCH_TICKS
          return []
  E2  if bot.mem.length === BOT_WORKING_SET:  remove bot.mem[0]
      append { carId: c.id, colour: c.colour, seenTick: T } to bot.mem
      bot.focus     = c.id
      bot.busyUntil = T + BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS
      return []
```

**The sweep.** `nextCarId(cars, cursor)` is the smallest id in `cars` strictly greater than
`cursor`; if there is none, or `cursor` is `null`, the smallest id in `cars`. `sim.cars` is
ascending by id (`gameplay.md` §2.4), so this is a total, deterministic, cyclic sweep and needs
no sort. Because ids are spawn order and every car moves at the same speed, the sweep runs from
the car nearest the depots back up to the newest — a fixed spatial sweep, **not** an urgency
ordering: the first car in the sweep is frequently one with nothing left to decide.

**The three readings, resolved.** The old text's ambiguity was entirely about what happens when
the bot looks at a car that needs nothing. Here, that costs a glance plus a focus and the tick
that evaluates it (`C1` with `v = NOTHING`), and then attention is released. Checking is never
free, waiting is never free, and attention is never held: **C1 releases the focus on every path**,
so a car whose flip is currently forbidden does not pin the bot — it stays in `mem`, and the
sweep will come back to it at `BOT_SWITCH_TICKS` instead of `BOT_ACQUIRE_TICKS`. That is the
single rule that kills all three old readings at once.

**Determinism.** `botTick` reads only `sim` and `bot`, draws from `bot.rng` exactly once per
glance and never elsewhere, and breaks every tie by car id or junction id. Two bots started from
the same `(seed, band)` produce byte-identical input streams
([AC-236](acceptance-criteria.md)).

#### 7.1.6 The helper functions

```
nextJunction(sim, car):
   n = edge(car.edgeId).to
   loop:
      if n.kind === 'depot':   return null
      if n.kind === 'branch':  return n
      n = edge(n.out[0]).to                  // a pass node has exactly one outgoing edge
```

```
ticksToReach(sim, car, junctionNode):
   d = edge(car.edgeId).lengthMlu - car.progress
   n = edge(car.edgeId).to
   while n !== junctionNode:
      if n.kind === 'depot':  return Infinity
      e = n.out[ n.kind === 'branch' ? sim.open[n.junctionId] : 0 ]
      d += edge(e).lengthMlu
      n  = edge(e).to
   return ceil(d / level.speedMluPerTick)
```

```
evaluate(sim, car, rememberedColour):
   j = nextJunction(sim, car)
   if j === null:  return NOTHING
   k0 = reaches(j.out[0], rememberedColour)     // precomputed per-edge reachable-colour sets
   k1 = reaches(j.out[1], rememberedColour)
   if k0 === k1:  return NOTHING                // both branches work, or neither does
   want = k0 ? 0 : 1
   if sim.open[j.junctionId] === want:  return NOTHING
   return TAP(j.junctionId)
```

```
breaksHeldCar(sim, bot, junctionId, focusedCar):
   j = the branch node with this junctionId
   for each entry m in bot.mem, in mem order:
      if m.carId === focusedCar.id:  continue
      if m.carId not in sim.cars:    continue
      o = the car in sim.cars with id m.carId
      if nextJunction(sim, o) !== j:                       continue
      if ticksToReach(sim, o, j) > BOT_SAFE_WINDOW:        continue
      if reaches(j.out[ sim.open[junctionId] ],     m.colour)
         and not reaches(j.out[ 1 - sim.open[junctionId] ], m.colour):  return true
   return false
```

`evaluate` uses `rememberedColour`, not `car.colour`. They are the same value today because the
bot only ever writes a colour it has just observed; the distinction is kept in the signature so
that a future mis-remembering model has somewhere to live, and so that a reviewer can see that
the bot is reading its memory rather than the world.

Note that `breaksHeldCar` ranges over `bot.mem` and nothing else. A car the bot has forgotten
will be misrouted by a flip made for a car it is holding, and it will never see it coming. That
is the failure mode the game is made of, and it is the reason this bot can measure something the
old one could not.

#### 7.1.7 Why this is expected to bind, arithmetically

Attention supply is 60 ticks per second. Demand is one focus per junction decision per car:

| Band | cars/s | mean depth | focus events/s needed | cheapest cost each | dearest cost each | ticks/s demanded |
|---|---|---|---|---|---|---|
| 1 | 0.385 | 2.0 | 0.77 | 11 | 22 | 8 – 17 |
| 2 | 0.435 | 2.5 | 1.09 | 11 | 22 | 12 – 24 |
| 3 | 0.500 | 2.7 | 1.35 | 11 | 22 | 15 – 30 |
| 4 | 0.556 | 3.2 | 1.78 | 11 | 22 | 20 – 39 |
| 5 | 0.625 | 3.3 | 2.06 | 11 | 22 | 23 – 45 |

Cheapest is `BOT_SCAN_TICKS + BOT_SWITCH_TICKS + 1` (the car was still held); dearest is
`BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS + 1` (it had been forgotten or evicted). Neither figure
counts glances that land on a car needing nothing, which rise with the number of cars in flight.
Band 1 sits at a quarter of supply; band 5 sits between 38 % and 75 % of supply *before* wasted
glances, with 4.1 cars competing for 3 working-set slots so that the dearer figure dominates.

The gradient is a property of the model, not of a tuned constant: the same fixed capacity is
asked to cover more cars, more colours and more decisions per car at every step up the ladder.
This is what §7.2's required *shape* is read against.

### 7.2 Target 1 — constrained-bot clear rate

Over 1,000 seeds per band, with the bot of §7.1.

**These targets are a shape the design requires, not a reading taken off a bot.** The slice-1
report is right that a target retuned to whatever the instrument measures is not a target. What
follows is derived from what the ladder is *for*; if the rebuilt bot misses it, §7.4 applies and
that is a real finding about the game, which is the entire point of having an instrument.

#### 7.2.1 The four requirements

**R1 — Band 1 is not allowed to fail a competent player.** Band 1 is four levels long and it is
where the player learns what a junction does. A competent player who loses level 1 before
understanding the rule does not conclude that they should try harder; they conclude the game is
not for them, and there is no upside to that failure anywhere in the design. **Band 1 clear rate
≥ 95 %**, with no upper bound — 100 % at band 1 is the intended outcome, not a sign the band is
too easy.

**R2 — Every band must be harder than the one below it, measurably.** A band boundary exists to
escalate; if band 3 is not harder than band 2 for the same player model, the boundary is
decoration and §5.1's escalation table is a story rather than a design. **Each band's clear rate
must be at least 4 percentage points below the band above it.** Four points is the smallest gap
that is not sampling noise: the binomial standard error at `p ≈ 0.8` over 1,000 seeds is 1.3 pp,
so 4 pp is about three standard errors.

**R3 — No band boundary may be a wall.** §5.1 adds exactly one axis per step up the ladder — a
column, a colour, a row. One axis should not cost a quarter of the player's runs. **No adjacent
pair of bands may differ by more than 15 percentage points.**

**R4 — Band 5 must have a ceiling, and must stay a reasonable bet.** Band 5 is levels 23 and up;
it is where the player lives. Two bounds, from opposite directions:

- *Upper.* At 80 % a competent player clears four levels in five and the ladder has no top. A
  visible failure rate of at least one run in five is what makes band 5 read as the ceiling
  rather than as band 4 with a bigger number. **≤ 80 %.**
- *Lower.* Expected attempts to clear is `1/p`. At 50 % that is 2 attempts, about 3.7 minutes of
  play per level cleared at band 5's ~110 s. At 33 % it is 3 attempts and 5.5 minutes, which is
  where a retry stops feeling like a rematch and starts feeling like grinding. **≥ 50 %.**

#### 7.2.2 The table

The design band for each level band, chosen inside R1–R4 with room on both sides:

| Band | Clear-rate band | Which requirement pins it |
|---|---|---|
| 1 | **≥ 95 %** | R1 |
| 2 | **86 – 97 %** | R2 against band 1, R3 |
| 3 | **76 – 92 %** | R2, R3 |
| 4 | **66 – 85 %** | R2, R3 |
| 5 | **55 – 78 %** | R4 both ends, inset from 50/80 for headroom |

R2 and R3 are **separately measurable** and are ACs in their own right
([AC-237](acceptance-criteria.md), [AC-238](acceptance-criteria.md)): a run that lands every band
inside its window but with band 2 only 2 pp below band 1 has failed, because the ladder is not
escalating even though every individual number looks fine. That is precisely the failure the
slice-0 targets could not have detected.

An **unconstrained** bot must clear **100 % of seeds at every band with zero misroutes**. That
follows from V1/V5/V6 plus the 1.00 s minimum flip window
([`gameplay.md` §4.7](gameplay.md#47-every-level-is-solvable-provably)), so a failure there is a
generator defect, not a tuning question. ([AC-220](acceptance-criteria.md))

#### 7.2.3 What the slice-0 numbers were, and why they moved

Slice 0 stated 92–100 / 88–99 / 80–96 / 72–90 / 62–84. Those numbers were judgement against an
unbuilt bot, and the slice-1 report showed they had been written against two different implicit
bots at once — §6.3's estimated tap rate matches the `literal` policy's measured rate almost
exactly, while §7.2's clear rate could only have been written with something much more capable in
mind. The bands above are wider and lower because they are now derived from R1–R4 rather than
interpolated, and because the bot they are read off pays for attention. **No lever has been
pulled.** §6.1's parameter table is untouched.

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

**Both targets bind at once.** §7.2 and §7.3 are not independent, and slice 1 showed the trap:
moving band 5's clear rate from 30 % to a 62 % floor by cutting `quota` alone implied a median
duration of about 76 s, which breaks §7.3's 98–122 s band — a band that currently passes at every
seed. **A lever is only pulled if the sweep shows both targets satisfied after the pull.** A
change that fixes §7.2 and breaks §7.3 has not fixed anything.

**Lever 0 — the iso-duration lever. Try this first whenever the clear rate is out of band and the
duration is in band.** Duration is
`≈ SPAWN_LEAD/60 + (quota - 1)·interval/60 + transit`, so the product `(quota - 1)·interval` is
what sets it. Difficulty, however, is set by `interval` alone — how much time separates two cars
is how much attention each one can have. So the two can be moved against each other:

```
interval' = interval + Δ                       // Δ > 0 makes the band easier, Δ < 0 harder
quota'    = 1 + round( (quota - 1) * interval / interval' )
```

This lowers (or raises) difficulty while holding the completion time where it already passes.
Worked, for band 5 at `interval = 96`, `quota = 64`, `SPAWN_LEAD = 90` ticks and a measured
transit of 6.5 s:

| `interval'` | `quota'` | nominal duration | inside §7.3's 98–122 s? |
|---|---|---|---|
| 96 (today) | 64 | 108.8 s | yes |
| 108 | 57 | 108.8 s | yes |
| 120 | 51 | 108.0 s | yes |
| 132 | 47 | 109.2 s | yes |

`interval` must never fall below `2·jitter + 60` ticks, or the minimum flip window drops below
1.00 s and [`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time) stops
being true. There is no upper bound on `interval` other than §7.3.

**If lever 0 is exhausted** — that is, the clear rate is still out of band at the edge of what
§7.3 allows:

- **Clear rate too low:** reduce `quota` further, then reduce `pBranch` (fewer junctions, so
  fewer decisions per car). Do **not** reduce speed — a slower car shortens nothing and a faster
  spawn rate is what makes it hard; reducing speed shortens the planning horizon relative to the
  spawn rate and pushes the game toward reaction.
- **Clear rate too high:** increase `quota`, then raise `pBranch`, then add a colour (`K`) if the
  band's `C` allows it.
- **Median time above band:** reduce `quota`. It is the only term that moves duration without
  changing how the level feels.
- **Median time below band:** increase `quota`.
- **R2 violated (a band is not harder than the one below it):** the fix is never a clear-rate
  lever on the offending band alone. Two adjacent bands that measure the same are one band; the
  correction is to §5.1's escalation — move an axis from the step above down into the step that
  is not escalating.

**What is not a lever.** `BOT_WORKING_SET`, `BOT_MEMORY_TICKS` and every other constant in §7.1
are properties of the instrument, not of the game. Changing one to make a target pass is
adjusting the gauge to match the reading, and it is forbidden. They change only if the *model of
a human player* is shown to be wrong, and then every target is re-read, not just the failing one.

---

## 8. Harnesses this design assumes exist

| Tool | What it must assert |
|---|---|
| `tools/generator-audit.mjs --seeds 5000` | V1–V12 hold for every band × seed; zero `GEN_EXHAUSTED`; report attempt-count percentiles and distinct-network counts per band. |
| `tools/bot.mjs --seeds 1000` | Unconstrained clear rate = 100 %; constrained clear rate within §7.2's table **and** satisfying R2 and R3's shape rules; measured taps/s per band. |
| `tools/bot.mjs --attention-report` | Per band, per 1,000 seeds: mean glances/s, mean focus events/s, the split between `BOT_SWITCH_TICKS` and `BOT_ACQUIRE_TICKS` focuses, mean working-set occupancy, evictions/s, memory expiries/s, and the count of misroutes caused by a flip the bot made for a car it was holding onto a car it was not (`breaksHeldCar` could not see). These are the numbers that say *why* a band lands where it does, and without them a missed target is unexplainable. |
| `tools/pacing.mjs` | Completion-time median / p95 / max per band against §7.3. |
| `tools/replay.mjs --seed N` | A recorded run replays to a deeply equal final state, twice in a row and across machines. |

Per `development-process.md:136`: before any of these is trusted to pass, the fault it is meant
to catch is injected and the harness is confirmed to fail.
