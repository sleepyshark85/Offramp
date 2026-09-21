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
| 2 | 5–9 | 4 | 3 | 4 | 0.70 | 3–5 | 3 | 2–3 | 300 | 260 | 415 | 3200 | 192 | **108** | ±12 | **33** | 10 |
| 3 | 10–15 | 4 | 4 | 4 | 0.80 | 4–6 | 4 | 2–3 | 300 | 260 | 415 | 3400 | 204 | **106** | ±18 | **41** | 10 |
| 4 | 16–22 | 5 | 4 | 5 | 0.80 | 5–7 | 5 | 2–4 | 240 | 195 | 323 | 3600 | 216 | **110** | ±18 | **47** | 9 |
| 5 | 23+ | 5 | 5 | 6 | 0.88 | 7–8 | 7 | 2–4 | 200 | 195 | 293 | 3800 | 228 | **120** | ±18 | **51** | 9 |

**`interval` and `quota` moved in round 6 and nothing else in this table did.** The before and
after, in one place, because it is the whole of what the developer has to change:

| Band | `interval` was → is | `quota` was → is | `SPAWN_SLACK` was → is |
|---|---|---|---|
| 1 | 156 → **156** (unchanged) | 16 → **16** (unchanged) | 8 → **8** |
| 2 | 138 → **108** | 26 → **33** | 9 → **10** |
| 3 | 120 → **106** | 36 → **41** | 9 → **10** |
| 4 | 108 → **110** | 48 → **47** | 9 → **9** |
| 5 | 96 → **120** | 64 → **51** | 10 → **9** |

`SPAWN_SLACK` is derived, not chosen; the column above is what
[`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)'s
formula produces from the new `interval`s, and [AC-139](acceptance-criteria.md)'s oracle sweep has
been re-run against it (§7.2.4). Every pull is §7.4's **lever 0** — the iso-duration pair — so each
row's `(quota - 1) · interval` is within a second of what it was and §7.3's duration bands are
untouched. **The generator is bit-identical:** `interval` and `quota` are consumed only by
`spawnSchedule`, which draws from the `SPAWN_SALT` stream after the topology is built, so node
lists, edge lists, junction lists and entry columns are unchanged over 500 seeds × 5 bands —
verified by comparison, not assumed. §6.2, [AC-211](acceptance-criteria.md),
[AC-234](acceptance-criteria.md), [AC-242](acceptance-criteria.md),
[AC-243](acceptance-criteria.md) and [AC-245](acceptance-criteria.md) therefore did not move and
did not need re-measuring.

**`interval` is no longer monotone across the ladder, and that is a measured result rather than a
preference.** It falls 156 → 108 → 106 and then *rises* to 110 and 120. §7.4's round-6 record
contains the proof that it has to, [`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order)
no longer claims otherwise, and what escalates instead is in §7.2.4.

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
| 2 | 3000 / 3000 | 3 / 11 / 27 | 1866 | J=3: 19 %, 4: 37 %, 5: 45 % | 3: 100 % | 2–3 |
| 3 | 3000 / 3000 | 2 / 7 / 16 | 1801 | J=4: 13 %, 5: 40 %, 6: 48 % | 4: 26 %, 5: 74 % | 2–3 |
| 4 | 3000 / 3000 | 3 / 10 / 22 | 2678 | J=5: 4 %, 6: 25 %, 7: 71 % | 5: 100 % | 2–4 |
| 5 | 3000 / 3000 | 2 / 9 / 23 | 2235 | J=7: 3 %, 8: 97 % | 7: 100 % | 2–4 |

**The `max` in the attempts column is a sample maximum and it grows with the seed count. Read it
that way, and never as a bound.** Median and p95 are stable statistics of the generator;
`max` is the largest of `seeds` draws from a geometric-ish tail, so it rises as more seeds are
drawn. At **5,000** seeds per band the same run reads median/p95/max
`5/19/74`, `3/11/27`, `2/8/17`, `3/10/26`, `3/9/23` — band 1's max moves 50 → **74** while its
median and p95 do not move at all. That is the tail being sampled further, not the generator
getting worse. It matters because [AC-203](acceptance-criteria.md) is written partly against this
column: its ceiling is **128** and its stated reason is `MAX_ATTEMPTS = 256`, so the honest reading
of 74 is "the observed worst case is well inside a budget that is itself 3.5× the observed worst
case", and the number to quote alongside it is always the seed count that produced it. **A future
reading that exceeds 128 at some larger seed count is not automatically a regression** — it is a
reason to re-read median and p95, which are what would actually have moved if the generator had.
Band 1 is the band to watch, for the reason two paragraphs down: it has the smallest network space
in the game, so it does the most rejecting.

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

| Band | Spawn rate | Mean depth | Estimated taps/s | Cars in flight, mean | Measured taps/s |
|---|---|---|---|---|---|
| 1 | 0.385 /s | 2.0 | 0.38 | 3.0 | 0.42 |
| 2 | 0.556 /s | 2.5 | 0.69 | 4.3 | 0.61 |
| 3 | 0.566 /s | 2.7 | 0.76 | 4.2 | 0.73 |
| 4 | 0.545 /s | 3.2 | 0.87 | 3.8 | 0.70 |
| 5 | 0.500 /s | 3.3 | 0.83 | 3.4 | 0.71 |

