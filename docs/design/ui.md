# Offramp — UI, Visual System and Motion

Slice-0 design. Screen inventory, layout arithmetic with real dimensions, the palette with hex
codes and measured contrast, every component state, the motion spec, and accessibility.

Companion documents: [`gameplay.md`](gameplay.md), [`generation.md`](generation.md),
[`acceptance-criteria.md`](acceptance-criteria.md).

Two units appear throughout and are never interchangeable:

- **pt** — React Native logical points. All UI chrome is specified in pt.
- **LU** — layout units, the engine's device-independent design space
  ([`generation.md` §3.1](generation.md#31-design-space)). Everything inside the Skia canvas is
  specified in LU and scaled once, at the canvas boundary.

---

## 1. Identity

Offramp is a **night road**, seen from directly above. Dark asphalt, bright painted lane edges,
saturated vehicle paint. It is not a toy, not a train set and not a children's illustration:
there is no wood grain, no rounded cartoon bevel, no cheerful sky. The reference points are
motorway signage and a traffic-control screen — flat, high-contrast, legible at a glance and at
arm's length.

Three rules carry the identity:

1. **The road network is the screen.** Chrome is a thin bar at the top; everything else is road.
2. **Nothing decorative moves.** Every animation in the play surface reports a state change. If
   it moves, it means something.
3. **Colour is reserved.** The five car colours belong to cars and depots and appear nowhere
   else. Chrome is greyscale plus one alert red.

---

## 2. Screen inventory

| # | Screen | Purpose |
|---|---|---|
| S1 | **Title** | Name, Play, Levels, Settings |
| S2 | **Level select** | Grid of unlocked levels with best score |
| S3 | **Play** | HUD + Skia play surface. The game. |
| S4 | **Pause** overlay | Resume, Restart, Quit |
| S5 | **Level complete** overlay | Score breakdown, Retry, Next |
| S6 | **Level failed** overlay | Progress reached, Retry, Levels |
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
│ │ LEVEL 12 │   │ ████████████░░░░░░░░░░ │   │ ● ● ○ │  │ ▮▮ │        │  │ 56
│ │  4,820   │   │        23 / 36         │   │       │  │    │        │  │
│ └──────────┘   └────────────────────────┘   └───────┘  └────┘        │  ▼
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │  ▲
│                         (vertical slack, 55 %)                       │  │
│  · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·   │  │
│                             ENTRY                                    │  │
│                               ┃                                      │  │
│                             ╭─◆─╮                                    │  │
│                            ╱     ╲                                   │  │ play
│                          ◆         ◆                                 │  │ area
│                         ╱ ╲       ╱ ╲                                │  │ 695
│                       ┃    ┃    ┃    ┃                               │  │
│                       ┃    ┃    ┃    ┃                               │  │
│                    ┌─────┐┌─────┐┌─────┐┌─────┐                      │  │
│                    │  ●  ││  ▲  ││  ■  ││  ✚  │      ← depots        │  │
│                    └─────┘└─────┘└─────┘└─────┘                      │  │
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
scale   = min(playW / 1000, playH / 1600)
slackX  = playW - 1000 * scale
slackY  = playH - 1600 * scale
originX = slackX / 2
originY = playTop + slackY * 0.55
```

The horizontal slack is centred. The **vertical slack is split 55 % above / 45 % below**, which
biases the whole network a few points downward toward the thumb without crowding the home
indicator. On a 21:9 Android with 245 pt of slack that is 135 pt above and 110 pt below.

`screen = origin + design * scale`, and the inverse is used for hit testing (§10.1).

### 3.3 Measured fit across real devices

| Device | W × H | insets | `scale` | play H | vertical slack | junction target | car body |
|---|---|---|---|---|---|---|---|
| iPhone SE (1st) | 320 × 568 | 20 / 0 | 0.3025 | 484 | 0 | **46.0 pt** | 25.4 × 42.4 |
| iPhone SE (2nd/3rd) | 375 × 667 | 20 / 0 | 0.3644 | 583 | 0 | 55.4 pt | 30.6 × 51.0 |
| iPhone 13 mini | 375 × 812 | 50 / 34 | 0.3750 | 664 | 64 | 57.0 pt | 31.5 × 52.5 |
| iPhone 13/14 | 390 × 844 | 47 / 34 | 0.3900 | 699 | 75 | 59.3 pt | 32.8 × 54.6 |
| **iPhone 15/16** | 393 × 852 | 59 / 34 | 0.3930 | 695 | 66 | 59.7 pt | 33.0 × 55.0 |
| iPhone 16 Pro Max | 440 × 956 | 62 / 34 | 0.4400 | 796 | 92 | 66.9 pt | 37.0 × 61.6 |
| Galaxy S23 | 360 × 780 | 24 / 24 | 0.3600 | 668 | 92 | 54.7 pt | 30.2 × 50.4 |
| Pixel 7 | 412 × 915 | 24 / 24 | 0.4120 | 803 | 144 | 62.6 pt | 34.6 × 57.7 |
| Tall Android 21:9 | 412 × 1024 | 32 / 24 | 0.4120 | 904 | 245 | 62.6 pt | 34.6 × 57.7 |

The binding device is the **iPhone SE 1st generation at 320 × 568**. Everything in §4 is sized so
that device passes.

**Re-checked after slice 1b's `ENTRY_LEN` change, and nothing in this table moves.** `ROW0_Y` and
`DEPOT_Y` each went down 60 LU while the route height stayed at 1200
([`generation.md` §3.2](generation.md#32-site-coordinates)), so `DESIGN_W`, `DESIGN_H`, `colW`,
`rowH` and therefore `scale`, `slackY`, the junction target and the car body are all the numbers
already printed above. What changed is where the content sits **inside** the design rectangle: it
now spans `y = 60 … 1590` instead of `60 … 1530`, so the clearance below the depot body falls from
70 LU to 10.

| Device | `scale` | depot bottom, LU | clearance to `DESIGN_H`, pt | plus slack below + gutter | total below the depot |
|---|---|---|---|---|---|
| iPhone SE (1st) | 0.3025 | 1590 | 3.0 | 0.0 + 8 | **11.0 pt** |
| iPhone 15/16 | 0.3930 | 1590 | 3.9 | 29.7 + 8 | 41.6 pt |
| Tall Android 21:9 | 0.4120 | 1590 | 4.1 | 110.3 + 8 | 122.4 pt |

The binding case is again the SE 1st generation, at 11.0 pt of clear space between the depot body
and the bottom of the screen — it has no home indicator and a zero bottom inset, which is why it
is the one device where the design rectangle is height-bound with no slack at all. The depot's
1.04 **receiving** scale (§7.4) reaches `y = 1593.4`, still inside the rectangle. A future change
that pushes `DEPOT_Y + DEPOT_H` past 1600 is a layout change, not a geometry tweak, and belongs
back in this table. ([AC-411](acceptance-criteria.md))

---

## 4. The play surface

### 4.1 Geometry constants (LU)

| Constant | Value | At SE scale 0.3025 | At iPhone 16 scale 0.393 |
|---|---|---|---|
| `ROAD_W` | 104 | 31.5 pt | 40.9 pt |
| `ROAD_EDGE_W` | 4 | 1.2 pt | 1.6 pt |
| `CAR_L` | 140 | 42.4 pt | 55.0 pt |
| `CAR_W` | 84 | 25.4 pt | 33.0 pt |
| `CAR_RADIUS` | 16 | — | — |
| `GLYPH_CAR` | 48 | 14.5 pt | 18.9 pt |
| `GLYPH_CAR_LARGE` | 66 | 20.0 pt | 25.9 pt |
| `GLYPH_DEPOT` | 64 | 19.4 pt | 25.2 pt |
| `GLYPH_DEPOT_LARGE` | 88 | 26.6 pt | 34.6 pt |
| `JUNCTION_MARK_R` | 46 | 27.8 pt ⌀ | 36.2 pt ⌀ |
| `DEPOT_W` | 160 | 48.4 pt | 62.9 pt |
| `DEPOT_H` | 170 | 51.4 pt | 66.8 pt |
| `COMMIT_PREVIEW` | 260 | — | — |
| `MOUTH_W` | 176 | 53.2 pt | 69.2 pt |
| `MOUTH_FADE` | 36 | 10.9 pt | 14.1 pt |
| `mouthLu` | per band, §7.6 | — | — |

`CAR_W` (84) is narrower than `ROAD_W` (104), leaving a 10 LU shoulder on each side. `DEPOT_W`
(160) is a constant rather than a fraction of `colW`, so the depot never collides with its
neighbour (narrowest case `colW = 195` leaves a 35 LU gap) and never overhangs the design-space
edge (narrowest margin is 30 LU).

### 4.2 Draw order

1. Background fill
2. Road casing — every edge stroked at `ROAD_W + 2*ROAD_EDGE_W` in `--road-edge`
3. Road surface — every edge stroked at `ROAD_W` in `--road`
4. Lane dashes — every edge stroked at 3 LU, dash 20/28, in `--road-dash`
5. Junction markers, and the lead-highlight arc when armed (§7.3)
6. Entry flares (§7.5) — beneath the cars, so a flare never dims the car whose arrival it marks
7. **Car shadows** — every car's shadow, ascending by id, as one layer
8. **Car bodies** — ascending by id, each with body, windscreen and roof glyph
9. **Depot-mouth aprons** (§7.6) — one filled path for the opaque cores, then one `saveLayer`
   for the fade segments
10. Depot bodies and depot glyphs
11. Transient effects sourced from `state.events` (§9)

**Steps 7 and 8 are two passes over the cars, not one, and that is what makes
[AC-501](acceptance-criteria.md) satisfiable.** Through slice 2 this was a single step — "cars,
ascending by id, each with body, roof glyph and shadow" — which draws car *n+1*'s shadow on top of
car *n*'s body. AC-501 forbids exactly that ("a car is never occluded by … another car's shadow"),
so the document contradicted its own acceptance criterion, and per-car ordering was the thing that
produced the violation. Shadows are a ground layer: they all belong under all of the bodies.

Whether this is ever visible is a separate question from whether it is specified, and it is
visible in one place. §4.5 guarantees two cars never overlap *on the same edge*, but
[`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-depot-mouth) is explicit that
the guarantee stops at a depot fed by two or three terminal edges, and every level at every band
has one. A shadow is offset only `(0, 6)` LU, so the overlap is a 6 LU sliver — but it is a
6 LU sliver of `#000000` at 32 % across another car's colour patch, in the one region of the board
where two colours are being told apart under time pressure, and it is under the apron where the
picture is already busy. Two passes cost one extra traversal of a list that is never longer than
about six.

Cars are painted after junction markers, so **a car is never hidden by a junction marker** — that
part is unchanged. Both car passes are painted *before* the depot layer, which is the change
slice 1's measurement forced: a car drives **under** the depot mouth and under the depot body,
which is
what makes two cars converging on one depot impossible to see overlapping (§7.6,
[`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-depot-mouth)). Nothing else
occludes a car.

### 4.3 The car

Top-down, axis-aligned to the road tangent. The body is **one large colour fill**: a rounded
rectangle `CAR_L × CAR_W`, corner radius `CAR_RADIUS`, filled with the car's colour. On top of
it:

- a **windscreen**: a 40 × 60 LU rounded rect (40 across the body, 60 along it), corner radius
  8 LU, in **`--text` `#E8ECF2` at 22 % opacity**, offset 28 LU toward the nose — it reads as a
  car rather than a capsule and costs no colour area;
- the **colour glyph**, `GLYPH_CAR` square, in `--ink`, centred on the body and **counter-rotated
  so it is always upright relative to the screen** (§6.2);
- a **shadow**: the same rounded rect, `#000000` at 32 %, offset `(0, +6)` LU in **screen** space
  — not in the car's frame, because the light is above the screen and a shadow does not rotate
  with the thing casting it — drawn as a layer under *all* bodies, not per car (§4.2, steps 7
  and 8).

No outline, no gradient, no headlights. The colour patch is at minimum 25.4 × 42.4 pt on the
smallest supported device, comfortably above the 20 px legibility floor.

**The windscreen is light, and this is a measurement rather than a preference.** Slice 2 found
that §4.3 named a `--car-glass` token that §5.3's table never defined, and chose `--ink`
(`#0B0E13`) on the argument that a dark pane reads as glass seen from above at night. It does not
survive §5.2's own contrast floor. The windscreen covers about a fifth of the body, and at 22 %
toward `--ink` that patch drops to **2.79 : 1** against the road for Rose and **2.81 : 1** for
Iris, against the ≥ 4.2 : 1 this palette was validated at — so a fifth of the colour patch of two
of the five cars would sit below the floor the whole palette was chosen to clear, on the one
element whose only job is to be identified by colour. At 22 % toward `--text` the same patch reads
`6.13 / 8.74 / 4.99 / 6.71 / 5.24 : 1`, every one above the floor. It also protects the glyph,
which overlaps the windscreen over roughly a quarter of its area: `--ink` glass drops the
glyph-against-its-background ratio inside the overlap to `4.03 / 5.37 / 3.41 / 4.36 / 3.38`, and
`--text` glass raises it to `6.16 / 7.73 / 5.30 / 6.53 / 5.44`. Physically it is also the right
answer — from directly above at night a windscreen shows reflected sky and street light, not a
hole.

**There is no `--car-glass` token.** The windscreen is `--text` at 22 % and §5.3's table is
unchanged. A token whose value would duplicate an existing one, for one use, is a second place the
same hex has to stay right.

### 4.4 Tap-target arithmetic

A junction is a tap target and must be at least 44 × 44 pt. The visible marker is smaller than
the target, which is standard, and the hit radius adapts to the scale:

```
minSep     = min(colW, rowH)                          // per band, 195 LU at worst
HIT_R_LU   = clamp( ceil(22 / scale), 76, floor((minSep - 6) / 2) )
```

`ceil(22 / scale)` is the radius in LU that yields exactly 44 pt. The lower clamp of 76 keeps the
target generous on large screens; the upper clamp keeps hit circles from ever touching, since
`2 * HIT_R_LU < minSep` by construction.

**Hit circles therefore never overlap**, which means "nearest junction within `HIT_R_LU`" and
"the unique junction containing the point" are the same answer, and hit testing has no tie-break
to get wrong.

Verified by arithmetic sweep over widths 320–520 pt × heights 560–1200 pt × 8 safe-area inset
profiles × 5 bands — **2,580,840 configurations, zero violations**: minimum junction target
44.00 pt, minimum car body width 21.00 pt, zero overlapping hit circles
([AC-401](acceptance-criteria.md), [AC-402](acceptance-criteria.md)).

**Declared support floor:** `playW ≥ 320 pt` and `playH ≥ 400 pt`. Below that the 44 pt target
cannot be met at bands 4–5 and the game is not guaranteed.

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
  equilateral triangle, a filled square, a plus with 16 LU-thick arms, and two horizontal bars
  with a gap equal to the bar height. No two of them share an outline family, and no shape is
  another shape rotated.
- The **Symbol size** setting switches `GLYPH_CAR` 48 → 66 LU and `GLYPH_DEPOT` 64 → 88 LU, and
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
│  LEVEL 12        ████████████░░░░░░░░░░         ● ● ○    ┌────┐  │
│   4,820                23 / 36                           │ ▮▮ │  │
│                                                          └────┘  │
└──────────────────────────────────────────────────────────────────┘
   ↑ label 12/16          ↑ bar 180×8, r4          ↑ 3 pips   ↑ 44×44
   ↑ numeric 20/24 tabular ↑ caption 12/16
```

- **Level + score.** `LEVEL nn` in `--text-dim`, Label style. Score in `--text`, HUD-numeric
  style, tabular figures so the width does not jitter as it counts up.
- **Quota bar.** 180 × 8 pt, radius 4, track `--surface-raised`, fill `--text`. Caption
  `delivered / quota` beneath, centred.
- **Lives.** Three 10 pt pips, 8 pt apart. Filled `--text` when held, outlined `--text-mute` when
  lost. Never colour-coded — a colour-only life counter would be the one place in the game where
  colour carries meaning without a glyph.
- **Pause.** 44 × 44 pt target, 16 pt glyph, `--text-dim`, 8 pt from the right edge.

### 7.2 Road

Casing, surface and dashes as in §4.2. The road is uniform everywhere; a branch is marked by the
junction marker, not by a change in road treatment, so the player's eye is not pulled to
decoration.

### 7.3 Junction

```
        idle                   flipped (open = 1)          armed (car within 260 LU)

         ╱ ╲                        ╱ ╲                          ╱ ╲
        ╱   ╲                      ╱   ╲                        ╱▓▓▓╲
       ◆──────                    ──────◆                    ══◆══════
      ╱                                  ╲                    ╱
   dim  bright                      bright  dim            bright arc, --text 60 %
```

- **Marker.** A `JUNCTION_MARK_R = 46` LU disc in `--surface-raised` with a 4 LU `--road-edge`
  ring, and a **blade**: a rounded bar `BLADE_LEN = 40` LU long and `BLADE_W = 12` LU thick,
  radius `BLADE_W / 2`, drawn from the node centre outward along the open branch, in `--text` at
  92 %. The blade is the state: where it points is where the next car goes. *Both numbers are proportions of the
  marker, which is why they are stated here rather than left to the renderer. 40 LU from the
  centre of a 46 LU disc keeps the whole blade on the marker and leaves 6 LU of disc face between
  the blade's tip and the inside of the ring, so the blade never touches the ring at any rotation.
  12 LU is three times the ring's 4 LU and gives a 3.3 : 1 bar — 12.1 × 3.6 pt at the smallest
  supported scale (0.3025) — which is the thinnest bar whose angle is still readable at that size.*
- **The blade's heading is the chord from the junction node to the branch's far node**, not the
  road's tangent near the junction. This is normative and it is the one place where "draw it along
  the open edge" gives the wrong picture. Every edge leaves its node **vertically** by design
  ([`generation.md` §2.3](generation.md#23-edges)) — that is what makes roads join without a kink —
  so 40 LU down *either* branch the road is still pointing straight down, and a tangent-derived
  blade draws the identical vertical bar whichever way the switch is set. Slice 2 shipped that and
  the junction silently stopped showing its state; it was caught by looking at a screenshot, not by
  a test. The chord points at the column the branch actually reaches: straight down for a straight
  branch, clearly down-left or down-right for a diagonal. ([AC-504](acceptance-criteria.md))
- **Open branch.** The first 150 LU of the open outgoing edge is overdrawn in `--road` lightened
  16 %, so the open road reads brighter than the closed one even without looking at the blade. The
  overdraw is stroked at `ROAD_W` with **butt caps at both ends**. *Round caps are wrong here for a
  reason worth recording: the cap radius on a 104 LU stroke is 52 LU, so a round cap at the near
  end puts a 52 LU lobe of brightened road **above** the junction node, on the incoming road, which
  reads as the branch being open backwards. The near butt end is invisible anyway — it sits under
  the 46 LU marker disc, which is painted after it.* The far end is not hidden by anything, and a
  butt cap there ends the brightening in a hard line straight across the road, which reads as a
  painted road marking the game does not have. **The overdraw's alpha therefore ramps linearly to
  zero over its final `OPEN_BRANCH_FADE = 36` LU** — the same distance §7.6's apron fades out over,
  for the same reason: 36 LU is the shortest run over which a road-width stroke can end without
  showing an edge.
- **Armed.** When the nearest approaching car is within `COMMIT_PREVIEW = 260 LU`, a 3 LU arc in
  `--text` at 60 % traces the open branch for 220 LU. This is the fairness affordance for the
  one-frame render-latency window ([`gameplay.md` §3.3](gameplay.md#33-the-one-honest-caveat-render-latency)).
  It shows what will happen; it does not change what will happen.
- **Pressed.** During the 160 ms after a tap, a ripple ring expands 46 → 84 LU, `--text` from
  50 % to 0 % opacity.

### 7.4 Depot

```
   ┌───────────────┐   ← DEPOT_W 160 × DEPOT_H 170 LU, radius 12
   │▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│   ← 18 LU face band in the depot's colour, full width
   │               │
   │       ●       │   ← GLYPH_DEPOT 64 LU, in --ink, on a colour disc of radius 48
   │               │
   │  ▬▬▬▬▬▬▬▬▬▬▬  │   ← three 6 LU sill bars in the colour at 18 %
   └───────────────┘
```

Body `--depot`, colour carried by the face band, the glyph disc and the sill bars. The road enters
through the top face band.

**Glyph disc.** A filled circle centred on the body centre, radius **0.75 × the glyph size** — 48
LU at `GLYPH_DEPOT = 64`, 66 LU at `GLYPH_DEPOT_LARGE = 88` (§11.2) — in the depot's colour, with
the glyph drawn on it in `--ink`. *The ratio is derived, not chosen. The widest glyph in §6.2 is
Rose's filled square, whose corners sit at `(√2 / 2) × s = 0.707 s` from the centre, so any disc
radius below `0.707 × s` would clip it. 0.75 is the next step up that leaves visible margin —
2.75 LU at Standard, 3.8 LU at Large — and the resulting 132 LU disc at Large still clears
`DEPOT_W = 160` by 14 LU a side. Do not take this below 0.72.*

**Sill bars.** Three horizontal rounded bars in the depot's colour at 18 % opacity, each
`DEPOT_HATCH_W = 6` LU tall on a 10 LU pitch, inset 16 LU from each side of the body (128 LU wide
at `DEPOT_W = 160`), with the lowest bar's bottom edge 8 LU above the body's bottom edge. *Slice-0
wording called this "a 6 LU hatch in the colour at 18 %, bottom third", which named a texture and a
region and specified neither. It is bars, not diagonal hatching, and they occupy the bottom 26 LU —
15 % of `DEPOT_H`, not a third. Filling a third of the body with the colour at 18 % would put more
coloured area in the sill than in the 18 LU face band, and the face band is the primary colour
carrier: the sill is redundancy at the bottom of the shape, where the eye ends up after following
the road down, and it must not compete with the band the road actually enters through.*

States:

- **Idle** — as drawn.
- **Receiving** (220 ms) — face band brightness +18 %, body scales 1.00 → 1.04 → 1.00.
- **Rejecting** (350 ms) — face band flashes `--alert` for 90 ms, then the whole depot desaturates
  to `--text-mute` and returns over 260 ms.

### 7.5 Car

States: **arriving** (see below), **rolling** (steady), **entering the mouth** (no change to the
car at all — the apron of §7.6 passes over it), **frozen** (level ended — 45 % opacity, no
motion). There is no *delivered* or *misrouted* car state: by the time either resolves the car is
beneath the depot layer, and both outcomes are drawn by the depot and the mouth (§8.3, §8.4).

**Arriving — the car appears at full opacity in a single frame.** No fade, no scale-up, no
ramp of any kind on the car body itself. On the tick a car spawns it is drawn complete: full
body fill, full glyph, full stroke, at the entry node.

This replaces a 140 ms fade-in over the first 40 LU, and the reason is a rule, not a taste.
[`generation.md` §7.1.5](generation.md#715-the-per-tick-procedure--normative) D3 says the player
looks at a newly appeared car **next** rather than last, and that is what makes the first junction
decision reachable at all
([`gameplay.md` §4.6b](gameplay.md#46b-the-other-window-from-a-car-appearing-to-its-first-decision),
§8.10). Attention is captured by an abrupt luminance transient; a gradual onset of the same
magnitude does not capture it. A fade-in is exactly the manipulation that removes the effect the
player model now depends on — so the drawing would have been quietly falsifying the design's own
statement about the player. The fade was also spending 40 of the entry edge's 160 LU — a quarter
of the only window in the game in which that car's colour can be read — on making the colour hard
to read.

**Entry flare.** The onset still needs to be *findable* in peripheral vision without the fade, so
the transient is put somewhere it costs nothing: a ring at the entry node, `--text-mute` at 60 %
alpha, outer radius 34 LU, 6 LU stroke, scaling 0.6 → 1.4 and fading to zero over 180 ms,
`ease-out-quad`, drawn **beneath** the car layer (§4.2, step 6). It carries no colour information — the
car body is the only thing that says which colour arrived — so it never competes with the match
key and it is unaffected by the colour-blind settings of §6.

### 7.6 The depot mouth

**What this solves.** Every generated level, at every band, has at least one depot fed by two or
three terminal edges — measured, 100 % of levels, max in-degree 3
([`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-depot-mouth)). Those edges
converge geometrically, and the cars on them took different paths from the entry, so nothing
constrains their relative timing. Measured: two cars came within a car length in 0–5 runs per
1,000 by band, with a minimum centre-to-centre distance of **26 LU** against a 140 LU car — a
complete overlap. The rules are fine. The picture is not, and the fix belongs here.

**The treatment: the road runs under the depot.** Each depot is given a forecourt — an apron in
`--depot` laid over the last stretch of every terminal edge that feeds it — and the car layer is
painted beneath it (§4.2). A car does not fade, pop or shrink; it drives into the building.

```
        col c-1        col c         col c+1
           ╲             │             ╱
            ╲            │            ╱          ← ordinary road, cars drawn on top
             ╲           │           ╱
        ─────╳───────────╳───────────╳─────      ← mouth line: last mouthLu of each terminal edge
              ╲▒▒▒▒▒▒▒▒▒▒│▒▒▒▒▒▒▒▒▒▒╱            ← MOUTH_FADE: apron alpha 0 → 100 %
               ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓             ← apron core, --depot, opaque
                ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓              ← cars are UNDER all of this
                 ┌─────────────────┐
                 │▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│             ← DEPOT_W × DEPOT_H, §7.4, unchanged
                 │        ●        │
                 └─────────────────┘
```

**Geometry.**

```
mouthLu     per band, below — LU of arc length measured back from the depot node
MOUTH_W     = 176   // apron stroke width
MOUTH_FADE  = 36    // LU of alpha ramp at the leading end
```

`MOUTH_W = 176` because a car body's diagonal is `sqrt(140² + 84²) = 163.3` LU: a 176 LU stroke
contains a car at any heading, so no corner of a car can poke out of the side of the apron. It is
also 16 LU wider than `DEPOT_W`, so the forecourt reads as a flare into the building rather than
as a stripe that happens to be the same width.

| Band | `colW` | `rowH` | straight terminal edge | diagonal terminal edge | **`mouthLu`** | apron as % of the straight edge | clear road left below the junction row |
|---|---|---|---|---|---|---|---|
| 1 | 300 | 400 | 400 | 521 | **180** | 45 % | 220 LU |
| 2 | 260 | 300 | 300 | 415 | **160** | 53 % | 140 LU |
| 3 | 260 | 300 | 300 | 415 | **160** | 53 % | 140 LU |
| 4 | 195 | 240 | 240 | 323 | **150** | 63 % | 90 LU |
| 5 | 195 | 200 | 200 | 293 | **140** | 70 % | 60 LU |

`mouthLu` is not a taste value. It is the smallest multiple of 10 LU at which two converging
terminal centrelines are at least `CAR_W = 84` LU apart, computed from the cubic of
[`generation.md` §2.3](generation.md#23-edges) — that is, the point above which two cars cannot be
side by side in the same place. The exact thresholds are 178 / 153 / 153 / 146 / 131 LU.

**What it guarantees, measured against the curve rather than asserted.** With these values, for
every pair of cars on converging terminal edges with **both** centres outside the apron:

| | Band 1 | Band 2 | Band 3 | Band 4 | Band 5 |
|---|---|---|---|---|---|
| Worst residual overlap, diagonal vs straight | 10.9 % | 9.4 % | 9.4 % | 10.2 % | 8.5 % |
| Worst residual overlap, diagonal vs opposite diagonal | 0 % | 0 % | 0 % | 0 % | 0 % |
| Minimum centre-to-centre distance | 91 LU | 97 LU | 97 LU | 95 LU | 102 LU |

So the measured 26 LU total overlap can only occur beneath the apron, where it cannot be seen,
and the worst thing that remains visible is a corner of one car clipping a corner of another by
about a tenth of a body — which reads as one car passing another, because that is what it is.
**A full geometric guarantee is not available and is not claimed:** an apron large enough to
prove zero overlap for every configuration would need to be about 210–270 LU deep, longer than
the terminal edge itself at bands 4 and 5. ([AC-513](acceptance-criteria.md))

**Drawing it.** Two draws, in this order, both after the car layer:

1. **Cores.** For every terminal edge, the sub-path covering its last `mouthLu - MOUTH_FADE` LU,
   stroked at `MOUTH_W`, round cap and round join. All of a level's cores go into **one** `Path`
   and are filled once in `--depot` at 100 %, so overlapping lobes cannot stack.
2. **Fades.** For every terminal edge, the `MOUTH_FADE` stretch immediately above its core,
   stroked at `MOUTH_W` with a linear gradient in `--depot` running 0 % → 100 % alpha along the
   edge tangent. These are drawn inside a single `saveLayer`, so where two fade segments overlap
   the alpha does not accumulate into a visible lens.

Both paths are built once per level, at level load, from the same cubics the roads are drawn
from. Nothing here is per-frame work and nothing here reads simulation state.

**Constraint the band table must keep satisfying:** `mouthLu <= rowH - JUNCTION_MARK_R - 12`, so
the apron never reaches the junction marker at the top of a straight terminal edge. The tightest
band is 5: `200 - 46 - 12 = 142`, against `mouthLu = 140`. ([AC-514](acceptance-criteria.md))

**What the player loses, and what replaces it.** A car disappears `mouthLu / speed` before it
resolves — 0.61 s at band 5, 1.00 s at band 1. It loses nothing it could act on: a car on a
terminal edge is past its last junction and no tap can change its fate. What it would lose is the
*confirmation*, and that moves to the mouth: see §8.3 and §8.4.

---

## 8. Screen states

### 8.1 Idle / rolling
The steady state. The only motion is car translation and the arming of junctions.

### 8.2 Junction flipped
Blade rotates to the new branch, 120 ms, `ease-out-cubic`. Open-branch brightening cross-fades
over the same 120 ms. Ripple ring, 160 ms. Light haptic. **Communicates:** your tap landed, and
this is where the next car goes.

### 8.3 Car delivered
The car is already beneath the apron (§7.6), so the confirmation is carried by the mouth and the
depot. A **mouth glow** — the core of `level.edges[event.edgeId]`'s apron segment, redrawn in the
car's colour at 55 % alpha ([AC-140](acceptance-criteria.md); the same reason as §8.4 — a depot is
fed by up to three mouths and only one of them delivered this car) — fades in over 90 ms and out
over 130 ms, `ease-out-cubic`. Depot plays **receiving**. Quota bar fills over
180 ms `ease-out-cubic`. Score counts up over 300 ms. **Communicates:** that one is banked, and
which colour it was.

### 8.4 Car misrouted
The shatter originates at the **mouth line** of `level.edges[event.edgeId]` — the terminal edge the
car came down, named on the event itself
([`gameplay.md` §2.6](gameplay.md#26-resolvearrival--the-single-place-scoring-happens),
[AC-140](acceptance-criteria.md)) — which is the last point at which the car was visible. Not the
depot node: a depot has an in-degree of up to 3, so the depot does not identify the road, and
throwing from the node would show the wrong colour appearing from *under* the depot instead of
arriving *at* it. Six 26 LU fragments in the car's colour
scatter 60–110 LU, biased upward and outward along the edge tangent, and fade over 320 ms,
`ease-out-quad`. Fragments are transient effects (draw order step 11) and are therefore drawn
**over** the apron and the depot; this is the one thing that is. Depot plays **rejecting**. A
3 pt `--alert` screen-edge vignette flashes to 30 % and back over 180 ms. One life pip drains
over 240 ms. Error haptic. **Communicates:** a life is gone and this depot was the wrong one —
the colour of the fragments and the depot desaturating together name the mistake.
([AC-515](acceptance-criteria.md))

### 8.5 Last life
When `lives === 1`, the life-pip row takes a 1.6 s `ease-in-out-sine` opacity pulse between 1.00
and 0.65, and a 2 pt `--alert` border at 24 % sits steady inside the screen edge. Both persist
until the level ends. **Communicates:** sustained jeopardy, without a startle that would cost the
player the car they are currently tracking.

### 8.6 Level complete

```
┌──────────────────────────────────────────┐
│                                          │
│              LEVEL 12 CLEAR              │   Title 24/30, --text
│  ────────────────────────────────────    │
│   Delivered                      36/36   │   Body 16/22, --text-dim / --text
│   Best streak                       14   │
│   Lives remaining          2   ×50 +100  │
│  ────────────────────────────────────    │
│   SCORE                          4,180   │   Display 34/40, --text
│   Best                           3,940   │   Caption 12/16, --text-dim
│                                          │
│   ┌─────────────┐   ┌─────────────────┐  │
│   │    RETRY    │   │     NEXT  ▸     │  │   48 pt tall, 12 pt gap
│   └─────────────┘   └─────────────────┘  │
└──────────────────────────────────────────┘
```

Play surface dims to 40 % over 240 ms. Panel rises 24 pt and fades in over 280 ms,
`ease-out-back(1.08)`. Panel `--surface`, radius 20, 24 pt padding, max width 340 pt, centred.

### 8.7 Level failed

Same panel geometry. Title `OUT OF LIVES`, rows `Delivered 19/36` and `Score 2,150`, buttons
`RETRY` and `LEVELS`. Play surface desaturates to greyscale over 320 ms rather than dimming — the
colours going out is the point, since colour is what the level was about.

### 8.8 Pause and resume countdown

Pause overlay: play surface dims to 40 %, panel with `RESUME` / `RESTART` / `QUIT`. Resume
countdown: three 600 ms beats, numeral at Display size, `--text`, scaling 1.3 → 1.0 and fading
out each beat. No simulation ticks advance during either
([`gameplay.md` §6](gameplay.md#6-run-control)).

---

## 9. Motion spec

| Event | Duration | Easing | What it communicates |
|---|---|---|---|
| Car arrival | 1 frame | none | A new car exists — an abrupt onset, because §7.5's capture claim depends on it |
| Entry flare | 180 ms | `ease-out-quad` | Where the new car arrived, findable peripherally, carrying no colour |
| Junction blade rotate | 120 ms | `ease-out-cubic` | The tap landed |
| Junction tap ripple | 160 ms | `ease-out-quad` | The tap was received at *this* junction |
| Junction arm (lead arc) | 180 ms fade in | `ease-out-cubic` | This car is committing to this branch |
| Depot mouth glow | 90 ms in + 130 ms out | `ease-out-cubic` | Banked — and in which colour |
| Depot receiving pulse | 220 ms | `ease-out-cubic` | This depot accepted it |
| Car misrouted shatter | 320 ms | `ease-out-quad` | Lost — thrown from the mouth line, in the car's colour |
| Depot rejecting flash | 90 ms + 260 ms | `linear`, `ease-out-cubic` | Wrong depot — and which one |
| Life pip drain | 240 ms | `ease-out-cubic` | A life is gone |
| Edge vignette flash | 180 ms | `ease-out-quad` | Something bad, peripherally |
| Last-life pulse | 1600 ms loop | `ease-in-out-sine` | Sustained jeopardy |
| Quota bar fill | 180 ms | `ease-out-cubic` | Progress |
| Score count-up | 300 ms | `ease-out-cubic` | How much that was worth |
| Play surface dim | 240 ms | `ease-out-cubic` | The level is over |
| Failure desaturate | 320 ms | `ease-out-cubic` | The colours went out |
| Overlay panel rise | 280 ms | `ease-out-back(1.08)` | A decision is wanted |
| Countdown beat | 600 ms × 3 | `ease-out-cubic` | Get ready |

**The determinism rule for motion.** Anything drawn **inside the Skia play surface** derives its
animation phase from `(currentTick - eventTick) / TICK_HZ`, taking `eventTick` from
`state.events` ([`gameplay.md` §2.9](gameplay.md#29-events-are-render-hints-and-only-that)). A
replay therefore paints identically, frame for frame, to the live run
([AC-505](acceptance-criteria.md)). UI chrome outside the canvas — overlay panels, the resume
countdown, the score count-up, the quota bar, the life pips — may use **wall-clock** time, because
it is not part of the replayable world. That means `requestAnimationFrame` driving React state,
with the easing curves taken from the same module the canvas uses so that a 280 ms
`ease-out-cubic` is one function in this codebase and not two. React Native's `Animated` with
`useNativeDriver: true` is permitted where a transition is pure opacity or transform and the
native thread is worth the wiring; nothing here requires it.

**`react-native-reanimated` is not used, and slice 3 does not adopt it — decided, round 7.** It has
been in `package.json` since slice 0 with a Babel plugin and a comment claiming it "drives the
UI-thread clock the render loop reads from". Nothing imports it, and the comment is false: the loop
is `requestAnimationFrame` and every in-canvas phase derives from ticks. The decision is whether
slice 3's motion work needs it, and the table above answers that, because of where the line in the
paragraph above falls. **Everything in the canvas is forbidden from using it** — a wall-clock
animation inside the play surface breaks AC-505 by construction, so Reanimated cannot touch the
larger half of this table. What is left outside the canvas is six one-shot transitions of opacity,
transform or width on a handful of views, plus one looping opacity pulse. None is gesture-driven —
the only gesture in the game is a tap (§10.3), which resolves to a discrete state change, so there
is no continuous gesture value for a worklet to follow, which is the case Reanimated exists for.
**Remove the dependency, the `react-native-reanimated/plugin` entry in `babel.config.js`, and the
comment.** `react-native-gesture-handler` soft-requires Reanimated and continues without it, so
nothing else in the tree depends on it. Removing a native module is free only until a device build
exists; after that it is a rebuild of every artefact, which is why this is decided now rather than
in slice 3. If slice 5's "juice" later wants a gesture-driven or layout animation, adding it back
is a dependency decision made for a reason, which is not what the current entry is.

**Nothing in the play surface loops or idles.** There is no ambient shimmer, no drifting
background, no pulsing junction waiting to be tapped. If it moves, something happened.

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
  recognised tap. `MAX_POINTERS` is deleted.
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

**Why one pointer — decided, round 7.** Slice 2 found this section and
[AC-312](acceptance-criteria.md) in direct conflict: AC-312 requires that only `Gesture.Tap()` is
registered, and a single `Tap` recognises one tap per gesture no matter how many fingers are on it
(RNGH 2.31's `TapGesture` has `minPointers` and no `maxPointers`), while two `Tap` instances
double-fire on a single touch. `Gesture.Manual()` would expose `allTouches` and could deliver two
independent taps. The conflict is real and it cannot be settled by tier 3, because a mouse has one
pointer. It is settled here, against two-finger play, on three grounds:

1. **The difficulty model is one-fingered by construction, and every number in this design is read
   off it.** [`generation.md` §7.1.3](generation.md#713-constants) sets
   `BOT_MAX_TAPS_PER_TICK = 1` and `BOT_MIN_TAP_GAP = 11` ticks — one thumb, 180 ms between taps —
   and §7.2.4's five clear rates, §7.2.2's five targets, R2, R3 and
   [AC-233](acceptance-criteria.md)'s tap-rate ceiling are all measured against that bot. A player
   able to flip two junctions in one frame has a capability the ladder has never priced, in a game
   whose entire dynamic range is under three percentage points of per-car error
   ([`generation.md` §7.1.10](generation.md#7110-why-the-clear-rate-is-the-wrong-number-to-reason-about-and-which-number-is-not)).
   Shipping an unmeasured input channel into that is not a small risk.
2. **The game never asks for it, and that is a theorem rather than a hope.**
   [`gameplay.md` §4.6](gameplay.md#46-why-a-junction-is-always-flippable-in-time) proves a 670 ms
   floor between two cars at one junction and §4.6b the tighter first-decision window; §4.7 proves
   every level solvable with the 1.00 s flip window; the measured tap rate peaks at **0.73/s**
   against a 1.25/s ceiling. There is no reachable board state that one finger cannot serve in
   time.
3. **It is an affordance for a grip the game is not designed for.** §3 designs for a 6.1" phone
   held in one hand. The second thumb is not on the glass, and the cost of assuming it is, is a
   hand-rolled `Manual` gesture reimplementing `maxDuration`, `maxDistance` and cancellation — the
   one piece of input code in the app that no tier below a device test can exercise.

**What is not given up.** Two inputs resolving on one tick stays exactly as
[`gameplay.md` §3.5](gameplay.md#35-two-taps-in-the-same-tick) specifies, because it is reachable
with one finger: any two taps arriving between consecutive `step()` calls share a tick stamp, and
that window is 33 ms at 30 fps and longer under catch-up.
[AC-306](acceptance-criteria.md) now states that as a property of the input **queue**, which is
both what the engine actually guarantees and — unlike the two-pointer version — something a test
can reach.

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
| Symbol size | Standard / Large | Standard | `GLYPH_CAR` 48→66 LU, `GLYPH_DEPOT` 64→88 LU, car-glyph opacity 78 %→100 % |
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
