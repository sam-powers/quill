# 09 — Comments below the document's end can't be scrolled into view

**Area:** Frontend (`CommentLayer.tsx`, `App.tsx`, `App.css`) · **Type:** bug

## Problem

A comment anchored low in the document — near or past the last line — renders a
card that sits below the visible/scrollable area. You **can't scroll or click it
into view**. The only workaround is to add blank lines to the document until the
page grows tall enough to reveal the card.

## Root cause

Comment cards live in an `overflow: hidden` margin column. They're positioned in
**document space** (anchor offset within the scroll area) and translated by the
editor's `-scrollTop`, so a card paints at `nudgedTop − scrollTop`. The editor's
maximum `scrollTop` is bounded by document content height. When a card's
`nudgedTop + cardHeight` exceeds `maxScrollTop + viewportHeight`, **no scroll
position can bring the card fully on-screen** — there simply isn't enough
scrollable content below the anchor, and the column can't scroll on its own.
Adding blank lines "works" only because it raises `maxScrollTop`.

## The change

Two coordinated pieces:

### 1. Dynamic bottom spacer (extends the scroll range)

- Have the comment layer compute the **lowest card bottom** (`max(nudgedTop +
measuredCardHeight)` across all cards — comments _and_ suggestions; the layer
  already tracks card positions and measured heights) and report it up to `App`
  via a callback prop.
- Expose a pure helper `computeBottomSpacer(maxCardBottom, baseContentHeight,
margin) → max(0, round(maxCardBottom + margin − baseContentHeight))` (unit-test
  it).
- In `App`, an effect measures the scroll area's natural content height
  (`scrollHeight − currentSpacer`, so the spacer's own height doesn't feed back),
  computes the spacer, and renders a `<div className="editor-bottom-spacer"
style={{ height }}>` inside the scroll content when height > 0. Guard the state
  update with `prev === next` to avoid a feedback loop.
- This adds scroll range **only when a low-anchored card needs it** — normal docs
  get spacer 0 (no trailing dead space). The spacer must live on the **scrollable
  content** (so it raises `maxScrollTop`), not on the overflow-hidden column.
- Suppress the spacer in the print stylesheet (`@media print { .editor-bottom-spacer
{ display: none } }`) so it never affects PDF/print output.

### 2. Card-aware activation scroll

The activation handlers (clicking a comment/suggestion, or its in-text highlight)
currently scroll the **anchor** into view, which doesn't guarantee the (taller,
possibly nudged-down) **card** is visible. Add a `scrollCardIntoView(cardId)` that
reads the card's document-space top and scrolls the editor scroll area so the full
card is on-screen with a small `CARD_SCROLL_MARGIN` of breathing room (the spacer
guarantees the room exists). Call it from both activation handlers.

**One timing detail:** the spacer is applied by a React effect that commits
_after_ the click handler returns, so scrolling synchronously would clamp against
the pre-spacer range. Defer the actual scroll by one `requestAnimationFrame` so
the spacer effect has flushed. Also, if the activation also fires an anchor
`scrollIntoView`, make that one `behavior: 'instant'` so it doesn't fight the
card's smooth scroll on the same container (two concurrent smooth scrolls cancel
each other).

## Verify

- Unit tests for `computeBottomSpacer`: 0 when all cards fit; overflow + margin
  when a card runs past; never negative; honors custom margin; integer output.
- e2e (real layout): put a comment on the last line of a **viewport-filling**
  document (short docs won't reproduce — there's empty viewport below the card
  already), click it, assert the card sits fully within the scroll area's viewport
  with a positive bottom gap — **without** adding content to the doc. Verify it
  fails without the fix and passes with it.
- Regression: a normal mid-document comment shows no extra trailing whitespace
  (spacer 0).

## Notes for the porter

- Watch for the feedback loop: derive the spacer from document-space
  (`nudgedTop + measuredHeight`), which is scroll-independent, and clamp ≥ 0.
- The card's `offsetTop` within the translated column equals its document-space
  `nudgedTop` (same coordinate space as `scrollTop`) — that's what makes the
  activation-scroll math line up.