The **cars in flight** column is a mean. The *maximum* is what sizes the spawn schedule, and it is
derived separately in
[`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed) —
`5 / 7 / 7 / 6 / 6` against an observed worst of `4 / 6 / 6 / 5 / 5`. The two columns are not in
conflict; reading the mean as the maximum is how the spawn margin came to be one car at band 5.

Two things changed here in round 6 and both are consequences of §6.1's `interval` column, not of
anything in the generator. The spawn rate now **peaks at band 3** rather than at band 5, and the
measured tap rate is flat at `0.70 – 0.73 /s` across bands 3–5 where it used to climb. Neither is a
softening: [AC-233](acceptance-criteria.md)'s ceiling is 1.25 /s and band 5 now reads 0.71, which
also retires [`gameplay.md` §8.6](gameplay.md#86-band-5-tap-load--closed-by-measurement)'s
open recommendation — the tap load that was "the number most likely to come back from the tester as
too hard" was removed by the lever the same section nominated. What rises monotonically instead is
**focus events per second**, which is the quantity the bot actually pays for: measured
`1.80 / 2.36 / 2.65 / 3.09 / 3.30` (§7.1.9).

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
                         //   colour must be re-observed at full price. Against §6.1's spawn
                         //   intervals it is 0.77 / 1.11 / 1.13 / 1.09 / 1.00 of one interval, so
                         //   memory lasts ON THE ORDER OF one spawn interval at every band and
                         //   never as much as TWO at any of them (the tightest case, band 3, is
                         //   1.13). It cannot carry the bot across the traffic stream: no car's
                         //   colour survives in memory long enough for two further cars to have
                         //   entered behind it.

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

**`BOT_MEMORY_TICKS`' rationale has now been rewritten twice and the constant has never moved;
round 7 is the round in which the sentence finally matches the ratios underneath it.** Under
§6.1's pre-round-6 `interval` column the ratio of memory to spawn interval was
`0.77 / 0.87 / 1.00 / 1.11 / 1.25`, and the note above used to end "and it carries less of it as
the bands get harder", which the round-6 column made false. Round 6 replaced that with "memory
spans at most one spawn interval anywhere in the game" — and the round-6 ratios,
`0.77 / 1.11 / 1.13 / 1.09 / 1.00`, printed two paragraphs below it, say 1.09 to 1.13 at bands 2, 3
and 4. **The replacement sentence was falsified by the numbers on the same page, twice in a row,
because both drafts claimed a clean bound that the arithmetic does not offer.**

`120 / interval` is `0.77 / 1.11 / 1.13 / 1.09 / 1.00`. What that supports, stated as tightly as
the numbers allow and no tighter:

- Memory is **within 13 % of one spawn interval at every band**, and at bands 2–5 it is within
  13 % on either side of exactly one. It is not a quantity that scales with the band.
- It **never reaches two spawn intervals**: `2 × interval` is `312 / 216 / 212 / 220 / 240` ticks
  against 120, so the worst case (band 3) is 57 % of two intervals. **No car's colour can survive
  in memory long enough for two further cars to have entered behind it**, at any band.

That second bullet is the property the constant is *for*, and it is the one to regress against:
memory cannot substitute for looking, because the working set of 3 cannot be refilled from memory
faster than the traffic replaces its contents. What is **not** claimed, and was claimed twice
before: that memory fits inside one spawn interval. At bands 2, 3 and 4 it does not, by 9 to 13 %.
Nothing in §7.1.5 or §7.1.9 rests on it doing so. The band table moved; the instrument did not, and
§7.4 forbids the reverse.

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
  round-robin. Measured under §6.1's round-6 parameters, captures per second are
  `0.384 / 0.549 / 0.561 / 0.541 / 0.497` against spawn rates of
  `0.385 / 0.556 / 0.566 / 0.545 / 0.500` — one per spawned car, less the cars still in flight
  when the level ends, which are never glanced at
  ([AC-247](acceptance-criteria.md)) — and 5.3 % to 9.9 % of all glances by band.
- **It is taken out of the same budget.** Total glances per second are unchanged
  (`7.20 / 5.97 / 5.74 / 5.45 / 5.53` against a pure round-robin's
  `7.19 / 6.05 / 5.82 / 5.52 / 5.57`, a drift of `+0.1 / −1.3 / −1.4 / −1.3 / −0.7 %`), so the
  capture is a *reallocation*. It is paid for by the rest of the board: working-set evictions
  per second rise `0.000 / 0.276 / 0.330 / 0.342 / 0.194` → `0.000 / 0.356 / 0.437 / 0.449 /
  0.249`, a 29 – 32 % increase at every band that has any. Attending to a newborn car costs the
  cars already in flight, which is the correct shape for a model of divided attention.

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
| 1 | 27 | 18 | deadline wins |
| 2 | 23 | 26 | latency wins |
| 3 | 21 | 25 | latency wins |
| 4 | 18 | 23 | latency wins |
| 5 | 16 | 20 | latency wins |

*The right-hand column is recomputed from §6.3's round-6 cars-in-flight means. The crossing moved
**down** a band — band 2 is now on the latency side — because round 6's lever pull raised the
traffic at bands 2 and 3 and lowered it at band 5. The left column did not move: it is set by
`ENTRY_LEN` and the band's speed, neither of which round 6 touched. This is the diagnosis of the
defect D3 repaired, kept because it is the argument for D3 existing, and D3 is what keeps the
inequality from mattering.*

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

**What it does to the measurement**, 1,000 seeds per band, the only change being D3. *These two
sweeps were taken under §6.1's **round-5** `interval` and `quota` columns, which is the point: the
comparison is between two sweeps that differ in exactly one rule. Round 6 then moved the band table
and re-read the same quantity under the new parameters — §7.2.4 has that reading, and this table is
kept as the evidence for D3 rather than as a current figure.* Every
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

| Band | cars/s | mean depth | focus events/s, lower bound | cheapest cost each | dearest cost each | ticks/s demanded | focus events/s, **measured** |
|---|---|---|---|---|---|---|---|
| 1 | 0.385 | 2.0 | 0.77 | 11 | 22 | 8 – 17 | **1.80** |
| 2 | 0.556 | 2.5 | 1.39 | 11 | 22 | 15 – 31 | **2.36** |
| 3 | 0.566 | 2.7 | 1.53 | 11 | 22 | 17 – 34 | **2.65** |
| 4 | 0.545 | 3.2 | 1.74 | 11 | 22 | 19 – 38 | **3.09** |
| 5 | 0.500 | 3.3 | 1.65 | 11 | 22 | 18 – 36 | **3.30** |

Cheapest is `BOT_SCAN_TICKS + BOT_SWITCH_TICKS + 1` (the car was still held); dearest is
`BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS + 1` (it had been forgotten or evicted). Neither figure
counts glances that land on a car needing nothing, which rise with the number of cars in flight.

**The last column was added in round 6 because the lower bound stopped being monotone and the
measurement did not.** The bound assumes one focus per decision per car; it therefore reads
`cars/s × depth` and nothing else, and after round 6's lever pull band 5 carries fewer cars per
second than band 4 while being a harder board, so the bound inverts at 4 → 5. The measured rate
does not: `1.80 / 2.36 / 2.65 / 3.09 / 3.30`, rising at every step. The difference between the two
columns is **re-focus** — a car the bot comes back to because it could not finish with it the first
time — and that is exactly what a harder board costs. Measured, focuses split into
`BOT_SWITCH_TICKS` re-focuses and `BOT_ACQUIRE_TICKS` cold ones at
`1.26 / 1.35 / 1.64 / 2.11 / 2.44` against `0.54 / 1.01 / 1.02 / 0.99 / 0.86` per second: the cold
half is flat from band 2 up, and every bit of the gradient above it is the board asking to be
looked at twice. Mean working-set occupancy rises with it, `1.47 / 2.44 / 2.59 / 2.65 / 2.61`
against a capacity of 3.

The gradient is still a property of the model rather than of a tuned constant — the same fixed
capacity is asked to cover more decisions per car and more re-visits at every step up the ladder —
but **the term that carries it is no longer the spawn rate**, and §7.2.4 is where that is stated as
a design position rather than an observation. This is what §7.2's required *shape* is read against.

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

| Band | `quota` | `p* = 2/quota` | `p` that produces the band's easiest allowed clear rate | …its hardest | width of the window | measured `p` |
|---|---|---|---|---|---|---|
| 1 | 16 | 12.50 % | 0 % | 5.31 % | 5.31 pp | **0.92 %** |
| 2 | 33 | 6.06 % | 2.06 % | 3.94 % | 1.89 pp | **2.53 %** |
| 3 | 41 | 4.88 % | 2.47 % | 4.14 % | 1.67 pp | **3.38 %** |
| 4 | 47 | 4.26 % | 2.85 % | 4.38 % | 1.53 pp | **3.38 %** |
| 5 | 51 | 3.92 % | 3.18 % | 4.83 % | 1.66 pp | **3.80 %** |

**Read the two inner columns as one interval and the consequence is the governing fact of this
design: every band's whole allowed range of difficulty is under two percentage points of per-car
reliability.** Every difficulty statement this project makes is a claim about one or two
percentage points of per-car error, and no lever moves a band without moving that number.

**This table is also where round 6's lever pull was decided, and the reason it is not just a
retune.** Every number below is `P(Binomial(N, p) <= 2)` inverted for a given clear rate, so it is
arithmetic a reader can re-derive in ten lines without running the game, and it should be
re-derived rather than taken on trust.

| | band 2 | band 3 | band 4 | band 5 | shape |
|---|---|---|---|---|---|
| **old quota** | 26 | 36 | 48 | 64 | |
| old window floor | 2.63 % | 2.81 % | 2.79 % | 2.53 % | **not monotone** |
| old window cap | 5.02 % | 4.71 % | 4.29 % | 3.85 % | **falls at every step** |
| **new quota** | 33 | 41 | 47 | 51 | |
| new window floor | 2.06 % | 2.47 % | 2.85 % | 3.18 % | **rises at every step** |
| new window cap | 3.94 % | 4.14 % | 4.38 % | 4.83 % | **rises at every step** |

A ladder whose bands get harder needs a per-car error rate that **rises**. Under the old quotas the
caps **fell** while the floors did not even rise, so a rising `p` was squeezed from above: the
whole of a four-band difficulty ladder had to fit between band 2's floor and band 5's cap, which is
`[2.63 %, 3.85 %]` — **1.23 pp of room**. Under the new quotas the same span is
`[2.06 %, 4.83 %]` — **2.78 pp**, 2.3× wider — and, more importantly, the floors and caps both step
*with* the ladder instead of against it.

**This is a statement about room, not about impossibility, and the distinction is worth getting
right because it was got wrong once already.** §7.2 *was* satisfiable under the old quotas — the
first draft of this subsection said it was not, and that was wrong. Search the model over monotone
`p` ladders at 0.01 pp resolution for the one that maximises the *smallest* margin against
§7.2.2's five windows and R2 and R3 together, and the old ladder's best case is `p = 3.23 %` at
**all four** of bands 2–5, giving clear rates `100.0 / 95.0 / 89.0 / 79.8 / 65.8 %` and a minimum
margin of **1.02 pp**. Two things follow, and they are the real finding:

- The only way to satisfy §7.2 under the old quotas was to make bands 2–5 **equally hard per car**
  and let `quota` alone produce the entire gradient. A rising `p` — which is what an escalating
  ladder physically is, and what §7.1.9's attention arithmetic predicts — spends margin rather than
  earning it.
- **1.02 pp is not a measurable margin.** The binomial standard error on a 1,000-seed clear rate at
  `p ≈ 0.8` is 1.3 pp, and on the *difference* of two rates it is about 1.8 pp. The best case
  available under the old quotas sat inside one standard error of failing, so a run that passed and
  a run that failed would have been the same design.

The same solve under the new quotas gives a best case of **4.96 pp** of minimum margin at
`p = 3.24 / 3.58 / 3.86 / 4.20 %` — a `p` that **rises**, which is the point: under the new quotas
an escalating ladder is the optimum rather than the penalty. Both figures are the model's best
case and neither is a prediction; what the table actually shipped *measures* is 3.4 pp (§7.2.4),
and that is the number a tester holds this design to. **`quota` is not only a duration knob: it
sets the per-car error budget, and the *shape* of the quota ladder decides how much room a monotone
difficulty ladder has to live in.** That is the finding of round 6 and it is more durable than the
five numbers it produced.

**One limitation, stated because the rest of this subsection leans on the model.** The binomial
treats a level's `quota` cars as independent trials, and they are not: level difficulty varies, so
failures cluster and the measured clear rate sits *below* the model's for the same `p`. At the `p`
column above, the model predicts `100.0 / 95.0 / 83.9 / 78.8 / 69.3 %` against a measured
`99.9 / 91.5 / 81.5 / 74.1 / 66.0 %` — below at every band, by `0.1 / 3.5 / 2.4 / 4.7 / 3.3` pp. The windows are therefore the right object for reasoning
about **shape** — which direction a ladder's room runs, and how much of it there is — and the wrong
object for predicting a clear rate. Every clear rate quoted anywhere in these documents is
measured, never inverted from this table.

Three things follow, and they are not negotiable by tuning:

1. **Any structural bit that moves `p` by more than about a point is a switch, not a dial.** It
   does not matter what the bit is. The dynamic range of bands 2–5 is **2.78 pp** — 2.06 % at the
   easiest end of band 2's window to 4.83 % at the hardest end of band 5's, and any one band's own
   range is under 1.9 pp. Before round 5 the
   first decision ran `1.23 / 3.71 / 6.42 / 8.35 / 11.80` pp worse than a later one (§7.1.8),
   which at bands 2–5 is **1.3 to 4.2 times the width of that whole range**, on the one decision
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

**What survives after D3, and why it is allowed to.** The row-0 split does not go to zero. Under
§6.1's round-6 parameters, at 1,000 seeds, it reads `0.2 / 4.8 / 17.3 / 25.5 / 29.0` pp — larger at
bands 2 and 3 than round 5's `0.2 / 1.0 / 3.2 / 30.2 / 9.2`, and for a reason that is the opposite
of a regression: round 5's bands 2 and 3 were pressed against the 99 % ceiling where no structural
bit can separate anything, and band 5's 9.2 pp was the floor doing the same thing from below. The
split is now **monotone in band**, which is the shape a unit of extra depth should have.

The residue is not a reliability gap — [AC-246](acceptance-criteria.md) passes at every band
(§7.2.4) — it is that a level whose row-0 node is a branch **asks every car one more question**,
and one more question per car is what the difficulty ladder is made of. Conditioned the other way
round at band 4, over 1,500 seeds in buckets of at least 20 levels each, the mean junction depth
over paths spreads the clear rate by **31.3 pp** (93.3 % at depth 2.67 against 62.0 % at 3.25) and
drawn `J` spreads it by 24.3 pp (93.3 % at `J = 5` against 69.0 % at `J = 7`); the row-0 bit's
26.7 pp sits *between* them, as it did in round 5. At band 5 the comparison is weaker and the
reason is visible in the same data: 89 % of band-5 levels have a mean depth of exactly 3.33, so
there is almost no depth variation left for the row-0 bit to be measured against, and its 30.2 pp
is simply the largest structural variable that band has. It has stopped being a coin flip and
become one unit of depth, which is what it physically is. A design that wanted it smaller than that
would have to stop varying depth, and §6.1 is built on varying depth.

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

Round 5's reading, taken under the previous `interval` and `quota` columns, was
`99.9 / 99.3 / 97.2 / 68.9 / 2.6 %` — bands 1 and 4 in band, bands 2 and 3 above it, band 5 far
below, R2 failing at 1→2 (0.6 pp) and 2→3 (2.1 pp) and R3 failing at 3→4 (28.3 pp) and 4→5
(66.3 pp). That was the first reading this project ever took on an instrument that had passed its
own sensitivity guard, and it was the brief for round 6's lever pull. **The targets did not move
and are not going to**, for the reason §7.2 opens with; §6.1 moved.

1,000 seeds per band, `ENTRY_LEN = 160`, V13 in force, §7.1.5 D3 as written, §6.1's round-6
`interval` and `quota`:

| Band | clear rate | §7.2.2 band | margin to nearer edge | per-car `p` | row-0 split | `p_first` − `p_later` | AC-246 ceiling | median s |
|---|---|---|---|---|---|---|---|---|
| 1 | **99.9 %** | ≥ 95 % — **in band** | +4.9 | 0.92 % | 0.2 pp | −0.39 pp | 3.13 | 49.3 |
| 2 | **91.5 %** | 86–97 % — **in band** | +5.5 | 2.53 % | 4.8 pp | −0.69 pp | 1.52 | 68.5 |
| 3 | **81.5 %** | 76–92 % — **in band** | +5.5 | 3.38 % | 17.3 pp | −0.21 pp | 1.22 | 81.6 |
| 4 | **74.1 %** | 66–85 % — **in band** | +8.1 | 3.38 % | 25.5 pp | +0.10 pp | 1.06 | 94.9 |
| 5 | **66.0 %** | 55–78 % — **in band** | +11.0 | 3.80 % | 29.0 pp | +0.27 pp | 0.98 | 110.8 |

| pair | drop | R2 (≥ 4 pp) | R3 (≤ 15 pp) |
|---|---|---|---|
| 1→2 | 8.4 pp | **pass**, +4.4 of margin | **pass**, 6.6 to spare |
| 2→3 | 10.0 pp | **pass**, +6.0 | **pass**, 5.0 |
| 3→4 | 7.4 pp | **pass**, +3.4 | **pass**, 7.6 |
| 4→5 | 8.1 pp | **pass**, +4.1 | **pass**, 6.9 |

**Every clear rate is in band, R2 and R3 pass at all four pairs, and the smallest margin anywhere
in the table is 3.4 pp.** Re-read at 2,000 seeds the table is `100.0 / 91.9 / 81.5 / 73.8 / 64.6 %`
with drops of `8.0 / 10.4 / 7.8 / 9.2` — every verdict identical, and every figure inside one
binomial standard error of the 1,000-seed reading, which is the check that the ladder is a property
of the design and not of a sample.

**What the per-car column says, and why it is the one to read.** `p` runs
`0.92 / 2.53 / 3.38 / 3.38 / 3.80 %`. It is **non-decreasing, and it is flat across bands 3 and
4** — 3.3801 % against 3.3807 %, a difference of 0.0006 pp, which is not a step in any sense a
measurement can defend. Each value sits inside its own band's window from §7.1.10, at least
**0.47 pp above each floor** (band 2 is the tightest from below) and at least **0.76 pp below each
cap** (band 3 is the tightest from above); per band the margins are
`+0.92 / +0.47 / +0.91 / +0.53 / +0.63` pp above the floor and
`4.40 / 1.42 / 0.76 / 1.00 / 1.03` pp below the cap.

*Round 7 corrected this column: band 3 was recorded as 2.88 % from slice 1b onward and the measured
value is 3.38 %. The other four bands re-measured unchanged to two decimals, so the definition —
misroutes over arrivals, summed across all 1,000 runs, not averaged per level — was right and one
number was wrong. No verdict moves: 3.38 % is still inside band 3's `[2.47 %, 4.14 %]` window, and
the clear rates in the table are measured rather than derived from `p`. What does move is the
claim: the sentence here used to say `p` rose at every step, and it does not.*

**That the ladder flattens between bands 3 and 4 is a finding with a measured mechanism, not a
defect.** Decompose `p` one level further. Over the same 1,000 seeds per band, counting a
*decision* as §7.1.6 `evaluate` does — a branch node the car actually crossed whose two branches
differ in whether they reach that car's colour — the bot faces
`1.77 / 2.01 / 2.31 / 2.51 / 2.78` decisions per arriving car and answers each one wrongly
`0.53 / 1.32 / 1.53 / 1.39 / 1.41 %` of the time. **Decisions per car rise monotonically;
per-decision error does not — it peaks at band 3 and falls 0.14 pp at band 4.** `1 - (1 - q)^d` on
those two
columns gives `0.93 / 2.63 / 3.50 / 3.44 / 3.87 %`, which reproduces the measured `p` to about a
tenth of a point, so the flat step is precisely this: band 4 asks each car 0.20 more questions and
makes each question 0.14 pp easier, and the two cancel.

Why band 4's questions are easier is the same fact §7.4's round-6 record already carries under
another name. From band 3 the spawn rate *falls* — `0.566 → 0.545 → 0.500 /s`, `interval`
`106 → 110 → 120` — so each decision gets more time even as there are more of them per car. **The
late bands buy depth with traffic, and that trade is visible as flatness in `p` at exactly the band
where the trade begins.** R2 and R3 are stated in clear rate and both pass at 3→4 with 3.4 and
7.6 pp to spare, so nothing in §7.2.1 requires a step in `p` at every pair. **What would be a
defect is `p` falling**, and it does not.

That is the ladder working the way the design says it works: an unamplified per-car quantity that
does not fall, read through a threshold that turns it into the five clear rates above. It is the
column a regression should be stated in, for §7.1.10's reason — **including its flat 3→4 step**,
which is now part of what "unchanged" means here. **The windows are not a predictor** — §7.1.10's
closing paragraph says why the binomial sits above the measurement — so this is a statement that
the ladder has room on both sides, not a derivation of the clear rates in the table above, which
are measured. Anyone tempted to buy a step at 3→4 by lowering band 3's `p` should price it
first. Band 3 has 0.91 pp of room to its floor, so the `p` move is affordable; the clear-rate
consequence is not free, because a higher band-3 clear rate **shrinks** the 2→3 drop (R2, +6.0 pp
of margin today) and **grows** the 3→4 drop (R3, 7.6 pp to spare today). Both have room. Neither
has so much that the trade can be made without measuring it, and §7.4 requires it to be.

**AC-246 is looser everywhere and loosest where it used to be tightest.** Gaps
`−0.39 / −0.69 / −0.21 / +0.10 / +0.27` pp against ceilings `3.13 / 1.52 / 1.22 / 1.06 / 0.98`.
Band 5 was the number to watch — round 5 left it at 81 % of its ceiling — and lever 0 moved it in
the direction §7.4 predicted, to **28 %**, because raising `interval` and cutting `quota` both help
it. The check has not lost its teeth: under the round-robin injection the same run reads
`+1.23 / +7.55 / +8.18 / +8.34 / +9.02` pp and fails at bands 2, 3, 4 and 5, with band 1 correctly
passing (§8).

**Completion times are inside §7.3's window at every band**, which is what makes this a lever pull
rather than a trade: medians `49.3 / 68.5 / 81.6 / 94.9 / 110.8 s`, p95
`52.1 / 71.5 / 84.0 / 97.2 / 113.0 s`, and the slowest run anywhere — cleared or not, over 10,000
runs — **114.1 s** against [AC-231](acceptance-criteria.md)'s 130 s ceiling. The unconstrained bot
still clears 100 % at every band with zero misroutes ([AC-220](acceptance-criteria.md)), the
measured tap rate is `0.42 / 0.61 / 0.73 / 0.70 / 0.71 /s` against
[AC-233](acceptance-criteria.md)'s 1.25 ceiling, and [AC-139](acceptance-criteria.md)'s spawn
margin, re-derived and re-run over 2,000 seeds per band in both oracle variants, is **3 at every
band**, against the `3 / 2 / 3 / 3 / 3` it replaced — the derived `SPAWN_SLACK` moved
`8 / 8 / 9 / 9 / 10` → `8 / 10 / 10 / 9 / 9` under the new `interval` column without anyone editing
it, which is what [`gameplay.md` §8.4](gameplay.md#84-spawn-slack-is-derived-not-chosen--decided)
exists to make happen.

**What escalates, now that `interval` does not.** This is the design position the new table commits
to and it should be argued with rather than absorbed. Through bands 1 to 3 the spawn rate rises,
`0.385 → 0.556 → 0.566 /s`; from band 3 to band 5 it *falls*, to `0.545` and `0.500`. What rises
across the whole ladder is the demand each car makes — decisions per car `2.0 / 2.5 / 2.7 / 3.2 /
3.3`, measured focus events per second `1.80 / 2.36 / 2.65 / 3.09 / 3.30` (§7.1.9), per-car error
`0.92 / 2.53 / 3.38 / 3.38 / 3.80 %` (non-decreasing, flat at 3→4) — and the number of cars that
have to be got right in a row,
`quota` at `16 / 33 / 41 / 47 / 51`. The late bands are not quieter; they are boards where each car
is a longer job and the traffic has to thin to leave room for it. **Traffic was carrying the ladder
and it could not carry it past band 3**, which §7.4's round-6 record proves rather than asserts.

**What is not fixed by this, and should not be mistaken for fixed.** [AC-240](acceptance-criteria.md)
still only *asserts* at bands 4 and 5, because its 80 % headroom rule excludes any band clearing
above that and band 3 now reads 81.5 %. It passes where it asserts, by +25.0 and +31.7 pp against a
20 pp floor — more headroom than round 5's reading gave it — and band 3's unasserted rise measures
+17.9 pp, which is consistent with the model and is reported. Buying band 3 into AC-240's range
would mean targeting it below 80 %, which costs the ladder most of its margin against R3 at 2→3;
that trade was priced and declined, and it is recorded in §7.4 so that it is a decision rather than
an oversight.

### 7.3 Target 2 — completion-time band

Measured over successful constrained-bot runs, in seconds of simulated time (`ticks / 60`).

| Band | Nominal | Median must fall in | Measured median | p95 ceiling | Measured p95 | Absolute ceiling, any seed |
|---|---|---|---|---|---|---|
| 1 | 49.4 s | 42 – 62 s | 49.3 s | 68 s | 52.1 s | **130 s** |
| 2 | 67.4 s | 58 – 78 s | 68.5 s | 86 s | 71.5 s | **130 s** |
| 3 | 80.0 s | 70 – 92 s | 81.6 s | 100 s | 84.0 s | **130 s** |
| 4 | 92.9 s | 84 – 106 s | 94.9 s | 114 s | 97.2 s | **130 s** |
| 5 | 108.3 s | 98 – 122 s | 110.8 s | 126 s | 113.0 s | **130 s** |

**The design bands did not move in round 6 and the nominals barely did**, which is the whole point
of §7.4's lever 0: `(quota - 1) · interval` is held while `interval` alone carries the difficulty.
The nominal column is
`SPAWN_LEAD/60 + (quota - 1) · interval/60 + transit`, with the same per-band transit
[`gameplay.md` §5.3](gameplay.md#53-session-length) uses, and it shifts by at most 1.0 s at any
band. The slowest run anywhere, cleared or not, over 10,000 runs is 114.1 s.

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
Worked, for band 5 as it stood before round 6 — `interval = 96`, `quota = 64`, `SPAWN_LEAD = 90`
ticks and a measured transit of 6.8 s — with the measured clear rate at each stop, 1,000 seeds:

| `interval'` | `quota'` | nominal duration | inside §7.3's 98–122 s? | clear rate | AC-246 gap / ceiling |
|---|---|---|---|---|---|
| 96 (was) | 64 | 110.7 s | yes | 2.6 % | +0.63 / 0.78 |
| 108 | 57 | 110.7 s | yes | 33.7 % | −0.13 / 0.88 |
| 114 | 54 | 110.6 s | yes | 56.9 % | −0.13 / 0.93 |
| **120 (is)** | **51** | **109.9 s** | **yes** | **66.0 %** | **+0.27 / 0.98** |
| 132 | 47 | 111.1 s | yes | 69.8 % | **+1.23 / 1.06 — FAILS** |
| 144 | 43 | 110.7 s | yes | 80.1 % | **+1.43 / 1.16 — FAILS** |

**Read the last column before the one before it.** Lever 0 is monotone in the clear rate but it is
*not* monotone in [AC-246](acceptance-criteria.md): past about `interval = 126` the gap starts
widening again and at 132 it breaks the ceiling, because a long interval makes a car's *later*
decisions very reliable (`p_later` falls to 0.92 % at 132 and 0.66 % at 144) while its first one is
still paid for at the cold `BOT_ACQUIRE_TICKS` price and barely improves. The gap is a difference,
so making everything else easy widens it. Lever 0 therefore has a **ceiling as well as a floor**,
and a pull that reaches for the top of §7.3's duration window can buy a clear rate and fail the
guard that §7.4 opens by calling binding. Band 5 sits at 120 partly for this reason.

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

### 7.4.1 Round 6's lever pull, and the thing it proved on the way

Round 6 pulled lever 0 at four of the five bands. The before and after is in §6.1 and the reading
is in §7.2.4; what belongs here is the order it was pulled in, the two levers that were measured
and rejected, and the one claim about the game that fell out of it.

**Band 5 first, because it was the band that was pinned.** At `interval = 96` it cleared 2.6 %
against a 55 % floor. Before reaching for a second lever, the §7.4 order requires lever 0 to be
exhausted — and it was swept, at 1,000 seeds per stop, in the table above. It reaches 66.0 % at
`interval = 120` with the duration at 109.9 s and AC-246 at 28 % of its ceiling. Every other band
followed the same procedure: sweep lever 0 at 1,000 seeds per stop, pick the stop that lands the
band inside §7.2.2 with the most margin on both sides *and* leaves the adjacent drops inside R2 and
R3. Band 1 was not pulled, because it misses nothing; §7.4 is a repair order, not a tidying pass.

**Rejected, measured: every structural lever at band 5.** The order below lever 0 says to reduce
`quota` further, then `pBranch`. Both were priced at band 5's original `interval = 96`, 500 seeds
each, so that the claim "only lever 0 moves this band" is a measurement rather than an assumption:

| Band-5 variant at `interval = 96` | clear rate | per-car `p` | mean drawn `J` |
|---|---|---|---|
| as it was | 2.6 % | 11.0 % | 8.0 |
| `R` 6 → 5 (band 4's geometry) | 7.8 % | 8.4 % | 7.9 |
| `pBranch` 0.88 → 0.78, `Ja` 7 → 6 | 3.8 % | 10.8 % | 7.5 |
| `pBranch` 0.88 → 0.70, `Ja` 7 → 5 | 7.4 % | 9.6 % | 7.0 |
| `pBranch` 0.88 → 0.60, `Ja` 7 → 4 | 14.6 % | 8.3 % | 6.2 |
| `K` 5 → 4 | — | — | **generator cannot build it** at `C = 5`, `R = 6` |

Gutting `pBranch` to 0.60 — which costs band 5 a third of its junctions and two of its actionable
ones, and is far past anything §7.4 would sanction — reaches 14.6 % against a 55 % floor. Dropping
a row reaches 7.8 %. Removing the fifth colour is not available at all: `C = 5, R = 6, K = 4` fails
validation on every one of 500 seeds. **`interval` is the only lever that moves band 5**, and that
is the premise of what follows.

**What that proves: `interval` cannot stay monotone across the ladder.** Two measured facts, and
the conclusion is arithmetic.

1. Band 5 needs `interval >= 116` to clear 55 %. Measured: `108 → 33.7 %`, `114 → 56.9 %`,
   `116 → 60.4 %`, and no structural lever closes the gap from below (the table above).
2. Band 4 needs `interval <= 115` to stay at or under its own 85 % ceiling. Measured:
   `112 → 80.2 %`, `114 → 83.9 %`, `116 → 86.1 %` — out of band — and R2 additionally requires it
   to sit at least 4 pp *above* band 5, which pushes it lower still.

So `interval(band 4) < interval(band 5)`, necessarily, and the same argument run one step down
gives `interval(band 3) < interval(band 4)`: for band 3 to stay above band 4 by R2's 4 pp while
remaining under its own 92 % ceiling it has to sit at `interval <= 112`, and band 4 is at 110.
**The escalation ladder's spawn-interval axis inverts after band 3 and no choice of the other
parameters prevents it.** That is a finding about the game rather than about the tuning: past band
3, each car is a big enough job that the board cannot also be given more cars.
[`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order)'s escalation table is
rewritten accordingly, and §7.2.4 says what carries the ladder instead.

