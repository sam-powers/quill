# 08 — Cancel during full-document review is a no-op

**Area:** Frontend (`src/hooks/useDocumentReview.ts`) · **Type:** bug

## Problem

While a "Review full document" is streaming — the modal shows "Claude is reading
the document…" — clicking **Cancel** does nothing. The review doesn't stop and the
modal stays stuck in the reading state.

## Root cause

Two stacked issues:

1. **Pre-token window.** The cancel handler early-returns when there's no cancel
   token (`const token = tokenRef.current; if (!token) return;`). But the token is
   only assigned **after** `await spawn_claude_resume(…)` resolves, while the modal
   enters the streaming state **synchronously** on submit. So during the exact
   "Claude is reading…" window — after submit, before the spawn resolves — there is
   no token and Cancel is a no-op.
2. **Event-dependent reset.** Even once a token exists, the modal only leaves the
   streaming state when a `cancelled` event arrives back from the backend. If the
   backend cancel doesn't emit one, the modal stays stuck. A user-initiated cancel
   should reset the UI immediately, not depend on a round-trip event.

## The change

Adopt a **generation guard** in the review hook (the same pattern the single-reply
path uses — see spec 07). Concretely:

- Add `const genRef = useRef(0)`. At the top of `start`, claim a generation:
  `const generation = ++genRef.current` and define `const isCurrent = () =>
genRef.current === generation`.
- After **each** async gap in `start`, if `!isCurrent()` bail / orphan-cancel:
  - After `spawn_claude_resume` resolves: `if (isCurrent()) tokenRef.current =
token; else invoke('cancel_claude_resume', { cancelToken: token })` — cancel
    the now-orphaned child instead of registering its token.
  - **Also** after any earlier await in `start` (e.g. a context-folder scan): if
    `!isCurrent()` return before spawning, so a cancel during that earlier gap
    doesn't still launch a review the user backed out of.
- In the stream `dispatch`, first line: `if (!isCurrent()) return;` — drop late
  delta/done/error events from a superseded run.
- In `cancel()`: **bump the generation first** (`genRef.current += 1`), **reset the
  phase to idle immediately** (don't wait for a `cancelled` event), then read and
  null the token and fire `cancel_claude_resume` if a token existed. Capture the
  token value before nulling it.
- Guard `finalize()` (which applies irreversible document mutations) with
  `if (!isCurrent()) return;` as defense-in-depth, even though it's only reached
  via the already-guarded dispatch.

The principle: **user cancel resets the UI synchronously and supersedes any
in-flight spawn**, regardless of backend event timing.

## Verify

- e2e (extend the review spec): with the mock scripted to stay "reading" (a
  `pause` step) and configured to **emit no `cancelled` event on cancel**, click
  Cancel → the modal returns to the compose form (guidance textarea visible) and
  no comments/suggestions are applied.
- e2e: after cancel, inject a late `delta` straight into the stream callback and
  assert the modal does **not** flip back to streaming (the generation guard drops
  it).
- The existing mid-stream cancel test (token already exists) still passes.

## Notes for the porter

- The fork verified both new tests **fail before** the fix and **pass after** —
  do the same (characterize first).
- If the mock's `spawn` returns its token synchronously, the true pre-token
  `await` gap isn't reproducible via e2e; the injected-late-event test + the
  no-`cancelled`-event test cover the observable behavior. A `renderHook` unit
  test can cover the orphan-cancel-after-await branch directly if desired.
- Do **not** change the Rust backend for this. The frontend fix makes the UI
  correct regardless of whether `cancel_claude_resume` emits `cancelled`. Whether
  the backend reliably terminates the child is a separate, optional follow-up.
