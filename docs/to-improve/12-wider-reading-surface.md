# 12 — Wider reading surface (trim the page margins)

**Area:** CSS (`src/App.css` `:root` layout tokens) · **Type:** UX / readability

## Problem

The text column feels cramped. The page card is US-Letter width (`--page-max-width:
816px`) with large side padding (`--page-padding-x: 96px`) → only **624px** of
actual text column. The user wants a wider reading surface.

## The change

Widen the text measure by trimming the page side padding. The fork went
`--page-padding-x: 96px → 64px`, keeping `--page-max-width: 816px` → an **688px
measure** (~85 characters — comfortable, not sprawling), with **no change to the
page footprint** (so no new horizontal-scroll risk against the fixed comment
column).

Constraints to respect:

- **Don't force horizontal scroll.** A wider page competes with the fixed comment
  column (`--comment-panel-width`, 260px) reserved on the right. Trimming padding
  (not growing `--page-max-width`) keeps the footprint constant, which is the
  safe lever. If you'd rather grow `--page-max-width` instead/also, verify
  `page-width + comment-panel + gutters` still fits the app's **minimum window
  width** without horizontal scroll.
- **Leave print/PDF alone.** The `@media print` block flattens the page (width
  auto, no padding), so the on-screen measure can differ from the US-Letter print
  width without affecting the PDF. Don't touch the print block.
- **Don't over-widen.** A very long measure hurts readability as much as a narrow
  one — aim ~65–90 characters, not "as wide as possible."

The numbers are **tunable** — pick a sensible default and confirm it visually in
the real app.

## Guard test

Add a small CSS-reading test asserting the widened token holds (e.g.
`--page-padding-x ≤ 72` and `--page-max-width ≥ 816`), with a negative control
proving the old cramped 96px would fail. Keeps a later refactor from silently
reverting the widening.

## Verify

- Guard test green.
- Real-app check across themes: the reading column is visibly wider and
  comfortable, no horizontal scrollbar at a normal window size, and Export-as-PDF
  / print preview is unchanged (still US-Letter).

## Notes for the porter

- This is a one-line token change plus a guard test. The exact final value is a
  visual judgment — 64px is a reasonable starting point.
- A user-facing wide/narrow toggle was considered and deferred — a fixed better
  default is the scope here.
