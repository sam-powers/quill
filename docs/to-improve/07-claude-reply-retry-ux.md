# 07 — Retry failed @claude replies; gate "Re-link session" to real session errors

**Area:** Frontend (`useClaudeReply`, `useComments`, `CommentCard`, `App.tsx`,
`annotationValidation`) · **Type:** feature

## Problem

When an `@claude` reply fails, the only affordance is a single "Re-link session…"
button, shown **unconditionally for every error**. For a transient/API error
(400/429/5xx, network blip, a passing server condition) that button is useless and
misleading — it implies the session link is broken, and re-linking just re-runs
the same call. There's no way to simply **retry**.

## The change

Four parts:

### 1. A pure error classifier

Add `classifyReplyError(message: string): { retryable: boolean; kind: 'transient'
| 'session' | 'auth' | 'unknown' }` (co-locate with the other exported pure
helpers in the `@claude` reply hook; unit-test it).

Matching rules, **ordered — specific before broad**:

- `session` — matches "No conversation found", "session ID", "session not found".
  → retryable, but session-recovery is primary.
- `auth` — matches "authentication", "unauthorized", "401", "login", "API key",
  "credentials". → **not** retryable. (Deliberately do **not** match a bare word
  "auth" — infra/transient messages often contain it incidentally.)
- `transient` — matches "API Error", HTTP 4xx/5xx codes (429/500/502/503/529),
  "overloaded", "timeout", "network", "rate limit", "ECONN", and the
  model-parameter family (e.g. "thinking.type"). → retryable.
- `unknown` — anything unmatched → retryable.

**Default-to-retryable is deliberate:** the bug being fixed is that errors
dead-end. A wrong "Retry" costs one re-run; a wrong "Re-link" misdirects the user.
Include a negative-control test (a clearly-transient message must NOT classify as
`session`).

### 2. Retry re-issues in place (no duplicate reply)

- Add a state helper `retryAIReply(commentId, replyId)` (mirror the existing
  `startAIReply`/`failAIReply` shape) that resets the **same** errored reply to
  `{ pending: true, error: undefined, text: '' }` — it must reuse the existing
  reply entry, never append a new one.
- Retry must re-issue the identical request (same comment, original user text,
  session binding, context folder). The original user text isn't stored on the
  reply, so stash the inputs needed to re-issue in a transient in-memory map
  keyed by reply id (`replyId → { commentId, userText, binding }`), populated when
  a reply is first requested. **In-memory only — never persisted** (see part 4).

### 3. Guard the reused-replyId against races

Because Retry reuses the same `replyId`, a late event from the original (failed)
spawn could corrupt the retried reply. Add a **generation guard**: a per-reply
counter (`genRef` map) incremented on each ask/retry; the spawn captures its
generation and an `isCurrent()` check drops late events and orphan-cancels a spawn
that resolves after being superseded. Also guard against double-fire (a
`retryingRef` set) so a fast double-click can't launch two retries. (This is the
same generation-guard pattern used in spec 08 — share the approach.)

### 4. Never persist transient error/pending state to the sidecar

Error and pending state are transient UI state. The `.comments.json` sidecar is
the saved-document contract — a failed/pending reply must **not** be written to
disk, or on reload the user sees a stale error with a Retry button that re-runs a
long-gone request. Add `stripTransientReplyState(comments)` and call it on the
save path so errored/pending AI replies are dropped before serialization. No
schema change.

### 5. Wire the UI

In the reply view (`CommentCard` / `CommentLayer`), call `classifyReplyError` on
a failed reply and render per kind:

- `transient` / `unknown` → **Retry** button (no Re-link).
- `session` → **Re-link session…** (Retry may also show as secondary).
- `auth` → **Re-link session…** only (no Retry).

Thread the new `onRetry` / `onRetryAIReply` callback from `App.tsx` down through
`CommentLayer` to `CommentCard`. Style the Retry button to match the existing
error affordance across all themes (reuse existing classes; no new color literals).

## Verify

- Unit tests for the classifier (each kind + the negative control + empty/whitespace
  → `unknown`, no throw).
- Unit tests for `retryAIReply`: clears error, sets pending, resets text, reply
  count unchanged, reply id stable, unknown replyId is a no-op.
- Test that a saved sidecar contains no errored/pending AI reply.
- e2e: a reply that errors with a transient message shows **Retry** and no
  Re-link; clicking Retry clears the error, re-enters "thinking", and on success
  renders the reply with **no duplicate**; a "No conversation found" error shows
  Re-link.

## Notes for the porter

- This is the largest spec — ~12 files in the fork. Land it as one coherent change.
- The generation-guard machinery (part 3) is the same shape spec 08 needs; if you
  do both, factor the pattern consistently.
