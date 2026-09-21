# Offramp — Track Generation

The road-network generator specified as an algorithm: the topology model, the construction
procedure, the rules that reject a candidate, the difficulty parameters per band, and the
measurable targets the tester will hold this design to.

Companion documents: [`gameplay.md`](gameplay.md), [`ui.md`](ui.md),
[`acceptance-criteria.md`](acceptance-criteria.md).

Everything here is a pure function of an integer seed and a band index. No layout is authored.
The generator runs in bare Node, in `src/engine/`, and **uses no floats at all** — round 8's
orthogonal roads removed the one place that needed them (§3.3).

> **Round 8 rebuilt §2 through §6 and re-derived §7.** Roads are orthogonal, the grid is finer,
> row 0 is always a pass, and a level is a fixed two minutes rather than a car quota. The bot of
> §7.1 is **unchanged** — it is the instrument, and
> [`gameplay.md` §8.7](gameplay.md#87-the-bot-is-a-model-of-attention-not-of-timing--decided)
> says why it does not move to suit a reading. Every number read *off* it is new, and every table
> in §6.2, §6.3, §7.2 and §7.3 marked *(to be measured)* is one the developer's sweep must produce
> before it is quoted as a fact.
>
> **What the designer measured and what the developer must.** Everything below is computed in this
> document and re-derivable from the band table in a few lines: §3's geometry, §6.1's `transit`,
> cars-in-flight, `N`, spawn count, flip window, first-decision window and car separation, §6.2's
> generator statistics (attempts, edge topologies, signatures, `J`, `Ja`, `D`, mean depth, jogs),
> §6.3's tap-load *estimate*, §7.1.10's per-car windows and ladder search, and
> [`ui.md` §4.4](ui.md#44-tap-target-arithmetic)'s viewport sweep. **The generator statistics come
> from the designer's own prototype of §4, not from `src/engine/`** — where the two disagree, the
> developer's `generator-audit` is right and §6.2 is corrected.
>
> Everything that needs the real bot is marked and is **not** stated: §6.3's measured tap rate,
> §7.1.5 D3's capture and glance rates, §7.1.9's measured focus events, §7.2.4's five clear rates
> and five per-car error rates, §7.3's delivered medians, §6.2's actionable-junction oracle
> figures, and [AC-513](acceptance-criteria.md)'s converging-car rate. Round 6's readings for these
> are quoted **only** as history, always labelled, and **none of them transfers** — they were taken
> against a quota ladder, a different geometry and a first-decision window the owner has rejected.

---

## 1. What the generator produces

```
level = {
  seed, band,
  C, K, R,                       // columns, colours (= depots), route rows
  colW, rowH,                    // geometry, integers in LU (§3)
  nodes:  [node, ...],           // §2.2 — includes the entry node and the K depot nodes
  edges:  [edge, ...],           // §2.3
  junctions: [nodeId, ...],      // ascending; index is the junctionId
  entryEdgeId,
  speedMluPerTick, interval, jitter,
  spawns: [{index, tick, colour}, ...]   // gameplay.md §2.7, bounded by LEVEL_TICKS
}
```

Everything in it is an integer or a string tag. It serialises to JSON and back with no loss,
which is what makes a bug report a replayable artifact.

`quota` is **gone** from the level object: a level ends on the clock
([`gameplay.md` §4.2](gameplay.md#42-the-clock-and-what-ends-a-level)). So is `diagLen`, because
an edge's length is now computed from its endpoints (§3.3).

---

## 2. The network topology model

### 2.1 A lattice, not a free-form graph

The network lives on an integer lattice of `R + 1` rows by `C` columns in **design space**
(§3.1). One lattice site holds at most one node.

- Rows `0 .. R-1` are **route rows**. Row `R` is the **depot row**.
- Every edge goes from a site in row `r` to a site in row `r+1`. There are no upward edges and
  no edges that skip a row.
- An edge's column change is `Δc ∈ {-1, 0, +1}`. Nothing moves two columns in one row.

This is the load-bearing simplification. It makes the graph a DAG by construction, makes every
root-to-node path exactly `r` edges long, and — most importantly — makes the drawing's overlap
cases finitely enumerable (§2.5).

### 2.2 Nodes

```
node = { id, row, col, x, y, kind, out, junctionId, depotColour }
```

| `kind` | out-degree | in-degree | Is it a tap target? | Column change on its out-edges |
|---|---|---|---|---|
| `entry` | 1 | 0 | no | `Δc = 0` |
| `branch` | 2 | 1 | **yes** — this is a junction | two distinct targets in `{c-1, c, c+1}` |
| `pass` | 1 | 1 | no | **`Δc = 0` — normative, §2.3** |
| `depot` | 0 | ≥ 1 | no | — |

`x` and `y` are integers in LU, derived from `(row, col)` by §3.2. `junctionId` is set iff
`kind === 'branch'`, and is the node's index in `level.junctions` (ascending by node id, so it is
stable and deterministic).

For a `branch` node, `out[0]` is the edge to the **smaller** column and `out[1]` the larger; the
two targets always differ, so the ordering is total. `junction.open ∈ {0,1}` indexes `out`
directly.

**A pass node is not drawn as anything, and its road runs dead straight.** It exists so that a
road can run for several rows without branching, which is how the generator controls vertical
pacing. That its edge is vertical is the single rule §2.5's planarity proof rests on, and it is
stated in the table above rather than only in §2.3 because it is a property of the *node kind*,
not a drawing choice.

### 2.3 Edges

```
edge = { id, from, to, lengthMlu, shape }     // shape ∈ 'entry' | 'straight' | 'jogL' | 'jogR'
```

**Every road segment is horizontal or vertical.** There are no curves. An edge from node
`(r, a)` at `(x_a, y_r)` to node `(r+1, b)` at `(x_b, y_{r+1})` is drawn as:

```
b === a   'straight'          one vertical segment, x_a, from y_r to y_{r+1}
b <  a    'jogL'              horizontal at y_r from x_a to x_b, then vertical at x_b to y_{r+1}
b >  a    'jogR'              horizontal at y_r from x_a to x_b, then vertical at x_b to y_{r+1}
          'entry'             one vertical segment, the entry edge, length ENTRY_LEN
```

**The horizontal run happens at the source row's `y` — at the node itself, not part-way down.**
That is what makes a branch node a corner or a T rather than a fork with a stem, and it is what
makes [`ui.md` §7.3](ui.md#73-junction)'s blade able to point at 90°. §2.5 proves the horizontal
run can never land on another node.

The corner is drawn with a fillet of radius `CORNER_R = 28` LU
([`ui.md` §4.1](ui.md#41-geometry-constants-lu)) — the "little bit of curved corners" the owner
asked for, and nothing else in the network curves.

```
lengthLu = |x_to - x_from| + |y_to - y_from|
```

— so a `straight` is `rowH`, a `jog` is `rowH + colW`, and the entry edge is `ENTRY_LEN`. Three
consequences that matter:

1. **The length is an exact integer computed at build time.** It is two subtractions and an
   addition, bit-identical on every JavaScript engine. The cubic model needed a 128-step chord sum
   and a per-band `diagLen` **table literal**, because `Math.hypot` is not required to be
   bit-identical and a runtime arc length was a determinism hazard
   ([`gameplay.md` §2.2](gameplay.md#22-position-fixed-point-integers-along-an-edge)). The table,
   its reference derivation and the unit test that guarded it against drift are all deleted.
2. **A car's heading is horizontal or vertical, and changes by exactly 90° at a corner.** The
   sprite's rotation is one of four values plus the fillet transition, and the colour-blind glyph's
   counter-rotation ([`ui.md` §6.2](ui.md#62-glyph-drawing-rules)) is a quarter turn rather than an
   arbitrary angle.
3. **A jog costs `colW` of extra travel where a cubic cost about `0.46 × rowH`.** Path lengths
   therefore vary more between colours than they used to — at band 5 a jogging row is 1.83× a
   straight one against the cubic's 1.47× — which is why §6.2 reports mean and maximum jog counts
   and why [`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)'s
   shared-approach overlap got worse.

**The renderer places a car by arc length along the un-filleted polyline and maps that onto the
filleted path**, which makes the drawn speed 1 – 3 % higher through a corner than along a straight.
The simulation never sees it: `progress` is Manhattan and integral. Float lives in `src/render/`,
where it is harmless.

### 2.4 Merge-free by construction

**No node other than a depot has in-degree greater than one.** The route portion of the network
is a tree rooted at the entry; the depot row is where branches are allowed to rejoin, and a car
entering a depot is resolved and removed in the same tick.

This single property delivers four things at once:

- It satisfies `docs/development-process.md:96` — "no junction a car can enter from two
  directions" — completely rather than approximately.
- Two cars share a route edge only if they took the identical path, so their separation *on that
  edge* is exactly their spawn separation
  ([`gameplay.md` §4.5](gameplay.md#45-why-two-cars-never-overlap-on-the-same-road-except-at-a-depot)).
  This needs no validity rule and no tuning.
- Two cars arrive at the same junction only if they took the same path to it, so the minimum
  flip window at any junction equals the minimum spawn gap — 1.60 s at the hardest band
  ([`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time)). That is a
  guarantee about **two cars at one junction**, and it is not the game's tightest window: the time
  from **one car appearing** to its first decision is a different quantity
  ([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)).
- The drawing reads as a river delta: roads only ever divide, never converge, until the depot row.

The alternative — a general DAG with merges — was prototyped and measured. To stop two cars
converging on a shared edge it requires every path to a node to have identical arc length, and
that constraint rejects essentially every candidate at bands 2–5: **0 valid networks in 2,000
seeds per band**, against 3,000/3,000 for the merge-free model. Round 8 measured the same
constraint in its weakest possible form — equal path length to a shared *depot* only — and it is
still unaffordable ([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road),
V16 rejected). The decision is recorded in
[`gameplay.md` §8.2](gameplay.md#82-merge-free-networks--decided).

### 2.5 Planarity and non-coincidence: why no two roads are ever mistaken for one

**The old proof does not survive orthogonal routing and this is its replacement.** Through slices
0–1 an edge was a monotone chord from column `a` to column `b`, and two chords `(a→b)`, `(a'→b')`
with `a < a'` crossed iff `b > b'`; V2's strictly increasing targets forbade the only such pair,
the adjacent swap. That argument is about crossings. Manhattan routing introduces a **worse**
failure: two horizontal runs in the same row band can be **collinear and touching**, which draws as
one continuous road with a fork in the middle that is not a junction. A crossing is confusing; a
false continuation is a lie about where a car can go.

Every road segment in a row band is one of three things:

```
H(a→b)   the horizontal run of a jog edge, at y = y_r, spanning [x_min(a,b), x_max(a,b)]
V(b)     the vertical drop of a jog edge to column b, at x = x_b, from y_r to y_{r+1}
S(a)     the whole of a straight edge, at x = x_a, from y_r to y_{r+1}
```

Two facts drive everything. **(P)** a pass node's edge is vertical (§2.2), so a jog exists only at
a branch node, which also emits a second edge. **(V2)** targets across a route row, read in source
order and within a source in increasing order, are **strictly increasing** (§5); across the
terminal row they are **non-decreasing**.

**Lemma 1 — a jog's target column is empty in the source row.** Suppose edge `(a→a+1)` exists.
V2 sets `minTarget = a+2` for every later source, so a node at column `a+1` in row `r` would have
to emit targets `≥ a+2`; with `|Δc| ≤ 1` its only candidate is `{a+2}`, a *pass* that changes
column, which (P) forbids, and it cannot form a branch from a single candidate. So no node sits at
`(r, a+1)`. The mirror argument covers `(a→a-1)`. ∎

*Lemma 1 is what allows the horizontal run to sit at `y_r`: it can never terminate on another
node's centre.*

**Lemma 2 — two horizontal runs never overlap, and touch only when they share a source.** Take
jogs from sources `a ≤ a'`.
- `a = a'`: one branch, two jogs, `H(a→a-1) = [x_{a-1}, x_a]` and `H(a→a+1) = [x_a, x_{a+1}]`.
  They meet at `x_a`, which is the node itself. This is the T, and it is the intended drawing.
- `a < a'`, `e` a right jog: by V2 later sources target `≥ a+2`, and by Lemma 1 `a+1 ∉ rows[r]`, so
  `a' ≥ a+2`. The only span that can reach `[x_a, x_{a+1}]` is a left jog from `a+2`, spanning
  `[x_{a+1}, x_{a+2}]` — which targets `a+1`, the same target as `e`. On a route row that is a
  duplicate target, forbidden by V2. On the terminal row it is permitted, and then both runs feed
  the **same depot**, which is one place and draws as one forecourt (§2.3, [`ui.md` §7.6](ui.md#76-the-depot-terrace)).
- `a < a'`, `e` a left jog spanning `[x_{a-1}, x_a]`: any later source's span starts at `≥ x_{a'-1} ≥ x_a`,
  so the only contact is a left jog from `a+1` spanning `[x_a, x_{a+1}]`, targeting `a`. Source `a`
  contains `a-1` among its targets, so its options are the pass `{a-1}` (forbidden by (P)) or a
  branch `{a-1, a}` or `{a-1, a+1}`, both of which set `minTarget ≥ a+1` and stop `a+1` targeting
  `a`. Forbidden. ∎

**Lemma 3 — two verticals never coincide except where they feed one depot.** `V(b)` and `S(a)`
both occupy a full row height at their column. Two of them coincide iff they have the same target
column. On a route row targets are distinct (V2), so they cannot. On the terminal row two or three
edges may share a depot column, and they then share the approach road for the whole row —
that is [`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road),
it is one road into one building, and it is covered by the depot terrace. ∎

**Lemma 4 — a vertical never meets a horizontal except at its own corner.** A horizontal at `y_r`
touches column `x_c` only at a span endpoint (`|Δc| ≤ 1` leaves no interior column). At the source
endpoint it is its own edge leaving the node; at the target endpoint, Lemma 1 says no node and
therefore no `S` is there, and any other `V` at that column would be a duplicate target (Lemma 3's
argument). ∎

**Therefore: within a row band, the only coincidences are a branch's own T and the depot row's
shared approach.** Neither is a false continuation: the first is the junction the marker is drawn
on, the second is a single road into a single depot. The generator needs no geometric test.
Planarity and non-coincidence are properties of the construction, verifiable by a two-line check
([AC-206](acceptance-criteria.md)), and the fault to inject before trusting that check is a
generator with rule (P) removed — which produces collinear touching runs on 4 – 11 % of levels
(§5.2).

### 2.6 A worked example

Band 3, `C = 4`, `K = 4`, `R = 6`, entry at column 1, `J = 5`, depth 2–3.

```
              col 0      col 1      col 2      col 3
              x=155      x=385      x=615      x=845
                            │
   entry  y=  50            │              (entry edge, 220 LU, vertical)
                            │
   row 0  y= 270            ·              V14: row 0 is always a pass — no junction here
                            │
   row 1  y= 450            ◆──────────╮   branch {1, 2}: down, and right at y=450
                            │          │
   row 2  y= 630        ╭───◆          ◆───────────╮      two branches, both turning
                        │   │          │           │
   row 3  y= 810        ·   ·          ·           ·      a pass row: four roads run straight
                        │   │          │           │
   row 4  y= 990        ·   ◆──╮       ·           ·
                        │   │  │       │           │
   row 5  y=1170        ·   ·  ·       ·           ·
                        │   │  │       │           │
   depot  y=1350      ┌───┐┌───┐    ┌───┐       ┌───┐
                      │ A ││ B │    │ C │       │ D │
                      └───┘└───┘    └───┘       └───┘
                      Ember  Sky     Rose        Teal
```

`◆` is a junction (branch node); `·` is a pass node and is not drawn. Every corner in the picture
is at a `◆`, which is §2.5's rule (P) seen from the outside.

Depth from the entry: depot A takes 3 junctions, B takes 3, C takes 2, D takes 2. Different
colours cost different amounts of attention within the same level, which is deliberate.

---

## 3. Geometry: how the graph maps to the screen

### 3.1 Design space

The generator works entirely in a fixed, device-independent rectangle:

```
DESIGN_W = 1000 LU
DESIGN_H = 1500 LU
```

Nothing about the device reaches the engine. The renderer maps this rectangle into the play area
with a single uniform scale ([`ui.md` §4](ui.md#4-the-play-surface)). An engine that knew the
screen size would produce different levels on different phones, and a bug report from an iPhone
would not reproduce on CI.

**`DESIGN_H` moved 1600 → 1500 and the reason is that LU is a ratio unit, so only the aspect
matters.** The binding device is the iPhone SE 1st generation, whose play area is 320 × 484 pt — an
aspect of 0.661 against the old rectangle's 0.625, so the old rectangle was **height-bound there
and wasted 17.5 pt of width**. At 1000 × 1500 the aspect is 0.667 and the SE fits both ways at a
scale of **0.3200** instead of 0.3025, a 5.8 % gain in every on-screen dimension, on the one device
every size floor in [`ui.md` §4.4](ui.md#44-tap-target-arithmetic) is measured against. That gain is
what pays for the sixth column at band 5.

### 3.2 Site coordinates

```
ENTRY_Y   = 50
ENTRY_LEN = 220
ROW0_Y    = ENTRY_Y + ENTRY_LEN = 270
ROUTE_H   = 1080                        // DEPOT_Y - ROW0_Y, the same at every band
DEPOT_Y   = ROW0_Y + ROUTE_H = 1350

colW  = per band (§6.1)
rowH  = ROUTE_H / R
x(c)  = 500 + (c - (C-1)/2) * colW
y(r)  = ROW0_Y + r * rowH
```

`DEPOT_Y + DEPOT_H = 1350 + 128 = 1478` against `DESIGN_H = 1500`, so 22 LU of margin sits below
the depot bodies ([`ui.md` §3.3](ui.md#33-measured-fit-across-real-devices),
[AC-411](acceptance-criteria.md)).

All of these are exact integers for every `(C, R)` the bands use:

| `C` | `colW` | column x positions | outermost depot edge to the rectangle |
|---|---|---|---|
| 3 | 260 | 240, 500, 760 | 178 LU |
| 4 | 230 | 155, 385, 615, 845 | 93 LU |
| 5 | 180 | 140, 320, 500, 680, 860 | 78 LU |
| 6 | 150 | 125, 275, 425, 575, 725, 875 | 63 LU |

| `R` | `rowH` | row y positions (row 0 … depot row) |
|---|---|---|
| 5 | 216 | 270, 486, 702, 918, 1134, 1350 |
| 6 | 180 | 270, 450, 630, 810, 990, 1170, 1350 |

`colW` is a **band-table value, not a division of a lane span**. Slices 0–1 derived it as
`min(300, LANE_SPAN / (C - 1))`, which made integrality an accident of which `C` a band happened to
use — §5.2's "integer geometry is a construction guard" existed precisely because a band-table edit
could produce a non-divisor. Naming `colW` directly makes integrality a property of the table, and
the guard's second half (`rowH = ROUTE_H / R`) is the only division left.

**The minimum distance between two lattice sites is `min(colW, rowH)`: 216 / 216 / 180 / 180 /
150 LU by band.** That is the number the 44 pt tap-target arithmetic in
[`ui.md` §4.4](ui.md#44-tap-target-arithmetic) is built on, and at band 5 it is the binding
constraint on the whole design — 150 LU at the SE's 0.3200 scale is a 46.1 pt junction target
against a 44 pt floor. It is why `C` is capped at 6.

**`ENTRY_LEN = 220` and the vertical budget.** `ENTRY_Y + ENTRY_LEN + ROUTE_H + DEPOT_H + margin`
is 50 + 220 + 1080 + 128 + 22 = 1500, exactly. The entry edge is 220 LU rather than the 160 it was,
but the first-decision window is no longer bought with it: V14 makes row 0 a pass, so the window is
`ENTRY_LEN + rowH` = 400 to 436 LU
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)).
Spending 60 LU of `ENTRY_LEN` on `ROUTE_H` would buy `rowH` back at a ratio of 1 : 1 at `R = 6`, so
the split is nearly free either way; 220 is chosen because the entry road is a real piece of the
picture the player watches for onsets, and 160 LU of it at the smaller scale is only 51 pt.

### 3.3 Edge lengths

```
lengthLu  = |x_to - x_from| + |y_to - y_from|
lengthMlu = lengthLu * MLU
```

| shape | length in LU | band 1/2 (`rowH` 216) | band 3/4/5 (`rowH` 180) |
|---|---|---|---|
| `entry` | `ENTRY_LEN` | 220 | 220 |
| `straight` | `rowH` | 216 | 180 |
| `jogL` / `jogR` | `rowH + colW` | 476 / 446 | 410 / 360 / 330 |

There is no offline derivation, no sampling, no table to drift, and no `diagLen` constant.
[AC-207](acceptance-criteria.md) asserts the identity directly against every edge of every
generated level. **This section used to be the only place in the generator that touched floating
point**; it now does not, and neither does anything else in `src/engine/`.

### 3.4 Placing a car (renderer only)

A car at `progress` MLU along an edge is placed by walking the edge's segments in order and
consuming `progress`: at most two segments, no table, no arc-length parameterisation, no binary
search. Where the walk lands within `CORNER_R` of a corner the renderer interpolates onto the
fillet and rotates the sprite through the 90°; the positional error against the polyline is at most
`CORNER_R * (√2 - 1) ≈ 11.6` LU, which is inside the road's 42 LU half-width, and the drawn speed
through a corner is 1 – 3 % above nominal.

The 65-entry `distance → t` table per edge shape that slices 0–1 needed is **deleted**.

---

## 4. The generator, as an algorithm

```
generate(seed, band):
  P   = BAND[band]                                  // §6.1
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
are in §6.2; the worst observed over 15,000 runs is 20.

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
     band     = buildRow(rng, rows[r], allowed, terminal, P.pBranch, /*forcePass=*/ r === 0)
     if band === null: return null
     rows[r+1] = sorted distinct targets of band
     if !terminal and rows[r+1].length > C: return null
     record edges
  return { entryCol, depotCols, rows, edges }
```

`forcePass` at `r === 0` is **V14**, applied as a construction constraint rather than a rejection
rule, for the reason §5.2 gives about the row-0 experiment in round 4: as a rejection rule it
costs attempts, as a construction constraint it costs none.

### 4.2 `buildRow` — depth-first with backtracking

Sources are processed left to right. A running `minTarget` enforces the ordering rule that makes
the row simultaneously merge-free and non-coincident.

```
buildRow(rng, srcs, allowed, terminal, pBranch, forcePass):
  budget = 40000 recursion steps      // exceeding it fails this attempt, not the level

  rec(i, minTarget):
     a    = srcs[i]
     if i === srcs.length:
        if terminal: return every depot column is covered
        return true
     cand = [a-1, a, a+1] ∩ allowed, filtered to >= minTarget
     passOptions   = cand contains a ? [[a]] : []       // RULE P: a pass goes straight down
     branchOptions = shuffled 2-subsets of cand
     options = forcePass ? passOptions
             : (rng() < pBranch) ? branchOptions ++ passOptions
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

**`passOptions` is the one-line expression of §2.5's rule (P), and it is the whole of what
orthogonal roads cost the generator.** Slices 0–1 offered a pass node every candidate column —
`[[a-1], [a], [a+1]]` — so a road could drift sideways without branching. It cannot any more:
a road changes column only at a junction
([`gameplay.md` §8.9](gameplay.md#89-a-road-changes-column-only-at-a-junction--decided-round-8)).
§5.2 measures what that cost.

`pBranch` is the band's branch bias (§6.1). It steers the search toward the junction count the
band wants without adding a rejection round-trip: with `pBranch = 0.90`, branch options are tried
first 90 % of the time.

The `nextMin` rule is doing three jobs at once. Targets across a route row are strictly
increasing, which means (a) no two nodes share a target — the network is merge-free; (b) together
with rule (P), no two roads are ever drawn as one (§2.5); (c) every node's targets are contiguous
with its neighbours', which is what keeps the drawing a clean delta.

### 4.3 `finalise`

Assigns node ids in `(row, col)` order, assigns `junctionId` to branch nodes in node-id order,
maps a random permutation of the band's `K` colours onto the `K` depot columns, computes each
edge's `lengthMlu` from its endpoints (§3.3), and builds the spawn schedule
([`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed)).

---

## 5. Validity rules: what rejects a candidate

`validate(net, P)` returns `null` or the id of the first rule violated. Rules are checked in this
order; the id is what a generator-audit failure reports.

| Id | Rule | Why |
|---|---|---|
| **V1** | Every route-row node has out-degree 1 or 2; every depot has out-degree 0 and in-degree ≥ 1. | No dead ends. Every car reaches a depot. |
| **V2** | Targets across a route row are strictly increasing; targets across the terminal row are non-decreasing. | Merge-free (§2.4) and non-coincident (§2.5), in one rule. |
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
| **V14** | The row-0 node is a **pass**. | [`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision). Enforced constructively in `buildRow` (§4.1), asserted here. |
| **V15** | Every `pass` node's outgoing edge has `Δcol = 0`. | §2.5 rule (P). Enforced constructively in `buildRow` (§4.2), asserted here. |

**V14 and V15 are construction constraints with validity-rule numbers, and that is deliberate.**
Neither ever rejects a candidate the shipped `buildRow` produces — `buildRow` cannot construct a
violation — so both sit in §5.2's "structural tripwire" class alongside V1–V5 and V9–V11, and
[AC-244](acceptance-criteria.md) requires each to be executed **directly** against a fixture built
to violate it. They are numbered because they are the two rules a future generator change is most
likely to break without noticing: V15 breaks the drawing (§2.5) and V14 breaks the fairness floor
([AC-245](acceptance-criteria.md)), and neither failure shows up in a clear rate.

**V6 subsumes the "no-op junction" case, and V13 subsumes the decorative one.** If both branches
reached the same set, flipping the junction would change nothing for any colour and the player
would learn that tapping sometimes does nothing — that is V6. But *differing* is weaker than
*mattering*. Where one branch's set strictly contains the other's, the superset branch serves every
colour the subset branch does, so a perfect player leaves the junction alone for the whole level.
V13 is the floor that makes `Ja` in §6.1 true. §6.2 gives what it cost and §5.1 gives what was
tried instead.

### 5.1 Why V6 was not simply strengthened

The obvious repair is to require **every** junction's two sets to be incomparable, rather than
requiring `Ja` of them. It was prototyped against the slice-1 generator and it is not a repair: the
generator starts failing (`GEN_EXHAUSTED` on 2 % and 7.3 % of seeds at bands 4 and 5), the attempt
count goes from a median of 2 to a median of 61, and the surviving networks collapse onto the
**bottom** of their `J` range — so the strengthened rule makes the game easier and the generator
unreliable.

The cause is structural and worth stating, because it constrains any future repair. Merge-free
networks are trees except on the terminal row, where V2 lets two edges land on the same depot
(§2.4). Two branches of a tree reach disjoint depot sets, and disjoint non-empty sets are never
comparable — so **every comparable pair comes from a shared depot.** Forbidding comparable pairs
outright forbids shared depots outright, which is the same topology
[`gameplay.md` §8.8](gameplay.md#88-45s-guarantee-is-narrowed-not-repaired--decided-and-the-number-got-worse)
decided to keep and draw correctly rather than generate away — and which
[`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road) now shows
is *arithmetically required*, because without shared depots a binary tree with `K` leaves has
exactly `K - 1` branch nodes and band 5's `J` would be pinned at 4 against a table asking for 7–9.
V13 asks for enough actionable junctions instead of all of them, and costs almost nothing (§6.2).

### 5.2 Which rules actually reject anything, and what rule (P) and V14 cost

**Three rules do the filtering — V6, V7 and V8 — and the other nine are structural tripwires.**
That was measured over 15,000 `generate()` calls in slice 1 and rule (P) does not change the shape
of it: `buildRow` enforces V2, V4, V9, V14 and V15 as it searches, `finalise` makes V1, V5 and V10
true by construction, and V3 is implied by V2. **A tripwire whose check has never been executed
against a violation is not a check**, which is why [AC-244](acceptance-criteria.md) requires each
rule's own predicate to be invoked directly on a fixture rather than through `validate()`'s ordered
cascade.

**What rule (P) and V14 cost, measured over 3,000 seeds per band.** Four generators, differing only
in whether a pass node may change column and whether row 0 may branch:

| Generator | band 1 | band 2 | band 3 | band 4 | band 5 |
|---|---|---|---|---|---|
| **shipping: (P) + V14** — distinct edge topologies | **63** | **251** | **312** | **744** | **794** |
| (P) only, row 0 free | 95 | 335 | 358 | 804 | 876 |
| V14 only, a pass may jog | 380 | 1118 | 913 | 1653 | 1589 |
| neither (the slice-1 generator's freedom) | 260 | 814 | 640 | 1314 | 1407 |
| **shipping: distinct signatures** | **279** | **851** | **1380** | **2216** | **2745** |
| **shipping: attempts median / p95 / max** | **1 / 5 / 15** | **2 / 8 / 20** | **1 / 3 / 8** | **2 / 6 / 14** | **1 / 4 / 9** |
| **shipping: valid networks** | 3000/3000 | 3000/3000 | 3000/3000 | 3000/3000 | 3000/3000 |

Three things to read here.

- **Rule (P) is the expensive one, not V14.** It costs between 51 % and 83 % of the shape space on
  its own (`380 → 95`, `1118 → 335`, `913 → 358`, `1653 → 804`, `1589 → 876` with row 0 free),
  because forbidding a pass node to drift sideways removes an entire construction. V14 on top of it
  costs a further `95 → 63`, `335 → 251`, `358 → 312`, `804 → 744`, `876 → 794` — between 8 % and
  34 %, and the 34 % is band 1, the band with the least to lose it from.
- **Neither costs the generator anything in attempts.** Median 1–2, p95 3–8, worst 20 over 15,000
  runs against [AC-203](acceptance-criteria.md)'s ceiling of 128 and `MAX_ATTEMPTS = 256`. Round 4
  measured the row-0 ban as a *rejection* rule reaching `MAX_ATTEMPTS` on 2 seeds per 1,000 at
  band 5; as a construction constraint (§4.1) it is free. That distinction is the whole reason V14
  is affordable now and was not then.
- **The variety floor is met because the grid paid for it, and band 1 is the band it was paid for.**
  Every band gained a row or a column in round 8. Distinct network **signatures** — edge topology
  plus depot-colour assignment, which is what a player distinguishes — come out at
  `279 / 851 / 1380 / 2216 / 2745`, against [AC-234](acceptance-criteria.md)'s re-derived floors of
  `160 / 250 / 360 / 490 / 1000`. Band 1 clears its floor by 74 %. **At `R = 4` it measured 155
  against 160 and failed**, which is the measurement that decided band 1's fifth row: the row buys
  nothing a player would name and everything the variety floor needs.

**Round 4's rejection of the row-0 ban is overturned, and both of its grounds were re-measured.**
It was rejected on variety (it took band 1 to 13 edge topologies against a floor of 30) and on
over-correction (with it in force the constrained bot cleared `100 / 100 / 99.9 / 96.9 / 25.0 %` and
[AC-240](acceptance-criteria.md) lost its headroom at four bands). The first ground is gone: at
`C = 3, R = 5` band 1 measures 28 edge topologies and 155 signatures rather than 13, because the
band gained two rows since that measurement. The second ground is **not re-measurable by me** — it
needs the bot — but it is no longer the same question: under a quota, "over-corrected" meant the
clear rate saturated at 100 % and the sensitivity guard had no room; under a clock, the same
removal of load is absorbed by `N` being 32–52 rather than a quota of 16–51, and §7.2.4's table is
where the answer has to come from. **The developer's sweep must re-run
[AC-240](acceptance-criteria.md) and report it per band; if it fails for want of headroom at bands
1–3 that is a finding about the new table, not a reason to re-open V14**, which is settled by tier-5
feedback.

**Integer geometry is a construction guard, not a validity rule.** §3.2 derives `rowH` by division,
and nothing in the search makes the result integral — the integrality of every shipped band is a
property of `ROUTE_H = 1080` being divisible by 5 and 6, so the first band-table edit that picks a
non-divisor would produce a level `generate()` accepts, with float node positions and a float
`progress` accumulating inside the simulation. That is a broken *band table*, not an unlucky
candidate, so retrying cannot fix it and it must **throw** rather than return a rule id
([AC-218](acceptance-criteria.md)). It is therefore deliberately outside the V-numbering.
*`colW` no longer participates: round 8 made it a table value rather than `LANE_SPAN / (C - 1)`,
which removes one of the two divisions this guard existed for (§3.2).*

---

## 6. Difficulty parameters per band

### 6.1 The table

| Band | Levels | `C` | `K` | `R` | `pBranch` | `J` | `Ja` | `D` | `colW` | `rowH` | Speed MLU/tick | LU/s | `interval` | `jitter` | **`N`** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | 3 | 3 | 5 | 0.85 | 3–4 | 3 | 2–3 | 260 | 216 | 2750 | 165 | **204** | ±26 | **32** |
| 2 | 5–9 | 4 | 3 | 5 | 0.80 | 3–5 | 3 | 2–3 | 230 | 216 | 2900 | 174 | **150** | ±18 | **44** |
| 3 | 10–15 | 4 | 4 | 6 | 0.85 | 4–6 | 4 | 2–4 | 230 | 180 | 3050 | 183 | **140** | ±18 | **47** |
| 4 | 16–22 | 5 | 4 | 6 | 0.85 | 5–7 | 5 | 2–4 | 180 | 180 | 3200 | 192 | **132** | ±16 | **50** |
| 5 | 23+ | 6 | 5 | 6 | 0.90 | 7–9 | 7 | 2–5 | 150 | 180 | 3350 | 201 | **128** | ±16 | **52** |

`quota` and `SPAWN_SLACK` are **gone**. `diagLen` is gone (§3.3). Every remaining column moved in
round 8, because every one of them is tied to a geometry or a duration that the owner's four
changes displaced.

**`N` is the column that replaced `quota`, and it is not a parameter.** It is the number of cars
that *arrive at a depot* inside the two-minute clock:

```
N(band) = #{ i >= 0 : SPAWN_LEAD + i * interval + transit < LEVEL_TICKS }
        ~ (7200 - 90 - transit) / interval
```

with `transit` the mean root-to-depot journey in ticks (§6.2). **It is determined entirely by
`interval`**, and that is the single structural consequence of the fixed clock that everything in
§7 turns on. Under the quota model the number of cars in a run was a free parameter and
§7.4's **lever 0** — move `interval` and `quota` against each other so that `(quota - 1) · interval`
holds the duration — was the lever that fixed the difficulty curve. **Lever 0 no longer exists**:
there is no second term to trade against `interval`, because the duration is a constant and the
car count is its consequence. §7.4 is rewritten around what is left.

**Derived quantities, computed rather than measured**, given §3.2's geometry and §6.2's measured
jog counts:

| Band | transit min / mean / max (ticks) | cars in flight | `N` | spawns scheduled | flip window (§4.6) | first decision (§4.6b) | min car separation |
|---|---|---|---|---|---|---|---|
| 1 | 473 / 587 / 757 | 2.88 | **32** | 35 | 2.53 s | 159 ticks (2.65 s) | 418 LU |
| 2 | 449 / 570 / 687 | 3.80 | **44** | 48 | 1.90 s | 151 ticks (2.52 s) | 331 LU |
| 3 | 427 / 544 / 728 | 3.89 | **47** | 51 | 1.73 s | 132 ticks (2.20 s) | 317 LU |
| 4 | 407 / 512 / 632 | 3.88 | **50** | 54 | 1.67 s | 125 ticks (2.08 s) | 320 LU |
| 5 | 389 / 481 / 612 | 3.76 | **52** | 56 | 1.60 s | 120 ticks (2.00 s) | 322 LU |

`transit` is `(ENTRY_LEN + R·rowH + jogs·colW) / speed`, with `jogs` at 0, the measured mean
(§6.2) and the measured maximum. **Journeys are 20–30 % longer than they were** — 8.0 to 12.6 s
against the old 7.4 to 9.6 — because a jog now costs `colW` where a cubic cost about `0.46 · rowH`
(§2.3). Cars in flight is `transit / interval`, and it lands at 2.9 to 3.9 against the old 3.0 to
4.3: **the board is about as busy as it was, at a much lower spawn rate.** That is the trade
orthogonal roads make, and it is why the `interval` column is not comparable to the old one.

**`interval` is monotone across the ladder for the first time.** It falls 204 → 150 → 140 → 132 →
128. Round 6 proved, under the quota model, that it *could not* be: band 5 needed a long interval
to clear its floor and band 4 needed a short one to stay under its ceiling, so the traffic axis
inverted after band 3 (§7.4.1). The clock removes that constraint, and §7.1.10 gives the
arithmetic — cutting `interval` now raises `p` **and** `N`, so a given drop in clear rate costs
roughly half the rise in per-car error it used to.

**Band 1 is the slowest band in the game by a long way and that is the answer to the two-minute
floor.** At `interval = 204` a car enters every 3.40 s, 32 arrive in the level, and 2.9 sit on the
board at once. A fixed two minutes makes band 1 two and a half times longer than it was
([`gameplay.md` §4.2](gameplay.md#42-the-clock-and-what-ends-a-level)); the only thing left to
control is how much happens in them.

`D` is `[Dmin, Dmax]` over all root-to-depot paths. `J` is `[Jmin, Jmax]`, the count of junctions
**drawn**. `Ja` is the floor on junctions that are **actionable** — V13, §5 — and it is a minimum,
not a range.

**`Ja` is set to `Jmin`, and that is not a coincidence of convenience.** Actionable junctions are
bounded by what there is to decide — with `K` colours a path of decisions can sort at most `K`
destinations, so actionable `J` tracks `K`, not the drawn junction count. **Above the floor, the
band table's `J` axis is mostly the `K` axis in disguise**, and whoever next pulls a lever should
reach for `K` or `interval` before `pBranch`.

### 6.2 Measured generator behaviour

Measured over **3,000 seeds per band**, 15,000 runs total, in the designer's prototype of §4 with
rule (P), V13 and V14 in force. *These are the figures the developer's `generator-audit` must
reproduce; where they differ, the audit is right and this table is wrong.*

| Band | Valid networks | Attempts: med / p95 / max | Edge topologies | Signatures | `J` distribution | `Ja` distribution | `D` range | mean depth | jogs per path, mean / max |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 3000 / 3000 | 1 / 5 / 15 | 63 | **279** | 3: 13 %, 4: 87 % | 3: 100 % | 2–3 | 2.35 | 1.20 / 3 |
| 2 | 3000 / 3000 | 2 / 8 / 20 | 251 | **851** | 3: 9 %, 4: 25 %, 5: 67 % | 3: 100 % | 2–3 | 2.54 | 1.54 / 3 |
| 3 | 3000 / 3000 | 1 / 3 / 8 | 312 | **1380** | 4: 1 %, 5: 14 %, 6: 85 % | 4: 10 %, 5: 90 % | 2–4 | 2.87 | 1.55 / 4 |
| 4 | 3000 / 3000 | 2 / 6 / 14 | 744 | **2216** | 5: 1 %, 6: 19 %, 7: 80 % | 5: 100 % | 2–4 | 3.10 | 1.88 / 4 |
| 5 | 3000 / 3000 | 1 / 4 / 9 | 794 | **2745** | 7: 1 %, 8: 19 %, 9: 80 % | 7: 100 % | 2–5 | 3.47 | 2.06 / 5 |

**The `max` in the attempts column is a sample maximum and it grows with the seed count. Read it
that way, and never as a bound.** Median and p95 are stable statistics of the generator; `max` is
the largest of `seeds` draws from a geometric-ish tail. [AC-203](acceptance-criteria.md)'s ceiling
is 128 and its stated reason is `MAX_ATTEMPTS = 256`, so the honest reading of 20 is "the observed
worst case is a sixth of a budget that is itself twice the ceiling", and the number to quote
alongside it is always the seed count that produced it.

**Band 1's variety was the number that decided band 1's geometry, and it is worth recording how.**
[AC-234](acceptance-criteria.md)'s floors are derived, not chosen: a band of `L` levels drawing
from `T` distinct signatures repeats with probability about `L²/2T`, and `T >= 10 L²` puts that
under 5 %; band 1 is four levels, so `T >= 160`. At `C = 3, R = 4` — the obvious band-1 geometry,
one row more than the old band 1 — the generator measures **155 signatures against 160 and fails**.
At `C = 3, R = 5` it measures **279**, clearing the floor by 74 %. Two alternatives were priced:

- **`C = 4, K = 3`** (band 2's shape, three depots in four columns): 89 edge topologies and 400
  signatures at `R = 4`, comfortably over — but it makes bands 1 and 2 differ only in `interval`,
  which takes "the network widens" out of the 1 → 2 step in
  [`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order) and leaves that step
  carrying the entire traffic budget with nothing beside it. **Declined**, and this is the trade to
  revisit first if a tester reports band 1 feeling repetitive.
- **Moving the floor.** Declined: a floor derived from a repeat probability that moves to meet a
  measurement is not a floor.

So band 1 has five rows, which is one more than its depth needs — `D` is 2–3 either way — and the
row exists for the variety floor rather than for the player. That is an honest reason for a
parameter to have the value it has, and it is stated here because nothing else in the band table
would explain it.

**Actionable junctions, measured rather than assumed.** A *lazy-optimal oracle* is the reference
reading, and it is normative because §6.2 is cited by [AC-243](acceptance-criteria.md): at each
tick, for every car that will transition onto a branch node during that tick's advance, if the
junction's currently open branch cannot reach that car's colour, flip it — and never otherwise.
This is what a perfect player does, it delivers every car at every band, and the junctions it never
flips are the junctions the level never asked about. *Mean and minimum live-junction counts, the
share of levels below `Ja` and the mean count of junctions flipped twice or more are* **(to be
measured)** *by the developer's `--actionable` sweep against the round-8 table.*

**V12 (cross-level rule).** A level's network signature — the sorted edge list plus the entry
column plus the depot-colour assignment — must differ from the immediately preceding level's. If it
matches, re-derive with `seed = mix32(seed, 0xC2B2AE35)` and rebuild, up to 8 times.
([AC-213](acceptance-criteria.md)) *This matters most at band 1, for the reason above.*

### 6.3 Tap load

The sustained tap rate is the third difficulty metric. It is derived rather than targeted, and
the constrained bot measures the true value.

| Band | Spawn rate | Mean depth | Estimated taps/s | Cars in flight, mean | Measured taps/s |
|---|---|---|---|---|---|
| 1 | 0.294 /s | 2.35 | 0.35 | 2.88 | *(to be measured)* |
| 2 | 0.400 /s | 2.54 | 0.51 | 3.80 | *(to be measured)* |
| 3 | 0.429 /s | 2.87 | 0.62 | 3.89 | *(to be measured)* |
| 4 | 0.455 /s | 3.10 | 0.71 | 3.88 | *(to be measured)* |
| 5 | 0.469 /s | 3.47 | 0.81 | 3.76 | *(to be measured)* |

The estimate is `spawn rate × mean depth / 2` and assumes a junction is in the wrong state half the
time, which overstates the true rate because consecutive same-colour cars inherit a correct
junction. The measured value from `tools/bot.mjs` is the one that counts
([AC-233](acceptance-criteria.md), ceiling 1.25 /s).

**Two things about this table read differently under a clock.** The estimate now rises
monotonically — it did not under round 6, because the spawn rate peaked at band 3 — and the rate is
sustained for **exactly 120 s at every band**, which is the longest any band ever asked for and is
now what band 1 asks for too
([`gameplay.md` §8.6](gameplay.md#86-tap-load--closed-by-measurement-and-re-opened-by-the-clock)).
The ceiling stays at 1.25 /s because it was derived from what a thumb can do, not from how long it
did it.

**Read this table as an upper bound on *demand*, never as a prediction of the bot.** Slice 1 found
that a broken bot policy's measured tap rate landed almost exactly on this estimate while clearing
0.7 % of band 5 — a bot can match the tap rate by tapping the wrong things. Agreement between this
column and a measured column is not evidence that the bot is playing well, and the two must never
be used to corroborate each other.

---

## 7. The measurable targets

These are the numbers the tester will hold this design to. They are measured by
`tools/bot.mjs --seeds 1000` per band.

**There are two, and there used to be three.** §7.2 is the constrained-bot clear rate and §7.3 is
the delivery band. The third — the completion-time band — **no longer exists**: every level is
exactly 7,200 ticks, so there is nothing to measure and nothing to get wrong
([`gameplay.md` §5.3](gameplay.md#53-session-length)). Five acceptance criteria and a 130 s ceiling
went with it.

### 7.1 The constrained solver bot

An omniscient bot proves nothing about playability (`development-process.md:99`). The bot that
the targets are stated against is constrained to human limits, and its constraints are
normative — a bot that clears a level by doing something a person cannot do is not evidence.

**Nothing in §7.1 changed in round 8 and that is deliberate.** The geometry moved, the clock
replaced the quota and the grid got finer; the instrument did not move with them, because an
instrument that moves to suit a reading is not one. §7.4's exception clause — a §7.1 constant
changes only when the *model of a human player* is shown to be wrong, and then every target is
re-read — is the only route, and round 8 did not take it. What round 8 did find is a limit on what
this instrument can *certify*, and that is in
[`gameplay.md` §8.11](gameplay.md#811-what-the-acceptance-criteria-could-not-certify--recorded-round-8):
the bot passed a first-decision window a human failed, because the acceptance criterion derived
from it priced one of the model's two terms.

**The section was rewritten after slice 1** because the previous wording admitted at least three
readings and band 5's measured clear rate moved 0.7 % → 30.0 % → 100 % across them. Worse, the most
permissive reading cleared **100 % at every band while obeying every constraint the section
imposed**, because every constraint was a *timing* constraint. Offramp's subject is divided
attention, and nothing in the old bot ever divided its attention. What follows is an **attention
model**, written so that two competent implementers cannot disagree about what the bot does on any
tick.

#### 7.1.1 What the bot is a model of

A **competent, attentive adult playing with one thumb**. Not an expert, not a beginner, not a
machine. It is the instrument §7.2's clear rate is read off — and §7.3's delivery band, which is a
report rather than a target — so the question to ask of every constant below is not "is this
optimal?" but "is this what a person can do?".

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
                         //   colour must be re-observed at full price. See the note below for
                         //   what it is and is not worth against §6.1's round-8 interval column.

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

**`BOT_MEMORY_TICKS` has never moved and its rationale has now been rewritten three times, twice
because a band-table edit falsified it.** Slice 0 said memory "carries less of the board as the
bands get harder"; round 6's interval column made that false. Round 6 replaced it with "memory
spans at most one spawn interval anywhere in the game"; the ratios printed two paragraphs below it
said 1.09 to 1.13 at bands 2, 3 and 4, so that was false on the same page. **Both drafts claimed a
clean bound the arithmetic does not offer**, and the third draft will not.

Under §6.1's round-8 column, `120 / interval` is **`0.59 / 0.80 / 0.86 / 0.91 / 0.94`**. What that
supports, stated as tightly as the numbers allow and no tighter:

- Memory is now **shorter than one spawn interval at every band**, for the first time, and it
  shortens relative to the interval as the ladder gets *easier* — it is 59 % of an interval at
  band 1 and 94 % at band 5. It is not a quantity that scales with the band; the interval moved
  under it.
- It **never reaches two spawn intervals**: `2 × interval` is `408 / 300 / 280 / 264 / 256` ticks
  against 120, so the worst case (band 5) is 47 % of two intervals. **No car's colour can survive
  in memory long enough for two further cars to have entered behind it**, at any band.

That second bullet is the property the constant is *for*, and it is the one to regress against:
memory cannot substitute for looking, because the working set of 3 cannot be refilled from memory
faster than the traffic replaces its contents. The first bullet is a **new fact about round 8 that
the sweep should watch**: memory now expires before the next car arrives at every band, where
previously it survived into the next interval at bands 2–4. If the measured clear rates come in
lower than §7.2.2's windows across the board, this is one of the two places to look — the other is
§7.1.9's focus-event demand — and neither is a licence to move the constant.
[`gameplay.md` §8.7](gameplay.md#87-the-bot-is-a-model-of-attention-not-of-timing--decided) and
§7.4 both forbid that.

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
- **It is taken out of the same budget.** Round 6 measured total glances per second unchanged
  (`7.20 / 5.97 / 5.74 / 5.45 / 5.53` against a pure round-robin's
  `7.19 / 6.05 / 5.82 / 5.52 / 5.57`, a drift of `+0.1 / −1.3 / −1.4 / −1.3 / −0.7 %`), so the
  capture is a *reallocation*, paid for by the rest of the board: working-set evictions per second
  rose 29 – 32 % at every band that has any. Attending to a newborn car costs the cars already in
  flight, which is the correct shape for a model of divided attention. **The absolute rates are
  stale under round 8's parameters and [AC-247](acceptance-criteria.md) is written against the
  *drift*, which is the durable claim** — under 2 % between the captured and the pure round-robin
  sweep of the same seeds. *(to be measured)*

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

| Band | `firstDecisionTicks` | cold deadline (car age) | as real time | was, at `ENTRY_LEN = 160` with row 0 free |
|---|---|---|---|---|
| 1 | 159 | 132 | 2.20 s | 27 |
| 2 | 151 | 124 | 2.07 s | 23 |
| 3 | 132 | 105 | 1.75 s | 21 |
| 4 | 125 | 98 | 1.63 s | 18 |
| 5 | 120 | **93** | **1.55 s** | **16** |

**The deadline was only one side of the inequality, and this is the section that said so first.**
The other side is the **latency to the first glance**, and under a pure round-robin that is a
function of how many cars are in flight, not of the deadline. A new car has the largest id, so the
sweep reaches it only after every older car; a glance costs 6 ticks and a glance that escalates
costs 21 or 10 more. Set the two columns side by side, with §6.3's round-8 cars-in-flight means:

| Band | cold deadline (ticks) | round-robin scan cycle, `6 × cars in flight` | binds? |
|---|---|---|---|
| 1 | 132 | 17 | deadline wins, by 115 |
| 2 | 124 | 23 | deadline wins, by 101 |
| 3 | 105 | 23 | deadline wins, by 82 |
| 4 | 98 | 23 | deadline wins, by 75 |
| 5 | 93 | 23 | deadline wins, by 70 |

**Under round 8 the deadline wins at every band with 70 to 115 ticks in hand, and under round 6 it
lost at four of five.** The round-6 reading was `27 / 23 / 21 / 18 / 16` against cycles of
`18 / 26 / 25 / 23 / 20` — the deadline shrank with speed while the latency grew with traffic, and
the two crossed between bands 1 and 2. V14 moved the whole left column up by a row height, and
`interval` moved the right column down by thinning the board; the crossing has gone off the end of
the ladder.

**That is the arithmetic case for V14, and it is the one round 4 did not have.** Round 4 raised
`ENTRY_LEN` 100 → 160 LU, which moved the left column from `7 / 5 / 3 / 2 / 0` to
`27 / 23 / 21 / 18 / 16` — enough to make [AC-245](acceptance-criteria.md) pass and not enough to
cross the right column at four of five bands. D3 (§7.1.5) then made the *first glance* arrive early
enough that the crossing stopped mattering **for the bot**, and every measured number said the
problem was solved. The owner played it and it was not: D3 is a claim about where attention goes
next, and it is true of a person, but it buys a person one reordering of a sweep and not 70 ticks
of runway. **The two repairs are complementary and the design needs both.** D3 is what makes the
first decision reachable once the player has started it; V14 is what gives them time to start.

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
It would also have lengthened every journey, which under a clock reduces `N` at every band — a
consequence the quota model did not have and which
§7.1.10 now prices. D3 costs the generator, the geometry and the layout **nothing**: no rule, no
constant and no node moves.

**Round 8 note: forbidding a branch at row 0 is no longer rejected — it is V14.** This subsection
used to end by rejecting it a third time, on §5.2's variety grounds and on the measurement that the
row-0-pass arm cleared `99.8 / 100 / 99.6 / 92.8 / 10.9 %`, i.e. that it deletes the decision rather
than making it fair. The owner then played the shipped window and could not make the decision at
all. Both grounds were re-measured (§5.2): the variety cost is gone because the grid is finer, and
the over-correction measurement was taken under a quota ladder that no longer exists. **D3 and V14
are not alternatives and this section is not superseded.** D3 makes the first decision *reachable
once the player has started it*; V14 gives them time to start. §7.1.7's two columns are why both
are needed, and [`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)
is the record of the criterion that priced only one of them.


#### 7.1.9 Why this is expected to bind, arithmetically

Attention supply is 60 ticks per second. Demand is one focus per junction decision per car:

| Band | cars/s | mean depth | focus events/s, lower bound | cheapest cost each | dearest cost each | ticks/s demanded | focus events/s, **measured** |
|---|---|---|---|---|---|---|---|
| 1 | 0.294 | 2.35 | 0.69 | 11 | 22 | 8 – 15 | *(to be measured)* |
| 2 | 0.400 | 2.54 | 1.02 | 11 | 22 | 11 – 22 | *(to be measured)* |
| 3 | 0.429 | 2.87 | 1.23 | 11 | 22 | 14 – 27 | *(to be measured)* |
| 4 | 0.455 | 3.10 | 1.41 | 11 | 22 | 16 – 31 | *(to be measured)* |
| 5 | 0.469 | 3.47 | 1.63 | 11 | 22 | 18 – 36 | *(to be measured)* |

Cheapest is `BOT_SCAN_TICKS + BOT_SWITCH_TICKS + 1` (the car was still held); dearest is
`BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS + 1` (it had been forgotten or evicted). Neither figure
counts glances that land on a car needing nothing, which rise with the number of cars in flight.

**The lower bound is monotone again, and that is a consequence of `interval` being monotone.**
Under round 6 the bound inverted at 4 → 5 because band 5 carried fewer cars per second than band 4
while being a harder board, and only the *measured* focus rate — which counts re-focuses — rose at
every step. Under round 8 both should rise, and the measured column is what says whether they do.

**The demand is materially lower than round 6's** — 8–36 ticks/s against 8–38 — because the spawn
rate is lower at every band, and materially *more* of it is re-focus, because journeys are 20–30 %
longer (§6.1) so each car spends longer on the board asking to be looked at again. **The two move
in opposite directions and the net is not predictable from this table**; the `--attention-report`
sweep is what resolves it, and it is the first thing to read if §7.2's clear rates come in wrong.

The gradient is a property of the model rather than of a tuned constant — the same fixed capacity
is asked to cover more decisions per car and more re-visits at every step up the ladder. This is
what §7.2's required *shape* is read against.

#### 7.1.10 Why the clear rate is the wrong number to reason about, and which number is not

**A level is cleared when it collects at most `LIVES - 1 = 2` misroutes across the `N` cars that
arrive inside the two-minute clock.** So if the player answers each car's routing wrongly with
probability `p`, the clear rate is `P(Binomial(N, p) <= 2)` — a **threshold function of `p`**, with
its knee at `p* = 2/N`.

That sentence is the same as it was under the quota model with `N` in place of `quota`, and **the
substitution is not cosmetic, because `N` is no longer free.**

```
quota model:  N was a band-table column.  interval set p.  The two were independent knobs,
              and §7.4's lever 0 moved them against each other at constant duration.

clock model:  N = (LEVEL_TICKS - SPAWN_LEAD - transit) / interval.
              interval sets p AND sets N.  There is one knob and it moves the ball and the
              goalposts together.
```

**Lever 0 is therefore gone, and with it the tool that fixed the difficulty curve two rounds ago.**
What replaces it is the observation that the two effects **compound in the same direction**, which
is better than it sounds:

| pulling `interval` | effect on `p` | effect on `N` | effect on the window `[p_easy, p_hard]` | net |
|---|---|---|---|---|
| **down** (more traffic) | up — less time per car | **up** — more cars to get right | **down** — `p* = 2/N` falls | harder, twice over |
| **up** (less traffic) | down | **down** | **up** | easier, twice over |

So `interval` has roughly **double the leverage** on the clear rate that it had under a quota. It is
a stronger lever and a blunter one: a small pull moves the clear rate a lot, and the band's own
window moves underneath it while it does. §7.4's procedure is written around that.

**The feasible windows, re-derived for the clock.** Each band's `N` comes from §6.1; each band's
clear-rate target from §7.2.2; the `p` column is `P(Binomial(N, p) <= 2)` inverted at each end of
the target, which is arithmetic a reader can re-derive in ten lines without running the game.

| Band | `N` | `p* = 2/N` | `p` at the band's easiest allowed clear rate | …at its hardest | width of the window |
|---|---|---|---|---|---|
| 1 | 32 | 6.25 % | 0 % | **2.60 %** | 2.60 pp |
| 2 | 44 | 4.55 % | **1.53 %** | **2.95 %** | 1.42 pp |
| 3 | 47 | 4.26 % | **2.15 %** | **3.61 %** | 1.46 pp |
| 4 | 50 | 4.00 % | **2.68 %** | **4.12 %** | 1.44 pp |
| 5 | 52 | 3.85 % | **3.11 %** | **4.74 %** | 1.63 pp |

**Read the two inner columns as one interval and the governing fact of this design is unchanged:
every band's whole allowed range of difficulty is under two percentage points of per-car
reliability.** Every difficulty statement this project makes is a claim about one or two percentage
points of per-car error, and no lever moves a band without moving that number.

**How much room the ladder has, compared with what it had.** The span from band 2's floor to
band 5's cap is the room a monotone `p` ladder has to live in:

| ladder | span of bands 2–5 | why |
|---|---|---|
| slice-0 / round-5 quotas (26 / 36 / 48 / 64) | **1.23 pp** | quota rose faster than the target fell, so the caps fell at every step while `p` had to rise |
| round-6 quotas (33 / 41 / 47 / 51) | **2.78 pp** | lever 0 flattened the quota ladder, so floors and caps stepped *with* the ladder |
| **round 8, the clock (`N` = 44 / 47 / 50 / 52)** | **3.21 pp** | `N` rises only 18 % across four bands while the target falls 42 %, so the windows rise faster than `N` narrows them |

**The clock's windows are wider than either quota ladder's, and the reason is worth stating
because it is not obvious.** One would expect a fixed clock to *narrow* the windows, because the
natural way to make a band harder is to cut `interval`, which raises `N`, which lowers `p*`. It
does — but the clear-rate target falls faster. Across bands 2 to 5 the target's midpoint falls from 91.5 % to
66.5 % (a factor of 0.73 in the survival probability) while `N` rises only 44 → 52 (a factor of
1.18). The target is the faster-moving term, so the windows rise. **A ladder that made bands harder
by raising `N` alone — say by cutting `interval` in half — would invert this**, and that is the
failure mode to watch for: the interval column in §6.1 spans 204 → 128, a factor of 1.6, and
roughly a factor of 2.5 is where the windows would start running downhill again.

**Wider is not the same as slacker, and the paragraph after next is where that is measured.** A
wider span means the ladder has more places it can legally sit; it does not mean any one of them
has more room around it.

**The best monotone ladder the windows admit**, searched at 0.02 pp resolution over §7.2.2's five
windows with R2 (≥ 4 pp) and R3 (≤ 15 pp) enforced, maximising the smallest margin in clear-rate
percentage points:

```
p     = 0.00 / 2.14 / 2.80 / 3.38 / 3.92 %      clear = 100.0 / 93.2 / 85.6 / 76.1 / 66.6 %
drops = 6.8 / 7.6 / 9.4 / 9.5 pp                smallest margin anywhere = 2.79 pp
```

The same search run against the two quota ladders this design has had, on the same objective so the
three are comparable:

| ladder | `N` or `quota` bands 2–5 | span of the bands 2–5 windows | best smallest margin |
|---|---|---|---|
| slice-0 / round-5 quotas | 26 / 36 / 48 / 64 | **1.23 pp** | **0.34 pp** |
| round-6 quotas | 33 / 41 / 47 / 51 | **2.78 pp** | **2.76 pp** |
| **round 8, the clock** | `N` = 44 / 47 / 50 / 52 | **3.21 pp** | **2.79 pp** |
| the same search with `p` ignored entirely | — | — | 5.00 pp |

Three things follow, and the second is not what one would hope for:

- **The old quota ladder was not measurable and the two since are.** 0.34 pp is far inside one
  standard error: the binomial standard error on a 1,000-seed clear rate at `p ≈ 0.8` is 1.3 pp and
  on the *difference* of two rates about 1.8 pp, so under the old quotas a run that passed and a
  run that failed would have been the same design. Round 6 fixed that, and the clock keeps it fixed.
- **The clock is wider but it is not easier to hit.** Its span is 16 % wider than round 6's and its
  best achievable margin is **2.79 pp against 2.76** — a difference of 0.03 pp, which is nothing.
  The extra span goes into *where* the ladder can sit, not into how much slack it has once it sits
  there. **Anyone expecting the fixed clock to have loosened the tuning problem should read this
  row and stop expecting it.**
- **The `p` windows are still the binding half.** Ignoring `p` entirely and solving only against
  the five clear-rate windows and R2/R3 gives 5.00 pp, so requiring a monotone per-car error rate
  costs **2.21 pp of the 5.00 available** — nearly half. That is the same shape of finding round 6
  reported and the clock did not change it: §7.2.2's targets and the physics of
  `P(Bin(N, p) <= 2)` each take about half the room, and a retune has to move both.

**One limitation, stated because the rest of this subsection leans on the model.** The binomial
treats a level's `N` cars as independent trials, and they are not: level difficulty varies, so
failures cluster and the measured clear rate sits *below* the model's for the same `p`. Round 6
measured that gap at `0.1 / 3.5 / 2.4 / 4.7 / 3.3` pp. The windows are therefore the right object
for reasoning about **shape** — which direction a ladder's room runs, and how much of it there is —
and the wrong object for predicting a clear rate. **Every clear rate quoted anywhere in these
documents is measured, never inverted from this table.**

Three things follow, and they are not negotiable by tuning:

1. **Any structural bit that moves `p` by more than about a point is a switch, not a dial.** The
   dynamic range of bands 2–5 is 3.21 pp and any one band's own range is under 1.7 pp. Round 5's
   worked example is the one to remember: before D3, a car's *first* junction decision ran
   `1.23 / 3.71 / 6.42 / 8.35 / 11.80` pp worse than a later one, which at bands 2–5 was **1.2 to
   3.7 times the width of that whole range**, on the one decision every car in the level has to
   make. The clear rate duly went to the rails — band 4 cleared 0.4 % of levels that branched at
   row 0 and 95.7 % of the rest. The 96-point swing was the amplifier working correctly on an
   8-point input.
2. **No difficulty lever can repair a defect of that size, and measuring it proves it.** Round 5
   swept the full range of lever 0 across band 5 under the unrepaired bot and the split stayed
   between 22 and 97 pp throughout. That is the demonstration that the row-0 problem was never a
   difficulty parameter — and, in round 8, the reason V14 removes it rather than tuning around it.
3. **The number to state a target against, and to regress against, is `p`, not the clear rate.**
   `p` is unamplified, it is measurable per decision rather than per level, and a 1 pp change in it
   is legible where the same change shows up as anything between 0 and 60 points of clear rate
   depending on where the band happens to sit. [AC-246](acceptance-criteria.md) is written in `p`
   for exactly this reason, and it is the only guard in the design that can fail *early*.

**And one thing that is new.** `p` is now the primary statement in a stronger sense than it was:
under the quota model, `quota` and `interval` could be moved against each other so that `p` and the
clear rate could be steered semi-independently. They cannot now. **`p` and `N` are both functions
of `interval`, so `p` is the only free difficulty quantity the design has** — the topology moves it
too, but `interval` is the lever §7.4 reaches for first and it moves nothing else. A regression
stated in the clear rate under this model is a regression stated in a quantity with two causes; one
stated in `p` has one.

### 7.2 Target 1 — the clear rate

Over 1,000 seeds per band, with the bot of §7.1. **A level is cleared by surviving its two minutes**
— `phase === 'ended'` — and lost by spending three lives
([`gameplay.md` §4.2](gameplay.md#42-the-clock-and-what-ends-a-level)). The clear rate is therefore
the share of runs that reach the bell.

**These targets are a shape the design requires, not a reading taken off a bot.** A target retuned
to whatever the instrument measures is not a target. What follows is derived from what the ladder
is *for*; if the bot misses it, §7.4 applies and that is a real finding about the game, which is
the entire point of having an instrument.

#### 7.2.1 The four requirements

**R1 — Band 1 is not allowed to fail a competent player.** Band 1 is four levels long and it is
where the player learns what a junction does. A competent player who loses level 1 before
understanding the rule does not conclude that they should try harder; they conclude the game is
not for them. **Band 1 clear rate ≥ 95 %**, with no upper bound — 100 % at band 1 is the intended
outcome, not a sign the band is too easy.

**R2 — Every band must be harder than the one below it, measurably.** A band boundary exists to
escalate; if band 3 is not harder than band 2 for the same player model, the boundary is
decoration. **Each band's clear rate must be at least 4 percentage points below the band above
it.** Four points is about three standard errors at 1,000 seeds.

**R3 — No band boundary may be a wall.**
[`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order) adds about one axis per step.
One axis should not cost a quarter of the player's runs. **No adjacent pair of bands may differ by
more than 15 percentage points.**

**R4 — Band 5 must have a ceiling, and must stay a reasonable bet.** Band 5 is levels 23 and up;
it is where the player lives. Two bounds, from opposite directions:

- *Upper.* At 80 % a competent player clears four levels in five and the ladder has no top. A
  visible failure rate of at least one run in five is what makes band 5 read as the ceiling
  rather than as band 4 with a bigger number. **≤ 80 %.**
- *Lower.* **≥ 50 %.** *This bound was re-derived for the clock and it came out in the same place,
  with more room than it had.* Under a quota, expected attempts to clear was `1/S` and every
  attempt cost a full ~110 s level, so 50 % meant 3.7 minutes per level cleared and 33 % meant
  5.5 minutes, which is where a retry stops feeling like a rematch. Under a clock a **failed run is
  shorter than a cleared one** — it ends on the third misroute, typically around 60–70 s — so at
  `S = 0.50` the expected time per clear is about `1.0 × 65 s + 120 s ≈ 3.1 minutes`, and even at
  `S = 0.40` it is 3.5 minutes. The floor could defensibly move to 40 %. It stays at 50 % because
  nothing in the design needs the extra room and a floor that moves without a reason is not a
  floor.

#### 7.2.2 The table

The design band for each level band, chosen inside R1–R4 with room on both sides:

| Band | Clear-rate band | Which requirement pins it |
|---|---|---|
| 1 | **≥ 95 %** | R1 |
| 2 | **86 – 97 %** | R2 against band 1, R3 |
| 3 | **76 – 92 %** | R2, R3 |
| 4 | **66 – 85 %** | R2, R3 |
| 5 | **55 – 78 %** | R4 both ends, inset from 50/80 for headroom |

**These five windows have not moved since they were derived from R1–R4, and round 8 did not move
them either.** That is worth saying explicitly, because everything around them moved: R1–R4 are
statements about what a difficulty ladder is for, and the change from a quota to a clock does not
touch any of them. What changed is the `p` each window corresponds to (§7.1.10) and the parameters
that are expected to land there (§6.1).

R2 and R3 are **separately measurable** and are ACs in their own right
([AC-237](acceptance-criteria.md), [AC-238](acceptance-criteria.md)): a run that lands every band
inside its window but with band 2 only 2 pp below band 1 has failed, because the ladder is not
escalating even though every individual number looks fine.

An **unconstrained** bot must deliver **every car that arrives, at every band, with zero
misroutes**, and its delivered count must equal §6.1's `N`. That follows from V1/V5/V6 plus the
1.60 s minimum flip window, so a failure there is a generator defect, not a tuning question.
([AC-220](acceptance-criteria.md))

#### 7.2.3 What the numbers were, and why they are not reused

Round 6's reading was `99.9 / 91.5 / 81.5 / 74.1 / 66.0 %` with per-car `p` of
`0.92 / 2.53 / 3.38 / 3.38 / 3.80 %`, every band in window, R2 and R3 passing at all four pairs,
and a smallest margin of 3.4 pp. It was a good reading and **none of it transfers.** It was taken
against a quota ladder that no longer exists, a geometry whose every dimension has changed, a
network model whose pass nodes could drift sideways, and a first-decision window the owner has
since rejected.

What does transfer is the *definition* of `p` — misroutes over arrivals, summed across all runs in
a band, not averaged per level ([AC-246](acceptance-criteria.md)) — and the finding that `p` is
what a regression should be stated in.

#### 7.2.4 What the instrument must read, and what the designer could compute

**This table is the developer's sweep to fill in.** The `p` window column is computed (§7.1.10)
and is not negotiable; the `p` prior is a crude fit and is not evidence.

| Band | clear rate | §7.2.2 band | per-car `p` | §7.1.10 window | AC-246 gap | AC-246 ceiling `0.25 × 2/N` | delivered |
|---|---|---|---|---|---|---|---|
| 1 | *(to be measured)* | ≥ 95 % | *(to be measured)* | 0.00 – 2.60 % | *(to be measured)* | **1.56 pp** | *(to be measured)* |
| 2 | *(to be measured)* | 86 – 97 % | *(to be measured)* | 1.53 – 2.95 % | *(to be measured)* | **1.14 pp** | *(to be measured)* |
| 3 | *(to be measured)* | 76 – 92 % | *(to be measured)* | 2.15 – 3.61 % | *(to be measured)* | **1.06 pp** | *(to be measured)* |
| 4 | *(to be measured)* | 66 – 85 % | *(to be measured)* | 2.68 – 4.12 % | *(to be measured)* | **1.00 pp** | *(to be measured)* |
| 5 | *(to be measured)* | 55 – 78 % | *(to be measured)* | 3.11 – 4.74 % | *(to be measured)* | **0.96 pp** | *(to be measured)* |

**A prior, and it is labelled a prior because it is one.** Fitting `q = a · inFlight^α · dpc^β` to
the seven `(cars in flight, decisions per car, per-decision error)` readings round 6 and round 7
produced — five band points plus two stops of the band-5 lever-0 sweep — gives
`α = 2.31`, `β = 1.26` and residuals of up to 40 % on two of the seven points. Applied to §6.1 it
predicts

```
p      ~  1.01 / 2.29 / 3.17 / 3.75 / 4.48 %
clear  ~  99.6 / 92.0 / 81.4 / 71.1 / 58.6 %       drops  7.5 / 10.7 / 10.2 / 12.5 pp
```

— every band inside its window, R2 and R3 satisfied, `p` monotone, band 5 the tightest at 0.26 pp
below its cap. **That is why this band table was chosen and it is not why it should be believed.**
The fit is to a different geometry's bot, the exponent on traffic is steep enough that a 10 % error
in `cars in flight` is a 25 % error in `q`, and §7.1.10's own limitation paragraph says the
binomial sits above the measurement. Treat it as evidence that the table is *plausible* and as
nothing else. **If the sweep disagrees, the sweep is right** and §7.4 is the procedure.

**What to read first if it disagrees**, in order:

1. **`--attention-report`'s focus split.** §7.1.9 predicts demand fell and re-focus rose; if the
   cold/re-focus split has moved a lot from round 6's `1.26–2.44` re-focuses against `0.54–1.01`
   cold per second, the longer journeys (§6.1) are doing more than expected.
2. **Memory expiries per second.** §7.1.3 records that `BOT_MEMORY_TICKS / interval` fell below 1
   at every band for the first time. If expiries are up sharply, that is why.
3. **`p` before the clear rate.** §7.1.10.3. A band that is 20 points out of window may be 0.6 pp
   out in `p`.

### 7.3 Target 2 — the delivery band

The completion-time target is **deleted**. Every level is 7,200 ticks
([`gameplay.md` §5.3](gameplay.md#53-session-length)), so the median, the p95 and the 130 s
absolute ceiling are all the same number by construction and five acceptance criteria measured it.

What replaces it is the quantity that *does* vary and that the player reads as their result: the
number of cars delivered.

| Band | `N`, arrivals available | a clean run delivers | modelled mean delivered | measured median | measured p10 |
|---|---|---|---|---|---|
| 1 | 32 | 32 | ≈ 31.6 | *(to be measured)* | *(to be measured)* |
| 2 | 44 | 44 | ≈ 42.1 | *(to be measured)* | *(to be measured)* |
| 3 | 47 | 47 | ≈ 43.0 | *(to be measured)* | *(to be measured)* |
| 4 | 50 | 50 | ≈ 43.8 | *(to be measured)* | *(to be measured)* |
| 5 | 52 | 52 | ≈ 42.7 | *(to be measured)* | *(to be measured)* |

The modelled column is the exact expectation of the three-lives process over `N` independent trials
at the §7.2.4 prior's `p`, and it inherits that prior's unreliability.

**This is a report, not a bound, and the difference matters.** The completion-time band was a
*constraint*: a lever pull that fixed the clear rate and broke the duration had not fixed anything,
and slice 1's worked example was exactly that. There is no second constraint now.
**§7.4's lever order is correspondingly more dangerous**, because the thing that used to stop a
pull going too far is gone, and the two guards that remain — [AC-246](acceptance-criteria.md) and
the `p` windows — are both narrow.

Two properties the delivery band is expected to have, and which are worth checking because a
violation would say something about the design rather than about tuning:

- **`delivered` should be flat from band 3 upward** (§7.2.4's prior says 43.0 / 43.8 / 42.7). A
  harder band spawns slightly more cars and loses slightly more of them. **The score is a
  within-band signal, not a between-band one**, and a player should not read a band-5 score as
  bigger than a band-3 one.
- **`delivered` should be strongly bimodal**, because a run either reaches the bell or stops at its
  third misroute. The p10 column is there to make that visible: it is roughly where the failed runs
  land, and if it is close to the median the lives are not doing their job.

### 7.4 When a target is missed

The lever order is normative, so the fix is not reinvented under time pressure.

**Two targets bind, and `interval` moves both of them.** [AC-246](acceptance-criteria.md) — the
per-car failure rate at a car's **first** decision may not exceed the rate at its other decisions
by more than a quarter of the band's per-car life budget, `0.25 × 2/N` = `1.56 / 1.14 / 1.06 /
1.00 / 0.96` pp by band — binds on every lever pull, because every lever below moves `N` and
therefore moves the threshold, and because §7.1.10 shows it is the one quantity that is not
amplified: a 1 pp drift in it is invisible in the clear rate until it is a 40-point cliff. A lever
pull that satisfies §7.2 while widening that gap has bought a number and sold the game.

> **Lever 0 — the iso-duration lever — no longer exists.** Under a quota, duration was
> `≈ SPAWN_LEAD/60 + (quota - 1)·interval/60 + transit`, so the product `(quota - 1)·interval` set
> the duration while `interval` alone set the difficulty, and the two could be moved against each
> other. Under a clock there is no `quota`, the duration is a constant, and the car count is a
> *consequence* of `interval` rather than a companion to it. **The lever that fixed this design's
> difficulty curve in round 6 has been deleted by the owner's first change**, and §6.1's `N` column
> is what took its place. Whoever next reaches for lever 0 out of habit should read §7.1.10's
> comparison table instead.

**The duration constraint is gone too, and that is a loss as well as a simplification.** §7.3's
delivery band is a report, not a bound. The check that used to stop a lever being pulled too far —
"a change that fixes §7.2 and breaks §7.3 has not fixed anything" — has no analogue. What is left
is [AC-246](acceptance-criteria.md) and §7.1.10's windows, and both are narrow.

**Lever 1 — `interval`. Pull this first.** It moves the per-car error rate and the number of cars
in the same direction (§7.1.10), so it has about twice the leverage it had under a quota:

```
interval' = interval + Δ                       // Δ > 0 makes the band easier, Δ < 0 harder
```

Constraints on it, all of which must be re-checked after a pull because all of them are functions
of `interval`:

- `interval - 2·jitter >= 60` ticks, or the minimum flip window drops below 1.00 s and
  [`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time) stops being true.
  §6.1's band 5 sits at 96 ticks, so there is room.
- `N` is recomputed, and with it **[AC-246](acceptance-criteria.md)'s ceiling** (`0.25 × 2/N`) and
  §7.1.10's window for that band. Both move. A pull that raises `interval` lowers `N`, which
  *loosens* AC-246 and *raises* the window; a pull that lowers `interval` tightens both. **The
  goalposts move with the ball and in the same direction, so the apparent effect on the clear rate
  overstates the effect on `p`.** Always read `p` against its recomputed window, never the clear
  rate against its old one.
- The spawn schedule is recomputed, which is now free
  ([`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed) —
  there is no slack to erode), and `jitter` is re-checked against the new `interval` so the beat
  does not become a metronome over 120 s.
- R2 and R3 are re-checked against the **adjacent** bands, which a single-band pull will move
  relative to.

**Lever 2 — topology, when lever 1 is exhausted or when it would break a neighbour.** `R`, `C` and
`pBranch` move `p` **without moving `N`**, which is the only way left to change a band's difficulty
without changing its window. That makes them the precision instrument in this model, where under a
quota they were the blunt one.

- *Clear rate too low:* reduce `pBranch` (fewer junctions, so fewer decisions per car), then reduce
  `R`. Do **not** reduce `speedMluPerTick` — a slower car shortens nothing and a faster spawn rate
  is what makes it hard; reducing speed shortens the planning horizon relative to the spawn rate
  and pushes the game toward reaction. It also lengthens `transit`, which lowers `N`, which is a
  third effect nobody intended.
- *Clear rate too high:* raise `pBranch`, then add a colour (`K`) if the band's `C` allows it, then
  add a row. *`pBranch` is weak: §6.1 shows that actionable junctions track `K` rather than drawn
  `J`, so raising `pBranch` buys scenery and tap targets more reliably than it buys decisions. If
  it is pulled, [AC-242](acceptance-criteria.md) and [AC-243](acceptance-criteria.md) are
  re-measured with it.*
- *R2 violated (a band is not harder than the one below it):* the fix is never a clear-rate lever
  on the offending band alone. Two adjacent bands that measure the same are one band; the
  correction is to [`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order)'s
  escalation — move an axis from the step above down into the step that is not escalating.

**Every topology pull re-measures the geometry.** `R` changes `rowH`, which changes
`firstDecisionTicks` ([AC-245](acceptance-criteria.md)'s 90-tick floor), `mouthLu`
([AC-514](acceptance-criteria.md)) and the tap-target floor ([AC-401](acceptance-criteria.md)); `C`
changes `colW`, which changes all three again and `transit` with them. Under the old geometry these
were independent of the difficulty levers. **They are not any more**, because `ROUTE_H` is fixed and
`rowH = ROUTE_H / R`, so `R` is simultaneously a difficulty knob and a geometry knob. `ROUTE_H`
must stay divisible by every `R` the table uses, or [AC-218](acceptance-criteria.md) throws.

**What is not a lever.** `BOT_WORKING_SET`, `BOT_MEMORY_TICKS` and every other constant in §7.1
are properties of the instrument, not of the game. Changing one to make a target pass is
adjusting the gauge to match the reading, and it is forbidden. They change only if the *model of
a human player* is shown to be wrong, and then every target is re-read, not just the failing one.

§7.1.5's D3 is the worked example of that exception and of its price. The round-robin claimed that
a person checks a newly appeared object last; that claim is wrong about people, so the rule
changed — and **every** target was re-read against the new gauge. Two tests distinguish that from
tuning the gauge, and a future proposal should be made to answer both. Did the change buy the bot
anything it did not already have for free? Is the effect specific — did the quantity the change was
argued to fix move, while the quantities it was not argued to fix did not? A change that improves
every number a little is a change to the gauge.

**And one thing that is not a lever any more either: `LIVES`.** Three lives is what makes the clear
rate `P(Bin(N, p) <= 2)`; changing it to 4 would move every window in §7.1.10 at once and every
AC-246 ceiling with them. It is a rule of the game
([`gameplay.md` §4.1](gameplay.md#41-lives)), not a tuning parameter, and it is listed here because
under a clock it is the most tempting-looking knob in the design.

### 7.4.1 The lever order under a clock, and what round 6 proved that still holds

Round 6 pulled lever 0 at four of five bands and, on the way, proved three things by measurement.
Lever 0 is gone; two of the three findings are not.

**Still true: `K` is barely a difficulty axis on its own.** At a common interval, per-car `p` across
bands 2–5 read `— / 1.25 / 1.53 / 2.29 / 3.80 %` — the 2 → 3 step, whose entire content in
[`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order) was the fourth colour, was
worth 0.28 pp against 0.76 pp for a column and a row. The reason is mechanical: the bot pays per
**car held**, not per colour in the world, so a new colour costs attention only through the deeper
networks and the extra decisions it makes possible. §6.1 records that the `J` axis is largely the
`K` axis in disguise; this says the `K` axis is largely the **depth** axis in disguise, and that the
two real axes in this game are *cars per second* and *decisions per car*. **Round 8's band table is
built on exactly those two** — `interval` falls monotonically and mean depth rises monotonically —
and treats `K` and `J` as the proxies they are. This finding is the reason band 3 gains a **row**
alongside its fourth colour rather than the colour alone.

**Still true: a structural bit that moves `p` by a point is a switch, not a dial, and no lever
reaches it.** Round 5 swept lever 0 across band 5 under the unrepaired first-decision defect and
the pass/branch split stayed between 22 and 97 pp across a 63 % change in the parameters. That is
what justifies V14 being a *rule* rather than a tuning response
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision)).

**No longer true: `interval` cannot stay monotone across the ladder.** Round 6 proved it under the
quota model, from two measurements — band 5 needed `interval >= 116` to clear 55 %, band 4 needed
`interval <= 115` to stay under 85 %, so `interval(band 4) < interval(band 5)` necessarily, and the
same argument one step down gave `interval(band 3) < interval(band 4)`. **The proof is sound and its
premise is gone.** Both measurements were of a clear rate at a *fixed* `quota`; under a clock,
raising `interval` at band 5 lowers `N` as well as `p`, so band 5 reaches its floor at a much
smaller pull, and band 4's ceiling constraint moves the same way. §6.1's monotone column is the
consequence.

**The finding that replaces it, and the one to carry forward:** under a fixed clock, `interval` is
a double-acting lever and the ladder's traffic axis can be monotone again — but the band's own
target window moves with every pull, so **a lever pull must recompute §7.1.10's window for the band
it moved and read `p` against the new window**, not the clear rate against the old one. That is the
single most likely way to get this model wrong, and it is the failure mode the quota model did not
have.

---

## 8. Harnesses this design assumes exist

| Tool | What it must assert |
|---|---|
| `tools/generator-audit.mjs --seeds 5000` | V1–V15 hold for every band × seed; zero `GEN_EXHAUSTED`; report attempt-count percentiles, per-rule rejection counts (§5.2), distinct edge topologies **and** distinct signatures per band. Also, per band, the **minimum `firstDecisionTicks`** over every path of every level against [AC-245](acceptance-criteria.md)'s floor of 90. |
| `tools/generator-audit.mjs --rule-injection` | For each of V1–V11 and V13–V15, a fixture that violates that rule, with the rule's check invoked **directly** rather than through `validate()`'s cascade ([AC-244](acceptance-criteria.md)). Eleven of the fourteen are unreachable through `generate()` (§5.2) and this is the only place their checks are ever executed against a violation. **V14 and V15 are new and are in that class.** |
| `tools/generator-audit.mjs --geometry` | Per band: every edge's `lengthMlu` equals `(|Δx| + |Δy|) · MLU` ([AC-207](acceptance-criteria.md)); no two horizontal runs in a row band are collinear and touching unless they share a source or a depot (§2.5); no horizontal run terminates on an occupied lattice site (Lemma 1). The fault to inject is a generator with rule (P) removed, which must fail all three. |
| `tools/generator-audit.mjs --actionable --seeds 3000` | Per band: mean and minimum live-junction count under §6.2's lazy-optimal oracle, the share of levels below `Ja`, and the mean count of junctions flipped twice or more ([AC-243](acceptance-criteria.md)). |
| `tools/bot.mjs --seeds 1000` | Unconstrained bot delivers `N` cars with zero misroutes; constrained clear rate within §7.2's table **and** satisfying R2 and R3's shape rules; measured taps/s and delivered per band. |
| `tools/bot.mjs --entry-window` | Per band: the per-car failure rate at each car's first decision against the rate at its other decisions, against [AC-246](acceptance-criteria.md)'s per-band ceiling. The fault to inject is a round-robin with no onset capture (round 3's shipped sweep), which must fail it at bands **2, 3, 4 and 5** and **pass** at band 1 — band 1's `N = 32` gives it a 6.25 % per-car budget and a 1.2 pp gap does not reach it. *The row-0 split that this sweep used to report per arm is gone: V14 means no level has a row-0 branch, so there is only one arm.* |
| `tools/bot.mjs --attention-report` | Per band, per 1,000 seeds: mean glances/s, mean focus events/s, the split between `BOT_SWITCH_TICKS` and `BOT_ACQUIRE_TICKS` focuses, mean working-set occupancy, evictions/s, memory expiries/s, onset captures/s and captures as a share of glances (§7.1.5 D3), and the count of misroutes caused by a flip the bot made for a car it was holding onto a car it was not. These are the numbers that say *why* a band lands where it does, and without them a missed target is unexplainable. |
| `tools/spawn-schedule.mjs --seeds 2000` | Per band: `spawns.length` equals the closed form of [`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed); every scheduled tick is `< LEVEL_TICKS`; ticks strictly increase; and in a run that reaches the bell, `nextSpawn === spawns.length` ([AC-139](acceptance-criteria.md)). *This replaces `tools/spawn-margin.mjs`, which measured a margin that no longer exists.* |
| `tools/converge.mjs --seeds 1000` | Per band: the rate at which two cars on converging terminal edges are within `CAR_L` of each other, and the share of those in which **both** centres are outside the depot terrace ([AC-513](acceptance-criteria.md)). Reports a number and a worst-case screenshot; the designer's prototype measured 59–301 per 1,000 runs before the terrace. |
| `tools/layout-sweep.mjs` | The viewport sweep of [AC-401](acceptance-criteria.md) and [AC-402](acceptance-criteria.md). |
| `tools/replay.mjs --seed N` | A recorded run replays to a deeply equal final state, twice in a row and across machines. |

Per `development-process.md:136`: before any of these is trusted to pass, the fault it is meant
to catch is injected and the harness is confirmed to fail.

`tools/pacing.mjs` is **deleted**. It measured completion time, which is now a constant.
