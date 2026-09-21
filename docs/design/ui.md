# Offramp — UI, Visual System and Motion

Screen inventory, layout arithmetic with real dimensions, the palette with hex codes and measured
contrast, every component state, the motion spec, and accessibility.

Companion documents: [`gameplay.md`](gameplay.md), [`generation.md`](generation.md),
[`acceptance-criteria.md`](acceptance-criteria.md).

Two units appear throughout and are never interchangeable:

- **pt** — React Native logical points. All UI chrome is specified in pt.
- **LU** — layout units, the engine's device-independent design space
  ([`generation.md` §3.1](generation.md#31-design-space)). Everything inside the Skia canvas is
  specified in LU and scaled once, at the canvas boundary.

> **Round 8 changed every dimension in §3 and §4 and rewrote §7.6.** The design rectangle is
> 1000 × 1500 LU, roads are orthogonal with filleted corners, and the road and the car are about a
> quarter smaller in each dimension than they were. §5 (the palette) and §6 (colour-blind support)
> are untouched, because nothing about colour changed.

---

## 1. Identity

Offramp is a **night road**, seen from directly above. Dark asphalt, bright painted lane edges,
saturated vehicle paint. It is not a toy, not a train set and not a children's illustration:
there is no wood grain, no rounded cartoon bevel, no cheerful sky. The reference points are
motorway signage and a traffic-control screen — flat, high-contrast, legible at a glance and at
arm's length.

Four rules carry the identity, and the fourth is new:

1. **The road network is the screen.** Chrome is a thin bar at the top; everything else is road.
2. **Nothing decorative moves.** Every animation in the play surface reports a state change. If
   it moves, it means something.
3. **Colour is reserved.** The five car colours belong to cars and depots and appear nowhere
   else. Chrome is greyscale plus one alert red.
4. **Every road runs north–south or east–west, and every corner is a junction.** Nothing curves
   except a 28 LU fillet at a corner. This is the owner's direction and it is also, as it turns
   out, the strongest thing the drawing has to say: because a pass node's road is always vertical
   ([`generation.md` §2.5](generation.md#25-planarity-and-non-coincidence-why-no-two-roads-are-ever-mistaken-for-one)),
   a player can read "this road turns" as "there is a decision here" with no exceptions.

---

## 2. Screen inventory

| # | Screen | Purpose |
|---|---|---|
| S1 | **Title** | Name, Play, Levels, Settings |
| S2 | **Level select** | Grid of unlocked levels with best delivered |
| S3 | **Play** | HUD + Skia play surface. The game. |
| S4 | **Pause** overlay | Resume, Restart, Quit |
| S5 | **Level complete** overlay | Result, Retry, Next |
| S6 | **Level failed** overlay | Result, Retry, Levels |
| S7 | **Settings** | Symbol size, reduce motion, haptics, sound |
| S8 | **Resume countdown** overlay | 3-2-1 after backgrounding |

Slices 1–3 need S3, S4, S5, S6, S8. S1, S2 and S7 can be stubs until slice 4, but their layout is
specified here so they are not invented later.

---

## 3. Play screen layout

Reference device: iPhone 15/16, **393 × 852 pt**, safe-area insets top 59, bottom 34.

```
┌─────────────────────────────── 393 pt ───────────────────────────────┐
│                                                                      │  ▲
│                        safe-area top inset (59)                      │  │ 59
├──────────────────────────────────────────────────────────────────────┤  ▼
│ 16                                                              16   │  ▲
│ ┌──────────┐   ┌────────────────────────┐   ┌───────┐  ┌────┐        │  │
│ │ LEVEL 12 │   │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░ │   │ ● ● ○ │  │ ▮▮ │        │  │ 56
│ │    23    │   │         1:07           │   │       │  │    │        │  │
│ └──────────┘   └────────────────────────┘   └───────┘  └────┘        │  ▼
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │  ▲
│                         (vertical slack, 55 %)                       │  │
│  · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·   │  │
│                             ENTRY                                    │  │
│                               │                                      │  │
│                               ·     ← row 0 is always a pass (V14)   │  │
│                               │                                      │  │
│                               ◆────────╮                             │  │ play
│                               │        │                             │  │ area
│                         ╭─────◆        ◆──────╮                      │  │ 695
│                         │     │        │      │                      │  │
│                         │     │        │      │                      │  │
│                      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   ← depot terrace   │  │
│                      ┌────┐┌────┐┌────┐┌────┐                        │  │
│                      │ ●  ││ ▲  ││ ■  ││ ✚  │       ← depots         │  │
│                      └────┘└────┘└────┘└────┘                        │  │
│  · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·   │  │
│                         (vertical slack, 45 %)                       │  ▼
├──────────────────────────────────────────────────────────────────────┤
│                      safe-area bottom inset (34)                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Play-area arithmetic

```
HUD_H      = 56 pt
GUTTER_BOT = 8 pt

playTop    = safeAreaTop + HUD_H
playBottom = screenH - safeAreaBottom - GUTTER_BOT
playH      = playBottom - playTop
playW      = screenW                          // full bleed, no side gutter
```

### 3.2 Mapping design space onto the play area

A single uniform scale. No stretch, no non-uniform axes, no per-band special case.

```
scale   = min(playW / 1000, playH / 1500)
slackX  = playW - 1000 * scale
slackY  = playH - 1500 * scale
originX = slackX / 2
originY = playTop + slackY * 0.55
```

The horizontal slack is centred. The **vertical slack is split 55 % above / 45 % below**, which
biases the whole network a few points downward toward the thumb without crowding the home
indicator.

`screen = origin + design * scale`, and the inverse is used for hit testing (§10.1).

**`DESIGN_H` moved 1600 → 1500 and the gain is real.** LU is a ratio unit, so only the aspect of
the design rectangle matters. The binding device is the iPhone SE 1st generation, whose play area
is 320 × 484 pt — an aspect of 0.661 against the old rectangle's 0.625, so the old rectangle was
**height-bound there and left 17.5 pt of width unused**. At 1000 × 1500 the aspect is 0.667, the SE
fits within a hair on both axes, and the scale goes 0.3025 → **0.3200**: 5.8 % more of everything,
on the one device every floor in §4.4 is measured against.
([`generation.md` §3.1](generation.md#31-design-space))

### 3.3 Measured fit across real devices

| Device | W × H | insets | `scale` | play H | vertical slack | junction target (worst band) | car body | road width |
|---|---|---|---|---|---|---|---|---|
| iPhone SE (1st) | 320 × 568 | 20 / 0 | 0.3200 | 484 | 4 | **46.1 pt** | 21.1 × 33.3 | 26.9 |
| iPhone SE (2nd/3rd) | 375 × 667 | 20 / 0 | 0.3750 | 583 | 21 | **54.0 pt** | 24.8 × 39.0 | 31.5 |
| iPhone 13 mini | 375 × 812 | 50 / 34 | 0.3750 | 664 | 102 | **54.0 pt** | 24.8 × 39.0 | 31.5 |
| iPhone 13/14 | 390 × 844 | 47 / 34 | 0.3900 | 699 | 114 | **56.2 pt** | 25.7 × 40.6 | 32.8 |
| **iPhone 15/16** | 393 × 852 | 59 / 34 | 0.3930 | 695 | 106 | **56.6 pt** | 25.9 × 40.9 | 33.0 |
| iPhone 16 Pro Max | 440 × 956 | 62 / 34 | 0.4400 | 796 | 136 | **63.4 pt** | 29.0 × 45.8 | 37.0 |
| Galaxy S23 | 360 × 780 | 24 / 24 | 0.3600 | 668 | 128 | **51.8 pt** | 23.8 × 37.4 | 30.2 |
| Pixel 7 | 412 × 915 | 24 / 24 | 0.4120 | 803 | 185 | **59.3 pt** | 27.2 × 42.8 | 34.6 |
| Tall Android 21:9 | 412 × 1024 | 32 / 24 | 0.4120 | 904 | 286 | **59.3 pt** | 27.2 × 42.8 | 34.6 |

The binding device is the **iPhone SE 1st generation at 320 × 568**. Everything in §4 is sized so
that device passes. The junction-target column is the worst band on that device, which is always
band 5 (`min(colW, rowH) = 150` LU, the finest grid in the game).

**What the size change actually did**, on the reference device: the car goes from 33.0 × 55.0 pt to
**25.9 × 40.9 pt** — 21 % narrower, 26 % shorter, **42 % less area** — and the road from 40.9 pt to
33.0 pt wide. The owner's report was that the road and the vehicles were too big and were pulling
attention away from changing routes; this is the answer, and it is bounded from below by
[AC-402](acceptance-criteria.md)'s 20 pt car-body floor, which the smallest supported configuration
clears at 20.24 pt (§4.4).

**Clearance below the depot row.** `DEPOT_Y + DEPOT_H = 1350 + 128 = 1478` against
`DESIGN_H = 1500`, so 22 LU of margin. On the SE that is 7.0 pt of design margin plus 1.8 pt of
lower slack plus the 8 pt gutter = **16.8 pt** between the depot body and the bottom of the screen;
over the whole viewport sweep the minimum is **14.75 pt** against [AC-411](acceptance-criteria.md)'s
8 pt floor. *The old layout ran this down to 11.0 pt after slice 1b spent 60 LU of it on
`ENTRY_LEN`; the re-laid rectangle gives it back.*

---

## 4. The play surface

### 4.1 Geometry constants (LU)

| Constant | Value | was | At SE scale 0.3200 | At iPhone 16 scale 0.393 |
|---|---|---|---|---|
| `ROAD_W` | **84** | 104 | 26.9 pt | 33.0 pt |
| `ROAD_EDGE_W` | 4 | 4 | 1.3 pt | 1.6 pt |
| `CORNER_R` | **28** | — | 9.0 pt | 11.0 pt |
| `CAR_L` | **104** | 140 | 33.3 pt | 40.9 pt |
| `CAR_W` | **66** | 84 | 21.1 pt | 25.9 pt |
| `CAR_RADIUS` | **12** | 16 | — | — |
| `GLYPH_CAR` | **42** | 48 | 13.4 pt | 16.5 pt |
| `GLYPH_CAR_LARGE` | **58** | 66 | 18.6 pt | 22.8 pt |
| `GLYPH_DEPOT` | **52** | 64 | 16.6 pt | 20.4 pt |
| `GLYPH_DEPOT_LARGE` | **72** | 88 | 23.0 pt | 28.3 pt |
| `JUNCTION_MARK_R` | **34** | 46 | 21.8 pt ⌀ | 26.7 pt ⌀ |
| `BLADE_LEN` | **30** | 40 | — | — |
| `BLADE_W` | **9** | 12 | — | — |
| `DEPOT_W` | **124** | 160 | 39.7 pt | 48.7 pt |
| `DEPOT_H` | **128** | 170 | 41.0 pt | 50.3 pt |
| `COMMIT_PREVIEW` | **200** | 260 | — | — |
| `OPEN_BRANCH_FADE` | **28** | 36 | — | — |
| `TERRACE_FADE` | **28** | 36 | — | — |
| `mouthLu` | per band, §7.6 | — | — | — |

**Everything shrank by roughly a fifth and the ratios that matter were preserved.** `CAR_W` (66) is
narrower than `ROAD_W` (84), leaving a 9 LU shoulder on each side — the old pair left 10. The
junction marker's diameter (68) is now **smaller than the road** (84), where the old 92 LU marker
overhung a 104 LU road by nothing at all; a marker that sits inside its road reads as a fitting on
the road rather than a sticker over it. `DEPOT_W` (124) is a constant rather than a fraction of
`colW`, so the depot never collides with its neighbour (narrowest case `colW = 150` leaves a 26 LU
gap) and never overhangs the design-space edge (narrowest margin 63 LU,
[`generation.md` §3.2](generation.md#32-site-coordinates)).

**`CAR_W = 66` is the binding number in this table and it is set by an acceptance criterion, not by
taste.** [AC-402](acceptance-criteria.md) requires ≥ 20 pt of car body on the smallest supported
configuration, which is `playW = 320, playH = 460` → `scale = 0.30667` → `CAR_W >= 65.2`. 66 gives
20.24 pt. Anything smaller fails the sweep. **The car cannot get smaller than this without either
raising the support floor or re-arguing AC-402**, and that is the wall the owner's "smaller
vehicles" direction runs into.

**`CORNER_R = 28` is a third of the road width.** Large enough to read as a turn rather than a
mitre, small enough that the road's outer corner is still square-shouldered. The car centre follows
the un-filleted polyline mapped onto the fillet
([`generation.md` §3.4](generation.md#34-placing-a-car-renderer-only)); the largest deviation
between the two is `CORNER_R·(√2 − 1) ≈ 11.6` LU, well inside the road's 42 LU half-width, so a car
never leaves the tarmac on a turn.

### 4.2 Draw order

1. Background fill
2. Road casing — every edge stroked at `ROAD_W + 2*ROAD_EDGE_W` in `--road-edge`, round joins
3. Road surface — every edge stroked at `ROAD_W` in `--road`, round joins
4. Lane dashes — every edge stroked at 3 LU, dash 16/22, in `--road-dash`
5. Junction markers, and the lead-highlight bar when armed (§7.3)
6. Entry flares (§7.5) — beneath the cars, so a flare never dims the car whose arrival it marks
7. **Car shadows** — every car's shadow, ascending by id, as one layer
8. **Car bodies** — ascending by id, each with body, windscreen and roof glyph
9. **The depot terrace** (§7.6) — one rounded rectangle in `--depot` with a `TERRACE_FADE` alpha
   ramp along its top edge
10. Depot bodies and depot glyphs
11. Transient effects sourced from `state.events` (§9)

**Steps 2, 3 and 4 stroke a polyline with round joins, and that is what draws the fillet.** A
Skia stroke with `StrokeJoin.Round` on a right-angled polyline produces exactly the rounded outer
corner the identity asks for; the join radius is half the stroke width, so the road casing's outer
corner radius is `(84 + 8) / 2 = 46` LU and the surface's is 42. `CORNER_R = 28` is the *centreline*
fillet the car follows, drawn separately only in the lane dashes, which are generated along the
filleted centreline so the dashes turn the corner instead of meeting it at a point.

**Steps 7 and 8 are two passes over the cars, not one**, which is what makes
[AC-501](acceptance-criteria.md) satisfiable: one pass draws car *n+1*'s shadow on top of car *n*'s
body. Shadows are a ground layer and they all belong under all of the bodies. The case is reachable
in exactly one place and that place is now far more common than it was: the shared depot approach
([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)),
measured at 59–301 runs per 1,000 rather than the old 0–5.

Cars are painted after junction markers, so **a car is never hidden by a junction marker**. Both
car passes are painted *before* the depot layer, so a car drives **under** the terrace and under
the depot body. Nothing else occludes a car.

### 4.3 The car

Top-down, axis-aligned to the road direction — which is now always one of four headings, plus the
90° sweep through a corner. The body is **one large colour fill**: a rounded rectangle
`CAR_L × CAR_W`, corner radius `CAR_RADIUS`, filled with the car's colour. On top of it:

- a **windscreen**: a 26 × 36 LU rounded rect (26 across the body, 36 along it), corner radius
  6 LU, in **`--text` `#E8ECF2` at 22 % opacity**, offset 24 LU toward the nose — it reads as a
  car rather than a capsule and costs no colour area;
- the **colour glyph**, `GLYPH_CAR` square, in `--ink`, centred on the body and **counter-rotated
  so it is always upright relative to the screen** (§6.2);
- a **shadow**: the same rounded rect, `#000000` at 32 %, offset `(0, +5)` LU in **screen** space
  — not in the car's frame, because the light is above the screen and a shadow does not rotate
  with the thing casting it — drawn as a layer under *all* bodies (§4.2, steps 7 and 8).

No outline, no gradient, no headlights. The colour patch is at minimum 21.1 × 33.3 pt on the
smallest common device and 20.24 pt wide in the worst supported configuration, above the 20 pt
legibility floor of [AC-402](acceptance-criteria.md) — by **0.24 pt**, which is the whole of the
remaining room.

**Cornering.** Through a corner the body rotates 90° over the `2 · CORNER_R = 56` LU of centreline
the fillet occupies — 0.34 s at band 1, 0.28 s at band 5 — with the rotation linear in arc length,
not eased. Easing it would make the car appear to hesitate at a junction, which is the one place in
the game where hesitation means something. The glyph counter-rotates over the same span so it stays
screen-upright throughout ([AC-603](acceptance-criteria.md)).

**The windscreen is light, and this is a measurement rather than a preference.** At 22 % toward
`--ink` the windscreen patch drops to **2.79 : 1** against the road for Rose and **2.81 : 1** for
Iris, against the ≥ 4.2 : 1 this palette was validated at — so part of the colour patch of two of
the five cars would sit below the floor the whole palette was chosen to clear, on the one element
whose only job is to be identified by colour. At 22 % toward `--text` the same patch reads
`6.13 / 8.74 / 4.99 / 6.71 / 5.24 : 1`, every one above the floor. Physically it is also the right
answer — from directly above at night a windscreen shows reflected sky and street light, not a
hole. **There is no `--car-glass` token.** [AC-606](acceptance-criteria.md)'s figures are per-pixel
and do not depend on the windscreen's size, so they are unchanged.

**The windscreen shrank further than the body did, and that is a consequence of the smaller car
rather than a taste.** The car's area fell 42 %, but `GLYPH_CAR` only fell 13 % (48 → 42 LU)
because it has to stay legible at 13.4 pt (§6.2) — so the glyph's *share* of the body rose from
20 % to 26 %. Measured by rasterising the exact shapes at 0.25 LU, windscreen plus glyph cover
**34.0 %** of a 6,740 LU² body, against [AC-502](acceptance-criteria.md)'s 35 % ceiling and the old
car's 31.5 %. The windscreen gave up the difference. **The colour-blind cue was protected at the
expense of colour area, deliberately**, and the 1.0 pp of headroom left against AC-502 is the
signal that this car is as small as the current glyph sizes allow.

### 4.4 Tap-target arithmetic

A junction is a tap target and must be at least 44 × 44 pt. The visible marker is smaller than
the target, which is standard, and the hit radius adapts to the scale:

```
minSep     = min(colW, rowH)                          // per band, 150 LU at worst
HIT_R_MIN  = 76
HIT_R_LU   = min( max( ceil(22 / scale), HIT_R_MIN ), floor((minSep - 6) / 2) )
```

`ceil(22 / scale)` is the radius in LU that yields exactly 44 pt. `HIT_R_MIN` keeps the target
generous on large screens. **The upper bound is applied last and wins whenever the two conflict** —
at band 5, `floor((150 - 6) / 2) = 72 < 76`, so the target is 72 LU and the clamp's lower bound is
inert. That ordering is normative: it is what keeps hit circles from ever touching, since
`2 * HIT_R_LU <= minSep - 6 < minSep` by construction.

**Hit circles therefore never overlap**, which means "nearest junction within `HIT_R_LU`" and
"the unique junction containing the point" are the same answer, and hit testing has no tie-break
to get wrong.

Verified by arithmetic sweep over widths 320–520 pt × heights 560–1200 pt × 9 safe-area inset
profiles × 5 bands, excluding configurations below the declared support floor — **5,512,425
configurations, zero violations**: minimum junction target **44.16 pt**, minimum car body width
**20.24 pt**, zero overlapping hit circles, minimum clear space below the depot **14.75 pt**
([AC-401](acceptance-criteria.md), [AC-402](acceptance-criteria.md),
[AC-411](acceptance-criteria.md)).

**Declared support floor:** `playW ≥ 320 pt` and `playH ≥ 460 pt`. *The height floor moved
400 → 460 because the design rectangle is shorter and therefore hits its height bound at a larger
scale; at `playH = 460` the scale is 0.30667 and both floors are met with 0.16 pt and 0.24 pt to
spare. Below it, band 5's 44 pt target cannot be met and the game is not guaranteed
([AC-409](acceptance-criteria.md)).*

**Both floors are now tight, and that is the price of the finer grid.** The old layout cleared 44 pt
by 2.00 pt and 20 pt by 1.00 pt at their worst; this one clears them by 0.16 pt and 0.24 pt. A sixth
column at band 5 and a 66 LU car are as far as this design rectangle goes. **Any future change that
adds a column, shrinks a car, or raises `HIT_R_MIN` has to move `DESIGN_W`, and that rescales every
width-bound device** — which is most of them.

---
## 5. Colour

### 5.1 The car palette

Five colours. They are the match key. They are used for nothing else.

| # | Name | Hex | L\* | C\* | Glyph | Bands |
|---|---|---|---|---|---|---|
| 0 | **Ember** | `#FF852A` | 68.2 | 77 | ● circle | 1–5 |
| 1 | **Sky** | `#89D9FF` | 83.0 | 30 | ▲ triangle, apex up | 1–5 |
| 2 | **Rose** | `#FF5386` | 60.9 | 69 | ■ square | 1–5 |
| 3 | **Teal** | `#22C6AF` | 72.1 | 45 | ✚ plus | 3–5 |
| 4 | **Iris** | `#A879FF` | 61.0 | 76 | ═ double bar | 5 |

A band with `K` colours uses entries `0 … K-1`. `K` is 3 at bands 1–2, 4 at bands 3–4, 5 at
band 5 ([`generation.md` §6.1](generation.md#61-the-table)).

**Why these five.** They were selected by constrained optimisation, not by eye: hue windows fixed
to keep the set aesthetically coherent, chroma floors to keep them reading as colours rather than
pastels, and the objective was to maximise the minimum CIEDE2000 distance across the set under
normal vision *and* under simulated protanopia and deuteranopia, with tritanopia and
road-contrast as constraints. The starting point was an Okabe-Ito-style hand-picked set; the
optimiser improved the worst deuteranopic pair from ΔE 10.1 to **17.0**.

### 5.2 Measured separation

Contrast ratios against the road surface `#2B323C` and the background `#0B0E13`:

| Colour | vs road | vs background | `--ink` glyph on it |
|---|---|---|---|
| Ember | 5.32 : 1 | 7.95 : 1 | 7.95 : 1 |
| Sky | 8.27 : 1 | 12.36 : 1 | 12.36 : 1 |
| Rose | 4.21 : 1 | 6.29 : 1 | 6.29 : 1 |
| Teal | 6.01 : 1 | 8.99 : 1 | 8.99 : 1 |
| Iris | 4.21 : 1 | 6.30 : 1 | 6.30 : 1 |

Every car colour clears **4.2 : 1 against the road**, well above the 3.0 : 1 floor for graphical
objects, and `--ink` clears 4.5 : 1 on every car colour so the glyph is always legible.

Minimum pairwise CIEDE2000 within the colour set actually used, by band and by vision type
(Machado 2009 severity-1.0 simulation):

| Set | Normal | Protanopia | Deuteranopia | Tritanopia |
|---|---|---|---|---|
| K = 3 (Ember, Sky, Rose) | 34.1 | 27.8 | 18.2 | 8.2 |
| K = 4 (+ Teal) | 24.1 | 22.3 | 17.0 | 8.2 |
| K = 5 (+ Iris) | 24.1 | 22.2 | 17.0 | 8.2 |

**Honest reading of that table.** Protanopia and deuteranopia — which together account for
roughly 8 % of men — are handled by colour alone at ΔE ≥ 17, which is a clear distinction.
Tritanopia (roughly 1 in 30,000) collapses two pairs: Ember/Rose and Sky/Teal both fall to
ΔE 8.2. Those two pairs are exactly what the glyph carries, and the glyphs assigned to them are
the most shape-distinct in the set: **circle vs square**, and **triangle vs plus**. That pairing
is deliberate, not incidental ([AC-601](acceptance-criteria.md)).

### 5.3 Surface and chrome palette

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0B0E13` | Screen background, behind and around the road network |
| `--surface` | `#151A22` | Overlay panels, HUD pills |
| `--surface-raised` | `#1F2630` | Buttons, level-select tiles |
| `--road` | `#2B323C` | Road surface fill |
| `--road-edge` | `#434C59` | Road casing stroke |
| `--road-dash` | `#5A6472` | Lane dashes, drawn at 40 % opacity |
| `--depot` | `#1B222C` | Depot body fill (the colour lives in its face band and glyph) |
| `--ink` | `#0B0E13` | Glyphs drawn on car bodies and depot faces |
| `--text` | `#E8ECF2` | Primary text — 14.73 : 1 on `--surface` |
| `--text-dim` | `#96A0B0` | Secondary text — 6.61 : 1 on `--surface` |
| `--text-mute` | `#6B7688` | Disabled — 3.80 : 1 on `--surface` |
| `--alert` | `#FF2D55` | Life lost, last-life border, failure. Nothing else. |
| `--ok` | `#E8ECF2` | Delivery pulse — white, so it never competes with a car colour |

`--alert` is the only saturated colour in the chrome, and it is far enough from Rose (`#FF5386`)
in lightness and hue to never be mistaken for a car, particularly because it is only ever drawn
as a screen-edge flash or a border, never as a filled body.

**Light mode is out of scope.** The game is a night road; a light variant would need a different
car palette re-validated for contrast against a pale road, and that is a second palette to keep
correct. The app declares `userInterfaceStyle: "dark"`.

---

## 6. Colour-blind support

### 6.1 Always on, never a rule

Every car carries its colour's glyph. Every depot carries the same glyph on its face. **The
glyph is always drawn** — it is not behind a setting ([`gameplay.md` §8.3](gameplay.md#83-always-on-colour-blind-glyphs--decided)).
A mode only some players see is a mode that is not exercised in development and not caught when
it breaks.

The glyph never changes the rules. It is redundant information, always agreeing with the colour.
A car matches a depot if and only if their colours match, and their glyphs match exactly when
their colours do.

### 6.2 Glyph drawing rules

- Drawn in `--ink` at 78 % opacity on the car, 100 % on the depot face.
- **Counter-rotated to screen-upright.** A car rotates with the road tangent; the glyph does not.
  Without this, "square" and "diamond" would be the same shape, and a triangle would point in a
  different direction on every edge.
- Shapes are chosen for maximum silhouette difference at 14 pt: a filled disc, a filled
  equilateral triangle, a filled square, a plus with arms `0.33 × s` thick, and two horizontal bars
  with a gap equal to the bar height. No two of them share an outline family, and no shape is
  another shape rotated.
  *Round 8 shrank `GLYPH_CAR` 48 → 42 LU with the car, which is **13.4 pt on the binding device** —
  just under the 14 pt this rule is stated at. The car glyph is a secondary cue layered on colour
  and never a rule (§6.1), and the primary cue grew in relative terms because the glyph is now a
  larger fraction of a smaller body; but a player who needs the glyph should be on **Large**, which
  gives 18.6 pt and full opacity. That is why Large raises opacity as well as size, and it is the
  honest reading of what the smaller car cost accessibility ([AC-604](acceptance-criteria.md)).*
- The **Symbol size** setting switches `GLYPH_CAR` 42 → 58 LU and `GLYPH_DEPOT` 52 → 72 LU, and
  raises car-glyph opacity to 100 %.

### 6.3 What is not claimed

The glyph makes the game playable for a player who cannot distinguish the colours at all. It does
not make the game playable with a screen reader — see §11.3.

---

## 7. Components and their states

### 7.1 HUD

56 pt tall, 16 pt side padding, sitting directly below the safe-area top inset. Three groups,
left / centre / right.

```
┌──────────────────────────────────────────────────────────────────┐
│  LEVEL 12        ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░         ● ● ○    ┌────┐  │
│     23                   1:07                            │ ▮▮ │  │
│                                                          └────┘  │
└──────────────────────────────────────────────────────────────────┘
   ↑ label 12/16          ↑ bar 180×8, r4          ↑ 3 pips   ↑ 44×44
   ↑ numeric 20/24 tabular ↑ caption 12/16 tabular
```

- **Level + delivered.** `LEVEL nn` in `--text-dim`, Label style. **The number beneath it is
  `delivered`** — the score ([`gameplay.md` §4.3](gameplay.md#43-the-score-is-the-number-of-cars-delivered))
  — in `--text`, HUD-numeric style, tabular figures so the width does not jitter as it counts up.
  It is one to two digits where the old score was four, which is a small win for a bar that is
  crowded.
- **The clock bar.** 180 × 8 pt, radius 4, track `--surface-raised`, fill `--text`. It **drains**
  left to right as the level runs: fill width is `180 * (LEVEL_TICKS - tick) / LEVEL_TICKS`.
  Caption beneath it is the time remaining as `m:ss`, centred, tabular.
  *This replaces the quota bar, which filled. Draining is the correct direction for a resource
  being spent and it is the opposite of the old bar, so a screenshot from before round 8 is
  immediately distinguishable from one after.*
- **The last ten seconds.** Below `tick >= LEVEL_TICKS - 600` the caption switches to seconds only
  and the bar fill switches to `--alert`, with no pulse and no motion
  ([AC-520](acceptance-criteria.md)). It is the one piece of chrome that changes colour on a timer,
  and it is a state change rather than decoration: the player's routing decisions in the last ten
  seconds are worth nothing for any car that cannot reach a depot, and knowing that is worth
  telling them.
- **Lives.** Three 10 pt pips, 8 pt apart. Filled `--text` when held, outlined `--text-mute` when
  lost. Never colour-coded — a colour-only life counter would be the one place in the game where
  colour carries meaning without a glyph.
- **Pause.** 44 × 44 pt target, 16 pt glyph, `--text-dim`, 8 pt from the right edge.

**The clock is drawn from `state.tick`, never from wall time** — the bar and the caption are pure
functions of the tick, so a paused game shows a frozen clock and a replay shows the same clock the
run did ([`gameplay.md` §6.1](gameplay.md#61-pause), [AC-505](acceptance-criteria.md)). A
`setInterval` counting seconds would drift from the simulation on any device that drops frames,
and would show 0:00 while cars were still moving.

### 7.2 Road

Casing, surface and dashes as in §4.2. The road is uniform everywhere; a branch is marked by the
junction marker, not by a change in road treatment, so the player's eye is not pulled to
decoration.

**Lane dashes follow the filleted centreline**, so a dash never lands on a corner as a wedge. The
dash pattern restarts at the start of every edge, which means the phase is a property of the edge
and not of the whole path — a car's position is never inferable from where the dashes happen to be.

### 7.3 Junction

```
   branch {c, c+1}          branch {c-1, c}         branch {c-1, c+1}
   open = 0 (down)          open = 1 (down)          open = 0 (left)

         │                        │                        │
         ◆━━━━━╮                ╭━◆                   ◄━━━━◆      ╮
         ┃     ╎                ╎ ┃                        ╎      │ closed
         ▼     ╎                ╎ ▼                        ╎      ╯ branch,
                                                                    dim
   blade points DOWN        blade points DOWN         blade points LEFT
   closed branch RIGHT      closed branch LEFT        closed branch RIGHT
   separation 90°           separation 90°            separation 180°
```

- **Marker.** A `JUNCTION_MARK_R = 34` LU disc in `--surface-raised` with a 4 LU `--road-edge`
  ring, and a **blade**: a rounded bar `BLADE_LEN = 30` LU long and `BLADE_W = 9` LU thick,
  radius `BLADE_W / 2`, drawn from the node centre outward along the open branch, in `--text` at
  92 %. The blade is the state: where it points is where the next car goes. *Both numbers are
  proportions of the marker. 30 LU from the centre of a 34 LU disc keeps the whole blade on the
  marker and leaves 4 LU of disc face between the blade's tip and the inside of the ring. 9 LU is
  a 3.3 : 1 bar — 9.6 × 2.9 pt at the smallest supported scale — which is the thinnest bar whose
  direction is still readable at that size.*
- **The blade points along the first segment of the open branch, and under orthogonal roads that
  is unambiguous.** A `straight` edge's first segment is vertical (down); a `jogL`'s is horizontal
  (left); a `jogR`'s is horizontal (right). So the blade has exactly three possible headings and
  the two branches of any junction differ by **90° or 180°**.

  > **AC-504's ≥ 30° separation clause is restated as ≥ 90°.** The old threshold was derived from
  > `atan(colW / rowH)` — the angle between a straight branch and a diagonal one under the cubic
  > model — and measured out at `36.87 / 39.09 / 40.91 / 44.27°` for straight-against-diagonal and
  > `73.74 / 78.19 / 81.83 / 88.55°` for diagonal-against-diagonal, so 30° was a real threshold
  > with a few degrees of room. Orthogonal branches leave the node at right angles by construction:
  > a branch is `{c, c±1}` (one vertical, one horizontal → **90°**) or `{c-1, c+1}` (two opposed
  > horizontals → **180°**). There are no other cases, the separation is exact rather than
  > measured, and **the floor is 90°** ([AC-504](acceptance-criteria.md)).

  The slice-2 defect this clause exists for is **gone by construction, not by discipline.** Under
  the cubic model every edge left its node vertically, so a tangent-derived blade drew the
  identical vertical bar for both branches and the junction silently stopped showing its state; it
  shipped, and it was caught by looking at a screenshot rather than by a test. A tangent-derived
  blade is now *correct*, because the tangent at the node **is** the first segment's direction. The
  AC keeps its second clause anyway, because "the two blades differ by at least 90°" is a cheap
  check that also catches a blade drawn along the wrong branch.
- **Open branch.** The first 120 LU of the open outgoing edge is overdrawn in `--road` lightened
  16 %, so the open road reads brighter than the closed one even without looking at the blade. The
  overdraw is stroked at `ROAD_W` with **butt caps at both ends**, and follows the edge's polyline
  and fillet if the 120 LU reaches round the corner. *Round caps are wrong here: the cap radius on
  an 84 LU stroke is 42 LU, so a round cap at the near end puts a 42 LU lobe of brightened road
  **above** the junction node, on the incoming road, which reads as the branch being open
  backwards. The near butt end is invisible anyway — it sits under the 34 LU marker disc, which is
  painted after it.* The far end is not hidden by anything, so **the overdraw's alpha ramps
  linearly to zero over its final `OPEN_BRANCH_FADE = 28` LU** — the shortest run over which a
  road-width stroke can end without showing an edge.
- **Armed.** When the nearest approaching car is within `COMMIT_PREVIEW = 200 LU`, a 3 LU bar in
  `--text` at 60 % traces the open branch for 170 LU. This is the fairness affordance for the
  one-frame render-latency window ([`gameplay.md` §3.3](gameplay.md#33-the-one-honest-caveat-render-latency)).
  It shows what will happen; it does not change what will happen.
- **Pressed.** During the 160 ms after a tap, a ripple ring expands 34 → 62 LU, `--text` from
  50 % to 0 % opacity.

### 7.4 Depot

```
   ┌─────────────┐   ← DEPOT_W 124 × DEPOT_H 128 LU, radius 10
   │▀▀▀▀▀▀▀▀▀▀▀▀▀│   ← 14 LU face band in the depot's colour, full width
   │             │
   │      ●      │   ← GLYPH_DEPOT 52 LU, in --ink, on a colour disc of radius 39
   │             │
   │ ▬▬▬▬▬▬▬▬▬▬▬ │   ← three 5 LU sill bars in the colour at 18 %
   └─────────────┘
```

Body `--depot`, colour carried by the face band, the glyph disc and the sill bars. The road enters
through the top face band, from directly above, always vertically — under orthogonal routing every
terminal edge's last segment is a vertical drop into the depot column
([`generation.md` §2.3](generation.md#23-edges)), so the depot has one mouth in the middle of its
top face and never a road arriving at an angle.

**Glyph disc.** A filled circle centred on the body centre, radius **0.75 × the glyph size** — 39
LU at `GLYPH_DEPOT = 52`, 54 LU at `GLYPH_DEPOT_LARGE = 72` (§11.2) — in the depot's colour, with
the glyph drawn on it in `--ink`. *The ratio is derived, not chosen. The widest glyph in §6.2 is
Rose's filled square, whose corners sit at `(√2 / 2) × s = 0.707 s` from the centre, so any disc
radius below `0.707 × s` would clip it. 0.75 is the next step up that leaves visible margin —
2.2 LU at Standard, 3.1 LU at Large — and the resulting 108 LU disc at Large still clears
`DEPOT_W = 124` by 8 LU a side. Do not take this below 0.72.*

**Sill bars.** Three horizontal rounded bars in the depot's colour at 18 % opacity, each
`DEPOT_HATCH_W = 5` LU tall on an 8 LU pitch, inset 12 LU from each side of the body (100 LU wide
at `DEPOT_W = 124`), with the lowest bar's bottom edge 6 LU above the body's bottom edge. They
occupy the bottom 21 LU — 16 % of `DEPOT_H`. The face band is the primary colour carrier; the sill
is redundancy at the bottom of the shape, where the eye ends up after following the road down, and
it must not compete with the band the road actually enters through.

States:

- **Idle** — as drawn.
- **Receiving** (220 ms) — face band brightness +18 %, body scales 1.00 → 1.04 → 1.00.
- **Rejecting** (350 ms) — face band flashes `--alert` for 90 ms, then the whole depot desaturates
  to `--text-mute` and returns over 260 ms.

*The 1.04 receiving scale reaches `y = 1478 + 0.04 × 128 / 2 = 1480.6`, inside `DESIGN_H = 1500`
with 19 LU to spare ([AC-411](acceptance-criteria.md)).*

### 7.5 Car

States: **arriving** (see below), **rolling** (steady), **turning** (§4.3's 90° sweep),
**entering the terrace** (no change to the car at all — the terrace of §7.6 passes over it),
**frozen** (level ended — 45 % opacity, no motion). There is no *delivered* or *misrouted* car
state: by the time either resolves the car is beneath the depot layer, and both outcomes are drawn
by the depot and the terrace (§8.3, §8.4).

**Arriving — the car appears at full opacity in a single frame.** No fade, no scale-up, no
ramp of any kind on the car body itself. On the tick a car spawns it is drawn complete: full
body fill, full glyph, full stroke, at the entry node.

The reason is a rule, not a taste.
[`generation.md` §7.1.5](generation.md#715-the-per-tick-procedure--normative) D3 says the player
looks at a newly appeared car **next** rather than last, and that is one of the two things that
make the first junction decision reachable
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision);
V14 is the other). Attention is captured by an abrupt luminance transient; a gradual onset of the
same magnitude does not capture it. **A fade-in is exactly the manipulation that removes the effect
the player model depends on** — so the drawing would be quietly falsifying the design's own
statement about the player, in the one place a clear rate could not detect it.
([AC-517](acceptance-criteria.md))

**Entry flare.** The onset still needs to be *findable* in peripheral vision without the fade, so
the transient is put somewhere it costs nothing: a ring at the entry node, `--text-mute` at 60 %
alpha, outer radius 28 LU, 5 LU stroke, scaling 0.6 → 1.4 and fading to zero over 180 ms,
`ease-out-quad`, drawn **beneath** the car layer (§4.2, step 6). It carries no colour information —
the car body is the only thing that says which colour arrived — so it never competes with the match
key and it is unaffected by the colour-blind settings of §6.

### 7.6 The depot terrace

**What this solves.** Every generated level, at every band, has at least one depot fed by two or
three terminal edges, and under orthogonal routing those edges **share the same vertical approach
road for the whole of the last row**
([`generation.md` §2.3](generation.md#23-edges),
[`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-shared-approach-road)). The cars
on them took different paths from the entry, so nothing constrains their relative timing. Measured
in the designer's prototype over 800 seeds per band: two cars came within a car length on a shared
approach in **59 to 301 runs per 1,000**, with a minimum centre-to-centre distance of **0 LU** —
a complete overlap. Under the cubic model the same measurement read 0–5 per 1,000. **The owner's
orthogonal-roads direction bought this, and it is the one place in round 8 where the drawing got
harder rather than easier.** The rules are fine; the picture is not, and the fix belongs here.

**The treatment: the road runs under the terrace.** The depot row is given a continuous forecourt —
one rounded rectangle in `--depot` laid over the bottom of every terminal edge — and the car layer
is painted beneath it (§4.2). A car does not fade, pop or shrink; it drives into the building.

```
        col c-1        col c         col c+1
           │             │             │
           │             │             │           ← ordinary road, cars drawn on top
           ╰─────────────┤             │           ← a jog merging into the depot's approach
                         │             │
      ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄       ← TERRACE_FADE: alpha 0 → 100 %
      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓       ← terrace, --depot, opaque
      ▓▓▓┌────┐▓▓▓▓▓┌────┐▓▓▓▓▓┌────┐▓▓▓▓▓▓▓       ← cars are UNDER all of this
      ▓▓▓│ ●  │▓▓▓▓▓│ ▲  │▓▓▓▓▓│ ■  │▓▓▓▓▓▓▓
         └────┘     └────┘     └────┘
```

**Geometry.**

```
mouthLu(band) = rowH - JUNCTION_MARK_R - 12          // 170 / 170 / 134 / 134 / 134
terraceTop    = DEPOT_Y - mouthLu
terraceRect   = x from (x(0) - DEPOT_W/2 - 12) to (x(C-1) + DEPOT_W/2 + 12)
                y from terraceTop to DEPOT_Y + DEPOT_H
TERRACE_FADE  = 28                                   // LU of alpha ramp at the top edge
```

| Band | `rowH` | **`mouthLu`** | shared approach visible above the terrace | a car is hidden for |
|---|---|---|---|---|
| 1 | 216 | **170** | 46 LU | 1.03 s |
| 2 | 216 | **170** | 46 LU | 0.98 s |
| 3 | 180 | **134** | 46 LU | 0.73 s |
| 4 | 180 | **134** | 46 LU | 0.70 s |
| 5 | 180 | **134** | 46 LU | 0.67 s |

`mouthLu` is its **maximum legal value**, not a taste value: the constraint is
`mouthLu <= rowH - JUNCTION_MARK_R - 12` so the terrace never reaches the junction marker at the
top of a terminal edge, and it is taken at equality at every band. The 12 LU is the clear gap
between the marker's bottom edge and the terrace's top edge.
([AC-514](acceptance-criteria.md))

**One rectangle, not `K` aprons, and that is a simplification worth stating.** The old treatment
stroked a per-edge apron along each terminal edge, which required a `saveLayer` so overlapping fade
segments did not stack alpha into a visible lens ([AC-516](acceptance-criteria.md)), a per-band
`MOUTH_W` derived from the car's diagonal, and a measured worst-case residual overlap. Under
orthogonal routing every terminal edge ends in a vertical drop at a depot column, so the region to
cover is a single horizontal band across the depot row. One rounded rect with one gradient along
its top edge covers it, cannot stack alpha with itself, and is built once per level.
[AC-516](acceptance-criteria.md) becomes trivially satisfied rather than carefully satisfied.

**What it guarantees and what it does not.** It guarantees that the entire shared approach except
its top 46 LU is hidden. It does **not** guarantee that two cars are never seen overlapping: two
cars whose centres are both inside that 46 LU window overlap, and each of them is then more than
half under the terrace. **A full geometric guarantee is not available and is not claimed** — it
would require the terrace to swallow the junction markers at the top of the terminal row, which
would hide a tap target. [AC-513](acceptance-criteria.md) is written to **report the measured rate**
as well as bound the geometry, because at 59–301 runs per 1,000 this is a thing a player will see
and a number that deserves a screenshot rather than only a pass.

**What the player loses, and what replaces it.** A car disappears `mouthLu / speed` before it
resolves — 0.67 s at band 5, 1.03 s at band 1, *less* than the 0.61–1.00 s the old apron hid. It
loses nothing it could act on: a car on a terminal edge is past its last junction and no tap can
change its fate. What it would lose is the *confirmation*, and that moves to the mouth: see §8.3
and §8.4.

---

## 8. Screen states

### 8.1 Idle / rolling
The steady state. The only motion is car translation, cars turning corners, the clock bar draining
and the arming of junctions.

### 8.2 Junction flipped
Blade rotates to the new branch, 120 ms, `ease-out-cubic` — a 90° or 180° sweep. Open-branch
brightening cross-fades over the same 120 ms. Ripple ring, 160 ms. Light haptic.
**Communicates:** your tap landed, and this is where the next car goes.

### 8.3 Car delivered
The car is already beneath the terrace (§7.6), so the confirmation is carried by the mouth and the
depot. A **mouth glow** — the last `mouthLu` of `level.edges[event.edgeId]`, redrawn on top of the
terrace in the car's colour at 55 % alpha ([AC-140](acceptance-criteria.md)) — fades in over 90 ms
and out over 130 ms, `ease-out-cubic`. Depot plays **receiving**. The delivered count in the HUD
increments. **Communicates:** that one is banked, which colour it was, and which road it came down.

**One mouth, not the depot's mouths.** A depot is fed by up to three terminal edges and they share
their final approach, so the glow is drawn on the arriving edge's own geometry — which, where the
approach is shared, *is* the shared segment plus whichever horizontal run the car came in on.
([AC-519](acceptance-criteria.md))

### 8.4 Car misrouted
The shatter originates at the **terrace line** of `level.edges[event.edgeId]` — the point at which
the car went under, on the edge named on the event
([`gameplay.md` §2.6](gameplay.md#26-resolvearrival--the-single-place-scoring-happens),
[AC-140](acceptance-criteria.md)) — which is the last point at which the car was visible. Not the
depot node: throwing from the node would show the wrong colour appearing from *under* the depot
instead of arriving *at* it. Six 20 LU fragments in the car's colour scatter 45–85 LU, biased
upward and outward along the edge direction, and fade over 320 ms, `ease-out-quad`. Fragments are
transient effects (draw order step 11) and are therefore drawn **over** the terrace and the depot;
this is the one thing that is. Depot plays **rejecting**. A 3 pt `--alert` screen-edge vignette
flashes to 30 % and back over 180 ms. One life pip drains over 240 ms. Error haptic.
**Communicates:** a life is gone and this depot was the wrong one — the colour of the fragments and
the depot desaturating together name the mistake. ([AC-515](acceptance-criteria.md))

### 8.5 Last life
When `lives === 1`, the life-pip row takes a 1.6 s `ease-in-out-sine` opacity pulse between 1.00
and 0.65, and a 2 pt `--alert` border at 24 % sits steady inside the screen edge. Both persist
until the level ends. **Communicates:** sustained jeopardy, without a startle that would cost the
player the car they are currently tracking.

*If the last ten seconds (§7.1) and the last life coincide, the clock caption and the border are
both `--alert` and neither moves. That is deliberate: two alert states at once should read as one
situation, not as two competing animations.*

### 8.6 Level complete

Shown when `phase === 'ended'` — the clock ran out with at least one life left. **That is what
clearing a level is** ([`gameplay.md` §7](gameplay.md#7-progression-slice-4-territory-specified-here-so-it-is-not-invented-later)).

```
┌──────────────────────────────────────────┐
│                                          │
│              TIME — LEVEL 12             │   Title 24/30, --text
│  ────────────────────────────────────    │
│   Best streak                       14   │   Body 16/22, --text-dim / --text
│   Misrouted                          2   │
│   Lives remaining                    1   │
│  ────────────────────────────────────    │
│   DELIVERED                         43   │   Display 34/40, --text
│   Best                              47   │   Caption 12/16, --text-dim
│                                          │
│   ┌─────────────┐   ┌─────────────────┐  │
│   │    RETRY    │   │     NEXT  ▸     │  │   48 pt tall, 12 pt gap
│   └─────────────┘   └─────────────────┘  │
└──────────────────────────────────────────┘
```

Play surface dims to 40 % over 240 ms, with cars frozen in place at 45 % opacity. Panel rises 24 pt
and fades in over 280 ms, `ease-out-back(1.08)`. Panel `--surface`, radius 20, 24 pt padding, max
width 340 pt, centred.

**The title is `TIME`, not `LEVEL CLEAR`**, because what happened is that the two minutes ran out.
The distinction matters on the one screen where the player learns what the game wants from them:
they did not complete a job, they survived a shift.

### 8.7 Level failed

Same panel geometry. Title `OUT OF LIVES`, rows `Delivered 19`, `Best streak 6`, `Time survived
1:12`, buttons `RETRY` and `LEVELS`. Play surface desaturates to greyscale over 320 ms rather than
dimming — the colours going out is the point, since colour is what the level was about.

**`Time survived` is on this panel and not on §8.6's**, because it is the only place it carries
information: a cleared run survived 2:00 by definition.

### 8.8 Pause and resume countdown

Pause overlay: play surface dims to 40 %, panel with `RESUME` / `RESTART` / `QUIT`. Resume
countdown: three 600 ms beats, numeral at Display size, `--text`, scaling 1.3 → 1.0 and fading
out each beat. **No simulation ticks advance during either, so the level clock does not move**
([`gameplay.md` §6](gameplay.md#6-run-control)) — the clock bar is frozen at whatever it showed,
which is the visible proof that pausing costs nothing.

---

## 9. Motion spec

| Event | Duration | Easing | What it communicates |
|---|---|---|---|
| Car arrival | 1 frame | none | A new car exists — an abrupt onset, because §7.5's capture claim depends on it |
| Entry flare | 180 ms | `ease-out-quad` | Where the new car arrived, findable peripherally, carrying no colour |
| Car turning a corner | `2·CORNER_R / speed` | linear in arc length | This car has taken a branch |
| Junction blade rotate | 120 ms | `ease-out-cubic` | The tap landed |
| Junction tap ripple | 160 ms | `ease-out-quad` | The tap was received at *this* junction |
| Junction arm (lead bar) | 180 ms fade in | `ease-out-cubic` | This car is committing to this branch |
| Mouth glow | 90 ms in + 130 ms out | `ease-out-cubic` | Banked — and in which colour |
| Depot receiving pulse | 220 ms | `ease-out-cubic` | This depot accepted it |
| Car misrouted shatter | 320 ms | `ease-out-quad` | Lost — thrown from the terrace line, in the car's colour |
| Depot rejecting flash | 90 ms + 260 ms | `linear`, `ease-out-cubic` | Wrong depot — and which one |
| Life pip drain | 240 ms | `ease-out-cubic` | A life is gone |
| Edge vignette flash | 180 ms | `ease-out-quad` | Something bad, peripherally |
| Last-life pulse | 1600 ms loop | `ease-in-out-sine` | Sustained jeopardy |
| Clock bar drain | continuous | linear in `tick` | Time remaining |
| Final-ten colour change | instant | none | The remaining time is shorter than a journey |
| Delivered count increment | 180 ms | `ease-out-cubic` | One more |
| Play surface dim | 240 ms | `ease-out-cubic` | The level is over |
| Failure desaturate | 320 ms | `ease-out-cubic` | The colours went out |
| Overlay panel rise | 280 ms | `ease-out-back(1.08)` | A decision is wanted |
| Countdown beat | 600 ms × 3 | `ease-out-cubic` | Get ready |

**The determinism rule for motion.** Anything drawn **inside the Skia play surface** derives its
animation phase from `(currentTick - eventTick) / TICK_HZ`, taking `eventTick` from
`state.events` ([`gameplay.md` §2.9](gameplay.md#29-events-are-render-hints-and-only-that)). A
replay therefore paints identically, frame for frame, to the live run
([AC-505](acceptance-criteria.md)). **The clock bar is in this class even though it lives in the
HUD**: it is a pure function of `state.tick` and it must be, or a paused or replayed game shows the
wrong time.

Other UI chrome outside the canvas — overlay panels, the resume countdown, the life pips, the
delivered increment — may use **wall-clock** time, because it is not part of the replayable world.
That means `requestAnimationFrame` driving React state, with the easing curves taken from the same
module the canvas uses so that a 280 ms `ease-out-cubic` is one function in this codebase and not
two. React Native's `Animated` with `useNativeDriver: true` is permitted where a transition is pure
opacity or transform.

**`react-native-reanimated` is not used and slice 3 does not adopt it — decided.** It has been in
`package.json` since slice 0 with a Babel plugin and a comment claiming it drives the render loop's
clock. Nothing imports it and the comment is false. **Everything in the canvas is forbidden from
using it** — a wall-clock animation inside the play surface breaks AC-505 by construction. What is
left outside the canvas is six one-shot transitions of opacity, transform or width on a handful of
views, plus one looping opacity pulse. None is gesture-driven — the only gesture in the game is a
tap (§10.3) — which is the case Reanimated exists for. **Remove the dependency, the
`react-native-reanimated/plugin` entry in `babel.config.js`, and the comment.**
`react-native-gesture-handler` soft-requires Reanimated and continues without it.

**Nothing in the play surface loops or idles.** There is no ambient shimmer, no drifting
background, no pulsing junction waiting to be tapped. If it moves, something happened — and the
clock bar draining is the one continuous motion in the game, which is why it is chrome and not
board.

---

## 10. Input

### 10.1 Hit testing

```
lx = round( (touchX - originX) / scale )
ly = round( (touchY - originY) / scale )
hit = the junction j minimising (lx - j.x)² + (ly - j.y)², if that distance ≤ HIT_R_LU
```

Since hit circles never overlap (§4.4), the nearest-within-radius test has a unique answer.
A tap that hits no junction is ignored silently — there is no "missed" feedback, because a miss
is not an error and flashing at the player for touching the road would train them to avoid it.

### 10.2 Input timing

A hit enqueues `{ tick: nextTickToSimulate, junctionId }`. The React layer hands the queue to
`step()` on the next tick. Maximum input latency introduced by the model is therefore **one
tick, 16.7 ms**.

### 10.3 Gestures

- `Gesture.Tap()` from `react-native-gesture-handler`, over the canvas, `maxDuration` 400 ms,
  `maxDistance` 16 pt. It is the only gesture registered
  ([AC-312](acceptance-criteria.md)).
- **Offramp is a one-pointer game.** One tap recognised at a time; at most one input enqueued per
  recognised tap.
- **A concurrent second pointer neither moves the tap nor cancels it.** The recognised point is
  the position of the gesture's **first** pointer, captured when the gesture begins; additional
  pointers that land before it ends are ignored. This is normative and it is not the default: RNGH
  tracks the **centroid** of all live pointers, so a second finger anywhere on the canvas drags the
  reported point toward it, and two fingers on two junctions report a single tap at the midpoint —
  which usually hits neither, and occasionally hits a third junction. Ignoring the extra pointer is
  the only behaviour that is never wrong. ([AC-313](acceptance-criteria.md))
- No drag, no swipe, no long-press, no double-tap. Every gesture the game understands is a tap.
- Taps are discarded while paused, during the resume countdown, and after `phase` leaves
  `'running'`.

**Why one pointer — decided.** Three grounds, unchanged by round 8 and one of them strengthened:

1. **The difficulty model is one-fingered by construction, and every number in this design is read
   off it.** [`generation.md` §7.1.3](generation.md#713-constants) sets
   `BOT_MAX_TAPS_PER_TICK = 1` and `BOT_MIN_TAP_GAP = 11` ticks — one thumb, 180 ms between taps —
   and §7.2's five clear rates, R2, R3 and [AC-233](acceptance-criteria.md)'s tap-rate ceiling are
   all measured against that bot. A player able to flip two junctions in one frame has a capability
   the ladder has never priced, in a game whose entire dynamic range is **3.21 percentage points of
   per-car error**
   ([`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)).
2. **The game never asks for it, and that is a theorem rather than a hope.**
   [`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time) proves a 1.50 s
   floor between two cars at one junction and §4.6b a 1.50 s first-decision floor; §4.7 proves every
   car routable; the estimated tap demand peaks at **0.79 /s** against a 1.25 /s ceiling. There is
   no reachable board state that one finger cannot serve in time. *Round 8 raised both floors —
   from 1.00 s and 0.72 s — so this argument is stronger than it was.*
3. **It is an affordance for a grip the game is not designed for.** §3 designs for a 6.1" phone
   held in one hand, and the cost of assuming a second thumb is a hand-rolled `Manual` gesture
   reimplementing `maxDuration`, `maxDistance` and cancellation — the one piece of input code in
   the app that no tier below a device test can exercise.

**What is not given up.** Two inputs resolving on one tick stays exactly as
[`gameplay.md` §3.5](gameplay.md#35-two-taps-in-the-same-tick) specifies, because it is reachable
with one finger: any two taps arriving between consecutive `step()` calls share a tick stamp, and
that window is 33 ms at 30 fps and longer under catch-up.
[AC-306](acceptance-criteria.md) states that as a property of the input **queue**, which is both
what the engine actually guarantees and something a test can reach.

---
## 11. Accessibility

### 11.1 Targets and contrast

- Junctions: ≥ 44 pt across every supported viewport, proven by sweep (§4.4).
- Pause, and every overlay button: ≥ 44 × 44 pt, with ≥ 8 pt between adjacent targets.
- All text ≥ 4.5 : 1 against its surface (§5.3). `--text-mute` at 3.80 : 1 is used only for
  disabled and decorative states, never for information.
- Car colours ≥ 4.2 : 1 against the road (§5.2), **and ≥ 4.9 : 1 after the windscreen tint is
  composited over them** (§4.3) — the tint covers about a fifth of the body, so the floor has to be
  checked on the composite and not only on the palette entry
  ([AC-606](acceptance-criteria.md)).

### 11.2 Settings

| Setting | Options | Default | Effect |
|---|---|---|---|
| Symbol size | Standard / Large | **Standard** | `GLYPH_CAR` 42→58 LU, `GLYPH_DEPOT` 52→72 LU, car-glyph opacity 78 %→100 % |
| Reduce motion | Off / On | follows `AccessibilityInfo.isReduceMotionEnabled` | Shatter → 120 ms fade; vignette flash → static 180 ms tint; panel spring → 120 ms fade; last-life pulse → static border; count-up → instant |
| Haptics | On / Off | **On** ([`gameplay.md` §8.5](gameplay.md#85-owner-recommendation--not-a-blocker-haptics-default)) | Light impact on flip, error notification on misroute, success on level clear |
| Sound | On / Off | On | Slice 5 |

**Reduce motion never removes information.** Every effect it changes has a static replacement
that says the same thing; a misroute still desaturates its depot and still drains a pip.

### 11.3 Screen readers — what is and is not supported

Stated plainly rather than implied:

- **Menus, overlays and settings are fully labelled** and operable with VoiceOver and TalkBack.
  Every button has an `accessibilityLabel` and an `accessibilityRole`.
- **The play surface is not.** It is one Skia canvas with no child views, and the game is
  real-time with a one-second decision window. A screen reader cannot announce four moving cars
  and eight junctions fast enough for the announcement to still be true. The canvas is exposed as
  a single element labelled with a live summary — *"Level 12. 23 of 36 delivered. 2 lives."* —
  updated on delivery, misroute and level end, so a player using a reader always knows where they
  stand, but the routing itself is not screen-reader playable.
- This is a limit of the design, not an oversight, and it is not papered over with labels that
  would be stale by the time they finished being read. ([AC-607](acceptance-criteria.md))

### 11.4 Safe areas

`react-native-safe-area-context` insets on all four edges. The HUD sits below the top inset; the
play area ends `8 pt` above the bottom inset. No interactive element is within 16 pt of the bottom
inset, so nothing competes with the home indicator. In landscape the game locks to portrait
(`app.json` `orientation: "portrait"`); there is no landscape layout.

---

## 12. Typography and spacing

| Style | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|
| Display | 34 / 40 | 700 | −0.4 | Final score, countdown numeral |
| Title | 24 / 30 | 700 | −0.2 | Overlay titles, screen titles |
| HUD numeric | 20 / 24 | 600 | 0 (tabular) | Live score |
| Body | 16 / 22 | 400 | 0 | Overlay rows, settings |
| Button | 16 / 20 | 600 | +0.4 | Button labels, uppercase |
| Label | 13 / 16 | 600 | +0.6 | `LEVEL nn`, uppercase |
| Caption | 12 / 16 | 500 | +0.2 | `23 / 36`, `Best` |

System font (SF Pro on iOS, Roboto on Android). No bundled webfont — a font file is a download,
a licence and a layout risk for zero gain in a game with under 200 words of copy.

Spacing scale: **4, 8, 12, 16, 24, 32, 48**. Nothing uses a value off this scale.
Radii: 4 (bar), 8 (pill), 12 (depot), 16 (button), 20 (panel).