**A second finding, from the same sweeps: `K` is barely a difficulty axis on its own.** At a
common `interval = 120`, per-car `p` reads `— / 1.25 / 1.53 / 2.29 / 3.80 %` across bands 2–5 — the
2 → 3 step, whose entire content in §5.1 is the fourth colour, is worth 0.28 pp, against 0.76 pp
for 3 → 4 (a column and a row) and 1.51 pp for 4 → 5. The reason is mechanical: the bot pays per
**car held**, not per colour in the world, so a new colour costs attention only through the deeper
networks and the extra decisions it makes possible. §6.1 already recorded that the `J` axis is
largely the `K` axis in disguise; this says the `K` axis is largely the **depth** axis in disguise,
and that the two real axes in this game are *cars per second* and *decisions per car*. A future
lever pull should reach for those two and treat everything else as their proxy.

**A third finding, which is arithmetic rather than measurement, and is in §7.1.10 because that is
where the model lives.** `quota` moved as lever 0's passenger, but it is not only a duration term:
it sets the per-car error budget `2/quota`, and therefore the window of per-car error each band's
clear-rate target corresponds to. The old `quota` ladder's windows ran *downhill* while an
escalating ladder's `p` has to run uphill, which left 1.23 pp of total room for the whole
five-band ladder against the new ladder's 2.78 pp. It was satisfiable — §7.1.10 gives the
assignment that does it — but only with `p` **flat** across bands 2–5 and 1.02 pp of margin, which
is inside one standard error of a 1,000-seed reading. **A future lever pull that moves `quota` far
should re-derive those windows before trusting the clear rates it measures**, because a table that
has run out of room fails by being unmeasurable rather than by being wrong.

