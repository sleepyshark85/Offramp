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
  interval, jitter,                  // speed is CAR_SPEED, a constant (§6.1)
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

**Lemma 1 — a jog's target column is empty in the source row.** *This holds on a **route row** and
is **false on the terminal row**; round 8 stated it without that qualification and
[AC-206](acceptance-criteria.md) inherited the error. What replaces it on the terminal row is
Lemma 1T.*

Suppose edge `(a→a+1)` exists and the target row is a route row. V2 sets `minTarget = a+2` for every
later source, so a node at column `a+1` in row `r` would have to emit targets `≥ a+2`; with
`|Δc| ≤ 1` its only candidate is `{a+2}`, a *pass* that changes column, which (P) forbids, and it
cannot form a branch from a single candidate. So no node sits at `(r, a+1)`. The mirror argument
covers `(a→a-1)`. ∎

**Lemma 1T — on the terminal row a jog's target column may be occupied, and what occupies it is a
depot.** Across the terminal row V2 is only **non-decreasing**, so a later source may target `a+1`
as well and both edges then feed the depot at column `a+1`. Lemma 1's proof does not reach this case
and cannot be repaired to, because its whole content is V2's *strictly* increasing rule. Nor is the
case rare: **measured over the round-9 table, terminal-row landings occur in 98.7–100 % of levels at
every band, and route-row landings in none.**

It is safe for a different reason from Lemma 1's. A depot is a **terminus**: it emits no edge. The
horizontal run that lands on it ends at a building rather than continuing into a road, and §2.5's
failure mode — a false continuation — needs an outgoing edge to exist. ∎

**The statement that is true at every row is therefore not "the site is empty" but this, and it is
the one to assert:**

> **Where a horizontal run terminates on an occupied lattice site, that site is either a depot, or a
> branch node carrying a junction marker.**

On a route row it holds vacuously by Lemma 1 — the site is empty. On the terminal row the site is a
depot, by Lemma 1T. And where two horizontal runs meet at a site that *does* emit an edge, rule (P)
and V2 force that site to emit it **down its own column**, so the meeting point is a T with a marker
drawn on it and never a fork without one. *That is what [AC-206](acceptance-criteria.md) clauses (c)
and (d) assert in round 9. Round 8's wording of (d) — "no horizontal run terminates on an occupied
lattice site" — **cannot pass**, because on the terminal row they almost always do.*

*Lemma 1 is what lets a route row's horizontal run sit at `y_r`: it can never terminate on another
node's centre. Lemma 1T is what lets the terminal row's, for a different reason.*

**Lemma 2 — two horizontal runs never overlap, and touch only when they share a source.** Take
jogs from sources `a ≤ a'`.
- `a = a'`: one branch, two jogs, `H(a→a-1) = [x_{a-1}, x_a]` and `H(a→a+1) = [x_a, x_{a+1}]`.
  They meet at `x_a`, which is the node itself. This is the T, and it is the intended drawing.
