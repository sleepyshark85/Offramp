# Slice 1 — orchestrator verification of the developer's report

Per `docs/development-process.md` §5. Everything below was re-run here, not relayed.

## Reproduced

| Claim | Re-run result |
|---|---|
| `npm test` green, 72 tests | 72 pass, 0 fail, 1,992 ms |
| Scope respected — only `src/`, `test/`, `tools/` | `git status` confirms; no `docs/` file modified |
| Determinism holds across processes | `tools/replay.mjs --seed 42` → identical in-process and cross-process, `DETERMINISM: PASS` |
| Generator audit clean | 1,000 seeds × 5 bands, 0 exhaustions, 0 violations, `validate()` vs independent re-check: 0 disagreements |
| Engine purity | Independent grep: 0 hits for `Math.random`, `Date.now`, `setTimeout`, `setInterval`, React import |
| Clear-rate swing by bot policy | Reproduced at 300 seeds/band: `nearest` band 5 **30.0 %**, `literal` band 5 **0.7 %**, `patient` band 5 **100 %** |

The generator also matches the designer's independent prototype closely enough to be the same
algorithm — attempts median 5/3/2/2/2 against 5/3/2/2/2, and band-1 distinct topologies 37
against 37 at equal seed counts.

## Finding 1 from slice 0 — now measured, and the answer is split

- **Structural: universal.** 100 % of levels at every band have at least one depot fed by two or
  more terminal edges; max depot in-degree 3 at bands 2–5. `gameplay.md` §4.5's guarantee is
  narrower than its heading in *every* level, not occasionally.
- **Behavioural: rare, but a total overlap when it lands.** Two cars on different terminal edges
  converging on one depot came within a car length in 0–5 runs per 1,000 depending on band.
  Minimum observed centre-to-centre distance **26 LU**, against a car 140 LU long and 84 LU wide
  — a complete overlap, not a near miss.

Disposition: no rules or generator change. `ui.md` gains a depot-mouth treatment for slice 3, and
§4.5's heading is narrowed to what its argument actually proves.

## The blocking problem: the instrument cannot measure the thing the game is about

`generation.md` §7.1's policy paragraph admits three readings, and the measured clear rate at
band 5 moves **0.7 % → 30.0 % → 100 %** across them. Until it is pinned to one deterministic
reading, **no clear-rate number is falsifiable and no lever pull can be evaluated.**

Worse, and this is the part that is not a wording fix: the `patient` reading clears **100 % at
every band while obeying every normative constraint in §7.1**. The constants (250 ms reaction,
180 ms inter-tap, 100 ms lockout, 4-car lookahead) constrain *timing*. They do not constrain
*attention* — the bot has perfect topology knowledge, perfect memory of every car's colour, and
no cost to switching between cars. Offramp's entire subject is divided attention. A bot that
never has to divide its attention cannot measure the difficulty of dividing it.

Corroborating evidence that the design's own numbers were written against two different implicit
bots: the `literal` policy's measured tap rate (0.38/0.42/0.54/0.59/0.72 per band) sits almost
exactly on §6.3's *estimated* rate (0.38/0.54/0.68/0.89/1.03) — yet that same policy clears
0.7 % at band 5, nowhere near §7.2's 62–84 % target.

**Disposition: fix the instrument before touching the game.** No lever was pulled, correctly. A
quota cut sized to move band 5 from 30 % to the 62 % floor would drop the median duration to
≈76 s, breaking §7.3's 98–122 s band, which currently *passes* at every band. The two targets are
in tension **under a bot we already know is the wrong instrument**, so retuning the game against
it would be tuning to a broken gauge.

## Two spec defects confirmed independently

**AC-805 is wrong twice over.** It states that a 50 ms frame carries "the 0.33 ms remainder" into
the React accumulator.

- In exact arithmetic 50 ms is 3 ticks exactly at 60 Hz, so the remainder is **0 ms**, not 0.33.
- More importantly, `1000/60` is `16.666666666666668` in IEEE 754, so a naive
  `floor(50 / (1000/60))` yields **2**, not the 3 the AC requires. Integer-tick arithmetic
  (`50 * 60 / 1000`) gives 3.

The developer implemented the integer form and flagged the discrepancy rather than quietly
matching the AC's wrong number. That is the correct behaviour.

**AC-119 / AC-121 / AC-122 cannot all hold simultaneously.** With `lives === 1` and two cars
misrouting on the same tick, AC-119 ("lives decreases by 1") applied twice gives `lives === -1`,
which AC-121 ("never goes below 0") forbids, while AC-122's ordering requires both arrivals to
resolve. The developer floored the decrement at 0 and kept counting `misrouted`. That is the
right resolution; the ACs still need reconciling so the next reader does not hit the same wall.

## Judgement calls accepted

- `pBranchPct` as an integer percentage rather than a float probability — exactly equivalent, and
  it keeps the generator free of floats. Accepted.
- `validate()` running after `finalise()` rather than before. V10 and V11 need finalised data, and
  validating the object the engine actually consumes is the stronger check. Accepted.
- `TRANSITION_STATS` / `GEN_STATS` module-level instrumentation — they never affect a result and
  they let AC-118 and AC-203 be observed rather than argued. Accepted for now; revisit if they
  ever leak into a code path that matters.

---

## Correction — the AC-805 finding above is half wrong, and the wrong half propagated

Written after the tester's blind pass caught it. The claim in "Two spec defects confirmed
independently" that *"a naive `floor(50 / (1000/60))` yields 2, not 3"* is **false**.

In Node 24, `50 / (1000/60)` is exactly `3` — bit pattern `0x4008000000000000`, no rounding
error at all — so `Math.floor` of it is `3`. The integer-first form gives `3` too. **The two
forms agree at 50 ms.**

**How the error was made.** The check was run in Python as `50 // (1000/60)`, which returned
`2.0`. Python's float `//` is not `floor(a/b)`: it is computed from `fmod` and can differ in the
last place. `math.floor(50/(1000/60))` in the same Python returns `3`, agreeing with Node. The
verification used an operator that does not correspond to the JavaScript being reasoned about,
which is the §6.1 failure shape exactly — a premise that looked executed but was not executed
*on the thing it was a premise about*.

**What survives.** AC-805's original "0.33 ms remainder" is still wrong: 50 ms is exactly 3 ticks
at 60 Hz, so the remainder is 0 ms. The integer-first form is still the right thing to ship, for
the ordinary reason that it cannot drift, not because 50 ms distinguishes it.

**What the correct falsifying case is.** The two forms first disagree at **250 ms**: divide-first
gives 14, integer-first gives 15. And because `MAX_CATCHUP_TICKS = 8` clamps at 133.34 ms, that
disagreement sits *outside* the uncapped range — for integer-millisecond deltas the two forms are
indistinguishable everywhere the clamp has not already taken over.

**The consequence, which is the part that matters.** The designer took the wrong number from this
report in good faith and wrote **AC-816**, which requires injecting the divide-first form and
observing `n === 2`. That AC cannot pass at 50 ms against any correct implementation. A bad number
in a verification report became an unsatisfiable acceptance criterion one step downstream — the
mirror image of incident §6.2, a check that cannot *pass* rather than one that cannot fail.

Carried back to the designer: fix AC-805's parenthetical, and either repoint AC-816 at 250 ms or
delete it and state plainly that the two forms are indistinguishable inside the uncapped range.
