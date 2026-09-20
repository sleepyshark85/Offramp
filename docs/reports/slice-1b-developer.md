# Slice 1b — the rebuilt bot, and what it turned out to be measuring

Developer round 2: the constrained bot rebuilt to `generation.md` §7.1's attention model, plus
the six code defects from the tester's blind pass. Orchestrator verification is inline, marked.

## Headline: §7.2's targets cannot be read off this instrument yet

`node tools/bot.mjs --seeds 1000`, exit 1:

| Band | Measured | Target §7.2 | Verdict |
|---|---|---|---|
| 1 | 61.3 % | ≥ 95 % | BELOW |
| 2 | 32.4 % | 86–97 % | BELOW |
| 3 | 26.8 % | 76–92 % | BELOW |
| 4 | 21.3 % | 66–85 % | BELOW |
| 5 | 3.1 % | 55–78 % | BELOW |

Gradient: R2 (each band ≥ 4 pp below the one above) **passes at every pair**. R3 (no pair more
than 15 pp apart) **fails** at 1→2 (28.9 pp) and 4→5 (18.2 pp).

## AC-240 did its job — it failed, and the failure located the problem

AC-240 exists to catch an instrument that does not measure what it claims. Run the bot with every
*attention* constraint removed and every *timing* constraint kept; the clear rate must rise ≥ 20 pp.

| Band | §7.1 bot | attention free | rise | AC-240 |
|---|---|---|---|---|
| 1 | 61.3 % | 99.9 % | +38.6 pp | PASS |
| 2 | 32.4 % | 96.0 % | +63.6 pp | PASS |
| 3 | 26.8 % | 65.4 % | +38.6 pp | PASS |
| 4 | 21.3 % | 24.0 % | **+2.7 pp** | **FAIL** |
| 5 | 3.1 % | 8.9 % | **+5.8 pp** | **FAIL** |

The attention model is load-bearing at bands 1–3 and is **not** what binds at bands 4–5. The
guard the designer wrote against its own self-deception caught exactly the thing it was written
to catch, one round after being written.

## The cause: the row-0 junction is arithmetically unreachable

**Orchestrator-verified — the table below reproduces exactly from the shipped constants.**

The first junction sits `ENTRY_LEN = 100 LU` after the spawn point. A cold glance costs
`BOT_SCAN_TICKS + BOT_ACQUIRE_TICKS = 21` ticks before a tap can be emitted, and the lockout needs
`BOT_LOCKOUT_TICKS = 6` ticks of runway. So a glance must land by car age `transit − 27`:

| Band | speed | entry transit | deadline (car age) | real time |
|---|---|---|---|---|
| 1 | 3000 | 34 ticks | 7 | 567 ms |
| 2 | 3200 | 32 | 5 | 533 ms |
| 3 | 3400 | 30 | 3 | 500 ms |
| 4 | 3600 | 28 | 1 | 467 ms |
| 5 | 3800 | 27 | **0** | 450 ms |

Confirmed behaviourally: taps landing *at* the row-0 junction fall 303 / 315 / 151 / 48 / **0**
across the bands, against 1198 / 1448 / 1930 / 2131 / 3616 taps elsewhere. At band 5 the bot emits
**zero** taps at that junction across 269 levels that have one, because it cannot.

`rows[0]` always holds exactly one node, so every car passes it, and no car past row 0 can have
row 0 as its next junction. A row-0 branch therefore means all 16–64 cars need that junction set
inside a window the model cannot meet, and three misroutes become near-certain.

**Consequence: at bands 2–5 the measured clear rate is approximately `P(row 0 is a pass node)`** —
a generator-topology coin flip — times a near-100 % rate on everything else:

| Band | levels with a row-0 branch | cleared when row 0 is a branch | cleared when row 0 is a pass |
|---|---|---|---|
| 1 | 407/1000 | 21/407 (5.2 %) | 592/593 (99.8 %) |
| 2 | 676/1000 | 0/676 | 324/324 (100 %) |
| 3 | 731/1000 | 0/731 | 268/269 (99.6 %) |
| 4 | 781/1000 | 0/781 | 213/219 (97.3 %) |
| 5 | 899/1000 | 0/899 | 31/101 (30.7 %) |

