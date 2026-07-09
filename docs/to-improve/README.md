# Quill — public-repo sync specs

These specs describe improvements made to a downstream fork of Quill that should
be ported back to the **public GitHub Quill** repo (`github.com/sam-powers/quill`).
Hand them to a Claude Code session running in a checkout of the public repo.

> **Claude, start here.** You are in a checkout of the public Quill repo. This
> folder contains a set of independent improvement specs to port into _this_ repo.
> Read this README, then work through the specs in the "Suggested order" section
> below — for each one: reproduce the issue if you can, apply the change following
> _this repo's_ existing conventions (the specs are behavior descriptions, not
> patches — do not paste code from them verbatim), run the checks listed under
> "How to use these", and confirm before moving on. Do one spec at a time and
> pause after each so the maintainer can review. If a spec's "before" state
> doesn't match what you find here, trust the current code and adapt — the fork
> diverged from this repo in unrelated ways. Ask if anything is ambiguous rather
> than guessing.

Each spec is self-contained: problem, root cause, the change to make, and how to
verify. They are written as **behavior specs, not patches** — the public repo has
diverged from the fork in unrelated ways (fonts, update-checker, CSP), so apply
the intent, matching the public repo's own conventions, rather than pasting diffs.

## How to use these

1. Open a Claude Code session in the public Quill checkout (your personal machine,
   personal account — **not** the internal build).
2. Feed it one spec at a time, in the order below (independent specs can go in any
   order; the three "claude CLI resolution" specs are related and best done
   together).
3. For each: reproduce the bug first if you can, apply the change, run the repo's
   existing checks (`npm run typecheck`, `npm run lint`, `npm test`, `npx playwright
test`, and the Rust checks `cargo test && cargo clippy && cargo fmt --check`),
   then confirm behavior in a real built app.

## What is DELIBERATELY excluded

None of the internal Brazil/Amazon porting work is in these specs — no build
wiring, dependency-mirror changes, CSP scrubbing, font vendoring, plugin
repointing, or removal of the GitHub update-checker. Those are downstream-only.
These specs are **only** the genuine product/behavior improvements that any Quill
user benefits from.

Two things to know about provenance:

- The three "claude CLI resolution / PATH" specs (01–03) were discovered because
  the fork runs as a packaged macOS `.app` launched from Finder, which exposed a
  minimal-`PATH` environment that a terminal `npm run tauri dev` never hits. They
  are still real bugs in the public app for anyone who installs and launches the
  built `.app` — but if the public repo is only ever run via `tauri dev` from a
  terminal, they may appear not to reproduce. Fix them anyway; installed users hit
  them.
- One spec (04, window-destroy capability) references a Tauri **capability grant**.
  The public repo's capability file may differ; apply the same grant to whatever
  capability file the public repo uses.

## Specs

| #   | Spec                                                                                                         | Area              | Type    |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------- | ------- |
| 01  | [claude CLI: give the spawned process a working PATH](01-claude-spawn-path.md)                               | Rust backend      | bug     |
| 02  | [claude CLI: resolve the user's configured binary, not a stale copy](02-claude-resolve-configured-binary.md) | Rust backend      | bug     |
| 03  | [claude CLI: use an interactive login shell to read PATH](03-claude-interactive-login-shell.md)              | Rust backend      | bug     |
| 04  | [Window won't close from the unsaved-changes dialog](04-window-close-capability.md)                          | Rust + capability | bug     |
| 05  | [Deep link opens a doc but leaves the window hidden](05-deep-link-surface-window.md)                         | Rust backend      | bug     |
| 06  | [Cmd+S (and other menu shortcuts) use stale handlers](06-menu-handler-stale-closure.md)                      | Frontend          | bug     |
| 07  | [Retry failed @claude replies; gate "Re-link session"](07-claude-reply-retry-ux.md)                          | Frontend          | feature |
| 08  | [Cancel during full-document review is a no-op](08-review-cancel-fix.md)                                     | Frontend          | bug     |
| 09  | [Comments below the document's end can't be scrolled into view](09-below-fold-comment-scroll.md)             | Frontend          | bug     |
| 10  | [Remove the faux page-break indicator](10-remove-page-break-indicator.md)                                    | Frontend/CSS      | fix     |
| 11  | [Comment composer placeholders should mention @claude](11-comment-placeholder-hint.md)                       | Frontend          | copy    |
| 12  | [Wider reading surface (trim page margins)](12-wider-reading-surface.md)                                     | CSS               | UX      |

## Suggested order

1. **Specs 01–03 together** (claude CLI resolution — they build on each other).
2. **04, 05, 06** (small backend/frontend bug fixes, independent).
3. **07** (retry UX — the largest change).
4. **08, 09** (review-cancel + below-fold scroll — independent).
5. **10, 11, 12** (page-break removal, placeholder copy, reading width — cosmetic/small).