- `a < a'`, `e` a right jog: **on a route row**, by V2 later sources target `≥ a+2`, and by Lemma 1
  `a+1 ∉ rows[r]`, so `a' ≥ a+2`. The only span that can reach `[x_a, x_{a+1}]` is a left jog from
  `a+2`, spanning `[x_{a+1}, x_{a+2}]` — which targets `a+1`, the same target as `e`, a duplicate
  target forbidden by V2. **On the terminal row the duplicate is permitted (Lemma 1T)**, and then
  both runs feed the **same depot**, which is one place and draws as one forecourt (§2.3,
  [`ui.md` §7.6](ui.md#76-the-depot-terrace)). *That overlap is the only one in the design Lemma 2
  does not forbid; it is the shared approach road of
  [`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road), and it
  is the reason §2.5's claim is about legibility rather than about disjointness.*
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
              x=104      x=368      x=632      x=896
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

colW  = per band (§6.1), derived by the rule in §3.2.1
rowH  = ROUTE_H / R
x(c)  = 500 + (c - (C-1)/2) * colW
y(r)  = ROW0_Y + r * rowH
```

`DEPOT_Y + DEPOT_H = 1350 + 128 = 1478` against `DESIGN_H = 1500`, so 22 LU of margin sits below
the depot bodies ([`ui.md` §3.3](ui.md#33-measured-fit-across-real-devices),
[AC-411](acceptance-criteria.md)).

All of these are exact integers for every `(C, R)` the bands use:

| `C` | `colW` | was | column x positions | outermost depot edge to the rectangle | `min(colW, rowH)` |
|---|---|---|---|---|---|
| 3 | **300** | 260 | 200, 500, 800 | 138 LU | 216 |
| 4 | **264** | 230 | 104, 368, 632, 896 | 42 LU | 216 / 180 |
| 5 | **198** | 180 | 104, 302, 500, 698, 896 | 42 LU | 180 |
| 6 | **158** | 150 | 105, 263, 421, 579, 737, 895 | 43 LU | **158** |

#### 3.2.1 `colW` is derived, not chosen

```
colW(C) = the largest EVEN value satisfying both
            (C - 1) * colW  <=  DESIGN_W - DEPOT_W - 2 * (ROAD_W / 2)   = 792
            colW            <=  300
```

The first bound says **the outermost depot keeps at least half a road width — 42 LU — of clearance
to the design-space edge.** The second caps a horizontal run at 30 % of the design width, above
which a jog stops reading as a jog and starts reading as a corridor. `C = 3` is the only `C` the cap
binds at; every other band takes the clearance bound exactly.

**Round 8 chose `colW` by hand and chose it too small at every `C`**, which cost the design twice.
It cost difficulty — `jogs * colW` is the only band-varying term in `transit` (§6.1.1) — and it cost
the tap target, because `min(colW, rowH)` is what
[`ui.md` §4.4](ui.md#44-tap-target-arithmetic)'s 44 pt floor is computed from. At `C = 6` the old
150 LU gave **44.16 pt** against a 44 pt floor, which that section itself calls tight; 158 LU gives
`HIT_R_LU = min(max(ceil(22/0.30667), 76), floor((158-6)/2)) = 76` and **46.61 pt**, and the hit
circles still cannot touch, because `2 * 76 = 152 = 158 - 6` exactly. *This arithmetic is the
designer's; [AC-401](acceptance-criteria.md) and [AC-402](acceptance-criteria.md) are re-measured by
`tools/layout-sweep.mjs` and that sweep is the number that counts.*

**`C = 7` is impossible at `DESIGN_W = 1000`, and this is where that is recorded so the next round
does not re-derive it.** 44 pt at the support floor needs `min(colW, rowH) >= 2*ceil(22/0.30667) + 6
= 150` LU; at `C = 7` that puts the outermost depot's edge 12 LU **outside** the rectangle. The
widest `colW` that fits inside it is 146, which gives a 42.93 pt target. Six columns is the cap,
band 5 uses all six, and a seventh costs `DESIGN_W >= 1024` and a rescale of every width-bound
device.

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
158 LU by band.** That is the number the 44 pt tap-target arithmetic in
[`ui.md` §4.4](ui.md#44-tap-target-arithmetic) is built on, and at band 5 it is still the binding
constraint on the whole design — but §3.2.1's derived `colW` moves band 5 from 150 LU to 158, which
takes the junction target at the support floor from **44.16 pt to 46.61 pt**. `C` is still capped
at 6, and §3.2.1 records why in a form the next round does not have to re-derive.

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

| shape | length in LU | band 1 | band 2 | band 3 | band 4 | band 5 |
|---|---|---|---|---|---|---|
| `entry` | `ENTRY_LEN` | 220 | 220 | 220 | 220 | 220 |
| `straight` | `rowH` | 216 | 216 | 180 | 180 | 180 |
| `jogL` / `jogR` | `rowH + colW` | 516 | 480 | 444 | 378 | 338 |

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

| Band | Levels | `C` | **`K`** | `R` | `pBranch` | `J` | `Ja` | `D` | `colW` | `rowH` | `interval` | `jitter` | **cars in flight** | **`N`** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | 3 | **3** | 5 | 0.85 | 3–4 | 3 | 2–3 | 300 | 216 | **208** | ±21 | **2.73** | **32** |
| 2 | 5–9 | 4 | **4** | 5 | 0.80 | 3–5 | 3 | 2–3 | 264 | 216 | **147** | ±15 | **3.96** | **45** |
| 3 | 10–15 | 4 | **4** | 6 | 0.85 | 4–6 | 4 | 2–4 | 264 | 180 | **140** | ±14 | **4.26** | **47** |
| 4 | 16–22 | 5 | **5** | 6 | 0.85 | 5–7 | 5 | 2–4 | 198 | 180 | **131** | ±13 | **4.38** | **50** |
| 5 | 23+ | 6 | **6** | 6 | 0.90 | 7–9 | 7 | 2–5 | 158 | 180 | **128** | ±13 | **4.40** | **51** |

**`speedMluPerTick` has left the band table.** It is now a single constant,
`CAR_SPEED = 2750` MLU/tick = **165 LU/s**, at every band, on the owner's instruction —
*"the vehicle should keep their constant speed regardless of level"* — and the measurement agrees
with him for a reason he did not have to give. Round 8 raised it 2750 → 3350 across the ladder;
§6.1.1 and §7.4.1 show that this is the defect that flattened the ladder, because speed is not a
difficulty axis at all. It is the *transit* axis, and raising it up the ladder emptied the board
faster than `interval` filled it.

**`LIVES` stays at 3 at every band, and §6.1.5 is why** — it was measured as a lever this round and
it is too strong to be one.

**`K = C` at every band now.** Round 8 ran `3 / 3 / 4 / 4 / 5`, so the first nine levels were
chromatically identical and the ceiling was five. `K` is capped by `C` — `K` depots need `K`
distinct columns — and `C` is capped at 6 by the 44 pt tap target (§3.2.1), so **`3 / 4 / 4 / 5 / 6`
is the most colour this design rectangle can carry**, and the one repeat is placed at the 2 → 3 step
where the sixth *row* is the escalation instead. The reference game's fourteen uniquely coloured
stations are not reachable on a phone at `DESIGN_W = 1000`; §3.2.1 has the arithmetic and it is a
measurement, not a preference.

**Three columns are new or re-purposed, and the first of them is the whole of this round.**
`cars in flight` was a derived quantity in a side table in round 8; it is now a band-table column,
because it is the quantity the ladder escalates and the quantity round 8 held constant without
noticing.

#### 6.1.1 Cars in flight is the ladder, and it has exactly two inputs

```
transit      = (ENTRY_LEN + ROUTE_H + jogs * colW) / speed          ticks
carsInFlight = transit / interval
             = (ENTRY_LEN + ROUTE_H + jogs * colW) / (interval * speed / 1000)
             ~ L / spacing,   spacing = interval * speed / 1000  (LU between consecutive cars)
```

**`R * rowH = ROUTE_H` is a constant of the geometry (§3.2), so the vertical part of every journey
is 1,080 LU at every band.** The horizontal part is `jogs * colW`, and the jog count rises almost
exactly as fast as `colW` falls with `C` (§6.2: 1.20 → 1.54 → 1.55 → 1.88 → 2.06 jogs against
300 → 264 → 264 → 198 → 158 LU), so `L` lands at **1660 / 1706 / 1709 / 1672 / 1625 LU** — a spread
of 5 % across the whole ladder. *Measured directly: at any fixed `(interval, speed)`, cars in flight
varies by under 6 % across all five bands and **falls** from band 2 to band 5.*

**So the board's occupancy is a function of one number — the spacing between cars in LU — and not of
the band at all.** Round 8's table read

```
spacing (round 8) = 561 / 435 / 427 / 422 / 429 LU      carsInFlight = 2.72 / 3.70 / 3.74 / 3.77 / 3.66
```

— flat from band 2 up, and **band 5 looser than band 4**. That is the flat ladder in one number, and
it is why `p` measured `0.33 / 0.73 / 2.25 / 2.25 / 2.17 %`. `interval` fell 37 % across the ladder
and `speed` rose 22 %; the two cancelled in the only quantity that matters.

Round 9:

```
spacing (round 9) = 572 / 404 / 385 / 360 / 352 LU      carsInFlight = 2.73 / 3.96 / 4.26 / 4.38 / 4.40
```

**Cars in flight is monotone for the first time in this design's history**, and it is the axis the
owner asked for — *"there should be more vehicles appears"*. The 1 → 2 step takes the board from
below `BOT_WORKING_SET` to above it; the rest is a 0.4-car climb, which sounds small and is not:
§6.1.2 shows the clear rate falling from 89 % to 4 % over a single car of occupancy at band 5.

**The 4 → 5 step is the one that has to fight the geometry, and it is worth knowing why.** The sixth
column costs 40 LU of `colW` (§3.2.1), which is 2.5 % of `L`, so band 5 starts that step with a
*shorter* journey than band 4 and the interval cut has to pay that back before it escalates
anything. It does — 4.38 → 4.40 — but only just. The escalation at that step is therefore mostly
topological, and it is real: **measured at matched cars in flight (≈ 4.48), band 4's per-car error
is 3.14 % and band 5's is 4.45 %.** Band 5 is harder than band 4 for the same board occupancy; it
simply cannot be given a much busier one inside six columns.

#### 6.1.2 The ceiling on cars in flight, which is not a choice

Pushing the board past about five cars leaves every clear-rate window at every band. Measured at
band 5:

| cars in flight | 3.89 | 4.11 | 4.36 | 4.60 | 4.78 |
|---|---|---|---|---|---|
| clear rate | 89.0 % | 72.5 % | 57.2 % | 29.0 % | 3.8 % |

**That ceiling is not `BOT_WORKING_SET`.** Raising the working set from 3 to 4 moves evictions from
0.51 /s to 0.015 /s and the band-5 clear rate at 4.36 cars from 57.2 % to 84.8 %; raising it from 4
to 5 moves the same reading from 84.8 % to 84.8 %. The wall past that is the **glance budget**:
`BOT_SCAN_TICKS = 6` allows at most 10 glances per second, measured glances run 5.8–7.3 /s, and at
4.4 cars on the board each car is already being looked at only about every 0.75 s.

**Whether a human's ceiling is five cars is a tier-5 question and it is the most important one this
design has open.** The owner's report of round 8 — *"it feels so different with train of thought, in
a worst way"* — is, mechanically, a report that the board is too empty, and the board is at 4.2–4.5
cars because that is what this instrument survives. `development-process.md` §6.9's rule applies
exactly: **a threshold derived from the instrument's own constants is not evidence about a human.**
§7.4 forbids changing a §7.1 constant to make a target pass, and it states the one exception — the
model of a player being shown to be wrong. **This design does not take that exception. It marks it,
and asks the owner.** The two readings that would settle it are in §7.4.2.

#### 6.1.3 What `N` is, and why band 1's was wrong

`N` is the number of cars that **arrive at a depot** inside the two-minute clock. It is not a
parameter; it is a consequence of `interval`.

```
arrival_i = SPAWN_LEAD + i * interval + jitter_i + transit_i
N         = #{ i >= 0 : arrival_i < LEVEL_TICKS }
```

**`N` is a distribution, not an integer, and round 8 published it as an integer computed from the
*mean* transit.** That is what made §6.1's band-1 `N` of 32 wrong: the last car to land is the one
with the *shortest* journey, so the mean overstates the cut-off and the closed form under-counts by
about one car. Measured over 3,000 seeds per band on the round-9 table, `N` is

| Band | median `N` | max `N` | closed form at mean `transit` |
|---|---|---|---|
| 1 | **32** | 33 | 31.3 |
| 2 | **45** | 46 | 44.2 |
| 3 | **47** | 48 | 46.3 |
| 4 | **50** | 51 | 49.6 |
| 5 | **51** | 52 | 51.0 |

**Everywhere `N` appears in a threshold — AC-220, AC-246's ceiling, §7.1.10's windows — it is the
median, and the max is quoted beside it.** [AC-220](acceptance-criteria.md) is stated "to within one
car" for exactly this reason and that tolerance is now load-bearing rather than decorative.

#### 6.1.4 Derived quantities

| Band | transit min / mean / max (ticks) | spacing (LU) | cars in flight | `N` | flip window (§4.6) | first decision (§4.6b) | min car separation |
|---|---|---|---|---|---|---|---|
| 1 | 473 / 604 / 800 | 572 | 2.73 | 32 | **2.77 s** | 159 ticks (**2.65 s**) | 457 LU |
| 2 | 473 / 620 / 761 | 404 | 3.96 | 45 | **1.95 s** | 159 ticks (**2.65 s**) | 322 LU |
| 3 | 473 / 622 / 857 | 385 | 4.26 | 47 | **1.87 s** | 146 ticks (**2.43 s**) | 308 LU |
| 4 | 473 / 608 / 761 | 360 | 4.38 | 50 | **1.75 s** | 146 ticks (**2.43 s**) | 289 LU |
| 5 | 473 / 591 / 760 | 352 | 4.40 | 51 | **1.70 s** | 146 ticks (**2.43 s**) | 281 LU |

`transit` is `(ENTRY_LEN + ROUTE_H + jogs·colW) / speed` with `jogs` at 0, the measured mean (§6.2)
and the measured maximum. **The minimum is 473 ticks at every band** — 1,300 LU at 2.75 LU/tick — because a jog-free path is
pure `ENTRY_LEN + ROUTE_H`, and both are band-independent. That row is the clearest single statement
of §6.1.1 there is: under round 8 it read 473 / 449 / 427 / 407 / 389, and the only reason it varied
was the speed column.

**Every window in the last three columns got longer, and that is the second thing this round buys.**
`development-process.md` §6.9 records that the owner rejected a first-decision window the instrument
had certified. V14 took that window to 2.00–2.65 s; the constant speed takes its *worst* case from
2.00 s to **2.43 s**, so every band now gets at least what band 3 got in round 8 and bands 1–2 keep
band 1's 2.65 s. The flip window's worst case rises 1.60 s → **1.73 s**. Neither was bought with a
lever pull; both are consequences of `speed` no longer rising up the ladder.

**Band 1 is the band below saturation and that is its design, not its difficulty setting.** At
`interval = 208` a car enters every 3.47 s and **2.73** sit on the board — below `BOT_WORKING_SET`,
which means the player never has to drop one. The 1 → 2 step takes that to 3.96, i.e. from below the
working set to above it, and **that is the mechanical content of the step that
[`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order) describes as spending the
whole traffic budget at once.** It is a better reason than "traffic rises sharply" and it is
measurable.

`D` is `[Dmin, Dmax]` over all root-to-depot paths. `J` is `[Jmin, Jmax]`, the count of junctions
**drawn**. `Ja` is the floor on junctions that are **actionable** — V13, §5 — and it is a minimum,
not a range.

**`Ja` is set to `Jmin`, and that is not a coincidence of convenience.** Actionable junctions are
bounded by what there is to decide — with `K` colours a path of decisions can sort at most `K`
destinations, so actionable `J` tracks `K`, not the drawn junction count. **Above the floor, the
band table's `J` axis is mostly the `K` axis in disguise.** Round 9 measured the same thing twice
more: at band 5, `pBranch` 0.90 → 0.95 moves `p` by 0.04 pp and `J` 7–9 → 8–10 by 0.02 pp, both
inside noise. **`pBranch` and `J` are not difficulty levers and §7.4 no longer lists them as ones.**

#### 6.1.5 Lives were measured as a lever this round, and they are too strong to be one

The reference game tightens lives with level — three early, two at levels 11–12, one at 13 and up —
and this design uses a flat three. That is the only axis in it that has never been tried, so it was
tried.

**Under a per-band life count the governing model stops being `P(Bin(N, p) <= 2)` and becomes
`P(Bin(N, p) < lives)`.** At one life it is `(1-p)^N`, which is a different curve, not a shifted
one. So the honest way to measure it is to take the measured misroute *distribution* rather than to
invert anything: the constrained bot was run over 3,000 seeds per band with the life count removed
entirely, and the clear rate at every life count read straight off the distribution.

| Band | `N` | measured `p` | mean misroutes | clear @ 4 lives | **@ 3** | @ 2 | @ 1 |
|---|---|---|---|---|---|---|---|
| 1 | 32 | 0.30 % | 0.09 | 100.0 % | **100.0 %** | 99.2 % | 91.3 % |
| 2 | 45 | 2.01 % | 0.90 | 97.7 % | **92.3 %** | 75.9 % | 45.2 % |
| 3 | 47 | 2.91 % | 1.36 | 94.1 % | **84.0 %** | 61.1 % | 26.7 % |
| 4 | 50 | 3.11 % | 1.57 | 90.7 % | **78.7 %** | 55.2 % | 24.1 % |
| 5 | 51 | 3.63 % | 1.87 | 86.2 % | **71.2 %** | 45.9 % | 18.1 % |

**One life is worth 16 to 26 percentage points of clear rate at the `p` this ladder runs at.** R3
caps a band-to-band step at **15**. So a life step on its own always breaks R3, at every pair, and
the only way to use it is to loosen the band's parameters by the same 16–26 pp in the other
direction at the same time.

**And that loosening is a reduction in cars on screen, which is the thing the owner asked for more
of.** Worked at band 5: two lives at the round-9 parameters clears 45.9 %, under R4's 55 % floor. To
put it back inside 55–78 % at two lives needs `P(Bin(51, p) < 2) ≈ 0.66`, i.e. `p ≈ 1.7 %` — which
this table reaches at an interval near 150 and **3.9 cars in flight, fewer than band 3 has.** Band 5
would become the emptiest board above band 1.

**So the two axes the owner named are in direct conflict at the sizes the ladder admits, and this
round takes density.** Density is the explicit primary instruction, it is the diagnosis of the flat
ladder, and it is the one that is visible every second of play rather than once per run. `LIVES = 3`
stays a rule of the game ([`gameplay.md` §4.1](gameplay.md#41-lives)).

**What is not settled, and goes to the owner (tier 5, §7.4.2 item L).** Two readings of the same
table are defensible and only a person can choose between them:

- *Density.* Band 5 at 3 lives, 4.40 cars, 71.2 % clear. A run ends at the bell most of the time.
- *Attrition.* A **band 6 at levels 30+** with 2 lives and band 4's density — not a re-tune of
  band 5, an extra rung past it, so R2/R3 between bands 1–5 are untouched. Measured at band 5's
  topology and `interval = 147`: 2 lives, `p ≈ 1.9 %`, clear ≈ 66 %, 3.9 cars in flight. It is a
  real endgame and it costs the design a band whose board is emptier than the one below it.

*Priced rather than chosen, because "does the ceiling feel like a ceiling" is not a question the bot
can answer — `development-process.md` §6.9.*

#### 6.1.6 The two-colour car, priced and not adopted

The reference game gives some trains and stations two colours from level 8. It is an axis this
design has no analogue for, and it is worth recording what it would cost, because it is the only
proposal on the table that raises difficulty **without** raising traffic.

A two-colour car is one that will accept either of two depots. Mechanically it *lowers* per-car
error — two acceptable destinations is an easier routing problem than one — so it is a difficulty
axis only if the pairing is the thing that is hard to hold, which is a claim about human memory and
not about this instrument: the bot holds a colour mask, and a two-bit mask costs it exactly what a
one-bit mask costs. **This design cannot measure it.** That puts it squarely in the class
§7.4 describes — a change to the model of a player — and it is listed in §7.4.2 as item **T**,
for the owner, with no recommendation attached.

### 6.2 Measured generator behaviour

Measured over **3,000 seeds per band**, 15,000 runs total, in the designer's prototype of §4 with
rule (P), V13 and V14 in force. *These are the figures the developer's `generator-audit` must
reproduce; where they differ, the audit is right and this table is wrong.*

| Band | Valid networks | Edge topologies | Signatures | `J` distribution | `Ja` distribution | `D` range | mean depth | jogs per path, mean / max |
|---|---|---|---|---|---|---|---|---|
| 1 | 3000 / 3000 | 21 | **290** | 3: 13 %, 4: 87 % | 3: 100 % | 2–3 | 2.36 | 1.20 / 3 |
| 2 | 3000 / 3000 | 125 | **1868** | 3: 9 %, 4: 24 %, 5: 68 % | 3: 39 %, 4: 24 %, 5: 36 % | 2–3 | 2.57 | 1.54 / 3 |
| 3 | 3000 / 3000 | 184 | **1411** | 4: 2 %, 5: 14 %, 6: 84 % | 4: 10 %, 5: 90 % | 2–4 | 2.87 | 1.55 / 4 |
| 4 | 3000 / 3000 | 541 | **2870** | 5: 2 %, 6: 23 %, 7: 75 % | 5: 47 %, 6: 29 %, 7: 24 % | 2–4 | 3.10 | 1.88 / 4 |
| 5 | 3000 / 3000 | 667 | **2975** | 7: 2 %, 8: 26 %, 9: 72 % | 7: 60 %, 8: 22 %, 9: 18 % | 2–5 | 3.45 | 2.06 / 5 |

**Attempt-count percentiles are** *(to be re-measured)* *by* `generator-audit`; the designer's
prototype does not instrument `GEN_STATS` and round 8's `1–2 / 3–8 / 8–20` were taken before `K`
moved. **`Ja` is the row that moved**, and it moved because `K` did: lifting `K` to `C` lifts the
count of junctions whose two reachable-colour sets are incomparable, so bands 2, 4 and 5 now sit
*above* their `Ja` floor in 61 %, 53 % and 40 % of levels instead of exactly on it.
[AC-242](acceptance-criteria.md)'s floor is unchanged and still holds in 100 % of levels.
**Signatures roughly doubled at bands 2, 4 and 5** for the same reason, which is a free gain against
[AC-234](acceptance-criteria.md)'s variety floor — band 1 is unchanged at 290 against a floor of 160
and is still the binding band.

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
| 1 | 0.288 /s | 2.36 | 0.34 | 2.73 | **0.34** |
| 2 | 0.408 /s | 2.57 | 0.52 | 3.96 | **0.54** |
| 3 | 0.429 /s | 2.87 | 0.62 | 4.26 | **0.55** |
| 4 | 0.458 /s | 3.10 | 0.71 | 4.38 | **0.65** |
| 5 | 0.469 /s | 3.45 | 0.81 | 4.40 | **0.72** |

*The measured column is the designer's 3,000-seed prototype and it is what
[AC-233](acceptance-criteria.md) is expected to reproduce, not a substitute for measuring it. Every
band is between 0.34 and 0.72 taps/s against a 1.25 /s ceiling, and the estimate overstates by
12–35 % at every band, in the direction §6.3 predicts.*

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
   return ceil(d / CAR_SPEED)
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
| 1 | 0.288 | 2.36 | 0.68 | 11 | 22 | 7 – 15 | **2.10** |
| 2 | 0.408 | 2.57 | 1.05 | 11 | 22 | 12 – 23 | **2.61** |
| 3 | 0.429 | 2.87 | 1.23 | 11 | 22 | 14 – 27 | **2.65** |
| 4 | 0.458 | 3.10 | 1.42 | 11 | 22 | 16 – 31 | **2.84** |
| 5 | 0.469 | 3.45 | 1.62 | 11 | 22 | 18 – 36 | **3.03** |

**The measured column is 1.9 to 3.1 times the lower bound, and the multiple falls up the ladder**
(3.1× at band 1, 1.9× at band 5), which says the re-focus traffic the bound omits is being squeezed
out by the cold traffic it counts. Glances fall 7.3 → 5.8 /s across the ladder while acquires rise
0.47 → 0.99 /s and evictions rise 0.000 → 0.523 /s: **the bot looks at fewer things, more
expensively, as the board fills.** That is the mechanism §6.1.2 caps at about five cars.

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

| Band | `N` | `p* = 2/N` | model window, easiest → hardest | **reading window** (model − 0.20 pp) | width |
|---|---|---|---|---|---|
| 1 | 32 | 6.25 % | 0 % → **2.60 %** | 0 % → **2.40 %** | 2.40 pp |
| 2 | 46 | 4.35 % | **1.47 %** → **2.82 %** | **1.27 %** → **2.62 %** | 1.35 pp |
| 3 | 47 | 4.26 % | **2.15 %** → **3.61 %** | **1.95 %** → **3.41 %** | 1.46 pp |
| 4 | 50 | 4.00 % | **2.68 %** → **4.12 %** | **2.48 %** → **3.92 %** | 1.44 pp |
| 5 | 51 | 3.92 % | **3.18 %** → **4.83 %** | **2.98 %** → **4.63 %** | 1.65 pp |

#### 7.1.10.0 The reading window, and why the model window cannot be used as a verdict

**The model window and the measured `p` are not on the same scale, and round 8 printed them side by
side as though they were.** §7.1.10's own limitation paragraph says why: the binomial treats a
level's `N` cars as independent trials and they are not, so at a given `p` the measured clear rate
sits *below* the model's. Inverted, that is the statement that **at a given clear rate the measured
`p` sits below the model's inversion** — always, at every band, by construction. A column that
inverts the model at the ends of the clear-rate target and then compares the measurement to it
**must** read "BELOW" whenever the clear rate is in band. Round 8's sweep duly reported exactly
that at bands 2, 4 and 5, and it was the table misreading itself, not the game.

**Measured, so it stops being a hand-wave.** Over the 222 points of round 9's `(interval, speed)`
sweep that produced a clear rate strictly between 1 % and 99.9 % — five bands, clear rates from
27 % to 99 %, `N` from 32 to 55 — the gap `invert(N, S_measured) − p_measured` is

| clear-rate bucket | 40–50 | 50–60 | 60–70 | 70–80 | 80–90 | 90–100 |
|---|---|---|---|---|---|---|
| points | 4 | 6 | 11 | 21 | 24 | 154 |
| mean gap, pp | 0.10 | 0.14 | 0.14 | 0.21 | 0.19 | 0.20 |
| mean ratio `p/p_model` | 0.98 | 0.97 | 0.97 | 0.94 | 0.93 | 0.82 |

**The gap is near-constant in percentage points and is not a constant ratio**, which is the useful
form: the correction is *additive*, about **0.20 pp**, and it does not depend on where on the ladder
the band sits. The ratio column is the same fact seen badly — it looks like a 0.82–0.98 multiplier
only because `p` itself is smaller at the easy end.

**So the design publishes two columns and they have different jobs.** The *model window* is the
object §7.1.10 reasons about — window widths, ladder spans, the monotone-`p` search — because all of
those are comparisons of the model with itself. The *reading window*, `model − 0.20 pp`, is the only
one a measured `p` may be compared against, and it is the one
[AC-241](acceptance-criteria.md) means. **A measured `p` below the model window and inside the
reading window is a pass, and round 8's "BELOW" verdicts at bands 2, 4 and 5 were the instrument
being held to the wrong ruler.**

*The 0.20 pp is itself a measurement and will move when the geometry does. It is re-measured
whenever §6.1 moves, from the same sweep that produces the clear rates, and it is a single number
rather than five because the evidence says it does not vary by band (0.19–0.25 pp across the five).*

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
| round 8, the clock (`N` = 44 / 47 / 50 / 52) | **3.21 pp** | `N` rises only 18 % across four bands while the target falls 42 %, so the windows rise faster than `N` narrows them |
| **round 9 (`N` = 45 / 47 / 50 / 51)** | **3.33 pp** | the same mechanism, with a slightly flatter `N` because `interval` no longer has to do all the escalating |

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
round 9, N = 32 / 45 / 47 / 50 / 51, searched at 0.04 pp over the five windows with R2 and R3:
p     = 0.00 / 2.38 / 3.14 / 3.66 / 4.22 %      clear = 100.0 / 90.8 / 81.7 / 72.3 / 63.5 %
drops = 9.2 / 9.1 / 9.4 / 8.9 pp                smallest margin anywhere = 4.84 pp
```

*The round-9 figure disagrees with round 8's stated **2.79 pp** by more than the change in `N`
explains — `N` moved only 44 → 45 and 52 → 51 — so one of the two searches is wrong and it is more
likely the one whose method is not written down. Round 9's is: enumerate `(p2, p3, p4, p5)` on a
0.04 pp grid inside each band's model window, require strict monotonicity, compute each band's clear
rate as `P(Bin(N, p) <= 2)`, reject any ladder whose four drops are outside `[4, 15]`, and score by
the smallest of the eight margins — four clear-rate distances to the nearer window edge and four
drop distances to the nearer of 4 and 15. **The round-8 number is not used anywhere else and is not
re-derived here; it is flagged rather than quietly replaced.***

The same search run against the two quota ladders this design has had, on the same objective so the
three are comparable:

| ladder | `N` or `quota` bands 2–5 | span of the bands 2–5 windows | best smallest margin |
|---|---|---|---|
| slice-0 / round-5 quotas | 26 / 36 / 48 / 64 | **1.23 pp** | **0.34 pp** |
| round-6 quotas | 33 / 41 / 47 / 51 | **2.78 pp** | **2.76 pp** |
| round 8, the clock | `N` = 44 / 47 / 50 / 52 | **3.21 pp** | 2.79 pp *(disputed — see above)* |
| **round 9** | `N` = 45 / 47 / 50 / 51 | **3.33 pp** | **4.84 pp** |
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
- **The `p` windows are no longer the binding half, and that is round 9's one piece of good news
  about the tuning problem.** Ignoring `p` entirely and solving only against the five clear-rate
  windows and R2/R3 gives 5.00 pp; requiring a monotone per-car error rate costs **0.16 pp of it**,
  against the 2.21 pp round 8 recorded. §7.2.2's targets and R2/R3 now take essentially all the
  room, and the physics of `P(Bin(N, p) <= 2)` takes almost none. **The ladder this round actually
  ships sits at a smallest margin of 1.3 pp** (R2 at the 3 → 4 pair), so there is 3.5 pp of
  unclaimed slack in the search — which is worth knowing the next time a band misses.

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

Round 8's reading on the round-8 table was `100.0 / 99.0 / 88.1 / 86.7 / 87.5 %` with per-car `p` of
`0.33 / 0.73 / 2.25 / 2.25 / 2.17 %`. **Band 5 was easier than band 4, `p` was flat from band 3 up,
and R2 failed at three of the four pairs.** §6.1.1 is the diagnosis and it is one sentence: cars in
flight measured `2.72 / 3.70 / 3.74 / 3.77 / 3.66`, so the quantity the ladder escalates was not
escalating.

Round 6's reading (`99.9 / 91.5 / 81.5 / 74.1 / 66.0 %`) is quoted nowhere as evidence. It was taken
against a quota ladder that no longer exists.

What transfers from both is the *definition* of `p` — misroutes over arrivals, summed across all
runs in a band, not averaged per level ([AC-246](acceptance-criteria.md)) — and the finding that `p`
is what a regression should be stated in.

#### 7.2.4 What the design expects the instrument to read

**This table is a prediction, it is falsifiable, and it is stated before the developer's sweep runs
so that it can be falsified.** It is the designer's own 3,000-seed prototype of §7.1 driven over the
§6.1 table; the developer's `tools/bot.mjs --seeds 1000` is the reading that counts, and where the
two differ the developer is right.

| Band | **clear rate expected** | §7.2.2 band | **per-car `p` expected** | §7.1.10 reading window | AC-246 ceiling `0.25 × 2/N` | `N` | delivered, median |
|---|---|---|---|---|---|---|---|
| 1 | **100.0 %** | ≥ 95 % | **0.30 %** | 0.00 – 2.40 % | **1.56 pp** | 32 | 32 |
| 2 | **92.3 %** | 86 – 97 % | **2.01 %** | 1.30 – 2.68 % | **1.11 pp** | 45 | 44 |
| 3 | **84.0 %** | 76 – 92 % | **2.91 %** | 1.95 – 3.41 % | **1.06 pp** | 47 | 46 |
| 4 | **78.7 %** | 66 – 85 % | **3.11 %** | 2.48 – 3.92 % | **1.00 pp** | 50 | 49 |
| 5 | **71.2 %** | 55 – 78 % | **3.63 %** | 2.98 – 4.63 % | **0.98 pp** | 51 | 49 |

```
drops            7.7 / 8.3 / 5.3 / 7.5 pp        R2 (>= 4)  passes at all four pairs
                                                 R3 (<= 15) passes at all four pairs
cars in flight   2.73 / 3.96 / 4.26 / 4.38 / 4.40    monotone
p                0.30 / 2.01 / 2.91 / 3.11 / 3.63 %  monotone, every band inside its reading window
taps/s           0.34 / 0.54 / 0.55 / 0.65 / 0.72    against AC-233's 1.25 ceiling
```

**Three predictions that are sharper than the clear rate and easier to falsify**, offered because a
clear rate can be right for the wrong reason:

1. **`cars in flight` at `1000` seeds should read `2.73 / 3.96 / 4.26 / 4.38 / 4.40 ± 0.03`**, and it
   is a property of the *geometry*, not of the bot — it is `transit / interval` and neither term
   depends on how well the bot plays. If the developer's number differs by more than a few
   hundredths, §6.1.1's arithmetic is wrong and everything downstream of it is suspect. **Read this
   before the clear rate.**
2. **Evictions per second should read `0.000 / 0.077 / 0.289 / 0.385 / 0.523`** and memory expiries
   should *fall* across the ladder (`0.19 / 0.16 / 0.14 / 0.10 / 0.07`). The second is
   counter-intuitive and round 8 measured it too: journeys are long enough that a car is re-glanced
   before its entry decays, so `BOT_MEMORY_TICKS / interval` falling below 1 costs nothing.
   **Evictions are the live pressure and expiries are not.**
3. **The AC-240 rise should read `-0.1 / +7.7 / +14.6 / +22.5 / +30.5 pp`**, asserting at bands 4
   and 5 under the 80 % headroom rule and reported as `n/a` at 1–3. In the `p` form it should read
   `1.40 / 2.89 / 4.18 / 6.52 / 7.11 ×`, monotone, asserting everywhere.

**If the sweep disagrees, the sweep is right** and §7.4 is the procedure. **What to read first**, in
order: cars in flight (prediction 1), then `p` against its *reading* window (§7.1.10.0 — not the
model window), then evictions, then the clear rate.

### 7.3 Target 2 — the delivery band

The completion-time target is **deleted**. Every level is 7,200 ticks
([`gameplay.md` §5.3](gameplay.md#53-session-length)), so the median, the p95 and the 130 s
absolute ceiling are all the same number by construction and five acceptance criteria measured it.

What replaces it is the quantity that *does* vary and that the player reads as their result: the
number of cars delivered.

| Band | `N`, arrivals available | a clean run delivers | expected median delivered | expected p10 |
|---|---|---|---|---|
| 1 | 32 | 32 | **32** | 31 |
| 2 | 45 | 45 | **44** | 42 |
| 3 | 47 | 47 | **46** | 33 |
| 4 | 50 | 50 | **49** | 30 |
| 5 | 51 | 51 | **49** | 25 |

*Designer's 3,000-seed prototype; the developer's sweep is the reading that counts
([AC-226](acceptance-criteria.md) – [AC-230](acceptance-criteria.md)).*

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

- **`delivered` should be flat from band 3 upward** (46 / 49 / 49). A harder band spawns slightly
  more cars and loses slightly more of them. **The score is a within-band signal, not a
  between-band one**, and a player should not read a band-5 score as bigger than a band-3 one.
- **`delivered` should be strongly bimodal**, because a run either reaches the bell or stops at its
  third misroute. The p10 column is there to make that visible: it is roughly where the failed runs
  land, and if it is close to the median the lives are not doing their job. **It separates properly
  under the round-9 table for the first time** — median minus p10 is 1 / 1 / 13 / 19 / 24 across the
  ladder, against round 8's 1 / 1 / 6 / 8 / 7. That widening is the lives starting to bite, and it
  is the same fact §6.1.5's misroute distribution reports from the other side.

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

> **What is a lever, restated from measurement rather than from habit.** Round 9 measured the
> response of `p` to every parameter in §6.1 at band 5, at a fixed operating point, over 600–2,000
> seeds each:
>
> | pull | Δ`p` | what it really moves |
> |---|---|---|
> | `interval` −8 ticks | **+0.5 to +1.5 pp** | cars in flight, and `N` |
> | `speed` −300 MLU/tick | **+0.9 to +1.7 pp** | cars in flight, via `transit` |
> | `colW` +30 LU | **+0.9 pp** | cars in flight, via `transit` |
> | `R` 6 → 8 | +0.5 pp | depth — *and breaks the 44 pt tap target, §3.2.1* |
> | `K` +1 | −0.4 to +0.3 pp | nothing reliable; it is a **visibility** axis |
> | `pBranch` 0.90 → 0.95 | +0.04 pp | nothing |
> | `J` 7–9 → 8–10 | +0.02 pp | nothing |
> | `LIVES` 3 → 2 | +26 pp *of clear rate* | everything at once — §6.1.5 |
>
> **The top three are all the same lever seen three ways: cars in flight.** `pBranch` and `J` are
> not levers and are no longer listed as ones. `K` is the axis the *player* reads as escalation and
> the instrument reads as noise; it is pulled for the player and never to move a number.

**Lever 1 — cars in flight, through `interval`. Pull this first.** It moves the per-car error rate
and the number of cars in the same direction (§7.1.10), so it has about twice the leverage it had
under a quota:

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

**Lever 1b — cars in flight, through `colW`.** `colW` moves `transit`, so it moves cars in flight
**without moving `N` and without moving the arrival rate**. That makes it the precision instrument
this model otherwise lacks: a 30 LU change is worth about 0.9 pp of `p` and about 0.05 pp of `N`.
Its range is fixed by §3.2.1's clearance rule and is entirely spent at `C >= 4`; it is available
only at band 1, and only downward. **Every `colW` pull re-runs `tools/layout-sweep.mjs`**, because
`min(colW, rowH)` is the tap-target floor.

**`speed` is not a lever and this is the paragraph that says so.** It moves cars in flight as
strongly as `interval` does, but it is one constant shared by every band
([`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order), owner-directed), so moving
it moves all five bands at once and re-opens every window in §7.1.10 simultaneously. If it is ever
moved, it is moved as a change to the *game*, with all five bands re-measured, and never as a
response to one band missing its target.

**Lever 2 — topology, when lever 1 is exhausted or when it would break a neighbour.** `R` and `C`
move `p` **without moving `N`**. `pBranch` and `J` move nothing measurable and are not levers
(§6.1, and the response table above).

- *Clear rate too low:* raise `interval`, then reduce `R`.

  > **Correction, round 9.** Round 8 wrote here: *"Do not reduce `speedMluPerTick` — a slower car
  > shortens nothing and a faster spawn rate is what makes it hard; reducing speed shortens the
  > planning horizon relative to the spawn rate and pushes the game toward reaction."* **The second
  > half of that is backwards and it is the sentence that produced the flat ladder.** A slower car
  > lengthens `transit`, which *raises* cars in flight at a fixed `interval` — measured, band 5 at
  > `interval = 140`: 3350 → 2450 MLU/tick takes the board from 3.36 cars to 4.51 and the clear rate
  > from 98.3 % to 75.8 %. And it gives every individual decision **more** absolute time, not less:
  > the first-decision window is `(ENTRY_LEN + rowH) / speed`. Slower cars push the game *toward*
  > divided attention and away from reaction, which is the direction this design wants. The correct
  > statement is the one above: speed is a traffic lever with as much force as `interval`, it is now
  > one constant for all five bands, and it is not pulled per band.
- *Clear rate too high:* cut `interval`, then add a row. **Do not reach for `pBranch` or `K`.**
  Measured this round at band 5: `pBranch` 0.90 → 0.95 is worth 0.04 pp of `p` and `J` 7–9 → 8–10 is
  worth 0.02 pp, both inside noise; `K` is worth between −0.4 and +0.3 pp depending on the band and
  the sign is not predictable. `K` is on the table because the player sees it
  ([`gameplay.md` §5.1](gameplay.md#51-what-escalates-and-in-what-order)), not because it moves this
  number. If either is pulled for any reason, [AC-242](acceptance-criteria.md) and
  [AC-243](acceptance-criteria.md) are re-measured with it.
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

**`LIVES` is still not a lever, and round 9 is the round that measured why rather than asserting
it.** Three lives is what makes the clear rate `P(Bin(N, p) <= 2)`; a per-band life count makes it
`P(Bin(N, p) < lives)`, which at one life is `(1-p)^N` — a different curve, not a shifted one. It
would move every window in §7.1.10 at once and every AC-246 ceiling with them. **And it is worth
16–26 pp of clear rate per life at this ladder's `p`, against R3's 15 pp ceiling on a single step**
(§6.1.5 has the measured distribution). It is a rule of the game
([`gameplay.md` §4.1](gameplay.md#41-lives)), not a tuning parameter. §6.1.5 prices the one shape in
which it could be used — an extra rung past band 5 rather than a re-tune of it — and sends it to the
owner.

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

### 7.4.2 The tier-5 register — what only the owner can settle

`development-process.md` §6.9's rule is that **a threshold derived from the instrument's own
constants is not evidence about a human.** This section is the list of places where this design has
reached one, so that nobody reads a bot's pass on them as settled. Each is a real choice with a
measured price, not an open question the designer declined to answer.

| # | The question | What the measurement says | Recommendation |
|---|---|---|---|
| **D** | **How busy should the board be?** | Cars in flight is capped near 5 by the instrument (§6.1.2) — and by the *glance budget*, not by `BOT_WORKING_SET`: 3 → 4 slots moves band 5's clear rate at 4.36 cars from 57 % to 85 %, and 4 → 5 moves it not at all. The round-9 table sits at 2.7–4.4. The owner has said the round-8 board at 2.7–3.8 felt like *"one train of thought"*. | **Ship 2.7–4.4, get a screenshot and a play session, and be ready to go further.** If the owner still reads it as sparse, the finding is that `BOT_WORKING_SET = 3` is too small a model of a human — which is the §7.4 exception, and it re-reads every target, not just the failing one. |
| **L** | **Should lives tighten at the top?** | One life is worth 16–26 pp; R3 caps a step at 15 (§6.1.5). Lives and density cannot both escalate: band 5 at 2 lives needs 3.9 cars to stay in window, fewer than band 3. | **Keep `LIVES = 3`.** If the owner wants the reference game's attrition, take it as a **band 6 at levels 30+** — an extra rung, not a re-tune — priced in §6.1.5. |
| **T** | **Two-colour cars.** | The instrument cannot measure it: a two-bit colour mask costs the bot exactly what a one-bit mask costs, and mechanically it makes routing *easier* (§6.1.6). Whether it is hard for a person is a claim about human memory. | **No recommendation.** If the owner wants it, it is a gameplay change measured by playing, and the bot is silent on it. |
| **S** | **Is 165 LU/s the right speed?** | Speed is now one constant for all five bands. At 2750 MLU/tick a car crosses the route in 6.5 s and the first-decision window is 2.43–2.65 s at every band, up from round 8's 2.00 s worst case. Lower is *harder* and *fairer* at once (§7.4 lever 1's correction); higher is easier and tighter. | **2750.** It is the value band 1 already ran at, so no band gets faster than the tutorial did, and §6.9's rejected window cannot recur. |
| **R** | **Does the road recede enough?** | [`ui.md` §4.6](ui.md#46-the-ink-budget) turns it into a measured ink budget rather than a matter of taste. | Per `ui.md`; the number is measurable but the threshold is a judgement. |
| **P** | **Is the palette still bleak?** | The six car colours are a constrained optimisation and are measured ([`ui.md` §5.2](ui.md#52-measured-separation)); *"feels sad"* is not a quantity. Round 9 adds a sixth colour, brightens `--road`, and puts each depot's colour on screen at car-sized area (`--depot-glow`). | Per [`ui.md` §5](ui.md#5-colour), and it wants the same screenshot as item R. |

**None of these is a blocker.** The design is complete and buildable on the recommendations above.
Each is listed because a tier-1 pass on it would be the instrument agreeing with itself.

---

---

## 8. Harnesses this design assumes exist

| Tool | What it must assert |
|---|---|
| `tools/generator-audit.mjs --seeds 5000` | V1–V15 hold for every band × seed; zero `GEN_EXHAUSTED`; report attempt-count percentiles, per-rule rejection counts (§5.2), distinct edge topologies **and** distinct signatures per band. Also, per band, the **minimum `firstDecisionTicks`** over every path of every level against [AC-245](acceptance-criteria.md)'s floor of 90. |
| `tools/generator-audit.mjs --rule-injection` | For each of V1–V11 and V13–V15, a fixture that violates that rule, with the rule's check invoked **directly** rather than through `validate()`'s cascade ([AC-244](acceptance-criteria.md)). Eleven of the fourteen are unreachable through `generate()` (§5.2) and this is the only place their checks are ever executed against a violation. **V14 and V15 are new and are in that class.** |
| `tools/generator-audit.mjs --geometry` | Per band: every edge's `lengthMlu` equals `(|Δx| + |Δy|) · MLU` ([AC-207](acceptance-criteria.md)); no two horizontal runs in a row band are collinear and touching unless they share a source or a depot (§2.5); and **where a horizontal run terminates on an occupied lattice site, that site is a depot or a branch node carrying a junction marker** (§2.5 Lemma 1 / Lemma 1T). *The last clause replaces round 8's "no horizontal run terminates on an occupied lattice site", which is false: terminal-row landings occur in 98.7–100 % of levels.* The audit must also **report** the route-row and terminal-row landing counts separately, so that the difference stays visible. The fault to inject is a generator with rule (P) removed, which must fail all three. |
| `tools/generator-audit.mjs --actionable --seeds 3000` | Per band: mean and minimum live-junction count under §6.2's lazy-optimal oracle, the share of levels below `Ja`, and the mean count of junctions flipped twice or more ([AC-243](acceptance-criteria.md)). |
| `tools/bot.mjs --seeds 1000` | Unconstrained bot delivers `N` cars with zero misroutes; constrained clear rate within §7.2's table **and** satisfying R2 and R3's shape rules; measured taps/s and delivered per band. **Also reports `cars in flight` per band** — the tick-weighted mean of `state.cars.length` — against §6.1's `2.73 / 3.96 / 4.26 / 4.38 / 4.40`. That column is a property of the geometry rather than of the bot, so it is the first thing to read when a clear rate comes in wrong, and §7.2.4 states it as a falsifiable prediction to ±0.03. |
| `tools/bot.mjs --entry-window` | Per band: the per-car failure rate at each car's first decision against the rate at its other decisions, against [AC-246](acceptance-criteria.md)'s per-band ceiling. **The fault injection no longer discriminates and [AC-246](acceptance-criteria.md) says so explicitly** — round 3's pure round-robin now passes at every band, because V14 removed the defect the guard was guarding rather than the guard catching it. The sweep still runs, still reports both figures at every band, and the round-robin arm is still executed; what changed is that it is now a **regression witness with a stated expectation of passing**, and a *failure* of it is the finding. |
| `tools/bot.mjs --lives-distribution --seeds 3000` | **New.** Per band, the full distribution of misroutes per run with the life cap removed, and the clear rate it implies at 1, 2, 3 and 4 lives (§6.1.5). This is the only way to measure `LIVES` as a lever without changing a rule of the game, and it is what priced §7.4.2 item **L**. Expected mean misroutes: `0.09 / 0.90 / 1.36 / 1.57 / 1.87`. |
| `tools/bot.mjs --attention-report` | Per band, per 1,000 seeds: mean glances/s, mean focus events/s, the split between `BOT_SWITCH_TICKS` and `BOT_ACQUIRE_TICKS` focuses, mean working-set occupancy, evictions/s, memory expiries/s, onset captures/s and captures as a share of glances (§7.1.5 D3), and the count of misroutes caused by a flip the bot made for a car it was holding onto a car it was not. These are the numbers that say *why* a band lands where it does, and without them a missed target is unexplainable. |
| `tools/spawn-schedule.mjs --seeds 2000` | Per band: `spawns.length` equals the closed form of [`gameplay.md` §2.7](gameplay.md#27-spawn-scheduling-as-a-deterministic-function-of-the-seed); every scheduled tick is `< LEVEL_TICKS`; ticks strictly increase; and in a run that reaches the bell, `nextSpawn === spawns.length` ([AC-139](acceptance-criteria.md)). *This replaces `tools/spawn-margin.mjs`, which measured a margin that no longer exists.* |
| `tools/converge.mjs --seeds 1000` | Per band: the rate at which two cars on converging terminal edges are within `CAR_L` of each other, and the share of those in which **both** centres are outside the depot terrace ([AC-513](acceptance-criteria.md)). Reports a number and a worst-case screenshot; the designer's prototype measured 59–301 per 1,000 runs before the terrace. **Re-measure under round 9's table**: `colW` rose at every band and the spacing fell, so the rate will move and the direction is not predictable from the old reading. |
| `tools/layout-sweep.mjs` | The viewport sweep of [AC-401](acceptance-criteria.md) and [AC-402](acceptance-criteria.md). **Re-run for round 9's `colW`** (§3.2.1): the binding junction target is expected to move from 44.16 pt to **46.61 pt** and the car-body floor to stay at 20.24 pt. |
| `tools/replay.mjs --seed N` | A recorded run replays to a deeply equal final state, twice in a row and across machines. |

Per `development-process.md:136`: before any of these is trusted to pass, the fault it is meant
to catch is injected and the harness is confirmed to fail.

`tools/pacing.mjs` is **deleted**. It measured completion time, which is now a constant.

## 9. Deferred, owner-directed: the Train of Thought identity questions

**This section is a brief for a later round, not an open question and not a proposal.** The owner
has deferred both items below to their own round and instructed that nothing here be re-measured or
changed now. **V2, the merge-free property and the one-entry rule are untouched by round 9.** What
follows is what the next round would have to measure, and why the recorded rejections may not
survive round 8's geometry — written down so that round is not spent re-deriving it.

### 9.1 Two entry points ([`gameplay.md` §8.1](gameplay.md#81-one-entry-not-two--decided))

**The recorded rejection.** A merge-free tree needs `K − 1` terminal columns per entry, so two
entries at four colours needed six columns, and at six columns the junction pitch was already at the
44 pt tap-target floor at 320 pt width.

**Why it may not survive.** Every number in that sentence moved. The design rectangle is now
1000 × 1500, `colW` is derived rather than chosen (§3.2.1), and the binding junction target at six
columns is **46.61 pt** rather than 44.16.

**What the next round must measure, and with what.**

1. *The column budget, which round 9 has already narrowed.* §3.2.1 records that `C = 7` is
   impossible at `DESIGN_W = 1000` — 44 pt needs `min(colW, rowH) >= 150` LU, which puts the
   outermost depot 12 LU outside the rectangle, and the widest `colW` that fits (146) gives 42.93 pt.
   So a second entry has to live inside six columns or move `DESIGN_W` to 1024 and rescale every
   width-bound device. **Harness: `tools/layout-sweep.mjs` at `C = 7` and at `DESIGN_W = 1024`.**
2. *What a second entry costs that §8.1 did not price.* Under merge-free routing two trees may not
   share a lattice site, so each owns a contiguous column range and can only reach the depots in it.
   **Two entries in `C` columns therefore give each front a disjoint subset of the colours, and each
   front is simpler than the single tree it replaced.** Total colour count is unchanged; what is
   bought is spatial separation, and what is paid is depth and colour breadth per front. Either
   `V10` relaxes to allow a colour to have a depot in both halves, or each entry serves half the
   palette. **Harness: a `generator-audit --two-entry` yield sweep, plus `bot.mjs` to measure
   whether two simple fronts are harder than one deep one — which is not obvious and is the whole
   question.**
3. *Whether it is the right fix at all.* §6.1.2 is the competing explanation for the owner's report:
   the board is empty because the instrument caps it near five cars, not because everything arrives
   down one road. **Those two hypotheses make different predictions and a play session distinguishes
   them.** Round 9's table raises cars in flight from 3.7 to 4.4 at band 5 and holds the entry
   count; if that alone changes the owner's reading, item 1 and 2 are moot.

### 9.2 Merges ([`gameplay.md` §8.2](gameplay.md#82-merge-free-networks--decided))

**The recorded rejection.** Preventing two cars converging onto a shared edge requires equal path
length to the shared node; under cubic edges that meant equal **arc length**, which rejected
essentially every candidate (0 valid networks in 2,000 seeds per band). Round 8 re-measured the
narrowest form — equal jog count to a shared *depot*, rule V16 — and it took generation from
3000/3000 to 2976 and 2960 valid, attempts from a median of 1–2 to 37 and 40 with a p95 of 150 and
168 against [AC-203](acceptance-criteria.md)'s ceiling of 128.

**Why it may not survive.** Under orthogonal routing,

```
path length to (r, c) = ENTRY_LEN + r * rowH + jogs * colW
```

and `r * rowH` is the same for every path to row `r`. **So two paths to the same node have equal
length if and only if they have the same jog count** — an integer condition on a small integer, not
an equality between two arc-length integrals. It is also a *parity*-constrained one: a path from
column `e` to column `c` has `jogs >= |c - e|` and `jogs ≡ |c - e| (mod 2)`, so the admissible jog
counts at a site differ by twos.

**The specific reason the round-8 measurement may not be about the space.** V16 was measured as a
**rejection filter** bolted onto a depth-first search that does not know about it — generate freely,
then throw the network away if the jog counts disagree. The constraint is *constructive*: the jog
count is a label that can be carried forward row by row, and a merge admitted only between equal
labels. **A rejection-sampling cost is evidence about the search, not about the space**, and this
project has made that mistake before — [`generation.md` §5.1](generation.md#51-why-v6-was-not-simply-strengthened)
records the same shape of finding about strengthening V6.

**What the next round must measure, and with what.**

1. *Yield under a constructive label.* A `buildRow` that carries `jogCount` per live site and admits
   a merge at `(r+1, c')` from sources `c1, c2` only when `label(c1) + |c'-c1| = label(c2) + |c'-c2|`.
   **Harness: `generator-audit --seeds 3000` on the modified generator, against
   [AC-203](acceptance-criteria.md)'s attempt ceiling of 128 and a `GEN_EXHAUSTED` count of zero.**
   The question is a yield, and it is a different question from the one round 8 answered.
2. *What it costs upstream.* §2.5's Lemmas 1–4 assume in-degree 1 on route rows; a merge makes two
   horizontal runs share a target column on a *route* row, which is the case Lemma 2 currently
   forbids. V2 would become non-decreasing on every row rather than only the terminal one, and a new
   rule — call it V17, *every path into a node carries the same jog count* — would carry the safety
   argument. `development-process.md:96`'s "no junction a car can enter from two directions" would
   need restating precisely as **no *branch* node may be entered from two directions**: a merge node
   is a pass node with in-degree 2, and the rule's intent is that a junction's meaning be
   unambiguous.
3. *What it buys.* Two things, and the second is larger than the first. Networks become graphs
   rather than trees, which is the dense-web half of the owner's report. And **the depot-mouth
   convergence problem disappears by construction**: equal jog count means equal path length means
   §4.5's spawn-separation guarantee extends all the way to the depot, which retires
   [`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road), the
   depot terrace and [AC-513](acceptance-criteria.md)'s 59–301-per-1,000 near-miss rate. §4.5b calls
   that "the complete fix"; the only thing ever held against it was the cost of the search.
