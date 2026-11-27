# diff-speed-20261126

A faster drop-in replacement for make.fun's own `makefun-diff` 1.0.0, written for the [Diff two texts faster](https://make.fun/bounty/diff-speed-01-run-20261126) bounty.

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/slarkand/diff-speed-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/slarkand/diff-speed-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

The three badges above are the competition's live badges for this entry.

For each case's input `{ old, new }` (two texts), the answer is make.fun's own patch as one JSON string — byte-identical to what `makefun-diff` 1.0.0 produces, just faster. The rule is make.fun's: lines are cut after every `\n` (a `\r` is part of its line), a last line with no `\n` is a line too, and two lines are equal only when they are the same code units. The edit script keeps the common prefix, then the common suffix of what is left; between them Myers's greedy search from the first lines, keeping on each diagonal the path reaching furthest into the old text, the deletion winning when a deletion and an insertion reach the same point, never moving past either text's end, pruning no edge diagonal, and following every run of equal lines as far as it goes; the first path to reach both ends is the script.

Speed, with no change to the algorithm's semantics or tie-breaking:

- Lines are interned to integer ids (one `Map` lookup per line), so every comparison in the search is an integer `==`, never a string `==`.
- The Myers search runs on flat `Int32Array`s. The V arrays for every depth are kept in one growing `Int32Array` (triangular layout), and the edit script is recovered by backtracking over them, so the hot loop allocates no objects at all — the reference allocates a path object and a component object per diagonal per depth.
- The middle slices are `Int32Array` copies, so the inner loop indexes them with plain integer offsets.
- Output is built in an array of strings and joined once.

## Layout

- `solve.js` — the fast diff (`run(input)` returns the patch as one JSON string).
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each case with `solve.js`, writes `/output/answers.json`.
- `LICENSE` — MIT.

## Measured

On the kit's 4 practice cases (20,000–40,000 lines each), the entry's output is byte-identical to the reference's `expected.json` on all 4 cases, and the core diff (`run`) runs in ~477 ms for the 4 cases against ~1,261 ms for the reference — about a 2.7× speedup. On a fresh set of 4 cases drawn from a different seed, the same comparison is ~355 ms against ~1,010 ms, about a 2.8× speedup. End to end through `main.ts` (including reading the 8.5 MB `cases.json` and writing `answers.json`), the entry runs in ~776 ms against the baseline's ~1,625 ms. The output is byte-identical across repeated runs, and it also matches the reference on 16 further randomly generated cases (4 seeds × 4 cases) and on 18 hand-built edge cases (identical texts, empty texts, CRLF, no trailing newline, single lines, swaps, repeated lines, Unicode).
