# Offramp — Team, Procedure and Development Process

How this project is built. The structure is inherited from a previous game built by the
same owner and squad (Wildlife Shuffle); the incidents in §6 happened there, and they are
kept because the mistakes are the part worth writing down.

What is new here is that Offramp is **real-time and procedurally generated**, where the
previous game was turn-based and hand-authored. §3 and §4 carry the consequences.

---

## 1. The team

Three agents, defined in `.claude/agents/`, invoked by name.

| Agent | Owns | Cannot |
|---|---|---|
| **game-designer** | Gameplay, generation rules, UI/visual system, acceptance criteria. Produces `docs/design/`. | Write production code. Touch `src/`. |
| **game-developer** | Implementation against approved ACs. | Redefine ACs. Mark its own work verified. Commit. |
| **game-tester** | Verification by execution. Bug hunting beyond the ACs. | Fix what it finds. Modify `src/` or `test/`. Commit. |

**The separation is the point.** A developer that can edit the acceptance criteria will edit
them to match what it built. A tester that can fix what it finds stops reporting and starts
patching, and nobody learns the defect existed. A designer that writes code designs what is
easy to write.

**The orchestrator** (the main session) owns git, owns what reaches the owner, and is the
only party that verifies claims across agents. No agent's report is taken at face value —
see §5.

---

## 2. The slice pipeline

```
  design ─→ build ─→ test ─→ fix ─→ re-test ─→ commit
                       ↑                 │
                       └─ max 2 rounds ──┘
```

If a slice is not green after two fix rounds it goes to the owner rather than grinding.

| Slice | Contents | Done when |
|---|---|---|
| **0** | Squad + design | `docs/design/` complete and self-consistent |
| **1** | Simulation engine + track generator, headless | `npm test` green; seeded replay is bit-identical; every generated level provably solvable |
| **2** | React state layer + Skia play surface | **The game plays on a real phone** |
| **3** | Visual system, motion, accessibility | Matches the visual system; colour-blind mode works |
| **4** | Meta progression, persistence | Levels unlock; best scores survive a restart |
| **5** | Polish — sound, haptics, juice | |
| **6** | Store readiness | Submittable to both stores |

Slices 1–3 are a complete, playable game. 4–6 are layers that can be deferred independently.

**Owner approval:** for this build the owner has delegated blanket approval — slices do not
stop for sign-off. That raises rather than lowers the bar on §4 and §5: with no human gate,
the only thing standing between a defect and the owner is execution-backed verification.

**Why the engine comes first.** The engine is the only part that can be *proved* correct, so
it is built and verified with nothing rendered to hide behind. A feature-vertical slice
would bury simulation bugs under rendering bugs.

---

## 3. What real-time changes

The previous game resolved discrete turns. Offramp advances continuously, and that pushes
hard on determinism.

- **Fixed integer timestep.** `TICK_HZ` is a constant. The engine advances exactly one tick
  per `step()`. Real elapsed time is converted to a whole number of ticks by the React
  layer, which accumulates the remainder — the engine never sees a fraction, never sees
  milliseconds, and never sees a frame.
- **Positions are integers or fixed-point.** Never accumulated floats. `distance += speed`
  over 7,200 ticks accumulates float error that differs between an arm64 phone and an x86
  CI box, and determinism dies silently. Store progress along an edge as an integer in
  fixed-point units.
- **Inputs are tick-stamped.** A tap is `{tick, junctionId}`, resolved at the start of that
  tick, in a defined order. Two taps in the same tick resolve by junction id, not by
  arrival order.
- **Junction state is read when a car enters the junction**, not before and not after. This
  is the single most important rule in the game and the one most likely to be got subtly
  wrong: a car that has already committed to a branch does not re-route when the player
  flips the switch behind it.
- **Pause, background and app resume must not advance the simulation.** A phone call is not
  extra ticks.

## 3b. What procedural generation changes

A generated level can be unfair in ways an authored one cannot, so generation carries its
own verification burden. A generator is not done when it produces a network; it is done when
every network it produces has been *played*.

1. **Structural validity** — planar, no ambiguous crossings, every depot reachable from
   every entry, no dead ends, no junction a car can enter from two directions.
2. **Solvability** — an unconstrained solver bot clears the level. Necessary, not sufficient.
3. **Human plausibility** — a bot constrained to human limits (minimum reaction latency, one
   tap at a time, bounded lookahead, no frame-perfect play) clears it at the target rate.
   *An omniscient bot proves nothing about playability.*
4. **Duration** — the constrained bot's completion time falls inside the design's band. The
   two-minute ceiling is a measured acceptance criterion, not an aspiration.

---

## 4. How verification works

Five tiers. Be honest about which tier a claim comes from.

