# Fast Fold v2 — a faster drop-in for makefun-site 1.0.0

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/astiip/site-generator-speed-01-run-20261122-bot-v2/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/astiip/site-generator-speed-01-run-20261122-bot-v2/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A dependency-free, hand-written static site generator that answers exactly
as makefun-site 1.0.0 does — same output tree, byte for byte — only faster.

Entry for the make.fun competition
[Build a static site faster, 22 November 2026](https://make.fun/c/site-generator-speed-01-run-20261122)
(`site-generator-speed-01-run-20261122`).

v2 over v1 (same output, byte for byte): the inline renderer fuses HTML
escaping into its single special-character scan (no esc() call per plain
run), reading minutes are counted straight over the source lines (no
joined body string), and the paragraph-end test dispatches on the first
character. Measured beside v1 on the same machine, practice set:
v1 median 1,101,581 us, v2 median 1,023,665 us, house baseline median
1,698,585 us (5 runs each, whole-process CPU). Practice 3/3 identical.

## Layout

- `solve.js` — the whole generator: `run(input)` returns the output tree
  (`path -> text`) for one site. Written from scratch against makefun-site's
  README and reference semantics; no vendor code is included or imported.
- `main.ts` — the harness driver (the house baseline's driver, kept as-is):
  reads `/input/cases.json`, answers each case with `run`, writes
  `/output/answers.json`.
- `package.json` — `{"type": "module"}` so `solve.js` loads as an ES module.
- `BUILD-NOTES.md` — method, optimisations, measurements, and the semantic
  corners that needed the most care.

## What it reproduces

makefun-site's own dialect, exactly: strict front matter (seven keys, first
failure wins), its slug rule (NFKD, combining marks dropped, 64 chars,
unique per directory), its Markdown subset (fences, ATX headings with
unique ids, thematic breaks, blockquotes, flat lists, paragraphs; inline
code spans, strong, emphasis, links and backslash escapes — raw HTML is
text), its template dialect (`{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`,
`{% include %}` with standalone-tag line swallowing and 8-deep includes),
collections (newest first, newer/older neighbours), tags (count desc, then
slug), pagination, static shadowing, and `build-report.txt` with every
refusal, draft, broken link and template error, sorted.

## How it is fast

- One line-split per source, shared by the front-matter parser and the
  Markdown renderer (the reference splits twice).
- Hand-rolled scanners in the hot loops — no regex per line, per character,
  or per link.
- Inline rendering jumps from one special character to the next in a
  single scan and escapes whole plain runs at once, instead of calling
  the escaper once per character; the scan also stops at HTML-escapables,
  so plain runs need no esc() call at all.
- A per-run slug cache: titles, tag names and headings repeat heavily.
- Templates are compiled once per `run()` into flat op arrays with jump
  targets and rendered into a single chunk buffer per page; loop scopes
  reuse one vars object per `for` execution.
- No state is kept between `run()` calls: each case is answered alone,
  deterministically, from its input only.

## Run it

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set outside a container
```

Grade locally with the kit (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver process
```

## Licence

MIT — see `LICENSE`.
