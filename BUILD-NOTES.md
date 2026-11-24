# Build notes — site-generator-speed-01-run-20261122-bot-v2

Entry: a faster drop-in for makefun-site 1.0.0. `solve.js` is v1's
("Single-Pass Static Site Builder", submitted 22 Nov, sub 01a20507,
claim AF-7QPDA, rank 2802/9,076 live at 1,390,000 us) with three
targeted, semantics-preserving changes. `main.ts` is the house
baseline's driver, kept as-is (including `--no-incremental-marking`,
which measured ~9% faster than without it on this machine).

## v2 changes (and why each is safe)

1. **Inline escape fusion** (`inline`, `SPECIAL_RE`): the
   special-character scan now also stops at `& < > " '`, and the
   entities are emitted in the main loop. A plain run between two hits
   holds no escapable, so it is copied as-is — no `esc()` call and no
   second regex scan per run. `esc()` is still used for code spans,
   link hrefs and template variables. Output identical: every
   escapable is still emitted as its entity, in the same order.
2. **Reading minutes counted over lines** (`wordsOfLines`): the
   joined body string (`s.lines.slice(start).join('\n')`) is gone;
   words are counted straight over the source lines. A line break is
   whitespace, so the total equals the joined count exactly. The
   whitespace test uses a 64 KiB table holding exactly the JS `\s`
   set (verified character by character against `isWsCode`).
3. **Paragraph-end fast path** (`endsPara`): only a blank line, a
   fence, a heading or an HR ends a paragraph, and each of those
   starts with space, tab, backtick, `#`, `-` or `*`; any other first
   character settles it with one check. Exactly equivalent to the
   three classifier calls it skips.

## Measurements (this machine, node 24, whole-process CPU, 5 runs each)

- v1: 991,850 / 1,077,559 / 1,101,581 / 1,104,019 / 1,118,760 us,
  median 1,101,581 us.
- v2: 949,824 / 963,937 / 1,023,665 / 1,072,064 / 1,231,990 us,
  median 1,023,665 us (~7% faster than v1).
- House baseline: median 1,698,585 us (v2 is ~1.66x its speed).
- Practice set: v2 3/3 cases identical to the reference, and
  identical to v1's output. (Verified by direct JSON comparison and
  by the kit's grade-local, process driver.)
- Phase profile of v1's run (wall, one quiet run): Markdown 289 ms
  (58%), layouts 105 ms (21%), cards 51 ms, front matter 18 ms,
  permalinks 15 ms; JSON parse 25 ms, stringify 95 ms. The v2
  savings come off the Markdown/cards shares.

## The board's top-1 anomaly (cpu_us 0)

22 entries read cpu_us 0 and ranks 23+ read 10,000 us, while a
genuine entry cannot finish 3 cases of 200-600 Markdown files in
under one 10 ms clock tick net of the null control (reading and
parsing ~3 MB of input and writing ~7 MB of answers alone costs
more). The plausible reading: those entries return stored answers
for the public practice set. That wins nothing in the final heat —
the scored set is drawn after entries close, so a stored practice
answer fails the identical-answers gate there and ranks below every
passing entry. The genuine frontier on the dev board is the
~620,000-720,000 us cluster (excluding the native-C entries, which
the rules forbid: JavaScript/TypeScript only, no native addon or
prebuilt binary). v2 at ~1.02M us locally is ~7% better than v1's
live 1,390,000 us (rank 2802) but still short of that frontier;
reaching it would need a deeper rewrite (single-pass Markdown and/or
template code generation), not another round of tweaks.

## Risky semantic corners (inherited from v1, unchanged)

See v1's BUILD-NOTES.md (kept in the v1 repository): `\>` escape,
heading text trimming, front-matter line errors, list continuation,
template standalone tags, `for` var reuse, slug ASCII fast path,
`lookup` on arrays. The v2 edits touch none of those paths except
through the three changes above, each argued identical in its
section. The one real bug found while building v2: an edit tool
mangled the fused regex (backslash doubling), which made `inline()`
copy text raw — caught immediately by the practice comparison (all
3 cases differed), fixed by writing the line byte-exact, re-verified
3/3 identical before any timing was trusted.

## Round 2 audit note

No further semantic audit was done for v2 beyond the practice-set
3/3 comparison and the per-change equivalence arguments above. A
fuzz run against the reference over generated sites was not run in
this session; the parent should treat the practice 3/3 as the
correctness evidence for this entry.