| Tier | Method | Proves |
|---|---|---|
| **1 · Engine** | `node --test` + seeded invariant fuzzing | Rules, scoring, determinism |
| **2 · Generation** | Solver bots over thousands of seeds | Every generated level is fair and finishes in band |
| **3 · E2E** | Expo web + Playwright at iPhone viewport | The full loop: input → state → paint |
| **4 · Layout** | Arithmetic against a continuous viewport sweep | Device fit, including hardware that has not shipped |
| **5 · On-device** | The owner, on a real iPhone via an EAS dev build | Feel, haptics, true touch, sustained frame rate |

Only tier 5 proves iOS. Tier 3 is a strong signal and not proof: it is `react-native-web`
driven by mouse events.

**Tier 3 has a known weakness, and it is named here so nobody forgets it.** The play surface
is a single Skia canvas. Playwright cannot query it the way it could query views — there are
no elements inside a canvas. Verification therefore asserts against a serialized frame
snapshot the state layer publishes to `window.__offramp`, plus screenshot comparison for the
paint itself. That proves the state reached the renderer. It does **not** prove the renderer
drew it correctly; only the screenshots and tier 5 speak to that.

**Invariant fuzzing is the sharpest tool.** Drive the engine over thousands of seeded ticks
and assert after *every step*: no car off its edge, no car past its edge end without a
transition, ids unique, tick +1 exactly, score integral and non-decreasing, lives
non-increasing, no car in a depot of the wrong colour without the mismatch having been
scored, no car occupying two edges.

**The tester verifies blind.** It writes its own tests from the ACs *before* reading the
developer's. Two passes that agree because they made the same assumption are worth one.

**Never trust a green check you have not seen fail.** Before relying on a new test, lint or
harness, inject the fault it is supposed to catch and confirm it fails. See §6.2.

---

## 5. Claims are verified, not relayed

Every agent report is checked against the files and by execution before it is acted on or
passed to the owner. This is not distrust; it is the only way a multi-agent chain stays
honest. On the previous project it caught a designer report claiming two ACs had been added
when neither existed, a claim that a table had been reworded when it had not, and a premise
all three parties shared that nobody had checked and that turned out to be false.

The orchestrator also verifies its *own* claims. A finding reported to the owner that turns
out to be wrong costs more than one that was never reported.

---

## 6. Incidents, and the rules that came from them

Inherited. They happened on the previous project; they are general.

### 6.1 The rail that bounded nothing
A safety rail everyone believed was bounding a multiplier was bounding nothing, because the
multiplier was already flat before the rail engaged. Three parties accepted the premise;
nobody executed it.
**Rule:** a shared premise that nobody has executed is a guess. Check the cheap thing first.
**Corollary:** a rail that play reaches is not a safety rail, it is a gameplay parameter.

### 6.2 The check that could only pass
A document fix was "verified" by grepping for a string that differed from the file's text by
one capital letter. Zero results was read as confirmation. Two ACs were lost while being
cited from two files.
**Rule:** a check that cannot fail is not a check. Prove a new check catches before trusting
it to pass.

### 6.3 Statistics with two sources
Run statistics were accumulated in local variables *and* derivable from the event stream.
They agreed, which is the bug shape rather than its absence.
**Rule:** remove the second source rather than keeping two in sync. A sync rule is the thing
that fails.

### 6.4 Reviewing a stale commit
A review was written against a session-start git snapshot that was seven commits behind.
**Rule:** `git fetch` and compare against `origin/<branch>` before reviewing anything.

### 6.5 The stacked-branch merge
A slice's PR was based on the previous slice's branch; both merged within seconds and the
code never reached `main`.
**Rule:** branch each slice from `main`. If stacking is genuinely necessary, merge in order
and verify the result is on `main` afterwards.

---

## 7. Git workflow

- **One branch per slice**, named `slice-N-<topic>`, cut from `main`.
- **Never commit to `main` directly.**
- **Stage explicitly.** Never `git add -A`.
- **Agents do not commit.** Only the orchestrator does.
- **Commit messages** explain *why*, cite `path:line` for defects, and give measured numbers
  rather than adjectives.
- **After merging, verify the code is actually on `main`** (§6.5).

---

## 8. Working agreements

- **Ground everything in the real files.** Cite `path:line`.
- **Measure, don't assert.** Every pacing, difficulty and layout claim needs a harness.
- **Flag ambiguity, don't resolve it silently.** Report the contradiction and state what you
  assumed.
- **Report failure plainly.** If tests fail, say so with the output. If a step was skipped,
  say that. Never mark your own work verified.
- **Correct errors without ceremony.** State the correction, carry the consequence, move on.

---

## 9. Running the checks

```bash
npm test                                   # engine unit + invariant tests
node tools/replay.mjs --seed 42            # seeded run, ASCII, must be identical every time
node tools/bot.mjs --seeds 1000            # constrained solver over the generator
node tools/pacing.mjs                      # completion-time band per difficulty
node tools/generator-audit.mjs --seeds 5000 # structural validity of generated networks
node docs/design/check-ac-refs.mjs         # dangling / duplicate AC references
node tools/layout-sweep.mjs                # viewport sweep, must be 0 overflowing
```

All must be clean before a slice ships.
