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
6. **Cars**, ascending by id, each with body, roof glyph and shadow
7. **Depot-mouth aprons** (§7.6) — one filled path for the opaque cores, then one `saveLayer`
   for the fade segments
8. Depot bodies and depot glyphs
9. Transient effects sourced from `state.events` (§9)

Cars are painted after junction markers, so **a car is never hidden by a junction marker** — that
part is unchanged. Cars are painted *before* the depot layer, which is the change slice 1's
measurement forced: a car drives **under** the depot mouth and under the depot body, which is
what makes two cars converging on one depot impossible to see overlapping (§7.6,
[`gameplay.md` §4.5b](gameplay.md#45b-where-the-guarantee-stops-the-depot-mouth)). Nothing else
occludes a car.

### 4.3 The car

Top-down, axis-aligned to the road tangent. The body is **one large colour fill**: a rounded
rectangle `CAR_L × CAR_W`, corner radius `CAR_RADIUS`, filled with the car's colour. On top of
it:

- a **windscreen**: a 40 × 60 LU rounded rect in `--car-glass` at 22 % opacity, offset 28 LU
  toward the nose — it reads as a car rather than a capsule and costs no colour area;
- the **colour glyph**, `GLYPH_CAR` square, in `--ink`, centred on the body and **counter-rotated
  so it is always upright relative to the screen** (§6.2);
- a **shadow**: the same rounded rect, offset (0, 6) LU, `#000000` at 32 %, drawn beneath.

No outline, no gradient, no headlights. The colour patch is at minimum 25.4 × 42.4 pt on the
smallest supported device, comfortably above the 20 px legibility floor.

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
  ring, and a 40 LU **blade** — a rounded bar — rotated to lie along the open branch. The blade is
  `--text` at 92 %. The blade is the state: where it points is where the next car goes.
- **Open branch.** The first 150 LU of the open outgoing edge is overdrawn in `--road` lightened
  16 %, so the open road reads brighter than the closed one even without looking at the blade.
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
   │       ●       │   ← GLYPH_DEPOT 64 LU, in --ink, on a colour disc
   │               │
   │  ▚▚▚▚▚▚▚▚▚▚   │   ← 6 LU hatch in the colour at 18 %, bottom third
   └───────────────┘
```

Body `--depot`, colour carried by the face band, the glyph disc and the hatch. The road enters
through the top face band. States:

- **Idle** — as drawn.
- **Receiving** (220 ms) — face band brightness +18 %, body scales 1.00 → 1.04 → 1.00.
- **Rejecting** (350 ms) — face band flashes `--alert` for 90 ms, then the whole depot desaturates
  to `--text-mute` and returns over 260 ms.

### 7.5 Car

States: **spawning** (140 ms fade-in over the first 40 LU), **rolling** (steady), **entering the
mouth** (no change to the car at all — the apron of §7.6 passes over it), **frozen** (level ended
— 45 % opacity, no motion). There is no *delivered* or *misrouted* car state: by the time either
resolves the car is beneath the depot layer, and both outcomes are drawn by the depot and the
mouth (§8.3, §8.4).

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
depot. A **mouth glow** — the apron core redrawn in the car's colour at 55 % alpha — fades in over
90 ms and out over 130 ms, `ease-out-cubic`. Depot plays **receiving**. Quota bar fills over
180 ms `ease-out-cubic`. Score counts up over 300 ms. **Communicates:** that one is banked, and
which colour it was.

### 8.4 Car misrouted
The shatter originates at the **mouth line** of the terminal edge the car came down — the last
point at which the car was visible — not at the depot node, so the wrong colour is seen arriving
at the wrong depot rather than appearing from under it. Six 26 LU fragments in the car's colour
scatter 60–110 LU, biased upward and outward along the edge tangent, and fade over 320 ms,
`ease-out-quad`. Fragments are transient effects (draw order step 9) and are therefore drawn
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
| Car spawn fade-in | 140 ms | `linear` | A new car exists; its colour is now readable |
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
([AC-505](acceptance-criteria.md)). UI chrome outside the canvas — panels, countdown, score
count-up — may use Reanimated wall-clock time, because it is not part of the replayable world.

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
  `maxDistance` 16 pt.
- Up to `MAX_POINTERS = 2` simultaneous pointers. Two junctions tapped in the same frame produce
  two inputs on the same tick, resolved by junction id
  ([`gameplay.md` §3.5](gameplay.md#35-two-taps-in-the-same-tick)).
- No drag, no swipe, no long-press, no double-tap. Every gesture the game understands is a tap.
- Taps are discarded while paused, during the resume countdown, and after `phase` leaves
  `'running'`.

---

## 11. Accessibility

### 11.1 Targets and contrast

- Junctions: ≥ 44 pt across every supported viewport, proven by sweep (§4.4).
- Pause, and every overlay button: ≥ 44 × 44 pt, with ≥ 8 pt between adjacent targets.
- All text ≥ 4.5 : 1 against its surface (§5.3). `--text-mute` at 3.80 : 1 is used only for
  disabled and decorative states, never for information.
- Car colours ≥ 4.2 : 1 against the road (§5.2).

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
