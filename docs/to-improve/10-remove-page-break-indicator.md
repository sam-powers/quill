# 10 — Remove the faux page-break indicator

**Area:** Frontend/CSS (`src/App.css`, guard test) · **Type:** fix

## Problem

Quill paints faux US-Letter page-break lines — a `repeating-linear-gradient`
background drawing a horizontal rule every "page height" (≈912px) down the
`.ProseMirror` content box. Because ProseMirror is a continuous-flow editor, that
rule lands wherever it falls — usually **through the middle of a paragraph**. Users
read it as a stray horizontal line that can't be selected, can't be deleted,
doesn't move with the text, and isn't in the saved `.md`. It looks like a glitch.

## What was tried and rejected

Moving the rule out of the text column into **gutter ticks** on the page card was
attempted first. In the real macOS WKWebView runtime the ticks **still rendered as
stray lines** (WKWebView rasterizes tiled/positioned gradient backgrounds
differently than Chromium — sub-pixel seams under CSS `zoom`). A headless-Chromium
preview said it looked fine; the real app disagreed. So the gutter-tick approach
was also removed.

## The change

**Remove the page-break indicator entirely.** The document is a continuous
surface with no page lines.

- Delete the `repeating-linear-gradient` (and any gutter-tick variant) from
  `.ProseMirror` **and** `.editor-page`. Remove any `:root` tick variables
  (`--page-tick-*`, `--page-content-height`) that only existed for it.
- Keep `.ProseMirror { min-height: … }` (≈912px) so a near-empty doc still fills
  the page card.
- Remove the now-dead print-suppression rule for the indicator.

## Guard test (lock in the robust end-state)

Add/repoint a CSS-reading guard test asserting **neither** `.ProseMirror` nor
`.editor-page` carries a `background-image` / `linear-gradient`, with a negative
control proving the assertion can fail. Guard the conclusion you trust (nothing
painted), not the clever thing that couldn't be verified.

## Verify

- Guard test green.
- Real-app check: open a multi-paragraph doc in the built `.app` — no horizontal
  lines through text, clean continuous surface, near-empty doc still shows a full
  page card.

## Notes for the porter

- If the public repo wants to _keep_ a page metaphor, the only reliable path is
  **true pagination** (discrete page elements) — a large architectural change,
  out of scope here. Short of that, no indicator is the safe default: a CSS
  background on a continuous editor is glitch-prone in WKWebView wherever it's put.
- Lesson worth carrying: verify visual/CSS changes in the **real WKWebView
  runtime**, not a headless-Chromium proxy — the proxy passed both rejected designs.
