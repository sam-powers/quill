# 11 — Comment composer placeholders should mention @claude

**Area:** Frontend (`AddCommentButton.tsx`, `CommentCard.tsx`) · **Type:** copy / discoverability

## Problem

Typing `@claude` in a comment or reply triggers an AI response, but that's
invisible from the empty composer. The new-comment box placeholder said only
`"Add a comment… (Cmd+Enter to post)"` — no hint that `@claude` does anything. The
reply composer mentioned Claude but inconsistently.

## The change

Reword both composer placeholders to advertise the `@claude` affordance, and keep
them consistent:

- New-comment composer (`AddCommentButton.tsx`): e.g.
  `"Add a comment… (@claude to get an AI response)"`.
- Reply composer (`CommentCard.tsx`): e.g.
  `"Reply… (@claude to get an AI response)"`.

Pure copy — no behavior change.

## Guard test

Add a small test that reads both component sources and asserts each composer's
placeholder contains `@claude` (match **all** `placeholder="…"` occurrences in the
file, not just the first, so a future inserted placeholder can't silently drop the
hint), with a negative control (a placeholder lacking `@claude` fails the check).

## Verify

- Guard test green.
- Real-app check: open the comment composer and the reply composer; both
  placeholders mention `@claude`.

## Notes for the porter

- Final wording is your call; the invariant the test locks is only that both
  mention `@claude`.
