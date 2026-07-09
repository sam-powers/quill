---
title: 'Page-break guide lines drew through reflowing editor text'
category: ui-bugs
date: 2026-07-07
module: editor-styling
problem_type: ui_bug
component: frontend_stimulus
severity: low
symptoms:
  - 'A faint horizontal rule painted every 912px slashed through any line of text sitting on the boundary'
  - 'Words got cut by a horizontal line in the editor'
  - 'Any change in font size, zoom, or window width reflowed text onto the 912px boundary, so the rule cut through different text'
root_cause: logic_error
resolution_type: code_fix
tags:
  - css
  - prosemirror
  - editor
  - pagination
  - background-image
  - reflow
  - tiptap
---

# Page-break guide lines drew through reflowing editor text

## Problem

Quill's editor painted a faint horizontal "page break" rule every 912px down the
page using a CSS `repeating-linear-gradient` on `.ProseMirror`. Because the rule
was a full-bleed background image _behind_ the text (not a divider _between_
blocks), it had no awareness of where lines of text fell — so it drew straight
through any line that happened to sit on a 912px boundary. The fix was to remove
the feature entirely: Quill is a continuous-scroll editor, not a paginated one,
so the cue added no value.

## Symptoms

- A faint horizontal line appeared roughly every 912px down the editor.
- Where a line of text landed on that boundary, the rule cut straight through
  the words — the text looked struck out or broken.
- The defect moved: any change in font size, zoom, or window width reflowed the
  text, so a _different_ line ended up on the boundary and got sliced instead.
  There was no stable "safe" layout.

## What Didn't Work

There was no repair path, and that was the key realization. The instinct is to
"nudge" a decorative background line so it lands in the gutter between lines
rather than on a line — but a `repeating-linear-gradient` is positioned by fixed
pixel offset from the top of the element. It has zero knowledge of line-box
positions, and those positions shift with every reflow (font, zoom, width,
content). No offset, interval, or thickness makes a fixed-interval background
consistently miss the text on a surface whose text reflows. Any "page break
every N px" drawn this way will strike through text at some layout. The only
correct move was removal, not repair. _(root cause corroborated by auto memory
[claude])_

## Solution

CSS-only change in `src/App.css`. Three edits, all in the same theme:

**1. Remove the gradient from `.ProseMirror`.** Delete the `background-image`
declaration and its comment; keep `min-height` as a plain layout minimum
(comment updated so it no longer claims to mark page boundaries).

```css
/* before */
.ProseMirror {
  /* Page break lines: dashed rule every 912px */
  background-image: repeating-linear-gradient(
    to bottom,
    transparent,
    transparent calc(912px - 1px),
    var(--color-border-light) calc(912px - 1px),
    var(--color-border-light) 912px
  );
  /* 8.5×11 at 96dpi = 1056px total; minus 2×72px padding = 912px content per page */
  min-height: 912px;
  /* …font, color, line-height unchanged… */
}

/* after */
.ProseMirror {
  /* Layout minimum so an empty document keeps a comfortable page-sized surface */
  min-height: 912px;
  /* …font, color, line-height unchanged… */
}
```

**2. Rename the now-misleading spacing variable.** `--page-break-gap` was
consumed by `.editor-scroll-area` as ordinary spacing (padding + gap), unrelated
to the gradient. Renaming keeps the value identical and removes a token that
names a feature that no longer exists.

```css
/* before */ /* after */
--page-break-gap: 40px;
--editor-scroll-gap: 40px;
```

Both consumers in `.editor-scroll-area` (`padding` and `gap`) update to the new
name with the same `40px` value — zero behavior change.

**3. Leave the print-block reset as a harmless net.** The print media block
already set `background-image: none !important` on `.ProseMirror`. With the
gradient gone this override now matches nothing; it was kept intentionally as a
cheap defensive net in case a background is ever reintroduced.

Left untouched (out of scope, unrelated to page breaks): the `.editor-page`
card, `--page-max-width` and the padding system, and `.pending-comment`'s dashed
border (that belongs to the comment composer).

## Why This Works

Removing the gradient removes the only thing that ever painted a line across the
text, so the defect cannot recur by that mechanism. The retained `min-height:
912px` is purely a layout floor — it gives an empty document a page-sized
surface and paints nothing — so keeping it does not reintroduce any rule. The
variable rename preserves the exact spacing (`40px`) it always applied; nothing
references the removed feature anymore.

The root cause is the reusable part: **a fixed-pixel-interval background on a
reflowing text surface has no awareness of where line boxes fall.** As soon as
font size, zoom, or window width shifts the text, some line lands on the
boundary and the rule cuts through it. Faking pagination this way is
fundamentally unsound on a continuous, reflowing surface. _(auto memory
[claude])_

## Prevention

- **Before adding any repeating, tiled, or fixed-offset decorative line to an
  editable text surface, ask whether the surface reflows.** If it does, a
  fixed-interval background is unsafe — it will eventually intersect a line of
  text. This applies to `repeating-linear-gradient`, tiled background images,
  and any absolutely-positioned rule placed by pixel math rather than by
  document structure.
- **Don't fake pagination on a continuous editor.** Quill is continuous-scroll,
  not paginated. If real pagination is ever wanted, it needs a layout approach —
  page-shaped containers with margins and shadows between breaks (which _do_
  track content flow) — not a full-bleed repeating background painted behind the
  text.
- **Watch for orphaned tokens and dead resets when removing a feature.** A
  removed CSS feature tends to leave behind a misleadingly-named variable
  (`--page-break-gap`) still doing real work elsewhere, and a now-inert
  `!important` reset. Rename the former to something neutral (don't delete it if
  it's load-bearing) and either drop the latter or keep it as a documented net —
  but never leave a token whose name lies about what it does.
- **This is a presentational change with no automated visual-regression suite.**
  Verification is visual: open a document long enough to cross 912px and confirm
  no line runs through or between text, then confirm Export-to-PDF is clean. Keep
  that manual check in mind for any future editor-background work.

## Related Issues

- **PR #69** — `fix/remove-page-break-guide-lines`; the removal that resolved
  this. No prior `docs/solutions/` entries and no related GitHub issues existed
  at capture time — this is the first solution doc in the store.
