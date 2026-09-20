# Slice 0 — orchestrator verification of the designer's report

Per `docs/development-process.md` §5, every agent claim is checked by execution before it is
acted on. This is what was checked and what it showed.

## Verified true

| Claim | How it was checked | Result |
|---|---|---|
| Four deliverables written to `docs/design/` | `ls -la` | True — plus `check-ac-refs.mjs`, declared in the report |
| 134 acceptance criteria | `grep -oE 'AC-[0-9]{3}' \| sort -u \| wc -l` | 134 |
| No dangling refs, duplicates or misgrouped numbers | `node docs/design/check-ac-refs.mjs` | Exit 0, 134 ACs across 8 groups |
| The checker was proven to catch its three fault classes | Re-injected all three independently, on a copy | Exit 1 each time; exit 0 after restore |
| Palette contrast ratios (10 figures) | Recomputed WCAG relative luminance from the hex values in Python | **All ten reproduce to 2 d.p.** |
| The designer wrote no production code | `git status --short` | Only `?? docs/design/` |

The palette check is the one worth calling out. Ten independently recomputed contrast ratios
matching to two decimal places is strong evidence the optimisation described in `ui.md` §5.1
actually ran, rather than being plausible numbers written into a table.

## Finding 1 — `gameplay.md` §4.5 claims more than its argument proves

**Severity:** low, cosmetic. Not a rules defect. **Confirmed by reading the rules against each
other**, not by execution — the engine does not exist yet.

§4.5 is titled *"Why two cars never visually overlap"* and argues: the network is a tree, so two
cars share an edge only if they took the identical path, so their separation is exactly their
spawn separation.

That argument is sound **for cars on the same edge**. It does not cover the depot row:

- `generation.md:354` **V2** requires terminal-row targets to be *non-decreasing*, not strictly
  increasing. Equal targets are therefore permitted.
- `generation.md:353` **V1** gives depots in-degree ≥ 1, and **V3** explicitly exempts depots
  from the in-degree ≤ 1 rule.

So two distinct terminal edges may feed one depot. Those edges converge geometrically at the
depot mouth. Two cars on them took *different* paths from the entry, so nothing constrains their
relative timing — they can arrive within a tick of each other and visually overlap for the few
frames before `resolveArrival` removes them.

The rules are unaffected: both cars resolve correctly and independently. Only the heading is
wrong, and the structural guarantee is narrower than stated.

**Carried to slice 1 as:** the developer treats this as a render-layer concern, and the tester
measures how often two cars come within one car length of each other on converging terminal
edges. If it is rare it is a non-issue and §4.5's heading is reworded; if it is common the depot
mouth needs a visual treatment.

## Finding 2 — mutation during iteration in `gameplay.md` §2.5 step 4

**Severity:** medium if implemented literally. **Suspected by reading.**

Step 4 iterates cars in ascending id order, and `resolveArrival` (§2.6) does `remove car from
state.cars` from inside that loop. Removing from an array while iterating it forward skips the
next element. The pseudocode is a specification, not an implementation, but this is the exact
shape that survives into code.

**Carried to slice 1 as:** collect arrivals during the pass and compact afterwards, or iterate
backwards. The tester should have a case where two cars arrive at depots on the same tick, which
is what exposes it.

## Accepted, with the designer's own caveats

- **Merge-free trees instead of a general DAG** (`gameplay.md` §8.2). Forced by measurement — the
  equal-arc-length constraint a merge model needs produced 0 valid networks in 2,000 seeds at
  bands 2–5. Accepted.
- **One entry point instead of two** (§8.1). Accepted; divided attention now comes from 3.3–4.1
  cars in flight across 3–5 colours rather than from two spatial fronts.
- **Session band 49–109 s with a 130 s hard ceiling** (§5.3). Matches the owner's "two minutes"
  read as a ceiling rather than a mean. Accepted.
- **Constrained-bot clear-rate and completion-time targets are judgement, not measurement** —
  the bot does not exist yet. The designer flagged this itself and pre-committed a lever order in
  `generation.md` §7.4 for when a target is missed. This is the largest open risk in the design
  and slice 1 is where it gets settled.