**Priced and declined: buying band 3 into AC-240's assertion range.** [AC-240](acceptance-criteria.md)
does not assert on a band clearing above 80 %, so at 81.5 % band 3 still reports `n/a`. Targeting it
at 78 % is reachable — `interval = 105` — but the ladder that follows has band 3 only 2.0 pp above
its own 76 % floor and the 2→3 drop only 1.4 pp inside R3, against 5.5 pp and 5.0 pp for the table
that was chosen. A guard that asserts at two bands with +25.0 and +31.7 pp of measured headroom is
doing its job; a ladder with 1.4 pp of margin is one re-measurement from failing. Margin was
preferred and this is the record of the trade.


---

## 8. Harnesses this design assumes exist

| Tool | What it must assert |
|---|---|
| `tools/generator-audit.mjs --seeds 5000` | V1–V13 hold for every band × seed; zero `GEN_EXHAUSTED`; report attempt-count percentiles, per-rule rejection counts (§5.2) and distinct-network counts per band. Also, per band, the **minimum `firstDecisionTicks`** over every path of every level against [AC-245](acceptance-criteria.md)'s floor of 40 — it is the cheapest possible check and the quantity it guards went unmeasured through two slices. |
| `tools/generator-audit.mjs --rule-injection` | For each of V1–V11 and V13, a fixture that violates that rule, with the rule's check invoked **directly** rather than through `validate()`'s cascade, confirmed to reject it ([AC-244](acceptance-criteria.md)). Eight of the twelve are unreachable through `generate()` (§5.2) and this is the only place their checks are ever executed against a violation. |
| `tools/generator-audit.mjs --actionable --seeds 3000` | Per band: mean and minimum live-junction count under §6.2's lazy-optimal oracle, the share of levels below `Ja`, the mean count of junctions flipped twice or more, and the decorative-junction share of drawn `J` ([AC-243](acceptance-criteria.md)). |
| `tools/spawn-margin.mjs --seeds 2000` | Per band, both oracle variants, two misroutes injected: the worst `max(nextSpawn)` and the resulting margin against `spawns.length`, which must be ≥ 2 ([AC-139](acceptance-criteria.md)). Re-run after every §7.4 lever move. |
| `tools/bot.mjs --seeds 1000` | Unconstrained clear rate = 100 %; constrained clear rate within §7.2's table **and** satisfying R2 and R3's shape rules; measured taps/s per band. |
| `tools/bot.mjs --entry-window` | Per band and per arm of the row-0 bit: the clear rate, **and** the per-car failure rate at each car's first decision against the rate at its other decisions, against [AC-246](acceptance-criteria.md)'s per-band ceiling. The split is reported; the `p` gap is what fails the run. The fault to inject before trusting it is round 3's shipped sweep — a round-robin with no onset capture — which must fail it at bands **2, 3, 4 and 5**. *It must **pass** at band 1 under the injection, and that is the correct result rather than a hole: band 1 never had the defect at a size its own ceiling could see (`+1.23` pp against 3.13), because `quota = 16` gives it a 12.5 % per-car budget. An injection that failed everywhere would mean the ceiling was not derived from `quota` at all. This row said "at every band" through round 5 and contradicted AC-246's own note; the AC was right and this table was wrong.* |
| `tools/bot.mjs --attention-report` | Per band, per 1,000 seeds: mean glances/s, mean focus events/s, the split between `BOT_SWITCH_TICKS` and `BOT_ACQUIRE_TICKS` focuses, mean working-set occupancy, evictions/s, memory expiries/s, onset captures/s and captures as a share of glances (§7.1.5 D3), and the count of misroutes caused by a flip the bot made for a car it was holding onto a car it was not (`breaksHeldCar` could not see). These are the numbers that say *why* a band lands where it does, and without them a missed target is unexplainable. |
| `tools/pacing.mjs` | Completion-time median / p95 / max per band against §7.3. |
| `tools/replay.mjs --seed N` | A recorded run replays to a deeply equal final state, twice in a row and across machines. |

Per `development-process.md:136`: before any of these is trusted to pass, the fault it is meant
to catch is injected and the harness is confirmed to fail.