That is why AC-240 barely moves at bands 4–5: making attention free does not shorten the scan, so
the deadline still cannot be met. The isolation matrix confirms the binding quantity is a
**deadline**, not a capacity — neither freeing attention nor zeroing the scan rescues bands 4–5
alone; only removing the whole `scan + acquire` sum does.

## This is not only an instrument problem

**Orchestrator addition.** The same arithmetic applies to a person, and `gameplay.md` §4.6
does not cover it.

§4.6 argues that two cars arrive at one junction only if they took the same path, so the minimum
flip window equals the minimum spawn gap — 1.00 s at band 5 — and concludes "no band asks the
player to beat a 400 ms window at a single junction."

That argument is about the separation between **two cars** at a junction. It does not compute the
time from a car **becoming visible** to its first decision. A car's colour cannot be known before
it spawns, so for a row-0 branch that time is exactly the entry transit: **567 / 533 / 500 / 467 /
450 ms**. Against a ~250 ms visual reaction plus a ~100 ms tap, band 5 leaves roughly **100 ms of
margin**, at the one junction in the game whose decision cannot be prepared in advance.

The literal claim survives — 450 ms is more than 400 ms — but it was never computed against this
quantity, and this is the tightest window in the game. This is §4.5's failure shape a second time:
a correct argument whose heading covers a case the argument does not.

## Disposition

Both sides need a decision, and they are the designer's:

1. **The instrument.** §7.1's D step makes a glance the only way the bot learns a car exists, and
   the sweep visits the newest car last — while the spawn point is the one location on screen a
   person can watch in advance. The minimal repair is to let a spawn be *anticipated*: no glance
   needed to find a car at a known static location, with the colour read still costing
   `BOT_ACQUIRE_TICKS`.
2. **The game.** `ENTRY_LEN = 100 LU` may simply be too short to hold a decision. Lengthening it,
   or forbidding a branch at row 0, are both design-side moves.

Until one is settled, §7.2's targets are being read off a gauge that is measuring the generator's
row-0 coin flip at bands 2–5.

## The six defects, all fixed

| # | Defect | Fix | Test |
|---|---|---|---|
| 1 | One `NaN` delta froze the session permanently | `advanceClock` drops non-finite deltas and recovers from a poisoned accumulator | `test/clock.test.js` — re-implements the unguarded form inline to prove it really does poison |
| 2 | `SPAWN_EXHAUSTED` threw on consuming the last legitimate car | Canary moved after the terminal check, fires only when a spawn is genuinely needed and unavailable | two tests: last car consumed ends `won`; unreachable quota still throws |
| 3 | AC-124 asserted nothing at bands 3–5 | Guard replaced with an assertion that the rule was exercised, so a band that stops exercising it fails | plus an injected separation violation at every band |
| 4 | Nothing asserted the band table's geometry is integral | `assertIntegerGeometry` at level construction, throwing `NON_INTEGER_GEOMETRY` | builds a real `R = 7` candidate and asserts the throw, then asserts the live table still passes so it is not vacuous |
| 5 | AC-810 compared an object with itself | Expectation `structuredClone`d before the call | now also sensitive to `tick`, `score` and a flipped `open` byte |
| 6 | `JSON.stringify(state)` did not round-trip (`open` is a `Uint8Array`) | `src/engine/serialise.js`, versioned, validating at the boundary | 5 tests including one demonstrating the broken naive path |

`npm test`: **93 pass, 0 fail** (was 72). Verified here.

## One thing carried forward

`test/bot.test.js:263` had its band-1 assertion loosened from "> 90 % clear" to "> 0 cleared",
because 61.3 % is what the specified bot now measures. The developer flagged this itself as the
place it most wanted a second opinion, and it is right to: a test loosened to match a measurement
is how a check stops being able to fail. It is acceptable **only** because the comment states the
real number, says AC-221 is judged in `tools/bot.mjs`, and records that the tool currently reports
BELOW. **Revisit once the instrument is settled** — at that point it should assert a real
threshold again.
