# Fast Site Generator — site-generator-speed-01-run-20261122

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/verzeni408-del/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/verzeni408-del/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` answers
exactly as makefun-site does on every case (the whole output tree — every
page's `index.html`, the index and tag pages, `build-report.txt` and each
static file — byte for byte), and `main.ts` is the program the harness runs.

## How it is faster

makefun-site parses front matter, Markdown and templates with small
per-character steps and repeated string concatenation. This entry:

- fuses Markdown lexing and rendering into a single pass over each body,
- escapes HTML in chunks instead of character by character,
- parses front matter without splitting the whole body,
- counts words for `reading_minutes` with a fast scan,
- compiles each template once per case into a rendering function and renders
  into one shared output array with prototype-chain scopes.

Verified locally on the practice set: 3/3 cases byte-identical to
makefun-site 1.0.0, ~4.1x faster than the house baseline (median ~287 ms vs
~1,170 ms for the three cases on this machine).

## Layout

- `solve.js` — the drop-in, a dependency-free ES module exporting `run(input)`
- `main.ts` — the harness driver (reads `/input/cases.json`, writes
  `/output/answers.json`)
- `package.json` — `{"type": "module"}`
- `LICENSE` — MIT
