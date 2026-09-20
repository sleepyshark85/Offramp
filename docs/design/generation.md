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
  spawns: [{index, tick, colour}, ...]   // gameplay.md §2.7, length = quota + SPAWN_SLACK(band)
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
  ([`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time)). That is a
  guarantee about **two cars at one junction**, and it is not the game's tightest window: the time
  from **one car appearing** to its first decision is a different quantity, bounded by `ENTRY_LEN`
  rather than by the spawn gap
  ([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)).
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
   entry  y=  60            ┃              (entry edge, 160 LU, straight)
                            ┃
   row 0  y= 220          ╭─◆─╮                          ◆ = junction (branch node)
                          │   ╰──╮                       · = pass node (not drawn)
   row 1  y= 520       ╭──◆──╮   ◆──╮                    ╱╲ = cubic edges
                       │     │   │  ╰──╮
   row 2  y= 820       ·     ·   ·     ·                 (a pass row: four roads run straight)
                       │     │   │     │
   row 3  y=1120       ·   ╭─◆─╮ ◆─╮   ·
                       │   │   ╰─│─╯   │                 (two branches, both rejoining at depots)
   depot  y=1420     ┌───┐┌───┐┌───┐┌───┐
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
ROW0_Y    = 220
DEPOT_Y   = 1420
ENTRY_LEN = ROW0_Y - ENTRY_Y = 160 LU

colW  = min(300, LANE_SPAN / (C - 1))
rowH  = (DEPOT_Y - ROW0_Y) / R = 1200 / R
x(c)  = 500 - colW*(C-1)/2 + c*colW
y(r)  = ROW0_Y + r*rowH
```

**`ROW0_Y` and `DEPOT_Y` both moved down 60 LU in slice 1b, and the route height did not move.**
`ENTRY_LEN` was 100 LU through slices 0 and 1, which put the first junction 450 ms after the spawn
point at band 5 — a decision no player can prepare, on a node every car crosses
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision),
[AC-245](acceptance-criteria.md)). The 60 LU is taken from the blank margin below the depot row,
which was 70 LU and is now 10: `DEPOT_Y + DEPOT_H = 1420 + 170 = 1590` against `DESIGN_H = 1600`,
and the 1.04 receiving scale of [`ui.md` §7.4](ui.md#74-depot) reaches 1593.4. Because
`DEPOT_Y - ROW0_Y` is still 1200, **`rowH`, `colW`, `diagLen`, the junction pitch, `mouthLu` and
every tap-target and device-fit number in [`ui.md` §3.3](ui.md#33-measured-fit-across-real-devices)
and [`ui.md` §4.4](ui.md#44-tap-target-arithmetic) are unchanged**, and so is every generated
topology: the same 2,500 seeds produce byte-identical network signatures before and after. Only the
`y` of every node and the length of one edge per level differ.

That 60 LU is also the whole budget. Buying more by shrinking the route height is blocked by
[`ui.md` §7.6](ui.md#76-the-depot-mouth)'s `mouthLu <= rowH - JUNCTION_MARK_R - 12`: band 5 sits at
`200 - 58 = 142` against `mouthLu = 140`, so its `rowH` cannot go below 198 and `1200 / 6 = 200` is
the last legal value. Anything further would have to move `DESIGN_H`, which rescales every
height-bound device.

All of these are exact integers for every `(C, R)` the bands use:

| `C` | `colW` | column x positions |
|---|---|---|
| 3 | 300 | 200, 500, 800 |
| 4 | 260 | 110, 370, 630, 890 |
| 5 | 195 | 110, 305, 500, 695, 890 |

| `R` | `rowH` | row y positions (row 0 … depot row) |
|---|---|---|
| 3 | 400 | 220, 620, 1020, 1420 |
| 4 | 300 | 220, 520, 820, 1120, 1420 |
| 5 | 240 | 220, 460, 700, 940, 1180, 1420 |
| 6 | 200 | 220, 420, 620, 820, 1020, 1220, 1420 |

The minimum distance between two lattice sites is `min(colW, rowH)`, which is **195 LU** at its
worst (band 4 and 5). That is the number the 44 pt tap-target arithmetic in
[`ui.md` §4.4](ui.md#44-tap-target-arithmetic) is built on, and it is why `C` is capped at 5.

### 3.3 Edge lengths

`straight` edges have length `rowH`. `entry` edges have length `ENTRY_LEN = 160`. Diagonal edges
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
are in §6.2; the worst observed over 15,000 runs is 50.

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
| **V3** | No node other than a depot has in-degree > 1. | `development-process.md:96`. Implied by V2; kept as an independent tripwire (§5.2). |
| **V4** | Every edge has `|Δcol| ≤ 1` and `Δrow = +1`. | The lattice invariant. |
| **V5** | Every depot column is reachable from the entry. | Any colour can spawn; every colour must be routable. |
| **V6** | Every branch node's two branches lead to **different** depot-colour sets. | A junction whose two branches are equivalent is a lie to the player. |
| **V7** | Junction count `J` is within the band's range. | Difficulty. |
| **V8** | Every root-to-depot path has junction depth within the band's `[Dmin, Dmax]`. | No colour is free; no colour is a five-step puzzle. |
| **V9** | At most one node per lattice site; `rows[r].length ≤ C` for all `r`. | Geometry. |
| **V10** | The `K` depot colours are distinct and are exactly the band's first `K` palette entries. | [`ui.md` §5.1](ui.md#51-the-car-palette). |
| **V11** | Minimum distance between any two junction centres ≥ 150 LU. | Tap targets (§3.2). Guaranteed by the lattice; asserted anyway. |
| **V13** | The count of branch nodes whose two branches lead to **incomparable** colour sets — neither set contains the other — is at least the band's `Ja` (§6.1). | `J` is a difficulty claim. A junction that never has to move is not difficulty. |

**V6 subsumes the "no-op junction" case, and V13 subsumes the decorative one.** If both branches
reached the same set, flipping the junction would change nothing for any colour and the player
would learn that tapping sometimes does nothing — that is V6, and it fires: 239 to 1,545 candidates
per band per 3,000 seeds are rejected for it. But *differing* is weaker than *mattering*. Where one
branch's set strictly contains the other's, the superset branch serves every colour the subset
branch does, so a perfect player leaves the junction alone for the whole level. Slice 1 measured
that class at `0 / 29.7 / 13.8 / 26.7 / 14.0 %` of all drawn junctions, and measured its
consequence: band 2 seed 986 draws `J = 5` and plays as 2; band 4 seed 332 draws `J = 6` and plays
as 3; 54 of 3,000 band-1 levels play as `J = 2` in a band whose table says `J = 3` exactly. V13 is
the floor that makes `Ja` in §6.1 true. §6.2 gives what it cost and §5.1 gives what was tried
instead.

### 5.1 Why V6 was not simply strengthened

The obvious repair is to require **every** junction's two sets to be incomparable, rather than
requiring `Ja` of them. It was prototyped against the shipped generator over 300 seeds per band and
it is not a repair:

| Band | attempts med / p95 / max | `GEN_EXHAUSTED` | mean `J` | mean live junctions per run |
|---|---|---|---|---|
| 1 | 5 / 21 / 34 (unchanged) | 0 | 3.00 | 2.99 |
| 2 | **17 / 71 / 131** | 0 | **3.00** (was 4.27) | **3.00** (was 3.48) |
| 3 | 5 / 21 / 39 | 0 | 4.70 (was 5.21) | 4.70 (was 4.59) |
| 4 | **61 / 194 / 251** | **2.0 %** | **5.00** (was 6.45) | **5.00** (was 5.31) |
| 5 | **61 / 212 / 255** | **7.3 %** | **7.00** (was 7.72) | 6.99 (was 6.74) |

Three things go wrong at once. The generator starts failing — `MAX_ATTEMPTS = 256`, and bands 4 and
5 reach it on 2 % and 7.3 % of seeds. The attempt count goes from a median of 2 to a median of 61,
which is the search telling us the constraint is nearly unsatisfiable. And the surviving networks
collapse onto the **bottom** of their `J` range, because the only topologies that satisfy the rule
are the minimal ones — so bands 2 and 4 end up with *fewer* actionable junctions than they have
today. The strengthened rule makes the game easier and the generator unreliable.

The cause is structural and worth stating, because it constrains any future repair. Merge-free
networks are trees except on the terminal row, where V2 lets two edges land on the same depot
(§2.4, [`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-depot-mouth)). Two
branches of a tree reach disjoint depot sets, and disjoint non-empty sets are never comparable —
so **every comparable pair comes from a shared depot.** Forbidding comparable pairs outright
forbids shared depots outright, which is the same topology
[`gameplay.md` §8.8](gameplay.md#88-45s-guarantee-is-narrowed-not-repaired--decided) already
decided to keep and draw correctly rather than generate away. V13 asks for enough actionable
junctions instead of all of them, and costs almost nothing (§6.2).

### 5.2 Which rules actually reject anything

Measured over 15,000 `generate()` calls (3,000 seeds × 5 bands), counting the rule each rejected
candidate died on:

| Band | `V6` | `V7` | `V8` | build failure | `V1` `V2` `V3` `V4` `V5` `V9` `V10` `V11` |
|---|---|---|---|---|---|
| 1 | 239 | 13,638 | 2,147 | 474 | **0** |
| 2 | 1,545 | 729 | 5,837 | 934 | **0** |
| 3 | 253 | 298 | 3,372 | 312 | **0** |
| 4 | 1,004 | 326 | 3,871 | 392 | **0** |
| 5 | 226 | 382 | 3,858 | 18 | **0** |

**Three rules do the filtering. The other eight are structural tripwires**, and saying so is more
honest than presenting eleven checks as if they were eleven filters:

- **V1, V5** — `finalise` builds row `r+1` from the targets of row `r`, so every node has
  in-degree ≥ 1 by construction and reachability follows by induction from row 0; the terminal row
  is built under `buildRow`'s `covered()` check, which is what makes every depot fed. A depot
  count other than `K` is impossible because the depot columns are a `K`-combination.
- **V2, V4** — `buildRow` enforces the running `minTarget` and the `±1` column candidate list as it
  searches; a candidate that violates either is never constructed.
- **V3** — implied by V2, and already labelled as such since slice 0.
- **V9** — row `r+1` is the deduplicated set of row `r`'s targets, and `tryBuild` returns `null`
  when a non-terminal row exceeds `C` columns.
- **V10, V11** — the depot palette is a permutation of `0…K-1` by construction; junction separation
  is a property of the lattice pitch.

This is not an argument for deleting them. It is an argument about **how they are tested**. Slice 1
enumerated every single-edge retarget of 200 band-3 levels and could not make `V5` or `V9` fire
once, because an earlier rule always catches the mutation first — so those checks had never been
executed against a violation, which is the same defect as a check that cannot fail. The audit must
therefore invoke each rule's check **directly**, on a fixture built to violate that rule, rather
than feeding a mutated level through `validate()`'s ordered cascade
([AC-244](acceptance-criteria.md)).

**What is deliberately *not* a rule:** there is no path-length-skew rule and no car-separation
rule. Both are guaranteed by V2 (§2.4), and a rule that cannot fail is not a rule
(`development-process.md:168`).

**And neither is "no branch at row 0" — measured, and rejected.** Slice 1b's first-decision problem
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision))
has an obvious topological repair: forbid the row-0 node from being a branch, so the first junction
sits `ENTRY_LEN + rowH` below the spawn point rather than `ENTRY_LEN`. It was prototyped as a
*construction* constraint rather than a rejection rule — `buildRow` is offered pass options only at
`r = 0` — which is the right shape, and it costs the generator nothing in attempts (median
`1 / 3 / 2 / 3 / 3` against the shipped `5 / 3 / 2 / 3 / 3`, max 33, zero exhaustions over 3,000
seeds per band; as a rejection rule instead it would reach `MAX_ATTEMPTS` on 2 seeds per 1,000 at
band 5 and blow [AC-203](acceptance-criteria.md)'s ceiling). V13 survives it: `Ja` still sits at its
floor in 100 % of levels at bands 1, 2, 4 and 5.

It fails on variety and on over-correction. Distinct **edge topologies** over 3,000 seeds per band
fall `38 / 1033 / 652 / 1882 / 962` → `13 / 556 / 248 / 1542 / 829`, which breaks
[AC-234](acceptance-criteria.md) at band 1 and band 3 — and band 1, four levels long, would be
drawing from thirteen shapes. Drawn `J` also collapses toward the bottom of every band's range
(band 5 goes from `7:3 % 8:97 %` to `7:14 % 8:86 %`, band 4 from `5:5 6:25 7:70` to
`5:15 6:51 7:34`) while `Ja` barely moves, which is §6.1's point about the `J` axis restated from
the other side. And the constrained bot clears `100 / 100 / 99.9 / 96.9 / 25.0 %` with it in force,
failing [AC-240](acceptance-criteria.md) at bands 1–4 for want of headroom: removing the row-0
decision removes so much load that attention stops binding until band 5. The window had to be made
fair, not deleted, and §3.2's 60 LU does that without touching a single topology.

**Integer geometry is a construction guard, not a validity rule.** §3.2 derives `colW` and `rowH`
by division, and nothing in the search makes the result integral — the integrality of every shipped
band is a property of the five rows in §6.1, so the first band-table edit that picks a non-divisor
of 780 or 1200 would produce a level `generate()` accepts, with float node positions and a float
`progress` accumulating inside the simulation. That is a broken *band table*, not an unlucky
candidate, so retrying cannot fix it and it must **throw** rather than return a rule id
([AC-218](acceptance-criteria.md)). It is therefore deliberately outside the V-numbering; `V13` is
the actionable-junction floor above and nothing else.

---

## 6. Difficulty parameters per band

### 6.1 The table

| Band | Levels | `C` | `K` | `R` | `pBranch` | `J` | `Ja` | `D` | `rowH` | `colW` | `diagLen` | Speed MLU/tick | LU/s | Interval | Jitter | Quota | `SPAWN_SLACK` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | 3 | 3 | 3 | 0.85 | 3 | 3 | 2 | 400 | 300 | 521 | 3000 | 180 | 156 | ±12 | 16 | 8 |
| 2 | 5–9 | 4 | 3 | 4 | 0.70 | 3–5 | 3 | 2–3 | 300 | 260 | 415 | 3200 | 192 | 138 | ±12 | 26 | 9 |
| 3 | 10–15 | 4 | 4 | 4 | 0.80 | 4–6 | 4 | 2–3 | 300 | 260 | 415 | 3400 | 204 | 120 | ±18 | 36 | 9 |
| 4 | 16–22 | 5 | 4 | 5 | 0.80 | 5–7 | 5 | 2–4 | 240 | 195 | 323 | 3600 | 216 | 108 | ±18 | 48 | 9 |
| 5 | 23+ | 5 | 5 | 6 | 0.88 | 7–8 | 7 | 2–4 | 200 | 195 | 293 | 3800 | 228 | 96 | ±18 | 64 | 10 |

`D` is `[Dmin, Dmax]` over all root-to-depot paths. `J` is `[Jmin, Jmax]`, the count of junctions
**drawn**. `Ja` is the floor on junctions that are **actionable** — V13, §5 — and it is a minimum,
not a range: a level may exceed it. `SPAWN_SLACK` is not a free parameter; it is derived per band
in [`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)
and reproduced here only so the whole per-band vector reads from one table.

**`Ja` is set to `Jmin`, and that is not a coincidence of convenience.** It is close to the most
the topology can carry: measured with V13 in force, `Ja` comes out at exactly its floor in 100 % of
levels at bands 1, 2, 4 and 5, and at 4 or 5 at band 3. The reason is that actionable junctions are
bounded by what there is to decide — with `K` colours a path of decisions can sort at most `K`
destinations, so actionable `J` tracks `K`, not the drawn junction count. **Above the floor, the
band table's `J` axis is mostly the `K` axis in disguise.** [`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order)'s escalation ladder already leans
on `K` for the two biggest steps; this says the `J` steps are doing less than they appear to, and
whoever next pulls a lever should reach for `K` or `interval` before `pBranch`.

### 6.2 Measured generator behaviour

Measured over **3,000 seeds per band**, 15,000 runs total, against the shipped generator with V13
in force:

| Band | Valid networks | Attempts: median / p95 / max | Distinct networks | `J` distribution | `Ja` distribution | `D` range |
|---|---|---|---|---|---|---|
| 1 | 3000 / 3000 | 5 / 19 / 50 | 190 | J=3: 100 % | 3: 100 % | 2 |
| 2 | 3000 / 3000 | 3 / 11 / 27 | 1867 | J=3: 18 %, 4: 37 %, 5: 45 % | 3: 100 % | 2–3 |
| 3 | 3000 / 3000 | 2 / 7 / 16 | 1802 | J=4: 13 %, 5: 40 %, 6: 48 % | 4: 26 %, 5: 74 % | 2–3 |
| 4 | 3000 / 3000 | 3 / 10 / 22 | 2678 | J=5: 4 %, 6: 25 %, 7: 71 % | 5: 100 % | 2–4 |
| 5 | 3000 / 3000 | 2 / 9 / 23 | 2236 | J=7: 3 %, 8: 97 % | 7: 100 % | 2–4 |

**What V13 cost.** The same generator without V13, at the same 3,000 seeds per band: attempts
`5 / 3 / 2 / 2 / 2` median, `19 / 11 / 6 / 8 / 6` p95 and `50 / 27 / 14 / 17 / 20` max; distinct
networks `190 / 1867 / 1981 / 2773 / 2507`; `J` distributions `3:100 %` / `3:18 4:37 5:45` /
`4:20 5:39 6:41` / `5:11 6:32 7:57` / `7:29 8:71`; decorative junctions
`0.0 / 29.6 / 13.5 / 26.7 / 14.1 %` of drawn `J`. So V13 costs:

- **No exhaustions and no material attempt cost.** Median attempts move `5/3/2/2/2` → `5/3/2/3/2`,
  p95 `19/11/6/8/6` → `19/11/7/10/9`, worst case 50 against a `MAX_ATTEMPTS` budget of 256 and an
  [AC-203](acceptance-criteria.md) ceiling of 128. Bands 1 and 2 come out **bit-identical** — their
  networks already satisfied the floor — which matters because band 1 has the smallest space in the
  game, 37 edge topologies, and is the band a stricter rule would have broken first.
- **Under 11 % of network variety.** Distinct signatures fall by 0 / 0 / 9 / 3 / 11 %, all far
  above [AC-234](acceptance-criteria.md)'s floors of 30 and 500.
- **A shift in the `J` distribution toward the top of each range**, which is why the `J` rows above
  differ from slice 0's and why [AC-211](acceptance-criteria.md)'s 5-point tolerance is measured
  against *this* table, not the old one.

**Actionable junctions, measured rather than assumed.** A *lazy-optimal oracle* is the reference
reading, and it is normative because §6.2 is cited by [AC-243](acceptance-criteria.md): at each
tick, for every car that will transition onto a branch node during that tick's advance, if the
junction's currently open branch cannot reach that car's colour, flip it — and never otherwise.
This is what a perfect player does, it delivers every car at every band, and the junctions it never
flips are the junctions the level never asked about.

| Band | drawn `J`, mean | live junctions, mean / min | flipped ≥ 2×, mean / min | levels below `Ja` |
|---|---|---|---|---|
| 1 | 3.00 | 2.98 / 2 | 2.93 / 2 | 1.6 % |
| 2 | 4.30 | 3.48 / 2 | 2.99 / 2 | 0.2 % |
| 3 | 5.34 | 4.81 / 4 | 4.70 / 3 | 0.0 % |
| 4 | 6.65 | 5.54 / 4 | 4.98 / 4 | 0.0 % |
| 5 | 7.95 | 7.07 / 6 | 6.95 / 5 | 0.2 % |

Two things to read here. First, live count still trails drawn `J` — decorative junctions are
allowed above the floor, and that is deliberate: they are real branches that real cars take, they
are part of reading the board, and §5.1 shows that eliminating them costs the generator more than
they cost the player. Second, a residue of levels plays below `Ja` even with V13 in force, at
1.6 % and 0.2 % at bands 1, 2 and 5. **That residue is spawn order, not topology**, and no static
rule removes it: a junction can be structurally actionable and still never be exercised, because
which colours reach it depends on how the upstream junctions were left. It is bounded and it is now
reported every audit run rather than being invisible, which is the most that is available.

**Band 1's network space is genuinely small** — 190 distinct signatures over 3,000 seeds, and only
37 distinct *edge topologies* once the depot-colour permutation is factored out, because `C = 3`,
`R = 3` and `J = 3` leaves little to vary. Band 1 is four levels long, so this is acceptable, but it
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

The **cars in flight** column is a mean. The *maximum* is what sizes the spawn schedule, and it is
derived separately in
[`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed) —
`5 / 5 / 6 / 6 / 7` against an observed worst of `4 / 5 / 5 / 5 / 6`. The two columns are not in
conflict; reading the mean as the maximum is how the spawn margin came to be one car at band 5.

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
| **That a car has just appeared, and where** | An abrupt visual onset is detected pre-attentively and is the classic exogenous capture cue; it does not require a glance, and in this game every onset happens at one fixed location the player already knows. This buys the bot **an ordering of the sweep and nothing else** — it still pays `BOT_SCAN_TICKS` to glance and `BOT_ACQUIRE_TICKS` to read the colour. The sweep has always read `sim.cars` for free to decide where to look next (§7.1.5 D3); this changes *which* free ordering, not whether the ordering is free. [`ui.md` §7.5](ui.md#75-car) is what makes it true of the drawing ([AC-517](acceptance-criteria.md)). |

| **Not** given free | Why |
|---|---|
| **Which car to look at next, among the cars already on screen** | A player is not handed a list sorted by urgency. The bot scans them in a fixed spatial round-robin (§7.1.5 D3), which is frequently the wrong order. The one exception is the row above, and it is an exception about an *event*, not about a ranking: an onset says "something appeared there", never "this is the one that needs you most". |
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
                         //   the operation it was always meant to price. A newly spawned car pays
                         //   this in full like any other car not yet held; what a spawn changes is
                         //   only WHEN it is glanced at (§7.1.5 D3), never what the glance costs.

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
  cursor:      carId | null,  // where the round-robin sweep is
  maxSeen:     carId,         // -1 at tick 0. The highest id that has ever been glanced at,
                              //   which is how an un-glanced onset is identified (§7.1.5 D3).
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

  // ── D. GLANCE. One car per BOT_SCAN_TICKS. This is the only way the bot ever learns a
  //       car's COLOUR, and the only way it ever binds one to a moving object.
  D1  bot.busyUntil = T + BOT_SCAN_TICKS
  D2  if sim.cars is empty:  return []
  D3  // Onset capture, then the round-robin sweep. See below.
      g = the smallest id in sim.cars strictly greater than bot.maxSeen, if any
      if g exists:
          bot.maxSeen = g
          glanceAt = g                          // the cursor is NOT moved
      else:
          bot.cursor = nextCarId(sim.cars, bot.cursor)
          glanceAt   = bot.cursor
          bot.maxSeen = max(bot.maxSeen, glanceAt)
  D4  r = bot.rng.next()                       // exactly one draw per glance; nowhere else
      if r % 100 < BOT_LAPSE_PCT:  return []   // the glance did not land
  D5  c = the car in sim.cars with id glanceAt
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

**The sweep, and the onset that interrupts it.** `nextCarId(cars, cursor)` is the smallest id in
`cars` strictly greater than `cursor`; if there is none, or `cursor` is `null`, the smallest id in
`cars`. `sim.cars` is ascending by id (`gameplay.md` §2.4), so this is a total, deterministic,
cyclic sweep and needs no sort. Because ids are spawn order and every car moves at the same speed,
the round-robin runs from the car nearest the depots back up to the newest — a fixed spatial sweep,
**not** an urgency ordering: the car it visits is frequently one with nothing left to decide.

**A car that has never been glanced at goes next, exactly once.** That is D3's `g` branch, and it
is the only thing in this section that changed in slice 1b round 5. Three properties make it a
statement about a person rather than a gift to the instrument, and all three are load-bearing:

- **It is an ordering, not an action.** The glance still costs `BOT_SCAN_TICKS`, the focus still
  costs `BOT_ACQUIRE_TICKS`, and the evaluation still costs its tick. Nothing is free that was
  not free before: `nextCarId` has always read `sim.cars` without paying, because deciding
  *where to look* is not the same act as *looking*. §7.1.8 rejects a repair that made the
  looking free; this does not touch it.
- **It fires once per car.** `maxSeen` is monotone, so an onset captures attention on its first
  glance opportunity and never again; afterwards the car is an ordinary member of the
  round-robin. Measured, captures are exactly one per spawned car — `0.38 / 0.43 / 0.50 / 0.55 /
  0.62` per second against spawn rates of `0.385 / 0.435 / 0.500 / 0.556 / 0.625` — and 5.3 % to
  12.6 % of all glances by band.
- **It is taken out of the same budget.** Total glances per second are unchanged
  (`7.19 / 6.39 / 6.00 / 5.41 / 4.90` against `7.19 / 6.47 / 6.08 / 5.47 / 4.93`), so the
  capture is a *reallocation*. It is paid for by the rest of the board: working-set evictions
  per second rise `0.000 / 0.032 / 0.137 / 0.377 / 0.665` → `0.000 / 0.046 / 0.201 / 0.486 /
  0.759`, and the per-decision failure rate at junctions **other** than the first rises at bands
  3–5. Attending to a newborn car costs the cars already in flight, which is the correct shape
  for a model of divided attention.

**The cursor is not moved by a capture.** Clobbering it was the defect in one of §7.1.8's
variants: it restarted the round-robin from the newest car every spawn and starved everything
older. `maxSeen` and `cursor` are independent, and the round-robin resumes exactly where it was.

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

#### 7.1.7 The first-decision deadline, and why the bot must not be given it for free

A glance costs `BOT_SCAN_TICKS = 6`; escalating to a car the bot is not holding costs
`BOT_ACQUIRE_TICKS = 15` on top, so the earliest a tap can be emitted is 21 ticks after the glance
lands, and `BOT_LOCKOUT_TICKS = 6` of runway must still remain. So for a car whose first junction is
`firstDecisionTicks` away at spawn
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)),
a glance must **land** by car age `firstDecisionTicks - 27` when the car is cold, or
`firstDecisionTicks - 16` when it is already held (`BOT_SWITCH_TICKS` in place of the acquire):

| Band | `firstDecisionTicks` when row 0 is a branch | cold deadline (car age) | as real time | was, at `ENTRY_LEN = 100` |
|---|---|---|---|---|
| 1 | 54 | 27 | 450 ms | 7 |
| 2 | 50 | 23 | 383 ms | 5 |
| 3 | 48 | 21 | 350 ms | 3 |
| 4 | 45 | 18 | 300 ms | 2 |
| 5 | 43 | **16** | **267 ms** | **0** |

The last column is the same arithmetic under the 100 LU `ENTRY_LEN`: at band 5 the deadline was
**zero ticks** — the glance had to land on the tick the car spawned — and the bot duly emitted
**zero** taps at the row-0 junction across 269 levels that had one. That is what
[AC-240](acceptance-criteria.md) caught when it failed at bands 4 and 5 — not an insensitive
instrument, but a deadline no model of a person could meet, correctly reported.

**The deadline was only one side of the inequality, and fixing it alone did not close it.** The
other side is the **latency to the first glance**, and under a pure round-robin that is a function
of how many cars are in flight, not of the deadline. A new car has the largest id, so the sweep
reaches it only after every older car; a glance costs 6 ticks and a glance that escalates costs 21
or 10 more. With `3.3 – 4.1` cars in flight (§6.3) the wait for the newest car's first glance runs
to 24 ticks of pure scanning and well past 40 when the cycle contains a focus or two. Set the two
columns side by side:

| Band | cold deadline (ticks) | round-robin scan cycle, `6 × cars in flight` | binds? |
|---|---|---|---|
| 1 | 27 | 20 | deadline wins |
| 2 | 23 | 21 | marginal |
| 3 | 21 | 23 | latency wins |
| 4 | 18 | 23 | latency wins |
| 5 | 16 | 25 | latency wins |

**The deadline shrinks with speed; the latency grows with traffic; they cross between bands 2 and
3.** `ENTRY_LEN = 160` moved the left column up by 20 ticks and the crossing moved up two bands
with it — which is why the measured clear rate improved at every band and the *shape* of the
failure did not change at all. Round 5 measured what that shape cost: see §7.1.10.

#### 7.1.8 Two repairs at the spawn point: one rejected twice, one adopted

Slice 1b proposed letting a spawn be **anticipated**, because the spawn point is the one location
on screen a person can watch in advance. Round 5 separated that proposal into two claims that had
been travelling together, measured both, and reached opposite verdicts. The distinction is the
whole content of this section.

**Rejected, and for the second time: a newborn car is attended to immediately and for free.** Both
variants built in round 4 found the car at its known static location without paying
`BOT_SCAN_TICKS`. That breaks the invariant that makes §7.1 a model of attention at all: every act
of attention consumes time. A zero-cost glance sets `busyUntil = T`, so a glance that then fails
D5's urgency gate costs nothing and is retaken on the very next tick — and again, for as long as
any car sits on the entry edge. One arm spent all 54 of those ticks re-glancing at a car it had
already decided was not urgent and did nothing else; its clear rates went **non-monotonic across
the ladder** — `53.8 / 90.6 / 29.5 / 14.1 / 0.4 %`, band 1 forty points below band 2 — which no
difficulty model may be. A second variant that preserved the sweep cursor removed the starvation
and kept the inversion: `99.2 / 99.9 / 95.4 / 65.2 / 4.4 %`. **This stays rejected.** Attending to
every newborn car at the instant it appears, for nothing, is a priority inversion and not a model
of a person.

**Adopted: a car that has never been glanced at is next in the sweep, at full price.** This is a
different claim and round 4 never tested it. It changes *where attention goes next* and nothing
else: the glance costs its 6 ticks, the focus costs its 15, the evaluation costs its tick, the
cursor is untouched, and the capture fires once per car. The case for it is that the round-robin
was making a specific and wrong claim about people — that a person checks a newly appeared object
**last**, after every object already on screen. An abrupt visual onset is the canonical exogenous
capture cue; new objects are prioritised, not deferred. §7.4 says a §7.1 rule changes only when
the model of a human player is shown to be wrong, and this is that case. The rule is in §7.1.5 D3
and what it does and does not buy is in §7.1.2's table.

**What it does to the measurement**, 1,000 seeds per band, the only change being D3. Every
junction a car actually crosses is classified as that car's **first** decision or a **later** one,
and the figure is the share of each class the car left on a branch that cannot reach its colour —
[AC-246](acceptance-criteria.md)'s definition, and the only definition of `p` used anywhere in
these documents:

| Band | `p_first` | `p_later` | gap | before D3: `p_first` / `p_later` / gap |
|---|---|---|---|---|
| 1 | **0.38 %** | 0.77 % | **−0.39 pp** | 1.78 % / 0.55 % / +1.23 |
| 2 | **0.37 %** | 0.57 % | **−0.20 pp** | 4.25 % / 0.54 % / +3.71 |
| 3 | **0.71 %** | 0.67 % | **+0.04 pp** | 6.85 % / 0.43 % / +6.42 |
| 4 | **1.54 %** | 1.54 % | **+0.00 pp** | 9.56 % / 1.21 % / +8.35 |
| 5 | **4.58 %** | 3.94 % | **+0.63 pp** | 14.72 % / 2.91 % / +11.80 |

The first decision was between 5× and 16× less reliable than a later one at bands 2–5, and 3× at
band 1. It is now indistinguishable from one, and at bands 1 and 2 it is *more* reliable — which is what a captured
decision should be, and is the check that the rule did something specific rather than something
general. Band 1 is the control: it never had the defect (`+1.23 pp`, inside its own ceiling) and
D3 leaves it alone. §7.1.10 says why `p` is the number to read and the clear rate is not, and
[AC-246](acceptance-criteria.md) is the guard.

**Why the geometry lever was not pulled again instead.** The two act on the same quantity and the
geometry one is exhausted. Priced over 300 seeds per band with the round-robin sweep left alone,
growing `ENTRY_LEN` from 160 to 280 LU takes the AC-246 gap to
`−0.37 / −0.14 / −0.19 / −0.22 / +0.65` pp — it passes, and lands within a tenth of a point of D3
at band 5 — but §3.2's 60 LU was the entire vertical budget and 120 LU does not exist: the margin
below the depot row is 10 LU, `rowH` cannot fall below 198, and the rest would have to come out of
`DESIGN_H`, which rescales every height-bound device in [`ui.md` §3.3](ui.md#33-measured-fit-across-real-devices).
It would also raise `transitMax`, hence `inFlightMax`, hence `SPAWN_SLACK`, at every band. D3 costs
the generator, the geometry and the layout **nothing**: no rule, no constant and no node moves.

**And it is not a third bite at forbidding a branch at row 0.** That repair is still rejected on
the grounds §5.2 gives — it breaks [AC-234](acceptance-criteria.md)'s variety floor at bands 1 and
3, band 1 falling to thirteen edge topologies — and it is now also rejected on a second measurement:
it is exactly the row-0-pass arm, which D3 shows clears `99.8 / 100 / 99.6 / 92.8 / 10.9 %`. It
deletes the decision. D3 makes it reachable.

#### 7.1.9 Why this is expected to bind, arithmetically

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

#### 7.1.10 Why the clear rate is the wrong number to reason about, and which number is not

Round 5 was asked to remove a **bimodality**, not to move a clear rate: with `ENTRY_LEN = 160`,
V13 in force and everything in §7.1 implemented, band 4 cleared **0.4 %** of the levels whose
row-0 node is a branch and **95.7 %** of the rest, over 1,000 seeds. A parameter that yields
either ~96 % or ~0 % is not measuring skill. This subsection is the arithmetic that explains both
why the split was that violent and why it is not a reason to distrust the design's shape.

**A level clears when it collects at most `LIVES - 1 = 2` misroutes across `quota` cars.** So if a
level asks `N` roughly independent per-car questions and the player answers each wrongly with
probability `p`, the clear rate is `P(Binomial(N, p) <= 2)` — a **threshold function of `p`**, with
its knee at `p* = 2/N`:

| Band | `quota` | `p* = 2/quota` | `p` that produces the band's easiest allowed clear rate | …its hardest | width of the window |
|---|---|---|---|---|---|
| 1 | 16 | 12.50 % | 0 % | 5.32 % | 5.32 pp |
| 2 | 26 | 7.69 % | 2.63 % | 5.02 % | 2.40 pp |
| 3 | 36 | 5.56 % | 2.81 % | 4.71 % | 1.90 pp |
| 4 | 48 | 4.17 % | 2.79 % | 4.29 % | 1.50 pp |
| 5 | 64 | 3.12 % | 2.53 % | 3.85 % | 1.33 pp |

**Read the two inner columns as one interval and the consequence is the governing fact of this
design: every one of bands 2–5 lies inside per-car failure rates of 2.5 % to 5.0 %, and band 1's
only bound is 5.3 %.** Every difficulty statement this project makes is a claim about **2.5
percentage points** of per-car reliability, and four of the five bands are stacked inside it.
Three things follow, and they are not negotiable by tuning:

1. **Any structural bit that moves `p` by more than about a point is a switch, not a dial.** It
   does not matter what the bit is. The dynamic range of bands 2–5 is **2.5 pp** — 2.53 % at the
   easiest end of band 5's window to 5.02 % at the hardest end of band 2's. Before round 5 the
   first decision ran `1.23 / 3.71 / 6.42 / 8.35 / 11.80` pp worse than a later one (§7.1.8),
   which at bands 2–5 is **1.5 to 4.7 times the width of that whole range**, on the one decision
   every car in the level has to make. Of course the clear rate went to the rails. The 96-point
   swing was the amplifier working correctly on an 8-point input.
2. **No difficulty lever can repair a defect of that size, and measuring it proves it.** Sweeping
   §7.4's lever 0 across band 5 under the unrepaired bot — `interval` 96 → 156, `quota` 64 → 40, a
   63 % change with the duration held at 110–113 s — moves the overall clear rate `2.3 → 44.8 %`
   while the split stays between 22 and 97 pp and gets *worse* in the middle: the pass arm
   saturates at 100 % long before the branch arm leaves the floor. That is the demonstration that
   the row-0 split was never a difficulty parameter. Under the repaired D3 the same sweep moves
   both arms together and the split falls as the band approaches its target — band 5 reads
   `2.3 / 34.0 / 65.3 / 69.3 / 80.8 / 94.5 %` with splits of `5.6 / 19.2 / 22.4 / 28.8 / 18.7 /
   3.4` pp.
3. **The number to state a target against, and to regress against, is `p`, not the clear rate.**
   `p` is unamplified, it is measurable per decision rather than per level, and a 1 pp change in it
   is legible where the same change shows up as anything between 0 and 60 points of clear rate
   depending on where the band happens to sit. [AC-246](acceptance-criteria.md) is written in `p`
   for exactly this reason, and it is the only guard in the design that can fail *early*.

**What survives after D3, and why it is allowed to.** The row-0 split does not go to zero: at
1,000 seeds it reads `0.2 / 1.0 / 3.2 / 30.2 / 9.2` pp. The residue at band 4 is not a reliability
gap — `p_first` and `p_later` are both 1.54 % — it is that a level whose
row-0 node is a branch **asks every car one more question**, and one more question per car is what
the difficulty ladder is made of. Conditioned the other way round at band 4 — over buckets of at
least 20 levels each — the mean junction depth over paths spreads the clear rate by **36.2 pp**
(88.0 % at depth 3.00 against 51.8 % at 3.25) and drawn `J` spreads it by 12.0 pp (77.1 % at
`J = 6` against 65.1 % at `J = 7`); the row-0 bit's 30.2 pp now sits *between* them instead of
dwarfing both at 95.3. It has stopped being a coin flip and become one unit of depth, which is
what it physically is. A design that wanted it smaller than that would have to stop varying depth,
and §6.1 is built on varying depth.

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
decoration and [`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order)'s escalation table is a story rather than a design. **Each band's clear rate
must be at least 4 percentage points below the band above it.** Four points is the smallest gap
that is not sampling noise: the binomial standard error at `p ≈ 0.8` over 1,000 seeds is 1.3 pp,
so 4 pp is about three standard errors.

**R3 — No band boundary may be a wall.** [`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order) adds exactly one axis per step up the ladder — a
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

#### 7.2.4 What the instrument reads now, and what is left to do about it

Two readings preceded this one and both were off gauges with a known defect. Slice 1b's numbers
were taken when the row-0 decision was arithmetically unreachable (§7.1.7). Round 3's were taken
with `ENTRY_LEN = 160` in code but the round-robin sweep still visiting the newest car last, and
they were **bimodal**: the clear rate was still approximately a function of the row-0 bit, with
band 4 at 0.4 % on one arm and 95.7 % on the other (§7.1.10). This is the first reading in which
the first decision is as reliable as every other decision, which is the condition under which the
clear rate is a statement about difficulty at all.

1,000 seeds per band, `ENTRY_LEN = 160`, V13 in force, §7.1.5 D3 as written:

| Band | clear rate | §7.2.2 band | row-0 split in clear rate | `p_first` − `p_later` | AC-246 ceiling | median s |
|---|---|---|---|---|---|---|
| 1 | **99.9 %** | ≥ 95 % — **in band** | 0.2 pp | −0.39 pp | 3.13 | 49.3 |
| 2 | 99.3 % | 86–97 % — **above** | 1.0 pp | −0.20 pp | 1.92 | 67.7 |
| 3 | 97.2 % | 76–92 % — **above** | 3.2 pp | +0.04 pp | 1.39 | 79.9 |
| 4 | 68.9 % | 66–85 % — **in band** | 30.2 pp | +0.00 pp | 1.04 | 95.2 |
| 5 | 2.6 % | 55–78 % — **below** | 9.2 pp | +0.63 pp | 0.78 | 112.1 |

Against the previous reading of `98.3 / 77.9 / 40.1 / 20.3 / 2.0 %`, with splits of
`3.8 / 32.7 / 80.1 / 95.3 / 19.8` pp and AC-246 gaps of `+1.23 / +3.71 / +6.42 / +8.35 / +11.80`.
**Band 5's `+0.63` against a ceiling of `0.78` is the thinnest margin in the table and is the one
number here to watch on the next lever pull**, because lever 0 moves `quota` and the ceiling is a
function of `quota`: raising `interval` and cutting `quota` *loosens* it, which is the direction
the band needs anyway, but cutting `interval` anywhere would tighten it. **The targets have not moved and are not going to**, for the
reason §7.2 opens with. What has changed is that the numbers above are now readable: bands 1 and 4
are in band, bands 2 and 3 are above it, band 5 is far below it, and each of those is a difficulty
statement that a §7.4 lever can act on — which §7.1.10 demonstrates by sweeping one.

**R2 and R3 both fail, and differently from before.** R2's ≥ 4 pp gradient fails at 1→2 (0.6 pp)
and 2→3 (2.1 pp) because bands 1–3 are all pressed against the ceiling; R3's ≤ 15 pp wall rule
fails at 3→4 (28.3 pp) and 4→5 (66.3 pp). Both are now what they claim to be — statements that the
*ladder* is mis-spaced — rather than artefacts of a bit the generator flips. **Closing them is
§7.4's lever order, starting at lever 0, and it is the next round's work and not this one's.** The
shape of the answer is visible in §7.1.10's lever sweep: band 5's clear rate is a smooth, monotone
function of `interval` at a fixed duration, which is the property a tunable band has and the
previous gauge did not.

Completion times are unaffected by D3 and remain in band at every level: medians
`49.3 / 67.7 / 79.9 / 95.2 / 112.1 s` against §7.3's windows, slowest cleared run anywhere
113.4 s against the 130 s ceiling.

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

**Three targets bind at once, not two.** [AC-246](acceptance-criteria.md) joined §7.2 and §7.3 in
round 5: the per-car failure rate at a car's **first** decision may not exceed the rate at its
other decisions by more than a quarter of the band's per-car life budget, `0.25 × 2/quota` —
`3.13 / 1.92 / 1.39 / 1.04 / 0.78` pp by band. It binds on every lever pull because every lever
below moves `quota` and therefore moves the threshold, and because §7.1.10 shows it is the only
one of the three that is not amplified: a 1 pp drift in it is invisible in the clear rate until it
is a 40-point cliff. A lever pull that satisfies §7.2 and §7.3 while widening that gap has bought
a number and sold the game.

**And the other two bind at once.** §7.2 and §7.3 are not independent, and slice 1 showed the trap:
moving band 5's clear rate from 30 % to a 62 % floor by cutting `quota` alone implied a median
duration of about 76 s, which breaks §7.3's 98–122 s band — a band that currently passes at every
seed. **A lever is only pulled if the sweep shows both targets satisfied after the pull.** A
change that fixes §7.2 and breaks §7.3 has not fixed anything.

**Every lever move re-derives the spawn margin.** `SPAWN_SLACK` is a function of `interval`,
`speedMluPerTick`, `R` and the band's geometry
([`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)),
and the two levers below that move `interval` move it. A lever pull is not applied until
`SPAWN_SLACK` has been recomputed from the new parameters **and**
[AC-139](acceptance-criteria.md)'s oracle sweep has been re-run and still shows a margin of at
least 2 spawns at every band. Slice 1 is the worked example: the flat
`SPAWN_SLACK = 8` had eroded to a margin of one car at band 5 without anything failing, and the
"clear rate too high" lever below — raise `quota`, then cut `interval` — was pointed straight at
what was left. Treat the margin as a target that binds alongside §7.2 and §7.3, not as a constant
that happens to hold.

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

**And the second floor, which is the one that was missed.** `speedMluPerTick` is not a lever (see
below), but if it ever becomes one, or if `ENTRY_LEN` is ever shortened to reclaim vertical space,
`ceil(ENTRY_LEN * MLU / speedMluPerTick)` must stay at or above 40 ticks
([AC-245](acceptance-criteria.md),
[`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)).
`interval` does not appear in it: that is precisely why §4.6's argument, which is about `interval`,
could be correct and still leave this window at 450 ms.

**If lever 0 is exhausted** — that is, the clear rate is still out of band at the edge of what
§7.3 allows:

- **Clear rate too low:** reduce `quota` further, then reduce `pBranch` (fewer junctions, so
  fewer decisions per car). Do **not** reduce speed — a slower car shortens nothing and a faster
  spawn rate is what makes it hard; reducing speed shortens the planning horizon relative to the
  spawn rate and pushes the game toward reaction.
- **Clear rate too high:** increase `quota`, then add a colour (`K`) if the band's `C` allows it,
  then raise `pBranch`. *`pBranch` is last, and it is the weakest of the three: §6.1 shows that
  actionable junctions track `K` rather than the drawn junction count, so raising `pBranch` buys
  scenery and tap targets more reliably than it buys decisions. If it is pulled, AC-242 and AC-243
  are re-measured with it — a `pBranch` rise that moves `J` without moving `Ja` has not made the
  band harder.*
- **Median time above band:** reduce `quota`. It is the only term that moves duration without
  changing how the level feels.
- **Median time below band:** increase `quota`.
- **R2 violated (a band is not harder than the one below it):** the fix is never a clear-rate
  lever on the offending band alone. Two adjacent bands that measure the same are one band; the
  correction is to [`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order)'s escalation — move an axis from the step above down into the step that
  is not escalating.

**What is not a lever.** `BOT_WORKING_SET`, `BOT_MEMORY_TICKS` and every other constant in §7.1
are properties of the instrument, not of the game. Changing one to make a target pass is
adjusting the gauge to match the reading, and it is forbidden. They change only if the *model of
a human player* is shown to be wrong, and then every target is re-read, not just the failing one.

§7.1.5's D3 is the worked example of that exception and of its price. The round-robin claimed that
a person checks a newly appeared object last; that claim is wrong about people, so the rule
changed — and **every** target was re-read against the new gauge, not only the one that had been
failing (§7.2.4). Two tests distinguish that from tuning the gauge, and a future proposal should
be made to answer both. Did the change buy the bot anything it did not already have for free? D3
reorders a read of `sim.cars` that `nextCarId` was already making for nothing, and adds no action
and removes no cost. Is the effect specific? The quantity D3 was argued to fix — the first
decision's reliability — moved by a factor of 5 to 15 at every band, while total glances per
second did not move at all, and the cost landed where the argument said it would, on the cars
already in flight. A change that improves every number a little is a change to the gauge.

---

## 8. Harnesses this design assumes exist

| Tool | What it must assert |
|---|---|
| `tools/generator-audit.mjs --seeds 5000` | V1–V13 hold for every band × seed; zero `GEN_EXHAUSTED`; report attempt-count percentiles, per-rule rejection counts (§5.2) and distinct-network counts per band. Also, per band, the **minimum `firstDecisionTicks`** over every path of every level against [AC-245](acceptance-criteria.md)'s floor of 40 — it is the cheapest possible check and the quantity it guards went unmeasured through two slices. |
| `tools/generator-audit.mjs --rule-injection` | For each of V1–V11 and V13, a fixture that violates that rule, with the rule's check invoked **directly** rather than through `validate()`'s cascade, confirmed to reject it ([AC-244](acceptance-criteria.md)). Eight of the twelve are unreachable through `generate()` (§5.2) and this is the only place their checks are ever executed against a violation. |
| `tools/generator-audit.mjs --actionable --seeds 3000` | Per band: mean and minimum live-junction count under §6.2's lazy-optimal oracle, the share of levels below `Ja`, the mean count of junctions flipped twice or more, and the decorative-junction share of drawn `J` ([AC-243](acceptance-criteria.md)). |
| `tools/spawn-margin.mjs --seeds 2000` | Per band, both oracle variants, two misroutes injected: the worst `max(nextSpawn)` and the resulting margin against `spawns.length`, which must be ≥ 2 ([AC-139](acceptance-criteria.md)). Re-run after every §7.4 lever move. |
| `tools/bot.mjs --seeds 1000` | Unconstrained clear rate = 100 %; constrained clear rate within §7.2's table **and** satisfying R2 and R3's shape rules; measured taps/s per band. |
| `tools/bot.mjs --entry-window` | Per band and per arm of the row-0 bit: the clear rate, **and** the per-car failure rate at each car's first decision against the rate at its other decisions, against [AC-246](acceptance-criteria.md)'s per-band ceiling. The split is reported; the `p` gap is what fails the run. The fault to inject before trusting it is round 3's shipped D3 — a round-robin with no onset capture — which must fail it at every band. |
| `tools/bot.mjs --attention-report` | Per band, per 1,000 seeds: mean glances/s, mean focus events/s, the split between `BOT_SWITCH_TICKS` and `BOT_ACQUIRE_TICKS` focuses, mean working-set occupancy, evictions/s, memory expiries/s, onset captures/s and captures as a share of glances (§7.1.5 D3), and the count of misroutes caused by a flip the bot made for a car it was holding onto a car it was not (`breaksHeldCar` could not see). These are the numbers that say *why* a band lands where it does, and without them a missed target is unexplainable. |
| `tools/pacing.mjs` | Completion-time median / p95 / max per band against §7.3. |
| `tools/replay.mjs --seed N` | A recorded run replays to a deeply equal final state, twice in a row and across machines. |

Per `development-process.md:136`: before any of these is trusted to pass, the fault it is meant
to catch is injected and the harness is confirmed to fail.
