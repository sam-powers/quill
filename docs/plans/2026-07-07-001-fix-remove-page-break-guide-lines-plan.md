---
title: 'fix: Remove page-break guide lines that cross through text'
type: fix
date: 2026-07-07
depth: lightweight
status: ready
---

# fix: Remove page-break guide lines that cross through text

## Summary

Quill's editor paints a horizontal guide line every 912px down the page via a CSS `repeating-linear-gradient` on `.ProseMirror`. Because it's a background image behind the text (not between blocks), the line draws **through** any text that happens to sit at the 912px boundary, which looks broken. This plan removes the guide-line rendering entirely. The change is CSS-only in `src/App.css`; there is no ProseMirror node, extension, or Rust code backing the feature.

## Problem Frame

The "page break" attempt was implemented as a decorative background gradient rather than as real pagination (which a continuous ProseMirror editor can't do without a layout engine). The gradient has no awareness of text position, so at each 912px interval it strikes a line across whatever line of text is there. Users read it as a horizontal rule slashing through their words. The feature adds no real value — Quill is a continuous-scroll editor, not a paginated one — so the fix is removal, not repair.

## Requirements

- **R1.** The editor must never render a horizontal line across or between document text on screen. (Removes the visual defect.)
- **R2.** Editor layout (page card, top/inter-page spacing, min-height feel) must not visibly regress for a normal single- or multi-screen document.
- **R3.** The Export-to-PDF / print path must continue to produce a clean copy — no page-break artifacts, no new regressions. (The print block already sets `background-image: none !important`; removal must keep that path correct.)
- **R4.** No dead CSS or misleadingly-named variables left referencing the removed feature.

## Key Technical Decisions

- **Remove the gradient, keep the page surface.** The `.editor-page` card, its border, and the `--page-max-width` / padding system are the document's visual frame and are unrelated to the guide lines — they stay. Only the `repeating-linear-gradient` background and the now-pointless `min-height: 912px` tied to the "one page" metaphor are in question.
- **`min-height: 912px` — reduce, don't necessarily zero.** The 912px min-height gave an empty document a full-page feel. Dropping it entirely would make a blank editor collapse to a few lines. Keep a sensible min-height (retain 912px or a comparable value) purely as a layout minimum, decoupled from any page-break meaning, and update the comment so it no longer claims to mark page boundaries.
- **`--page-break-gap` variable — rename or repurpose, don't blindly delete.** It's consumed by `.editor-scroll-area` `padding` and `gap` (lines 626/629) as ordinary spacing. Deleting the variable would break that spacing. Rename it to a neutral spacing name (e.g. `--editor-scroll-gap`) so nothing references a removed feature, OR leave the value and just update naming/comments. Behavior must be unchanged.
- **Leave `.pending-comment`'s dashed border alone.** The dashed `border-bottom` at ~line 858 belongs to the comment-composer highlight, not page breaks. Out of scope — do not touch.

## Implementation Units

### U1. Remove the page-break gradient from `.ProseMirror`

**Goal:** Delete the `repeating-linear-gradient` background so no horizontal line is ever painted through text (R1).

**Files:** `src/App.css`

**Approach:** In the `.ProseMirror` rule (~lines 647–665), remove the `background-image: repeating-linear-gradient(...)` declaration and its `/* Page break lines: dashed rule every 912px */` comment. Re-evaluate `min-height: 912px`: keep it as a plain layout minimum (updating the adjacent comment so it no longer describes "one page per 912px"), since removing it would collapse an empty editor. Do not alter font, color, or line-height declarations in the same rule.

**Patterns to follow:** Match the surrounding CSS comment style in `src/App.css`.

**Test scenarios:** Test expectation: none — pure presentational CSS with no behavioral surface. Verification is visual (see U3) and via the existing `format:check`/lint gates. The round-trip and component test suites already cover editor behavior and must stay green.

**Verification:** Grep confirms no `repeating-linear-gradient` (or any page-break gradient) remains on `.ProseMirror`. In the running app, a document long enough to cross 912px shows no line through or between text.

---

### U2. Retire the `--page-break-gap` naming and stale print comment

**Goal:** Remove the last references to the deleted feature so no misleadingly-named token or comment survives (R4), with zero behavior change (R2).

**Files:** `src/App.css`

**Approach:** Rename `--page-break-gap` (declared ~line 169) to a neutral spacing name such as `--editor-scroll-gap`, updating both consumers in `.editor-scroll-area` (`padding` ~line 626, `gap` ~line 629) to the new name with the **same value** (40px). Update the print-media comment (~line 1895) that says "Drop … the dashed page-break guide lines" to reflect that there are no longer guide lines to drop (the `background-image: none !important` on `.ProseMirror` in the print block may stay as a harmless safety net, or be removed if it's now redundant — keep it if in doubt).

**Dependencies:** Independent of U1, but land together (same file, same theme).

**Test scenarios:** Test expectation: none — rename + comment edit with no behavioral change. Verification is that computed spacing is identical (same 40px) and no other rule references the old variable name.

**Verification:** `grep -rn "page-break-gap\|page-break\|page break" src/` returns no CSS matches (comments included). Editor top/inter-page spacing is visually unchanged from before.

---

### U3. Visual verification in the running app

**Goal:** Confirm on screen that text is never crossed and layout is intact (R1, R2), and that Export-to-PDF is still clean (R3).

**Files:** none (verification only)

**Approach:** Run the app (`npm run tauri dev`, or `npm run dev` for a browser-only visual check), open/create a document long enough to span past 912px, and confirm: no horizontal line through or between text; the page card, spacing, and empty-doc min-height look right; toggling suggesting mode and comments still renders normally. Trigger Export to PDF (Cmd/Ctrl+P) and confirm the output has no page-break artifacts.

**Test scenarios:** Manual visual check per the above — this is the acceptance gate for a presentational change (`/verify`-style end-to-end observation, not a unit test).

**Verification:** Screenshot or direct observation shows clean text with the guide lines gone and no layout/PDF regression.

---

## Scope Boundaries

**In scope:** Removing the CSS guide-line gradient and cleaning up its naming/comments in `src/App.css`.

**Out of scope / non-goals:**

- The `.pending-comment` dashed border (~line 858) — belongs to the comment composer, unrelated.
- The `.editor-page` card, border, radius, and `--page-max-width`/padding system — that's the document frame, staying.
- Real pagination / page-numbering — Quill is a continuous-scroll editor; not attempting it.

## Verification Strategy

CI gates (`typecheck`, `eslint`, `prettier --check`, `vitest`, and the Rust suite) must stay green — none should be affected by a CSS-only change, but running them confirms nothing regressed. The decisive check is visual (U3): the guide lines are gone, text is uncrossed, and the PDF export is clean.

## Compounding Note

After the fix lands, capture a short learning (via `ce-compound` / `docs/solutions/`) recording **why the page-break attempt failed**: a `repeating-linear-gradient` background on a continuous ProseMirror editor paints lines by pixel offset with no awareness of text position, so any "page break every N px" approach will strike through text at the boundary. The general lesson — _don't fake pagination with a fixed-interval background on a reflowing text surface_ — is the reusable takeaway.
